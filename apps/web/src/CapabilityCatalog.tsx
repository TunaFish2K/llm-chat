import { DownOutlined, EditOutlined, SearchOutlined, UpOutlined } from "@ant-design/icons";
import { Button, Checkbox, Empty, Flex, Input, Pagination, Select, Space, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState, type ReactNode } from "react";

const { Text } = Typography;

export interface CapabilityCatalogItem {
  key: string;
  title: string;
  description?: string;
  keywords?: Array<string | null | undefined>;
  filterValues?: Record<string, string | string[] | null | undefined>;
  badges?: ReactNode;
  controls?: ReactNode;
  details?: ReactNode;
}

export interface CapabilityCatalogFilter {
  key: string;
  label: string;
  options: Array<{ label: string; value: string }>;
}

export interface CapabilityCatalogSort {
  value: string;
  label: string;
  compare: (left: CapabilityCatalogItem, right: CapabilityCatalogItem) => number;
}

interface Props {
  ariaLabel: string;
  items: CapabilityCatalogItem[];
  searchPlaceholder: string;
  emptyLabel: string;
  filters?: CapabilityCatalogFilter[];
  sorts?: CapabilityCatalogSort[];
  selectable?: boolean;
  renderBatchActions?: (selectedKeys: string[], clearSelection: () => void) => ReactNode;
}

const PAGE_SIZES = [25, 50, 100];

export function CapabilityCatalog({
  ariaLabel,
  items,
  searchPlaceholder,
  emptyLabel,
  filters = [],
  sorts = [],
  selectable = false,
  renderBatchActions
}: Props) {
  const [query, setQuery] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string | undefined>>({});
  const [sortValue, setSortValue] = useState(sorts[0]?.value ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  const clearSelection = () => setSelectedKeys(new Set());
  const resetView = () => {
    setPage(1);
    setExpandedKey(null);
    clearSelection();
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = useMemo(() => {
    const output = items.filter((item) => {
      const searchable = [item.title, item.description, ...(item.keywords ?? [])]
        .filter((value): value is string => Boolean(value))
        .join("\n")
        .toLocaleLowerCase();
      if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
      return filters.every((filter) => {
        const selected = filterValues[filter.key];
        if (!selected) return true;
        const value = item.filterValues?.[filter.key];
        return Array.isArray(value) ? value.includes(selected) : value === selected;
      });
    });
    const sort = sorts.find((item) => item.value === sortValue) ?? sorts[0];
    return sort ? [...output].sort(sort.compare) : output;
  }, [filterValues, filters, items, normalizedQuery, sortValue, sorts]);

  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleItems = filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);
  const visibleKeys = visibleItems.map((item) => item.key);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.has(key));
  const hasFilters = query.trim().length > 0 || Object.values(filterValues).some(Boolean);
  const itemKeySignature = items.map((item) => item.key).join("\u0000");
  const currentKeys = useMemo(() => new Set(items.map((item) => item.key)), [itemKeySignature]);

  useEffect(() => {
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => currentKeys.has(key)));
      return next.size === current.size ? current : next;
    });
    if (expandedKey && !currentKeys.has(expandedKey)) setExpandedKey(null);
  }, [currentKeys, expandedKey]);

  const setFilter = (key: string, value: string | undefined) => {
    setFilterValues((current) => ({ ...current, [key]: value }));
    resetView();
  };
  const clearFilters = () => {
    setQuery("");
    setFilterValues({});
    resetView();
  };
  const toggleSelected = (key: string, checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const toggleVisible = () => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of visibleKeys) {
        if (allVisibleSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  };
  const leaveBatchMode = () => {
    setBatchMode(false);
    clearSelection();
  };

  return <section className="capability-catalog" aria-label={ariaLabel}>
    <Flex className="capability-toolbar" vertical gap="small">
      <Flex className="capability-toolbar-primary" gap="small" align="flex-end" wrap>
        <div className="capability-search-field">
          <Text type="secondary">搜索</Text>
          <Input
            aria-label="搜索"
            allowClear
            prefix={<SearchOutlined aria-hidden="true" />}
            value={query}
            placeholder={searchPlaceholder}
            onChange={(event) => {
              setQuery(event.target.value);
              resetView();
            }}
          />
        </div>
        {filters.map((filter) => <div className="capability-filter-field" key={filter.key}>
          <Text type="secondary">{filter.label}</Text>
          <Select
            aria-label={filter.label}
            allowClear
            value={filterValues[filter.key]}
            placeholder="全部"
            options={filter.options}
            onChange={(value) => setFilter(filter.key, value)}
          />
        </div>)}
        {sorts.length > 1 && <div className="capability-filter-field">
          <Text type="secondary">排序</Text>
          <Select aria-label="排序" value={sortValue} options={sorts.map(({ value, label }) => ({ value, label }))} onChange={(value) => {
            setSortValue(value);
            resetView();
          }} />
        </div>}
        {selectable && <Button
          icon={<EditOutlined aria-hidden="true" />}
          aria-label={batchMode ? "结束批量编辑" : "批量编辑"}
          aria-pressed={batchMode}
          onClick={() => {
          if (batchMode) leaveBatchMode();
          else setBatchMode(true);
        }}>{batchMode ? "结束批量编辑" : "批量编辑"}</Button>}
      </Flex>
      <Flex className="capability-result-line" align="center" justify="space-between" gap="small" wrap>
        <Text type="secondary" role="status" aria-live="polite" className="capability-result-count">
          {filteredItems.length === items.length ? `共 ${items.length} 项` : `找到 ${filteredItems.length} 项，共 ${items.length} 项`}
        </Text>
        {hasFilters && <Button type="link" size="small" onClick={clearFilters}>清除筛选</Button>}
      </Flex>
    </Flex>

    {batchMode && <Flex className="capability-batch-bar" align="center" gap="small" wrap>
      <Button onClick={toggleVisible}>{allVisibleSelected ? "取消本页选择" : "全选本页"}</Button>
      <Text className="capability-selected-count">已选 {selectedKeys.size} 项</Text>
      {renderBatchActions?.([...selectedKeys], clearSelection)}
    </Flex>}

    {visibleItems.length ? <div className="capability-list">
      {visibleItems.map((item) => {
        const expanded = expandedKey === item.key;
        const detailId = `capability-detail-${safeId(item.key)}`;
        return <article className="capability-row" key={item.key}>
          <div className="capability-row-summary">
            {batchMode && <Checkbox
              className="capability-row-selector"
              aria-label={`选择 ${item.title}`}
              checked={selectedKeys.has(item.key)}
              onChange={(event) => toggleSelected(item.key, event.target.checked)}
            />}
            <div className="capability-row-copy">
              <Space className="capability-row-title" size={6} wrap>
                <Text strong>{item.title}</Text>
                {item.badges}
              </Space>
              {item.description && <Text className="capability-row-description" type="secondary">{item.description}</Text>}
            </div>
            {item.controls && <Flex className="capability-row-controls" align="center" gap="small" wrap>{item.controls}</Flex>}
            <Tooltip title={expanded ? "收起详情" : "展开详情"}>
              <Button
                className="capability-expand-button"
                type="text"
                icon={expanded ? <UpOutlined /> : <DownOutlined />}
                aria-label={`${expanded ? "收起" : "展开"} ${item.title} 详情`}
                aria-expanded={expanded}
                aria-controls={detailId}
                onClick={() => setExpandedKey(expanded ? null : item.key)}
              />
            </Tooltip>
          </div>
          {expanded && <div className="capability-row-details" id={detailId}>
            {item.description && <Text className="capability-full-description">{item.description}</Text>}
            {item.details}
          </div>}
        </article>;
      })}
    </div> : <Empty
      className="capability-empty"
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={<Flex vertical gap={4} align="center">
        <Text>{hasFilters ? `没有符合“${query.trim() || "当前筛选条件"}”的项目` : emptyLabel}</Text>
        {hasFilters && <Button type="link" onClick={clearFilters}>清除筛选</Button>}
      </Flex>}
    />}

    {filteredItems.length > 50 && <Pagination
      className="capability-pagination"
      current={safePage}
      pageSize={pageSize}
      total={filteredItems.length}
      pageSizeOptions={PAGE_SIZES}
      showSizeChanger
      responsive
      onChange={(nextPage, nextPageSize) => {
        setPage(nextPageSize === pageSize ? nextPage : 1);
        setPageSize(nextPageSize);
        setExpandedKey(null);
      }}
    />}
  </section>;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
