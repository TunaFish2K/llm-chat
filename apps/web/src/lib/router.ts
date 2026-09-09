import { useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";

export type Route =
  | { name: "chat"; conversationId: string | null; view: "chat" | "trajectory" | "tasks"; taskId: string | null }
  | { name: "agents"; agentId: string | null }
  | { name: "tasks"; taskId: string | null }
  | { name: "settings"; section: string };

function parsePath(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  if (head === "agents") return { name: "agents", agentId: parts[1] ?? null };
  if (head === "tasks") return { name: "tasks", taskId: parts[1] ?? null };
  if (head === "settings") return { name: "settings", section: parts[1] ?? "general" };
  if (head === "c") {
    const view = parts[2] === "trajectory" ? "trajectory" : parts[2] === "tasks" ? "tasks" : "chat";
    return {
      name: "chat",
      conversationId: parts[1] ?? null,
      view,
      taskId: view === "tasks" ? parts[3] ?? null : null
    };
  }
  return { name: "chat", conversationId: null, view: "chat", taskId: null };
}

export const routes = {
  chat: (conversationId?: string | null, view: "chat" | "trajectory" = "chat") =>
    conversationId ? `/c/${conversationId}${view === "trajectory" ? "/trajectory" : ""}` : "/",
  conversationTasks: (conversationId: string, taskId?: string | null) =>
    `/c/${conversationId}/tasks${taskId ? `/${taskId}` : ""}`,
  agents: (agentId?: string | null) => (agentId ? `/agents/${agentId}` : "/agents"),
  settings: (section = "general") => `/settings/${section}`
};

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

// useSyncExternalStore requires a referentially stable snapshot per location.
let cachedPathname: string | null = null;
let cachedRoute: Route = { name: "chat", conversationId: null, view: "chat", taskId: null };

function currentRoute(): Route {
  const pathname = window.location.pathname;
  if (pathname !== cachedPathname) {
    cachedPathname = pathname;
    cachedRoute = parsePath(pathname);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(
    subscribe,
    currentRoute,
    () => cachedRoute
  );
}

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  if (!window.dispatchEvent(new CustomEvent("llm-chat:before-navigate", { cancelable: true, detail: { path } }))) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function replaceRoute(path: string): void {
  if (window.location.pathname === path) return;
  window.history.replaceState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Click handler for internal links: keeps real hrefs (open-in-new-tab and
 * modified clicks keep working) while routing same-tab navigations in-app.
 */
export function linkClick(path: string): (event: ReactMouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(path);
  };
}
