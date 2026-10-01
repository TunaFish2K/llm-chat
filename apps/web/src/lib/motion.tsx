import { useBackLayer } from "./mobile-navigation";
import type { ReactNode } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "motion/react";

export { animate, m, useIsPresent, useMotionValue, usePresence, useReducedMotion, useTransform } from "motion/react";

export const drawerEase = [.2, .7, .2, 1] as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation} strict><MotionConfig reducedMotion="user">{children}</MotionConfig></LazyMotion>;
}

/** Keep presence at the conditional owner so the whole dialog survives its exit. */
export function Presence({ children, onExitComplete }: { children: ReactNode; onExitComplete?: () => void }) {
  return <MotionProvider><AnimatePresence initial={false} {...(onExitComplete ? { onExitComplete } : {})}>{children}</AnimatePresence></MotionProvider>;
}

/** Radix keeps this child mounted through its CSS exit animation. */
export function PopoverLayer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBackLayer(true, () => { if (open) onClose(); }, 40);
  return null;
}
