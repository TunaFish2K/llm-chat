import type {
  ImageAssetDto,
  ImageGenerationInput,
  ImageGenerationJobDto,
  ImageModelOptionDto,
  ImageSessionDraft,
  ImageSessionDto,
  ImageSessionNodeDto
} from "@llm-chat/contracts";
import { ArrowDown, Copy, Download, ImagePlus, LoaderCircle, Pencil, RotateCcw, Send, Settings2, Square, SquarePen, Trash2, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AttachmentMenu } from "../components/chat/AttachmentEditor";
import { ImageGallery, MessageAction, copyText } from "../components/chat/atoms";
import { MessageFooter, VersionSwitcher } from "../components/chat/MessageStream";
import { useStickToBottom } from "../components/chat/useStickToBottom";
import { ModelPicker } from "../components/ModelPicker";
import { Button, Field, Modal, Segmented } from "../components/ui";
import { endpoints } from "../lib/api";
import { appStore, toast, toastError } from "../lib/app-state";
import { formatTime } from "../lib/format";
import { t, useLocale } from "../lib/i18n";
import { refreshImageSessions } from "../lib/image-studio-state";
import { PopoverLayer, Presence } from "../lib/motion";
import { navigate, replaceRoute, routes } from "../lib/router";
import { assetUrl } from "../lib/server-channel";
import { useStore } from "../lib/store";
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
const COUNTS = ["1", "2", "3", "4"] as const;
const IMAGE_MIME_TYPES = new Set<ImageAssetDto["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);
const ACTIVE_STATUSES = new Set<ImageGenerationJobDto["status"]>(["queued", "running", "waiting-provider"]);

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

function selectedJob(node: ImageSessionNodeDto): ImageGenerationJobDto {
  return node.versions.find((job) => job.id === node.selectedJobId) ?? node.versions.at(-1)!;
}

/** Image creation laid out like a chat: each node is a prompt bubble followed by its result. */
export function ImageStudioView({ sessionId, mobile }: { sessionId: string | null; mobile: boolean }) {
  useLocale();
  const allModels = useStore(appStore, (state) => state.models);
  const connections = useStore(appStore, (state) => state.connections);
  const [models, setModels] = useState<ImageModelOptionDto[]>([]);
  const [session, setSession] = useState<ImageSessionDto | null>(null);
  const [draft, setDraft] = useState<ImageSessionDraft>(() => readNewDraft());
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ node: ImageSessionNodeDto; job: ImageGenerationJobDto } | null>(null);
  const hydrated = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [editing, setEditing] = useState<ImageGenerationJobDto | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [pending, setPending] = useState<{ prompt: string; references: ImageAssetDto[] } | null>(null);
  const scroller = useStickToBottom([session?.nodes], true);

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
    // A session this view just created already holds the live draft; refresh it in place without a loading flash.
    if (sessionId && hydrated.current === sessionId) { void loadSession(false); return; }
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
    if (draft.modelId && models.some((item) => item.id === draft.modelId)) return;
    if (!models[0]) return;
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
  const pickerModels = useMemo(() => allModels.filter((item) => models.some((option) => option.id === item.id)), [allModels, models]);
  const maxReferences = model?.capabilities.operations.includes("edit") ? model.capabilities.maxReferenceImages : 0;
  const references = useMemo(() => draft.referenceAssetIds.flatMap((id) => {
    const asset = session?.assets.find((item) => item.id === id);
    return asset ? [asset] : [];
  }), [draft.referenceAssetIds, session?.assets]);
  const activeJob = session?.nodes.map(selectedJob).find((job) => ACTIVE_STATUSES.has(job.status)) ?? null;
  const parameterCount = model ? [
    model.capabilities.count && draft.count > 1,
    model.capabilities.aspectRatio && draft.aspectRatio,
    model.capabilities.size && draft.size,
    model.capabilities.quality && draft.quality,
    model.capabilities.outputFormat && draft.outputFormat,
    model.capabilities.negativePrompt && draft.negativePrompt.trim(),
    model.capabilities.seed && draft.seed !== null
  ].filter(Boolean).length : 0;
  const hasParameters = Boolean(model && (model.capabilities.count || model.capabilities.aspectRatio || model.capabilities.size ||
    model.capabilities.quality || model.capabilities.outputFormat || model.capabilities.negativePrompt || model.capabilities.seed));
  const referenceBlocked = !model ? t("ImageStudio.model_required")
    : maxReferences === 0 ? t("ImageStudio.model_no_reference")
    : draft.referenceAssetIds.length >= maxReferences ? t("ImageStudio.reference_limit", { value1: String(maxReferences) })
    : null;

  const ensureSession = async (title = draft.prompt): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await endpoints.createImageSession({
      title: title.trim().slice(0, 60) || t("ImageStudio.untitled"),
      draft: draftRef.current
    });
    setSession(created);
    hydrated.current = created.id;
    sessionStorage.removeItem(NEW_DRAFT_KEY);
    await refreshImageSessions();
    return created.id;
  };

  /** Uploads images into a session so jobs there may reference them. */
  const attachImages = async (id: string, images: File[]): Promise<ImageAssetDto[]> => {
    const assets: ImageAssetDto[] = [];
    for (const file of images) {
      const asset = await endpoints.uploadFile(file);
      if (!isImageAsset(asset)) throw new Error(t("ImageStudio.reference_must_be_image"));
      assets.push(asset);
    }
    setSession(await endpoints.attachImageSessionAssets(id, assets.map((asset) => asset.id)));
    return assets;
  };

  const uploadReferences = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    if (referenceBlocked) { toast("info", referenceBlocked); return; }
    const remaining = Math.max(0, maxReferences - draft.referenceAssetIds.length);
    setUploading(true);
    try {
      const id = await ensureSession();
      const assets = await attachImages(id, images.slice(0, remaining));
      const referenceAssetIds = [...new Set([...draft.referenceAssetIds, ...assets.map((asset) => asset.id)])].slice(0, maxReferences);
      const nextDraft = { ...draft, referenceAssetIds };
      const saved = await endpoints.updateImageSession(id, { draft: nextDraft });
      setSession(saved);
      setDraft(nextDraft);
      if (images.length > remaining) toast("info", t("ImageStudio.reference_limit", { value1: String(maxReferences) }));
      await refreshImageSessions();
      if (!sessionId) replaceRoute(routes.images(id));
    } catch (cause) {
      toastError(cause);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (busy || uploading) return;
    if (!draft.prompt.trim()) { input.current?.focus(); return; }
    if (!model) { toast("error", t("ImageStudio.model_required")); return; }
    if (draft.referenceAssetIds.length && !model.capabilities.operations.includes("edit")) {
      toast("error", t("ImageStudio.model_no_reference")); return;
    }
    // The prompt leaves the composer the moment it is sent, like a chat message; parameters and references stay.
    const sent = draft.prompt;
    setPending({ prompt: sent.trim(), references });
    setDraft((value) => ({ ...value, prompt: "" }));
    draftRef.current = { ...draftRef.current, prompt: "" };
    setBusy(true);
    try {
      const id = await ensureSession(sent);
      const request: ImageGenerationInput = {
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
      await endpoints.createImageSessionNode(id, request);
      // Save whatever the composer holds now, so reopening the session never brings the sent prompt back.
      void endpoints.updateImageSession(id, { draft: draftRef.current }).catch(() => {});
      // Show the new node before the pending bubble goes away, also for a session created just now.
      loadSequence.current += 1;
      setSession(await endpoints.imageSession(id));
      scroller.toBottom("auto");
      scroller.scheduleFollow();
      if (!sessionId) replaceRoute(routes.images(id));
      await refreshImageSessions();
    } catch (cause) {
      // A failed send keeps the prompt, unless something new was typed meanwhile.
      setDraft((value) => value.prompt ? value : { ...value, prompt: sent });
      toastError(cause);
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<unknown>) => {
    try { await action(); await loadSession(false); await refreshImageSessions(); }
    catch (cause) { toastError(cause); }
  };

  const selectVersion = (node: ImageSessionNodeDto, index: number) => {
    const job = node.versions[index];
    if (!session || !job) return;
    const previous = node.selectedJobId;
    const choose = (selectedJobId: string) => setSession((current) => current ? {
      ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, selectedJobId } : item)
    } : current);
    choose(job.id);
    void endpoints.selectImageSessionVersion(session.id, node.id, job.id).catch((cause) => { choose(previous); toastError(cause); });
  };

  const submitEdit = async (prompt: string, referenceAssetIds: string[]) => {
    const nodeId = editing?.imageNodeId;
    if (!session || !editing || !nodeId) return;
    setEditBusy(true);
    try {
      await endpoints.rerunImageSessionNode(session.id, nodeId, editing.id, { prompt: prompt.trim(), referenceAssetIds });
      setEditing(null);
      await loadSession(false);
      await refreshImageSessions();
    } catch (cause) {
      toastError(cause);
    } finally {
      setEditBusy(false);
    }
  };

  const useAsReference = (assets: ImageAssetDto[]) => {
    if (referenceBlocked) { toast("info", referenceBlocked); return; }
    const referenceAssetIds = [...new Set([...draft.referenceAssetIds, ...assets.map((asset) => asset.id)])].slice(0, maxReferences);
    setDraft((value) => ({ ...value, referenceAssetIds }));
    toast("success", t("ImageStudio.reference_added"));
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!event.repeat) void submit();
  };

  const updateDraft = (patch: Partial<ImageSessionDraft>) => setDraft((value) => ({ ...value, ...patch }));

  if (loading) return <LoadingState label={t("ImageStudio.loading")} />;
  if (error && !session) return <ErrorState message={error} onRetry={() => { setLoading(true); void loadSession(true); }} />;

  return <div className="chat-workspace image-studio">
    {!mobile ? <header className="conversation-header">
      <div className="conversation-heading">
        <span className="conversation-title" title={session?.title}><strong>{session?.title || t("ImageStudio.title")}</strong></span>
      </div>
      <button type="button" className="icon-button shell-control" onClick={() => navigate(routes.images())}
        aria-label={t("ImageStudio.new_session")} title={t("ImageStudio.new_session")}><SquarePen size={18} /></button>
    </header> : null}

    <div className="chat-scroll-shell">
      <div className="chat-scroll" ref={scroller.ref} onScroll={scroller.onScroll} data-following-bottom={!scroller.detached || undefined}
        aria-live="polite" aria-label={t("ImageStudio.timeline")}>
        <div className="chat-thread" ref={scroller.contentRef}>
          {session?.nodes.map((node) => <ImageNode
            key={node.id}
            node={node}
            assets={session.assets}
            models={models}
            referenceBlocked={referenceBlocked}
            onSelect={(index) => selectVersion(node, index)}
            onCancel={(job) => void runAction(() => endpoints.cancelImageSessionGeneration(job.id))}
            onRetry={(job) => void runAction(() => endpoints.retryImageSessionGeneration(job.id))}
            onRerun={(job) => void runAction(() => endpoints.rerunImageSessionNode(session.id, node.id, job.id))}
            onEdit={setEditing}
            onReference={useAsReference}
            onDelete={(job) => setDeleteTarget({ node, job })}
          />)}
          {pending ? <article className="msg pending-message" data-role="user" aria-busy="true">
            {pending.references.length ? <ImageGallery assets={pending.references} /> : null}
            <div className="msg-bubble">{pending.prompt}</div>
            <MessageFooter busy metadata={<LoaderCircle className="spin message-request-state" size={13} role="status" aria-label={t("ImageStudio.status_queued")} />}>{null}</MessageFooter>
          </article> : null}
          {!session?.nodes.length && !pending ? <div className="welcome">
            <h1>{t("ImageStudio.empty_title")}</h1>
            <p>{models.length ? t("ImageStudio.empty_description") : t("ImageStudio.no_models")}</p>
            {!models.length ? <button type="button" className="btn" onClick={() => navigate(routes.settings("connections"))}>{t("ImageStudio.configure_models")}</button> : null}
          </div> : null}
        </div>
      </div>
      {scroller.detached ? <button type="button" className="icon-button jump-to-latest" onClick={() => scroller.toBottom("smooth")}
        aria-label={t("ChatView.go_to_latest_message")} title={t("ChatView.go_to_latest_message")}><ArrowDown size={17} /></button> : null}
    </div>

    <div className="composer">
      <div className="composer-inner">
        <div className="composer-surface"
          onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault(); }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length) { event.preventDefault(); void uploadReferences(files); }
          }}>
          <div className="composer-input-area">
            <textarea
              ref={input}
              className="composer-input"
              aria-label={t("ImageStudio.prompt")}
              placeholder={models.length ? t("ImageStudio.prompt_placeholder") : t("ImageStudio.no_model_option")}
              value={draft.prompt}
              rows={2}
              maxLength={10_000}
              onChange={(event) => updateDraft({ prompt: event.target.value })}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length) { event.preventDefault(); void uploadReferences(files); }
              }}
            />
            {activeJob ? <button type="button" className="composer-stop-button" onClick={() => void runAction(() => endpoints.cancelImageSessionGeneration(activeJob.id))}
              aria-label={t("ImageStudio.cancel")} title={t("ImageStudio.cancel")}><Square size={17} fill="currentColor" /></button> : null}
          </div>

          {references.length ? <div className="composer-attachments" aria-label={t("ImageStudio.references")}>
            {references.map((asset) => <div className="attachment-chip" key={asset.id}>
              <img src={assetUrl(asset.url)} alt={asset.fileName} />
              <span>{asset.fileName}</span>
              <button type="button" aria-label={t("ImageStudio.remove_reference", { value1: asset.fileName })}
                onClick={() => updateDraft({ referenceAssetIds: draft.referenceAssetIds.filter((id) => id !== asset.id) })}><X size={13} /></button>
            </div>)}
          </div> : null}

          <div className="composer-tools">
            <div className="composer-tool-scroll">
              <ModelPicker
                appearance="icon"
                value={draft.modelId}
                models={pickerModels}
                connections={connections}
                disabled={!models.length}
                imageOutputOnly
                label={t("ImageStudio.model")}
                onChange={(modelId) => {
                  const next = models.find((item) => item.id === modelId);
                  const limit = next?.capabilities.operations.includes("edit") ? next.capabilities.maxReferenceImages : 0;
                  updateDraft({ modelId, referenceAssetIds: draft.referenceAssetIds.slice(0, limit) });
                }}
              />
              {hasParameters ? <Popover.Root modal={false} open={settingsOpen} onOpenChange={setSettingsOpen}>
                <Popover.Trigger asChild><button type="button" className="chip composer-settings-trigger"
                  aria-label={t("ImageStudio.parameters")} title={t("ImageStudio.parameters")}>
                  <Settings2 size={26} />
                  {parameterCount ? <b>{parameterCount}</b> : null}
                </button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="composer-more-popover composer-settings-popover image-parameters" side="top" align="start" sideOffset={10}
                  inert={!settingsOpen ? true : undefined} aria-hidden={!settingsOpen || undefined}><PopoverLayer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
                  {model?.capabilities.count ? <div className="composer-menu-field"><span>{t("ImageStudio.count")}</span>
                    <Segmented label={t("ImageStudio.count")} options={COUNTS.map((value) => ({ value, label: value }))}
                      value={String(draft.count) as (typeof COUNTS)[number]} onChange={(value) => updateDraft({ count: Number(value) })} /></div> : null}
                  {model?.capabilities.aspectRatio ? <div className="composer-menu-field"><span>{t("ImageStudio.aspect_ratio")}</span>
                    <Segmented label={t("ImageStudio.aspect_ratio")} options={[{ value: "", label: t("ImageStudio.auto") }, ...RATIOS.map((value) => ({ value, label: value }))]}
                      value={draft.aspectRatio ?? ""} onChange={(value) => updateDraft({ aspectRatio: value || null })} /></div> : null}
                  {model?.capabilities.size ? <label className="composer-menu-field"><span>{t("ImageStudio.size")}</span>
                    <select className="select" value={draft.size ?? ""} onChange={(event) => updateDraft({ size: event.target.value || null })}>
                      <option value="">{t("ImageStudio.auto")}</option>
                      {(model.imageProtocol === "google-imagen" || model.imageProtocol === "google-interactions" ? ["1K", "2K"] : ["1024x1024", "1536x1024", "1024x1536"]).map((value) => <option key={value}>{value}</option>)}
                    </select></label> : null}
                  {model?.capabilities.quality ? <div className="composer-menu-field"><span>{t("ImageStudio.quality")}</span>
                    <Segmented label={t("ImageStudio.quality")} options={[{ value: "", label: t("ImageStudio.auto") }, ...(["low", "medium", "high"] as const).map((value) => ({ value, label: t(`ImageStudio.quality_${value}`) }))]}
                      value={draft.quality ?? ""} onChange={(value) => updateDraft({ quality: (value || null) as ImageSessionDraft["quality"] })} /></div> : null}
                  {model?.capabilities.outputFormat ? <div className="composer-menu-field"><span>{t("ImageStudio.format")}</span>
                    <Segmented label={t("ImageStudio.format")} options={[{ value: "", label: t("ImageStudio.auto") }, ...["png", "jpeg", "webp"].map((value) => ({ value, label: value.toUpperCase() }))]}
                      value={draft.outputFormat ?? ""} onChange={(value) => updateDraft({ outputFormat: (value || null) as ImageSessionDraft["outputFormat"] })} /></div> : null}
                  {model?.capabilities.negativePrompt ? <label className="composer-menu-field"><span>{t("ImageStudio.negative_prompt")}</span>
                    <textarea className="textarea" rows={2} value={draft.negativePrompt} onChange={(event) => updateDraft({ negativePrompt: event.target.value })} /></label> : null}
                  {model?.capabilities.seed ? <label className="composer-menu-field"><span>{t("ImageStudio.seed")}</span>
                    <input className="input" type="number" inputMode="numeric" min={0} max={4_294_967_295} value={draft.seed ?? ""} placeholder={t("ImageStudio.random")}
                      onChange={(event) => updateDraft({ seed: event.target.value ? Number(event.target.value) : null })} /></label> : null}
                </Popover.Content></Popover.Portal>
              </Popover.Root> : null}
            </div>
            <div className="composer-action-group">
              <AttachmentMenu files={false} multipleImages={maxReferences > 1} uploadFiles={uploadReferences}
                disabled={Boolean(referenceBlocked)} uploading={uploading} />
              <button type="button" className="send-button" onClick={() => void submit()}
                disabled={busy || uploading || !model || !draft.prompt.trim()}
                aria-label={t("ImageStudio.generate")} title={t("ImageStudio.generate")}>
                {busy ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Presence>{editing && session ? <EditImagePromptDialog
      job={editing}
      assets={session.assets}
      model={models.find((item) => item.id === editing.input.modelId) ?? null}
      busy={editBusy}
      onUpload={(files) => attachImages(session.id, files)}
      onClose={() => setEditing(null)}
      onSubmit={(prompt, referenceAssetIds) => void submitEdit(prompt, referenceAssetIds)}
    /> : null}</Presence>

    {deleteTarget && session ? <ConfirmModal
      title={t("ImageStudio.delete_version")}
      message={deleteTarget.node.versions.length === 1 ? t("ImageStudio.delete_node_message") : t("ImageStudio.delete_version_message")}
      confirmLabel={t("ImageStudio.delete")}
      danger
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => void runAction(async () => {
        await endpoints.deleteImageSessionVersion(session.id, deleteTarget.node.id, deleteTarget.job.id);
        setDeleteTarget(null);
      })}
    /> : null}
  </div>;
}

function ImageNode({ node, assets, models, referenceBlocked, onSelect, onCancel, onRetry, onRerun, onEdit, onReference, onDelete }: {
  node: ImageSessionNodeDto;
  assets: ImageAssetDto[];
  models: ImageModelOptionDto[];
  referenceBlocked: string | null;
  onSelect: (index: number) => void;
  onCancel: (job: ImageGenerationJobDto) => void;
  onRetry: (job: ImageGenerationJobDto) => void;
  onRerun: (job: ImageGenerationJobDto) => void;
  onEdit: (job: ImageGenerationJobDto) => void;
  onReference: (assets: ImageAssetDto[]) => void;
  onDelete: (job: ImageGenerationJobDto) => void;
}) {
  useLocale();
  const index = Math.max(0, node.versions.findIndex((job) => job.id === node.selectedJobId));
  const job = node.versions[index] ?? node.versions.at(-1)!;
  const active = ACTIVE_STATUSES.has(job.status);
  const references = job.input.referenceAssetIds.flatMap((id) => {
    const asset = assets.find((item) => item.id === id);
    return asset ? [asset] : [];
  });
  const modelName = models.find((item) => item.id === job.modelId)?.displayName ?? job.modelKey;
  const status = job.status === "queued" ? t("ImageStudio.status_queued")
    : job.status === "running" ? t("ImageStudio.status_running")
    : job.status === "waiting-provider" ? t("ImageStudio.status_waiting")
    : job.status === "cancelled" ? t("ImageStudio.status_cancelled")
    : null;
  const single = job.outputAssets.length === 1 ? job.outputAssets[0]! : null;

  return <>
    <article className="msg" data-role="user">
      {references.length ? <ImageGallery assets={references} /> : null}
      <div className="msg-bubble">{job.prompt}</div>
      <MessageFooter metadata={<time>{formatTime(job.createdAt)}</time>}>
        <MessageAction label={t("ImageStudio.copy_prompt")} onClick={() => void copyText(job.prompt)}><Copy size={14} /></MessageAction>
        <MessageAction label={t("ImageStudio.edit")} disabled={active} onClick={() => onEdit(job)}><Pencil size={14} /></MessageAction>
      </MessageFooter>
    </article>
    <article className="msg image-result" data-role="assistant" aria-busy={active || undefined}>
      {job.outputAssets.length ? <ImageGallery assets={job.outputAssets} />
        : job.status === "failed" ? <div className="refusal-block" role="alert">
          <strong>{t("ImageStudio.status_failed")}</strong>{job.error?.message}
        </div>
        : status ? <div className="image-job-status" role="status">{active ? <LoaderCircle size={14} className="spin" /> : null}<span>{status}</span></div>
        : null}
      <MessageFooter metadata={<><span className="reply-identity">{modelName} · {job.connectionName}</span><time className="reply-timestamp">{formatTime(job.completedAt ?? job.createdAt)}</time></>}>
        {active ? <MessageAction label={t("ImageStudio.cancel")} danger onClick={() => onCancel(job)}><Square size={14} fill="currentColor" /></MessageAction> : null}
        {job.outputAssets.length ? <span title={referenceBlocked ?? undefined}>
          <MessageAction label={t("ImageStudio.use_as_reference")} disabled={Boolean(referenceBlocked)} onClick={() => onReference(job.outputAssets)}><ImagePlus size={14} /></MessageAction>
        </span> : null}
        {single ? <a className="act" href={assetUrl(single.url)} download={single.fileName} aria-label={t("ImageStudio.download")} title={t("ImageStudio.download")}><Download size={14} /></a> : null}
        {job.status === "failed" || job.status === "cancelled"
          ? <MessageAction label={t("ImageStudio.retry")} onClick={() => onRetry(job)}><RotateCcw size={14} /></MessageAction>
          : job.status === "completed" ? <MessageAction label={t("ImageStudio.rerun")} onClick={() => onRerun(job)}><RotateCcw size={14} /></MessageAction> : null}
        {node.versions.length > 1 ? <VersionSwitcher label={t("ImageStudio.versions")} index={index} total={node.versions.length} onChange={onSelect} /> : null}
        <MessageAction label={t("ImageStudio.delete")} danger disabled={active} onClick={() => onDelete(job)}><Trash2 size={14} /></MessageAction>
      </MessageFooter>
    </article>
  </>;
}

/** Rewrites a sent prompt into a new version of the same node, mirroring chat's edit-and-branch dialog. */
function EditImagePromptDialog({ job, assets, model, busy, onUpload, onClose, onSubmit }: {
  job: ImageGenerationJobDto;
  assets: ImageAssetDto[];
  model: ImageModelOptionDto | null;
  busy: boolean;
  onUpload: (files: File[]) => Promise<ImageAssetDto[]>;
  onClose: () => void;
  onSubmit: (prompt: string, referenceAssetIds: string[]) => void;
}) {
  useLocale();
  const [prompt, setPrompt] = useState(job.input.prompt);
  const [referenceIds, setReferenceIds] = useState(job.input.referenceAssetIds);
  const [extra, setExtra] = useState<ImageAssetDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const maxReferences = model?.capabilities.operations.includes("edit") ? model.capabilities.maxReferenceImages : 0;
  const references = referenceIds.flatMap((id) => {
    const asset = assets.find((item) => item.id === id) ?? extra.find((item) => item.id === id);
    return asset ? [asset] : [];
  });
  const valid = Boolean(model && prompt.trim()) && prompt.length <= 10_000 && referenceIds.length <= maxReferences;

  const upload = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, maxReferences - referenceIds.length));
    if (!images.length) {
      if (files.length) toast("info", maxReferences ? t("ImageStudio.reference_limit", { value1: String(maxReferences) }) : t("ImageStudio.model_no_reference"));
      return;
    }
    setUploading(true);
    try {
      const added = await onUpload(images);
      setExtra((value) => [...value, ...added]);
      setReferenceIds((value) => [...new Set([...value, ...added.map((asset) => asset.id)])].slice(0, maxReferences));
    } catch (cause) {
      toastError(cause);
    } finally {
      setUploading(false);
    }
  };

  const submit = () => { if (valid && !busy && !uploading) onSubmit(prompt, referenceIds); };

  return <Modal
    title={t("ImageStudio.edit_prompt")}
    onClose={onClose}
    footer={<>
      <Button onClick={onClose} disabled={busy}>{t("WorkspaceSidebar.cancel")}</Button>
      <Button variant="primary" onClick={submit} disabled={busy || uploading || !valid}>
        {busy ? t("dialogs.creating") : t("ImageStudio.generate_version")}
      </Button>
    </>}
  >
    <Field label={t("ImageStudio.prompt")}>
      <textarea
        className="textarea"
        rows={7}
        aria-label={t("ImageStudio.prompt")}
        value={prompt}
        maxLength={10_000}
        autoFocus
        onChange={(event) => setPrompt(event.target.value)}
        disabled={busy}
        onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void upload([...event.clipboardData.files]); } }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void upload([...event.dataTransfer.files]); }}
      />
    </Field>
    {references.length ? <div className="composer-attachments" aria-label={t("ImageStudio.references")}>
      {references.map((asset) => <div className="attachment-chip" key={asset.id}>
        <img src={assetUrl(asset.url)} alt={asset.fileName} />
        <span>{asset.fileName}</span>
        <button type="button" disabled={busy} aria-label={t("ImageStudio.remove_reference", { value1: asset.fileName })}
          onClick={() => setReferenceIds((value) => value.filter((id) => id !== asset.id))}><X size={13} /></button>
      </div>)}
    </div> : null}
    {maxReferences ? <AttachmentMenu files={false} multipleImages={maxReferences > 1} uploadFiles={upload}
      disabled={busy || referenceIds.length >= maxReferences} uploading={uploading} /> : null}
    <p className="small muted">{t("ImageStudio.edit_prompt_hint")}</p>
  </Modal>;
}
