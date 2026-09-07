import type {
  AgentDto,
  AgentExecutionConfig,
  AgentInput,
  AgentRoleplayConfig,
  AgentUserProfileOverride,
  CharacterCardV2,
  ProviderProtocol
} from "@llm-chat/contracts";
import { randomUUID } from "node:crypto";
import { characterCardV2Schema } from "@llm-chat/contracts";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { Store } from "./database";
import { StoreError } from "./database";
import type { ImageService } from "./images";
import { defaultRoleplayConfig } from "./roleplay";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CARD_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

interface PortableExtension {
  version: 1;
  execution: Omit<AgentExecutionConfig, "modelId" | "visionModelId"> & {
    model: { protocol: ProviderProtocol; modelKey: string; connectionName: string } | null;
    visionModel?: { protocol: ProviderProtocol; modelKey: string; connectionName: string } | null;
  };
  userProfile: AgentUserProfileOverride;
  roleplay?: AgentRoleplayConfig;
}

export function importCharacterCard(store: Store, fileName: string, bytes: Uint8Array): AgentDto {
  if (bytes.byteLength > MAX_CARD_BYTES) throw new StoreError("card_too_large", "角色卡不能超过 10 MiB");
  const png = isPng(bytes);
  const archive = !png && isZip(bytes) ? decodeCharx(bytes) : undefined;
  const raw = png ? extractPngCard(bytes) : archive?.raw ?? decodeJson(bytes);
  const card = normalizeCard(raw);
  const extension = readPortableExtension(card.data.extensions.llm_chat);
  const defaultAgent = store.getAgent(store.getSettings().defaultAgentId)!;
  const execution = extension
    ? {
        ...extension.execution,
        modelId: resolvePortableModel(store, extension.execution.model),
        visionModelId: resolvePortableModel(store, extension.execution.visionModel ?? null)
      }
    : defaultAgent.execution;
  const input: AgentInput = {
    card,
    execution,
    userProfile: extension?.userProfile ?? {},
    roleplay: extension?.roleplay ?? importedRoleplayConfig(card)
  };
  return store.createAgentCopy(input, png ? bytes : archive?.avatar);
}

export async function importCharacterCardWithAssets(
  store: Store,
  files: ImageService,
  fileName: string,
  bytes: Uint8Array
): Promise<AgentDto> {
  const agent = importCharacterCard(store, fileName, bytes);
  if (!isZip(bytes)) return agent;
  const archive = decodeCharx(bytes);
  const imported = [];
  for (const source of archive.assets) {
    const asset = await files.importFile(source.name, source.mimeType, source.bytes);
    store.attachFileToAgent(agent.id, asset.id);
    imported.push({
      id: asset.id,
      type: source.type,
      name: source.name,
      ext: source.ext,
      uri: asset.url,
      mimeType: asset.mimeType,
      hash: asset.sha256
    });
  }
  return store.updateAgent(agent.id, {
    roleplay: { ...agent.roleplay, assets: [...agent.roleplay.assets, ...imported] }
  })!;
}

export function exportCharacterCard(
  store: Store,
  agent: AgentDto,
  format: "json" | "png"
): { fileName: string; contentType: string; bytes: Uint8Array } {
  const card = portableCard(store, agent);
  const safeName = agent.name.replace(/[\\/:*?"<>|]/g, "_") || "character";
  if (format === "json") {
    return {
      fileName: `${safeName}.json`,
      contentType: "application/json; charset=utf-8",
      bytes: Buffer.from(JSON.stringify(card, null, 2), "utf8")
    };
  }
  const avatar = store.getAgentAvatar(agent.id);
  if (!avatar || !isPng(avatar)) throw new StoreError("agent_png_avatar_required", "PNG 导出需要先设置 PNG 头像");
  return {
    fileName: `${safeName}.png`,
    contentType: "image/png",
    bytes: embedPngCard(avatar, card)
  };
}

export async function exportCharacterCardWithAssets(
  store: Store,
  files: ImageService,
  agent: AgentDto,
  format: "json" | "png" | "charx"
): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }> {
  if (format !== "charx") return exportCharacterCard(store, agent, format);
  const safeName = agent.name.replace(/[\\/:*?"<>|]/g, "_") || "character";
  const archive: Record<string, Uint8Array> = {};
  const assets = [];
  for (const item of agent.roleplay.assets) {
    try {
      const loaded = await files.readFileAsset(item.id);
      const path = `assets/${item.id}.${cleanExtension(item.ext)}`;
      archive[path] = loaded.bytes;
      assets.push({ type: item.type, name: item.name, ext: item.ext, uri: `embeded://${path}` });
    } catch {
      assets.push({ type: item.type, name: item.name, ext: item.ext, uri: item.uri });
    }
  }
  const portable = portableCard(store, agent);
  const ccv3 = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { ...portable.data, assets }
  };
  archive["card.json"] = strToU8(JSON.stringify(ccv3, null, 2));
  return {
    fileName: `${safeName}.charx`,
    contentType: "application/vnd.character-card+zip",
    bytes: zipSync(archive, { level: 6 })
  };
}

function portableCard(store: Store, agent: AgentDto): CharacterCardV2 {
  const model = agent.execution.modelId ? store.getModel(agent.execution.modelId) : undefined;
  const connection = model ? store.getConnection(model.connectionId) : undefined;
  const visionModel = agent.execution.visionModelId ? store.getModel(agent.execution.visionModelId) : undefined;
  const visionConnection = visionModel ? store.getConnection(visionModel.connectionId) : undefined;
  const extension: PortableExtension = {
    version: 1,
    execution: {
      model: model && connection ? {
        protocol: connection.protocol,
        modelKey: model.modelKey,
        connectionName: connection.name
      } : null,
      visionModel: visionModel && visionConnection ? {
        protocol: visionConnection.protocol,
        modelKey: visionModel.modelKey,
        connectionName: visionConnection.name
      } : null,
      contextPolicy: agent.execution.contextPolicy,
      reasoningEffort: agent.execution.reasoningEffort,
      search: agent.execution.search,
      generation: agent.execution.generation,
      tools: agent.execution.tools,
      enabledSkillIds: agent.execution.enabledSkillIds,
      maxToolRounds: agent.execution.maxToolRounds,
      maxBackgroundTasks: agent.execution.maxBackgroundTasks,
      taskLogLimitBytes: agent.execution.taskLogLimitBytes
    },
    userProfile: agent.userProfile,
    roleplay: agent.roleplay
  };
  return {
    ...agent.card,
    data: {
      ...agent.card.data,
      extensions: { ...agent.card.data.extensions, llm_chat: extension }
    }
  };
}

function readPortableExtension(value: unknown): PortableExtension | undefined {
  if (!value || typeof value !== "object") return undefined;
  const extension = value as Partial<PortableExtension>;
  if (extension.version !== 1 || !extension.execution || !extension.userProfile) return undefined;
  return extension as PortableExtension;
}

function importedRoleplayConfig(card: CharacterCardV2): AgentRoleplayConfig {
  const config = defaultRoleplayConfig(true);
  const extensions = card.data.extensions;
  const regexSource = Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : [];
  config.regexScripts = regexSource.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const raw = String(row.findRegex ?? row.pattern ?? "");
    const literal = /^\/(.*)\/([gimsuy]*)$/.exec(raw);
    const scopes = Array.isArray(row.placement) && row.placement.includes(1)
      ? ["user_prompt" as const]
      : ["display" as const];
    return [{
      id: randomUUID(),
      name: String(row.scriptName ?? row.name ?? `导入正则 ${index + 1}`).slice(0, 200),
      enabled: false,
      pattern: (literal?.[1] ?? raw).slice(0, 20_000),
      replacement: String(row.replaceString ?? row.replacement ?? "").slice(0, 200_000),
      flags: (literal?.[2] ?? String(row.flags ?? "gu")).slice(0, 10),
      scopes,
      runOnEdit: Boolean(row.runOnEdit),
      importWarning: "导入的正则尚未执行；检查 RE2 兼容性后再启用"
    }];
  });
  const quickSource = Array.isArray(extensions.quick_replies) ? extensions.quick_replies : [];
  if (quickSource.length) {
    config.quickReplySets = [{
      id: randomUUID(), name: "角色卡快捷回复", enabled: true,
      replies: quickSource.flatMap((value, index) => {
        if (!value || typeof value !== "object") return [];
        const row = value as Record<string, unknown>;
        const content = String(row.message ?? row.content ?? "").slice(0, 500_000);
        const scripted = content.trimStart().startsWith("/");
        return [{
          id: randomUUID(), label: String(row.label ?? row.name ?? `快捷回复 ${index + 1}`).slice(0, 100),
          tooltip: String(row.title ?? row.tooltip ?? "").slice(0, 500),
          mode: scripted ? "script" as const : "insert" as const,
          content, enabled: !scripted && row.disabled !== true, pinned: false, autoTriggers: []
        }];
      })
    }];
  }
  return config;
}

function resolvePortableModel(
  store: Store,
  portable: PortableExtension["execution"]["model"]
): string | null {
  if (!portable) return null;
  const model = store.listModels().find((candidate) => {
    const connection = store.getConnection(candidate.connectionId);
    return candidate.enabled
      && candidate.modelKey === portable.modelKey
      && connection?.protocol === portable.protocol
      && connection.name === portable.connectionName;
  });
  return model?.id ?? null;
}

function normalizeCard(raw: unknown): CharacterCardV2 {
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).spec === "chara_card_v3") {
    const record = raw as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
    const extensions = data.extensions && typeof data.extensions === "object"
      ? data.extensions as Record<string, unknown>
      : {};
    return characterCardV2Schema.parse({
      ...record,
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        ...data,
        extensions: {
          ...extensions,
          llm_chat_ccv3_source: raw
        }
      }
    });
  }
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).spec === "chara_card_v2") {
    return characterCardV2Schema.parse(raw);
  }
  const legacy = raw as Record<string, unknown>;
  return characterCardV2Schema.parse({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: legacy.data && typeof legacy.data === "object" ? legacy.data : legacy
  });
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new StoreError("card_invalid_json", "角色卡 JSON 无法解析");
  }
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.length
    && Buffer.from(bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

function decodeCharx(bytes: Uint8Array): {
  raw: unknown;
  avatar?: Uint8Array;
  assets: Array<{ type: string; name: string; ext: string; mimeType: string; bytes: Uint8Array }>;
} {
  let count = 0;
  let expanded = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        count += 1;
        expanded += file.originalSize;
        if (count > MAX_ARCHIVE_ENTRIES || expanded > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          throw new StoreError("card_archive_too_large", "CHARX 解包后超过安全限制");
        }
        return file.originalSize <= MAX_CARD_BYTES && !unsafeArchivePath(file.name);
      }
    });
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("card_invalid_archive", "CHARX 文件无法安全解包");
  }
  const cardPath = Object.keys(entries).find((name) => /(^|\/)card\.json$/i.test(name));
  if (!cardPath) throw new StoreError("card_missing_archive_metadata", "CHARX 中没有 card.json");
  const raw = decodeJson(entries[cardPath]!);
  const data = raw && typeof raw === "object" && (raw as Record<string, unknown>).data;
  const manifest = data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).assets)
    ? (data as Record<string, unknown>).assets as unknown[]
    : [];
  const assets = manifest.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const uri = String(item.uri ?? "");
    const path = uri.replace(/^embed(?:ded|ed):\/\//i, "").replace(/^\.\//, "");
    const content = entries[path];
    if (!content || unsafeArchivePath(path)) return [];
    const ext = cleanExtension(String(item.ext ?? path.split(".").at(-1) ?? "bin"));
    return [{
      type: String(item.type ?? "asset").slice(0, 100),
      name: String(item.name ?? path.split("/").at(-1) ?? "asset").slice(0, 200),
      ext,
      mimeType: mimeForExtension(ext),
      bytes: content
    }];
  });
  const avatar = assets.find((asset) => asset.type === "icon" && asset.mimeType === "image/png")?.bytes;
  return { raw, assets, ...(avatar ? { avatar } : {}) };
}

function unsafeArchivePath(path: string): boolean {
  return !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "");
}

function cleanExtension(value: string): string {
  return /^[A-Za-z0-9]{1,20}$/.test(value) ? value.toLocaleLowerCase() : "bin";
}

function mimeForExtension(ext: string): string {
  const known: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    json: "application/json", txt: "text/plain", mp3: "audio/mpeg", ogg: "audio/ogg", mp4: "video/mp4"
  };
  return known[ext.toLocaleLowerCase()] ?? "application/octet-stream";
}

function extractPngCard(bytes: Uint8Array): unknown {
  for (const chunk of parsePngChunks(bytes)) {
    if (chunk.type !== "tEXt") continue;
    const separator = chunk.data.indexOf(0);
    if (separator < 0 || chunk.data.subarray(0, separator).toString("latin1") !== "chara") continue;
    try {
      const json = Buffer.from(chunk.data.subarray(separator + 1).toString("latin1"), "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      throw new StoreError("card_invalid_png_metadata", "PNG 中的角色卡数据无法解析");
    }
  }
  throw new StoreError("card_missing_png_metadata", "PNG 中没有 chara 角色卡数据");
}

function embedPngCard(bytes: Uint8Array, card: CharacterCardV2): Uint8Array {
  const chunks = parsePngChunks(bytes).filter((chunk) => !(
    chunk.type === "tEXt"
    && chunk.data.indexOf(0) === 5
    && chunk.data.subarray(0, 5).toString("latin1") === "chara"
  ));
  const text = Buffer.concat([
    Buffer.from("chara\0", "latin1"),
    Buffer.from(Buffer.from(JSON.stringify(card), "utf8").toString("base64"), "latin1")
  ]);
  const output: Buffer[] = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    if (chunk.type === "IEND") output.push(encodeChunk("tEXt", text));
    output.push(encodeChunk(chunk.type, chunk.data));
  }
  return Buffer.concat(output);
}

function parsePngChunks(bytes: Uint8Array): Array<{ type: string; data: Buffer }> {
  if (!isPng(bytes)) throw new StoreError("card_invalid_png", "文件不是有效的 PNG");
  const buffer = Buffer.from(bytes);
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_CARD_BYTES || offset + 12 + length > buffer.length) {
      throw new StoreError("card_invalid_png", "PNG 数据块损坏");
    }
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += length + 12;
    if (type === "IEND") return chunks;
  }
  throw new StoreError("card_invalid_png", "PNG 缺少 IEND 数据块");
}

function encodeChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.byteLength + 12);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), data.byteLength + 8);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
