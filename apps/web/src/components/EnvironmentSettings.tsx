import { resourceName } from "./ContainerResourceSettings";
import type { ContainerResourceItem } from "@llm-chat/contracts";
import { Button } from "./ui";
import { useEffect, useState } from "react";
import type { ContainerEngineDto, ConversationEnvironmentDto, ExecutionEnvironment } from "@llm-chat/contracts";
import { linkClick, routes } from "../lib/router";
import { endpoints } from "../lib/api";
import { t, useLocale } from "../lib/i18n";
import { Field } from "../lib/ui";
import { toastError } from "../lib/app-state";

export function EnvironmentSettings({ value, onChange }: { value: ExecutionEnvironment | undefined; onChange: (value: ExecutionEnvironment) => void }) {
  useLocale();
  const [resources, setResources] = useState<ContainerResourceItem[]>([]);
  const [engines, setEngines] = useState<ContainerEngineDto[]>([]);
  useEffect(() => { if (value?.type === "container") void endpoints.containerEngines().then(setEngines).catch(toastError); }, [value?.type]);
  const current = value?.type === "container" ? value : null;
  useEffect(() => {
    if (current?.image === "llm-chat-runtime:alpine") void endpoints.containerResources().then(value => setResources(value.resources)).catch(toastError);
  }, [current?.image]);
  const selected = engines.find(engine => engine.engine === current?.engine);
  return <section>
    <h3>{t("environment.title")}</h3>
    <Field label={t("environment.title")}>
      <select className="select" aria-label={t("environment.title")} value={current ? "container" : "host"}
        onChange={event => onChange(event.target.value === "host" ? { type: "host" } : { type: "container", engine: "docker", image: "llm-chat-runtime:alpine", preloadResourceIds: ["builtin:tools"], idleTimeoutMinutes: 15 })}>
        <option value="host">{t("environment.host")}</option><option value="container">{t("environment.container")}</option>
      </select>
    </Field>
    {current ? <>
      <p className="hint">{t("environment.description")}</p>
      <div className="form-grid">
        <Field label={t("environment.engine")}>
          <select className="select" aria-label={t("environment.engine")} value={current.engine} onChange={event => onChange({ ...current, engine: event.target.value as "docker" | "podman" })}>
            {["docker", "podman"].map(engine => <option key={engine} value={engine}>{engine === "docker" ? "Docker" : "Podman"}{engines.find(item => item.engine === engine)?.available === false ? ` · ${t("environment.unavailable")}` : ""}</option>)}
          </select>
          {selected?.error ? <p className="hint" role="status">{selected.error}</p> : null}
        </Field>
        <Field label={t("environment.image")}>
          <select className="select" aria-label={t("environment.image")} value={current.image === "llm-chat-runtime:alpine" ? "alpine" : "custom"}
            onChange={event => onChange({ ...current, image: event.target.value === "alpine" ? "llm-chat-runtime:alpine" : "llm-chat-runtime:local", preloadResourceIds: event.target.value === "alpine" ? ["builtin:tools"] : [] })}>
            <option value="alpine">Alpine</option><option value="custom">{t("container_resources.custom_image")}</option>
          </select>
          {current.image !== "llm-chat-runtime:alpine" ? <input className="input" aria-label={t("container_resources.custom_image")} value={current.image} onChange={event => onChange({ ...current, image: event.target.value })} /> : null}
        </Field>
        <Field label={t("environment.idle")}>
          <input className="input" type="number" min={1} max={10080} aria-label={t("environment.idle")} value={current.idleTimeoutMinutes}
            onChange={event => onChange({ ...current, idleTimeoutMinutes: Number(event.target.value) || 15 })} />
        </Field>
      </div>
      {current.image === "llm-chat-runtime:alpine" ? <fieldset className="choice-fieldset">
        <legend>{t("container_resources.preload")}</legend>
        <p className="hint">{t("container_resources.preload_hint")}</p>
        {[...resources.filter(item => !["builtin:alpine", "builtin:runtime"].includes(item.id)).map(item => ({ id: item.id, name: resourceName(item), available: item.available })),
          ...(current.preloadResourceIds ?? ["builtin:tools"]).filter(id => !resources.some(item => item.id === id)).map(id => ({ id, name: id, available: true }))].map(item => {
          const selectedIds = current.preloadResourceIds ?? ["builtin:tools"];
          return <label className="checkbox-row" key={item.id}>
            <input type="checkbox" checked={selectedIds.includes(item.id)} disabled={!item.available && !selectedIds.includes(item.id)}
              onChange={event => onChange({ ...current, preloadResourceIds: event.target.checked ? [...selectedIds, item.id] : selectedIds.filter(id => id !== item.id) })} />
            {item.name}
          </label>;
        })}
        <a className="text-link" href={routes.settings("container-resources")} onClick={linkClick(routes.settings("container-resources"))}>{t("container_resources.title")}</a>
      </fieldset> : null}
    </> : null}
  </section>;
}

export function ConversationEnvironments({ conversationId }: { conversationId: string }) {
  useLocale();
  const [items, setItems] = useState<ConversationEnvironmentDto[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = () => endpoints.conversationEnvironments(conversationId).then(setItems).catch(toastError);
  useEffect(() => { void refresh(); }, [conversationId]);
  const stop = async (id: string, reset: boolean) => {
    setBusy(true);
    try { setItems(await endpoints.stopEnvironment(conversationId, id, reset)); } catch (error) { toastError(error); }
    finally { setBusy(false); }
  };
  return <section>
    <h4>{t("environment.environments")}</h4>
    {items.length ? <>
      <p className="hint">{t("environment.reset_hint")}</p>
      {items.map(item => <div className="card" key={item.id}>
        <p>{item.engine} · {item.image}</p>
        <p className="muted">{t(`environment.${item.status}`)}</p>
        {item.error ? <p role="status">{item.error}</p> : null}
        <div className="row">
          <Button disabled={busy || item.status === "stopped"} onClick={() => void stop(item.id, false)}>{t("environment.stop")}</Button>
          <Button disabled={busy} onClick={() => void stop(item.id, true)}>{t("environment.reset")}</Button>
        </div>
      </div>)}
    </> : <p className="muted">{t("environment.empty")}</p>}
    <Button disabled={busy} onClick={() => void refresh()}>{t("environment.refresh")}</Button>
  </section>;
}
