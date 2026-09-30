import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { clearResources, useResource } from "./resource";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it("shares reads, shows cached content immediately and retains it after a refresh failure", async () => {
  const pending = deferred<string>();
  const read = vi.fn(() => pending.promise);
  const a = renderHook(() => useResource("shared", read));
  const b = renderHook(() => useResource("shared", read));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await act(async () => pending.resolve("saved"));
  expect(a.result.current.data).toBe("saved"); expect(b.result.current.data).toBe("saved");
  a.unmount(); b.unmount();
  const next = renderHook(() => useResource("shared", async () => { throw new Error("unavailable"); }));
  expect(next.result.current.data).toBe("saved");
  await waitFor(() => expect(next.result.current.error).toBe("unavailable"));
  expect(next.result.current.data).toBe("saved");
  expect(next.result.current.loading).toBe(false);
});

it("separates targets and prevents stale reads from overwriting an edit or restored session", async () => {
  const first = deferred<string>(), second = deferred<string>();
  const view = renderHook(({ id }) => useResource(id, () => id === "a" ? first.promise : second.promise), { initialProps: { id: "a" } });
  view.rerender({ id: "b" });
  await act(async () => first.resolve("wrong target"));
  expect(view.result.current.data).toBeNull();
  act(() => view.result.current.setData("edited"));
  await act(async () => second.resolve("old read"));
  expect(view.result.current.data).toBe("edited");
  act(() => view.result.current.setData(old => old + " again"));
  expect(view.result.current.data).toBe("edited again");
  act(clearResources);
  expect(view.result.current.data).toBeNull();
});

it("does not resurrect cleared data when an in-flight read finishes", async () => {
  const pending = deferred<string>();
  const view = renderHook(() => useResource("logout", () => pending.promise));
  act(clearResources);
  await act(async () => pending.resolve("private"));
  expect(view.result.current.data).toBeNull();
  expect(view.result.current.refreshing).toBe(false);
});

it("does not load disabled resources, and expires unused cached entries", async () => {
  const read = vi.fn(async () => "data");
  const disabled = renderHook(() => useResource(null, read));
  expect(read).not.toHaveBeenCalled(); disabled.unmount();
  const view = renderHook(() => useResource("expire", read));
  await waitFor(() => expect(view.result.current.data).toBe("data")); view.unmount();
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  const next = renderHook(() => useResource("expire", () => new Promise<string>(() => {})));
  expect(next.result.current.data).toBeNull();
});

it("bounds unused entries without evicting a mounted resource", async () => {
  const mounted = renderHook(() => useResource("mounted", async () => "active"));
  await waitFor(() => expect(mounted.result.current.data).toBe("active"));
  for (let i = 0; i < 55; i++) {
    const view = renderHook(() => useResource(`bounded:${i}`, async () => String(i)));
    await act(async () => { await view.result.current.reload(); }); view.unmount();
  }
  expect(mounted.result.current.data).toBe("active");
  const evicted = renderHook(() => useResource("bounded:0", () => new Promise<string>(() => {})));
  expect(evicted.result.current.data).toBeNull();
});
