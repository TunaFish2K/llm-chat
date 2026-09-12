# 模型协议

在“设置 → 连接”中编辑模型，可选择“自动识别”或手动指定 OpenAI Chat Completions、OpenAI Responses、
Anthropic Messages。同一连接下的模型可以使用不同协议，共用连接地址、API Key 和秘密请求头。
模型列表、选择器和编辑页显示实际使用的协议。

自动选择顺序是：手动指定 → 目录识别 → OpenCode Go 官方模型映射 → 连接默认协议。
例如，OpenCode Go 的 `grok-4.6` 使用 `/responses`，`minimax-m3` 使用 `/messages`，
`glm-5.3` 使用 `/chat/completions`。映射仅适用于确切的提供商和模型 ID，未知模型沿用连接默认值。
官方端点来源：[OpenCode Go endpoints](https://opencode.ai/docs/go/#endpoints)。

“发现模型”从 models.dev 的确切提供商和模型条目读取模型级 `provider.npm`：
`@ai-sdk/openai` 对应 Responses，`@ai-sdk/openai-compatible` 对应 Chat Completions，
`@ai-sdk/anthropic` 对应 Messages。跨提供商的相似名称只用于补充能力信息，不用于推断协议。
目录暂时不可用时保留已有识别结果。更换模型 ID、所属连接，或修改连接的提供商、地址后清除旧识别结果。

只修改协议不会关闭模型参数的目录管理。重新发现或恢复目录管理不会覆盖手动协议；手动管理参数的模型
也会更新自动协议。需要恢复自动选择时，将“模型协议”改为“自动识别”。

普通生成、工具续轮、排队消息、摘要和备用识图使用同一协议解析规则。生成记录保存实际使用的协议，
审批恢复沿用该记录，避免生成途中修改设置导致切换协议。请求失败不会自动改用其他协议重试。

API 的模型 `protocol` 字段可省略或设为 `null`。新模型省略时使用自动模式；更新时省略保留原值，
传 `null` 清除手动覆盖。`detectedProtocol` 只读，由服务维护。旧客户端和离线记录缺少这些字段仍可读取。
SQLite v42 增加两个可空列，部署和回滚步骤见[运维手册](DEPLOYMENT.md#模型协议升级v42)。

## 原生推理档位

推理菜单使用模型目录声明的原生档位。例如 Grok 4.6 是 `low / medium / high / xhigh`，不接受 `max`。
继承 Agent 的设置或切换模型后，若当前档位不受支持，界面会提示重新选择；服务在保存新消息和请求上游前
拦截无效档位并列出可选值。平台不把 `max` 自动转换成 `xhigh`。目录未声明档位时保留原有透传行为。
`none` 沿用现有语义：省略推理参数，由提供商使用默认行为，并不保证关闭模型推理。
