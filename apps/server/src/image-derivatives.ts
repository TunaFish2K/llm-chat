import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageAssetDto, ProviderProtocol } from "@llm-chat/contracts";

/**
 * What each provider accepts for one image and one request. Anthropic documents
 * 1568 px as the long edge it uses without downscaling and rejects images over
 * 5 MB; OpenAI-compatible endpoints accept larger images but downscale past
 * 2048 px and commonly reject request bodies around 50 MB.
 */
export interface ImageProfile {
  id: string;
  maxEdge: number;
  maxBytes: number;
  /** Raw image bytes allowed in one request; older images beyond it are described instead. */
  requestBytes: number;
}

const ANTHROPIC: ImageProfile = { id: "anthropic-v1", maxEdge: 1568, maxBytes: 3_750_000, requestBytes: 24 * 1024 ** 2 };
const OPENAI: ImageProfile = { id: "openai-v1", maxEdge: 2048, maxBytes: 8 * 1024 ** 2, requestBytes: 36 * 1024 ** 2 };

export function imageProfile(protocol: ProviderProtocol): ImageProfile {
  return protocol === "anthropic-messages" ? ANTHROPIC : OPENAI;
}

export interface DerivedImage {
  mimeType: ImageAssetDto["mimeType"];
  bytes: Buffer;
}

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | undefined;
async function loadSharp(): Promise<Sharp> {
  // Loaded on first use so the server starts even when the native module is missing.
  sharpModule ??= import("sharp").then(({ default: sharp }) => {
    // One image at a time keeps memory bounded on small servers.
    sharp.concurrency(1);
    sharp.cache(false);
    return sharp;
  });
  return sharpModule;
}

/**
 * Produces a provider-sized copy of an uploaded image. The original stays
 * untouched; derived copies are cached on disk by content hash and profile.
 */
export class ImageDerivatives {
  private readonly root: string;
  private readonly inflight = new Map<string, Promise<DerivedImage>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, private readonly readOriginal: (assetId: string) => Promise<Buffer>) {
    this.root = resolve(dataDir, "image-derivatives");
  }

  async derive(asset: ImageAssetDto, profile: ImageProfile): Promise<DerivedImage> {
    const key = `${asset.sha256}-${profile.id}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.load(asset, profile, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async load(asset: ImageAssetDto, profile: ImageProfile, key: string): Promise<DerivedImage> {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp"] as const) {
      const cached = await readFile(resolve(this.root, `${key}.${extension(mimeType)}`)).catch(() => undefined);
      if (cached) return { mimeType, bytes: cached };
    }
    const original = await this.readOriginal(asset.id);
    // Run conversions one after another; each one can hold a full decoded bitmap.
    const run = this.queue.then(() => convert(original, asset.mimeType, profile));
    this.queue = run.catch(() => {});
    const derived = await run;
    if (derived.bytes === original) return derived;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = resolve(this.root, `${key}.${extension(derived.mimeType)}`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, derived.bytes, { mode: 0o600 });
    await rename(temporary, path);
    return derived;
  }
}

export async function convert(original: Buffer, mimeType: ImageAssetDto["mimeType"], profile: ImageProfile): Promise<DerivedImage> {
  const sharp = await loadSharp();
  // Only the first GIF frame is sent; providers treat animated images as stills.
  let metadata: import("sharp").Metadata;
  try {
    metadata = await sharp(original, { animated: false }).metadata();
  } catch (error) {
    // Let the provider judge an image the decoder cannot read, as long as it fits.
    if (original.byteLength <= profile.maxBytes) return { mimeType, bytes: original };
    throw error;
  }
  const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
  const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
  const oriented = !metadata.orientation || metadata.orientation === 1;
  if (mimeType !== "image/gif" && oriented && Math.max(width, height) <= profile.maxEdge && original.byteLength <= profile.maxBytes) {
    return { mimeType, bytes: original };
  }
  const alpha = Boolean(metadata.hasAlpha);
  let edge = Math.min(profile.maxEdge, Math.max(width, height) || profile.maxEdge);
  let quality = 85;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pipeline = sharp(original, { animated: false }).rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    const bytes = alpha
      ? await pipeline.webp({ quality, alphaQuality: 90, effort: 4 }).toBuffer()
      : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    if (bytes.byteLength <= profile.maxBytes) return { mimeType: alpha ? "image/webp" : "image/jpeg", bytes };
    quality = Math.max(50, quality - 10);
    edge = Math.round(edge * 0.8);
  }
  throw new Error("Image could not be compressed below the provider limit");
}

function extension(mimeType: DerivedImage["mimeType"]): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}
