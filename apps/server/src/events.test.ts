import { describe, expect, it, vi } from "vitest";
import { EventHub } from "./events";

describe("EventHub", () => {
  it("replays only newer events and stops delivery after unsubscribe", () => {
    const hub = new EventHub();
    hub.emit({ type: "plugin", pluginId: "old", state: "loaded" });
    const second = hub.emit({ type: "skill", skillId: "new", state: "pending-reload" });
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(1, listener);
    expect(listener).toHaveBeenCalledWith(second);
    hub.emit({ type: "plugin", pluginId: "live", state: "error", message: "failed" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(unsubscribe()).toBe(true);
    hub.emit({ type: "plugin", pluginId: "ignored", state: "loaded" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("retains only the latest thousand events", () => {
    const hub = new EventHub();
    for (let index = 0; index < 1_005; index += 1) {
      hub.emit({ type: "plugin", pluginId: String(index), state: "loaded" });
    }
    const listener = vi.fn();
    hub.subscribe(0, listener);
    expect(listener).toHaveBeenCalledTimes(1_000);
    expect(listener.mock.calls[0]![0]).toMatchObject({ id: 6, pluginId: "5" });
  });
});
