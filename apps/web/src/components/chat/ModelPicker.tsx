import type { ConnectionDto, ModelDto } from "@llm-chat/contracts";
import { t, useLocale } from "../../lib/i18n";
import { ModelPicker as SharedModelPicker } from "../ModelPicker";
import { INHERIT } from "./model";

/** Keep conversation inheritance separate from Agent configuration choices. */
export function ModelPicker({ effectiveModelId, explicitValue, agentModelId, models, connections, disabled, onChange }: {
  effectiveModelId: string | null;
  explicitValue: string;
  agentModelId: string | null;
  models: ModelDto[];
  connections: ConnectionDto[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  useLocale();
  return <SharedModelPicker value={effectiveModelId} models={models} connections={connections}
    appearance="icon" disabled={disabled} onChange={onChange} label={t("ModelPicker.select_model")}
    description={t("ModelPicker.agents_without_a_default_model_remember_your_selection")}
    emptyOption={{
      label: t("dialogs.follow_agent_2"),
      description: models.find(model => model.id === agentModelId)?.displayName ?? t("ModelPicker.no_model_configured_for_this_agent"),
      selected: explicitValue === INHERIT,
      onSelect: () => onChange(INHERIT)
    }} />;
}
