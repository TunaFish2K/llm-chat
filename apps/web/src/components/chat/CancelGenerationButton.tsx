import { ActionButton } from "../../lib/action-feedback";
import { useEffect, useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { endpoints } from "../../lib/api";
import { isGenerationActive, loadMessages, toastError } from "../../lib/app-state";

export function CancelGenerationButton({ conversationId, generationId, className = "act" }: { conversationId: string; generationId: string; className?: string }) {
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [generationId]);
  const cancel = async () => {
    setStopping(true);
    try {
      const result = await endpoints.cancelGeneration(conversationId, generationId);
      if (result.ok === false && result.status !== "stopping" && isGenerationActive(result.status)) throw new Error("取消未生效，请重试");
      if (result.status !== "stopping") {
        await loadMessages(conversationId);
        setStopping(false);
      }
    }
    catch (error) { setStopping(false); toastError(error); }
  };
  return <ActionButton type="button" className={className} disabled={stopping} onClick={() => cancel()}
    aria-label={stopping ? "正在取消" : "停止生成"} title={stopping ? "正在取消" : "停止生成"}>
    {stopping ? <LoaderCircle size={17} className="spin" /> : <Square size={17} fill="currentColor" />}
  </ActionButton>;
}
