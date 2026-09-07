import type { ProviderRequestContext } from "@llm-chat/providers";
import type { GenerationRecord } from "./database";

const CLIENT_ID = "llm-chat";
const USER_AGENT = "llm-chat/0.1.0";

export function providerRequestContext(record: GenerationRecord, requestId: string): ProviderRequestContext {
  return providerRequestContextForConversation(record.conversationId, `${record.id}:${requestId}`);
}

export function providerRequestContextForConversation(conversationId: string, requestId: string): ProviderRequestContext {
  return {
    sessionId: `ses_${conversationId.replaceAll("-", "")}`,
    requestId,
    clientId: CLIENT_ID,
    userAgent: USER_AGENT
  };
}
