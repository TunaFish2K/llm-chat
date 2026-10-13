# 配置 OIDC 登录

LLM Chat 支持 OpenID Connect 身份服务。默认使用密码登录；可以同时启用密码和 OIDC，也可以仅启用 OIDC。

在身份服务中注册一个机密客户端，启用 Authorization Code 和 PKCE S256，允许 `openid profile`。为每个公网入口注册精确的回调地址。例如：

```text
https://chat.example.com/api/auth/oidc/callback
https://chat-alt.example.com/api/auth/oidc/callback
```

把客户端密钥写入仅服务账号可读的文件。在运行配置中添加：

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "dataDir": "/srv/llm-chat/data",
  "authentication": {
    "password": { "enabled": true },
    "oidc": {
      "issuer": "https://identity.example.com",
      "clientId": "llm-chat",
      "clientSecretFile": "./oidc-client-secret",
      "clientAuthentication": "client_secret_basic",
      "publicOrigins": ["https://chat.example.com", "https://chat-alt.example.com"],
      "allowedSubjects": ["subject-issued-to-the-owner"],
      "label": "统一登录"
    }
  }
}
```

`clientSecretFile` 相对于配置文件解析。`issuer` 必须与 Discovery 文档及 ID Token 中的 issuer 完全一致。`allowedSubjects` 使用身份服务分配的 `sub`，不要填写邮箱或用户名；先从身份服务的管理界面或经过验证的 ID Token 获取自己的 subject，再启用入口。issuer 与 subject 共同确定身份。更换 issuer、client ID 或准入名单后，原身份不再通过会话检查。

公网入口要求 HTTPS。本机开发允许 loopback HTTP。代理必须保留原始 Host。应用根据 `publicOrigins` 设置安全 Cookie，不信任 `X-Forwarded-Proto` 或 `Remote-User`。未配置的 Host 不提供 OIDC 登录。身份服务发现失败时，密码登录仍可用。

登录后，“设置 → 安全”显示当前认证方式。普通退出撤销当前应用会话。“退出身份服务”同时撤销当前应用会话，并在提供商支持标准退出端点时跳转到该端点。提供商不支持时，页面提示另行退出身份服务。身份服务退出不会自动撤销已有 LLM Chat 会话。修改密码或执行离线密码重置会撤销全部应用会话。

升级前备份数据库、运行配置和发布目录。schema 52 自动迁移旧密码会话。回滚时同时恢复旧程序、旧配置和升级前数据库备份。反向代理访问日志必须排除 `/api/auth/*` 的查询参数，避免记录 authorization code。

协议与会话边界见 [ADR-007](ADR-007-openid-connect-authentication.md)。
