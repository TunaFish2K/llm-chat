import type { ReasoningEffort } from "@llm-chat/contracts";
import { BulbOutlined, LoadingOutlined } from "@ant-design/icons";
import { Button, Flex, Popover, Slider, Typography, type PopoverProps } from "antd";
import { useEffect, useState } from "react";

const { Text } = Typography;

export const REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

const MARKS = Object.fromEntries(REASONING_EFFORTS.map((effort, index) => [index, effort]));

interface Props {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  mobile?: boolean;
  saving?: boolean;
  placement?: PopoverProps["placement"];
}

export function ReasoningEffortControl({ value, onChange, mobile, saving, placement }: Props) {
  const [preview, setPreview] = useState(value);
  useEffect(() => setPreview(value), [value]);

  const content = <Flex vertical gap="middle" className="reasoning-popover">
    <Flex align="center" justify="space-between">
      <Text strong>推理强度</Text>
      <Text code>{preview}</Text>
    </Flex>
    <Slider
      min={0}
      max={REASONING_EFFORTS.length - 1}
      step={1}
      marks={MARKS}
      value={REASONING_EFFORTS.indexOf(preview)}
      tooltip={{ formatter: (index) => REASONING_EFFORTS[index ?? 0] }}
      onChange={(index) => setPreview(REASONING_EFFORTS[index] ?? "none")}
      onChangeComplete={(index) => onChange(REASONING_EFFORTS[index] ?? "none")}
    />
  </Flex>;

  return <Popover
    content={content}
    placement={placement ?? (mobile ? "top" : "topLeft")}
    trigger={mobile ? "click" : ["hover", "click"]}
    styles={{ content: { width: mobile ? "min(340px, calc(100vw - 24px))" : 340 } }}
  >
    <Button
      type="text"
      size="small"
      icon={saving ? <LoadingOutlined /> : <BulbOutlined />}
      aria-label={`推理强度：${value}`}
    >
      推理：{value}
    </Button>
  </Popover>;
}
