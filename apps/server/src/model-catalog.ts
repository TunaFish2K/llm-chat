import type {
  ConnectionDto,
  ModelCatalogMetadata,
  ModelCapabilities,
  ModelInput,
  ProviderProtocol,
} from "@llm-chat/contracts";
import type { DiscoveredModel } from "@llm-chat/providers";
import { knownModelProtocol, providerPreset } from "@llm-chat/contracts";

const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const OFFICIAL_PROVIDERS: Readonly<Record<string, string>> = {
  gpt: "openai", o1: "openai", o3: "openai", o4: "openai", o5: "openai", codex: "openai",
  claude: "anthropic", deepseek: "deepseek", gemini: "google", glm: "zhipuai", kimi: "moonshotai",
  moonshot: "moonshotai", minimax: "minimax", qwen: "alibaba", doubao: "volcengine", seed: "volcengine",
  llama: "meta", mistral: "mistral", grok: "xai", command: "cohere"
};

type JsonRecord = Record<string, unknown>;

interface CatalogEntry {
  providerId: string;
  modelId: string;
  modelKeys: string[];
  meta: JsonRecord;
  completeness: number;
}

export type CatalogModelInput = ModelInput & { detectedProtocol?: ProviderProtocol | null; detectedReasoningEfforts?: string[] | null };

export interface EnrichedDiscoveredModel {
  input: CatalogModelInput;
  matched: boolean;
  catalogMetadata: ModelCatalogMetadata | null;
}

export interface CatalogEnrichmentResult {
  models: EnrichedDiscoveredModel[];
  warning?: string;
}

export function fallbackModel(
  connectionId: string,
  protocol: ProviderProtocol,
  modelKey: string,
  displayName: string
): ModelInput {
  const anthropic = protocol === "anthropic-messages";
  const responses = protocol === "openai-responses";
  return {
    connectionId,
    modelKey,
    displayName,
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: 4096,
    capabilities: {
      imageInput: false,
      tools: true,
      temperature: true,
      topP: true,
      reasoning: responses || anthropic,
      reasoningSummary: responses,
      adaptiveThinking: anthropic,
      manualThinking: anthropic
    },
    defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} },
    enabled: true
  };
}

export class ModelCatalogService {
  private entries: CatalogEntry[] | null = null;
  private expiresAt = 0;
  private pending: Promise<CatalogEntry[] | null> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async enrich(connection: ConnectionDto, discovered: DiscoveredModel[]): Promise<CatalogEnrichmentResult> {
    const entries = await this.load();
    if (!entries) {
      return {
        models: discovered.map((model) => ({
          input: this.discoveredDefaults(connection, model, null),
          matched: false,
          catalogMetadata: null
        })),
        warning: "models.dev 目录暂时不可用，已使用协议默认值"
      };
    }
    return {
      models: discovered.map((model) => {
        const exact = entries.find((entry) => connection.providerId !== "custom" && entry.providerId === connection.providerId && entry.modelId === model.id);
        const fallback = this.discoveredDefaults(connection, model, exact);
        const entry = exact ?? bestMatch(connection, model.id, entries);
        return entry
          ? { input: applyCatalogEntry(fallback, model, entry, connection.providerId), matched: true, catalogMetadata: catalogMetadata(entry) }
          : { input: fallback, matched: false, catalogMetadata: null };
      })
    };
  }

  private discoveredDefaults(connection: ConnectionDto, model: DiscoveredModel, exact: CatalogEntry | null | undefined): CatalogModelInput {
    const sdk = exact && isRecord(exact.meta.provider) ? exact.meta.provider.npm : undefined;
    const protocols: Record<string, ProviderProtocol> = {
      "@ai-sdk/openai": "openai-responses", "@ai-sdk/openai-compatible": "openai-chat", "@ai-sdk/anthropic": "anthropic-messages"
    };
    const declared = typeof sdk === "string" && Object.hasOwn(protocols, sdk) ? protocols[sdk] : null;
    const detectedProtocol = declared && providerPreset(connection.providerId).protocols.includes(declared)
      ? declared : knownModelProtocol(connection.providerId, model.id);
    const hasEfforts = exact && Array.isArray(exact.meta.reasoning_options)
      && exact.meta.reasoning_options.some(option => isRecord(option) && option.type === "effort");
    return {
      ...fallbackModel(connection.id, detectedProtocol ?? connection.protocol, model.id, model.displayName),
      detectedProtocol,
      detectedReasoningEfforts: hasEfforts ? reasoningEfforts(exact.meta.reasoning_options) : null
    };
  }

  async enrichOne(connection: ConnectionDto, modelKey: string, displayName: string): Promise<EnrichedDiscoveredModel | null> {
    const result = await this.enrich(connection, [{ id: modelKey, displayName }]);
    const model = result.models[0];
    return model?.matched ? model : null;
  }

  private async load(): Promise<CatalogEntry[] | null> {
    if (Date.now() < this.expiresAt) return this.entries;
    if (this.pending) return this.pending;
    this.pending = this.fetchIndex();
    try {
      this.entries = await this.pending;
      this.expiresAt = Date.now() + (this.entries ? CATALOG_TTL_MS : FAILURE_TTL_MS);
      return this.entries;
    } finally {
      this.pending = null;
    }
  }

  private async fetchIndex(): Promise<CatalogEntry[] | null> {
    try {
      const response = await this.fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return null;
      const document = await response.json() as unknown;
      if (!isRecord(document) || "error" in document) return null;
      const entries: CatalogEntry[] = [];
      for (const [providerId, providerValue] of Object.entries(document)) {
        if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue;
        for (const [modelId, value] of Object.entries(providerValue.models)) {
          if (!isRecord(value)) continue;
          entries.push({
            providerId,
            modelId,
            modelKeys: modelKeys(modelId),
            meta: value,
            completeness: metadataCompleteness(value)
          });
        }
      }
      return entries.length ? entries : null;
    } catch {
      return null;
    }
  }
}

function applyCatalogEntry(
  fallback: CatalogModelInput,
  discovered: DiscoveredModel,
  entry: CatalogEntry,
  providerId: ConnectionDto["providerId"]
): CatalogModelInput {
  const meta = entry.meta;
  const limit = isRecord(meta.limit) ? meta.limit : null;
  const context = limit ? positiveInteger(limit.context) : undefined;
  const output = limit ? positiveInteger(limit.output) : undefined;
  const input = limit ? positiveInteger(limit.input) : undefined;
  const modalities = isRecord(meta.modalities) ? meta.modalities : {};
  const inputModalities = stringArray(modalities.input);
  const outputModalities = stringArray(modalities.output);
  const efforts = reasoningEfforts(meta.reasoning_options);
  const reasoning = typeof meta.reasoning === "boolean"
    ? meta.reasoning
    : efforts.length > 0
      ? efforts.some((effort) => effort !== "none")
      : fallback.capabilities.reasoning;
  const capabilities: ModelCapabilities = {
    ...fallback.capabilities,
    imageInput: inputModalities.includes("image"),
    ...(outputModalities.includes("image") ? { imageOutput: true, imageMultiple: true } : {}),
    tools: typeof meta.tool_call === "boolean" ? meta.tool_call : fallback.capabilities.tools,
    temperature: typeof meta.temperature === "boolean" ? meta.temperature : fallback.capabilities.temperature,
    reasoning,
    reasoningSummary: reasoning && fallback.capabilities.reasoningSummary,
    adaptiveThinking: reasoning && fallback.capabilities.adaptiveThinking,
    manualThinking: reasoning && fallback.capabilities.manualThinking
  };
  const validLimits = context !== undefined && output !== undefined;
  const maxOutputTokens = validLimits ? output : fallback.maxOutputTokens;
  const providerName = discovered.displayName.trim();
  const catalogName = typeof meta.name === "string" ? meta.name.trim() : "";
  return {
    ...fallback,
    displayName: providerName && normalizeId(providerName) !== normalizeId(discovered.id)
      ? providerName
      : catalogName || providerName || discovered.id,
    contextWindow: validLimits ? context : fallback.contextWindow,
    maxInputTokens: validLimits ? input ?? null : fallback.maxInputTokens,
    maxOutputTokens,
    imageProtocol: outputModalities.includes("image") ? inferImageProtocol(providerId, discovered.id) : null,
    capabilities,
    defaultSettings: {
      common: { maxOutputTokens: Math.min(4096, maxOutputTokens), stopSequences: [] },
      protocol: {}
    }
  };
}

function inferImageProtocol(providerId: ConnectionDto["providerId"], modelKey: string): ModelInput["imageProtocol"] {
  const normalized = modelKey.toLowerCase();
  if (providerId === "google") return normalized.includes("imagen") ? "google-imagen" : "google-interactions";
  if (providerId === "stability") return "stability-image";
  if (normalized.includes("imagen")) return "google-imagen";
  if (normalized.includes("dall-e") || normalized.includes("gpt-image") || normalized.includes("image-")) {
    return "openai-images";
  }
  return null;
}

function catalogMetadata(entry: CatalogEntry): ModelCatalogMetadata {
  const meta = entry.meta;
  const modalities = isRecord(meta.modalities) ? meta.modalities : {};
  const pricing = catalogPricing(meta.cost);
  return {
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...(typeof meta.description === "string" ? { description: meta.description } : {}),
    ...(typeof meta.family === "string" ? { family: meta.family } : {}),
    ...(typeof meta.release_date === "string" ? { releaseDate: meta.release_date } : {}),
    inputModalities: stringArray(modalities.input),
    outputModalities: stringArray(modalities.output),
    reasoningEfforts: reasoningEfforts(meta.reasoning_options),
    ...(pricing ? { pricing } : {}),
    fetchedAt: Date.now()
  };
}

function bestMatch(connection: ConnectionDto, modelId: string, entries: CatalogEntry[]): CatalogEntry | undefined {
  const targetKeys = modelKeys(modelId);
  const normalizedTarget = targetKeys[0] ?? "";
  const official = officialProvider(normalizedTarget);
  const providerHints = providerKeys(connection);
  const candidates = entries.filter((entry) => entry.modelKeys.some((candidate) =>
    targetKeys.some((target) => target === candidate || target.startsWith(`${candidate}-`))
  ));
  return candidates.sort((left, right) => {
    const leftScore = matchScore(left, normalizedTarget, providerHints, official);
    const rightScore = matchScore(right, normalizedTarget, providerHints, official);
    for (let index = 0; index < leftScore.length; index += 1) {
      const difference = (rightScore[index] ?? 0) - (leftScore[index] ?? 0);
      if (difference) return difference;
    }
    return `${left.providerId}\0${left.modelId}`.localeCompare(`${right.providerId}\0${right.modelId}`);
  })[0];
}

function matchScore(entry: CatalogEntry, target: string, hints: Set<string>, official?: string): number[] {
  const similarity = Math.max(...entry.modelKeys.map((key) => key === target ? 1 : key.length / Math.max(1, target.length)));
  const providerKey = normalizeId(entry.providerId);
  const providerAffinity = hints.has(providerKey) ? 2 : official === entry.providerId ? 1 : 0;
  return [similarity, providerAffinity, entry.completeness];
}

function providerKeys(connection: ConnectionDto): Set<string> {
  const result = new Set<string>();
  for (const value of [connection.providerId, connection.name, safeHostname(connection.baseUrl)]) {
    const normalized = normalizeId(value);
    if (normalized) result.add(normalized);
    for (const part of normalized.split("-")) if (part.length >= 3) result.add(part);
  }
  return result;
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return ""; }
}

function officialProvider(modelKey: string): string | undefined {
  if (/^o[1-9]\d*(?:-|$)/.test(modelKey)) return "openai";
  const brand = /^[a-z]+/.exec(modelKey)?.[0];
  return brand ? OFFICIAL_PROVIDERS[brand] : undefined;
}

function modelKeys(...values: string[]): string[] {
  return [...new Set(values.flatMap((value) => [value, value.split("/").at(-1) ?? ""]).map(normalizeId).filter(Boolean))];
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function reasoningEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values = new Set<string>();
  for (const option of raw) {
    if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const value of option.values) if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64) {
      values.add(value.trim());
    }
  }
  return [...values].slice(0, 20);
}

function catalogPricing(raw: unknown): ModelCatalogMetadata["pricing"] | undefined {
  if (!isRecord(raw)) return undefined;
  const input = finiteNumber(raw.input);
  const output = finiteNumber(raw.output);
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined;
  const tiers = Array.isArray(raw.tiers) ? raw.tiers.flatMap((tier) => priceTier(tier)) : [];
  if (isRecord(raw.context_over_200k)) tiers.push(...priceTier({ ...raw.context_over_200k, tier: { type: "context", size: 200_000 } }));
  return {
    input,
    output,
    ...(nonnegativeNumber(raw.reasoning) !== undefined ? { reasoning: nonnegativeNumber(raw.reasoning)! } : {}),
    ...(nonnegativeNumber(raw.cache_read) !== undefined ? { cacheRead: nonnegativeNumber(raw.cache_read)! } : {}),
    ...(nonnegativeNumber(raw.cache_write) !== undefined ? { cacheWrite: nonnegativeNumber(raw.cache_write)! } : {}),
    tiers
  };
}

function priceTier(raw: unknown): NonNullable<ModelCatalogMetadata["pricing"]>["tiers"] {
  if (!isRecord(raw)) return [];
  const input = nonnegativeNumber(raw.input);
  const output = nonnegativeNumber(raw.output);
  if (input === undefined || output === undefined) return [];
  const tier = isRecord(raw.tier) ? raw.tier : null;
  const contextTokens = tier?.type === "context" ? positiveInteger(tier.size) : undefined;
  return [{
    ...(contextTokens === undefined ? {} : { contextTokens }), input, output,
    ...(nonnegativeNumber(raw.cache_read) !== undefined ? { cacheRead: nonnegativeNumber(raw.cache_read)! } : {}),
    ...(nonnegativeNumber(raw.cache_write) !== undefined ? { cacheWrite: nonnegativeNumber(raw.cache_write)! } : {})
  }];
}

function metadataCompleteness(meta: JsonRecord): number {
  return [meta.limit, meta.modalities, meta.cost, meta.reasoning_options, meta.family, meta.release_date]
    .filter((value) => value !== undefined && value !== null).length;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}
