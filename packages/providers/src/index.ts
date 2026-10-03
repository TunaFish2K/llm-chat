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
import { ProviderError, type DiscoveredModel, type ProviderAdapter, type ProviderConnection, type ProviderRequestContext } from "./types";
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

/**
 * Lists models with the connection's default protocol. Custom endpoints are usually
 * OpenAI-compatible relays; when they reject Bearer auth, retry once as Anthropic.
 */
export async function listConnectionModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
  requestContext?: ProviderRequestContext
): Promise<DiscoveredModel[]> {
  try {
    return await adapterFor(connection.protocol).listModels(connection, signal, requestContext);
  } catch (error) {
    const rejected = error instanceof ProviderError && [401, 403, 404].includes(error.status ?? 0);
    if (connection.providerId !== "custom" || connection.protocol === "anthropic-messages" || !rejected) throw error;
    return adapterFor("anthropic-messages").listModels({ ...connection, protocol: "anthropic-messages" }, signal, requestContext);
  }
}

export function imageAdapter(protocol: ImageProviderProtocol) {
  return imageAdapterFor(protocol);
}
