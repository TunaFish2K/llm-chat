import { t, useLocale } from "../lib/i18n";
import { useEffect, useState } from "react";
import { Modal } from "../lib/ui";

export const TOUR_KEY = "llm-chat.quick-tour.v1";
export function QuickTour() {
  useLocale();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const mobile = window.matchMedia("(pointer: coarse)").matches;
  useEffect(() => {
    try { setOpen(localStorage.getItem(TOUR_KEY) !== "seen"); } catch { setOpen(true); }
    const replay = () => { setStep(0); setOpen(true); };
    window.addEventListener("llm-chat:quick-tour", replay);
    return () => window.removeEventListener("llm-chat:quick-tour", replay);
  }, []);
  const close = () => { try { localStorage.setItem(TOUR_KEY, "seen"); } catch {} setOpen(false); };
  const pages = [
    [t("QuickTour.connect_a_model_first"), t("QuickTour.in_connections_and_models_choose_a_provider_enter_a_key")],
    [t("QuickTour.using_the_composer"), t("QuickTour.choose_an_agent_model_and_thinking_level_on_the_left")],
    [t("QuickTour.send_messages_during_generation"), mobile ? t("QuickTour.select_send_to_queue_a_message_for_the_end_of") : t("QuickTour.press_enter_to_send_or_shift_enter_for_a_new")],
    [t("QuickTour.find_chats_and_personalize"), t("QuickTour.use_the_sidebar_search_to_find_conversation_titles_and_messages")]
  ];
  if (!open) return null;
  return <Modal title={t("QuickTour.quick_start")} onClose={close} footer={<>
    <button className="btn" onClick={close}>{t("QuickTour.skip_tour")}</button>
    {step > 0 ? <button className="btn" onClick={() => setStep(step - 1)}>{t("QuickTour.back")}</button> : null}
    <button className="btn primary" onClick={() => step === pages.length - 1 ? close() : setStep(step + 1)}>{step === pages.length - 1 ? t("QuickTour.get_started") : t("QuickTour.next")}</button>
  </>}>
    <div className="quick-tour" aria-live="polite"><span className="hint">{step + 1} / {pages.length}</span>
      <h3>{pages[step]![0]}</h3><p>{pages[step]![1]}</p>
      {step === 2 ? <p className="hint">{t("QuickTour.steer_does_not_interrupt_the_current_request_or_tool_or")}</p> : null}
    </div>
  </Modal>;
}
