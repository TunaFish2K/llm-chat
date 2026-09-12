import { t, useLocale, getLocale } from "../../lib/i18n";
import { useBackLayer } from "../../lib/mobile-navigation";
import { useEffect, useMemo, useState } from "react";
import { Popover } from "radix-ui";
import { Bot, Check, RefreshCw, Search, Settings2, X } from "lucide-react";
import type { ConnectionBalanceDto, ConnectionDto, ModelDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { navigate, routes } from "../../lib/router";
import { INHERIT } from "./model";
import { ModelBrandIcon } from "./ModelBrandIcon";

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
  useLocale();
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  const [query, setQuery] = useState("");
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const touchLayout = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const effective = models.find((model) => model.id === effectiveModelId);
  const groups = useMemo(() => {
    if (!open) return [];
    const eligible = models.filter(
      (model) => model.enabled && connections.some((connection) => connection.id === model.connectionId)
    );
    const normalized = query.trim().toLocaleLowerCase();
    return connections
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
  }, [open, models, connections, query]);

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
        <button type="button" className="model-trigger" disabled={disabled} aria-label={t("ModelPicker.select_model")} title={effective?.displayName ?? t("ModelPicker.select_model")}>
          <ModelBrandIcon model={effective} connection={connections.find((item) => item.id === effective?.connectionId)} />
        </button>
      </Popover.Trigger>
      {open ? <Popover.Portal>
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
              <strong>{t("InspectorPanel.model")}</strong>
              <span>{t("ModelPicker.agents_without_a_default_model_remember_your_selection")}</span>
            </div>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label={t("ModelPicker.close_model_picker")}>
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
              data-selected={explicitValue === INHERIT || undefined}
              onClick={() => {
                onChange(INHERIT);
                setOpen(false);
              }}
            >
              <Bot size={18} aria-hidden="true" />
              <span>
                <strong>{t("dialogs.follow_agent_2")}</strong>
                <small>{models.find((model) => model.id === agentModelId)?.displayName ?? t("ModelPicker.no_model_configured_for_this_agent")}</small>
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
                    <ModelBrandIcon model={model} connection={connection} />
                    <span>
                      <strong>{model.displayName}</strong>
                      <small>{model.modelKey}</small>
                    </span>
                    <span className="model-badges">
                      {model.capabilities.imageInput ? <i>{t("ModelPicker.images")}</i> : null}
                      {model.capabilities.imageOutput ? <i>{t("ModelPicker.image_generation")}</i> : null}
                      {model.capabilities.tools ? <i>{t("SettingsView.tools")}</i> : null}
                      {model.capabilities.reasoning ? <i>{t("TrajectoryView.reasoning")}</i> : null}
                    </span>
                    {effectiveModelId === model.id ? <Check size={15} aria-hidden="true" /> : null}
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
              setOpen(false);
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
