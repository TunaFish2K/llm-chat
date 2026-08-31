import type { ConnectionDto, ModelDto, ProviderProtocol } from "@llm-chat/contracts";
import { CheckOutlined, DownOutlined, LoadingOutlined, SearchOutlined, SettingOutlined, WalletOutlined, WarningOutlined } from "@ant-design/icons";
import { Button, Divider, Empty, Flex, Input, Popover, Tag, Tooltip, Typography, type PopoverProps } from "antd";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

const { Text } = Typography;

export function protocolShortName(protocol: ProviderProtocol): string {
  return protocol === "openai-responses" ? "Responses" : protocol === "openai-chat" ? "Chat" : "Anthropic";
}

interface Props {
  value: string | null;
  models: ModelDto[];
  connections: ConnectionDto[];
  onChange: (modelId: string) => void;
  onGoSettings: () => void;
  placement?: PopoverProps["placement"];
}

type BalanceState =
  | { status: "loading" }
  | { status: "success"; value: number }
  | { status: "error"; message: string };

const balanceFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

function balanceErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "余额获取失败";
}

function BalanceIndicator({ state }: { state: BalanceState | undefined }) {
  if (!state) return null;
  if (state.status === "loading") return <LoadingOutlined spin aria-label="正在加载账户余额" title="正在加载账户余额" />;
  if (state.status === "error") return <Tooltip title={state.message}>
    <WarningOutlined aria-label="账户余额获取失败" title="账户余额获取失败" />
  </Tooltip>;
  const formatted = balanceFormatter.format(state.value);
  return <span className="model-group-balance" aria-label={`账户余额 ${formatted}`} title="账户余额">
    <WalletOutlined />
    <span>{formatted}</span>
  </span>;
}

export function isModelUsable(model: ModelDto | null | undefined, connections: ConnectionDto[]): boolean {
  return Boolean(model && model.enabled && connections.some((connection) => connection.id === model.connectionId));
}

export function ModelSelector({ value, models, connections, onChange, onGoSettings, placement = "topLeft" }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const eligible = useMemo(() => models.filter((model) => isModelUsable(model, connections)), [models, connections]);
  const selected = models.find((model) => model.id === value) ?? null;
  const invalid = Boolean(value) && !isModelUsable(selected, connections);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const balanceTargets = useMemo(() => connections.filter((connection) =>
    connection.balanceConfig?.enabled && eligible.some((model) => model.connectionId === connection.id)
  ), [connections, eligible]);
  const balanceSignature = balanceTargets.map((connection) => [
    connection.id,
    connection.baseUrl,
    connection.updatedAt,
    connection.balanceConfig?.enabled,
    connection.balanceConfig?.apiPath,
    connection.balanceConfig?.resultExpression
  ].join("\u0000")).join("\u0001");

  useEffect(() => {
    if (!open) return;
    let active = true;
    const targetIds = new Set(balanceTargets.map((connection) => connection.id));
    setBalances(Object.fromEntries(balanceTargets.map((connection) => [connection.id, { status: "loading" } satisfies BalanceState])));
    for (const connection of balanceTargets) {
      void api.connectionBalance(connection.id).then((result) => {
        if (!active || !targetIds.has(result.connectionId)) return;
        setBalances((current) => ({ ...current, [connection.id]: { status: "success", value: result.value } }));
      }).catch((error: unknown) => {
        if (!active) return;
        setBalances((current) => ({ ...current, [connection.id]: { status: "error", message: balanceErrorMessage(error) } }));
      });
    }
    return () => { active = false; };
  }, [open, balanceSignature]);

  const groups = connections.map((connection) => ({
    connection,
    models: eligible.filter((model) => model.connectionId === connection.id && [
      model.displayName,
      model.modelKey,
      connection.name,
      connection.protocol
    ].join(" ").toLocaleLowerCase().includes(normalizedQuery))
  })).filter((group) => group.models.length);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const content = <Flex vertical gap="small" className="model-popover">
    <Input
      allowClear
      autoFocus
      prefix={<SearchOutlined />}
      placeholder="搜索模型、连接或协议"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
    <div className="model-popover-list">
      {groups.length ? groups.map(({ connection, models: groupModels }) => <Flex vertical gap={4} key={connection.id}>
        <Flex align="center" justify="space-between" gap="small" className="model-group-title">
          <Text type="secondary" ellipsis>{connection.name}</Text>
          {connection.balanceConfig?.enabled ? <BalanceIndicator state={balances[connection.id]} /> : null}
        </Flex>
        {groupModels.map((model) => <Button
          key={model.id}
          type="text"
          block
          className="model-option-button"
          onClick={() => choose(model.id)}
        >
          <Flex align="center" justify="space-between" gap="small">
            <Flex vertical align="flex-start" className="model-option-copy">
              <Text ellipsis>{model.displayName}</Text>
              <Text type="secondary" ellipsis>{model.modelKey}</Text>
            </Flex>
            <Flex align="center" gap={4}>
              <Tag>{protocolShortName(connection.protocol)}</Tag>
              {model.id === value ? <CheckOutlined /> : null}
            </Flex>
          </Flex>
        </Button>)}
      </Flex>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模型" />}
    </div>
    <Divider />
    <Button type="text" block icon={<SettingOutlined />} onClick={() => { setOpen(false); onGoSettings(); }}>
      管理模型
    </Button>
  </Flex>;

  return <Popover
    open={open}
    onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}
    content={content}
    placement={placement}
    trigger="click"
    arrow={false}
    styles={{ content: { width: "min(380px, calc(100vw - 24px))" } }}
  >
    <Button
      type="text"
      size="small"
      danger={invalid}
      className="model-trigger"
      aria-label="选择模型"
    >
      <Text ellipsis {...(invalid ? { type: "danger" as const } : {})} className="model-trigger-label">
        {selected?.displayName ?? (eligible.length ? "选择模型" : "暂无模型")}
      </Text>
      <DownOutlined />
    </Button>
  </Popover>;
}
