import { afterEach, describe, expect, it } from "vitest";
import { exportCharacterCard, importCharacterCard } from "./character-card";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

describe("Character Card V2 import and export", () => {
  afterEach(cleanupStores);

  it("preserves extensions, creates duplicate copies, and round-trips PNG metadata", () => {
    const store = createStore();
    const card = {
      spec: "chara_card_v2", spec_version: "2.0", data: {
        name: "Mira", description: "Archivist", personality: "", scenario: "", first_mes: "Hello",
        mes_example: "", creator_notes: "", system_prompt: "{{original}}", post_history_instructions: "",
        alternate_greetings: [], tags: [], creator: "", character_version: "", extensions: { vendor: { keep: true } }
      }
    };
    const first = importCharacterCard(store, "mira.json", Buffer.from(JSON.stringify(card)));
    const second = importCharacterCard(store, "mira.json", Buffer.from(JSON.stringify(card)));
    expect(first.name).toBe("Mira");
    expect(second.name).toBe("Mira (2)");

    const exported = exportCharacterCard(store, first, "json");
    const parsed = JSON.parse(Buffer.from(exported.bytes).toString("utf8"));
    expect(parsed.data.extensions.vendor).toEqual({ keep: true });
    expect(parsed.data.extensions.llm_chat).toMatchObject({ version: 1, execution: { model: null } });
    expect(JSON.stringify(parsed.data.extensions.llm_chat)).not.toContain("apiKey");

    store.setAgentAvatar(first.id, ONE_PIXEL_PNG);
    const png = exportCharacterCard(store, first, "png");
    const importedPng = importCharacterCard(store, "mira.png", png.bytes);
    expect(importedPng.name).toBe("Mira (3)");
    expect(importedPng.hasAvatar).toBe(true);
    expect(importedPng.card.data.extensions.vendor).toEqual({ keep: true });
  });

  it("rejects oversized and invalid JSON cards and accepts the legacy data shape", () => {
    const store = createStore();
    expect(() => importCharacterCard(store, "huge.json", new Uint8Array(10 * 1024 * 1024 + 1)))
      .toThrow("角色卡不能超过 10 MiB");
    expect(() => importCharacterCard(store, "bad.json", Buffer.from("{bad")))
      .toThrow("角色卡 JSON 无法解析");

    const legacy = importCharacterCard(store, "legacy.json", Buffer.from(JSON.stringify(cardData("Legacy"))));
    expect(legacy.card).toMatchObject({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Legacy" } });
  });

  it("maps portable model references and falls back when the reference is unavailable", () => {
    const store = createStore();
    const { connection, model } = seedModel(store);
    const defaultAgent = store.getAgent(store.getSettings().defaultAgentId)!;
    const { modelId: _modelId, ...portableExecution } = defaultAgent.execution;
    const portable = {
      version: 1,
      execution: {
        ...portableExecution,
        model: { protocol: connection.protocol, modelKey: model.modelKey, connectionName: connection.name }
      },
      userProfile: { displayName: "Portable user" }
    };
    const matching = card("Portable", { llm_chat: portable });
    const imported = importCharacterCard(store, "portable.json", Buffer.from(JSON.stringify(matching)));
    expect(imported.execution.modelId).toBe(model.id);
    expect(imported.userProfile).toEqual({ displayName: "Portable user" });

    portable.execution.model = { ...portable.execution.model, connectionName: "Missing" };
    const unmatched = importCharacterCard(store, "unmatched.json", Buffer.from(JSON.stringify(matching)));
    expect(unmatched.execution.modelId).toBeNull();

    const invalidExtension = card("Defaulted", { llm_chat: { version: 2, execution: portableExecution } });
    const defaulted = importCharacterCard(store, "defaulted.json", Buffer.from(JSON.stringify(invalidExtension)));
    expect(defaulted.execution).toEqual(defaultAgent.execution);
    expect(defaulted.userProfile).toEqual({});
  });

  it("requires a valid PNG avatar for PNG export", () => {
    const store = createStore();
    const agent = importCharacterCard(store, "avatar.json", Buffer.from(JSON.stringify(card("Avatar"))));
    expect(() => exportCharacterCard(store, agent, "png")).toThrow("PNG 导出需要先设置 PNG 头像");
    store.setAgentAvatar(agent.id, Buffer.from("not a png"));
    expect(() => exportCharacterCard(store, store.getAgent(agent.id)!, "png")).toThrow("PNG 导出需要先设置 PNG 头像");

    const detached = { ...agent, name: "", execution: { ...agent.execution, modelId: "missing-model" } };
    const json = exportCharacterCard(store, detached, "json");
    expect(json.fileName).toBe("character.json");
    expect(JSON.parse(Buffer.from(json.bytes).toString("utf8")).data.extensions.llm_chat.execution.model).toBeNull();
  });

  it("rejects truncated, corrupt, metadata-free, and invalid-metadata PNG cards", () => {
    const store = createStore();
    expect(() => importCharacterCard(store, "truncated.png", ONE_PIXEL_PNG.subarray(0, 8)))
      .toThrow("PNG 缺少 IEND 数据块");
    const corrupt = Buffer.from(ONE_PIXEL_PNG);
    corrupt.writeUInt32BE(0xffffffff, 8);
    expect(() => importCharacterCard(store, "corrupt.png", corrupt)).toThrow("PNG 数据块损坏");
    expect(() => importCharacterCard(store, "plain.png", ONE_PIXEL_PNG)).toThrow("PNG 中没有 chara 角色卡数据");

    const agent = importCharacterCard(store, "source.json", Buffer.from(JSON.stringify(card("Metadata"))));
    store.setAgentAvatar(agent.id, ONE_PIXEL_PNG);
    const embedded = Buffer.from(exportCharacterCard(store, agent, "png").bytes);
    const marker = embedded.indexOf(Buffer.from("chara\0", "latin1"));
    expect(marker).toBeGreaterThan(0);
    embedded.fill("!".charCodeAt(0), marker + 6, marker + 14);
    expect(() => importCharacterCard(store, "invalid-metadata.png", embedded))
      .toThrow("PNG 中的角色卡数据无法解析");

    const foreignText = Buffer.from(exportCharacterCard(store, agent, "png").bytes);
    const foreignMarker = foreignText.indexOf(Buffer.from("chara\0", "latin1"));
    foreignText.write("other", foreignMarker, "latin1");
    expect(() => importCharacterCard(store, "foreign-text.png", foreignText))
      .toThrow("PNG 中没有 chara 角色卡数据");
    const noSeparator = Buffer.from(exportCharacterCard(store, agent, "png").bytes);
    const separator = noSeparator.indexOf(Buffer.from("chara\0", "latin1")) + 5;
    noSeparator[separator] = "x".charCodeAt(0);
    expect(() => importCharacterCard(store, "no-separator.png", noSeparator))
      .toThrow("PNG 中没有 chara 角色卡数据");
  });
});

function card(name: string, extensions: Record<string, unknown> = {}) {
  return { spec: "chara_card_v2", spec_version: "2.0", data: cardData(name, extensions) };
}

function cardData(name: string, extensions: Record<string, unknown> = {}) {
  return {
    name, description: "", personality: "", scenario: "", first_mes: "Hello", mes_example: "",
    creator_notes: "", system_prompt: "{{original}}", post_history_instructions: "", alternate_greetings: [],
    tags: [], creator: "", character_version: "", extensions
  };
}
