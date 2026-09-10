declare const __LLM_CHAT_BUILD_ID__: string;

// tsup replaces this identifier; direct source execution remains development.
export const BUILD_ID = typeof __LLM_CHAT_BUILD_ID__ === "string" ? __LLM_CHAT_BUILD_ID__ : "development";
