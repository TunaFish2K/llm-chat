import { withMessage } from "@llm-chat/i18n";
import type { ServiceSettingsDto, ServiceSettingsInput, SearchEngineDto, ImageToolModelDto } from "@llm-chat/contracts";
import type { Store } from "./database";
import { StoreError } from "./errors";

type Engine = SearchEngineDto & { apiKey: string };

export class ServiceSettings {
  constructor(private readonly store: Store) {}

  engines(): Engine[] {
    return this.store.sqlite.prepare("SELECT * FROM global_search_engines ORDER BY position, id").all().map((row) => {
      const provider = row.provider as Engine["provider"];
      const apiKey = String(row.api_key);
      const baseUrl = String(row.base_url);
      return { id: String(row.id), provider, baseUrl, apiKey, enabled: Boolean(row.enabled), hasApiKey: Boolean(apiKey),
        available: Boolean(row.enabled) && (provider === "tavily" ? Boolean(apiKey) : Boolean(baseUrl)) };
    });
  }

  images(): ImageToolModelDto[] {
    const models = this.store.listModels().filter((model) => model.capabilities.imageOutput);
    for (const model of models) {
      if (this.store.sqlite.prepare("SELECT 1 FROM image_tool_models WHERE model_id = ?").get(model.id)) continue;
      const connection = this.store.getConnection(model.connectionId);
      const prefix = (connection?.providerId === "custom" ? connection.name : connection?.providerId ?? "image")
        .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "image";
      let handle = `${prefix}/${model.modelKey}`;
      let suffix = 1;
      while (this.store.sqlite.prepare("SELECT 1 FROM image_tool_models WHERE handle = ?").get(handle)) {
        handle = `${prefix}-${++suffix}/${model.modelKey}`;
      }
      this.store.sqlite.prepare(`INSERT INTO image_tool_models VALUES (?, ?, 1,
        (SELECT COALESCE(MAX(position), 0) + 1 FROM image_tool_models))`).run(model.id, handle);
    }
    const byId = new Map(models.map((model) => [model.id, model]));
    return this.store.sqlite.prepare("SELECT * FROM image_tool_models ORDER BY position, handle").all().flatMap((row) => {
      const model = byId.get(String(row.model_id));
      if (!model) return [];
      const connection = this.store.getConnection(model.connectionId);
      return [{ modelId: model.id, id: String(row.handle), name: model.displayName, connectionName: connection?.name ?? "",
        enabled: Boolean(row.enabled), available: Boolean(row.enabled && model.enabled && model.imageProtocol && connection),
        protocol: model.imageProtocol ?? null }];
    });
  }

  get(): ServiceSettingsDto {
    return { searchEngines: this.engines().map(({ apiKey: _secret, ...engine }) => engine), imageModels: this.images() };
  }

  update(input: ServiceSettingsInput): ServiceSettingsDto {
    this.images();
    const { sqlite } = this.store;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (input.searchEngines) {
        const ids = new Set(input.searchEngines.map((item) => item.id));
        if (ids.size !== input.searchEngines.length) throw withMessage(new StoreError("service_config_invalid", "搜索服务不能重复"), "error.search_services_cannot_be_duplicated");
        input.searchEngines.forEach((item, position) => {
          const existing = sqlite.prepare("SELECT provider FROM global_search_engines WHERE id = ?").get(item.id);
          if (!existing || existing.provider !== item.provider) throw withMessage(new StoreError("service_config_invalid", "搜索服务不存在或类型不匹配"), "error.the_search_service_does_not_exist_or_its_type_does_not_match");
          sqlite.prepare(`UPDATE global_search_engines SET enabled = ?, base_url = ?,
            api_key = COALESCE(?, api_key), position = ? WHERE id = ?`)
            .run(Number(item.enabled), item.baseUrl, item.apiKey ?? null, position, item.id);
        });
      }
      if (input.imageModels) {
        if (new Set(input.imageModels.map((item) => item.modelId)).size !== input.imageModels.length) throw withMessage(new StoreError("service_config_invalid", "图片模型不能重复"), "error.image_models_cannot_be_duplicated");
        input.imageModels.forEach((item, position) => {
          const result = sqlite.prepare("UPDATE image_tool_models SET enabled = ?, position = ? WHERE model_id = ?")
            .run(Number(item.enabled), position, item.modelId);
          if (!result.changes) throw withMessage(new StoreError("service_config_invalid", "图片模型不存在"), "error.image_model_not_found");
        });
      }
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    return this.get();
  }
}
