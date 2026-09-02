export type InspectionTarget =
  | { kind: "generation"; messageId: string; generationId: string }
  | { kind: "tool"; messageId: string; generationId: string; toolCallId: string }
  | { kind: "task"; taskId: string };
