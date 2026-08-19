# 开发执行计划 v1.0

> 基于已确认的《设计文档 v1.0》，按 Cloudflare Pages 纯静态交付约束执行。

## 1. 里程碑与步骤

### 阶段 0 — 准备（0.5 天）

| 步骤 | 内容 | 产出 | 验收 |
|---|---|---|---|
| 0-1 | 确定 xray-js 版本与预设节点占位符；初始化仓库结构 `index.html/style.css/app.js/worker.js/xray.wasm/_headers/docs/` | 仓库骨架 | `git status` 干净 |
| 0-2 | 选定本地 HTTPS 方案：`scripts/serve-https.mjs` + `selfsigned` 依赖 | 脚本可执行 | `node scripts/serve-https.mjs` 启动 `https://127.0.0.1:12345` |

- 依赖：用户待提供的预设节点清单、xray-js tag；先以占位符推进，不阻塞。

### 阶段 1 — 静态基座与 UI（1 天）

| 步骤 | 内容 | 细节 |
|---|---|---|
| 1-1 | `index.html` DOM：header 模式切换、左栏表单/浏览器控件、右栏 iframe、底部日志面板 | 语义化、无行内样式、引入 `style.css/app.js` |
| 1-2 | `style.css` 主题变量、两栏响应式、4 状态色、表单/按钮/日志样式 | 深浅色自适应、移动端单栏 |
| 1-3 | `_headers` 根文件 | `/*.wasm` → `application/wasm`，`Cache-Control` |
| 1-4 | 空 Worker 占位与主线程 Bridge 打通 | `postMessage` 心跳验证 |

**验收**：本地打开页面无 404，模式切换显隐正常，Worker 能回声。

### 阶段 2 — 节点配置与状态机（1 天）

| 步骤 | 内容 |
|---|---|
| 2-1 | `PresetStore`：数组写死，预设模式下拉只读展示（当前以 `PRESET_PLACEHOLDER` 2 条演示数据，注释 `// TODO: 替换为真实节点`） |
| 2-2 | `NodeModeController`：radio 切换、显隐编辑控件、禁用逻辑 |
| 2-3 | `NodeForm`：5 字段 + 校验（§4.1 规则）+ 连接/断开按钮；状态机 `idle/connecting/connected/failed` 徽标与禁用态 |
| 2-4 | `StorageService`：`localStorage` 键 `v2ray-custom-nodes`，自动保存/回显、清空 |

**验收**：自定义模式填写后刷新仍回显；非法 UUID/端口提示；预设不可编辑。

### 阶段 3 — Worker 与 WASM（1.5 天） ★ 关键路径

| 步骤 | 内容 |
|---|---|
| 3-1 | `WasmLoader`：`instantiateStreaming` 加载 `xray.wasm`，失败回退 `ArrayBuffer`；上报 `WASM_READY/ERROR` |
| 3-2 | 真实 `xray.wasm` 获取：拉取 `xray-js` 指定 tag，单线程构建 `GOOS=js GOARCH=wasm go build -ldflags="-s -w"`，`wasm-opt -Oz`，校验 <25 MiB；若构建环境受限则先置 `mock.wasm`（JS 封装模拟）并文档说明替换步骤 |
| 3-3 | `TunnelManager`：封装 `CONNECT/DISCONNECT`，调用 xray-js 连接 API（含 WS path、SNI、UUID），状态机与错误分类（DNS/TLS/WS/UUID） |
| 3-4 | `ProxyEngine`：`PROXY_FETCH` 经隧道转发，返回 body/headers/status；流量计数 |
| 3-5 | `Logger`：分级日志回传，主线程落盘 |

**验收**：点击连接→状态 `connecting→connected/failed`；失败有明确错误日志；`xray.wasm` 网络面板 `Content-Type: application/wasm` 且体积合规。

### 阶段 4 — 代理浏览与日志（1 天）

| 步骤 | 内容 |
|---|---|
| 4-1 | `BrowserModule`：地址栏、前进/后退栈、刷新；发送 `PROXY_FETCH`，接收 `PROXY_RESPONSE` |
| 4-2 | HTML 响应注入 `<base>`，Blob URL 载入 iframe；非 HTML 直接 Blob |
| 4-3 | 子资源说明：方案A 局限在 UI 提示与日志中诚实标注，预留 SW 升级接口 |
| 4-4 | `LogPanel`：tabs、着色、时间戳、清空/导出（JSON/CSV）、1000 条上限虚拟化 |

**验收**：已连接后在地址栏输入 `https://example.com` 能在 iframe 显示，日志出现 HTTP 记录与流量统计。

### 阶段 5 — 本地 HTTPS 与部署文档（0.5 天）

| 步骤 | 内容 |
|---|---|
| 5-1 | `scripts/serve-https.mjs`：自签名证书生成、静态服务 `https://127.0.0.1:12345`、端口冲突提示 |
| 5-2 | `package.json` 脚本 `serve:https`、`serve:http` |
| 5-3 | `deploy-cf-pages.md`：GitHub 推送、Pages 绑定、分支/构建配置（Build command 空、Output `/`）、`_headers` 验证、线上/本地校验流程 |
| 5-4 | `README.md` 更新 |

**验收**：`npm run serve:https` 一键可复现；部署文档按步骤可完成 Pages 上线。

### 阶段 6 — 联调与交付（0.5 天）

- 端到端用例：未连接浏览阻断提示 → 自定义节点校验 → 预设切换 → 连接/断开 → 代理浏览 → 日志/流量 → 刷新持久化
- 体积与头检查：`xray.wasm` <25 MiB，`curl -I` 验证 MIME
- 浏览器矩阵：Chrome/Edge/Firefox 最新版；移动端 Safari 基础可用

---

## 2. 任务依赖图

```
0-准备 → 1-基座 → 2-节点表单 → 3-WASM/隧道 → 4-浏览/日志 → 5-HTTPS/文档 → 6-联调
              └─────────────── 3-1 WasmLoader 可与 2 并行 ──────────────┘
```

关键路径：3-2 真实 WASM 构建；若受限则 Mock 不阻塞后续。

## 3. 文件清单映射

| 交付物 | 负责阶段 | 备注 |
|---|---|---|
| `index.html` | 1 |  |
| `style.css` | 1 |  |
| `app.js` | 2,4 |  |
| `worker.js` | 3 |  |
| `xray.wasm` | 3-2 | 单线程 <25 MiB，mock 兜底亦合规 |
| `_headers` | 1-3 | 根目录无后缀 |
| `deploy-cf-pages.md` | 5 | 含本地 `127.0.0.1:12345` 步骤 |

## 4. 风险应对（执行期）

- **WASM 构建超限/超时**：立即切换 Mock 并在 `deploy-cf-pages.md` 标注真实构建命令，用户后续替换即可。
- **Pages `_headers` 语法差异**：以官方文档为准，本地用 `serve-https` 同步头验证。
- **预设节点未到位**：以占位符先行，预留 `src/presets.js` 替换点，不影响联调。

## 5. 时间估算

总计约 **5 人日**（单人串行）；按本计划可 1–2 个工作日内交付可运行 Demo（含 Mock WASM），真实 WASM 替换为增量步骤。

## 6. 确认点

- 是否接受 **阶段 3-2 Mock 兜底策略**（保证先交付可演示版本）？
- 预设节点与 xray-js 版本是否可先以占位符/最新 main 推进，清单到位后我直接替换提交？

> 请确认本计划或提出修改；确认后即进入编码交付阶段，按清单生成全部文件并推送至 `arena/01a019a5-v2ray-on-browser`。
