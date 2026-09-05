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

  it("supports the complete bounded state command set", () => {
    const config = defaultRoleplayConfig(true);
    const presetId = config.presets[0]!.id;
    config.personas.push({ id: "hero", name: "Hero", description: "", avatarAssetId: null });
    config.lorebooks.push({ id: "lore", name: "Lore", enabled: true, book: { entries: [], extensions: {} } });
    const state = {
      ...resolveRoleplayState(config),
      variables: { old: "value", remove: true },
      enabledLorebookIds: []
    };
    const result = executeRestrictedStscript([
      "# ignored comment",
      "/getvar old | /echo",
      "/getvar missing | /setvar truth true | /setvar label words here",
      "/addvar score 2 | /incvar score | /decvar score",
      "/flushvar remove | /note 'remember this' | /scenario new scene",
      `/persona hero | /preset ${presetId} | /world lore | /world lore off`,
      "/input final draft | /send explicit reply | /flushvars"
    ].join("\n"), "initial", state, config);

    expect(result).toMatchObject({
      draft: "final draft",
      sendText: "explicit reply",
      output: ["value"],
      patch: {
        variables: {}, personaId: "hero", presetId,
        enabledLorebookIds: [], authorNote: "remember this", scenarioOverride: "new scene"
      }
    });
  });

  it("uses the pipe as input and enforces command, value, and Agent ownership limits", () => {
    const config = defaultRoleplayConfig(true);
    config.lorebooks.push({ id: "lore", name: "Lore", enabled: true, book: { entries: [], extensions: {} } });
    const state = resolveRoleplayState(config);
    expect(executeRestrictedStscript("/input | /send", "draft", state, config).sendText).toBe("draft");
    expect(executeRestrictedStscript("/setvar value false", "", state, config).patch.variables?.value).toBe(false);
    expect(() => executeRestrictedStscript("/addvar value nope", "", state, config)).toThrow("需要数字");
    expect(() => executeRestrictedStscript("/send", "", state, config)).toThrow("没有可发送内容");
    expect(() => executeRestrictedStscript("/persona missing", "", state, config)).toThrow("不属于当前 Agent");
    expect(() => executeRestrictedStscript("/preset missing", "", state, config)).toThrow("不属于当前 Agent");
    expect(() => executeRestrictedStscript("/world missing", "", state, config)).toThrow("不属于当前 Agent");
    expect(() => executeRestrictedStscript("/getvar", "", state, config)).toThrow("缺少参数");
    expect(() => executeRestrictedStscript("/echo x\n".repeat(101), "", state, config)).toThrow("最多执行 100 条");
    expect(() => executeRestrictedStscript("x".repeat(500_001), "", state, config)).toThrow("脚本内容过长");
  });
});
