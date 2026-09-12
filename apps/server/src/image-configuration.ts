import { withMessage } from "@llm-chat/i18n";
import type { Store } from "./database";
import { StoreError } from "./errors";

export function assertImageConfiguration(store: Store, agentId: string | null, modelId: string | null, assetIds: string[]): void {
  for (const assetId of assetIds) {
    if (!store.getImageAsset(assetId)) throw withMessage(new StoreError("image_asset_not_found", "图片资产不存在"), "error.image_asset_not_found");
  }
  const agent = agentId ? store.getAgent(agentId) : undefined;
  if (!agent) throw withMessage(new StoreError("conversation_agent_required", "请先选择可用 Agent"), "error.select_an_available_agent_first");
  const model = modelId ? store.getModel(modelId) : undefined;
  if (!model?.enabled) throw withMessage(new StoreError("conversation_model_required", "请先选择可用模型"), "error.select_an_available_model_first");
  if (model.capabilities.imageInput) return;
  const vision = agent.execution.visionModelId ? store.getModel(agent.execution.visionModelId) : undefined;
  if (!vision?.enabled || !vision.capabilities.imageInput) {
    throw withMessage(new StoreError("vision_model_required", "当前模型不支持图片，请先为 Agent 配置备用识图模型"), "error.this_model_does_not_support_images_configure_a_fallback_vision_model_for");
  }
}

