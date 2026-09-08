import { useEffect, useRef } from "react";

/** A short press sends on release. Holding sends once at the threshold. */
export function useHoldSend(send: (steer: boolean) => void, identity?: string) {
  const callback = useRef(send); callback.current = send;
  const state = useRef<{ timer?: ReturnType<typeof setTimeout>; active: boolean; held: boolean }>({ active: false, held: false });
  const suppressClick = useRef(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => { clearTimeout(state.current.timer); state.current = { active: false, held: false }; };
  useEffect(() => {
    const blur = () => cancel();
    const newPointer = () => { suppressClick.current = false; };
    const click = (event: MouseEvent) => {
      if (!suppressClick.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); suppressClick.current = false;
    };
    const release = () => { clearTimeout(releaseTimer.current); releaseTimer.current = setTimeout(() => { suppressClick.current = false; }, 500); };
    window.addEventListener("blur", blur);
    document.addEventListener("click", click, true);
    document.addEventListener("pointerdown", newPointer, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("keyup", release, true);
    return () => { cancel(); clearTimeout(releaseTimer.current); suppressClick.current = false; window.removeEventListener("blur", blur);
      document.removeEventListener("click", click, true); document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointerdown", newPointer, true);
      document.removeEventListener("pointercancel", release, true); document.removeEventListener("keyup", release, true); };
  }, [identity]);
  return {
    start(pointer = false) { if (state.current.active) return; state.current = { active: true, held: false, timer: setTimeout(() => { state.current.held = true; suppressClick.current = pointer; callback.current(true); }, 450) }; },
    finish() { const tap = state.current.active && !state.current.held; cancel(); if (tap) callback.current(false); },
    cancel
  };
}
