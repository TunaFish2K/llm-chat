import { ActionButton } from "../../lib/action-feedback";
import { useState } from "react";
import type { ToolCallDto } from "@llm-chat/contracts";
import { Markdown } from "../../lib/markdown";
import { CodeField, copyText } from "./atoms";
import { prettyJson } from "./model";

export function ToolCallSummary({ call }: { call: ToolCallDto }) {
  const summary = [call.presentation?.arguments?.summary, call.presentation?.result?.summary].filter(Boolean).join(" · ");
  return summary ? <span className="tool-markdown-summary"><Markdown text={summary} inline /></span> : null;
}

export function ToolCallContent({ call }: { call: ToolCallDto }) {
  const [raw, setRaw] = useState(false);
  const formatted = Boolean(call.presentation?.arguments?.detail || call.presentation?.result?.detail);
  return <div className="tool-presentation">
    {formatted ? <ActionButton type="button" className="link-button" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? "查看格式化内容" : "查看原始数据"}</ActionButton> : null}
    {!raw && call.presentation?.arguments?.detail
      ? <section><span className="small muted">参数</span><Markdown text={call.presentation.arguments.detail} /></section>
      : <RawToolField label="参数" value={call.arguments} />}
    {!raw && call.presentation?.result?.detail
      ? <section><span className="small muted">输出</span><Markdown text={call.presentation.result.detail} /></section>
      : call.output !== null ? <RawToolField label="输出" value={call.output} /> : null}
    {call.error ? <CodeField label="错误" value={call.error} danger /> : null}
  </div>;
}

function RawToolField({ label, value }: { label: string; value: string }) {
  return <section><ActionButton type="button" className="link-button" onClick={() => copyText(value)}>复制原始{label}</ActionButton><CodeField label={label} value={prettyJson(value)} /></section>;
}
