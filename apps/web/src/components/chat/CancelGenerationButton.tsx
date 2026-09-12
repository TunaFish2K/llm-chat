import { t, useLocale } from "../../lib/i18n";
import { useEffect, useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { endpoints } from "../../lib/api";
import { isGenerationActive, loadMessages, toastError } from "../../lib/app-state";

export function CancelGenerationButton({ conversationId, generationId, className = "act" }: { conversationId: string; generationId: string; className?: string }) {
  useLocale();
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [generationId]);
  const cancel = async () => {
    setStopping(true);
    try {
      const result = await endpoints.cancelGeneration(conversationId, generationId);
      if (result.ok === false && result.status !== "stopping" && isGenerationActive(result.status)) throw new Error(t("CancelGenerationButton.cancellation_did_not_take_effect_try_again"));
      if (result.status !== "stopping") {
        await loadMessages(conversationId);
        setStopping(false);
      }
    }
    catch (error) { setStopping(false); toastError(error); }
  };
  return <button type="button" className={className} disabled={stopping} onClick={() => void cancel()}
    aria-label={stopping ? t("CancelGenerationButton.canceling") : t("CancelGenerationButton.stop_generation")} title={stopping ? t("CancelGenerationButton.canceling") : t("CancelGenerationButton.stop_generation")}>
    {stopping ? <LoaderCircle size={17} className="spin" /> : <Square size={17} fill="currentColor" />}
  </button>;
}
