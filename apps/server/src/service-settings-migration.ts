import type { DatabaseSync } from "node:sqlite";

export function migrateServiceSettings(sqlite: DatabaseSync): void {
  if (sqlite.prepare("SELECT 1 FROM global_search_engines LIMIT 1").get()) return;
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const rows = sqlite.prepare("SELECT id, execution_json FROM agents ORDER BY created_at, id").all();
  for (const row of rows) {
    const execution = JSON.parse(String(row.execution_json));
    const search = execution.search ?? { provider: "searxng", baseUrl: "" };
    const secrets = sqlite.prepare("SELECT provider, api_key FROM agent_search_secrets WHERE agent_id = ?").all(String(row.id));
    const providers = new Set([search.provider, ...secrets.map((secret) => String(secret.provider))]);
    for (const provider of providers) {
      const selected = provider === search.provider;
      const baseUrl = selected ? search.baseUrl ?? "" : "";
      const apiKey = String(secrets.find((secret) => secret.provider === provider)?.api_key ?? "");
      if (!baseUrl && !apiKey) continue;
      const key = JSON.stringify([provider, baseUrl, apiKey]);
      if (seen.has(key)) {
        if (selected) sqlite.prepare("UPDATE global_search_engines SET enabled = 1 WHERE provider = ? AND base_url = ? AND api_key = ?").run(provider, baseUrl, apiKey);
        continue;
      }
      seen.add(key);
      const n = (counts.get(provider) ?? 0) + 1;
      counts.set(provider, n);
      sqlite.prepare("INSERT INTO global_search_engines VALUES (?, ?, ?, ?, ?, ?)")
        .run(n === 1 ? provider : `${provider}-${n}`, provider, baseUrl, apiKey, Number(selected), seen.size);
    }
  }
  for (const provider of ["searxng", "tavily"]) {
    if (!counts.has(provider)) sqlite.prepare("INSERT INTO global_search_engines VALUES (?, ?, '', '', 0, ?)")
      .run(provider, provider, seen.size + (provider === "tavily" ? 2 : 1));
  }
}

