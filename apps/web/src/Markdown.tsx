import { XMarkdown } from "@ant-design/x-markdown";
import "@ant-design/x-markdown/es/XMarkdown/index.css";

export function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  return <XMarkdown content={children} openLinksInNewTab {...(streaming ? { streaming: { hasNextChunk: true } } : {})} />;
}
