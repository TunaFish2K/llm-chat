import { afterEach, describe, expect, it } from "vitest";
import { exportCharacterCard, importCharacterCard } from "./character-card";
import { cleanupStores, createStore } from "./test-helpers";

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
});
