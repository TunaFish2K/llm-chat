import { t, useLocale, localized } from "../lib/i18n";
import { useContext, useRef, useState, type ComponentProps } from "react";
import { Clipboard, Download, Maximize2 } from "lucide-react";
import { Popover } from "radix-ui";
import { StreamdownContext, extractTableDataFromElement, tableDataToCSV, tableDataToMarkdown, tableDataToTSV } from "streamdown";
import { useBackLayer } from "../lib/mobile-navigation";
import { Modal } from "../lib/ui";
import { toast, toastError } from "../lib/app-state";

type Format = "md" | "csv" | "tsv";
export function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  useLocale();
  const table = useRef<HTMLTableElement>(null);
  const { isAnimating } = useContext(StreamdownContext);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<"copy" | "download" | null>(null);
  useBackLayer(menu !== null, () => setMenu(null), expanded ? 40 : 20);
  const exportTable = async (format: Format, download: boolean) => {
    if (!table.current) return;
    try {
      const data = extractTableDataFromElement(table.current);
      const text = format === "csv" ? tableDataToCSV(data) : format === "tsv" ? tableDataToTSV(data) : tableDataToMarkdown(data);
      if (download) {
        const url = URL.createObjectURL(new Blob([text], { type: format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = `table.${format}`;
        document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else { await navigator.clipboard.writeText(text); toast("success", localized("MarkdownTable.table_copied")); }
      setMenu(null);
    } catch (error) { toastError(error); }
  };
  const actions = <div className="markdown-table-actions" role="group" aria-label={t("MarkdownTable.table_actions")}>
    {(["copy", "download"] as const).map((action) => <Popover.Root key={action} open={menu === action} onOpenChange={(open) => setMenu(open ? action : null)}>
      <Popover.Trigger asChild><button type="button" className="btn ghost small" disabled={isAnimating}>
        {action === "copy" ? <Clipboard size={16} /> : <Download size={16} />}{action === "copy" ? t("RichPreview.copy") : t("RichPreview.download")}
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="composer-more-popover table-format-menu" side="top" align="start" sideOffset={6}>
        {(action === "copy" ? ["md", "csv", "tsv"] as const : ["md", "csv"] as const).map((format) => <button type="button" key={format}
          onClick={() => void exportTable(format, action === "download")}>{format === "md" ? "Markdown" : format.toUpperCase()}</button>)}
      </Popover.Content></Popover.Portal>
    </Popover.Root>)}
    {!expanded ? <button type="button" className="btn ghost small" disabled={isAnimating} onClick={() => setExpanded(true)}><Maximize2 size={16} />{t("MarkdownTable.enlarge")}</button> : null}
  </div>;
  return <div className="markdown-table" data-streamdown="table-wrapper">
    <div className="markdown-table-scroll"><table {...props} ref={table}>{children}</table></div>
    {!expanded ? actions : null}
    {expanded ? <Modal title={t("MarkdownTable.table")} fullscreen onClose={() => { setExpanded(false); setMenu(null); }} footer={actions}>
      <div className="markdown markdown-table-scroll"><table {...props}>{children}</table></div>
    </Modal> : null}
  </div>;
}
