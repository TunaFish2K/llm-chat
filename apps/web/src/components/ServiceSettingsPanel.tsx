import { ActionButton } from "../lib/action-feedback";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ServiceSettingsDto, ServiceSettingsInput } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { toast, toastError } from "../lib/app-state";
import { ErrorState, Field, LoadingState, Switch } from "../lib/ui";

export function ServiceSettingsPanel({ kind }: { kind: "search" | "image" }) {
  const [data, setData] = useState<ServiceSettingsDto | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => endpoints.serviceSettings().then(setData).catch((cause) => setError(String(cause))), []);
  useEffect(() => { void load(); }, [load]);
  const editVersion = useRef(0);
  const save = async (input: ServiceSettingsInput, rollback?: ServiceSettingsDto) => {
    const submittedVersion = editVersion.current;
    setBusy(true);
    try {
      const saved = await endpoints.updateServiceSettings(input);
      if (editVersion.current === submittedVersion) { setData(saved); setKeys({}); }
      toast("success", "已保存推荐顺序与配置");
    } catch (cause) {
      if (rollback && editVersion.current === submittedVersion) setData(rollback);
      toastError(cause);
    }
    finally { setBusy(false); }
  };
  if (error) return <ErrorState message={error} onRetry={() => { setError(null); return load(); }} />;
  if (!data) return <LoadingState />;
  const input = (next = data): ServiceSettingsInput => kind === "search"
    ? { searchEngines: next.searchEngines.map((engine) => ({ ...engine, ...(keys[engine.id] !== undefined ? { apiKey: keys[engine.id] } : {}) })) }
    : { imageModels: next.imageModels.map(({ modelId, enabled }) => ({ modelId, enabled })) };
  const move = (index: number, direction: number) => {
    const next = { ...data };
    if (kind === "search") { next.searchEngines = [...data.searchEngines]; [next.searchEngines[index], next.searchEngines[index + direction]] = [next.searchEngines[index + direction]!, next.searchEngines[index]!]; }
    else { next.imageModels = [...data.imageModels]; [next.imageModels[index], next.imageModels[index + direction]] = [next.imageModels[index + direction]!, next.imageModels[index]!]; }
    editVersion.current++; setData(next);
    return save(input(next), data);
  };
  const items = kind === "search" ? data.searchEngines : data.imageModels;
  return <div className="card service-settings" onChangeCapture={() => { editVersion.current++; }}>
    <h3>{kind === "search" ? "搜索引擎" : "图片工具模型"}</h3>
    <p className="hint">可以同时启用多个。越靠前越推荐 AI 优先使用，AI 也可以选择其他可用项。</p>
    {kind === "image" ? <p className="hint">模型来自“连接与模型”。工具生图需要图片协议；此处的开关不影响直接通过 Responses 对话生图。</p> : null}
    {!items.length ? <p className="hint">请先在连接与模型中添加支持图片输出的模型。</p> : null}
    <fieldset className="service-fields"><ol className="service-list">{items.map((item, index) => <li key={item.id}>
      <div className="service-heading">
        <Switch label={"provider" in item ? `${item.provider === "tavily" ? "Tavily" : "SearXNG"} · ${item.id}` : `${item.name} · ${item.connectionName}`}
          checked={item.enabled} onChange={(enabled) => {
            const next = kind === "search" ? { ...data, searchEngines: data.searchEngines.map((entry) => entry.id === item.id ? { ...entry, enabled } : entry) }
              : { ...data, imageModels: data.imageModels.map((entry) => entry.id === item.id ? { ...entry, enabled } : entry) };
            setData(next);
          }} />
        <div className="service-order">
          <ActionButton className="icon-button" title="上移" aria-label={`上移 ${item.id}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={17} /></ActionButton>
          <ActionButton className="icon-button" title="下移" aria-label={`下移 ${item.id}`} disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={17} /></ActionButton>
        </div>
      </div>
      {"provider" in item ? <div className="grid-2">
        <Field label="服务地址" hint={item.provider === "tavily" ? "留空使用 Tavily 默认地址。" : "填写 SearXNG 地址，并在服务端启用 JSON 搜索接口。"}>
          <input className="input" value={item.baseUrl} onChange={(event) => setData({ ...data, searchEngines: data.searchEngines.map((entry) => entry.id === item.id ? { ...entry, baseUrl: event.target.value } : entry) })} />
        </Field>
        <Field label="API Key" hint={item.hasApiKey ? "已配置。留空不修改，点击清除可移除。" : item.provider === "tavily" ? "Tavily 需要 API Key。" : "可选。"}>
          <div className="row"><input className="input" type="password" autoComplete="new-password" value={keys[item.id] ?? ""} onChange={(event) => {
            const next = { ...keys }; if (event.target.value) next[item.id] = event.target.value; else delete next[item.id]; setKeys(next);
          }} /><ActionButton className="btn small" onClick={() => setKeys({ ...keys, [item.id]: "" })}>清除</ActionButton></div>
          {keys[item.id] === "" ? <small>保存后清除密钥</small> : null}
        </Field>
      </div> : <><code className="service-model-id">{item.id}</code>{!item.available && item.enabled ? <p className="hint">请确认模型已启用，并配置图片协议。</p> : null}</>}
    </li>)}</ol></fieldset>
    <ActionButton className="btn primary" disabled={busy} onClick={() => save(input())}>{busy ? "正在保存…" : "保存配置"}</ActionButton>
  </div>;
}
