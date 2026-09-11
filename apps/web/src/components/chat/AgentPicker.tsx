import { useBackLayer } from "../../lib/mobile-navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Bot, Check, Search, X } from "lucide-react";
import type { AgentSummaryDto } from "@llm-chat/contracts";

function AgentAvatar({ agent }: { agent: AgentSummaryDto | undefined }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [agent?.id, agent?.updatedAt]);
  return <span className="agent-picker-avatar" aria-hidden="true">
    {agent?.hasAvatar && !failed
      ? <img src={`/api/agents/${agent.id}/avatar?t=${agent.updatedAt}`} alt="" onError={() => setFailed(true)} />
      : <Bot size={18} />}
  </span>;
}

export function AgentPicker({ agents, value, disabled, onChange, menuItem = false }: {
  agents: AgentSummaryDto[]; value: string; disabled: boolean; onChange: (id: string) => void;
  menuItem?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const selected = agents.find((agent) => agent.id === value);
  const matches = useMemo(() => {
    if (!open) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return agents.filter((agent) => `${agent.name}\n${agent.description}`.toLocaleLowerCase().includes(normalized));
  }, [open, agents, query]);
  useEffect(() => { setOpen(false); setQuery(""); }, [value, disabled]);
  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
    <Popover.Trigger asChild>
      <button type="button" className={menuItem ? "agent-menu-item" : "chip composer-agent-select agent-trigger"} aria-label="选择 Agent"
        title={selected?.name ?? "选择 Agent"} disabled={disabled || !agents.length}>
        <Bot size={26} aria-hidden="true" />
        {menuItem ? <span><strong>Agent</strong><small>{selected?.name ?? "未选择"}</small></span> : null}
      </button>
    </Popover.Trigger>
    {open ? <Popover.Portal><Popover.Content className="picker-popover agent-popover" aria-label="Agent 选择" side="top" align="start" sideOffset={10}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) search.current?.focus();
      }}>
      <header><div><strong>Agent</strong><span>选择会话助手</span></div>
        <button type="button" className="icon-button" aria-label="关闭 Agent 选择" onClick={() => { setOpen(false); setQuery(""); }}><X size={15} /></button>
      </header>
      <label className="search-field"><Search size={15} aria-hidden="true" />
        <input ref={search} type="search" aria-label="搜索 Agent" placeholder="搜索名称或描述" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="picker-list">
        {matches.map((agent) => <button type="button" className="model-option agent-option" key={agent.id}
          aria-label={agent.name} aria-pressed={agent.id === value} data-selected={agent.id === value || undefined}
          onClick={() => { setOpen(false); setQuery(""); if (agent.id !== value) onChange(agent.id); }}>
          <AgentAvatar agent={agent} /><span><strong>{agent.name}</strong>{agent.description ? <small>{agent.description}</small> : null}</span>
          {agent.id === value ? <Check size={15} aria-hidden="true" /> : null}
        </button>)}
        {!matches.length ? <div className="picker-empty">没有匹配的 Agent</div> : null}
      </div>
    </Popover.Content></Popover.Portal> : null}
  </Popover.Root>;
}
