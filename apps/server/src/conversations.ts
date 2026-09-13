import { withMessage } from "@llm-chat/i18n";
import type { ForkConversationInput } from "@llm-chat/contracts";
import type { ContainerEnvironments } from "./container-environments";
import type { Store } from "./database";
import type { TaskManager } from "./background-tasks";
import type { ImageGenerationManager } from "./image-generation";
import type { ImageService } from "./images";
import type { EventHub } from "./events";
import { StoreError } from "./errors";
import { assertImageConfiguration } from "./image-configuration";

interface ConversationDependencies {
  store: Store;
  environments?: Pick<ContainerEnvironments, "cleanupDeleted">;
  tasks: Pick<TaskManager, "hasNonterminalForConversation">;
  imageJobs: Pick<ImageGenerationManager, "hasActiveForConversation">;
  files: Pick<ImageService, "cloneAttachmentWorkspace" | "materializeMessageAttachments" | "scheduleAttachmentWorkspaceCleanup">;
  events: Pick<EventHub, "emit">;
  startGeneration: (id: string) => void;
}

export class ConversationService {
  constructor(private readonly deps: ConversationDependencies) {}

  async delete(id: string): Promise<void> {
    const { store, tasks, imageJobs, files, events } = this.deps;
    const ids = store.conversationDeletionIds(id);
    if (!ids.length) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    // Do not yield between the checks and deletion: managers share this process.
    for (const target of ids) {
      if (store.isConversationBusy(target)) throw withMessage(new StoreError("conversation_busy", "请先停止当前生成，再删除会话"), "error.stop_the_current_generation_before_deleting_the_conversation");
      if (tasks.hasNonterminalForConversation(target)) throw withMessage(new StoreError("conversation_tasks_active", "请先停止该会话的后台任务，再删除会话"), "error.stop_this_conversation_s_background_tasks_before_deleting_it");
      if (imageJobs.hasActiveForConversation(target)) throw withMessage(new StoreError("conversation_image_tasks_active", "请先停止该会话的图片任务，再删除会话"), "error.stop_this_conversation_s_image_tasks_before_deleting_it");
    }
    if (!store.deleteConversation(id)) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    for (const target of ids) events.emit({ type: "resource-changed", resource: "conversations", resourceId: target });
    await this.deps.environments?.cleanupDeleted();
    const cleanups = await Promise.allSettled(ids.map((target) => files.scheduleAttachmentWorkspaceCleanup(target)));
    for (const result of cleanups) if (result.status === "rejected") throw result.reason;
  }

  async fork(id: string, input: ForkConversationInput) {
    const { store, files } = this.deps;
    const imageAssetIds = input.mode === "edit"
      ? [...new Set([...(input.assetIds ?? []), ...(input.imageAssetIds ?? [])])]
        .filter((assetId) => store.getFileAsset(assetId)?.kind === "image")
      : [];
    if (imageAssetIds.length) {
      const source = store.getConversation(id);
      if (!source) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
      const resolved = store.resolveGeneration(source);
      assertImageConfiguration(store, resolved.agent.id, resolved.model.id, imageAssetIds);
    }
    const result = store.forkConversation(id, input);
    await files.cloneAttachmentWorkspace(id, result.conversation.id);
    if (result.generation?.userMessageId) {
      await files.materializeMessageAttachments(result.conversation.id, result.generation.userMessageId);
    }
    if (result.generation) this.deps.startGeneration(result.generation.generationId);
    return result;
  }
}
