import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import * as pwa from "../lib/pwa";
import { PwaInstallSettings } from "./PwaInstallSettings";

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn() }));

it("offers manual instructions instead of claiming the app is installed when no prompt is available", () => {
  render(<PwaInstallSettings />);
  expect(screen.getByRole("heading", { name: "安装PWA" })).toBeInTheDocument();
  expect(screen.getByText(/在浏览器菜单中查找/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByText("已安装", { exact: true })).not.toBeInTheDocument();
});

it.each([
  { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 1 },
  { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 }
])("provides Share instructions on iOS and iPadOS: $platform", (device) => {
  const simulated = Object.create(navigator) as Navigator;
  for (const [key, value] of Object.entries(device)) Object.defineProperty(simulated, key, { value });
  vi.stubGlobal("navigator", simulated);
  render(<PwaInstallSettings />);
  expect(screen.getByText(/点击“分享”，选择“添加到主屏幕”/)).toBeInTheDocument();
});

it("invokes the prompt only after a click and prevents duplicate submissions", async () => {
  vi.spyOn(pwa, "getPwaState").mockReturnValue({ ...pwa.getPwaState(), installAvailable: true });
  let finish!: () => void;
  const prompt = vi.spyOn(pwa, "promptInstall").mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<PwaInstallSettings />);
  expect(prompt).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "安装PWA" }));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("请在浏览器提示中完成安装或取消");
  expect(prompt).toHaveBeenCalledOnce();
  await act(async () => { finish(); });
});

it("shows installation errors and retains manual installation guidance", async () => {
  let snapshot = { ...pwa.getPwaState(), installAvailable: true };
  vi.spyOn(pwa, "getPwaState").mockImplementation(() => snapshot);
  vi.spyOn(pwa, "promptInstall").mockImplementation(async () => {
    snapshot = { ...snapshot, installAvailable: false };
    throw new Error("无法打开安装提示");
  });
  render(<PwaInstallSettings />);
  await userEvent.setup().click(screen.getByRole("button", { name: "安装PWA" }));
  expect(screen.getByRole("alert")).toHaveTextContent("无法打开安装提示");
  expect(screen.getByText(/在浏览器菜单中查找/)).toBeInTheDocument();
});

it("shows installed status without an install action", () => {
  vi.spyOn(pwa, "getPwaState").mockReturnValue({ ...pwa.getPwaState(), installed: true, installAvailable: false });
  render(<PwaInstallSettings />);
  expect(screen.getByRole("status")).toHaveTextContent("已安装");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
