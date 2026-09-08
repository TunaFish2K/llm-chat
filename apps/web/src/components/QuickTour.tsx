import { useEffect, useState } from "react";
import { Modal } from "../lib/ui";

export const TOUR_KEY = "llm-chat.quick-tour.v1";
export function QuickTour() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const mobile = window.matchMedia("(pointer: coarse)").matches;
  useEffect(() => {
    try { setOpen(localStorage.getItem(TOUR_KEY) !== "seen"); } catch { setOpen(true); }
    const replay = () => { setStep(0); setOpen(true); };
    window.addEventListener("llm-chat:quick-tour", replay);
    return () => window.removeEventListener("llm-chat:quick-tour", replay);
  }, []);
  const close = () => { try { localStorage.setItem(TOUR_KEY, "seen"); } catch {} setOpen(false); };
  const pages = [
    ["先连接模型", "在设置的“连接与模型”中选择服务商、填写 Key，再添加或发现模型。为 Agent 选择模型后，就可以开始聊天。"],
    ["输入栏怎么用", "左侧选择 Agent、模型和思考等级。工作目录与高级执行设置在低频设置菜单中；窄屏也会将 Agent 收入这里。右侧是附件、发送和停止。压缩上下文在聊天顶部的会话操作菜单中。"],
    ["生成中也能发消息", mobile ? "点击发送，把消息加入轮末队列。长按发送约半秒，使用 Steer：在下次模型请求前优先送入消息。" : "按 Enter 发送，Shift+Enter 换行。生成中短按加入轮末队列；长按 Enter 或发送按钮约半秒，使用 Steer，在下次模型请求前优先送入消息。"],
    ["找回聊天与个性化", "侧栏的搜索图标会搜索会话标题与正文。设置中可以更换强调色、开启深色纯黑背景，也可以随时重放本教程。"]
  ];
  if (!open) return null;
  return <Modal title="快速开始" onClose={close} footer={<>
    <button className="btn" onClick={close}>跳过教程</button>
    {step > 0 ? <button className="btn" onClick={() => setStep(step - 1)}>上一步</button> : null}
    <button className="btn primary" onClick={() => step === pages.length - 1 ? close() : setStep(step + 1)}>{step === pages.length - 1 ? "开始使用" : "下一步"}</button>
  </>}>
    <div className="quick-tour" aria-live="polite"><span className="hint">{step + 1} / {pages.length} · 仅此浏览器记录是否看过</span>
      <h3>{pages[step]![0]}</h3><p>{pages[step]![1]}</p>
      {step === 2 ? <p className="hint">Steer 不打断当前请求或工具，不跳过审批。待发送消息可以单条删除或全部清空。</p> : null}
    </div>
  </Modal>;
}
