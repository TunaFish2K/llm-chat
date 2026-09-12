import { displayError } from "../../lib/error-display";
import { localizedToolFormatters } from "@llm-chat/i18n/tool-presentation";
import { t, useLocale, getLocale } from "../../lib/i18n";
import { useState } from "react";
import type { ToolCallDto } from "@llm-chat/contracts";
import { Markdown } from "../../lib/markdown";
import { CodeField, copyText } from "./atoms";
import { prettyJson } from "./model";

export function ToolCallSummary({ call }: { call: ToolCallDto }) {
  useLocale();
  const presentation = localizedPresentation(call);
  const summary = [presentation?.arguments?.summary, presentation?.result?.summary].filter(Boolean).join(" · ");
  return summary ? <span className="tool-markdown-summary"><Markdown text={summary} inline /></span> : null;
}

export function ToolCallContent({ call }: { call: ToolCallDto }) {
  useLocale();
  const presentation = localizedPresentation(call);
  const [raw, setRaw] = useState(false);
  const formatted = Boolean(presentation?.arguments?.detail || presentation?.result?.detail);
  return <div className="tool-presentation">
    {formatted ? <button type="button" className="link-button" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? t("ToolPresentation.view_formatted_content") : t("ToolPresentation.view_raw_data")}</button> : null}
    {!raw && presentation?.arguments?.detail
      ? <section><span className="small muted">{t("ToolPresentation.arguments")}</span><Markdown text={presentation.arguments.detail} /></section>
      : <RawToolField label={t("ToolPresentation.arguments")} value={call.arguments} />}
    {!raw && presentation?.result?.detail
      ? <section><span className="small muted">{t("InspectorPanel.output")}</span><Markdown text={presentation.result.detail} /></section>
      : call.output !== null ? <RawToolField label={t("InspectorPanel.output")} value={call.output} /> : null}
    {call.error ? <CodeField label={t("SettingsView.error")} value={toolError(call)} danger /> : null}
  </div>;
}

function RawToolField({ label, value }: { label: string; value: string }) {
  useLocale();
  return <section><button type="button" className="link-button" onClick={() => void copyText(value)}>{t("ToolPresentation.copy_raw", { value1: (label) })}</button><CodeField label={label} value={prettyJson(value)} /></section>;
}

function localizedPresentation(call: ToolCallDto) {
  const descriptor = call.presentation?.builtin;
  if (descriptor?.version !== 1 || descriptor.name !== call.name) return call.presentation;
  const formatter = localizedToolFormatters(descriptor.name, getLocale());
  if (!formatter) return call.presentation;
  try {
    const input: unknown = JSON.parse(call.arguments);
    if (!input || typeof input !== "object" || Array.isArray(input)) return call.presentation;
    return {
      arguments: formatter.formatArguments(input as Record<string, unknown>),
      ...(call.output !== null ? { result: formatter.formatResult({ input: input as Record<string, unknown>, output: call.output, error: call.error ? toolError(call) : null }) } : {})
    };
  } catch { return call.presentation; }
}

function toolError(call: ToolCallDto): string { return displayError({ message: call.error ?? "", ...(call.errorI18n ? { i18n: call.errorI18n } : {}) }); }
