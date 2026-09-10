import { ActionButton } from "../../lib/action-feedback";
import { useBackLayer } from "../../lib/mobile-navigation";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Popover } from "radix-ui";
import { FilePlus2, FileText, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import type { FileAssetDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { toast, toastError } from "../../lib/app-state";
import { fileToBase64 } from "../../lib/format";

export interface PendingAttachment { id: string; file: File; url?: string; error?: string }

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export function useAttachments(initial: FileAssetDto[] = [], scope?: string) {
  const [attachments, setAttachments] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingAttachment[]>([]);
  const previewUrls = useRef(new Set<string>());
  useEffect(() => () => { for (const url of previewUrls.current) URL.revokeObjectURL(url); previewUrls.current.clear(); }, []);
  const removeUpload = (id: string) => setPendingUploads((items) => items.filter((item) => {
    if (item.id !== id) return true;
    if (item.url) { URL.revokeObjectURL(item.url); previewUrls.current.delete(item.url); }
    return false;
  }));
  const version = useRef(0);
  const busy = useRef(false);
  useEffect(() => { version.current++; busy.current = false; setUploading(false); return () => { version.current++; }; }, [scope]);
  const uploadFiles = async (files: File[]) => {
    if (busy.current || !files.length) return;
    busy.current = true;
    setUploading(true);
    const currentVersion = version.current;
    const next = [...attachments];
    const batch = files.map((file) => {
      const url = IMAGE_TYPES.has(file.type) && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
      if (url) previewUrls.current.add(url);
      return { id: crypto.randomUUID(), file, ...(url ? { url } : {}) };
    });
    setPendingUploads((items) => [...items, ...batch]);
    const failure = (file: File, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const id = batch.find((item) => item.file === file)?.id;
      setPendingUploads((items) => items.map((item) => item.id === id ? { ...item, error: message } : item));
      toast("error", message);
    };
    try {
      for (const file of files) {
        if (currentVersion !== version.current) return;
        const image = IMAGE_TYPES.has(file.type);
        const images = next.filter((asset) => asset.kind === "image");
        if (next.length >= 8) { failure(file, "每条消息最多附加 8 个文件"); continue; }
        if (file.size > (image ? 5 : 64) * 1024 * 1024) { failure(file, `${file.name} 超过 ${image ? 5 : 64} MiB`); continue; }
        if (image && (images.length >= 4 || images.reduce((sum, item) => sum + item.byteSize, 0) + file.size > 15 * 1024 * 1024)) {
          failure(file, "每条消息最多附加 4 张图片，图片总大小不超过 15 MiB"); continue;
        }
        if (next.reduce((sum, item) => sum + item.byteSize, 0) + file.size > 128 * 1024 * 1024) {
          failure(file, "附件总大小不能超过 128 MiB"); continue;
        }
        try {
          const asset = image ? await endpoints.uploadImage(file.name || "pasted-image.png", await fileToBase64(file)) : await endpoints.uploadFile(file);
          if (currentVersion !== version.current) return;
          next.push({ ...asset, kind: asset.kind ?? (image ? "image" : "file") });
          setAttachments((items) => [...items, next.at(-1)!]);
          removeUpload(batch.find((item) => item.file === file)!.id);
        } catch (error) { if (currentVersion === version.current) failure(file, error); }
      }
    } finally {
      if (currentVersion === version.current) { busy.current = false; setUploading(false); }
    }
  };
  return { attachments, setAttachments, uploading, uploadFiles, pendingUploads, removeUpload };
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
      <Popover.Trigger asChild><ActionButton type="button" className="chip composer-attachment-button" disabled={disabled || uploading} aria-label="添加附件" title="添加附件">
        {uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}
      </ActionButton></Popover.Trigger>
      <Popover.Portal><Popover.Content className="composer-more-popover attachment-menu" side="top" align="start" sideOffset={8}>
        <ActionButton type="button" onClick={() => { fileInput.current?.click(); setOpen(false); }}><FilePlus2 size={17} />上传文件</ActionButton>
        <ActionButton type="button" onClick={() => { imageInput.current?.click(); setOpen(false); }}><ImagePlus size={17} />上传图片</ActionButton>
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
      <ActionButton type="button" disabled={disabled} aria-label={`移除 ${asset.fileName}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== asset.id))}><X size={13} /></ActionButton>
    </div>)}
  </div> : null;
}

export function PendingAttachmentList({ items, remove, retry, uploading }: {
  items: PendingAttachment[]; remove: (id: string) => void; retry: (files: File[]) => Promise<void>; uploading: boolean;
}) {
  return <div className="composer-attachments">{items.map((item) => <div className="attachment-chip" key={item.id}>
    {item.url ? <img src={item.url} alt={item.file.name} /> : <FileText size={20} />}
    <span>{item.file.name}</span><span role={item.error ? "alert" : "status"}>{item.error ?? "正在上传…"}</span>
    {item.error ? <><ActionButton disabled={uploading} onClick={() => { remove(item.id); return retry([item.file]); }}>重试</ActionButton>
      <ActionButton onClick={() => remove(item.id)}>移除</ActionButton></> : null}
  </div>)}</div>;
}
