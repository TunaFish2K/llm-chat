# 工具的 Markdown 展示

工具可以为参数和结果分别提供缩略与详细 Markdown。缩略出现在折叠工具栏中，与工具名同行；详细内容出现在展开区和工具检查器中。原始数据始终可以查看、复制，并继续用于模型上下文。

内置工具默认支持。旧内置调用根据已保存的参数和结果生成展示，不重新执行工具。插件需要自行添加下面的回调；未接入的插件、旧插件调用和 MCP 工具保留原始 JSON／文本视图。

## 插件接口

在 `api.registerTool` 中增加任意一个或两个回调。`execute` 的参数、返回值和审批机制不变。

```ts
type ToolMarkdown = { summary?: string; detail?: string };

formatArguments?(input: Record<string, unknown>): ToolMarkdown | Promise<ToolMarkdown>;
formatResult?(result: {
  input: Record<string, unknown>;
  output: string | null;
  error: string | null;
}): ToolMarkdown | Promise<ToolMarkdown>;
```

- `formatArguments` 接收完整、校验后的参数，在审批或执行前调用。
- `formatResult` 接收原始参数、持久化结果字符串和错误。结果可能已经过现有的大输出截断处理；解析失败时可抛错，界面会回退到原始数据。
- 只提供 `summary` 时，详情使用原始数据；只提供 `detail` 时，折叠栏不额外显示该部分摘要。空内容同样回退。
- 摘要只渲染行内内容；换行合并显示，不展示图片、表格和代码块控件。详情使用应用现有的 Markdown 内容清理、链接和图片处理。
- 回调必须是快速、无副作用的数据转换，不应读写文件、访问网络或再次执行工具。它们在固定 Plugin Revision 的服务端子进程中运行，不在浏览器中运行。
- 每次格式化最多等待 1 秒。异常、无效返回或超时不会触发执行重试，也不会改写工具的执行状态。摘要限制为 512 个字符，详情限制为 64 KiB；超出时标注截断。

格式化不是隔离不可信插件的沙箱。与 `execute` 一样，插件代码应受信任；同步阻塞子进程的回调仍会影响该插件的其他请求。

完整示例位于 [examples/tool-markdown-plugin](../examples/tool-markdown-plugin)。将该目录作为普通 llm-chat 工具插件安装即可，不需要前端代码。

## 历史记录与兼容

新调用将 Markdown 保存到工具记录的 `presentation.arguments` 和 `presentation.result`。查看历史时直接读取快照，不启动插件；更新或卸载插件不改变已有快照。会话分叉复制快照，流式工具事件也携带同一份展示数据。

数据库版本从 36 升至 37，为工具调用增加可空的 `presentation_json`。旧记录无需回填；旧内置调用读取时采用内置纯格式化函数。回滚到不支持版本 37 的服务时，需要使用升级前的数据备份，按部署文档执行。
