const queues = new Map<string, Promise<unknown>>();
let epoch = 0;

export function clearMutationQueues() { epoch++; queues.clear(); }

/** Preserve command order for a resource, including after a rejected write. */
export function serializeMutation<T>(key: string, write: () => Promise<T>): Promise<T> {
  const session = epoch;
  const request = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => {
    if (session !== epoch) throw new Error("Session changed");
    return write();
  }).finally(() => { if (queues.get(key) === request) queues.delete(key); });
  queues.set(key, request);
  return request;
}
