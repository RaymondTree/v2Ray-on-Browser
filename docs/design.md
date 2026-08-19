# v2Ray-on-Browser 设计文档 v1.0

> 日期：2026-08-19 | 分支：arena/01a019a5-v2ray-on-browser | 部署目标：Cloudflare Pages（纯静态）

## 1. 项目概述

构建一款**完全运行于浏览器端**的 VLESS 网页代理 SPA。用户访问 Cloudflare Pages 线上地址后，所有代理逻辑、WASM 内核、网络隧道均在本地浏览器内执行；平台仅分发 `html/css/js/wasm` 静态资源，不参与流量转发。仅支持 `VLESS + WebSocket + TLS` 协议组合。

### 1.1 核心约束（来自需求 6、7）

- WASM 采用**单线程**编译，规避 `SharedArrayBuffer` / `COOP` / `COEP` 头依赖，单文件 <25 MiB。
- 项目根目录提供无后缀 `_headers` 为 `*.wasm` 设置 `Content-Type: application/wasm`。
- 零后端：禁止 Pages Functions / Workers 业务逻辑。
- `https://127.0.0.1:12345` 本地 HTTPS 可验证，行为与线上一致。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Pages (静态托管)                         │
│  index.html / style.css / app.js / worker.js /      │
│  xray.wasm / _headers                               │
└────────────────────┬────────────────────────────────┘
                     │ 静态分发（GET）
                     ▼
┌─────────────────────────────────────────────────────┐
│  Browser 主线程 (UI)                                 │
│  - app.js: 节点模式切换 / 表单 / 代理浏览 / 日志     │
│  - iframe: 网页浏览容器                              │
│  - localStorage: 自定义节点持久化                    │
│             ↕ postMessage                            │
│  Web Worker (worker.js)                             │
│  - xray-js WASM 单线程实例                           │
│  - VLESS+WS+TLS 隧道建立/拆卸                         │
│  - fetch 拦截转发 / 流量统计                         │
│  - 日志回传                                          │
└─────────────────────────────────────────────────────┘
                     │ WebSocket over TLS
                     ▼
           VLESS 节点 (用户自建/预设)
```

**线程隔离**：WASM 仅在 Worker 内初始化与运行，避免阻塞 UI。主线程与 Worker 通过结构化 `postMessage` 通信。

### 2.1 技术选型（已确认）

| 层 | 选型 | 理由 |
|---|---|---|
| 内核 | xray-js（官方 xray-core 编译为 Go→WASM / JS 封装），单线程构建 | 满足 VLESS+WS+TLS，官方维护，需指定版本（待用户确认 commit/tag） |
| 前端 | 原生 HTML+CSS+JS，无框架 | 满足交付约束，最小静态体积 |
| Worker | Dedicated Worker + `importScripts` / `fetch`+`WebAssembly.instantiateStreaming` | 兼容 Pages 静态环境 |
| 浏览容器 | `iframe` + **方案A：Worker fetch → blob URL 载入**（已确认） | 规避 Service Worker 额外复杂度，能证明流量经隧道；后续可平滑升级为 SW 拦截 |
| 存储 | `localStorage` | 自定义节点持久化 |
| 本地验证 | `vite preview --https` 或 `npx serve` + 自签名证书，端口 12345 | 统一脚本 `scripts/serve-https.mjs` |

---

## 3. 模块划分

### 3.1 主线程 `app.js`

| 子模块 | 职责 |
|---|---|
| **NodeModeController** | 切换「自定义/预设」单选；显隐表单控件；预设模式禁用编辑 |
| **NodeForm** | 字段：`address`、`port`、`uuid`、`wsPath`、`sni`；校验（见 §4.1）；连接/断开按钮；状态机渲染（未连接/连接中/已连接/失败） |
| **StorageService** | `localStorage` 键 `v2ray-custom-nodes`，JSON 序列化；读写、清理 |
| **PresetStore** | `presets.js` 或内联常量数组，写死 1–3 条（等待用户提供真实数据前以 `PRESET_PLACEHOLDER` 占位，构建时替换） |
| **BrowserModule** | 地址栏、前进/后退（history 栈）、刷新；将 URL 发送至 Worker 请求；接收 `blob:` 或 `data:` 转交 iframe |
| **LogPanel** | 5 类日志（连接状态、HTTP 记录、流量统计、WASM 异常、节点错误）；按级别着色、时间戳、导出/清空；虚拟滚动上限 1000 条 |
| **WorkerBridge** | 封装 `postMessage` 协议、请求 ID、超时、状态同步 |

### 3.2 Worker `worker.js`

| 子模块 | 职责 |
|---|---|
| **WasmLoader** | `fetch('xray.wasm')` + `WebAssembly.instantiateStreaming`，单线程实例；失败回退至 `ArrayBuffer` 实例化；上报加载进度/异常 |
| **TunnelManager** | 维护单隧道状态机；调用 xray-js API 建立 `VLESS → WS → TLS`；心跳；断开清理 |
| **ProxyEngine** | 接收主线程 `PROXY_FETCH {url, method, headers}`，经隧道发起请求，返回 `{status, headers, body}`；统计 `bytesUp/Down` |
| **Logger** | 结构化日志回传主线程 |

### 3.3 静态资源

```
/index.html
/style.css
/app.js
/worker.js
/xray.wasm        # 单线程构建产物，<25 MiB
/_headers         # Cloudflare Pages 头配置
/deploy-cf-pages.md
```

---

## 4. 数据流转逻辑

### 4.1 节点配置与连接

```
用户选择模式
  ├─ 自定义 → 表单可编辑 → 校验 → 存 localStorage → 点击“连接”
  └─ 预设   → 下拉选择预设 → 表单只读展示 → 点击“连接”
        ↓
app.js → WorkerBridge.postMessage({type:'CONNECT', payload:{address,port,uuid,wsPath,sni}})
        ↓
Worker: 校验 → WasmLoader 确保已就绪 → TunnelManager.connect()
        ↓ 成功/失败
Worker → postMessage({type:'STATUS', state:'connected'|'failed', error?})
        ↓
UI 更新状态徽标 + LogPanel 追加记录
```

**校验规则**

- `address`：域名或 IPv4/IPv6，非空
- `port`：1–65535，默认 443（TLS 场景）
- `uuid`：RFC4122 v4 正则
- `wsPath`：以 `/` 开头，允许空（默认 `/`）
- `sni`：可选，默认同 `address`；若填则校验域名格式

### 4.2 代理浏览（已确认方案A）

```
地址栏输入 https://example.com
  ↓
app.js 推入 history 栈 → Bridge.postMessage({type:'PROXY_FETCH', id, url})
  ↓
Worker.ProxyEngine 经已建立隧道 fetch → 返回 body ArrayBuffer + headers
  ↓
Worker → postMessage({type:'PROXY_RESPONSE', id, status, headers, body})
  ↓
app.js: 依据 Content-Type
  - text/html → 注入 <base href="..."> + 将子资源 URL 改写为 proxied fetch（或提示跨域限制）
  - 其他 → 生成 Blob URL → iframe.src = blobUrl
  - 记录 HTTP 日志 + 流量统计
```

> 局限与诚实说明：iframe 无法 100% 透明代理子资源（CSS/JS/图片的相对路径）；方案A可满足“容器内网页经隧道”可验证性，后续可无缝升级为 Service Worker 拦截（方案B）实现全量资源代理，接口保持一致。

### 4.3 日志与统计

- Worker 每 1s 推送 `STATS {bytesUp, bytesDown, activeRequests}`，主线程累计展示。
- 所有 `console.error` 来自 WASM 的异常经 `Logger` 捕获并以 `level:error` 回传。

---

## 5. 页面结构 `index.html`

```
header: 标题 + 节点模式切换 (radio)
main: 两栏布局
  左栏: NodeForm (address/port/uuid/wsPath/sni + 连接/断开 + 状态徽标)
        PresetSelector (预设模式可见)
        BrowserControls (地址栏 + 前进/后退/刷新)
  右栏: iframe#browserView
footer: LogPanel (tabs: 全部/请求/流量/错误) + 清空/导出按钮
```

`style.css`：CSS 变量主题、Flex/Grid 布局、响应式（<768px 单栏）、状态色（灰/蓝/绿/红对应四状态）。

---

## 6. 关键接口契约

```ts
// 主→Worker
type MsgToWorker =
  | {type:'INIT_WASM'}
  | {type:'CONNECT', payload: VlessConfig}
  | {type:'DISCONNECT'}
  | {type:'PROXY_FETCH', id:string, url:string, method?:string, headers?:Record<string,string>}

type VlessConfig = { address:string, port:number, uuid:string, wsPath:string, sni:string }

// Worker→主
type MsgToMain =
  | {type:'WASM_READY' | 'WASM_ERROR', error?:string}
  | {type:'STATUS', state:'idle'|'connecting'|'connected'|'failed', error?:string}
  | {type:'PROXY_RESPONSE', id:string, status:number, headers:Record<string,string>, body:ArrayBuffer}
  | {type:'LOG', level:'info'|'warn'|'error', msg:string, ts:number}
  | {type:'STATS', bytesUp:number, bytesDown:number}
```

---

## 7. Cloudflare Pages 适配

**`_headers`（根目录，无后缀）**

```
/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable
/*.js
  Content-Type: application/javascript; charset=utf-8
```

***（注意：Pages 的 `_headers` 语法为路径+缩进头，需实测）***

**WASM 体积控制**

- 使用 `tinygo` 或 `go wasm` 单线程构建，关闭 `pthread`，启用 `-ldflags="-s -w"` 与 `wasm-opt -Oz`。
- 目标 <5 MiB（远低于 25 MiB 上限）；若真实 xray-core 超限，则剥离不必要入站/出站协议，仅保留 VLESS/WS/TLS。

**本地 HTTPS**

- 提供 `scripts/serve-https.mjs`：生成自签名证书（`openssl` 或 `selfsigned` npm 包），启动 `https://127.0.0.1:12345` 静态服务，自动设置 `Cross-Origin-Opener-Policy` 非必需（单线程无需 COOP/COEP）。

---

## 8. 潜在风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 真实 xray-js 单线程编译体积超 25 MiB | 部署失败 | 裁剪协议、开启压缩、上报体积监控；提供 Mock 兜底分支 |
| 浏览器无法直接建立原始 TCP/TLS，需经 WebSocket | 节点必须支持 WS+TLS，否则连接失败 | 表单提示“仅支持 VLESS+WS+TLS”，预设节点强制校验 |
| iframe 子资源无法 100% 走隧道（方案A限制） | 用户感知“部分直连” | 文档诚实说明，日志中标注直连回退；预留 SW 升级路径 |
| WASM MIME 错误 | 加载失败 | `_headers` + `application/wasm` 双保险，`instantiateStreaming` 失败回退 |
| 自签名证书本地信任问题 | `https://127.0.0.1:12345` 报错 | 文档提供“信任证书/忽略警告”步骤，脚本自动打开 |
| localStorage 隐私/容量 | 节点泄露 | 仅存本地，不上传；提供“一键清除” |
| 预设节点敏感信息泄露 | 仓库公开 | 提醒用户预设节点仅作演示，真实密钥应使用自定义模式 |

---

## 9. 待确认事项（阻塞后续开发）

1. **预设节点清单**：请提供 1–3 条真实 `address/port/uuid/wsPath/sni`（或授权使用占位符先行开发，清单到位后替换）。
2. **xray-js 版本**：请指定 `xray-js` / `xray-core` 的 tag/commit（如 `v1.8.x`），或授权使用最新 main 单线程构建。
3. **是否接受 Mock 兜底**：若真实 WASM 在 Pages 上加载失败，是否允许自动降级为 Mock 隧道以保证演示可用性？（建议接受）

---

## 10. 交付校验

- 本地：`npm run serve:https` → 访问 `https://127.0.0.1:12345` → 自定义节点连接 → 地址栏访问 `https://example.com` → iframe 显示 → 日志含请求与流量。
- 线上：推送至 GitHub → Cloudflare Pages 绑定 → 同上流程验证；检查 DevTools 中 `xray.wasm` 响应头为 `application/wasm`。

---

> 请确认本设计文档或提出修改意见；确认后将输出《开发执行计划》。
