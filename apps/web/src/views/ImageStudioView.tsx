import type {
  ImageAssetDto,
  ImageGenerationInput,
  ImageGenerationJobDto,
  ImageModelOptionDto,
  ImageSessionDraft,
  ImageSessionDto,
  ImageSessionNodeDto
} from "@llm-chat/contracts";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImagePlus,
  Images,
  LoaderCircle,
  Menu,
  RefreshCw,
  Send,
  Settings2,
  SquarePen,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NativeFileButton } from "../components/NativeFileButton";
import { endpoints } from "../lib/api";
import { toast, toastError } from "../lib/app-state";
import { t, useLocale } from "../lib/i18n";
import { refreshImageSessions } from "../lib/image-studio-state";
import { navigate, replaceRoute, routes } from "../lib/router";
import { assetUrl } from "../lib/server-channel";
import { ConfirmModal, ErrorState, LoadingState } from "../lib/ui";

const NEW_DRAFT_KEY = "llm-chat.image-studio-draft.v1";
const EMPTY_DRAFT: ImageSessionDraft = {
  modelId: null,
  prompt: "",
  referenceAssetIds: [],
  negativePrompt: "",
  count: 1,
  aspectRatio: null,
  size: null,
  quality: null,
  outputFormat: null,
  seed: null
};
const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const IMAGE_MIME_TYPES = new Set<ImageAssetDto["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function isImageAsset(asset: Awaited<ReturnType<typeof endpoints.uploadFile>>): asset is ImageAssetDto {
  return asset.kind === "image" && IMAGE_MIME_TYPES.has(asset.mimeType as ImageAssetDto["mimeType"]);
}

function readNewDraft(): ImageSessionDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(NEW_DRAFT_KEY) ?? "null") as Partial<ImageSessionDraft> | null;
    return value ? { ...EMPTY_DRAFT, ...value, referenceAssetIds: [] } : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

export function ImageStudioView({
  sessionId,
  mobile,
  sidebarCollapsed,
  onToggleSidebar
}: {
  sessionId: string | null;
  mobile: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  useLocale();
  const [models, setModels] = useState<ImageModelOptionDto[]>([]);
  const [session, setSession] = useState<ImageSessionDto | null>(null);
  const [draft, setDraft] = useState<ImageSessionDraft>(() => readNewDraft());
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ node: ImageSessionNodeDto; job: ImageGenerationJobDto } | null>(null);
  const hydrated = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const composer = useRef<HTMLDivElement>(null);

  const loadSession = useCallback(async (hydrate = false) => {
    const ticket = ++loadSequence.current;
    if (!sessionId) { setSession(null); setLoading(false); setError(null); return; }
    try {
      const value = await endpoints.imageSession(sessionId);
      if (ticket !== loadSequence.current) return;
      setSession(value);
      if (hydrate || hydrated.current !== sessionId) {
        hydrated.current = sessionId;
        setDraft(value.draft);
      }
      setError(null);
    } catch (cause) {
      if (ticket !== loadSequence.current) return;
      setError(cause instanceof Error ? cause.message : t("ImageStudio.load_failed"));
    } finally {
      if (ticket === loadSequence.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    void endpoints.imageModels().then((value) => { if (active) setModels(value); }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : t("ImageStudio.models_failed"));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setLoading(Boolean(sessionId));
    if (!sessionId) {
      hydrated.current = null;
      setDraft(readNewDraft());
    }
    void loadSession(true);
  }, [sessionId, loadSession]);

  useEffect(() => {
    const changed = (raw: Event) => {
      const event = raw as CustomEvent<{ imageSessionId: string }>;
      if (event.detail.imageSessionId === sessionId) void loadSession(false);
    };
    window.addEventListener("llm-chat:image-session-generation", changed);
    return () => window.removeEventListener("llm-chat:image-session-generation", changed);
  }, [sessionId, loadSession]);

  useEffect(() => {
    if (draft.modelId || !models[0]) return;
    setDraft((value) => ({ ...value, modelId: models[0]!.id }));
  }, [models, draft.modelId]);

  useEffect(() => {
    if (sessionId) return;
    try { sessionStorage.setItem(NEW_DRAFT_KEY, JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ }
  }, [sessionId, draft]);

  useEffect(() => {
    if (!sessionId || !session || hydrated.current !== sessionId || JSON.stringify(draft) === JSON.stringify(session.draft)) return;
    const timer = setTimeout(() => {
      void endpoints.updateImageSession(sessionId, { draft }).then((value) => setSession((current) => current ? { ...current, draft: value.draft } : current)).catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [sessionId, session, draft]);

  const model = models.find((item) => item.id === draft.modelId) ?? null;
  const maxReferences = model?.capabilities.operations.includes("edit")
    ? model.capabilities.maxReferenceImages
    : 0;
  const references = useMemo(() => draft.referenceAssetIds.flatMap((id) => {
    const asset = session?.assets.find((item) => item.id === id);
    return asset ? [asset] : [];
  }), [draft.referenceAssetIds, session?.assets]);

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await endpoints.createImageSession({
      title: draft.prompt.trim().slice(0, 60) || t("ImageStudio.untitled"),
      draft
    });
    setSession(created);
    hydrated.current = created.id;
    sessionStorage.removeItem(NEW_DRAFT_KEY);
    await refreshImageSessions();
    return created.id;
  };

  const uploadReferences = async (files: File[]) => {
    const remaining = Math.max(0, maxReferences - draft.referenceAssetIds.length);
    if (!remaining) {
      toast("info", model ? t("ImageStudio.reference_limit", { value1: String(maxReferences) }) : t("ImageStudio.model_required"));
      return;
    }
    setUploading(true);
    try {
      const id = await ensureSession();
      const assets: ImageAssetDto[] = [];
      for (const file of files.slice(0, remaining)) {
        const asset = await endpoints.uploadFile(file);
        if (!isImageAsset(asset)) throw new Error(t("ImageStudio.reference_must_be_image"));
        assets.push(asset);
      }
      await endpoints.attachImageSessionAssets(id, assets.map((asset) => asset.id));
      const referenceAssetIds = [...new Set([...draft.referenceAssetIds, ...assets.map((asset) => asset.id)])]
        .slice(0, maxReferences);
      const nextDraft = { ...draft, referenceAssetIds };
      const saved = await endpoints.updateImageSession(id, { draft: nextDraft });
      setSession(saved);
      setDraft(nextDraft);
      if (files.length > remaining) toast("info", t("ImageStudio.reference_limit", { value1: String(maxReferences) }));
      await refreshImageSessions();
      if (!sessionId) replaceRoute(routes.images(id));
    } catch (cause) {
      toastError(cause);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!draft.prompt.trim()) { toast("error", t("ImageStudio.prompt_required")); return; }
    if (!model) { toast("error", t("ImageStudio.model_required")); return; }
    if (draft.referenceAssetIds.length && !model.capabilities.operations.includes("edit")) {
      toast("error", t("ImageStudio.model_no_reference")); return;
    }
    setBusy(true);
    try {
      const id = await ensureSession();
      const input: ImageGenerationInput = {
        modelId: model.id,
        prompt: draft.prompt.trim(),
        operation: draft.referenceAssetIds.length ? "edit" : "generate",
        referenceAssetIds: draft.referenceAssetIds.slice(0, model.capabilities.maxReferenceImages),
        count: model.capabilities.count ? draft.count : 1,
        ...(model.capabilities.negativePrompt && draft.negativePrompt.trim() ? { negativePrompt: draft.negativePrompt.trim() } : {}),
        ...(model.capabilities.aspectRatio && draft.aspectRatio ? { aspectRatio: draft.aspectRatio } : {}),
        ...(model.capabilities.size && draft.size ? { size: draft.size } : {}),
        ...(model.capabilities.quality && draft.quality ? { quality: draft.quality } : {}),
        ...(model.capabilities.outputFormat && draft.outputFormat ? { outputFormat: draft.outputFormat } : {}),
        ...(model.capabilities.seed && draft.seed !== null ? { seed: draft.seed } : {})
      };
      await endpoints.updateImageSession(id, { draft });
      await endpoints.createImageSessionNode(id, input);
      if (!sessionId) replaceRoute(routes.images(id));
      else await loadSession(false);
      await refreshImageSessions();
    } catch (cause) {
      toastError(cause);
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await loadSession(false); await refreshImageSessions(); }
    catch (cause) { toastError(cause); }
    finally { setBusy(false); }
  };

  const editJob = (job: ImageGenerationJobDto) => {
    setDraft({
      modelId: job.input.modelId,
      prompt: job.input.prompt,
      referenceAssetIds: job.input.referenceAssetIds,
      negativePrompt: job.input.negativePrompt ?? "",
      count: job.input.count,
      aspectRatio: job.input.aspectRatio ?? null,
      size: job.input.size ?? null,
      quality: job.input.quality ?? null,
      outputFormat: job.input.outputFormat ?? null,
      seed: job.input.seed ?? null
    });
    composer.current?.scrollIntoView({
      block: "end",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  };

  const copyPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast("success", t("atoms.copied"));
    } catch (cause) {
      toastError(cause);
    }
  };

  if (loading) return <LoadingState label={t("ImageStudio.loading")} />;
  if (error && !session) return <ErrorState message={error} onRetry={() => { setLoading(true); void loadSession(true); }} />;

  return <section className="image-studio">
    {!mobile ? <header className="image-studio-header">
      {sidebarCollapsed ? <button className="icon-button" onClick={onToggleSidebar} aria-label={t("WorkspaceSidebar.expand_conversation_sidebar")}><Menu size={19} /></button> : null}
      <div><h1>{session?.title ?? t("ImageStudio.title")}</h1><p>{t("ImageStudio.subtitle")}</p></div>
      <button className="button secondary" onClick={() => navigate(routes.images())}><SquarePen size={16} />{t("ImageStudio.new_session")}</button>
    </header> : null}

    <div className="image-studio-scroll" role="region" aria-label={t("ImageStudio.timeline")}>
      <div className="image-studio-timeline">
        {session?.nodes.length ? session.nodes.map((node) => <TimelineNode
          key={node.id}
          node={node}
          disabled={busy}
          onSelect={(jobId) => runAction(() => endpoints.selectImageSessionVersion(session.id, node.id, jobId))}
          onCancel={(jobId) => runAction(() => endpoints.cancelImageSessionGeneration(jobId))}
          onRetry={(jobId) => runAction(() => endpoints.retryImageSessionGeneration(jobId))}
          onRerun={(jobId) => runAction(() => endpoints.rerunImageSessionNode(session.id, node.id, jobId))}
          onEdit={editJob}
          onCopy={copyPrompt}
          onReference={(asset) => setDraft((value) => ({ ...value,
            referenceAssetIds: [...new Set([...value.referenceAssetIds, asset.id])].slice(0, model?.capabilities.maxReferenceImages ?? 4)
          }))}
          onDelete={(job) => setDeleteTarget({ node, job })}
        />) : <div className="image-studio-empty">
          <Images size={34} aria-hidden="true" />
          <h2>{t("ImageStudio.empty_title")}</h2>
          <p>{models.length ? t("ImageStudio.empty_description") : t("ImageStudio.no_models")}</p>
          {!models.length ? <button className="button secondary" onClick={() => navigate(routes.settings("connections"))}>{t("ImageStudio.configure_models")}</button> : null}
        </div>}
      </div>
    </div>

    <div className="image-studio-composer-wrap" ref={composer}>
      <div className="image-studio-composer">
        {references.length ? <div className="image-reference-list" aria-label={t("ImageStudio.references")}>
          {references.map((asset) => <div className="image-reference" key={asset.id}>
            <img src={assetUrl(asset.url)} alt={asset.fileName} />
            <button onClick={() => setDraft((value) => ({ ...value, referenceAssetIds: value.referenceAssetIds.filter((id) => id !== asset.id) }))}
              aria-label={t("ImageStudio.remove_reference", { value1: asset.fileName })}><X size={14} /></button>
          </div>)}
        </div> : null}
        <label className="image-prompt-field">
          <span className="sr-only">{t("ImageStudio.prompt")}</span>
          <textarea value={draft.prompt} onChange={(event) => setDraft((value) => ({ ...value, prompt: event.target.value }))}
            placeholder={t("ImageStudio.prompt_placeholder")} rows={2} maxLength={10_000}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} />
        </label>
        <div className="image-composer-tools">
          <NativeFileButton className="image-tool-button" label={t("ImageStudio.add_reference")}
            accept="image/jpeg,image/png,image/webp,image/gif" multiple={maxReferences > 1} busy={uploading}
            disabled={!models.length || maxReferences === 0 || draft.referenceAssetIds.length >= maxReferences}
            onFiles={uploadReferences}>
            {uploading ? <LoaderCircle className="spin" size={19} /> : <ImagePlus size={19} />}
          </NativeFileButton>
          <label className="image-model-select"><span className="sr-only">{t("ImageStudio.model")}</span>
            <select value={draft.modelId ?? ""} disabled={!models.length || busy} onChange={(event) => {
              const next = models.find((item) => item.id === event.target.value);
              setDraft((value) => ({ ...value, modelId: event.target.value || null,
                referenceAssetIds: value.referenceAssetIds.slice(0, next?.capabilities.maxReferenceImages ?? 0) }));
            }}>
              {!models.length ? <option value="">{t("ImageStudio.no_model_option")}</option> : null}
              {models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </label>
          <details className="image-settings">
            <summary aria-label={t("ImageStudio.parameters")} title={t("ImageStudio.parameters")}><Settings2 size={19} /></summary>
            <div className="image-settings-panel">
              {model?.capabilities.count ? <label><span>{t("ImageStudio.count")}</span><select value={draft.count} onChange={(event) => setDraft((value) => ({ ...value, count: Number(event.target.value) }))}>{[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label> : null}
              {model?.capabilities.aspectRatio ? <label><span>{t("ImageStudio.aspect_ratio")}</span><select value={draft.aspectRatio ?? ""} onChange={(event) => setDraft((value) => ({ ...value, aspectRatio: event.target.value || null }))}><option value="">{t("ImageStudio.auto")}</option>{RATIOS.map((value) => <option key={value}>{value}</option>)}</select></label> : null}
              {model?.capabilities.size ? <label><span>{t("ImageStudio.size")}</span><select value={draft.size ?? ""} onChange={(event) => setDraft((value) => ({ ...value, size: event.target.value || null }))}><option value="">{t("ImageStudio.auto")}</option>{(model.imageProtocol === "google-imagen" || model.imageProtocol === "google-interactions" ? ["1K", "2K"] : ["1024x1024", "1536x1024", "1024x1536"]).map((value) => <option key={value}>{value}</option>)}</select></label> : null}
              {model?.capabilities.quality ? <label><span>{t("ImageStudio.quality")}</span><select value={draft.quality ?? ""} onChange={(event) => setDraft((value) => ({ ...value, quality: event.target.value as ImageSessionDraft["quality"] || null }))}><option value="">{t("ImageStudio.auto")}</option>{["low", "medium", "high"].map((value) => <option key={value}>{value}</option>)}</select></label> : null}
              {model?.capabilities.outputFormat ? <label><span>{t("ImageStudio.format")}</span><select value={draft.outputFormat ?? ""} onChange={(event) => setDraft((value) => ({ ...value, outputFormat: event.target.value as ImageSessionDraft["outputFormat"] || null }))}><option value="">{t("ImageStudio.auto")}</option>{["png", "jpeg", "webp"].map((value) => <option key={value}>{value}</option>)}</select></label> : null}
              {model?.capabilities.negativePrompt ? <label className="wide"><span>{t("ImageStudio.negative_prompt")}</span><textarea rows={2} value={draft.negativePrompt} onChange={(event) => setDraft((value) => ({ ...value, negativePrompt: event.target.value }))} /></label> : null}
              {model?.capabilities.seed ? <label><span>{t("ImageStudio.seed")}</span><input type="number" min={0} max={4_294_967_295} value={draft.seed ?? ""} placeholder={t("ImageStudio.random")} onChange={(event) => setDraft((value) => ({ ...value, seed: event.target.value ? Number(event.target.value) : null }))} /></label> : null}
            </div>
          </details>
          <button className="image-generate-button" disabled={busy || uploading || !models.length} onClick={() => void submit()} aria-label={t("ImageStudio.generate")} title={t("ImageStudio.generate")}>
            {busy ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
          </button>
        </div>
      </div>
    </div>

    {deleteTarget && session ? <ConfirmModal
      title={t("ImageStudio.delete_version")}
      message={deleteTarget.node.versions.length === 1 ? t("ImageStudio.delete_node_message") : t("ImageStudio.delete_version_message")}
      confirmLabel={t("ImageStudio.delete")}
      danger busy={busy}
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => void runAction(async () => {
        await endpoints.deleteImageSessionVersion(session.id, deleteTarget.node.id, deleteTarget.job.id);
        setDeleteTarget(null);
      })}
    /> : null}
  </section>;
}

function TimelineNode({ node, disabled, onSelect, onCancel, onRetry, onRerun, onEdit, onCopy, onReference, onDelete }: {
  node: ImageSessionNodeDto;
  disabled: boolean;
  onSelect: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onRerun: (jobId: string) => void;
  onEdit: (job: ImageGenerationJobDto) => void;
  onCopy: (prompt: string) => void;
  onReference: (asset: ImageAssetDto) => void;
  onDelete: (job: ImageGenerationJobDto) => void;
}) {
  const index = Math.max(0, node.versions.findIndex((job) => job.id === node.selectedJobId));
  const job = node.versions[index] ?? node.versions.at(-1)!;
  const active = ["queued", "running", "waiting-provider"].includes(job.status);
  const label = {
    queued: t("ImageStudio.status_queued"), running: t("ImageStudio.status_running"),
    "waiting-provider": t("ImageStudio.status_waiting"), completed: t("ImageStudio.status_completed"),
    failed: t("ImageStudio.status_failed"), cancelled: t("ImageStudio.status_cancelled")
  }[job.status];

  return <article className="image-timeline-node" data-status={job.status}>
    <header>
      <div><span className="image-status"><i aria-hidden="true" />{label}</span><small>{job.connectionName} · {job.modelKey}</small></div>
      {node.versions.length > 1 ? <div className="image-version-switcher" role="group" aria-label={t("ImageStudio.versions")}>
        <button disabled={disabled || index === 0} onClick={() => onSelect(node.versions[index - 1]!.id)} aria-label={t("ImageStudio.previous_version")}><ChevronLeft size={15} /></button>
        <span>{index + 1}/{node.versions.length}</span>
        <button disabled={disabled || index === node.versions.length - 1} onClick={() => onSelect(node.versions[index + 1]!.id)} aria-label={t("ImageStudio.next_version")}><ChevronRight size={15} /></button>
      </div> : null}
    </header>
    <p className="image-node-prompt">{job.prompt}</p>
    {job.outputAssets.length ? <div className="image-result-grid" data-count={job.outputAssets.length}>
      {job.outputAssets.map((asset) => <figure key={asset.id}>
        <a href={assetUrl(asset.url)} target="_blank" rel="noreferrer"><img src={assetUrl(asset.url)} alt={job.revisedPrompt || job.prompt} /></a>
        <figcaption>
          <button onClick={() => onReference(asset)} title={t("ImageStudio.use_as_reference")} aria-label={t("ImageStudio.use_as_reference")}><ImagePlus size={16} /></button>
          <a href={assetUrl(asset.url)} download={asset.fileName} title={t("ImageStudio.download")} aria-label={t("ImageStudio.download")}><Download size={16} /></a>
        </figcaption>
      </figure>)}
    </div> : active ? <div className="image-job-progress" role="status"><LoaderCircle className="spin" size={23} /><span>{label}</span>{job.progress !== null ? <progress max={1} value={job.progress} /> : null}</div> : null}
    {job.error ? <p className="image-job-error" role="alert">{job.error.message} {t("ImageStudio.try_again")}</p> : null}
    <footer>
      <button disabled={disabled} onClick={() => onCopy(job.prompt)}><Copy size={15} />{t("ImageStudio.copy_prompt")}</button>
      <button disabled={disabled} onClick={() => onEdit(job)}><SquarePen size={15} />{t("ImageStudio.edit")}</button>
      {active ? <button disabled={disabled} onClick={() => onCancel(job.id)}><X size={15} />{t("ImageStudio.cancel")}</button> : null}
      {["failed", "cancelled"].includes(job.status) ? <button disabled={disabled} onClick={() => onRetry(job.id)}><RefreshCw size={15} />{t("ImageStudio.retry")}</button> : null}
      {job.status === "completed" ? <button disabled={disabled} onClick={() => onRerun(job.id)}><RefreshCw size={15} />{t("ImageStudio.rerun")}</button> : null}
      <button className="danger-quiet" disabled={disabled || active} onClick={() => onDelete(job)}><Trash2 size={15} />{t("ImageStudio.delete")}</button>
    </footer>
  </article>;
}
