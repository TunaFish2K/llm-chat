import { useBackLayer } from "../../lib/mobile-navigation";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Popover } from "radix-ui";
import { FilePlus2, FileText, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import type { FileAssetDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { toast, toastError } from "../../lib/app-state";
import { fileToBase64 } from "../../lib/format";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export function useAttachments(initial: FileAssetDto[] = [], scope?: string) {
  const [attachments, setAttachments] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const version = useRef(0);
  const busy = useRef(false);
  useEffect(() => { version.current++; busy.current = false; setUploading(false); return () => { version.current++; }; }, [scope]);
  const uploadFiles = async (files: File[]) => {
    if (busy.current || !files.length) return;
    busy.current = true;
    setUploading(true);
    const currentVersion = version.current;
    const next = [...attachments];
    try {
      for (const file of files) {
        if (currentVersion !== version.current) return;
        const image = IMAGE_TYPES.has(file.type);
        const images = next.filter((asset) => asset.kind === "image");
        if (next.length >= 8) { toast("error", "每条消息最多附加 8 个文件"); break; }
        if (file.size > (image ? 5 : 64) * 1024 * 1024) { toast("error", `${file.name} 超过 ${image ? 5 : 64} MiB`); continue; }
        if (image && (images.length >= 4 || images.reduce((sum, item) => sum + item.byteSize, 0) + file.size > 15 * 1024 * 1024)) {
          toast("error", "每条消息最多附加 4 张图片，图片总大小不超过 15 MiB"); continue;
        }
        if (next.reduce((sum, item) => sum + item.byteSize, 0) + file.size > 128 * 1024 * 1024) {
          toast("error", "附件总大小不能超过 128 MiB"); continue;
        }
        try {
          const asset = image ? await endpoints.uploadImage(file.name || "pasted-image.png", await fileToBase64(file)) : await endpoints.uploadFile(file);
          if (currentVersion !== version.current) return;
          next.push({ ...asset, kind: asset.kind ?? (image ? "image" : "file") });
          setAttachments([...next]);
        } catch (error) { if (currentVersion === version.current) toastError(error); }
      }
    } finally {
      if (currentVersion === version.current) { busy.current = false; setUploading(false); }
    }
  };
  return { attachments, setAttachments, uploading, uploadFiles };
}

export function AttachmentMenu({ uploadFiles, disabled, uploading = false }: {
  uploadFiles: (files: File[]) => Promise<void>; disabled?: boolean; uploading?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  return <>
    <input hidden aria-label="上传文件" ref={fileInput} type="file" multiple onChange={(event) => {
      void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = "";
    }} />
    <input hidden aria-label="上传图片" ref={imageInput} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => {
      void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = "";
    }} />
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="chip composer-attachment-button" disabled={disabled || uploading} aria-label="添加附件" title="添加附件">
        {uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="composer-more-popover attachment-menu" side="top" align="start" sideOffset={8}>
        <button type="button" onClick={() => { fileInput.current?.click(); setOpen(false); }}><FilePlus2 size={17} />上传文件</button>
        <button type="button" onClick={() => { imageInput.current?.click(); setOpen(false); }}><ImagePlus size={17} />上传图片</button>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </>;
}

export function AttachmentList({ attachments, setAttachments, disabled = false }: {
  attachments: FileAssetDto[]; setAttachments: Dispatch<SetStateAction<FileAssetDto[]>>; disabled?: boolean;
}) {
  return attachments.length ? <div className="composer-attachments" aria-label="待发送附件">
    {attachments.map((asset) => <div className="attachment-chip" key={asset.id}>
      {asset.kind === "image" ? <img src={asset.url} alt={asset.fileName} /> : <FileText size={20} />}
      <span>{asset.fileName}</span>
      <button type="button" disabled={disabled} aria-label={`移除 ${asset.fileName}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== asset.id))}><X size={13} /></button>
    </div>)}
  </div> : null;
}
