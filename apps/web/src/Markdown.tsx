import { XMarkdown } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { Children, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { normalizeSyntaxLanguage } from "./syntaxLanguages";
import type { ColorScheme } from "./theme";
import "@ant-design/x-markdown/es/XMarkdown/index.css";

const markdownConfig = { extensions: Latex() };

function codeText(children: ReactNode): string {
  return Children.toArray(children).join("");
}

function componentsFor(colorScheme: ColorScheme) {
  return {
    pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
    code: ({ block, children, lang }: { block?: boolean; children?: ReactNode; lang?: string }) => {
      if (!block) return <code>{children}</code>;

      const language = normalizeSyntaxLanguage(lang);
      if (!language) return <pre><code>{children}</code></pre>;
      return <CodeBlock language={language} source={codeText(children)} colorScheme={colorScheme} />;
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
