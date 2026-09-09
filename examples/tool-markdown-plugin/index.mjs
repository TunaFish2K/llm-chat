function fence(value) {
  const text = String(value);
  const marker = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${marker}text\n${text}\n${marker}`;
}

export function register(api) {
  api.registerTool({
    name: "echo",
    description: "Return the supplied text unchanged.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false
    },
    execute(input) {
      return { text: input.text, characters: Array.from(input.text).length };
    },
    formatArguments(input) {
      return { summary: `输入 ${Array.from(input.text).length} 个字符`, detail: fence(input.text) };
    },
    formatResult({ output, error }) {
      if (error) return { summary: "执行失败", detail: fence(error) };
      const result = JSON.parse(output);
      return { summary: `返回 ${result.characters} 个字符`, detail: `**返回内容**\n\n${fence(result.text)}` };
    }
  });
}
