import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FILE_UPLOAD_CHUNK_BYTES } from "@llm-chat/contracts";

export async function hashFile(file: Blob, progress: (bytes: number) => void): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += FILE_UPLOAD_CHUNK_BYTES) {
    const bytes = new Uint8Array(await file.slice(offset, offset + FILE_UPLOAD_CHUNK_BYTES).arrayBuffer());
    hash.update(bytes);
    progress(Math.min(file.size, offset + bytes.length));
  }
  return bytesToHex(hash.digest());
}
