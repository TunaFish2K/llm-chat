import { Presence } from "./lib/motion";
import { useAnimationDuration } from "./lib/animation-preferences";
import { HistoryRendering } from "./lib/history-rendering";
import { GlobalFileUploads } from "./components/FileUploads";
import { useErrorState } from "./lib/error-display";
import { t, useLocale, localized } from "./lib/i18n";
import { initOfflineHistory, isOffline } from "./lib/offline-history";
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { dismissBackLayer, parentRoute, requestMobileBack, useMobileBackGesture } from "./lib/mobile-navigation";
import { endpoints } from "./lib/api";
import { appStore, bootstrap, initAuthGate, refreshTaskCounts, startAppEvents, stopAppEvents, toast } from "./lib/app-state";
import type { InspectionTarget } from "./lib/inspection";
import { applyUpdate, getPwaState, initPwa, promptInstall, subscribePwa } from "./lib/pwa";
import { navigate, navigateAfterPaint, replaceRoute, routes, useRoute, type Route } from "./lib/router";
import { useStore } from "./lib/store";
import { useChatTypography } from "./lib/chat-typography";
import { useTheme } from "./lib/theme";
import { displayStore, useDisplayPreferences } from "./lib/local-display";
import { ErrorState, LoadingState } from "./components/ui";
import {
  AppFrame,
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
const ImageStudioView = lazy(() => import("./views/ImageStudioView").then((module) => ({ default: module.ImageStudioView })));

/** Owns shell geometry, authentication and routing. */
export function App() {
  useLocale();
  const sourceId = useStore(appStore, state => state.sourceId);
  const auth = useStore(appStore, (state) => state.auth);
  const shell = useRef({ sourceId, key: sourceId ?? "initial" });
  if (sourceId && shell.current.sourceId && sourceId !== shell.current.sourceId) shell.current.key = sourceId;
  if (sourceId) shell.current.sourceId = sourceId;
  const settings = useStore(appStore, (state) => state.settings);
  const conversations = useStore(appStore, (state) => state.conversations);
  const agents = useStore(appStore, (state) => state.agents);
  const toasts = useStore(appStore, (state) => state.toasts);
  const route = useRoute();
  const initialConversation = useRef(route.name === "chat" ? route.conversationId ?? undefined : undefined);
  const mobile = useMediaQuery("(max-width: 767px)");
  const [navDrawer, setNavDrawer] = useState(false);
  const [historyPause, setHistoryPause] = useState(0);
  const drawerExitDuration = useAnimationDuration("sidebar", "exit");
  const historyTicket = useRef(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspection, setInspection] = useState<InspectionTarget | null>(null);
  const openNav = useCallback(() => setNavDrawer(true), []);
  const navigateFromDrawer = useCallback((path: string) => {
    const ticket = ++historyTicket.current;
    navigateAfterPaint(path, () => flushSync(() => { setHistoryPause(ticket); setNavDrawer(false); }));
  }, []);
  const finishDrawerExit = () => setHistoryPause(current => current === historyPause ? 0 : current);
  useEffect(() => {
    if (!historyPause) return;
    // A cancelled presence callback must never leave a destination waiting forever.
    const timer = setTimeout(() => setHistoryPause(current => current === historyPause ? 0 : current), drawerExitDuration + 100);
    return () => clearTimeout(timer);
  }, [historyPause, drawerExitDuration]);
  const toggleSidebar = useCallback(() => mobile ? setNavDrawer(true) : setSidebarCollapsed(value => !value), [mobile]);
  const toggleInspector = useCallback(() => setInspectorOpen(value => !value), []);
  const inspect = useCallback((target: InspectionTarget) => { setInspection(target); setInspectorOpen(true); }, []);
  const back = () => {
    if (dismissBackLayer()) return;
    const parent = parentRoute(route);
    if (parent) navigate(parent);
    else setNavDrawer(true);
  };
  const backOffset = useMobileBackGesture(mobile && auth !== "required", back);
  useEffect(() => {
    if (!mobile) return;
    window.addEventListener("llm-chat:back", back);
    return () => window.removeEventListener("llm-chat:back", back);
  }, [mobile, route]);

  const [leftWidth, setLeftWidth] = useStoredNumber("llm-chat.sidebar-width", 276, LEFT_MIN, LEFT_MAX);
  const [rightWidth, setRightWidth] = useStoredNumber("llm-chat.inspector-width", 360, RIGHT_MIN, RIGHT_MAX);
  const [pwa, setPwa] = useState(getPwaState());
  const applyingUpdate = pwa.updateStatus === "applying";
  const preferencesApplied = useRef(false);
  const display = useDisplayPreferences(settings);
  const displayInitialized = useStore(displayStore, (state) => state.initialized);
  useTheme(display);
  useChatTypography(settings);

  useEffect(() => {
    const disposeAuth = initAuthGate();
    const draftWarning = () => toast("error", localized("App.cannot_save_your_draft_locally_unsent_content_may_be_lost"));
    window.addEventListener("llm-chat:draft-storage-unavailable", draftWarning);
    const unsubscribePwa = subscribePwa(setPwa);
    initPwa();
    void bootstrap(initialConversation.current);
    return () => { disposeAuth(); unsubscribePwa(); window.removeEventListener("llm-chat:draft-storage-unavailable", draftWarning); };
  }, []);

  useEffect(() => {
    // Release SSE held by workers from older releases before activating a new
    // worker. A failed update reconnects; server-side generation keeps running.
    if (auth !== "ready" || applyingUpdate) return;
    initOfflineHistory();
    startAppEvents();
    void refreshTaskCounts();
    return stopAppEvents;
  }, [auth, applyingUpdate]);

  useEffect(() => {
    const reconnect = () => void bootstrap(location.pathname.match(/^\/c\/([^/]+)/)?.[1], true).then(() => { startAppEvents(); });
    const cleared = () => { if (isOffline()) void bootstrap(); };
    window.addEventListener("llm-chat:offline-reconnected", reconnect);
    window.addEventListener("llm-chat:offline-cleared", cleared);
    return () => { window.removeEventListener("llm-chat:offline-reconnected", reconnect); window.removeEventListener("llm-chat:offline-cleared", cleared); };
  }, []);

  /* The stored sidebar preference applies once, then the session owns it. */
  useEffect(() => {
    if (!settings || !displayInitialized || preferencesApplied.current) return;
    preferencesApplied.current = true;
    setSidebarCollapsed(display.sidebarCollapsed);
  }, [settings, displayInitialized, display.sidebarCollapsed]);

  useEffect(() => {
    setNavDrawer(false);
    setInspection(null);
    if (route.name !== "chat" || !route.conversationId) setInspectorOpen(false);
  }, [route]);

  const conversation =
    route.name === "chat" && route.conversationId
      ? conversations.find((item) => item.id === route.conversationId) ?? null
      : null;
  const showInspector = route.name === "chat" && Boolean(conversation) && inspectorOpen;
  const leftTrack = mobile ? 0 : sidebarCollapsed ? RAIL_WIDTH : leftWidth;
  const rightTrack = mobile || !showInspector ? 0 : rightWidth;

  if (auth === "required") return <LoginView />;

  const inspector = (
    <InspectorPanel conversation={conversation} target={inspection} onClose={() => setInspectorOpen(false)} />
  );

  return (
    <AppFrame key={shell.current.key}
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
        {route.name !== "chat" ? (
          <MobileAppBar
            title={routeTitle(route, conversations, agents)}
            onOpenNav={openNav}
            onBack={parentRoute(route) ? requestMobileBack : undefined}
            onOpenInspector={null}
          />
        ) : null}
        <Suspense fallback={<LoadingState label={t("App.loading_the_interface")} />}>
          <HistoryRendering value={historyPause === 0}><RouteView
            route={route}
            mobile={mobile}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            inspectorOpen={showInspector}
            onToggleInspector={toggleInspector}
            onInspect={inspect}
          /></HistoryRendering>
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

      {mobile ? <Presence onExitComplete={finishDrawerExit}>{navDrawer ? (
        <MobileDrawer side="left" closeLabel={t("App.close_navigation")} onClose={() => setNavDrawer(false)}>
          <WorkspaceSidebar
            route={route}
            onClose={() => setNavDrawer(false)}
            onNavigate={navigateFromDrawer}
            compact={false}
            pwa={pwa}
            onInstall={() => void promptInstall()}
          />
        </MobileDrawer>
      ) : null}</Presence> : null}
      {mobile ? <Presence>{showInspector ? (
        <MobileDrawer side="right" closeLabel={t("App.close_inspector")} onClose={() => setInspectorOpen(false)}>
          {inspector}
        </MobileDrawer>
      ) : null}</Presence> : null}

      {mobile ? <div className="mobile-back-feedback" aria-hidden="true" data-active={backOffset > 0 || undefined}
        data-ready={backOffset >= 64 || undefined} style={{ transform: `translateX(${backOffset - 44}px)` }}><ArrowLeft size={20} /></div> : null}
      <GlobalFileUploads />
      <QuickTour />
      <ToastStack toasts={toasts} updateAvailable={pwa.updateAvailable} onApplyUpdate={applyUpdate}
        updating={["checking", "downloading", "applying", "repairing"].includes(pwa.updateStatus)} updateError={pwa.updateError} />
    </AppFrame>
  );
}

const RouteView = memo(function RouteView({
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
  useLocale();
  if (route.name === "agents") {
    return (
      <section className="admin-shell">
        {route.agentId ? <AgentEditorView key={route.agentId} agentId={route.agentId} /> : <AgentsView />}
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
  if (route.name === "images") {
    return <ImageStudioView
      key={route.sessionId ?? "new"}
      sessionId={route.sessionId}
      mobile={mobile}
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={onToggleSidebar}
    />;
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
});

/** Old `/tasks/:id` links still resolve: look the task up, then rewrite the URL. */
function LegacyTaskRedirect({ taskId }: { taskId: string | null }) {
  useLocale();
  const [error, setError] = useErrorState(null);
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
        if (active) setError(cause instanceof Error ? cause : t("App.could_not_load_the_task"));
      });
    return () => {
      active = false;
    };
  }, [taskId, attempt]);

  return error ? (
    <ErrorState message={error} onRetry={() => setAttempt((value) => value + 1)} />
  ) : (
    <LoadingState label={t("App.opening_conversation_tasks")} />
  );
}
