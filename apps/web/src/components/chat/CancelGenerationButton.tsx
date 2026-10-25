import { t, useLocale } from "../../lib/i18n";
import { useEffect, useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { endpoints } from "../../lib/api";
import { isGenerationActive, loadMessages, toastError } from "../../lib/app-state";

export function useCancelGeneration(conversationId: string, generationId: string) {
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [generationId]);
  const cancel = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const result = await endpoints.cancelGeneration(conversationId, generationId);
      if (result.ok === false && result.status !== "stopping" && isGenerationActive(result.status)) throw new Error(t("CancelGenerationButton.cancellation_did_not_take_effect_try_again"));
      if (result.status !== "stopping") {
        void loadMessages(conversationId).catch(toastError);
        setStopping(false);
      }
    }
    catch (error) { setStopping(false); toastError(error); }
  };
  return { stopping, cancel };
}

export function CancelGenerationButton({ conversationId, generationId, className = "act", control, shortcut }: {
  conversationId: string; generationId: string; className?: string;
  control?: ReturnType<typeof useCancelGeneration>; shortcut?: boolean;
}) {
  useLocale();
  const own = useCancelGeneration(conversationId, generationId);
  const { stopping, cancel } = control ?? own;
  const label = stopping ? t("CancelGenerationButton.canceling") : t("CancelGenerationButton.stop_generation");
  return <button type="button" className={className} disabled={stopping} onClick={() => void cancel()}
    aria-label={label} title={shortcut && !stopping ? t("CancelGenerationButton.stop_generation_esc") : label} aria-keyshortcuts={shortcut ? "Escape" : undefined}>
    {stopping ? <LoaderCircle size={17} className="spin" /> : <Square size={17} fill="currentColor" />}
  </button>;
}
