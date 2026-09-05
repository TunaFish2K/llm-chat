import type { ConversationDto, MessageDto } from "@llm-chat/contracts";

export interface ConversationFamily {
  root: ConversationDto;
  latestUpdatedAt: number;
  size: number;
}

export interface ConversationBranchGroup {
  id: string;
  messageOrdinal: number | null;
  conversationIds: string[];
  activeIndex: number;
}

export interface GreetingBranchContext {
  sourceConversationId: string;
  sourceMessageId: string;
  routesByGreetingIndex: ReadonlyMap<number, string>;
}

export function resolveConversationRoot(
  conversation: ConversationDto,
  conversations: readonly ConversationDto[]
): ConversationDto {
  const byId = new Map(conversations.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current = conversation;
  while (current.forkedFrom && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.forkedFrom.conversationId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

export function listConversationFamilies(conversations: readonly ConversationDto[]): ConversationFamily[] {
  const families = new Map<string, ConversationFamily>();
  for (const conversation of conversations) {
    const root = resolveConversationRoot(conversation, conversations);
    const existing = families.get(root.id);
    if (existing) {
      existing.latestUpdatedAt = Math.max(existing.latestUpdatedAt, conversation.updatedAt);
      existing.size += 1;
    } else {
      families.set(root.id, { root, latestUpdatedAt: conversation.updatedAt, size: 1 });
    }
  }
  return [...families.values()].sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
}

export function conversationBranchGroups(
  conversation: ConversationDto,
  conversations: readonly ConversationDto[]
): ConversationBranchGroup[] {
  const byId = new Map(conversations.map((item) => [item.id, item]));
  const groups = new Map<string, ConversationBranchGroup>();

  const addGroup = (
    parent: ConversationDto,
    messageId: string | null,
    messageOrdinal: number | null
  ) => {
    const children = conversations
      .filter((item) => item.forkedFrom?.conversationId === parent.id
        && item.forkedFrom.messageId === messageId
        && item.forkedFrom.mode !== "greeting")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    if (!children.length) return;
    const conversationIds = [parent.id, ...children.map((item) => item.id)];
    const activeIndex = conversationIds.indexOf(conversation.id);
    if (activeIndex < 0) return;
    groups.set(`${parent.id}:${messageId ?? "root"}`, {
      id: `${parent.id}:${messageId ?? "root"}`,
      messageOrdinal,
      conversationIds,
      activeIndex
    });
  };

  if (conversation.forkedFrom?.mode !== "greeting" && conversation.forkedFrom) {
    const parent = byId.get(conversation.forkedFrom.conversationId);
    if (parent) addGroup(parent, conversation.forkedFrom.messageId, conversation.forkedFrom.messageOrdinal);
  }

  const childForkPoints = new Map<string, { messageId: string | null; messageOrdinal: number | null }>();
  for (const child of conversations) {
    if (child.forkedFrom?.conversationId !== conversation.id || child.forkedFrom.mode === "greeting") continue;
    const key = child.forkedFrom.messageId ?? "root";
    childForkPoints.set(key, {
      messageId: child.forkedFrom.messageId,
      messageOrdinal: child.forkedFrom.messageOrdinal
    });
  }
  for (const point of childForkPoints.values()) addGroup(conversation, point.messageId, point.messageOrdinal);

  return [...groups.values()].sort((a, b) => (a.messageOrdinal ?? -1) - (b.messageOrdinal ?? -1));
}

export function greetingBranchContext(
  conversation: ConversationDto,
  message: MessageDto,
  conversations: readonly ConversationDto[]
): GreetingBranchContext | null {
  if (!message.greeting) return null;
  const byId = new Map(conversations.map((item) => [item.id, item]));
  let source = conversation;
  let firstChild: ConversationDto | null = null;
  const seen = new Set<string>();
  while (source.forkedFrom?.mode === "greeting" && !seen.has(source.id)) {
    seen.add(source.id);
    const parent = byId.get(source.forkedFrom.conversationId);
    if (!parent) break;
    firstChild = source;
    source = parent;
  }

  const sourceMessageId = firstChild?.forkedFrom?.messageId ?? message.id;
  if (!sourceMessageId) return null;
  const sourceGreetingIndex = firstChild?.forkedFrom?.sourceGreetingIndex ?? message.greeting.activeIndex;
  const routesByGreetingIndex = new Map<number, string>([[sourceGreetingIndex, source.id]]);
  const queue = [source.id];
  const visited = new Set(queue);
  const descendants: ConversationDto[] = [];
  while (queue.length) {
    const parentId = queue.shift()!;
    const children = conversations
      .filter((item) => item.forkedFrom?.conversationId === parentId && item.forkedFrom.mode === "greeting")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  for (const item of descendants) {
    const index = item.forkedFrom?.greetingIndex;
    if (index !== null && index !== undefined && !routesByGreetingIndex.has(index)) {
      routesByGreetingIndex.set(index, item.id);
    }
  }
  routesByGreetingIndex.set(message.greeting.activeIndex, conversation.id);
  return { sourceConversationId: source.id, sourceMessageId, routesByGreetingIndex };
}
