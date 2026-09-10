import type { ToolMarkdown, ToolPresentation, ToolResultFormatInput } from "@llm-chat/contracts";

/** Callbacks must be pure, fast projections of the supplied data. */
export interface ToolFormatters {
  formatArguments?: (input: Record<string, unknown>) => ToolMarkdown | Promise<ToolMarkdown>;
  formatResult?: (result: ToolResultFormatInput) => ToolMarkdown | Promise<ToolMarkdown>;
}

const builtinNames = new Set(`browser_fetch get_time_info eval_javascript fetch_url search_web image_generate recent_chats conversation_search memory_tool workspace_list workspace_read_file workspace_write_file workspace_edit_file workspace_glob workspace_grep workspace_shell workspace_shell_readonly workspace_publish_image workspace_publish_file use_skill codex_runtime codex_sessions codex_start codex_send codex_wait codex_respond codex_interrupt background_start background_read background_wait background_write background_stop background_list search_tools plugin_install plugin_reload plugin_unload plugin_remove skill_install skill_reload app_agents app_conversations app_settings app_connections app_models app_mcp_servers app_skills app_plugins app_tool_settings app_roleplay`.split(" "));

function clip(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = "…（已截断）";
  return Buffer.from(value).subarray(0, bytes - Buffer.byteLength(suffix)).toString("utf8").replace(/\uFFFD$/, "") + suffix;
}

export function normalizeToolMarkdown(value: unknown): ToolMarkdown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ((candidate.summary !== undefined && typeof candidate.summary !== "string") || (candidate.detail !== undefined && typeof candidate.detail !== "string")) return undefined;
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const detail = typeof candidate.detail === "string" ? candidate.detail.trim() : "";
  return summary || detail ? {
    ...(summary ? { summary: Array.from(summary).length > 512 ? Array.from(summary).slice(0, 503).join("") + "…（已截断）" : summary } : {}),
    ...(detail ? { detail: clip(detail, 64 * 1024) } : {})
  } : undefined;
}

/** Formatting never retries execution or changes its outcome. */
export async function formatTool<T>(formatter: ((input: T) => unknown) | undefined, input: T): Promise<ToolMarkdown | undefined> {
  if (!formatter) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return normalizeToolMarkdown(await Promise.race([
      Promise.resolve().then(() => formatter(input)),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000); })
    ]));
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}
function text(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }
function inline(value: unknown): string { return text(value).replace(/[\\`*_{}\[\]()<>#!|~]/g, "\\$&").replace(/\s+/g, " "); }
function code(value: unknown, language = ""): string {
  const content = text(value);
  const fence = "`".repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${fence}${language}\n${content}\n${fence}`;
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function fields(value: unknown, depth = 0): string {
  if (typeof value === "string") return code(value);
  if (Array.isArray(value)) {
    if (!value.length) return "（空列表）";
    if (value.every((item) => typeof item === "string")) return value.slice(0, 100).map((item) => `- ${inline(item)}`).join("\n") + (value.length > 100 ? "\n\n…请查看原始数据。" : "");
    if (value.every(object)) {
      const columns = [...new Set(value.flatMap((item) => Object.keys(item)))];
      if (columns.length > 0 && columns.length <= 6 && value.every((item) => columns.every((key) => !object(item[key]) && !Array.isArray(item[key])))) {
        return `| ${columns.map(inline).join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n` + value.slice(0, 100).map((item) => `| ${columns.map((key) => inline(item[key] ?? "")).join(" | ")} |`).join("\n") + (value.length > 100 ? "\n\n…请查看原始数据。" : "");
      }
    }
    return value.slice(0, 100).map((item, i) => `**${i + 1}**\n\n${fields(item, depth + 1)}`).join("\n\n") + (value.length > 100 ? `\n\n…另有 ${value.length - 100} 项，请查看原始数据。` : "");
  }
  if (!object(value) || depth > 3) return code(value, "json");
  if (Object.keys(value).length && Object.values(value).every((item) => !object(item) && !Array.isArray(item) && !(typeof item === "string" && item.includes("\n")))) {
    return "| 字段 | 值 |\n| --- | --- |\n" + Object.entries(value).map(([key, item]) => `| ${inline(key)} | ${inline(item)} |`).join("\n");
  }
  return Object.entries(value).map(([key, item]) => `**${inline(key)}**\n\n${object(item) || Array.isArray(item) ? fields(item, depth + 1) : typeof item === "string" && item.includes("\n") ? code(item) : inline(item)}`).join("\n\n") || "（无参数）";
}
function language(path: unknown): string {
  const ext = typeof path === "string" ? path.split(".").at(-1) : "";
  return ({ ts: "typescript", tsx: "tsx", js: "javascript", py: "python", json: "json", sh: "bash", md: "markdown", css: "css", html: "html" } as Record<string, string>)[ext ?? ""] ?? "";
}

export function builtinToolFormatters(name: string): ToolFormatters | undefined {
  if (!builtinNames.has(name)) return undefined;
  return {
    formatArguments(input) {
      const summary = inline(input.command ?? input.code ?? input.query ?? input.path ?? input.url ?? input.prompt ?? [input.action, input.id ?? input.task_id ?? input.name].filter(Boolean).join(" · ")) || "无参数";
      let detail = fields(input);
      if (["workspace_shell", "workspace_shell_readonly", "eval_javascript"].includes(name)) {
        const { command, code: source, ...rest } = input;
        detail = code(command ?? source ?? "", name === "eval_javascript" ? "javascript" : "bash") + (Object.keys(rest).length ? `\n\n${fields(rest)}` : "");
      } else if (name === "workspace_edit_file") {
        const { old_text, new_text, ...rest } = input;
        detail = `${fields(rest)}\n\n**替换前**\n\n${code(old_text, language(input.path))}\n\n**替换后**\n\n${code(new_text, language(input.path))}`;
      } else if (name === "workspace_write_file") {
        const { text: content, ...rest } = input;
        detail = `${fields(rest)}\n\n${code(content, language(input.path))}`;
      }
      return normalizeToolMarkdown({ summary, detail })!;
    },
    formatResult({ input, output, error }) {
      const value = parse(output ?? "");
      let detail = fields(value);
      let summary = error ? `失败：${inline(error)}` : Array.isArray(value) ? `${value.length} 项` : "已完成";
      if (object(value)) {
        const count = Object.values(value).find(Array.isArray);
        summary = error ? summary : inline(value.status ?? (value.exitCode !== undefined ? `退出码 ${value.exitCode}` : count ? `${count.length} 项` : "已完成"));
        if (typeof value.stdout === "string" || typeof value.stderr === "string") {
          const { stdout, stderr, ...rest } = value;
          detail = `${fields(rest)}\n\n**stdout**\n\n${code(stdout ?? "")}\n\n**stderr**\n\n${code(stderr ?? "")}`;
        } else if (["image_generate", "workspace_publish_image", "workspace_publish_file"].includes(name)) {
          const { assets, asset, markdown: _markdown, ...rest } = value;
          const files = Array.isArray(assets) ? assets : asset ? [asset] : [];
          detail = fields(rest) + "\n\n" + files.filter(object).map((file) => typeof file.url === "string" && /^\/api\/(images|files)\//.test(file.url) ? `[${inline(file.fileName ?? "文件")}](${file.url.replace(/[()\s]/g, encodeURIComponent)})` : fields(file)).join("\n\n");
          summary = error ? summary : `${files.length} 个文件`;
        } else if (name === "workspace_read_file") {
          const { content, text: fileText, ...rest } = value;
          detail = `${fields(rest)}\n\n${code(content ?? fileText ?? "", language(input.path))}`;
        } else if (name === "fetch_url" || name === "browser_fetch") {
          detail = `${typeof value.url === "string" && /^https?:\/\//.test(value.url) ? `<${value.url.replace(/[<>\s]/g, encodeURIComponent)}>` : ""}\n\n${code(value.text ?? value.content ?? "")}`;
        } else if (name === "search_web" && Array.isArray(value.results)) {
          detail = value.results.map((item) => object(item) ? `**${inline(item.title ?? "结果")}**\n\n${typeof item.url === "string" && /^https?:\/\//.test(item.url) ? `<${item.url.replace(/[<>\s]/g, encodeURIComponent)}>` : ""}\n\n${inline(item.snippet ?? item.text ?? item.content ?? "")}` : fields(item)).join("\n\n");
        }
      } else if (name === "search_web" && Array.isArray(value)) {
        detail = value.map((item) => object(item) ? `**${inline(item.title ?? "结果")}**\n\n${typeof item.url === "string" && /^https?:\/\//.test(item.url) ? `<${item.url.replace(/[<>\s]/g, encodeURIComponent)}>` : ""}\n\n${inline(item.snippet ?? item.text ?? item.content ?? "")}` : fields(item)).join("\n\n");
      } else if (name === "use_skill" && typeof value === "string") detail = value;
      return normalizeToolMarkdown({ summary, detail })!;
    }
  };
}

/** Legacy builtins are pure projections; viewing history never loads a plugin. */
export function legacyToolPresentation(name: string, argumentsJson: string, output: string | null, error: string | null): ToolPresentation | undefined {
  const formatter = builtinToolFormatters(name);
  const input = parse(argumentsJson);
  if (!formatter || !object(input)) return undefined;
  try {
    return {
      arguments: normalizeToolMarkdown(formatter.formatArguments!(input)),
      ...(output !== null ? { result: normalizeToolMarkdown(formatter.formatResult!({ input, output, error })) } : {})
    } as ToolPresentation;
  } catch { return undefined; }
}
