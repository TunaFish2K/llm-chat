import { createStore } from "./store";
export const resourceSaveStore = createStore<Record<string, "saving" | "saved" | "error">>({});
/** Confirmed values and pending edits have separate lifetimes. */
interface Resource<T> { base: T; edits: Array<{ id: symbol; apply: (value: T) => T }>; tail: Promise<unknown> }
const resources = new Map<string, Resource<unknown>>();
const project = <T>(state: Resource<T>) => state.edits.reduce((value, edit) => edit.apply(value), state.base);
export function overlayResource<T>(key: string, incoming: T): T {
  const state = resources.get(key) as Resource<T> | undefined;
  return state ? state.edits.reduce((value, edit) => edit.apply(value), incoming) : incoming;
}
export function optimisticWrite<T>(key: string, initial: T, apply: (value: T) => T,
  write: (value: T) => void, commit: () => Promise<T>): Promise<T> {
  const state = (resources.get(key) as Resource<T> | undefined) ?? { base: initial, edits: [], tail: Promise.resolve() };
  resources.set(key, state as Resource<unknown>);
  const id = Symbol(key);
  state.edits.push({ id, apply });
  resourceSaveStore.set({ [key]: "saving" });
  write(project(state));
  const work = state.tail.catch(() => undefined).then(() => {
    if (resources.get(key) !== state) throw new Error("登录或服务实例已变更，请重新操作");
    return commit();
  }).then((saved) => { state.base = saved; return saved; });
  let failed = false;
  const finish = work.catch((error) => { failed = true; throw error; }).finally(() => {
    state.edits = state.edits.filter((edit) => edit.id !== id);
    if (resources.get(key) !== state) return;
    write(project(state));
    resourceSaveStore.set({ [key]: state.edits.length ? "saving" : failed ? "error" : "saved" });
    if (!state.edits.length) resources.delete(key);
  });
  state.tail = finish;
  return finish;
}

window.addEventListener("llm-chat:submissions-clear", () => { resources.clear(); });
