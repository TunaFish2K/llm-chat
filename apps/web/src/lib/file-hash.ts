import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Kept local so the hash worker does not bundle the zod-backed contracts module.
const SLICE_BYTES = 4 * 1024 ** 2;

export async function hashFile(file: Blob, progress: (bytes: number) => void): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += SLICE_BYTES) {
    const bytes = new Uint8Array(await file.slice(offset, offset + SLICE_BYTES).arrayBuffer());
    hash.update(bytes);
    progress(Math.min(file.size, offset + bytes.length));
  }
  return bytesToHex(hash.digest());
}
