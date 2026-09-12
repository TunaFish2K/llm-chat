import { displayError } from "./error-display";
import type { SkillDto, ToolCatalogItemDto } from "@llm-chat/contracts";
import { resources, type MessageKey } from "@llm-chat/i18n";
import { t } from "./i18n";
function known(key: string, fallback: string): string {
  return Object.hasOwn(resources["zh-CN"].translation, key) ? t(key as MessageKey) : fallback;
}
export function toolLabel(tool: ToolCatalogItemDto): string {
  return tool.sourceKind === "builtin" ? known(`catalog.${tool.name}.label`, tool.label) : tool.label;
}
export function toolDescription(tool: ToolCatalogItemDto): string {
  return tool.sourceKind === "builtin" ? known(`catalog.${tool.name}.description`, tool.description) : tool.description;
}
export function skillName(skill: SkillDto): string {
  return skill.sourceKind === "bundled" ? known(`skill.${skill.id}.name`, skill.name) : skill.name;
}
export function skillDescription(skill: SkillDto): string {
  return skill.sourceKind === "bundled" ? known(`skill.${skill.id}.description`, skill.description) : skill.description;
}

export function toolError(tool: ToolCatalogItemDto): string | undefined { return tool.error ? displayError({ message: tool.error, ...(tool.errorI18n ? { i18n: tool.errorI18n } : {}) }) : undefined; }
