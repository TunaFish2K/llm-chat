import { useBackLayer } from "./mobile-navigation";
import type { ReactNode } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "motion/react";

export { animate, m, useIsPresent, useMotionValue, usePresence, useReducedMotion, useTransform } from "motion/react";

export const motionTiming = { enter: 0.18, exit: 0.14, message: 0.12 };
export const drawerSpring = { type: "spring" as const, stiffness: 400, damping: 40, mass: 1 };

export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation} strict><MotionConfig reducedMotion="user">{children}</MotionConfig></LazyMotion>;
}

/** Keep presence at the conditional owner so the whole dialog survives its exit. */
export function Presence({ children }: { children: ReactNode }) {
  return <MotionProvider><AnimatePresence initial={false}>{children}</AnimatePresence></MotionProvider>;
}

/** Radix keeps this child mounted through its CSS exit animation. */
export function PopoverLayer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBackLayer(true, () => { if (open) onClose(); }, 40);
  return null;
}
