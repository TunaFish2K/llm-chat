import { t, useLocale } from "../../lib/i18n";
import { useCallback, useId, useState, type ChangeEvent, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { Popover } from "radix-ui";
import { FilePlus2, FileText, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import type { FileAssetDto } from "@llm-chat/contracts";
import { toast } from "../../lib/app-state";
import { formatBytes } from "../../lib/format";
import { uploadManager, uploadStore, type UploadIntent } from "../../lib/file-upload-manager";
import { useStore } from "../../lib/store";
import { UploadTasks } from "../FileUploads";
import { assetUrl } from "../../lib/server-channel";
import { PopoverLayer } from "../../lib/motion";

export function useAttachments(initial: FileAssetDto[] = [], scope = "new", conversationId?: string) {
  useLocale();
  useStore(uploadStore, (state) => state.revision);
  const current = uploadManager.ensure(scope, initial, conversationId);
  const setAttachments: Dispatch<SetStateAction<FileAssetDto[]>> = (action) => {
    const latest = uploadManager.ensure(scope, initial, conversationId).attachments;
    uploadManager.setAttachments(scope, typeof action === "function" ? action(latest) : action);
  };
  const uploadFiles = async (files: File[], intent?: UploadIntent) => {
    for (const error of uploadManager.enqueue(scope, files, intent)) toast("error", error);
  };
  return { attachments: current.attachments, setAttachments, uploading: current.tasks.length > 0, uploadFiles, uploadScope: scope,
    attachmentCount: current.attachments.length + current.tasks.length };
}

export const IMAGE_UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

/**
 * The paperclip drawer. Menu rows are labels for real file inputs that stay mounted outside
 * the popover, so a tap activates the native picker directly and the change event always
 * lands; the drawer closes only after the picker returns.
 */
export function AttachmentMenu({ uploadFiles, disabled, uploading = false, files = true, multipleImages = true }: {
  uploadFiles: (files: File[], intent?: UploadIntent) => Promise<void>; disabled?: boolean; uploading?: boolean;
  /** Offer the generic file row; image-only callers turn it off. */
  files?: boolean; multipleImages?: boolean;
}) {
  useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const fileId = `${id}-file`;
  const imageId = `${id}-image`;
  const picked = (intent: UploadIntent) => (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    setOpen(false);
    if (chosen.length) void uploadFiles(chosen, intent);
  };
  const closeOnCancel = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    const cancel = () => setOpen(false);
    input.addEventListener("cancel", cancel);
    return () => input.removeEventListener("cancel", cancel);
  }, []);
  const keyboard = (target: string) => (event: KeyboardEvent<HTMLLabelElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    (document.getElementById(target) as HTMLInputElement | null)?.click();
  };
  const row = (target: string, icon: ReactNode, label: string) => <label htmlFor={target} className="attachment-menu-item" role="button" tabIndex={disabled ? -1 : 0}
    aria-disabled={disabled || undefined} onKeyDown={keyboard(target)}>{icon}<span>{label}</span></label>;
  return <>
    {files ? <input id={fileId} ref={closeOnCancel} className="sr-only" tabIndex={-1} aria-hidden="true" aria-label={t("AttachmentEditor.upload_files")} type="file" multiple
      disabled={disabled} onChange={picked("file")} /> : null}
    <input id={imageId} ref={closeOnCancel} className="sr-only" tabIndex={-1} aria-hidden="true" aria-label={t("AttachmentEditor.upload_images")} type="file" multiple={multipleImages}
      accept={IMAGE_UPLOAD_ACCEPT} disabled={disabled} onChange={picked("image")} />
    <Popover.Root modal={false} open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="chip composer-attachment-button" disabled={disabled} aria-label={t("AttachmentEditor.add_attachment")} title={t("AttachmentEditor.add_attachment")}>
        {uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="composer-more-popover attachment-menu" side="top" align="start" sideOffset={8}
        inert={!open ? true : undefined} aria-hidden={!open || undefined}><PopoverLayer open={open} onClose={() => setOpen(false)} />
        {files ? row(fileId, <FilePlus2 size={17} />, t("AttachmentEditor.upload_files")) : null}
        {row(imageId, <ImagePlus size={17} />, t("AttachmentEditor.upload_images"))}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </>;
}

export function AttachmentList({ attachments, setAttachments, disabled = false, uploadScope }: {
  attachments: FileAssetDto[]; setAttachments: Dispatch<SetStateAction<FileAssetDto[]>>; disabled?: boolean; uploadScope?: string;
}) {
  useLocale();
  return <> {attachments.length ? <div className="composer-attachments" aria-label={t("AttachmentEditor.pending_attachments")}>
    {attachments.map((asset) => <div className="attachment-chip" key={asset.id}>
      {asset.kind === "image" ? <img src={assetUrl(asset.url)} alt={asset.fileName} /> : <FileText size={20} />}
      <span>{asset.fileName}<small className="muted"> {formatBytes(asset.byteSize)}</small></span>
      <button type="button" disabled={disabled} aria-label={t("AttachmentEditor.remove", { value1: (asset.fileName) })} onClick={() => setAttachments((items) => items.filter((item) => item.id !== asset.id))}><X size={13} /></button>
    </div>)}
  </div> : null}{uploadScope && <UploadTasks scopeId={uploadScope} />}</>;
}
