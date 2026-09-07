import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw } from "lucide-react";
import { LoginView } from "./views/LoginView";
import { ChatView } from "./views/ChatView";
import { WorkspaceSidebar } from "./views/WorkspaceSidebar";
import { InspectorPanel } from "./views/InspectorPanel";
import { appStore, bootstrap, initAuthGate, refreshTaskCounts, startAppEvents } from "./lib/app-state";
import { endpoints } from "./lib/api";
import type { InspectionTarget } from "./lib/inspection";
import { navigate, replaceRoute, routes, useRoute, type Route } from "./lib/router";
import { useStore } from "./lib/store";
import { useTheme } from "./lib/theme";
import { applyUpdate, getPwaState, initPwa, promptInstall, subscribePwa } from "./lib/pwa";
import { ErrorState, LoadingState } from "./lib/ui";

const AgentsView = lazy(() => import("./views/AgentsView").then((module) => ({ default: module.AgentsView })));
const AgentEditorView = lazy(() => import("./views/AgentEditorView").then((module) => ({ default: module.AgentEditorView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((module) => ({ default: module.SettingsView })));

const LEFT_MIN = 224;
const LEFT_MAX = 380;
const RIGHT_MIN = 300;
const RIGHT_MAX = 560;

export function App() {
  const state = useStore(appStore, (value) => value);
  const route = useRoute();
  const initialConversation = useRef(route.name === "chat" ? route.conversationId ?? undefined : undefined);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [sidebarDrawer, setSidebarDrawer] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspection, setInspection] = useState<InspectionTarget | null>(null);
  const [leftWidth, setLeftWidth] = useStoredNumber("llm-chat.sidebar-width", 276, LEFT_MIN, LEFT_MAX);
  const [rightWidth, setRightWidth] = useStoredNumber("llm-chat.inspector-width", 360, RIGHT_MIN, RIGHT_MAX);
  const [pwa, setPwa] = useState(getPwaState());
  const preferencesApplied = useRef(false);
  useTheme(state.settings);

  useEffect(() => {
    initAuthGate();
    initPwa();
    void bootstrap(initialConversation.current);
    return subscribePwa(setPwa);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (state.auth !== "ready") return;
    startAppEvents();
    void refreshTaskCounts();
  }, [state.auth]);

  useEffect(() => {
    if (!state.settings || preferencesApplied.current) return;
    preferencesApplied.current = true;
    setSidebarCollapsed(state.settings.uiPreferences.sidebarCollapsed);
  }, [state.settings]);

  useEffect(() => {
    setSidebarDrawer(false);
    setInspection(null);
    if (route.name !== "chat" || !route.conversationId) setInspectorOpen(false);
    else setInspectorOpen(!mobile);
  }, [route, mobile]);

  const conversation = route.name === "chat" && route.conversationId
    ? state.conversations.find((item) => item.id === route.conversationId) ?? null
    : null;
  const showInspector = route.name === "chat" && Boolean(conversation) && inspectorOpen;
  const sidebarTrack = mobile ? 0 : sidebarCollapsed ? 56 : leftWidth;
  const inspectorTrack = mobile ? 0 : showInspector ? rightWidth : 0;
  const title = routeTitle(route, state.conversations, state.agents);

  if (state.auth === "loading") {
    return <div className="boot-screen">{state.bootError ? <ErrorState message={`无法连接服务：${state.bootError}`} onRetry={() => void bootstrap(initialConversation.current)} /> : <LoadingState label="正在启动 llm-chat…" />}</div>;
  }
  if (state.auth === "required") return <LoginView />;

  return (
    <div
      className="app-frame"
      style={{ gridTemplateColumns: `${sidebarTrack}px minmax(0, 1fr) ${inspectorTrack}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-inspector-open={showInspector || undefined}
    >
      {!mobile ? (
        <WorkspaceSidebar
          route={route}
          compact={sidebarCollapsed}
          onToggleCompact={() => setSidebarCollapsed((value) => !value)}
          pwa={pwa}
          onInstall={() => void promptInstall()}
        />
      ) : null}
      {!mobile && !sidebarCollapsed ? <ResizeHandle side="left" position={sidebarTrack} value={leftWidth} min={LEFT_MIN} max={LEFT_MAX} onChange={setLeftWidth} /> : null}

      <main className="workspace-main">
        <header className="mobile-appbar">
          <button className="icon-button" onClick={() => setSidebarDrawer(true)} aria-label="打开导航"><Menu size={20} /></button>
          <strong role="heading" aria-level={2}>{title}</strong>
          {conversation ? <button className="icon-button" onClick={() => setInspectorOpen(true)} aria-label="打开检查器"><PanelRightOpen size={19} /></button> : <span />}
        </header>
        <Suspense fallback={<LoadingState label="正在加载界面…" />}>
          <RouteView
            route={route}
            inspectorOpen={showInspector}
            onToggleInspector={() => setInspectorOpen((value) => !value)}
            onInspect={(target) => { setInspection(target); setInspectorOpen(true); }}
          />
        </Suspense>
      </main>

      {!mobile && showInspector ? <ResizeHandle side="right" position={rightWidth} value={rightWidth} min={RIGHT_MIN} max={RIGHT_MAX} onChange={setRightWidth} /> : null}
      {!mobile && showInspector ? <InspectorPanel conversation={conversation} target={inspection} onClose={() => setInspectorOpen(false)} /> : null}

      {mobile && sidebarDrawer ? (
        <div className="mobile-drawer" data-side="left">
          <button className="drawer-scrim" onClick={() => setSidebarDrawer(false)} aria-label="关闭导航" />
          <WorkspaceSidebar route={route} compact={false} onClose={() => setSidebarDrawer(false)} pwa={pwa} onInstall={() => void promptInstall()} />
        </div>
      ) : null}
      {mobile && showInspector ? (
        <div className="mobile-drawer" data-side="right">
          <button className="drawer-scrim" onClick={() => setInspectorOpen(false)} aria-label="关闭检查器" />
          <InspectorPanel conversation={conversation} target={inspection} onClose={() => setInspectorOpen(false)} />
        </div>
      ) : null}

      <div className="toast-stack" aria-live="polite">
        {pwa.updateAvailable ? <div className="toast info"><RefreshCw size={16} /><span>新版本已准备好</span><button className="button primary small" onClick={applyUpdate}>更新</button></div> : null}
        {state.toasts.map((item) => <div key={item.id} className={`toast ${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>{item.text}</div>)}
      </div>
    </div>
  );
}

function RouteView({
  route,
  inspectorOpen,
  onToggleInspector,
  onInspect
}: {
  route: Route;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onInspect: (target: InspectionTarget) => void;
}) {
  if (route.name === "agents") return <section className="admin-shell">{route.agentId ? <AgentEditorView agentId={route.agentId} /> : <AgentsView />}</section>;
  if (route.name === "tasks") return <LegacyTaskRedirect taskId={route.taskId} />;
  if (route.name === "settings") return <section className="admin-shell"><SettingsView section={route.section} /></section>;
  return (
    <ChatView
      conversationId={route.conversationId}
      view={route.view}
      taskId={route.taskId}
      inspectorOpen={inspectorOpen}
      onToggleInspector={onToggleInspector}
      onInspect={onInspect}
      onViewChange={(view) => navigate(
        view === "tasks"
          ? route.conversationId ? routes.conversationTasks(route.conversationId) : routes.chat()
          : routes.chat(route.conversationId, view)
      )}
    />
  );
}

function LegacyTaskRedirect({ taskId }: { taskId: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    if (!taskId) {
      replaceRoute(routes.chat());
      return () => { active = false; };
    }
    setError(null);
    void endpoints.backgroundTask(taskId).then(({ task }) => {
      if (active) replaceRoute(routes.conversationTasks(task.conversationId, task.id));
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "任务加载失败");
    });
    return () => { active = false; };
  }, [taskId, attempt]);

  return error
    ? <ErrorState message={error} onRetry={() => setAttempt((value) => value + 1)} />
    : <LoadingState label="正在打开会话任务…" />;
}

function ResizeHandle({ side, position, value, min, max, onChange }: { side: "left" | "right"; position: number; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startValue = value;
    const target = event.currentTarget;
    const move = (next: PointerEvent) => {
      const delta = next.clientX - startX;
      onChange(clamp(startValue + (side === "left" ? delta : -delta), min, max));
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };
  return (
    <div
      className="resize-handle"
      data-side={side}
      style={side === "left" ? { left: position - 2 } : { right: position - 2 }}
      role="separator"
      aria-label={side === "left" ? "调整会话栏宽度" : "调整检查器宽度"}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 16 : -16;
        onChange(clamp(value + (side === "left" ? delta : -delta), min, max));
      }}
    />
  );
}

function useStoredNumber(key: string, fallback: number, min: number, max: number): [number, (value: number) => void] {
  const [value, setValue] = useState(() => {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clamp(stored, min, max) : fallback;
  });
  return [value, (next) => { const safe = clamp(next, min, max); setValue(safe); localStorage.setItem(key, String(safe)); }];
}

function routeTitle(
  route: Route,
  conversations: Array<{ id: string; title: string }>,
  agents: Array<{ id: string; name: string }>
): string {
  if (route.name === "chat") return route.conversationId ? conversations.find((item) => item.id === route.conversationId)?.title ?? "会话" : "新会话";
  if (route.name === "agents") return route.agentId ? agents.find((item) => item.id === route.agentId)?.name ?? "Agent" : "Agent";
  if (route.name === "tasks") return "后台任务";
  return "设置";
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

export function ShellToggleIcons({ side, open }: { side: "left" | "right"; open: boolean }) {
  if (side === "left") return open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />;
  return open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />;
}
