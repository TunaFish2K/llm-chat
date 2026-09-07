import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { attachmentFileName, ImageService, sniffImage } from "./images";

afterEach(cleanupStores);

describe("file assets and attachment workspaces", () => {
  it("materializes files in an isolated conversation workspace and rebuilds paths after a fork", async () => {
    const store = createStore();
    seedModel(store);
    const files = new ImageService(store);
    await files.initialize();
    const asset = await files.importFile("notes.txt", "text/plain", Buffer.from("attachment body"));
    const source = store.createConversation({ systemPrompt: "" });
    const turn = store.createMessageGeneration(source.id, "read it", [asset.id]);
    await files.materializeMessageAttachments(source.id, turn.userMessageId!);
    const sourcePath = join(files.attachmentWorkspace(source.id), "incoming", turn.userMessageId!, attachmentFileName(asset));
    expect(readFileSync(sourcePath, "utf8")).toBe("attachment body");

    store.updateGenerationBlock(turn.generationId, 1, "text", "done", true);
    store.finishGeneration(turn.generationId, "completed", { stopReason: "stop" });
    const fork = store.forkConversation(source.id, { mode: "continue", throughMessageId: turn.assistantMessageId });
    await files.cloneAttachmentWorkspace(source.id, fork.conversation.id);
    const forkUser = store.listMessages(fork.conversation.id)[0]!;
    const forkPath = join(files.attachmentWorkspace(fork.conversation.id), "incoming", forkUser.id, attachmentFileName(asset));
    expect(forkUser.id).not.toBe(turn.userMessageId);
    expect(existsSync(forkPath)).toBe(true);
    expect(readFileSync(forkPath, "utf8")).toBe("attachment body");
  });

  it("sniffs image bytes instead of trusting a declared non-image MIME type", async () => {
    const store = createStore();
    const files = new ImageService(store);
    await files.initialize();
    const path = join(store.dataDir, "fake.png");
    writeFileSync(path, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const asset = await files.importWorkspaceFile(store.dataDir, "fake.png", "application/octet-stream");
    expect(asset).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(asset.url).toMatch(/^\/api\/images\//);
  });

  it("recognizes supported signatures and rejects invalid image payloads and sizes", async () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF87a"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
    expect(sniffImage(Buffer.from("plain text"))).toBeNull();

    const store = createStore();
    const files = new ImageService(store);
    await files.initialize();
    await expect(files.importBytes("bad.png", Buffer.from("not an image"))).rejects.toMatchObject({ code: "image_type_invalid" });
    await expect(files.importBytes("empty.png", new Uint8Array())).rejects.toMatchObject({ code: "image_too_large" });
    await expect(files.importBytes("huge.png", Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "image_too_large" });
    await expect(files.importFile("empty.bin", "invalid mime", new Uint8Array())).rejects.toMatchObject({ code: "file_too_large" });
    await expect(files.importFile("huge.bin", "application/octet-stream", Buffer.alloc(64 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: "file_too_large" });
    const ordinary = await files.importFile("unsafe.html", "not a mime", Buffer.from("plain"));
    const jpeg = await files.importBytes("photo", new Uint8Array([0xff, 0xd8, 0xff]));
    expect(ordinary).toMatchObject({ mimeType: "application/octet-stream", kind: "file" });
    expect(jpeg).toMatchObject({ fileName: "photo", mimeType: "image/jpeg" });
    await expect(files.readAsset(ordinary.id)).rejects.toMatchObject({ code: "image_asset_not_found" });
  });

  it("confines workspace imports after resolving symlinks", async () => {
    const store = createStore();
    const files = new ImageService(store);
    await files.initialize();
    const root = join(store.dataDir, "sandbox");
    mkdirSync(root);
    writeFileSync(join(store.dataDir, "outside.txt"), "outside");
    symlinkSync(join(store.dataDir, "outside.txt"), join(root, "escape.txt"));
    await expect(files.importWorkspaceFile(root, "")).rejects.toMatchObject({ code: "workspace_file_path_invalid" });
    await expect(files.importWorkspaceFile(root, "/absolute.txt")).rejects.toMatchObject({ code: "workspace_file_path_invalid" });
    await expect(files.importWorkspaceFile(root, "../outside.txt")).rejects.toMatchObject({ code: "workspace_file_path_invalid" });
    await expect(files.importWorkspaceFile(root, "escape.txt")).rejects.toMatchObject({ code: "workspace_file_path_invalid" });
    await expect(files.importWorkspaceFile(root, ".")).rejects.toMatchObject({ code: "file_too_large" });
    await expect(files.importWorkspaceImage(root, "/absolute.png")).rejects.toMatchObject({ code: "workspace_image_path_invalid" });
    await expect(files.importWorkspaceImage(root, "")).rejects.toMatchObject({ code: "workspace_image_path_invalid" });
    await expect(files.importWorkspaceImage(root, "../outside.txt")).rejects.toMatchObject({ code: "workspace_image_path_invalid" });
    await expect(files.importWorkspaceImage(root, "escape.txt")).rejects.toMatchObject({ code: "workspace_image_path_invalid" });
  });

  it("blocks unsafe remote locations before making a network request", async () => {
    const store = createStore();
    const files = new ImageService(store);
    await files.initialize();
    await expect(files.proxy("ftp://1.1.1.1/file.png")).rejects.toMatchObject({ code: "image_proxy_url_invalid" });
    await expect(files.proxy("http://user:pass@1.1.1.1/file.png")).rejects.toMatchObject({ code: "image_proxy_url_invalid" });
    for (const url of [
      "http://127.0.0.1/file.png",
      "http://[::1]/file.png",
      "http://[::]/file.png",
      "http://[fe80::1]/file.png",
      "http://[fc00::1]/file.png",
      "http://[fd00::1]/file.png",
      "http://10.0.0.1/file.png",
      "http://0.0.0.0/file.png",
      "http://169.254.0.1/file.png",
      "http://172.16.0.1/file.png",
      "http://172.31.0.1/file.png",
      "http://192.168.0.1/file.png",
      "http://224.0.0.1/file.png"
    ]) {
      await expect(files.proxy(url)).rejects.toMatchObject({ code: "image_proxy_private_address" });
    }
    await expect(files.fetchPublicFile("http://127.0.0.1/card.json")).rejects.toMatchObject({ code: "image_proxy_private_address" });
    await expect(files.proxy("http://localhost/file.png")).rejects.toMatchObject({ code: "image_proxy_private_address" });
  });

  it("cleans shared orphan blobs and resumes attachment tombstones", async () => {
    const store = createStore();
    const files = new ImageService(store);
    await files.initialize();
    const first = await files.importFile("first.txt", "text/plain", Buffer.from("same bytes"));
    const second = await files.importFile("second.txt", "text/plain", Buffer.from("same bytes"));
    expect(first.sha256).toBe(second.sha256);
    expect(existsSync(join(store.dataDir, "image-assets", first.sha256))).toBe(true);
    await files.cleanupOrphans(Date.now() + 25 * 60 * 60 * 1000);
    expect(store.getFileAsset(first.id)).toBeUndefined();
    expect(store.getFileAsset(second.id)).toBeUndefined();
    expect(existsSync(join(store.dataDir, "image-assets", first.sha256))).toBe(false);

    await files.scheduleAttachmentWorkspaceCleanup("missing-conversation");
    const expired = join(store.dataDir, "attachment-workspaces", "old.deleted-1");
    const recent = join(store.dataDir, "attachment-workspaces", `recent.deleted-${Date.now()}`);
    const ignored = join(store.dataDir, "attachment-workspaces", "ordinary");
    const ignoredFile = join(store.dataDir, "attachment-workspaces", "not-a-directory");
    mkdirSync(expired);
    mkdirSync(recent);
    mkdirSync(ignored);
    writeFileSync(ignoredFile, "file");
    await new ImageService(store).initialize();
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(ignored)).toBe(true);
  });

  it("normalizes empty names and reports missing assets", async () => {
    const store = createStore();
    const files = new ImageService(store);
    await files.initialize();
    const ordinary = await files.importFile("\0", "text/plain; charset=utf-8", Buffer.from("body"));
    const image = await files.importBytes("\0", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    expect(ordinary).toMatchObject({ fileName: "file", mimeType: "text/plain" });
    expect(image).toMatchObject({ fileName: "image.png", mimeType: "image/png" });
    await expect(files.readFileAsset("missing")).rejects.toMatchObject({ code: "file_asset_not_found" });
  });
});
