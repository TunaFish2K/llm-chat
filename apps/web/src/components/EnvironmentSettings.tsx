import { Button } from "./ui";
import { useEffect, useState } from "react";
import type { ContainerEngineDto, ConversationEnvironmentDto, ExecutionEnvironment } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { t, useLocale } from "../lib/i18n";
import { Field } from "../lib/ui";
import { toastError } from "../lib/app-state";

export function EnvironmentSettings({ value, onChange }: { value: ExecutionEnvironment | undefined; onChange: (value: ExecutionEnvironment) => void }) {
  useLocale();
  const [engines, setEngines] = useState<ContainerEngineDto[]>([]);
  useEffect(() => { if (value?.type === "container") void endpoints.containerEngines().then(setEngines).catch(toastError); }, [value?.type]);
  const current = value?.type === "container" ? value : null;
  const selected = engines.find(engine => engine.engine === current?.engine);
  return <section>
    <h3>{t("environment.title")}</h3>
    <Field label={t("environment.title")}>
      <select className="select" aria-label={t("environment.title")} value={current ? "container" : "host"}
        onChange={event => onChange(event.target.value === "host" ? { type: "host" } : { type: "container", engine: "docker", image: "llm-chat-runtime:local", idleTimeoutMinutes: 15 })}>
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
          <input className="input" aria-label={t("environment.image")} value={current.image} onChange={event => onChange({ ...current, image: event.target.value })} />
        </Field>
        <Field label={t("environment.idle")}>
          <input className="input" type="number" min={1} max={10080} aria-label={t("environment.idle")} value={current.idleTimeoutMinutes}
            onChange={event => onChange({ ...current, idleTimeoutMinutes: Number(event.target.value) || 15 })} />
        </Field>
      </div>
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
