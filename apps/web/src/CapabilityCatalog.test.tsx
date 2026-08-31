import { App as AntApp, Button } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { CapabilityCatalog, type CapabilityCatalogItem } from "./CapabilityCatalog";

const item = (key: string, overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem => ({
  key,
  title: `Tool ${key}`,
  description: `Description for ${key}`,
  keywords: [`internal_${key}`],
  filterValues: { category: "local", state: "enabled" },
  details: <span>{`Details for ${key}`}</span>,
  ...overrides
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) });
});

function renderCatalog(items: CapabilityCatalogItem[], overrides: Partial<ComponentProps<typeof CapabilityCatalog>> = {}) {
  render(<AntApp><CapabilityCatalog
    ariaLabel="能力目录"
    items={items}
    searchPlaceholder="搜索能力"
    emptyLabel="没有能力"
    {...overrides}
  /></AntApp>);
}

describe("CapabilityCatalog", () => {
  it("searches all indexed fields, exposes full details, and clears an empty result", async () => {
    renderCatalog([
      item("alpha", { title: "Alpha", description: "Short summary", details: <span>Full metadata</span> }),
      item("beta", { title: "Beta" })
    ]);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索" }), { target: { value: "internal_alpha" } });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("找到 1 项，共 2 项");

    fireEvent.click(screen.getByRole("button", { name: "展开 Alpha 详情" }));
    expect(screen.getAllByText("Short summary")).toHaveLength(2);
    expect(screen.getByText("Full metadata")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起 Alpha 详情" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(screen.getByRole("textbox", { name: "搜索" }), { target: { value: "missing" } });
    expect(screen.getByText("没有符合“missing”的项目")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "清除筛选" })[0]!);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("combines filters and sorting while keeping controls visibly labelled", async () => {
    renderCatalog([
      item("z", { title: "Zulu", filterValues: { category: "web", state: "enabled" } }),
      item("a", { title: "Alpha", filterValues: { category: "web", state: "disabled" } }),
      item("m", { title: "Mike", filterValues: { category: "local", state: "enabled" } })
    ], {
      filters: [
        { key: "category", label: "类别", options: [{ label: "网页", value: "web" }, { label: "本地", value: "local" }] },
        { key: "state", label: "状态", options: [{ label: "已启用", value: "enabled" }, { label: "已停用", value: "disabled" }] }
      ],
      sorts: [
        { value: "name", label: "名称", compare: (left, right) => left.title.localeCompare(right.title) },
        { value: "category", label: "类别", compare: (left, right) => String(left.filterValues?.category).localeCompare(String(right.filterValues?.category)) }
      ]
    });

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "类别" }));
    fireEvent.click(await screen.findByText("网页", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("找到 2 项，共 3 项"));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "状态" }));
    fireEvent.click(await screen.findByText("已启用", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("找到 1 项，共 3 项"));

    expect(screen.getByText("Zulu")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("Mike")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("找到 1 项，共 3 项");
  });

  it("selects explicit rows for bulk actions and clears hidden selections when searching", () => {
    const apply = vi.fn();
    renderCatalog([item("alpha", { title: "Alpha" }), item("beta", { title: "Beta" })], {
      selectable: true,
      renderBatchActions: (keys) => <Button disabled={!keys.length} onClick={() => apply(keys)}>应用批量设置</Button>
    });

    fireEvent.click(screen.getByRole("button", { name: "批量编辑" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Alpha" }));
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "应用批量设置" }));
    expect(apply).toHaveBeenCalledWith(["alpha"]);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索" }), { target: { value: "Beta" } });
    expect(screen.getByText("已选 0 项")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用批量设置" })).toBeDisabled();
  });

  it("paginates a 500-item catalog without rendering every row", async () => {
    renderCatalog(Array.from({ length: 500 }, (_, index) => item(String(index + 1))));

    expect(screen.getByRole("status")).toHaveTextContent("共 500 项");
    expect(screen.getByText("Tool 1")).toBeInTheDocument();
    expect(screen.queryByText("Tool 51")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("10"));
    await waitFor(() => expect(screen.getByText("Tool 500")).toBeInTheDocument());
    expect(screen.queryByText("Tool 1")).not.toBeInTheDocument();
  });
});
