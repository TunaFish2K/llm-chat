import { describe, expect, it } from "vitest";
import type { ImageGenerationInput, ImageProviderProtocol } from "@llm-chat/contracts";
import { assertImageWorkspaceRequest, imageModelCapabilities } from "./image-model-capabilities";

const request: ImageGenerationInput = {
  modelId: "00000000-0000-4000-8000-000000000001",
  prompt: "city at sunrise",
  operation: "generate",
  referenceAssetIds: [],
  count: 1
};

describe("image workspace protocol capabilities", () => {
  it.each([
    ["openai-images", ["generate", "edit"], 4, true],
    ["google-imagen", ["generate"], 0, true],
    ["google-interactions", ["generate", "edit"], 4, false],
    ["stability-image", ["generate", "edit"], 1, false]
  ] as const)("describes %s", (protocol, operations, maxReferenceImages, count) => {
    expect(imageModelCapabilities(protocol)).toMatchObject({ operations: [...operations], maxReferenceImages, count });
  });

  it("rejects workspace-only operations and parameters that the protocol cannot honor", () => {
    expect(() => assertImageWorkspaceRequest("google-imagen", { ...request, operation: "edit" })).toThrow("不支持此绘图请求");
    expect(() => assertImageWorkspaceRequest("google-imagen", { ...request, referenceAssetIds: [request.modelId] })).toThrow();
    expect(() => assertImageWorkspaceRequest("google-interactions", { ...request, count: 2 })).toThrow();
    for (const patch of [
      { operation: "inpaint" as const },
      { operation: "variation" as const },
      { maskAssetId: request.modelId },
      { strength: 0.5 },
      { providerOptions: { raw: true } }
    ]) {
      expect(() => assertImageWorkspaceRequest("openai-images", { ...request, ...patch })).toThrow();
    }
    for (const protocol of ["openai-images", "google-imagen", "google-interactions", "stability-image"] as ImageProviderProtocol[]) {
      expect(() => assertImageWorkspaceRequest(protocol, request)).not.toThrow();
    }
  });
});
