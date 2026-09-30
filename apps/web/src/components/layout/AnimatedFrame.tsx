import { Component, createRef, type ReactNode } from "react";

interface Props { left: number; right: number; sidebarCollapsed: boolean; inspectorOpen: boolean; children: ReactNode }
interface Snapshot { positions: Map<Element, DOMRect>; exits: Array<{ element: HTMLElement; before: DOMRect }> }
const REGIONS = ".workspace-sidebar, .workspace-main, .inspector-panel";
const timing = { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" };

/** Capture geometry and departing content before React applies the final layout. */
export class AnimatedFrame extends Component<Props, Record<string, never>, Snapshot | null> {
  private readonly frame = createRef<HTMLDivElement>();
  private animations: Animation[] = [];
  private ghosts: HTMLElement[] = [];
  private stop() {
    for (const animation of this.animations) animation.cancel();
    for (const ghost of this.ghosts) ghost.remove();
    this.animations = []; this.ghosts = [];
  }
  override getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if ((previous.sidebarCollapsed === this.props.sidebarCollapsed && previous.inspectorOpen === this.props.inspectorOpen)
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    const positions = new Map([...this.frame.current!.children].filter(element => element.matches(REGIONS)).map(element => [element, element.getBoundingClientRect()]));
    const exits: Snapshot["exits"] = [];
    for (const [element, before] of positions) {
      if ((element.matches(".workspace-sidebar") && this.props.left < previous.left)
        || (element.matches(".inspector-panel") && this.props.right < previous.right)) {
        const ghost = element.cloneNode(true) as HTMLElement;
        ghost.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
        ghost.querySelectorAll(".modal-backdrop").forEach(node => node.remove());
        const embedded = element.querySelectorAll("iframe, video, audio");
        ghost.querySelectorAll("iframe, video, audio").forEach((node, index) => {
          const bounds = embedded[index]!.getBoundingClientRect(), placeholder = document.createElement("div");
          Object.assign(placeholder.style, { width: `${bounds.width}px`, height: `${bounds.height}px` });
          node.replaceWith(placeholder);
        });
        ghost.removeAttribute("id"); ghost.inert = true; ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { position: "fixed", top: `${before.top}px`, left: `${before.left}px`, width: `${before.width}px`, height: `${before.height}px`, pointerEvents: "none", zIndex: "5" });
        exits.push({ element: ghost, before });
      }
    }
    return { positions, exits };
  }
  override componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    if (!snapshot) { if (previous.left !== this.props.left || previous.right !== this.props.right) this.stop(); return; }
    this.stop();
    for (const element of [...this.frame.current!.children].filter(element => element.matches(REGIONS))) {
      const before = snapshot.positions.get(element), after = element.getBoundingClientRect();
      if (typeof element.animate !== "function") continue;
      const offset = before ? before.left - after.left : 0;
      if (offset) this.animations.push(element.animate([{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }], timing));
      if (element.matches(".workspace-sidebar, .inspector-panel") && after.width > (before?.width ?? 0)) {
        this.animations.push(element.animate([{ clipPath: `inset(0 ${after.width - (before?.width ?? 0)}px 0 0)`, opacity: before ? 1 : 0 }, { clipPath: "inset(0 0 0 0)", opacity: 1 }], timing));
      }
    }
    for (const { element, before } of snapshot.exits) {
      if (typeof element.animate !== "function") continue;
      document.body.append(element); this.ghosts.push(element);
      const remaining = element.matches(".workspace-sidebar") ? this.props.left : this.props.right;
      const animation = element.animate([{ clipPath: "inset(0 0 0 0)", opacity: 1 }, { clipPath: `inset(0 ${Math.max(0, before.width - remaining)}px 0 0)`, opacity: 0 }], timing);
      this.animations.push(animation);
      void animation.finished.then(() => element.remove(), () => element.remove());
    }
  }
  override componentWillUnmount() { this.stop(); }
  override render() {
    const { left, right, sidebarCollapsed, inspectorOpen, children } = this.props;
    return <div ref={this.frame} className="app-frame"
      style={{ gridTemplateColumns: `${left}px minmax(0, 1fr) ${right}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined} data-inspector-open={inspectorOpen || undefined}>{children}</div>;
  }
}
