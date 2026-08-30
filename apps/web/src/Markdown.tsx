import { CodeHighlighter } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { Children, type ReactNode } from "react";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { ColorScheme } from "./theme";
import "@ant-design/x-markdown/es/XMarkdown/index.css";

const aliases: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  cc: "cpp",
  cjs: "javascript",
  cs: "csharp",
  dockerfile: "docker",
  golang: "go",
  hpp: "cpp",
  html: "markup",
  js: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash"
};

const highlightedLanguages = new Set([
  "bash",
  "c",
  "clike",
  "clojure",
  "cmake",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "django",
  "docker",
  "elixir",
  "elm",
  "erlang",
  "fortran",
  "fsharp",
  "git",
  "glsl",
  "go",
  "gradle",
  "graphql",
  "groovy",
  "haskell",
  "hcl",
  "http",
  "ini",
  "java",
  "javascript",
  "json",
  "json5",
  "jsx",
  "julia",
  "kotlin",
  "latex",
  "less",
  "lisp",
  "lua",
  "makefile",
  "markdown",
  "markup",
  "matlab",
  "nginx",
  "objectivec",
  "ocaml",
  "pascal",
  "perl",
  "php",
  "plsql",
  "powershell",
  "protobuf",
  "python",
  "r",
  "regex",
  "ruby",
  "rust",
  "sass",
  "scala",
  "scheme",
  "scss",
  "solidity",
  "sql",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "vim",
  "wasm",
  "yaml",
  "zig"
]);

const markdownConfig = { extensions: Latex() };

function normalizeLanguage(infoString?: string): string | undefined {
  const language = infoString?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!language) return undefined;

  const normalized = aliases[language] ?? language;
  return highlightedLanguages.has(normalized) ? normalized : undefined;
}

function codeText(children: ReactNode): string {
  return Children.toArray(children).join("");
}

const darkHighlightProps = {
  style: oneDark,
  customStyle: { margin: 0, background: "transparent" }
};

function componentsFor(colorScheme: ColorScheme) {
  return {
    code: ({ block, children, lang }: { block?: boolean; children?: ReactNode; lang?: string }) => {
      if (!block) return <code>{children}</code>;

      const language = normalizeLanguage(lang);
      if (!language) return <code>{children}</code>;

      return colorScheme === "dark"
        ? <CodeHighlighter lang={language} highlightProps={darkHighlightProps}>{codeText(children)}</CodeHighlighter>
        : <CodeHighlighter lang={language}>{codeText(children)}</CodeHighlighter>;
    }
  };
}

const lightComponents = componentsFor("light");
const darkComponents = componentsFor("dark");

export function Markdown({ children, colorScheme, streaming = false }: { children: string; colorScheme: ColorScheme; streaming?: boolean }) {
  return (
    <XMarkdown
      components={colorScheme === "dark" ? darkComponents : lightComponents}
      config={markdownConfig}
      content={children}
      openLinksInNewTab
      {...(streaming ? { streaming: { hasNextChunk: true } } : {})}
    />
  );
}
