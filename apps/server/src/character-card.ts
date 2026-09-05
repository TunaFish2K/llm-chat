import type {
  AgentDto,
  AgentExecutionConfig,
  AgentInput,
  AgentRoleplayConfig,
  AgentUserProfileOverride,
  CharacterCardV2,
  ProviderProtocol
} from "@llm-chat/contracts";
import { characterCardV2Schema } from "@llm-chat/contracts";
import type { Store } from "./database";
import { StoreError } from "./database";
import { defaultRoleplayConfig } from "./roleplay";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CARD_BYTES = 10 * 1024 * 1024;

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
  const raw = png ? extractPngCard(bytes) : decodeJson(bytes);
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
    roleplay: extension?.roleplay ?? defaultRoleplayConfig(true)
  };
  return store.createAgentCopy(input, png ? bytes : undefined);
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
