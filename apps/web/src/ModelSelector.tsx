import type { ConnectionDto, ModelDto, ProviderProtocol } from "@llm-chat/contracts";
import { CheckOutlined, DownOutlined, SearchOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Divider, Empty, Flex, Input, Popover, Tag, Typography, type PopoverProps } from "antd";
import { useMemo, useState } from "react";

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

export function isModelUsable(model: ModelDto | null | undefined, connections: ConnectionDto[]): boolean {
  return Boolean(model && model.enabled && connections.some((connection) => connection.id === model.connectionId));
}

export function ModelSelector({ value, models, connections, onChange, onGoSettings, placement = "topLeft" }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const eligible = useMemo(() => models.filter((model) => isModelUsable(model, connections)), [models, connections]);
  const selected = models.find((model) => model.id === value) ?? null;
  const invalid = Boolean(value) && !isModelUsable(selected, connections);
  const normalizedQuery = query.trim().toLocaleLowerCase();

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
        <Text type="secondary" className="model-group-title">{connection.name}</Text>
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
