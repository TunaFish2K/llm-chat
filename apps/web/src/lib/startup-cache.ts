import type { BootstrapDto } from "./api";
import { agentExecutionConfigSchema, appSettingsSchema, modelCapabilitiesSchema } from "@llm-chat/contracts";

const KEY = "llm-chat.startup.v1";
export type StartupSnapshot = Omit<BootstrapDto, "messages"> & { sourceId: string };
let pending: ReturnType<typeof setTimeout> | undefined;

export function readStartupCache(): StartupSnapshot | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value?.version !== 1 || typeof value.data?.sourceId !== "string" || !value.data.sourceId) return;
    const data = value.data;
    if (!data.settings || typeof data.settings.defaultAgentId !== "string" || typeof data.settings.lastAgentId !== "string"
      || !appSettingsSchema.omit({ defaultAgentId: true, lastAgentId: true }).safeParse(data.settings).success) return;
    for (const field of ["agents", "connections", "models", "conversations"]) {
      if (!Array.isArray(data[field]) || !data[field].every((item: unknown) => item && typeof item === "object" && "id" in item && typeof item.id === "string")) return;
    }
    if (!data.agents.every((item: StartupSnapshot["agents"][number]) => typeof item.name === "string"
      && Array.isArray(item.alternateGreetings) && agentExecutionConfigSchema.safeParse(item.execution).success)) return;
    if (!data.models.every((item: StartupSnapshot["models"][number]) => typeof item.displayName === "string" && typeof item.connectionId === "string"
      && item.defaultSettings && modelCapabilitiesSchema.safeParse(item.capabilities).success)) return;
    if (!data.connections.every((item: StartupSnapshot["connections"][number]) => typeof item.name === "string" && typeof item.baseUrl === "string" && Array.isArray(item.secretHeaderNames))) return;
    if (!data.conversations.every((item: StartupSnapshot["conversations"][number]) => typeof item.title === "string" && typeof item.draft === "string"
      && typeof item.updatedAt === "number" && item.executionOverrides && typeof item.executionOverrides === "object")) return;
    return data as StartupSnapshot;
  } catch { return; }
}

export function scheduleStartupCache(read: () => StartupSnapshot | undefined): void {
  if (pending !== undefined) clearTimeout(pending);
  // Catalogs and the conversation index are small; message bodies stay in IndexedDB.
  pending = setTimeout(() => {
    pending = undefined;
    const data = read();
    if (!data) return;
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, data })); } catch { /* Storage never gates the interface. */ }
  }, 250);
}

export function clearStartupCache(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  try { localStorage.removeItem(KEY); } catch {}
}
