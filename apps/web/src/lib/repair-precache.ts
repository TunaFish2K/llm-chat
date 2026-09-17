export interface RepairEntry {
  url: string;
  key: string;
  integrity?: string;
}

/** Download every resource before replacing the application's existing cache. */
export async function repairPrecache(cacheName: string, entries: readonly RepairEntry[], verifyRelease: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const temporaryName = `${cacheName}-repair-${crypto.randomUUID()}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  try {
    const temporary = await caches.open(temporaryName);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const entry = entries[next++]!;
        const response = await fetch(entry.url, {
          cache: "reload", credentials: "same-origin", signal: abort.signal,
          ...(entry.integrity ? { integrity: entry.integrity } : {})
        });
        if (!response.ok) throw new Error(`Resource download failed (${response.status})`);
        await temporary.put(entry.key, response);
      }
    }));
    await verifyRelease(abort.signal);
    const target = await caches.open(cacheName);
    for (const entry of entries) {
      const response = await temporary.match(entry.key);
      if (!response) throw new Error("Downloaded resource is missing");
      await target.put(entry.key, response);
    }
  } finally {
    abort.abort();
    clearTimeout(timer);
    await caches.delete(temporaryName);
  }
}
