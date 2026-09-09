import { initOfflineHistory, isOffline } from "./lib/offline-history";
import { OfflineBanner } from "./components/OfflineHistorySettings";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { dismissBackLayer, parentRoute, requestMobileBack, useMobileBackGesture } from "./lib/mobile-navigation";
import { endpoints } from "./lib/api";
import { appStore, bootstrap, initAuthGate, refreshTaskCounts, startAppEvents, toast } from "./lib/app-state";
import type { InspectionTarget } from "./lib/inspection";
import { applyUpdate, getPwaState, initPwa, promptInstall, subscribePwa } from "./lib/pwa";
import { navigate, replaceRoute, routes, useRoute, type Route } from "./lib/router";
import { useStore } from "./lib/store";
import { useChatTypography } from "./lib/chat-typography";
import { useTheme } from "./lib/theme";
import { ErrorState, LoadingState } from "./components/ui";
import {
  AppFrame,
  BootScreen,
  LEFT_MAX,
  LEFT_MIN,
  MobileAppBar,
  MobileDrawer,
  RAIL_WIDTH,
  ResizeHandle,
  RIGHT_MAX,
  RIGHT_MIN,
  ToastStack,
  routeTitle,
  useMediaQuery,
  useStoredNumber
} from "./components/layout";
import { ChatView } from "./views/ChatView";
import { InspectorPanel } from "./views/InspectorPanel";
import { LoginView } from "./views/LoginView";
import { WorkspaceSidebar } from "./views/WorkspaceSidebar";
import { QuickTour } from "./components/QuickTour";

const AgentsView = lazy(() => import("./views/AgentsView").then((module) => ({ default: module.AgentsView })));
const AgentEditorView = lazy(() =>
  import("./views/AgentEditorView").then((module) => ({ default: module.AgentEditorView }))
);
const SettingsView = lazy(() => import("./views/SettingsView").then((module) => ({ default: module.SettingsView })));

/**
 * Root of the console. It owns the shell's geometry and the three global
 * gates — boot, authentication and route — and delegates everything else.
 */
export function App() {
  const state = useStore(appStore, (value) => value);
  const route = useRoute();
  const initialConversation = useRef(route.name === "chat" ? route.conversationId ?? undefined : undefined);
  const mobile = useMediaQuery("(max-width: 767px)");
  const [navDrawer, setNavDrawer] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspection, setInspection] = useState<InspectionTarget | null>(null);
  const back = () => {
    if (dismissBackLayer()) return;
    const parent = parentRoute(route);
    if (parent) navigate(parent);
    else setNavDrawer(true);
  };
  const backOffset = useMobileBackGesture(mobile && state.auth === "ready", back);
  useEffect(() => {
    if (!mobile) return;
    window.addEventListener("llm-chat:back", back);
    return () => window.removeEventListener("llm-chat:back", back);
  }, [mobile, route]);

  const [leftWidth, setLeftWidth] = useStoredNumber("llm-chat.sidebar-width", 276, LEFT_MIN, LEFT_MAX);
  const [rightWidth, setRightWidth] = useStoredNumber("llm-chat.inspector-width", 360, RIGHT_MIN, RIGHT_MAX);
  const [pwa, setPwa] = useState(getPwaState());
  const preferencesApplied = useRef(false);
  useTheme(state.settings);
  useChatTypography(state.settings);

  useEffect(() => {
    initAuthGate();
    const draftWarning = () => toast("error", "无法保存本地草稿，刷新后可能丢失未发送内容");
    window.addEventListener("llm-chat:draft-storage-unavailable", draftWarning);
    const unsubscribePwa = subscribePwa(setPwa);
    initPwa();
    void bootstrap(initialConversation.current);
    return () => { unsubscribePwa(); window.removeEventListener("llm-chat:draft-storage-unavailable", draftWarning); };
  }, []);

  useEffect(() => {
    if (state.auth !== "ready") return;
    initOfflineHistory();
    startAppEvents();
    void refreshTaskCounts();
  }, [state.auth]);

  useEffect(() => {
    const reconnect = () => void bootstrap(location.pathname.match(/^\/c\/([^/]+)/)?.[1], true).then(() => { startAppEvents(); });
    const cleared = () => { if (isOffline()) void bootstrap(); };
    window.addEventListener("llm-chat:offline-reconnected", reconnect);
    window.addEventListener("llm-chat:offline-cleared", cleared);
    return () => { window.removeEventListener("llm-chat:offline-reconnected", reconnect); window.removeEventListener("llm-chat:offline-cleared", cleared); };
  }, []);

  /* The stored sidebar preference applies once, then the session owns it. */
  useEffect(() => {
    if (!state.settings || preferencesApplied.current) return;
    preferencesApplied.current = true;
    setSidebarCollapsed(state.settings.uiPreferences.sidebarCollapsed);
  }, [state.settings]);

  useEffect(() => {
    setNavDrawer(false);
    setInspection(null);
    if (route.name !== "chat" || !route.conversationId) setInspectorOpen(false);
  }, [route]);

  const conversation =
    route.name === "chat" && route.conversationId
      ? state.conversations.find((item) => item.id === route.conversationId) ?? null
      : null;
  const showInspector = route.name === "chat" && Boolean(conversation) && inspectorOpen;
  const leftTrack = mobile ? 0 : sidebarCollapsed ? RAIL_WIDTH : leftWidth;
  const rightTrack = mobile || !showInspector ? 0 : rightWidth;

  if (state.auth === "loading") {
    return <BootScreen error={state.bootError} onRetry={() => void bootstrap(initialConversation.current)} />;
  }
  if (state.auth === "required") return <LoginView />;

  const inspector = (
    <InspectorPanel conversation={conversation} target={inspection} onClose={() => setInspectorOpen(false)} />
  );

  return (
    <AppFrame
      left={leftTrack}
      right={rightTrack}
      sidebarCollapsed={sidebarCollapsed}
      inspectorOpen={showInspector}
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
      {!mobile && !sidebarCollapsed ? (
        <ResizeHandle
          side="left"
          position={leftTrack}
          value={leftWidth}
          min={LEFT_MIN}
          max={LEFT_MAX}
          onChange={setLeftWidth}
        />
      ) : null}

      <main className="workspace-main">
        <OfflineBanner />
        {route.name !== "chat" ? (
          <MobileAppBar
            title={routeTitle(route, state.conversations, state.agents)}
            onOpenNav={() => setNavDrawer(true)}
            onBack={parentRoute(route) ? requestMobileBack : undefined}
            onOpenInspector={null}
          />
        ) : null}
        <Suspense fallback={<LoadingState label="正在加载界面…" />}>
          <RouteView
            route={route}
            mobile={mobile}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => (mobile ? setNavDrawer(true) : setSidebarCollapsed((value) => !value))}
            inspectorOpen={showInspector}
            onToggleInspector={() => setInspectorOpen((value) => !value)}
            onInspect={(target) => {
              setInspection(target);
              setInspectorOpen(true);
            }}
          />
        </Suspense>
      </main>

      {!mobile && showInspector ? (
        <>
          <ResizeHandle
            side="right"
            position={rightWidth}
            value={rightWidth}
            min={RIGHT_MIN}
            max={RIGHT_MAX}
            onChange={setRightWidth}
          />
          {inspector}
        </>
      ) : null}

      {mobile && navDrawer ? (
        <MobileDrawer side="left" closeLabel="关闭导航" onClose={() => setNavDrawer(false)}>
          <WorkspaceSidebar
            route={route}
            onClose={() => setNavDrawer(false)}
            compact={false}
            pwa={pwa}
            onInstall={() => void promptInstall()}
          />
        </MobileDrawer>
      ) : null}
      {mobile && showInspector ? (
        <MobileDrawer side="right" closeLabel="关闭检查器" onClose={() => setInspectorOpen(false)}>
          {inspector}
        </MobileDrawer>
      ) : null}

      {mobile ? <div className="mobile-back-feedback" aria-hidden="true" data-active={backOffset > 0 || undefined}
        data-ready={backOffset >= 64 || undefined} style={{ transform: `translateX(${backOffset - 44}px)` }}><ArrowLeft size={20} /></div> : null}
      <QuickTour />
      <ToastStack toasts={state.toasts} updateAvailable={pwa.updateAvailable} onApplyUpdate={applyUpdate}
        updating={["checking", "downloading", "applying"].includes(pwa.updateStatus)} updateError={pwa.updateError} />
    </AppFrame>
  );
}

function RouteView({
  route,
  mobile,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onInspect
}: {
  route: Route;
  mobile: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onInspect: (target: InspectionTarget) => void;
}) {
  if (route.name === "agents") {
    return (
      <section className="admin-shell">
        {route.agentId ? <AgentEditorView agentId={route.agentId} /> : <AgentsView />}
      </section>
    );
  }
  if (route.name === "settings") {
    return (
      <section className="admin-shell">
        <SettingsView section={route.section} />
      </section>
    );
  }
  if (route.name === "tasks") return <LegacyTaskRedirect taskId={route.taskId} />;
  return (
    <ChatView
      key={route.conversationId ?? "new"}
      conversationId={route.conversationId}
      view={route.view}
      taskId={route.taskId}
      mobile={mobile}
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={onToggleSidebar}
      inspectorOpen={inspectorOpen}
      onToggleInspector={onToggleInspector}
      onInspect={onInspect}
      onViewChange={(view) =>
        navigate(
          view === "tasks"
            ? route.conversationId
              ? routes.conversationTasks(route.conversationId)
              : routes.chat()
            : routes.chat(route.conversationId, view)
        )
      }
    />
  );
}

/** Old `/tasks/:id` links still resolve: look the task up, then rewrite the URL. */
function LegacyTaskRedirect({ taskId }: { taskId: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    if (!taskId) {
      replaceRoute(routes.chat());
      return () => {
        active = false;
      };
    }
    setError(null);
    void endpoints
      .backgroundTask(taskId)
      .then(({ task }) => {
        if (active) replaceRoute(routes.conversationTasks(task.conversationId, task.id));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "任务加载失败");
      });
    return () => {
      active = false;
    };
  }, [taskId, attempt]);

  return error ? (
    <ErrorState message={error} onRetry={() => setAttempt((value) => value + 1)} />
  ) : (
    <LoadingState label="正在打开会话任务…" />
  );
}
