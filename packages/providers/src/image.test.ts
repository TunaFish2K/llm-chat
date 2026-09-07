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
