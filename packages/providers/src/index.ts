export * from "./messages";
export * from "./types";
export * from "./http";
export * from "./openai-chat";
export * from "./openai-responses";
export * from "./anthropic";
export * from "./image";

import type { ProviderProtocol } from "@llm-chat/contracts";
import { AnthropicAdapter } from "./anthropic";
import { OpenAiChatAdapter } from "./openai-chat";
import { OpenAiResponsesAdapter } from "./openai-responses";
import type { ProviderAdapter } from "./types";
import type { ImageProviderProtocol } from "@llm-chat/contracts";
import { imageAdapterFor } from "./image";

const adapters: Record<ProviderProtocol, ProviderAdapter> = {
  "openai-chat": new OpenAiChatAdapter(),
  "openai-responses": new OpenAiResponsesAdapter(),
  "anthropic-messages": new AnthropicAdapter()
};

export function adapterFor(protocol: ProviderProtocol): ProviderAdapter {
  return adapters[protocol];
}

export function imageAdapter(protocol: ImageProviderProtocol) {
  return imageAdapterFor(protocol);
}
