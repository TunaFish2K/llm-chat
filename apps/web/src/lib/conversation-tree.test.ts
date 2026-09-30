import { describe, expect, it } from "vitest";
import { makeConversation, makeMessage } from "../../test/fixtures";
import {
  conversationBranchGroups,
  greetingBranchContext,
  listConversationFamilies,
  resolveConversationRoot
} from "./conversation-tree";

const origin = (
  conversationId: string,
  messageId: string,
  mode: "edit" | "continue" | "greeting",
  greetingIndex: number | null = null,
  sourceGreetingIndex: number | null = null
) => ({ conversationId, messageId, messageOrdinal: 1, mode, greetingIndex, sourceGreetingIndex });

describe("conversation tree", () => {
  it("indexes a long chain once and rebuilds for a new list version", () => {
    const items = Array.from({ length: 2_000 }, (_, index) => makeConversation({ id: `node-${index}`, updatedAt: index,
      forkedFrom: index ? origin(`node-${index - 1}`, `message-${index}`, "edit") : null }));
    const families = listConversationFamilies(items);
    expect(families).toEqual([{ root: items[0], latestUpdatedAt: 1_999, size: 2_000 }]);
    expect(listConversationFamilies(items)).toBe(families);
    expect(resolveConversationRoot(items.at(-1)!, items)).toBe(items[0]);
    const updated = items.map(item => item.id === "node-0" ? { ...item, title: "Renamed" } : item);
    expect(listConversationFamilies(updated)[0]?.root.title).toBe("Renamed");
    expect(listConversationFamilies(updated)).not.toBe(families);
  });

  it("terminates cycles and missing parents without losing family members", () => {
    const first = makeConversation({ id: "first", forkedFrom: origin("second", "m", "edit") });
    const second = makeConversation({ id: "second", forkedFrom: origin("first", "m", "edit") });
    const orphan = makeConversation({ id: "orphan", forkedFrom: origin("missing", "m", "edit") });
    const items = [first, second, orphan];
    expect(listConversationFamilies(items).map(item => item.size).sort()).toEqual([1, 2]);
    expect(resolveConversationRoot(orphan, items)).toBe(orphan);
  });

  it("resolves roots and aggregates family recency", () => {
    const root = makeConversation({ id: "root", updatedAt: 1 });
    const child = makeConversation({ id: "child", updatedAt: 9, forkedFrom: origin("root", "message", "edit") });
    const grandchild = makeConversation({ id: "grandchild", updatedAt: 5, forkedFrom: origin("child", "message-2", "continue") });
    const other = makeConversation({ id: "other", updatedAt: 7 });

    expect(resolveConversationRoot(grandchild, [root, child, grandchild, other])).toBe(root);
    expect(listConversationFamilies([root, child, grandchild, other])).toEqual([
      { root, latestUpdatedAt: 9, size: 3 },
      { root: other, latestUpdatedAt: 7, size: 1 }
    ]);
  });

  it("builds stable message-local branch groups", () => {
    const root = makeConversation({ id: "root" });
    const first = makeConversation({ id: "first", createdAt: 2, forkedFrom: origin("root", "message", "edit") });
    const second = makeConversation({ id: "second", createdAt: 3, forkedFrom: origin("root", "message", "edit") });

    expect(conversationBranchGroups(root, [root, second, first])).toEqual([{
      id: "root:message",
      messageOrdinal: 1,
      conversationIds: ["root", "first", "second"],
      activeIndex: 0
    }]);
    expect(conversationBranchGroups(second, [root, second, first])[0]).toMatchObject({
      conversationIds: ["root", "first", "second"],
      activeIndex: 2
    });
  });

  it("flattens legacy nested greeting branches into variant routes", () => {
    const root = makeConversation({ id: "root" });
    const first = makeConversation({
      id: "first",
      forkedFrom: origin("root", "root-greeting", "greeting", 1, 0)
    });
    const nested = makeConversation({
      id: "nested",
      forkedFrom: origin("first", "first-greeting", "greeting", 2, 1)
    });
    const message = makeMessage({
      id: "nested-greeting",
      greeting: {
        variants: ["zero", "one", "two"],
        activeIndex: 2,
        agent: { agentId: "agent-1", name: "Agent", revision: 1 }
      }
    });

    const context = greetingBranchContext(nested, message, [root, first, nested]);
    expect(context?.sourceConversationId).toBe("root");
    expect(context?.sourceMessageId).toBe("root-greeting");
    expect(Object.fromEntries(context?.routesByGreetingIndex ?? [])).toEqual({
      0: "root",
      1: "first",
      2: "nested"
    });
  });
});
