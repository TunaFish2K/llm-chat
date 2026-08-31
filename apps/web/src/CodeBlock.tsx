import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useEffect, useState } from "react";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import prism from "react-syntax-highlighter/dist/esm/styles/prism/prism";
import { loadSyntaxLanguage, type SyntaxLanguage } from "./syntaxLanguages";
import type { ColorScheme } from "./theme";

export function CodeBlock({ language, source, colorScheme }: {
  language: SyntaxLanguage;
  source: string;
  colorScheme: ColorScheme;
}) {
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setReady(false);
    void loadSyntaxLanguage(language).then(() => { if (active) setReady(true); }).catch(() => {});
    return () => { active = false; };
  }, [language]);

  const copy = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return <div className="ant-codeHighlighter code-block">
    <div className="code-block-header">
      <span>{language}</span>
      <Tooltip title={copied ? "已复制" : "复制代码"}>
        <Button
          type="text"
          size="small"
          aria-label="复制代码"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={() => void copy()}
        />
      </Tooltip>
    </div>
    <div className="ant-codeHighlighter-code code-block-body">
      {ready ? <PrismLight
        language={language}
        style={colorScheme === "dark" ? oneDark : prism}
        customStyle={{ margin: 0, background: "transparent" }}
      >{source}</PrismLight> : <pre><code>{source}</code></pre>}
    </div>
  </div>;
}
