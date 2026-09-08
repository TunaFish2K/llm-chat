import { useEffect, useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, toastError } from "../../lib/app-state";

export function CancelGenerationButton({ generationId, className = "act" }: { generationId: string; className?: string }) {
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [generationId]);
  const cancel = async () => {
    setStopping(true);
    try {
      const result = await endpoints.cancelGeneration(generationId);
      if (result.ok === false && result.status !== "stopping" && isGenerationActive(result.status)) throw new Error("取消未生效，请重试");
      if (result.status !== "stopping") {
        const owner = Object.entries(appStore.get().messages).find(([, messages]) => messages.some((message) => message.generations.some((generation) => generation.id === generationId)));
        if (owner) await loadMessages(owner[0]);
        setStopping(false);
      }
    }
    catch (error) { setStopping(false); toastError(error); }
  };
  return <button type="button" className={className} disabled={stopping} onClick={() => void cancel()}
    aria-label={stopping ? "正在取消" : "停止生成"} title={stopping ? "正在取消" : "停止生成"}>
    {stopping ? <LoaderCircle size={17} className="spin" /> : <Square size={17} fill="currentColor" />}
  </button>;
}
