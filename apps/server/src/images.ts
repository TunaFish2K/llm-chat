import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type { FileAssetDto, ImageAssetDto } from "@llm-chat/contracts";
import type { FileAssetRecord, Store } from "./database";
import { StoreError } from "./database";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedImage {
  bytes: Uint8Array;
  mimeType: ImageAssetDto["mimeType"];
  expiresAt: number;
  lastUsedAt: number;
}

export class ImageService {
  private readonly root: string;
  private readonly attachmentRoot: string;
  private readonly proxyCache = new Map<string, CachedImage>();
  private proxyCacheBytes = 0;

  constructor(private readonly store: Store) {
    this.root = resolve(store.dataDir, "image-assets");
    this.attachmentRoot = resolve(store.dataDir, "attachment-workspaces");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.attachmentRoot, { recursive: true, mode: 0o700 });
    await this.cleanupOrphans();
    await this.resumeAttachmentWorkspaceCleanup();
  }

  async importBytes(fileName: string, bytes: Uint8Array): Promise<ImageAssetDto> {
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new StoreError("image_too_large", "图片必须小于 5 MiB");
    }
    const mimeType = sniffImage(bytes);
    if (!mimeType) throw new StoreError("image_type_invalid", "仅支持 JPEG、PNG、WebP 和 GIF 图片");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `${sha256}.${extensionFor(mimeType)}`;
    await this.storeBlob(storageKey, bytes);
    return toDto(this.store.createFileAsset({
      sha256,
      fileName: cleanFileName(fileName, mimeType),
      mimeType,
      kind: "image",
      byteSize: bytes.byteLength,
      storageKey
    })) as ImageAssetDto;
  }

  async importFile(fileName: string, declaredMimeType: string, bytes: Uint8Array): Promise<FileAssetDto> {
    if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) {
      throw new StoreError("file_too_large", "文件必须小于 64 MiB");
    }
    const imageType = sniffImage(bytes);
    if (imageType) return this.importBytes(fileName, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = sha256;
    await this.storeBlob(storageKey, bytes);
    return toDto(this.store.createFileAsset({
      sha256,
      fileName: cleanFileName(fileName),
      mimeType: cleanMimeType(declaredMimeType),
      kind: "file",
      byteSize: bytes.byteLength,
      storageKey
    }));
  }

  async importWorkspaceImage(workspaceRoot: string, inputPath: string): Promise<ImageAssetDto> {
    if (!inputPath.trim() || isAbsolute(inputPath)) throw new StoreError("workspace_image_path_invalid", "图片路径必须相对工作区");
    const canonicalRoot = await realpath(workspaceRoot);
    const candidate = resolve(canonicalRoot, inputPath);
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`)) {
      throw new StoreError("workspace_image_path_invalid", "图片路径必须相对工作区且不能越界");
    }
    const canonical = await realpath(candidate);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw new StoreError("workspace_image_path_invalid", "图片路径解析到了工作区之外");
    }
    const bytes = new Uint8Array(await readFile(canonical));
    return this.importBytes(basename(canonical), bytes);
  }

  async importWorkspaceFile(workspaceRoot: string, inputPath: string, declaredMimeType = "application/octet-stream"): Promise<FileAssetDto> {
    const canonical = await workspaceFile(workspaceRoot, inputPath);
    const info = await import("node:fs/promises").then(({ stat }) => stat(canonical));
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new StoreError("file_too_large", "文件必须小于 64 MiB");
    return this.importFile(basename(canonical), declaredMimeType, new Uint8Array(await readFile(canonical)));
  }

  async readFileAsset(id: string): Promise<{ asset: FileAssetDto; bytes: Uint8Array }> {
    const record = this.store.getFileAssetRecord(id);
    if (!record) throw new StoreError("file_asset_not_found", "文件资产不存在");
    return { asset: toDto(record), bytes: new Uint8Array(await readFile(resolve(this.root, record.storageKey))) };
  }

  async readAsset(id: string): Promise<{ asset: ImageAssetDto; bytes: Uint8Array }> {
    const loaded = await this.readFileAsset(id);
    if (loaded.asset.kind !== "image") throw new StoreError("image_asset_not_found", "图片资产不存在");
    return loaded as { asset: ImageAssetDto; bytes: Uint8Array };
  }

  attachmentWorkspace(conversationId: string): string {
    return resolve(this.attachmentRoot, conversationId);
  }

  async materializeMessageAttachments(conversationId: string, messageId: string): Promise<void> {
    const targetRoot = resolve(this.attachmentWorkspace(conversationId), "incoming", messageId);
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    for (const asset of this.store.messageFiles(messageId)) {
      const record = this.store.getFileAssetRecord(asset.id)!;
      await copyFile(resolve(this.root, record.storageKey), resolve(targetRoot, attachmentFileName(asset)));
    }
  }

  async cloneAttachmentWorkspace(_sourceConversationId: string, targetConversationId: string): Promise<void> {
    const target = this.attachmentWorkspace(targetConversationId);
    await rm(target, { recursive: true, force: true });
    // Forking creates new message IDs, so rebuild from immutable assets instead
    // of copying directories whose names belong to the source conversation.
    for (const message of this.store.listMessages(targetConversationId)) {
      if (message.attachments.length) await this.materializeMessageAttachments(targetConversationId, message.id);
    }
  }

  async scheduleAttachmentWorkspaceCleanup(conversationId: string): Promise<void> {
    const root = this.attachmentWorkspace(conversationId);
    const tombstone = `${root}.deleted-${Date.now()}`;
    await rename(root, tombstone).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.removeAttachmentWorkspaceLater(tombstone, ORPHAN_TTL_MS);
  }

  async proxy(rawUrl: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: ImageAssetDto["mimeType"] }> {
    const normalized = new URL(rawUrl).toString();
    const cached = this.proxyCache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      cached.lastUsedAt = Date.now();
      return { bytes: cached.bytes, mimeType: cached.mimeType };
    }
    if (cached) this.dropCache(normalized, cached);
    let current = new URL(normalized);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicUrl(current);
      const timeout = AbortSignal.timeout(10_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(current, {
        redirect: "manual",
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif", "user-agent": "llm-chat-image-proxy/1.0" },
        signal: combined
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new StoreError("image_proxy_redirect_invalid", "图片重定向缺少 Location");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new StoreError("image_proxy_failed", `图片服务器返回 HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE_BYTES) throw new StoreError("image_too_large", "远程图片超过 5 MiB");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new StoreError("image_too_large", "远程图片超过 5 MiB");
      const mimeType = sniffImage(bytes);
      if (!mimeType) throw new StoreError("image_type_invalid", "远程响应不是受支持的图片");
      this.addCache(normalized, { bytes, mimeType, expiresAt: Date.now() + CACHE_TTL_MS, lastUsedAt: Date.now() });
      return { bytes, mimeType };
    }
    throw new StoreError("image_proxy_redirect_invalid", "图片重定向次数过多");
  }

  async fetchPublicFile(rawUrl: string, maxBytes = 10 * 1024 * 1024, signal?: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string; mimeType: string }> {
    let current = new URL(rawUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicUrl(current);
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      const response = await fetch(current, { redirect: "manual", signal: combined, headers: { "user-agent": "llm-chat-file-fetch/1.0" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new StoreError("file_redirect_invalid", "文件重定向缺少 Location");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new StoreError("file_fetch_failed", `文件服务器返回 HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new StoreError("file_too_large", "远程文件超过大小限制");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new StoreError("file_too_large", "远程文件超过大小限制");
      let remoteName = "file";
      try {
        remoteName = decodeURIComponent(current.pathname.split("/").at(-1) || "file");
      } catch {
        remoteName = current.pathname.split("/").at(-1) || "file";
      }
      return {
        bytes,
        fileName: cleanFileName(remoteName),
        mimeType: cleanMimeType(response.headers.get("content-type") ?? "application/octet-stream")
      };
    }
    throw new StoreError("file_redirect_invalid", "文件重定向次数过多");
  }

  async cleanupOrphans(now = Date.now()): Promise<void> {
    for (const asset of this.store.unreferencedFileAssets(now - ORPHAN_TTL_MS)) {
      const result = this.store.deleteFileAsset(asset.id);
      if (!result.storageKey) continue;
      await unlink(resolve(this.root, result.storageKey)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  private async resumeAttachmentWorkspaceCleanup(now = Date.now()): Promise<void> {
    for (const entry of await readdir(this.attachmentRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /\.deleted-(\d+)$/.exec(entry.name);
      if (!match) continue;
      const elapsed = Math.max(0, now - Number(match[1]));
      const path = resolve(this.attachmentRoot, entry.name);
      if (elapsed >= ORPHAN_TTL_MS) await rm(path, { recursive: true, force: true });
      else this.removeAttachmentWorkspaceLater(path, ORPHAN_TTL_MS - elapsed);
    }
  }

  private removeAttachmentWorkspaceLater(path: string, delay: number): void {
    const timer = setTimeout(() => void rm(path, { recursive: true, force: true }), delay);
    timer.unref();
  }

  private async storeBlob(storageKey: string, bytes: Uint8Array): Promise<void> {
    const target = resolve(this.root, storageKey);
    try {
      await access(target, constants.F_OK);
    } catch {
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" }).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  }

  private addCache(key: string, value: CachedImage): void {
    this.proxyCache.set(key, value);
    this.proxyCacheBytes += value.bytes.byteLength;
    const ordered = [...this.proxyCache.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    for (const [candidate, cached] of ordered) {
      if (this.proxyCacheBytes <= CACHE_MAX_BYTES) break;
      this.dropCache(candidate, cached);
    }
  }

  private dropCache(key: string, value: CachedImage): void {
    if (this.proxyCache.delete(key)) this.proxyCacheBytes -= value.bytes.byteLength;
  }
}

export function sniffImage(bytes: Uint8Array): ImageAssetDto["mimeType"] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

function cleanFileName(fileName: string, mimeType?: ImageAssetDto["mimeType"]): string {
  const clean = basename(fileName).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return clean || (mimeType ? `image.${extensionFor(mimeType)}` : "file");
}

function extensionFor(mimeType: ImageAssetDto["mimeType"]): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}

function toDto(record: FileAssetRecord): FileAssetDto {
  const { storageKey: _storageKey, ...dto } = record;
  return dto;
}

function cleanMimeType(value: string): string {
  const clean = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean) ? clean : "application/octet-stream";
}

async function workspaceFile(workspaceRoot: string, inputPath: string): Promise<string> {
  if (!inputPath.trim() || isAbsolute(inputPath)) throw new StoreError("workspace_file_path_invalid", "文件路径必须相对工作区");
  const canonicalRoot = await realpath(workspaceRoot);
  const candidate = resolve(canonicalRoot, inputPath);
  if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`)) {
    throw new StoreError("workspace_file_path_invalid", "文件路径必须相对工作区且不能越界");
  }
  const canonical = await realpath(candidate);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new StoreError("workspace_file_path_invalid", "文件路径解析到了工作区之外");
  }
  return canonical;
}

export function attachmentFileName(asset: Pick<FileAssetDto, "id" | "fileName">): string {
  return `${asset.id}-${cleanFileName(asset.fileName)}`;
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new StoreError("image_proxy_url_invalid", "只允许 HTTP 和 HTTPS 图片");
  if (url.username || url.password) throw new StoreError("image_proxy_url_invalid", "图片 URL 不能包含凭据");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new StoreError("image_proxy_private_address", "不允许代理私网或回环地址");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")
    || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168)
    || parts[0]! >= 224;
}
