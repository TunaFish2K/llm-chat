import { t, useLocale } from "../../lib/i18n";
import { type Dispatch, type SetStateAction } from "react";
import { FileText, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import type { FileAssetDto } from "@llm-chat/contracts";
import { toast } from "../../lib/app-state";
import { formatBytes } from "../../lib/format";
import { uploadManager, uploadStore, type UploadIntent } from "../../lib/file-upload-manager";
import { useStore } from "../../lib/store";
import { UploadTasks } from "../FileUploads";
import { assetUrl } from "../../lib/server-channel";
import { NativeFileButton } from "../NativeFileButton";

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

export function AttachmentMenu({ uploadFiles, disabled, uploading = false }: {
  uploadFiles: (files: File[], intent?: UploadIntent) => Promise<void>; disabled?: boolean; uploading?: boolean;
}) {
  useLocale();
  return <div className="composer-native-files" aria-label={t("AttachmentEditor.add_attachment")}>
    <NativeFileButton
      className="chip composer-attachment-button"
      label={t("AttachmentEditor.upload_images")}
      accept="image/jpeg,image/png,image/webp,image/gif"
      multiple
      disabled={Boolean(disabled)}
      busy={uploading}
      onFiles={(files) => uploadFiles(files, "image")}
    >
      <ImagePlus size={17} />
    </NativeFileButton>
    <NativeFileButton
      className="chip composer-attachment-button"
      label={t("AttachmentEditor.upload_files")}
      multiple
      disabled={Boolean(disabled)}
      busy={uploading}
      onFiles={(files) => uploadFiles(files, "file")}
    >
      {uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}
    </NativeFileButton>
  </div>;
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
