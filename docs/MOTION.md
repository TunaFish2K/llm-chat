# 界面动画

动画入口为 `apps/web/src/lib/motion.tsx`。抽屉和自定义 Modal 使用 Motion；Radix Popover 使用 CSS 的 `data-state` 动画。条件渲染入口使用 `Presence` 保留退场节点，不在已经卸载的弹层内部放置退出边界。

默认入场 180 ms、退场 140 ms、消息入场 120 ms。抽屉弹簧为 stiffness 400、damping 40、mass 1；不启用自由惯性。减少动态效果由 Motion 与 CSS 分别处理。

抽屉沿用关闭距离 `max(56px, 宽度 × 22%)` 或速度 `0.55px/ms` 的判断。指针捕获转移时，忽略子元素冒泡的捕获丢失事件；取消真正的面板捕获才恢复位置。拖动后的合成点击不能触发导航项。

Modal 退场时使内容 inert，遮罩继续拦截点击，返回层仍保留。恢复焦点前检查目标是否仍在文档中，以及是否有其他前台对话框。Popover 的返回层随 Content 保留至 CSS 退场结束。快速重新打开会中断退出，恢复交互并将焦点放回对话框。

推理与工具展开沿用原生 details/summary 语义，显式提供 aria-expanded 和关联内容 ID。仅手动切换时测量高度，结束后清除固定高度；流式追加不反复测量或动画高度。消息以首批快照为基线，只对后续新增尾部 ID 标记一次入场。

## 测量记录

基线为提交 `25e2615`。使用生产构建、Playwright Chromium、390×844 手机触摸视口、4 倍 CPU 降速和相同空会话列表。关闭 Service Worker 以稳定测量传输资源，进入页面后打开导航抽屉，执行 6 次 36px 短拖及回弹。通过 React DevTools 提交钩子、requestAnimationFrame 和 PerformanceObserver 记录结果。首屏体积为实际请求到的 JavaScript 按文件 gzip 后求和，不是 npm 安装体积。

| 指标 | 改造前 | 改造后 |
| --- | ---: | ---: |
| 拖动期间 React 提交次数 | 67 | 1 |
| 帧间隔 P95 | 16.7 ms | 16.8 ms |
| 超过 32 ms 的帧 | 0 | 0 |
| 超过 50 ms 的主线程任务 | 0 | 0 |
| 首屏 JavaScript gzip | 534279 B | 568748 B |

首屏增加 34469 B，约 33.7 KiB gzip，低于 35 KiB（35840 B）的增量上限。

改造后另外逐次检查面板位移，6 次拖动均达到 -36px，避免将未实际拖动误判为性能改善。记录表明拖动的 React 更新开销减少；基线没有出现长任务或慢帧，因此不据此声称帧率提高。这是桌面运行的移动环境模拟，不代表安卓 PWA 真机或软键盘表现。

## 验证

- `pnpm check`：类型、构建、前端测试时间预算、完整单元测试与覆盖率通过。1089 项通过，14 项按现有条件跳过；语句覆盖率 95.98%，分支覆盖率 90.16%。
- `pnpm exec playwright test e2e/motion.spec.ts e2e/drafts-navigation.spec.ts e2e/experience.spec.ts e2e/chat-controls.spec.ts`：Chromium、Firefox、WebKit 和手机 Chromium 共 74 项通过；6 项手机专用测试在桌面项目跳过。包含发送失败回归。
- `pnpm test:deploy`：部署冒烟检查通过。

生产构建和浏览器测试必须串行运行，避免构建清理 dist 时使测试服务短暂返回 404。导航测试需区分正在退场的抽屉与可操作抽屉，不能仅凭节点可见就认定导航已打开。

嵌套 Popover 关闭后，要等子弹层卸载，再验证 Escape 关闭父弹层。退出期间的返回操作仍由子弹层消费。流式回复测试需将推理区定位到对应消息，不能在推理数据尚未到达时误选历史消息。

本次 WebKit 使用 `mcr.microsoft.com/playwright:v1.62.1-noble` 的浏览器服务，通过 Playwright `connectOptions.wsEndpoint` 连接；应用服务仍在宿主机运行。这样避开 Arch 宿主机缺失的 WebKit 共享库，也不混用两种 Node 版本编译的原生扩展。测试临时文件使用独立 `TMPDIR`，避免系统 `/tmp` 用户配额耗尽干扰结果。
