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
import { formatTime } from "../lib/format";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, Field, Modal } from "../lib/ui";

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
      toast("success", `发现 ${result.discovered} 个模型，新增 ${result.created.length} 个`);
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
                  <h3>
                    <span>
                      {connection.name} <span className="tag">{connection.protocol}</span>
                    </span>
                    <span className="row">
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
                    </span>
                  </h3>
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
                              <div>{model.displayName}</div>
                              <div className="small muted mono">{model.modelKey}</div>
                            </td>
                            <td>{model.contextWindow ?? "—"}</td>
                            <td>{model.source === "discovered" ? "发现" : "手动"}</td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`启用 ${model.displayName}`}
                                checked={model.enabled}
                                onChange={(event) => {
                                  endpoints
                                    .updateModel(model.id, { enabled: event.target.checked })
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

  return (
    <Modal
      title={model ? `编辑模型 ${model.displayName}` : "手动添加模型"}
      onClose={onClose}
      wide
      footer={
        <>
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
      <div className="grid-2">
        <Field label="上下文窗口" hint="留空表示未知。">
          <input
            className="input"
            type="number"
            aria-label="上下文窗口"
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
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
