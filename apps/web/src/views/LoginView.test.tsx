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
  it("renders a password form with an accessible label", () => {
    render(<LoginView />);
    expect(screen.getByLabelText("访问密码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  it("submits the password and bootstraps on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
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
    await user.type(screen.getByLabelText("访问密码"), "12345678");
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
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "invalid_credentials", message: "密码错误" } }, 401)
      )
    );
    render(<LoginView />);
    await user.type(screen.getByLabelText("访问密码"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("密码错误");
  });
});
