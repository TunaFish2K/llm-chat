import { useCallback, useEffect, useState } from "react";
import type { ContainerResourceCatalog, ContainerResourceItem, ContainerResourceJob, ContainerResourceNode } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { t, useLocale } from "../lib/i18n";
import { toastError } from "../lib/app-state";
import { Field, LoadingState } from "../lib/ui";
import { Button } from "./ui";

export const resourceName = (resource: Pick<ContainerResourceItem, "id" | "definition">) => resource.id.startsWith("builtin:")
  ? t(({ "builtin:alpine": "container_resources.alpine", "builtin:runtime": "container_resources.runtime", "builtin:tools": "container_resources.tools" } as const)[resource.id as "builtin:alpine" | "builtin:runtime" | "builtin:tools"]) : resource.definition.name;
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;

export function ContainerResourceSettings() {
  useLocale();
  const [catalog, setCatalog] = useState<ContainerResourceCatalog | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setCatalog(await endpoints.containerResources()); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => {
    void refresh();
    const resource = (raw: Event) => {
      const job = (raw as CustomEvent<ContainerResourceJob>).detail;
      setCatalog(current => current ? { ...current, jobs: [job, ...current.jobs.filter(item => item.id !== job.id)].slice(0, 100) } : current);
      if (job.state !== "running") void refresh();
    };
    const changed = () => { void refresh(); };
    window.addEventListener("llm-chat:container-resource", resource);
    window.addEventListener("llm-chat:resource-changed", changed);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    return () => {
      window.removeEventListener("llm-chat:container-resource", resource);
      window.removeEventListener("llm-chat:resource-changed", changed);
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (run: () => Promise<unknown>) => { try { await run(); await refresh(); } catch (error) { toastError(error); } };
  if (!catalog) return error ? <p role="alert">{error}<Button onClick={() => void refresh()}>{t("environment.refresh")}</Button></p> : <LoadingState />;
  return <section className="container-resources settings-panels">
    <div>
      <h3>{t("container_resources.title")}</h3>
      <p className="hint">{t("container_resources.description")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <Field label={t("container_resources.node")}>
        <select className="select" aria-label={t("container_resources.node")} value={catalog.node}
          onChange={event => void action(() => endpoints.setContainerResourceNode(event.target.value as ContainerResourceNode))}>
          {(["official", "tuna", "ustc"] as const).map(node => <option key={node} value={node}>{t(`container_resources.${node}`)}</option>)}
        </select>
      </Field>
      <p className="muted">{catalog.platform} · {t("container_resources.cache")}: {bytes(catalog.cacheBytes)}</p>
      <div className="row">
        <Button onClick={() => void action(() => endpoints.downloadContainerResources(["builtin:tools"]))}>{t("container_resources.download_default")}</Button>
        <Button disabled={catalog.jobs.some(job => job.state === "running")} onClick={() => void action(() => endpoints.clearContainerResourceCache())}>{t("container_resources.clear_cache")}</Button>
      </div>
    </div>
    {catalog.jobs.length > 0 ? <div className="settings-panels">{catalog.jobs.slice(0, 10).map(job => <div className="card" key={job.id}>
      <p>{t(`container_resources.${job.kind}`)} · {t(`container_resources.${job.state}`)}</p>
      <p className="hint">{job.message}</p>
      {job.state === "running" ? <><progress max={job.totalBytes || 1} value={job.completedBytes} aria-label={t("container_resources.progress")} />
        <Button onClick={() => void action(() => endpoints.cancelContainerResourceJob(job.id))}>{t("container_resources.cancel")}</Button></> : null}
      {job.error ? <p role="status">{job.error}</p> : null}
    </div>)}</div> : null}
    <div className="settings-panels">{catalog.resources.map(resource => <div className="card" key={resource.id}>
      <h4>{resourceName(resource)}</h4>
      <p className="muted">{resource.definition.version} · {bytes(resource.files.reduce((sum, file) => sum + file.size, 0))}</p>
      {resource.definition.description && resource.source !== "builtin" ? <p>{resource.definition.description}</p> : null}
      <div className="row">
        <Button disabled={!resource.available} onClick={() => void action(() => endpoints.downloadContainerResources([resource.id]))}>{t("container_resources.download")}</Button>
      </div>
      {!resource.available ? <p>{resource.availabilityError ?? t("environment.unavailable")}</p> : <details>
        <summary>{t("container_resources.files")} · {resource.files.filter(file => file.cached).length}/{resource.files.length}</summary>
        <ul className="container-resource-files">{resource.files.map(file => <li key={file.sha256}>
          <a className="text-link" href={file.downloadUrl} target="_blank" rel="noreferrer">{file.name}</a> · {bytes(file.size)} {file.cached ? `· ${t("container_resources.cached")}` : ""}
        </li>)}</ul>
      </details>}
    </div>)}</div>
  </section>;
}
