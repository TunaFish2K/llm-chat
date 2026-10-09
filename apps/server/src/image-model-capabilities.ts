import type {
  ImageGenerationInput,
  ImageModelCapabilitiesDto,
  ImageProviderProtocol
} from "@llm-chat/contracts";
import { withMessage } from "@llm-chat/i18n";
import { StoreError } from "./errors";

export function imageModelCapabilities(protocol: ImageProviderProtocol): ImageModelCapabilitiesDto {
  if (protocol === "openai-images") return {
    operations: ["generate", "edit"], maxReferenceImages: 4,
    count: true, aspectRatio: false, size: true, quality: true, outputFormat: true,
    negativePrompt: false, seed: false
  };
  if (protocol === "google-imagen") return {
    operations: ["generate"], maxReferenceImages: 0,
    count: true, aspectRatio: true, size: true, quality: false, outputFormat: false,
    negativePrompt: false, seed: false
  };
  if (protocol === "google-interactions") return {
    operations: ["generate", "edit"], maxReferenceImages: 4,
    count: false, aspectRatio: true, size: true, quality: false, outputFormat: true,
    negativePrompt: false, seed: false
  };
  return {
    operations: ["generate", "edit"], maxReferenceImages: 1,
    count: false, aspectRatio: true, size: false, quality: false, outputFormat: true,
    negativePrompt: true, seed: true
  };
}

export function assertImageWorkspaceRequest(protocol: ImageProviderProtocol, input: ImageGenerationInput): void {
  const capabilities = imageModelCapabilities(protocol);
  const operationAllowed = input.operation === "generate" || input.operation === "edit"
    ? capabilities.operations.includes(input.operation)
    : false;
  const referencesAllowed = input.referenceAssetIds.length <= capabilities.maxReferenceImages
    && (input.referenceAssetIds.length === 0 || input.operation === "edit");
  const countAllowed = input.count === 1 || capabilities.count;
  if (!operationAllowed || !referencesAllowed || !countAllowed || input.maskAssetId || input.strength !== undefined || input.providerOptions) {
    throw withMessage(
      new StoreError("image_operation_unsupported", "所选模型不支持此绘图请求"),
      "error.image_operation_unsupported"
    );
  }
}
