import type { ServiceSettingsDto, ServiceSettingsInput, SearchEngineDto, ImageToolModelDto } from "@llm-chat/contracts";
import { StoreError, type Store } from "./database";

type Engine = SearchEngineDto & { apiKey: string };

export function migrateServiceSettings(store: Store): void {
  if (store.sqlite.prepare("SELECT 1 FROM global_search_engines LIMIT 1").get()) return;
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const rows = store.sqlite.prepare("SELECT id, execution_json FROM agents ORDER BY created_at, id").all();
  for (const row of rows) {
    const execution = JSON.parse(String(row.execution_json));
    const search = execution.search ?? { provider: "searxng", baseUrl: "" };
    const secrets = store.sqlite.prepare("SELECT provider, api_key FROM agent_search_secrets WHERE agent_id = ?").all(String(row.id));
    const providers = new Set([search.provider, ...secrets.map((secret) => String(secret.provider))]);
    for (const provider of providers) {
      const selected = provider === search.provider;
      const baseUrl = selected ? search.baseUrl ?? "" : "";
      const apiKey = String(secrets.find((secret) => secret.provider === provider)?.api_key ?? "");
      if (!baseUrl && !apiKey) continue;
      const key = JSON.stringify([provider, baseUrl, apiKey]);
      if (seen.has(key)) {
        if (selected) store.sqlite.prepare("UPDATE global_search_engines SET enabled = 1 WHERE provider = ? AND base_url = ? AND api_key = ?").run(provider, baseUrl, apiKey);
        continue;
      }
      seen.add(key);
      const n = (counts.get(provider) ?? 0) + 1;
      counts.set(provider, n);
      store.sqlite.prepare("INSERT INTO global_search_engines VALUES (?, ?, ?, ?, ?, ?)")
        .run(n === 1 ? provider : `${provider}-${n}`, provider, baseUrl, apiKey, Number(selected), seen.size);
    }
  }
  for (const provider of ["searxng", "tavily"]) {
    if (!counts.has(provider)) store.sqlite.prepare("INSERT INTO global_search_engines VALUES (?, ?, '', '', 0, ?)")
      .run(provider, provider, seen.size + (provider === "tavily" ? 2 : 1));
  }
}

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
        if (ids.size !== input.searchEngines.length) throw new StoreError("service_config_invalid", "搜索服务不能重复");
        input.searchEngines.forEach((item, position) => {
          const existing = sqlite.prepare("SELECT provider FROM global_search_engines WHERE id = ?").get(item.id);
          if (!existing || existing.provider !== item.provider) throw new StoreError("service_config_invalid", "搜索服务不存在或类型不匹配");
          sqlite.prepare(`UPDATE global_search_engines SET enabled = ?, base_url = ?,
            api_key = COALESCE(?, api_key), position = ? WHERE id = ?`)
            .run(Number(item.enabled), item.baseUrl, item.apiKey ?? null, position, item.id);
        });
      }
      if (input.imageModels) {
        if (new Set(input.imageModels.map((item) => item.modelId)).size !== input.imageModels.length) throw new StoreError("service_config_invalid", "图片模型不能重复");
        input.imageModels.forEach((item, position) => {
          const result = sqlite.prepare("UPDATE image_tool_models SET enabled = ?, position = ? WHERE model_id = ?")
            .run(Number(item.enabled), position, item.modelId);
          if (!result.changes) throw new StoreError("service_config_invalid", "图片模型不存在");
        });
      }
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    return this.get();
  }
}
