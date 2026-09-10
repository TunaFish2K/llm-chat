import type { Store } from "./database";
import { StoreError } from "./errors";

export function assertImageConfiguration(store: Store, agentId: string | null, modelId: string | null, assetIds: string[]): void {
  for (const assetId of assetIds) {
    if (!store.getImageAsset(assetId)) throw new StoreError("image_asset_not_found", "图片资产不存在");
  }
  const agent = agentId ? store.getAgent(agentId) : undefined;
  if (!agent) throw new StoreError("conversation_agent_required", "请先选择可用 Agent");
  const model = modelId ? store.getModel(modelId) : undefined;
  if (!model?.enabled) throw new StoreError("conversation_model_required", "请先选择可用模型");
  if (model.capabilities.imageInput) return;
  const vision = agent.execution.visionModelId ? store.getModel(agent.execution.visionModelId) : undefined;
  if (!vision?.enabled || !vision.capabilities.imageInput) {
    throw new StoreError("vision_model_required", "当前模型不支持图片，请先为 Agent 配置备用识图模型");
  }
}

