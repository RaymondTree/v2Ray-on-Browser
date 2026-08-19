# 部署说明 — v2Ray on Browser（Cloudflare Pages 纯静态）

## 1. 产物清单

已交付的静态文件（均位于仓库根目录）：

| 文件 | 说明 |
|---|---|
| `index.html` | 主页面 |
| `style.css` | 样式 |
| `app.js` | UI + 存储 + 代理浏览 |
| `worker.js` | Worker + WASM 加载 + 隧道 |
| `xray.wasm` | 单线程 WASM（当前为 40 B Mock 占位，演示可用；替换见 §4） |
| `_headers` | Cloudflare Pages 头配置，为 `*.wasm` 注入 `application/wasm` |
| `deploy-cf-pages.md` | 本文 |

> 约束：全部为静态资源，无 Pages Functions / Workers 业务逻辑。

---

## 2. 本地 HTTPS 验证（`https://127.0.0.1:12345`）

### 2.1 一键脚本

仓库提供 `scripts/serve-https.mjs`（若未生成，可按 §2.2 手动启动）。

```bash
npm install        # 安装 selfsigned（如已提供）
npm run serve:https
# 输出：Serving https://127.0.0.1:12345
```

脚本逻辑：使用 `selfsigned` 生成自签名证书，启动静态 HTTPS 服务于 `127.0.0.1:12345`，自动设置 `Content-Type`。

### 2.2 手动启动（无脚本时）

```bash
# 生成自签名证书
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=127.0.0.1"

# 使用任意静态 HTTPS 服务（示例：npx serve）
npx serve . -l 12345 --ssl-cert cert.pem --ssl-key key.pem
# 或
python3 -m http.server 12345  # 仅 http，需自行加反向代理；推荐 serve
```

访问：`https://127.0.0.1:12345`，浏览器提示证书不信任 → 选择 “高级 → 继续访问” 或将 `cert.pem` 加入系统信任。

### 2.3 本地功能校验

1. 打开 `https://127.0.0.1:12345`，观察日志面板 `WASM: 就绪`。
2. 自定义模式填写真实 VLESS 节点（地址/端口/UUID/WS 路径/SNI），点击 **连接** → 状态由 `连接中 → 已连接`，日志出现 `隧道已建立`。
3. 在代理浏览地址栏输入 `https://example.com` → 点击 **前往** → 右侧 iframe 显示页面，日志出现 `HTTP https://example.com` 与 `响应 200`，流量统计增长。
4. 测试前进/后退/刷新、断开重连、刷新后 `localStorage` 回显。
5. DevTools → Network → `xray.wasm` → Response Headers 含 `Content-Type: application/wasm`（本地脚本已模拟，线上由 `_headers` 保证）。

> 预设节点当前为占位 `preset*.example.com`，连接会提示 “演示节点不可连通”；属预期，替换真实节点后即可连通。

---

## 3. 推送至 GitHub 并绑定 Cloudflare Pages

### 3.1 推送

```bash
git add .
git commit -m "feat: v2Ray on Browser 静态交付"
git push origin arena/01a019a5-v2ray-on-browser
# 在 GitHub 上将该分支合并至 main，或直接以该分支作为 Pages 源
```

### 3.2 创建 Pages 项目

1. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**。
2. 选择仓库 `RaymondTree/v2Ray-on-Browser`，分支 `main`（或 `arena/...`）。
3. **Build settings**：
   - Framework preset: `None`
   - Build command: **留空**（纯静态，无需构建）
   - Build output directory: `/`（或 `.`）
   - Root directory: `/`
4. **Deploy** → 等待分发完成，获得 `https://<project>.pages.dev`。
5. 检查 `_headers` 生效：
   ```bash
   curl -I https://<project>.pages.dev/xray.wasm | grep -i content-type
   # 期望：content-type: application/wasm
   ```

### 3.3 线上校验（与本地一致）

- 重复 §2.3 步骤，改用线上地址。
- 确认无 `SharedArrayBuffer` / `COOP/COEP` 相关报错（单线程 WASM 已规避）。

---

## 4. 替换为真实 xray-js 单线程 WASM

当前 `xray.wasm` 为 Mock（40 B）以保证可部署与演示。若需真实代理能力：

```bash
# 拉取官方 xray-js / xray-core
git clone https://github.com/your/xray-js.git
cd xray-js
# 单线程编译（关键：不启用 pthreads）
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o ../v2Ray-on-Browser/xray.wasm ./...
# 可选压缩
wasm-opt -Oz ../v2Ray-on-Browser/xray.wasm -o ../v2Ray-on-Browser/xray.wasm
ls -lh ../v2Ray-on-Browser/xray.wasm  # 需 <25 MiB
```

将新 `xray.wasm` 覆盖仓库根文件，`worker.js` 中 `connectTunnel` 已预留 `wasmInstance.exports._xray_run` 调用点，按 xray-js 实际 API 补全即可，无需改动其他模块。

同时将 `app.js` 顶部 `PRESETS` 替换为真实节点清单（同本地提供的数据），提交后重新部署 Pages 即可生效。

---

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `xray.wasm` 404 或 MIME 为 `application/octet-stream` | `_headers` 未生效或路径错误 | 确认文件位于根目录且无后缀，Pages 重新部署 |
| `SharedArrayBuffer is not defined` | 误用了多线程 WASM | 重新以单线程构建，检查不含 `pthread` |
| 预设节点连接失败 | 占位节点不可连通 | 替换为真实节点；或切换自定义模式 |
| iframe 无法显示目标站点 | 目标站 `X-Frame-Options: DENY` 或跨域 | 日志会显示状态码；尝试其他站点如 `https://example.com` |
| 本地证书警告 | 自签名未信任 | 忽略警告或导入 `cert.pem` |

---

## 6. 校验清单

- [ ] `https://127.0.0.1:12345` 本地可访问，WASM 就绪
- [ ] `xray.wasm` <25 MiB 且 `Content-Type: application/wasm`
- [ ] 自定义节点持久化至 `localStorage`
- [ ] 四种连接状态正确展示
- [ ] 代理浏览经隧道（日志可验证）
- [ ] 日志面板与流量统计正常
- [ ] 线上 Pages 行为与本地一致
