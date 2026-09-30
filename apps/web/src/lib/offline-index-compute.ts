import type { OfflineConversationDto } from "@llm-chat/contracts";
import { historyImageUrls } from "./offline-assets";

export function computeOfflineIndex(snapshot: OfflineConversationDto) {
  return { id: snapshot.conversation.id, sourceId: snapshot.sourceId, revision: snapshot.revision,
    bytes: new Blob([JSON.stringify(snapshot)]).size, images: historyImageUrls(snapshot.messages) };
}
