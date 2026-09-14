import { afterEach, describe, expect, it, vi } from "vitest";
import { imageAdapterFor } from "./image";
import type { ImageGenerationRequest } from "./types";

afterEach(() => vi.unstubAllGlobals());

const request = (protocol: ImageGenerationRequest["protocol"]): ImageGenerationRequest => ({
  connection: {
    id: "connection",
    providerId: protocol === "stability-image" ? "stability" : protocol.startsWith("google") ? "google" : "openai",
    protocol: "openai-chat",
    baseUrl: protocol === "stability-image"
      ? "https://api.stability.ai/v2beta"
      : protocol.startsWith("google")
      ? "https://generativelanguage.googleapis.com/v1beta/openai"
      : "https://api.openai.com/v1",
    apiKey: "secret",
    secretHeaders: {}
  },
  modelKey: protocol === "stability-image" ? "core" : "image-model",
  protocol,
  operation: "generate",
  prompt: "a glass house in the mountains",
  referenceImages: [],
  options: { count: 1 },
  signal: new AbortController().signal
});

describe("image provider adapters", () => {
  it("parses OpenAI base64 image responses", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ b64_json: "aGVsbG8=" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await imageAdapterFor("openai-images").start(request("openai-images"));
    expect(result).toMatchObject({ status: "completed", images: [{ mimeType: "image/png" }] });
    expect(Buffer.from((result as { images: Array<{ data: Uint8Array }> }).images[0]!.data).toString()).toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/images/generations", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret" })
    }));
  });

  it("parses Imagen prediction bytes and uses the native Google endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ predictions: [{ bytesBase64Encoded: "aGVsbG8=", mimeType: "image/jpeg" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await imageAdapterFor("google-imagen").start(request("google-imagen"));
    expect(result).toMatchObject({ status: "completed", images: [{ mimeType: "image/jpeg" }] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/image-model:predict",
      expect.objectContaining({ headers: expect.objectContaining({ "x-goog-api-key": "secret" }) })
    );
  });

  it("accepts Stability binary image responses", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50]), {
      headers: { "content-type": "image/png" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await imageAdapterFor("stability-image").start(request("stability-image"));
    expect(result).toMatchObject({ status: "completed", images: [{ mimeType: "image/png" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://api.stability.ai/v2beta/stable-image/generate/core", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret", accept: "application/json" })
    }));
  });
});

const reference = { dataBase64: Buffer.alloc(128, 1).toString("base64"), mimeType: "image/png" as const };

it.each(["edit", "variation"] as const)("sends OpenAI %s as multipart without overriding its boundary", async operation => {
  const fetchMock = vi.fn(async () => Response.json({ data: [{ url: "https://images.example/result.png", revised_prompt: "revised" }] }));
  vi.stubGlobal("fetch", fetchMock);
  const input: ImageGenerationRequest = { ...request("openai-images"), operation, referenceImages: [reference, { ...reference, fileName: "second.png" }], mask: reference,
    options: { count: 2, size: "1024x1024", quality: "high", outputFormat: "png" as const, providerOptions: { background: "transparent", nested: { x: 1 }, absent: null } } };
  const result = await imageAdapterFor(input.protocol).start(input);
  const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toContain(operation === "edit" ? "images/edits" : "images/variations");
  expect(init.headers).not.toHaveProperty("content-type");
  const form = init.body as FormData;
  expect(form.get("n")).toBe("2"); expect(form.get("size")).toBe("1024x1024");
  expect(form.get("quality")).toBe("high"); expect(form.get("output_format")).toBe("png");
  expect(form.get("nested")).toBe('{"x":1}'); expect(form.has("absent")).toBe(false);
  expect((form.get(operation === "edit" ? "image[]" : "image") as File).size).toBe(128);
  if (operation === "edit") { expect(form.getAll("image[]")).toHaveLength(2); expect((form.get("mask") as File).name).toBe("mask.png"); }
  expect(result).toMatchObject({ status: "completed", revisedPrompt: "revised", images: [{ url: "https://images.example/result.png", revisedPrompt: "revised" }] });
});

it("forwards OpenAI options and accepts base64 revised prompts", async () => {
  const fetchMock = vi.fn(async () => Response.json({ data: [{ b64_json: reference.dataBase64, revised_prompt: "refined" }] }));
  vi.stubGlobal("fetch", fetchMock);
  const input = request("openai-images"); input.options = { count: 1, size: "1024x1024", quality: "high", outputFormat: "webp", providerOptions: { background: "transparent" } };
  expect(await imageAdapterFor(input.protocol).start(input)).toMatchObject({ revisedPrompt: "refined" });
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ n: 1, size: "1024x1024", quality: "high", output_format: "webp", background: "transparent" });
});

it.each(["openai-images", "stability-image"] as const)("rejects missing variation input for %s before fetching", async protocol => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(imageAdapterFor(protocol).start({ ...request(protocol), operation: "variation" })).rejects.toMatchObject({ code: "image_input_required" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("passes Imagen image options and normalizes absent MIME types", async () => {
  const fetchMock = vi.fn(async () => Response.json({ predictions: [{ imageBytes: reference.dataBase64 }, { bytesBase64Encoded: reference.dataBase64, mimeType: "text/html" }] }));
  vi.stubGlobal("fetch", fetchMock);
  const input = request("google-imagen"); input.options = { count: 1, aspectRatio: "16:9", size: "2K", providerOptions: { sampleCount: 2 } };
  expect(await imageAdapterFor(input.protocol).start(input)).toMatchObject({ images: [{ mimeType: "image/png" }, { mimeType: "image/png" }] });
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).parameters).toEqual({ sampleCount: 2, aspectRatio: "16:9", imageSize: "2K" });
  await expect(imageAdapterFor(input.protocol).start({ ...input, operation: "edit" })).rejects.toMatchObject({ code: "image_operation_unsupported" });
});

it("collects and deduplicates nested Gemini images and preserves references", async () => {
  const fetchMock = vi.fn(async () => Response.json({ outputs: [
    { data: reference.dataBase64, mimeType: "image/webp" }, reference.dataBase64,
    { url: "https://images.example/one", mimeType: "image/jpeg" }, { imageUrl: "https://images.example/one" },
    { image_url: { url: "https://images.example/two" } }, null, 1, "invalid!".repeat(30)
  ] }));
  vi.stubGlobal("fetch", fetchMock);
  const input = request("google-interactions"); input.referenceImages = [reference];
  input.options = { count: 1, aspectRatio: "1:1", size: "1K", outputFormat: "png", providerOptions: { temperature: 0.5 } };
  const result = await imageAdapterFor(input.protocol).start(input);
  expect(result).toMatchObject({ status: "completed", images: [{ mimeType: "image/webp" }, { url: "https://images.example/one", mimeType: "image/jpeg" }, { url: "https://images.example/two" }] });
  const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(JSON.parse(init.body as string)).toMatchObject({ input: [{ type: "text", text: input.prompt }, { type: "image", data: reference.dataBase64 }], response_format: { type: "image", aspect_ratio: "1:1", image_size: "1K", mime_type: "image/png" }, temperature: 0.5 });
});

it("polls Stability pending jobs, completion and provider failure", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ id: "job/one" }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ status: "working" }))
    .mockResolvedValueOnce(Response.json({ image: reference.dataBase64 }))
    .mockResolvedValueOnce(Response.json({ error: "content rejected" }));
  vi.stubGlobal("fetch", fetchMock);
  const input = request("stability-image"); input.operation = "edit"; input.referenceImages = [reference]; input.mask = { ...reference, fileName: "mask.png" };
  input.options = { count: 1, negativePrompt: "blur", seed: 0, aspectRatio: "1:1", outputFormat: "png", providerOptions: { strength: 0.8 } };
  const adapter = imageAdapterFor(input.protocol);
  expect(await adapter.start(input)).toMatchObject({ status: "pending", providerJobId: "job/one" });
  const form = fetchMock.mock.calls[0]![1].body as FormData;
  expect(form.get("seed")).toBe("0"); expect(form.get("negative_prompt")).toBe("blur"); expect(form.get("strength")).toBe("0.8");
  expect(fetchMock.mock.calls[0]![0]).toContain("/edit/inpaint");
  expect(await adapter.poll!(input, "job/one")).toMatchObject({ status: "pending" });
  expect(fetchMock.mock.calls[1]![0]).toContain("results/job%2Fone");
  expect(await adapter.poll!(input, "job/one")).toMatchObject({ status: "pending" });
  expect(await adapter.poll!(input, "job/one")).toMatchObject({ status: "completed", result: { images: [{ mimeType: "image/png" }] } });
  expect(await adapter.poll!(input, "job/one")).toMatchObject({ status: "failed", error: "content rejected" });
});

it.each([
  ["openai-images", {}], ["openai-images", { data: [null] }], ["openai-images", { data: [{ url: "file:///etc/passwd" }] }],
  ["google-imagen", []], ["google-imagen", { predictions: [{}] }], ["google-interactions", {}], ["stability-image", {}]
] as const)("rejects malformed %s results %j", async (protocol, payload) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
  await expect(imageAdapterFor(protocol).start(request(protocol))).rejects.toMatchObject({ code: "image_response_invalid" });
});

it.each(["plain error", ""])("reports upstream status and bounded error text", async text => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(text.repeat(1000), { status: 429 })));
  const error = await imageAdapterFor("openai-images").start(request("openai-images")).catch(error => error);
  expect(error).toMatchObject({ code: "image_provider_error", status: 429 }); expect(error.message.length).toBeLessThanOrEqual(2000);
});

it("rejects non-JSON success bodies", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON")));
  await expect(imageAdapterFor("openai-images").start(request("openai-images"))).rejects.toMatchObject({ code: "image_response_invalid" });
});


it("accepts a binary result when a Stability asynchronous job finishes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } })));
  expect(await imageAdapterFor("stability-image").poll!(request("stability-image"), "job")).toMatchObject({ status: "completed", result: { images: [{ data: new Uint8Array([1, 2]), mimeType: "image/jpeg" }] } });
});
