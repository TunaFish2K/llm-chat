import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";

type LanguageModule = { default: unknown };
type LanguageLoader = () => Promise<LanguageModule>;

const languageLoaders = {
  bash: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  c: () => import("react-syntax-highlighter/dist/esm/languages/prism/c"),
  clike: () => import("react-syntax-highlighter/dist/esm/languages/prism/clike"),
  clojure: () => import("react-syntax-highlighter/dist/esm/languages/prism/clojure"),
  cmake: () => import("react-syntax-highlighter/dist/esm/languages/prism/cmake"),
  cpp: () => import("react-syntax-highlighter/dist/esm/languages/prism/cpp"),
  csharp: () => import("react-syntax-highlighter/dist/esm/languages/prism/csharp"),
  css: () => import("react-syntax-highlighter/dist/esm/languages/prism/css"),
  dart: () => import("react-syntax-highlighter/dist/esm/languages/prism/dart"),
  diff: () => import("react-syntax-highlighter/dist/esm/languages/prism/diff"),
  django: () => import("react-syntax-highlighter/dist/esm/languages/prism/django"),
  docker: () => import("react-syntax-highlighter/dist/esm/languages/prism/docker"),
  elixir: () => import("react-syntax-highlighter/dist/esm/languages/prism/elixir"),
  elm: () => import("react-syntax-highlighter/dist/esm/languages/prism/elm"),
  erlang: () => import("react-syntax-highlighter/dist/esm/languages/prism/erlang"),
  fortran: () => import("react-syntax-highlighter/dist/esm/languages/prism/fortran"),
  fsharp: () => import("react-syntax-highlighter/dist/esm/languages/prism/fsharp"),
  git: () => import("react-syntax-highlighter/dist/esm/languages/prism/git"),
  glsl: () => import("react-syntax-highlighter/dist/esm/languages/prism/glsl"),
  go: () => import("react-syntax-highlighter/dist/esm/languages/prism/go"),
  gradle: () => import("react-syntax-highlighter/dist/esm/languages/prism/gradle"),
  graphql: () => import("react-syntax-highlighter/dist/esm/languages/prism/graphql"),
  groovy: () => import("react-syntax-highlighter/dist/esm/languages/prism/groovy"),
  haskell: () => import("react-syntax-highlighter/dist/esm/languages/prism/haskell"),
  hcl: () => import("react-syntax-highlighter/dist/esm/languages/prism/hcl"),
  http: () => import("react-syntax-highlighter/dist/esm/languages/prism/http"),
  ini: () => import("react-syntax-highlighter/dist/esm/languages/prism/ini"),
  java: () => import("react-syntax-highlighter/dist/esm/languages/prism/java"),
  javascript: () => import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
  json: () => import("react-syntax-highlighter/dist/esm/languages/prism/json"),
  json5: () => import("react-syntax-highlighter/dist/esm/languages/prism/json5"),
  jsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
  julia: () => import("react-syntax-highlighter/dist/esm/languages/prism/julia"),
  kotlin: () => import("react-syntax-highlighter/dist/esm/languages/prism/kotlin"),
  latex: () => import("react-syntax-highlighter/dist/esm/languages/prism/latex"),
  less: () => import("react-syntax-highlighter/dist/esm/languages/prism/less"),
  lisp: () => import("react-syntax-highlighter/dist/esm/languages/prism/lisp"),
  lua: () => import("react-syntax-highlighter/dist/esm/languages/prism/lua"),
  makefile: () => import("react-syntax-highlighter/dist/esm/languages/prism/makefile"),
  markdown: () => import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
  markup: () => import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
  matlab: () => import("react-syntax-highlighter/dist/esm/languages/prism/matlab"),
  nginx: () => import("react-syntax-highlighter/dist/esm/languages/prism/nginx"),
  objectivec: () => import("react-syntax-highlighter/dist/esm/languages/prism/objectivec"),
  ocaml: () => import("react-syntax-highlighter/dist/esm/languages/prism/ocaml"),
  pascal: () => import("react-syntax-highlighter/dist/esm/languages/prism/pascal"),
  perl: () => import("react-syntax-highlighter/dist/esm/languages/prism/perl"),
  php: () => import("react-syntax-highlighter/dist/esm/languages/prism/php"),
  plsql: () => import("react-syntax-highlighter/dist/esm/languages/prism/plsql"),
  powershell: () => import("react-syntax-highlighter/dist/esm/languages/prism/powershell"),
  protobuf: () => import("react-syntax-highlighter/dist/esm/languages/prism/protobuf"),
  python: () => import("react-syntax-highlighter/dist/esm/languages/prism/python"),
  r: () => import("react-syntax-highlighter/dist/esm/languages/prism/r"),
  regex: () => import("react-syntax-highlighter/dist/esm/languages/prism/regex"),
  ruby: () => import("react-syntax-highlighter/dist/esm/languages/prism/ruby"),
  rust: () => import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
  sass: () => import("react-syntax-highlighter/dist/esm/languages/prism/sass"),
  scala: () => import("react-syntax-highlighter/dist/esm/languages/prism/scala"),
  scheme: () => import("react-syntax-highlighter/dist/esm/languages/prism/scheme"),
  scss: () => import("react-syntax-highlighter/dist/esm/languages/prism/scss"),
  solidity: () => import("react-syntax-highlighter/dist/esm/languages/prism/solidity"),
  sql: () => import("react-syntax-highlighter/dist/esm/languages/prism/sql"),
  swift: () => import("react-syntax-highlighter/dist/esm/languages/prism/swift"),
  toml: () => import("react-syntax-highlighter/dist/esm/languages/prism/toml"),
  tsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
  typescript: () => import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
  vim: () => import("react-syntax-highlighter/dist/esm/languages/prism/vim"),
  wasm: () => import("react-syntax-highlighter/dist/esm/languages/prism/wasm"),
  yaml: () => import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
  zig: () => import("react-syntax-highlighter/dist/esm/languages/prism/zig")
} satisfies Record<string, LanguageLoader>;

export type SyntaxLanguage = keyof typeof languageLoaders;
export const syntaxLanguages = Object.keys(languageLoaders) as SyntaxLanguage[];

const aliases: Record<string, SyntaxLanguage> = {
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

const loaded = new Set<SyntaxLanguage>();
const pending = new Map<SyntaxLanguage, Promise<void>>();

export function normalizeSyntaxLanguage(infoString?: string): SyntaxLanguage | undefined {
  const language = infoString?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!language) return undefined;
  const normalized = aliases[language] ?? language;
  return Object.hasOwn(languageLoaders, normalized) ? normalized as SyntaxLanguage : undefined;
}

export function loadSyntaxLanguage(language: SyntaxLanguage): Promise<void> {
  if (loaded.has(language)) return Promise.resolve();
  const existing = pending.get(language);
  if (existing) return existing;
  const promise = languageLoaders[language]().then((module) => {
    PrismLight.registerLanguage(language, module.default);
    loaded.add(language);
    pending.delete(language);
  }).catch((error) => {
    pending.delete(language);
    throw error;
  });
  pending.set(language, promise);
  return promise;
}
