/**
 * Opening a native file picker hides the page on phones. Returning fires the
 * same visibility, focus and pageshow events as resuming the app, which would
 * refetch and re-render everything at the moment the user attaches a file.
 * The page never left, so resume work is skipped while a picker is in use.
 */
const MAX_PICKER_MS = 60_000;
const SETTLE_MS = 1_500;
let openedAt = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

export function notePickerOpen(now = Date.now()): void {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  openedAt = now;
}

/** Call when the picker reports `change` or `cancel`; resume events can still follow briefly. */
export function notePickerClosed(): void {
  if (!openedAt) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { openedAt = 0; closeTimer = undefined; }, SETTLE_MS);
}

export function returningFromPicker(now = Date.now()): boolean {
  if (!openedAt) return false;
  if (now - openedAt <= MAX_PICKER_MS) return true;
  openedAt = 0;
  return false;
}

/** Props for a hidden file input whose picker should not count as an app resume. */
export const pickerInputEvents = {
  onClick: () => notePickerOpen(),
  onCancel: () => notePickerClosed()
};
