import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Claude from "@lobehub/icons/es/Claude/components/Color";
import Gemini from "@lobehub/icons/es/Gemini/components/Color";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color";
import Grok from "@lobehub/icons/es/Grok/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Color";
import Kimi from "@lobehub/icons/es/Kimi/components/Color";
import Minimax from "@lobehub/icons/es/Minimax/components/Color";
import Mistral from "@lobehub/icons/es/Mistral/components/Color";
import Meta from "@lobehub/icons/es/Meta/components/Color";
import ChatGLM from "@lobehub/icons/es/ChatGLM/components/Color";
import Doubao from "@lobehub/icons/es/Doubao/components/Color";
import Stability from "@lobehub/icons/es/Stability/components/Color";
import Flux from "@lobehub/icons/es/Flux/components/Mono";
import Cohere from "@lobehub/icons/es/Cohere/components/Color";
import Hunyuan from "@lobehub/icons/es/Hunyuan/components/Color";
import Yi from "@lobehub/icons/es/Yi/components/Color";
import Baidu from "@lobehub/icons/es/Baidu/components/Color";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Color";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Color";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import Google from "@lobehub/icons/es/Google/components/Color";
import ZAI from "@lobehub/icons/es/ZAI/components/Mono";
import Volcengine from "@lobehub/icons/es/Volcengine/components/Color";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono";
import { Cpu } from "lucide-react";
import type { ModelDto, ConnectionDto } from "@llm-chat/contracts";

const modelIcons = [
  [/claude/i, Claude], [/gemini|gemma/i, Gemini], [/deepseek|深度求索/i, DeepSeek],
  [/grok/i, Grok], [/qwen|qwq|通义|千问/i, Qwen], [/kimi/i, Kimi],
  [/minimax|海螺/i, Minimax], [/mistral|mixtral|codestral|devstral|magistral/i, Mistral],
  [/llama/i, Meta], [/glm|智谱/i, ChatGLM], [/doubao|seed|豆包/i, Doubao],
  [/stable.?diffusion|stable.?image|sdxl|sd3/i, Stability], [/flux/i, Flux],
  [/command|cohere/i, Cohere], [/hunyuan|混元/i, Hunyuan], [/^yi[- /]|零一万物/i, Yi],
  [/ernie|文心/i, Baidu], [/sonar|perplexity/i, Perplexity],
  [/gpt|chatgpt|codex|dall.e|(^|[/ -])o[1345]([- /]|$)/i, OpenAI]
] as const;
const providerIcons: Record<string, typeof OpenAI> = {
  openai: OpenAI, anthropic: Anthropic, google: Google, deepseek: DeepSeek, xai: Grok,
  alibaba: Qwen, moonshot: Moonshot, moonshotai: Moonshot, minimax: Minimax, mistral: Mistral,
  meta: Meta, zhipuai: ChatGLM, zai: ZAI, "z.ai": ZAI, volcengine: Volcengine,
  stability: Stability, cohere: Cohere, openrouter: OpenRouter, perplexity: Perplexity
};

export function resolveModelIcon(model?: Pick<ModelDto, "modelKey" | "displayName" | "catalogMetadata">, connection?: Pick<ConnectionDto, "providerId">) {
  if (!model) return Cpu;
  for (const candidate of [model.catalogMetadata?.modelId, model.modelKey, model.catalogMetadata?.family, model.displayName]) {
    if (!candidate) continue;
    const match = modelIcons.find(([pattern]) => pattern.test(candidate));
    if (match) return match[1];
  }
  return providerIcons[model.catalogMetadata?.providerId?.toLowerCase() ?? ""]
    ?? providerIcons[connection?.providerId ?? ""] ?? Cpu;
}

export function ModelBrandIcon({ model, connection, size = 20 }: {
  model?: Pick<ModelDto, "modelKey" | "displayName" | "catalogMetadata"> | undefined;
  connection?: Pick<ConnectionDto, "providerId"> | undefined; size?: number;
}) {
  const Icon = resolveModelIcon(model, connection);
  return <span className="model-brand-icon" data-brand={Icon === Kimi ? "kimi" : undefined} aria-hidden="true"><Icon size={size} /></span>;
}
