import { t, useLocale, getLocale } from "../lib/i18n";
import { useBackLayer } from "../lib/mobile-navigation";
import { useEffect, useMemo, useState } from "react";
import { Popover } from "radix-ui";
import { Bot, Check, ChevronDown, RefreshCw, Search, Settings2, X } from "lucide-react";
import type { ConnectionBalanceDto, ConnectionDto, ModelDto } from "@llm-chat/contracts";
import { resolveModelProtocol } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { navigate, routes } from "../lib/router";
import { ModelBrandIcon } from "./chat/ModelBrandIcon";
import { Highlight, literalSearchPattern } from "./Highlight";

type BalanceState = ConnectionBalanceDto | "loading" | "error";

/** Shared model chooser for chat and Agent execution settings. */
export function ModelPicker({
  value, models, connections, disabled = false, onChange, label,
  description, emptyOption, appearance = "field", imageInputOnly = false
}: {
  value: string | null;
  models: ModelDto[];
  connections: ConnectionDto[];
  disabled?: boolean;
  onChange: (modelId: string) => void;
  label: string;
  description?: string;
  emptyOption: { label: string; description?: string; selected: boolean; onSelect: () => void };
  appearance?: "icon" | "field";
  imageInputOnly?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const changeOpen = (next: boolean) => { setOpen(next); if (!next) setQuery(""); };
  useBackLayer(open, () => changeOpen(false));
  useEffect(() => { if (disabled) changeOpen(false); }, [disabled]);
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const touchLayout = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const effective = models.find((model) => model.id === value);
  const connection = connections.find((item) => item.id === effective?.connectionId);
  const unavailable = value !== null && (!effective?.enabled || !connection || (imageInputOnly && !effective.capabilities.imageInput));
  const selectedName = value === null ? emptyOption.label : effective?.displayName ?? value;
  const groups = useMemo(() => {
    if (!open) return [];
    const eligible = models.filter(
      (model) => model.enabled && (!imageInputOnly || model.capabilities.imageInput) && connections.some((connection) => connection.id === model.connectionId)
    );
    const pattern = literalSearchPattern(query);
    return connections
      .map((connection) => ({
        connection,
        models: eligible.filter(
          (model) =>
            model.connectionId === connection.id &&
            (!pattern || [model.displayName, model.modelKey, connection.name, resolveModelProtocol(model, connection)]
              .some(text => text.search(pattern) >= 0))
        )
      }))
      .filter((group) => group.models.length);
  }, [open, models, connections, query, imageInputOnly]);

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
      onOpenChange={changeOpen}
    >
      <Popover.Trigger asChild>
        <button type="button" className={appearance === "icon" ? "model-trigger" : "model-field-trigger"}
          disabled={disabled} aria-label={label} title={selectedName}>
          <ModelBrandIcon model={effective} connection={connection} />
          {appearance === "field" ? <>
            <span className="model-field-value"><span>{selectedName}</span>
              {unavailable ? <small>{t("SettingsView.unavailable")}</small> : null}
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </> : null}
        </button>
      </Popover.Trigger>
      {open ? <Popover.Portal>
        <Popover.Content
          className="picker-popover model-picker-popover"
          aria-label={label}
          data-searching={Boolean(query.trim()) || undefined}
          side={appearance === "icon" ? "top" : "bottom"}
          align="start"
          sideOffset={10}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            if (touchLayout) event.preventDefault();
          }}
        >
          <header>
            <div>
              <strong>{label}</strong>
              {description ? <span>{description}</span> : null}
            </div>
            <button type="button" className="icon-button" onClick={() => changeOpen(false)} aria-label={t("ModelPicker.close_model_picker")}>
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
              placeholder={t("ModelPicker.search_models_connections_or_protocols")}
              aria-label={t("ModelPicker.search_models")}
            />
          </label>
          <div className="picker-list">
            <button
              type="button"
              className="model-option"
              data-selected={emptyOption.selected || undefined}
              onClick={() => {
                emptyOption.onSelect();
                changeOpen(false);
              }}
            >
              <Bot size={18} aria-hidden="true" />
              <span>
                <strong>{emptyOption.label}</strong>
                {emptyOption.description ? <small>{emptyOption.description}</small> : null}
              </span>
              {emptyOption.selected ? <Check size={15} aria-hidden="true" /> : null}
            </button>
            {groups.map(({ connection, models: items }) => (
              <section className="model-group" key={connection.id}>
                <h3>
                  <span><Highlight text={connection.name} query={query} /></span>
                  <Balance value={balances[connection.id]} />
                </h3>
                {items.map((model) => (
                  <button
                    type="button"
                    className="model-option"
                    key={model.id}
                    data-selected={value === model.id || undefined}
                    onClick={() => {
                      onChange(model.id);
                      changeOpen(false);
                    }}
                  >
                    <ModelBrandIcon model={model} connection={connection} />
                    <span>
                      <strong><Highlight text={model.displayName} query={query} /></strong>
                      <small><Highlight text={model.modelKey} query={query} /> · <Highlight text={resolveModelProtocol(model, connection)} query={query} /></small>
                    </span>
                    <span className="model-badges">
                      {model.capabilities.imageInput ? <i>{t("ModelPicker.images")}</i> : null}
                      {model.capabilities.imageOutput ? <i>{t("ModelPicker.image_generation")}</i> : null}
                      {model.capabilities.tools ? <i>{t("SettingsView.tools")}</i> : null}
                      {model.capabilities.reasoning ? <i>{t("TrajectoryView.reasoning")}</i> : null}
                    </span>
                    {value === model.id ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                ))}
              </section>
            ))}
            {!groups.length ? <div className="picker-empty">{t("ModelPicker.no_matching_available_models")}</div> : null}
          </div>
          <button
            type="button"
            className="picker-footer"
            onClick={() => {
              changeOpen(false);
              navigate(routes.settings("connections"));
            }}
          >
            <Settings2 size={15} aria-hidden="true" />{t("ModelPicker.manage_connections_and_models")}</button>
        </Popover.Content>
      </Popover.Portal> : null}
    </Popover.Root>
  );
}

function Balance({ value }: { value: BalanceState | undefined }) {
  useLocale();
  if (!value) return null;
  if (value === "loading") return <RefreshCw size={12} className="spin" aria-hidden="true" />;
  if (value === "error") return <small className="danger-text">{t("ModelPicker.balance_check_failed")}</small>;
  return <small>{t("ModelPicker.balance", { value1: (new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 4 }).format(value.value)) })}</small>;
}
