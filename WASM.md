# WASM.md — 编译真实 xray WASM（单线程，<25 MiB）

> 目标：把 `xray.wasm` 从 42B 占位替换为可真实走 `VLESS+WS+TLS` 的单线程产物，替换后 `npm run serve:https` 即真正经 `178.128.20.158:443` 隧道拉取任意网站，不再走 `corsproxy`。

---

## 1. 为什么需要编译

- 仓库自带的 `xray.wasm` 是合法空模块（仅导出 `_xray_run`），用于通过 Cloudflare Pages 的 `application/wasm` 与体积校验，保证 `clone + npm install` 开箱可用。
- 真正的 VLESS 握手、WS 封装、TLS 转发逻辑在 `Xray-core`（Go）里，需编译为 `GOOS=js GOARCH=wasm` 单线程产物。

## 2. 编译环境准备

| 要求 | 说明 |
|---|---|
| OS | Ubuntu 20.04+ / macOS / Windows WSL2 均可 |
| Go | **1.21+**（推荐 1.22），`go version` 能输出 |
| Git | 拉取源码 |
| 可选 | `binaryen` 的 `wasm-opt`（压缩，可让 20+ MiB 压到 10 MiB 内） |

### 安装 Go（Ubuntu）

```bash
# 卸载旧版
sudo rm -rf /usr/local/go

# 下载（以 1.22.5 为例）
curl -L https://go.dev/dl/go1.22.5.linux-amd64.tar.gz -o /tmp/go.tar.gz
sudo tar -C /usr/local -xzf /tmp/go.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc && source ~/.bashrc
go version  # 应显示 go1.22.x
```

### 安装 wasm-opt（可选）

```bash
# Ubuntu
sudo apt install binaryen
wasm-opt --version

# macOS
brew install binaryen
```

## 3. 获取源码

有两条路线，二选一：

### 路线 A：直接编 Xray-core（适合想自己裁剪）

```bash
git clone https://github.com/XTLS/Xray-core.git /tmp/xray
cd /tmp/xray
git log --oneline -1  # 记录 commit，后续可写进 README
```

### 路线 B：用 xray-js 封装（已处理 JS 胶水，推荐）

```bash
git clone https://github.com/sohaha/xray-js.git /tmp/xray-js
# 或 https://github.com/mzz2017/gg 等，选你熟悉的封装
cd /tmp/xray-js
```

下文以 **Xray-core** 为例，`xray-js` 只需把 `go build` 的包路径换成其入口即可。

## 4. 单线程编译（关键）

**必须单线程**，否则会依赖 `SharedArrayBuffer` + `COOP/COEP` 头，Cloudflare Pages 无法满足。

在源码根执行：

```bash
# 单线程，不启用 pthreads
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /tmp/xray.wasm ./main

# 若 ./main 不存在，试：
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /tmp/xray.wasm .

# 查看体积
ls -lh /tmp/xray.wasm
# 期望 <25 MiB，若 >25 MiB 见 §6 裁剪
```

> `-ldflags="-s -w"` 去符号，`-trimpath` 去路径，均可显著减小体积。

## 5. 压缩与校验

```bash
# 压缩（若装了 wasm-opt）
wasm-opt -Oz /tmp/xray.wasm -o /tmp/xray.wasm
ls -lh /tmp/xray.wasm

# 校验可实例化
node -e "import fs from 'fs'; WebAssembly.instantiate(fs.readFileSync('/tmp/xray.wasm')).then(r=>console.log('ok',Object.keys(r.instance.exports).slice(0,5))).catch(e=>console.log('fail',e.message))" --input-type=module

# 体积 <25 MiB 检查
python3 -c "import os; s=os.path.getsize('/tmp/xray.wasm'); print(f'{s/1024/1024:.2f} MiB', s < 25*1024*1024)"
```

## 6. 体积超限怎么裁

若直编 >25 MiB：

1. 用 `wasm-opt -Oz`（通常 -30%）
2. 裁剪 Xray 的 `config`：只保留 `vless / ws / tls / freedom / dns`，移除 `vmess / trojan / h2 / grpc / routing` 等（改 `core/*.go` 的 import）
3. 改用 `tinygo` 编译（体积更小，但需适配）
4. 终极：改用 `xray-js` 的精简分支，已预裁剪

## 7. 替换到本项目

```bash
cp /tmp/xray.wasm ~/v2Ray-on-Browser/xray.wasm
cd ~/v2Ray-on-Browser
ls -lh xray.wasm  # 确认 <25 MiB

# 本地验证
npm run serve:https
# 浏览器开 https://127.0.0.1:12345
# 连接 178.128.20.158:443 成功后，访问 https://www.baidu.com / https://www.google.com
# 日志应显示“响应 200”而非“(合成)”，且不再出现 corsproxy.io
```

### 让 worker 真正调用

当前 `worker.js` 已预留：

```js
if(wasmInstance.exports._xray_run) // 真 WASM 需导出此符号
```

- 若你的 WASM 导出名不同（如 `run`、`main`），改 `worker.js: connectTunnel` 里的导出名即可。
- 完整接管示例（在 `worker.js: handleProxyFetch` 中）：

```js
// 伪代码：经 WASM 隧道 fetch
const out = wasmInstance.exports.xray_fetch(urlPtr, urlLen);
```

具体以 `xray-js` 的 JS 胶水为准，直接按其 README 替换 `worker.js` 的 `handleProxyFetch` 即可。

## 8. 推送与 Cloudflare Pages

```bash
git add xray.wasm
git commit -m "feat: 替换为真实单线程 xray.wasm"
git push origin main
```

Pages 会自动重新部署，线上同样走真隧道。检查：

```bash
curl -I https://你的pages.dev/xray.wasm | grep -i content-type
# 必须 application/wasm（由根目录 _headers 保证）
```

## 9. 常见失败

| 现象 | 原因 | 解决 |
|---|---|---|
| `wasm validation error` | 多线程产物或 Go 版本过旧 | 重编时确保无 `-pthread`，`go version >=1.21` |
| `SharedArrayBuffer is not defined` | 误用多线程 | 单线程编译，不设 `COOP/COEP` |
| 体积 30+ MiB | 未裁剪 | `wasm-opt -Oz` + 裁 `import` |
| 本地 `NetworkError` 仍合成 | 未替换 `worker.js` 的 fetch 逻辑 | 按 §7 接入真导出 |
| Pages 上 `xray.wasm` 404 | 路径错 | 文件必须在仓库根，与 `index.html` 同级 |

## 10. 一键脚本（可选）

保存为 `scripts/build-wasm.sh`：

```bash
#!/usr/bin/env bash
set -e
SRC=/tmp/xray
OUT=$(pwd)/xray.wasm
[ -d $SRC ] || git clone https://github.com/XTLS/Xray-core.git $SRC
cd $SRC
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $OUT ./main
which wasm-opt && wasm-opt -Oz $OUT -o $OUT || true
ls -lh $OUT
```

```bash
chmod +x scripts/build-wasm.sh && ./scripts/build-wasm.sh
```

---

完成后，`xray.wasm` 即为真内核，`npm install` 开箱即真正经你的 VLESS 代理访问任意网站。
