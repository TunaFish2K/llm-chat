import { describe, expect, it } from "vitest";
import { defaultRoleplayConfig, resolveRoleplayState } from "./roleplay";
import { executeRestrictedStscript } from "./stscript";

describe("restricted STscript", () => {
  it("changes only Agent-owned state and drafts", () => {
    const config = defaultRoleplayConfig(true);
    config.personas.push({ id: "hero", name: "Hero", description: "", avatarAssetId: null });
    const state = resolveRoleplayState(config);
    const result = executeRestrictedStscript(
      "/setvar score 4 | /incvar score | /getvar score | /input \"Score is 5\" | /persona hero | /send",
      "",
      state,
      config
    );
    expect(result.patch).toMatchObject({ variables: { score: 5 }, personaId: "hero" });
    expect(result.sendText).toBe("Score is 5");
  });

  it("rejects arbitrary or malformed commands", () => {
    const config = defaultRoleplayConfig(true);
    const state = resolveRoleplayState(config);
    expect(() => executeRestrictedStscript("/exec rm -rf x", "", state, config)).toThrow("不支持的命令");
    expect(() => executeRestrictedStscript('/echo "oops', "", state, config)).toThrow("引号没有闭合");
  });
});
