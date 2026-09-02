// Mock OpenAI-compatible provider for E2E tests. No UI assumptions.
import { createServer } from "node:http";

export async function startMockProvider() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "e2e-chat", display_name: "E2E 测试模型" }] }));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          requests.push(JSON.parse(body));
        } catch {}
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        const deltas = [
          { choices: [{ index: 0, delta: { reasoning_content: "先想一下。" } }] },
          { choices: [{ index: 0, delta: { content: "你好，" } }] },
          { choices: [{ index: 0, delta: { content: "这是 E2E 流式回复。" } }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18
            }
          }
        ];
        let i = 0;
        const timer = setInterval(() => {
          if (i < deltas.length) {
            res.write(`data: ${JSON.stringify(deltas[i])}\n\n`);
            i += 1;
          } else {
            res.write("data: [DONE]\n\n");
            clearInterval(timer);
            res.end();
          }
        }, 30);
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
