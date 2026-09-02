import { useCallback, useEffect, useState } from "react";
import { Bot, Plus } from "lucide-react";
import type {
  ConnectionDto,
  ConnectionInput,
  ModelCapabilities,
  ModelDto,
  ModelInput,
  ProviderProtocol
} from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { appStore, refreshConnectionsAndModels, toast, toastError } from "../lib/app-state";
import { formatTime, formatTokens } from "../lib/format";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, Field, Modal, Switch } from "../lib/ui";

const PROTOCOLS: ProviderProtocol[] = ["openai-responses", "openai-chat", "anthropic-messages"];

interface BalanceState {
  loading: boolean;
  value?: number;
  cached?: boolean;
  fetchedAt?: number;
  error?: string;
}

export function ConnectionsView({ embedded = false }: { embedded?: boolean } = {}) {
  const connections = useStore(appStore, (s) => s.connections);
  const models = useStore(appStore, (s) => s.models);
  const [editingConnection, setEditingConnection] = useState<ConnectionDto | "new" | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<ConnectionDto | null>(null);
  const [editingModel, setEditingModel] = useState<ModelDto | "new" | null>(null);
  const [deletingModel, setDeletingModel] = useState<ModelDto | null>(null);
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const [busy, setBusy] = useState(false);

  const loadBalance = useCallback(async (connection: ConnectionDto, refresh = false) => {
    setBalances((current) => ({ ...current, [connection.id]: { loading: true } }));
    try {
      const result = await endpoints.connectionBalance(connection.id, refresh);
      setBalances((current) => ({
        ...current,
        [connection.id]: { loading: false, value: result.value, cached: result.cached, fetchedAt: result.fetchedAt }
      }));
    } catch (error) {
      setBalances((current) => ({
        ...current,
        [connection.id]: { loading: false, error: error instanceof Error ? error.message : "余额获取失败" }
      }));
    }
  }, []);

  useEffect(() => {
    for (const connection of connections) {
      if (connection.balanceConfig?.enabled && !balances[connection.id]) {
        void loadBalance(connection);
      }
    }
  }, [connections, balances, loadBalance]);

  const testConnection = async (connection: ConnectionDto) => {
    setBusy(true);
    try {
      const result = await endpoints.testConnection(connection.id);
      toast("success", `连接正常，发现 ${result.modelsFound} 个模型`);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const discover = async (connection: ConnectionDto) => {
    setBusy(true);
    try {
      const result = await endpoints.discoverModels(connection.id);
      await refreshConnectionsAndModels();
      const details = [
        `发现 ${result.discovered}`,
        `新增 ${result.created.length}`,
        `更新 ${result.updated.length}`,
        `保留手动配置 ${result.skipped}`,
        `目录未匹配 ${result.unmatched}`
      ];
      toast(result.warnings.length > 0 ? "info" : "success", `${details.join("，")}。${result.warnings.join("；")}`);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const actions = (
    <div className={embedded ? "connection-actions" : "actions"}>
      <button className="btn" onClick={() => setEditingModel("new")} disabled={connections.length === 0}>
        <Bot size={15} aria-hidden="true" />
        手动添加模型
      </button>
      <button className="btn primary" onClick={() => setEditingConnection("new")}>
        <Plus size={15} aria-hidden="true" />
        新建连接
      </button>
    </div>
  );

  return (
    <>
      {!embedded ? <div className="page-header">
        <h2>连接与模型</h2>
        {actions}
      </div> : null}
      <div className="panel-scroll">
        <div className="panel-inner">
          {embedded ? actions : null}
          {connections.length === 0 ? (
            <EmptyState title="还没有连接" hint="添加一个模型提供方连接，然后发现或手动添加模型。" />
          ) : (
            connections.map((connection) => {
              const balance = balances[connection.id];
              const connectionModels = models.filter((model) => model.connectionId === connection.id);
              return (
                <div className="card" key={connection.id}>
                  <header className="management-card-header">
                    <h3 className="list-row-title">
                      <strong>{connection.name}</strong>
                      <span className="tag">{connection.protocol}</span>
                    </h3>
                    <div className="list-row-actions">
                      <button className="btn small" disabled={busy} onClick={() => void testConnection(connection)}>
                        测试连接
                      </button>
                      <button className="btn small" disabled={busy} onClick={() => void discover(connection)}>
                        发现模型
                      </button>
                      <button className="btn small" onClick={() => setEditingConnection(connection)}>
                        编辑
                      </button>
                      <button className="btn small danger" onClick={() => setDeletingConnection(connection)}>
                        删除
                      </button>
                    </div>
                  </header>
                  <p className="small muted mono">{connection.baseUrl}</p>
                  <p className="small muted">
                    API Key：{connection.hasApiKey ? "已配置" : "未配置"}
                    {connection.secretHeaderNames.length > 0
                      ? ` · 秘密头：${connection.secretHeaderNames.join(", ")}`
                      : ""}
                  </p>
                  {connection.balanceConfig?.enabled ? (
                    <p className="small">
                      余额：
                      {balance?.loading ? (
                        "查询中…"
                      ) : balance?.error ? (
                        <span style={{ color: "var(--danger)" }}>{balance.error}</span>
                      ) : balance?.value !== undefined ? (
                        <>
                          <strong>{balance.value}</strong>
                          {balance.cached ? "（缓存）" : ""} · {formatTime(balance.fetchedAt)}
                        </>
                      ) : (
                        "未查询"
                      )}{" "}
                      <button className="btn small ghost" onClick={() => void loadBalance(connection, true)}>
                        刷新
                      </button>
                    </p>
                  ) : null}

                  {connectionModels.length === 0 ? (
                    <p className="small muted">该连接下没有模型。</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>模型</th>
                          <th>上下文</th>
                          <th>来源</th>
                          <th>启用</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {connectionModels.map((model) => (
                          <tr key={model.id}>
                            <td>
                              <div className="list-row-title">
                                <span>{model.displayName}</span>
                                {model.catalogManaged ? <span className="tag ok">自动维护</span> : null}
                              </div>
                              <div className="small muted mono">{model.modelKey}</div>
                            </td>
                            <td>
                              <div>{formatTokens(model.contextWindow ?? undefined)}</div>
                              <div className="small muted">
                                输入 {formatTokens(model.maxInputTokens ?? undefined)} · 输出 {formatTokens(model.maxOutputTokens)}
                              </div>
                            </td>
                            <td>{model.source === "discovered" ? "发现" : "手动"}</td>
                            <td>
                              <Switch
                                label={`启用 ${model.displayName}`}
                                hideLabel
                                checked={model.enabled}
                                onChange={(checked) => {
                                  endpoints
                                    .updateModel(model.id, { enabled: checked })
                                    .then(() => refreshConnectionsAndModels())
                                    .catch(toastError);
                                }}
                              />
                            </td>
                            <td>
                              <button className="btn small" onClick={() => setEditingModel(model)}>
                                编辑
                              </button>{" "}
                              <button className="btn small danger" onClick={() => setDeletingModel(model)}>
                                删除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {editingConnection ? (
        <ConnectionEditor
          connection={editingConnection === "new" ? null : editingConnection}
          onClose={() => setEditingConnection(null)}
        />
      ) : null}
      {editingModel ? (
        <ModelEditor
          model={editingModel === "new" ? null : editingModel}
          onClose={() => setEditingModel(null)}
        />
      ) : null}
      {deletingConnection ? (
        <ConfirmModal
          title={`删除连接 ${deletingConnection.name}`}
          message="删除连接会一并删除其下的所有模型，并清除指向这些模型的默认模型设置。"
          confirmLabel="删除"
          danger
          onClose={() => setDeletingConnection(null)}
          onConfirm={() => {
            const target = deletingConnection;
            setDeletingConnection(null);
            endpoints
              .deleteConnection(target.id)
              .then(() => refreshConnectionsAndModels())
              .catch(toastError);
          }}
        />
      ) : null}
      {deletingModel ? (
        <ConfirmModal
          title={`删除模型 ${deletingModel.displayName}`}
          message="确定删除该模型吗？"
          confirmLabel="删除"
          danger
          onClose={() => setDeletingModel(null)}
          onConfirm={() => {
            const target = deletingModel;
            setDeletingModel(null);
            endpoints
              .deleteModel(target.id)
              .then(() => refreshConnectionsAndModels())
              .catch(toastError);
          }}
        />
      ) : null}
    </>
  );
}

function ConnectionEditor({ connection, onClose }: { connection: ConnectionDto | null; onClose: () => void }) {
  const [name, setName] = useState(connection?.name ?? "");
  const [protocol, setProtocol] = useState<ProviderProtocol>(connection?.protocol ?? "openai-responses");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [balanceEnabled, setBalanceEnabled] = useState(Boolean(connection?.balanceConfig?.enabled));
  const [balancePath, setBalancePath] = useState(connection?.balanceConfig?.apiPath ?? "");
  const [balanceExpression, setBalanceExpression] = useState(connection?.balanceConfig?.resultExpression ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const secretHeaders: Record<string, string> = {};
      for (const header of headers) {
        if (header.name.trim()) secretHeaders[header.name.trim()] = header.value;
      }
      if (connection) {
        const patch: Partial<ConnectionInput> = {
          name: name.trim(),
          protocol,
          baseUrl: baseUrl.trim(),
          ...(apiKey ? { apiKey } : {}),
          ...(headers.length > 0 ? { secretHeaders } : {}),
          ...(balanceEnabled
            ? {
                balanceConfig: {
                  enabled: true,
                  apiPath: balancePath.trim(),
                  resultExpression: balanceExpression.trim()
                }
              }
            : connection.balanceConfig
              ? { balanceConfig: { ...connection.balanceConfig, enabled: false } }
              : {})
        };
        await endpoints.updateConnection(connection.id, patch);
      } else {
        const input: ConnectionInput = {
          name: name.trim(),
          protocol,
          baseUrl: baseUrl.trim(),
          ...(apiKey ? { apiKey } : {}),
          secretHeaders,
          ...(balanceEnabled
            ? {
                balanceConfig: {
                  enabled: true,
                  apiPath: balancePath.trim(),
                  resultExpression: balanceExpression.trim()
                }
              }
            : {})
        };
        await endpoints.createConnection(input);
      }
      await refreshConnectionsAndModels();
      toast("success", "连接已保存");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={connection ? `编辑连接 ${connection.name}` : "新建连接"}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !baseUrl.trim()} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      <div className="grid-2">
        <Field label="名称" htmlFor="conn-name">
          <input id="conn-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="协议" htmlFor="conn-protocol">
          <select
            id="conn-protocol"
            className="select"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as ProviderProtocol)}
          >
            {PROTOCOLS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Base URL" htmlFor="conn-base-url">
        <input
          id="conn-base-url"
          className="input mono"
          placeholder="https://api.example.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </Field>
      <Field
        label="API Key"
        hint={connection?.hasApiKey ? "已配置；留空保持不变。" : "可选。"}
        htmlFor="conn-api-key"
      >
        <input
          id="conn-api-key"
          className="input mono"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      <Field
        label="秘密请求头"
        hint={
          connection && connection.secretHeaderNames.length > 0
            ? `当前已配置：${connection.secretHeaderNames.join(", ")}。添加同名请求头会覆盖，留空列表则保持不变。`
            : undefined
        }
      >
        {headers.map((header, index) => (
          <div className="row" key={index} style={{ marginBottom: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder="Header 名称"
              aria-label={`请求头 ${index + 1} 名称`}
              value={header.name}
              onChange={(event) =>
                setHeaders(headers.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))
              }
            />
            <input
              className="input mono"
              style={{ flex: 2 }}
              placeholder="值"
              aria-label={`请求头 ${index + 1} 值`}
              value={header.value}
              onChange={(event) =>
                setHeaders(headers.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))
              }
            />
            <button className="btn small" onClick={() => setHeaders(headers.filter((_, i) => i !== index))}>
              移除
            </button>
          </div>
        ))}
        <button className="btn small" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
          添加请求头
        </button>
      </Field>
      <label className="checkbox-row">
        <input type="checkbox" checked={balanceEnabled} onChange={(event) => setBalanceEnabled(event.target.checked)} />
        启用余额查询
      </label>
      {balanceEnabled ? (
        <div className="grid-2" style={{ marginTop: 8 }}>
          <Field label="余额 API 路径" hint="相对连接 origin 的根路径，如 /dashboard/billing/credit_grants。">
            <input
              className="input mono"
              aria-label="余额 API 路径"
              value={balancePath}
              onChange={(event) => setBalancePath(event.target.value)}
            />
          </Field>
          <Field label="取值表达式" hint="从响应 JSON 中取余额数值。">
            <input
              className="input mono"
              aria-label="取值表达式"
              value={balanceExpression}
              onChange={(event) => setBalanceExpression(event.target.value)}
            />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

const CAPABILITY_LABELS: Array<[keyof ModelCapabilities, string]> = [
  ["imageInput", "图片输入"],
  ["tools", "工具"],
  ["temperature", "温度"],
  ["topP", "Top-P"],
  ["reasoning", "推理"],
  ["reasoningSummary", "推理摘要"],
  ["adaptiveThinking", "自适应思考"],
  ["manualThinking", "手动思考"]
];

function ModelEditor({ model, onClose }: { model: ModelDto | null; onClose: () => void }) {
  const connections = useStore(appStore, (s) => s.connections);
  const [connectionId, setConnectionId] = useState(model?.connectionId ?? connections[0]?.id ?? "");
  const [modelKey, setModelKey] = useState(model?.modelKey ?? "");
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxInputTokens, setMaxInputTokens] = useState(model?.maxInputTokens?.toString() ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(model?.maxOutputTokens ?? 4096));
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(
    model?.capabilities ?? {
      imageInput: false,
      tools: true,
      temperature: true,
      topP: true,
      reasoning: false,
      reasoningSummary: false,
      adaptiveThinking: false,
      manualThinking: false
    }
  );
  const [temperature, setTemperature] = useState(model?.defaultSettings.common.temperature?.toString() ?? "");
  const [reasoningSummary, setReasoningSummary] = useState(model?.defaultSettings.protocol.reasoningSummary ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: ModelInput = {
        connectionId,
        modelKey: modelKey.trim(),
        displayName: displayName.trim(),
        contextWindow: contextWindow === "" ? null : Number(contextWindow),
        maxInputTokens: maxInputTokens === "" ? null : Number(maxInputTokens),
        maxOutputTokens: Number(maxOutputTokens) || 4096,
        capabilities,
        defaultSettings: {
          common: {
            ...(temperature === "" ? {} : { temperature: Number(temperature) }),
            maxOutputTokens: Number(maxOutputTokens) || 4096,
            stopSequences: model?.defaultSettings.common.stopSequences ?? []
          },
          protocol: reasoningSummary ? { reasoningSummary: reasoningSummary as "auto" | "concise" | "detailed" } : {}
        },
        enabled: model?.enabled ?? true
      };
      if (model) await endpoints.updateModel(model.id, input);
      else await endpoints.createModel(input);
      await refreshConnectionsAndModels();
      toast("success", "模型已保存");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const restoreCatalog = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.restoreModelCatalog(model.id);
      await refreshConnectionsAndModels();
      toast("success", "已恢复目录托管并刷新模型参数");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复目录托管失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={model ? `编辑模型 ${model.displayName}` : "手动添加模型"}
      onClose={onClose}
      wide
      footer={
        <>
          {model && !model.catalogManaged ? (
            <button className="btn" disabled={busy} onClick={() => void restoreCatalog()}>
              恢复目录托管
            </button>
          ) : null}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || !modelKey.trim() || !displayName.trim() || !connectionId}
            onClick={() => void save()}
          >
            保存
          </button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      {model ? (
        <div className="model-management-note" data-managed={model.catalogManaged || undefined}>
          <div>
            <strong>{model.catalogManaged ? "自动维护模型参数" : "当前使用手动参数"}</strong>
            <span>
              {model.catalogManaged
                ? model.catalogMetadata
                  ? "参数来自 models.dev。保存下面的技术参数会转为手动配置，后续发现不会覆盖。"
                  : "暂未匹配目录记录；重新发现时会继续尝试。保存参数后将转为手动配置。"
                : model.catalogMetadata
                  ? "可恢复目录托管，重新采用 models.dev 的能力、限制和价格数据。"
                  : "该模型尚未匹配到目录记录。"}
            </span>
          </div>
          <span className={`tag ${model.catalogManaged ? "ok" : ""}`}>{model.catalogManaged ? "自动" : "手动"}</span>
        </div>
      ) : null}
      <div className="grid-2">
        <Field label="所属连接">
          <select
            className="select"
            aria-label="所属连接"
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="显示名">
          <input
            className="input"
            aria-label="显示名"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
      </div>
      <Field label="模型标识（modelKey）">
        <input
          className="input mono"
          aria-label="模型标识"
          value={modelKey}
          onChange={(event) => setModelKey(event.target.value)}
        />
      </Field>
      <div className="grid-3">
        <Field label="上下文窗口" hint="留空表示未知。">
          <input
            className="input"
            type="number"
            aria-label="上下文窗口"
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
          />
        </Field>
        <Field label="最大输入 token" hint="留空时按上下文窗口计算。">
          <input
            className="input"
            type="number"
            aria-label="最大输入 token"
            value={maxInputTokens}
            onChange={(event) => setMaxInputTokens(event.target.value)}
          />
        </Field>
        <Field label="最大输出 token">
          <input
            className="input"
            type="number"
            aria-label="最大输出 token"
            value={maxOutputTokens}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </Field>
      </div>
      {model?.catalogMetadata ? <ModelCatalogDetails model={model} /> : null}
      <Field label="能力">
        <div>
          {CAPABILITY_LABELS.map(([key, label]) => (
            <label key={key} className="checkbox-row">
              <input
                type="checkbox"
                checked={capabilities[key]}
                onChange={(event) => setCapabilities({ ...capabilities, [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      </Field>
      <div className="grid-2">
        <Field label="默认温度" hint="留空使用提供方默认。">
          <input
            className="input"
            type="number"
            step="0.1"
            aria-label="默认温度"
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
          />
        </Field>
        <Field label="推理摘要">
          <select
            className="select"
            aria-label="推理摘要"
            value={reasoningSummary}
            onChange={(event) => setReasoningSummary(event.target.value)}
          >
            <option value="">（不设置）</option>
            <option value="auto">auto</option>
            <option value="concise">concise</option>
            <option value="detailed">detailed</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function ModelCatalogDetails({ model }: { model: ModelDto }) {
  const metadata = model.catalogMetadata;
  if (!metadata) return null;
  const pricing = metadata.pricing;
  return (
    <details className="model-catalog-details">
      <summary>模型目录详情</summary>
      <dl className="catalog-detail-grid">
        <div><dt>目录标识</dt><dd className="mono">{metadata.providerId} / {metadata.modelId}</dd></div>
        <div><dt>系列与发布</dt><dd>{metadata.family ?? "—"} · {metadata.releaseDate ?? "—"}</dd></div>
        <div><dt>输入模态</dt><dd>{metadata.inputModalities.join("、") || "—"}</dd></div>
        <div><dt>输出模态</dt><dd>{metadata.outputModalities.join("、") || "—"}</dd></div>
        <div className="detail-grid-wide"><dt>推理档位</dt><dd>{metadata.reasoningEfforts.join("、") || "目录未声明"}</dd></div>
        {metadata.description ? <div className="detail-grid-wide"><dt>说明</dt><dd>{metadata.description}</dd></div> : null}
        {pricing ? (
          <div className="detail-grid-wide">
            <dt>价格（每百万 token）</dt>
            <dd>
              输入 ${pricing.input} · 输出 ${pricing.output}
              {pricing.cacheRead !== undefined ? ` · 缓存读取 $${pricing.cacheRead}` : ""}
              {pricing.cacheWrite !== undefined ? ` · 缓存写入 $${pricing.cacheWrite}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
