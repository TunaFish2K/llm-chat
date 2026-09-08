import { z } from "zod";
import type { QueuedMessageDto } from "./index";

export const searchEngineInputSchema = z.object({
  id: z.string().min(1).max(100),
  provider: z.enum(["searxng", "tavily"]),
  enabled: z.boolean(),
  baseUrl: z.string().url().or(z.literal("")),
  apiKey: z.string().max(4096).optional()
});
export const serviceSettingsInputSchema = z.object({
  searchEngines: z.array(searchEngineInputSchema).max(100).optional(),
  imageModels: z.array(z.object({ modelId: z.string().uuid(), enabled: z.boolean() })).max(1000).optional()
});
export type ServiceSettingsInput = z.infer<typeof serviceSettingsInputSchema>;
export interface SearchEngineDto {
  id: string; provider: "searxng" | "tavily"; enabled: boolean; baseUrl: string; hasApiKey: boolean; available: boolean;
}
export interface ImageToolModelDto {
  modelId: string; id: string; name: string; connectionName: string; enabled: boolean; available: boolean; protocol: string | null;
}
export interface ServiceSettingsDto { searchEngines: SearchEngineDto[]; imageModels: ImageToolModelDto[] }
export interface MessageQueueStateDto { items: QueuedMessageDto[]; paused: boolean }
