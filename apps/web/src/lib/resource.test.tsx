import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { clearResources, invalidateResources, useResource } from "./resource";

it("shares the initial request, then re-reads after a notification during that request", async () => {
  let finish!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const first = renderHook(() => useResource("shared", read));
  const second = renderHook(() => useResource("shared", read));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  let refresh!: Promise<void>;
  act(() => { refresh = second.result.current.reload(); });
  read.mockImplementationOnce(async () => "newer");
  await act(async () => { finish("stale"); await refresh; });
  expect(read).toHaveBeenCalledTimes(2);
  expect(first.result.current.data).toBe("newer");
  expect(second.result.current.data).toBe("newer");
});

it("keeps cached content on a failed refresh and fences a response before a local edit", async () => {
  const read = vi.fn(async () => "cached");
  const resource = renderHook(() => useResource("editable", read));
  await waitFor(() => expect(resource.result.current.data).toBe("cached"));
  read.mockRejectedValueOnce(new Error("network failed"));
  await act(async () => { await resource.result.current.reload(); });
  expect(resource.result.current.data).toBe("cached");
  expect(resource.result.current.error).toBe("network failed");
  let finish!: (value: string) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let loading!: Promise<void>;
  act(() => { loading = resource.result.current.reload(); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => resource.result.current.setData("edited"));
  await act(async () => { finish("old"); await loading; });
  expect(resource.result.current.data).toBe("edited");
  act(() => invalidateResources(key => key === "editable"));
  expect(resource.result.current.data).toBeNull();
});

it("ignores late reads across an authentication boundary", async () => {
  let finish!: (value: string) => void;
  const resource = renderHook(() => useResource("session", () => new Promise<string>(resolve => { finish = resolve; })));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => clearResources());
  await act(async () => { finish("old session"); });
  expect(resource.result.current.data).toBeNull();
});
