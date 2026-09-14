import { t, useLocale } from "../../lib/i18n";
import { useBackLayer } from "../../lib/mobile-navigation";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Popover } from "radix-ui";
import { FilePlus2, FileText, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import type { FileAssetDto } from "@llm-chat/contracts";
import { toast } from "../../lib/app-state";
import { formatBytes } from "../../lib/format";
import { uploadManager, uploadStore } from "../../lib/file-upload-manager";
import { useStore } from "../../lib/store";
import { UploadTasks } from "../FileUploads";

export function useAttachments(initial: FileAssetDto[] = [], scope = "new", conversationId?: string) {
  useLocale();
  useStore(uploadStore, (state) => state.revision);
  const current = uploadManager.ensure(scope, initial, conversationId);
  const setAttachments: Dispatch<SetStateAction<FileAssetDto[]>> = (action) => {
    const latest = uploadManager.ensure(scope, initial, conversationId).attachments;
    uploadManager.setAttachments(scope, typeof action === "function" ? action(latest) : action);
  };
  const uploadFiles = async (files: File[]) => {
    for (const error of uploadManager.enqueue(scope, files)) toast("error", error);
  };
  return { attachments: current.attachments, setAttachments, uploading: current.tasks.length > 0, uploadFiles, uploadScope: scope,
    attachmentCount: current.attachments.length + current.tasks.length };
}

export function AttachmentMenu({ uploadFiles, disabled, uploading = false }: {
  uploadFiles: (files: File[]) => Promise<void>; disabled?: boolean; uploading?: boolean;
}) {
  useLocale();
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  return <>
    <input hidden aria-label={t("AttachmentEditor.upload_files")} ref={fileInput} type="file" multiple onChange={(event) => {
      void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = "";
    }} />
    <input hidden aria-label={t("AttachmentEditor.upload_images")} ref={imageInput} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => {
      void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = "";
    }} />
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="chip composer-attachment-button" disabled={disabled} aria-label={t("AttachmentEditor.add_attachment")} title={t("AttachmentEditor.add_attachment")}>
        {uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="composer-more-popover attachment-menu" side="top" align="start" sideOffset={8}>
        <button type="button" onClick={() => { fileInput.current?.click(); setOpen(false); }}><FilePlus2 size={17} />{t("AttachmentEditor.upload_files")}</button>
        <button type="button" onClick={() => { imageInput.current?.click(); setOpen(false); }}><ImagePlus size={17} />{t("AttachmentEditor.upload_images")}</button>
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
      {asset.kind === "image" ? <img src={asset.url} alt={asset.fileName} /> : <FileText size={20} />}
      <span>{asset.fileName}<small className="muted"> {formatBytes(asset.byteSize)}</small></span>
      <button type="button" disabled={disabled} aria-label={t("AttachmentEditor.remove", { value1: (asset.fileName) })} onClick={() => setAttachments((items) => items.filter((item) => item.id !== asset.id))}><X size={13} /></button>
    </div>)}
  </div> : null}{uploadScope && <UploadTasks scopeId={uploadScope} />}</>;
}
