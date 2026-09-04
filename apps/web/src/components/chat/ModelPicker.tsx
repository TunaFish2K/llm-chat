import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { Bot, Check, ChevronDown, RefreshCw, Search, Settings2, X } from "lucide-react";
import type { ConnectionBalanceDto, ConnectionDto, ModelDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { navigate, routes } from "../../lib/router";
import { INHERIT } from "./model";

type BalanceState = ConnectionBalanceDto | "loading" | "error";

/**
 * Model chooser for the composer. Grouped by connection, searchable across
 * display name / model key / connection / protocol, and lazily showing the
 * account balance for connections that expose one.
 */
export function ModelPicker({
  effectiveModelId,
  explicitValue,
  agentModelId,
  models,
  connections,
  disabled,
  onChange
}: {
  effectiveModelId: string | null;
  explicitValue: string;
  agentModelId: string | null;
  models: ModelDto[];
  connections: ConnectionDto[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const touchLayout = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const effective = models.find((model) => model.id === effectiveModelId);
  const eligible = models.filter(
    (model) => model.enabled && connections.some((connection) => connection.id === model.connectionId)
  );
  const normalized = query.trim().toLocaleLowerCase();
  const groups = connections
    .map((connection) => ({
      connection,
      models: eligible.filter(
        (model) =>
          model.connectionId === connection.id &&
          [model.displayName, model.modelKey, connection.name, connection.protocol]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalized)
      )
    }))
    .filter((group) => group.models.length);

  useEffect(() => {
    if (!open) return;
    for (const connection of connections) {
      if (!connection.balanceConfig?.enabled || balances[connection.id]) continue;
      setBalances((current) => ({ ...current, [connection.id]: "loading" }));
      void endpoints
        .connectionBalance(connection.id)
        .then((result) => setBalances((current) => ({ ...current, [connection.id]: result })))
        .catch(() => setBalances((current) => ({ ...current, [connection.id]: "error" })));
    }
  }, [open, connections]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className="model-trigger" disabled={disabled} aria-label="选择模型" title="选择模型">
          <span className="model-mark">M</span>
          <span>{effective?.displayName ?? "选择模型"}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="picker-popover"
          side="top"
          align="start"
          sideOffset={10}
          onOpenAutoFocus={(event) => {
            if (touchLayout) event.preventDefault();
          }}
        >
          <header>
            <div>
              <strong>模型</strong>
              <span>仅影响当前会话</span>
            </div>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="关闭模型选择">
              <X size={15} />
            </button>
          </header>
          <label className="search-field">
            <Search size={15} aria-hidden="true" />
            <input
              autoFocus={!touchLayout}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型、连接或协议"
              aria-label="搜索模型"
            />
          </label>
          <div className="picker-list">
            <button
              type="button"
              className="model-option"
              data-selected={explicitValue === INHERIT || undefined}
              onClick={() => {
                onChange(INHERIT);
                setOpen(false);
              }}
            >
              <Bot size={18} aria-hidden="true" />
              <span>
                <strong>跟随 Agent</strong>
                <small>{models.find((model) => model.id === agentModelId)?.displayName ?? "Agent 未配置模型"}</small>
              </span>
              {explicitValue === INHERIT ? <Check size={15} aria-hidden="true" /> : null}
            </button>
            {groups.map(({ connection, models: items }) => (
              <section className="model-group" key={connection.id}>
                <h3>
                  <span>{connection.name}</span>
                  <small>{connection.protocol}</small>
                  <Balance value={balances[connection.id]} />
                </h3>
                {items.map((model) => (
                  <button
                    type="button"
                    className="model-option"
                    key={model.id}
                    data-selected={effectiveModelId === model.id || undefined}
                    onClick={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                  >
                    <span className="model-mark">M</span>
                    <span>
                      <strong>{model.displayName}</strong>
                      <small>{model.modelKey}</small>
                    </span>
                    <span className="model-badges">
                      {model.capabilities.imageInput ? <i>图片</i> : null}
                      {model.capabilities.tools ? <i>工具</i> : null}
                      {model.capabilities.reasoning ? <i>推理</i> : null}
                    </span>
                    {effectiveModelId === model.id ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                ))}
              </section>
            ))}
            {!groups.length ? <div className="picker-empty">没有匹配的可用模型</div> : null}
          </div>
          <button
            type="button"
            className="picker-footer"
            onClick={() => {
              setOpen(false);
              navigate(routes.settings("connections"));
            }}
          >
            <Settings2 size={15} aria-hidden="true" />
            管理连接与模型
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Balance({ value }: { value: BalanceState | undefined }) {
  if (!value) return null;
  if (value === "loading") return <RefreshCw size={12} className="spin" aria-hidden="true" />;
  if (value === "error") return <small className="danger-text">余额失败</small>;
  return <small>余额 {new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value.value)}</small>;
}
