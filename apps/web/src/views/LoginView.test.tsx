import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { appStore } from "../lib/app-state";
import { LoginView } from "./LoginView";
import { makeAgent, makeSettings } from "../../test/fixtures";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("LoginView", () => {
  it("offers OIDC without a password form in OIDC-only mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ password: false, oidc: true, oidcLabel: "统一登录", oidcLoginPath: "/api/auth/oidc/start" })));
    render(<LoginView />);
    expect(await screen.findByRole("link", { name: "统一登录" })).toHaveAttribute("href", expect.stringContaining("/api/auth/oidc/start?returnTo="));
    expect(screen.queryByLabelText("访问密码")).not.toBeInTheDocument();
  });

  it("renders a password form with an accessible label", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ password: true, oidc: false })));
    render(<LoginView />);
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(await screen.findByLabelText("访问密码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  it("submits the password and bootstraps on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/auth/methods") return Promise.resolve(jsonResponse({ password: true, oidc: false }));
      if (url === "/api/auth/login") return Promise.resolve(jsonResponse({ ok: true }));
      if (url.startsWith("/api/bootstrap")) {
        return Promise.resolve(
          jsonResponse({
            settings: makeSettings(),
            agents: [makeAgent()],
            connections: [],
            models: [],
            conversations: []
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    appStore.set({ auth: "required" });

    render(<LoginView />);
    await user.type(await screen.findByLabelText("访问密码"), "12345678");
    await user.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(appStore.get().auth).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "12345678" }) })
    );
    expect(appStore.get().agents).toHaveLength(1);
  });

  it("shows an error message when login fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/auth/methods"
        ? jsonResponse({ password: true, oidc: false })
        : jsonResponse({ error: { code: "invalid_credentials", message: "密码错误" } }, 401)))
    );
    render(<LoginView />);
    await user.type(await screen.findByLabelText("访问密码"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("密码错误");
  });
});
