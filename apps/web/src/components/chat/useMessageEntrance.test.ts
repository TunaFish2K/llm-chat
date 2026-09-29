import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useMessageEntrance } from "./useMessageEntrance";

it("keeps history still and animates only later tail messages", () => {
  const initial = { id: "a", messages: null as Array<{ id: string; ordinal: number }> | null, following: true };
  const hook = renderHook(({ id, messages, following }) => useMessageEntrance(id, messages, following), { initialProps: initial });
  const first = { id: "first", ordinal: 1 }, next = { id: "next", ordinal: 2 };
  hook.rerender({ ...initial, messages: [first] });
  expect([...hook.result.current]).toEqual([]);
  hook.rerender({ ...initial, messages: [first, next] });
  expect([...hook.result.current]).toEqual(["next"]);
  hook.rerender({ ...initial, messages: [first, { ...next }] });
  expect([...hook.result.current]).toEqual([]);
  hook.rerender({ ...initial, messages: [{ id: "older", ordinal: 0 }, first, next] });
  expect([...hook.result.current]).toEqual([]);
  hook.rerender({ ...initial, id: "b", messages: [first, next] });
  expect([...hook.result.current]).toEqual([]);
});

it("does not replay background appends when the reader returns to the bottom", () => {
  const props = { id: "a", messages: [{ id: "one", ordinal: 1 }], following: true };
  const hook = renderHook(({ id, messages, following }) => useMessageEntrance(id, messages, following), { initialProps: props });
  const updated = { ...props, messages: [...props.messages, { id: "two", ordinal: 2 }] };
  hook.rerender({ ...updated, following: false });
  expect(hook.result.current.size).toBe(0);
  hook.rerender(updated);
  expect(hook.result.current.size).toBe(0);
});
