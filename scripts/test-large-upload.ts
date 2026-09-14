// Real 2 GiB smoke test. Keeps client and server in separate processes to measure server RSS.
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { once } from "node:events";
import { buildApp } from "../apps/server/src/app";

if (process.argv[2] === "--server") {
  const root = process.argv[3]!;
  await mkdir(join(root, "web"), { recursive: true });
  await writeFile(join(root, "web", "index.html"), "<html></html>");
  let password = "";
  const app = await buildApp({ dataFile: join(root, "db.sqlite"), webRoot: join(root, "web"), logger: false,
    skillDiscoveryRoot: join(root, "skills"), authAnnounce: (text) => { password = text.match(/\d{8}/)![0]; } });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  process.send!({ url, password, baseline });
  process.on("message", async (message) => {
    if (message === "stop") {
      clearInterval(timer); await app.close(); process.send!({ peak }); process.disconnect();
    }
  });
} else {
  const root = await mkdtemp(join(tmpdir(), "llm-chat-2gib-"));
  const child = fork(fileURLToPath(import.meta.url), ["--server", root], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  try {
    const [{ url, password, baseline }] = await once(child, "message") as [{ url: string; password: string; baseline: number }];
    const login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-llm-chat-request": "1" }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers = { cookie, "x-llm-chat-request": "1" };
    const chunk = Buffer.alloc(4 * 1024 ** 2, 37); const count = 512; const byteSize = chunk.length * count;
    const hash = createHash("sha256"); for (let i = 0; i < count; i++) hash.update(chunk);
    const sha256 = hash.digest("hex"); const id = randomUUID();
    const create = await fetch(`${url}/api/file-uploads`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id, fileName: "two-gib.bin", mimeType: "application/octet-stream", byteSize, sha256 }) });
    assert.equal(create.status, 201, await create.text());
    for (let i = 0; i < count; i++) {
      const response = await fetch(`${url}/api/file-uploads/${id}?offset=${i * chunk.length}`, { method: "PATCH", headers: { ...headers, "content-type": "application/octet-stream" }, body: chunk });
      assert.equal(response.status, 200, await response.text());
      if ((i + 1) % 128 === 0) console.log(`Uploaded ${(i + 1) * 4} MiB`);
    }
    const complete = await fetch(`${url}/api/file-uploads/${id}/complete`, { method: "POST", headers });
    assert.equal(complete.status, 202); await complete.text();
    let value;
    do {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const response = await fetch(`${url}/api/file-uploads/${id}`, { headers }); value = await response.json() as { state: string; asset: { url: string; byteSize: number; sha256: string } };
    } while (value.state === "checking");
    assert.equal(value.state, "completed"); assert.equal(value.asset.byteSize, byteSize); assert.equal(value.asset.sha256, sha256);
    const head = await fetch(`${url}${value.asset.url}`, { method: "HEAD", headers });
    assert.equal(head.headers.get("content-length"), String(byteSize));
    const ranged = await fetch(`${url}${value.asset.url}`, { headers: { ...headers, range: `bytes=${byteSize - 16}-` } });
    assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), chunk.subarray(0, 16));
    const download = await fetch(`${url}${value.asset.url}`, { headers }); assert.equal(download.status, 200);
    const downloaded = createHash("sha256"); let received = 0;
    for await (const bytes of download.body!) { downloaded.update(bytes); received += bytes.length; }
    assert.equal(received, byteSize); assert.equal(downloaded.digest("hex"), sha256);
    const stopped = once(child, "message"); child.send("stop"); const [{ peak }] = await stopped as [{ peak: number }];
    console.log(JSON.stringify({ byteSize, sha256, baselineMiB: Math.round(baseline / 1024 ** 2), peakMiB: Math.round(peak / 1024 ** 2), growthMiB: Math.round((peak - baseline) / 1024 ** 2) }));
    assert.ok(peak - baseline < 256 * 1024 ** 2, "Server RSS grew by more than 256 MiB");
    await once(child, "exit");
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await rm(root, { recursive: true, force: true });
  }
}
