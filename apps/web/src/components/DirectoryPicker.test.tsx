import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryListingDto } from "@llm-chat/contracts";
import { ApiRequestError, endpoints } from "../lib/api";
import { DirectoryPicker } from "./DirectoryPicker";

function listing(path: string): DirectoryListingDto {
  return { path, parentPath: path === "/" ? null : "/", entries: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function picker(initialPath: string | null = "/workspace") {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = render(<DirectoryPicker initialPath={initialPath} onSelect={onSelect} onClose={onClose} />);
  await waitFor(() => expect(screen.queryByText("读取目录…")).not.toBeInTheDocument());
  return { ...view, onSelect, onClose, user: userEvent.setup(), input: screen.getByRole("textbox", { name: "目录路径" }) };
}

describe("DirectoryPicker", () => {
  beforeEach(() => {
    vi.spyOn(endpoints, "listDirectories").mockImplementation(async (path) => listing(path ?? "/"));
    vi.spyOn(endpoints, "validatePath").mockImplementation(async (path) => ({ path }));
    vi.spyOn(endpoints, "createDirectory").mockImplementation(async (path) => ({ path }));
  });

  it("opens a typed path before selecting its canonical, validated directory", async () => {
    const { user, input, onSelect } = await picker();
    await user.clear(input);
    await user.type(input, "/中文 project /../alias");
    expect(screen.getByRole("button", { name: "使用当前目录" })).toBeDisabled();
    vi.mocked(endpoints.listDirectories).mockResolvedValueOnce(listing("/中文 project "));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input).toHaveValue("/中文 project "));
    expect(endpoints.listDirectories).toHaveBeenLastCalledWith("/中文 project /../alias");
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "使用当前目录" }));
    expect(endpoints.validatePath).toHaveBeenCalledWith("/中文 project ");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/中文 project ");
  });

  it("preserves an invalid path and the last directory, then retries the failed path", async () => {
    const { user, input } = await picker();
    vi.mocked(endpoints.listDirectories).mockRejectedValueOnce(new ApiRequestError(400, "workspace_invalid", "目录不存在，请检查路径"));
    await user.clear(input);
    await user.type(input, "/missing");
    await user.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("目录不存在");
    expect(input).toHaveValue("/missing");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("当前目录：/workspace")).toBeVisible();
    expect(screen.getByRole("button", { name: "使用当前目录" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(endpoints.listDirectories).toHaveBeenLastCalledWith("/missing");
    expect(screen.getByText("当前目录：/missing")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects empty input locally and allows correcting it", async () => {
    const { user, input } = await picker();
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("请输入目录路径");
    expect(endpoints.listDirectories).toHaveBeenCalledTimes(1);
    await user.type(input, "/fixed{Enter}");
    expect(await screen.findByText("当前目录：/fixed")).toBeVisible();
  });

  it("recovers from a missing initial directory through the root", async () => {
    vi.mocked(endpoints.listDirectories).mockRejectedValueOnce(new Error("目录不存在"));
    const { user, input } = await picker("/deleted");
    expect(input).toHaveValue("/deleted");
    await user.click(screen.getByRole("button", { name: "打开根目录" }));
    await waitFor(() => expect(input).toHaveValue("/"));
    expect(endpoints.listDirectories).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole("button", { name: /上级目录/ })).not.toBeInTheDocument();
  });

  it("keeps selection open when permission validation fails and can retry validation", async () => {
    const { user, input, onSelect } = await picker();
    vi.mocked(endpoints.validatePath).mockRejectedValueOnce(new ApiRequestError(400, "workspace_invalid", "工作目录需要读取、写入和访问权限"));
    await user.click(screen.getByRole("button", { name: "使用当前目录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("写入");
    expect(input).toHaveValue("/workspace");
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/workspace");
    expect(endpoints.validatePath).toHaveBeenCalledTimes(2);
  });

  it("does not treat network failure as an invalid path", async () => {
    const { user, input } = await picker();
    vi.mocked(endpoints.listDirectories).mockRejectedValueOnce(new ApiRequestError(0, "network_error", "网络连接失败，请重试"));
    await user.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "使用当前目录" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByRole("button", { name: "使用当前目录" })).toBeEnabled();
  });

  it("ignores out-of-order responses and responses received after another edit", async () => {
    const { user, input } = await picker();
    const slow = deferred<DirectoryListingDto>();
    const latest = deferred<DirectoryListingDto>();
    vi.mocked(endpoints.listDirectories).mockReturnValueOnce(slow.promise).mockReturnValueOnce(latest.promise);
    await user.clear(input);
    await user.type(input, "/slow{Enter}");
    expect(screen.getByRole("button", { name: "使用当前目录" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "/latest{Enter}");
    await act(async () => { latest.resolve(listing("/latest")); });
    await act(async () => { slow.resolve(listing("/slow")); });
    expect(input).toHaveValue("/latest");
    expect(screen.getByText("当前目录：/latest")).toBeVisible();

    const pending = deferred<DirectoryListingDto>();
    vi.mocked(endpoints.listDirectories).mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "打开" }));
    await user.clear(input);
    await user.type(input, "/still-typing");
    await act(async () => { pending.reject(new Error("stale failure")); });
    expect(input).toHaveValue("/still-typing");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用当前目录" })).toBeDisabled();
  });

  it("does not select after closing while validation is pending", async () => {
    const { user, onSelect, onClose } = await picker();
    const pending = deferred<{ path: string }>();
    vi.mocked(endpoints.validatePath).mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "使用当前目录" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => { pending.resolve({ path: "/workspace" }); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("updates the path when browsing or creating a directory and recovers from name conflicts", async () => {
    vi.mocked(endpoints.listDirectories).mockResolvedValueOnce({ ...listing("/workspace"), entries: [
      { name: "child", path: "/workspace/child", directory: true, hidden: false }
    ] });
    const { user, input } = await picker();
    await user.click(screen.getByRole("button", { name: /child/ }));
    expect(input).toHaveValue("/workspace/child");
    await user.click(screen.getByRole("button", { name: /上级目录/ }));
    expect(input).toHaveValue("/");
    const name = screen.getByRole("textbox", { name: "新目录名称" });
    vi.mocked(endpoints.createDirectory).mockRejectedValueOnce(new Error("该名称已存在"));
    await user.type(name, "taken");
    await user.click(screen.getByRole("button", { name: "新建目录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("该名称已存在");
    await user.clear(name);
    await user.type(name, "new");
    await user.click(screen.getByRole("button", { name: "新建目录" }));
    expect(input).toHaveValue("/new");
    expect(name).toHaveValue("");
  });

  it("does not submit Enter used to commit IME text", async () => {
    const { input } = await picker();
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true, cancelable: true })).toBe(false);
    expect(endpoints.listDirectories).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps inputs unfocused when opened and loaded (touch: %s)", async (touch) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: touch } as MediaQueryList);
    const pending = deferred<DirectoryListingDto>();
    vi.mocked(endpoints.listDirectories).mockReturnValueOnce(pending.promise);
    render(<DirectoryPicker initialPath="/workspace" onSelect={vi.fn()} onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: "关闭对话框" });
    expect(close).toHaveFocus();
    await act(async () => { pending.resolve(listing("/workspace")); });
    expect(close).toHaveFocus();
    for (const input of screen.getAllByRole("textbox")) expect(input).not.toHaveFocus();
  });
});
