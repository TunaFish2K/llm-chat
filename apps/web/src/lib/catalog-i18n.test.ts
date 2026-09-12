import { expect, it } from "vitest";
import type { SkillDto, ToolCatalogItemDto } from "@llm-chat/contracts";
import { skillDescription, skillName, toolDescription, toolLabel, toolError } from "./catalog-i18n";
import { setLocalePreference } from "./i18n";

it("localizes built-ins by ID and source without translating third-party overrides", () => {
  setLocalePreference("en-US");
  const tool = { name: "workspace_read_file", label: "读文件", description: "自定义说明", sourceKind: "builtin" } as ToolCatalogItemDto;
  expect(toolLabel(tool)).toBe("Read file");
  expect(toolError(tool)).toBeUndefined();
  expect(toolError({ ...tool, error: "原文" })).toBe("原文");
  expect(toolError({ ...tool, error: "旧文字", errorI18n: { key: "runtime.shell_closed" } })).toBe("Read-only shell is closed");
  expect(toolDescription(tool)).not.toBe("自定义说明");
  expect(toolLabel({ ...tool, sourceKind: "plugin" })).toBe("读文件");
  expect(toolDescription({ ...tool, sourceKind: "mcp" })).toBe("自定义说明");
  expect(toolLabel({ ...tool, name: "future_tool" })).toBe("读文件");
  const skill = { id: "command-execution-guide", sourceKind: "bundled", name: "我的名字", description: "我的说明" } as SkillDto;
  expect(skillName(skill)).toBe("Command Execution Guide");
  expect(skillDescription(skill)).toContain("Complete concrete tasks");
  expect(skillName({ ...skill, sourceKind: "manual" })).toBe("我的名字");
  expect(skillDescription({ ...skill, sourceKind: "agents" })).toBe("我的说明");
});
