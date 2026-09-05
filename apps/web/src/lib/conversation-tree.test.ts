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
