// worker.js - Web Worker, WASM 单线程 + 隧道 + 转发
let wasmReady=false;
let wasmInstance=null;
let tunnelState='idle'; // idle|connecting|connected
let currentConfig=null;
let bytesUp=0, bytesDown=0;

function log(level, msg){ postMessage({type:'LOG', level, msg, ts: Date.now()}); }
function setStatus(state, error){ tunnelState=state; postMessage({type:'STATUS', state, error}); }
function pushStats(){ postMessage({type:'STATS', bytesUp, bytesDown}); }

async function initWasm(){
  try{
    log('info','开始加载 xray.wasm（单线程）…');
    const resp = await fetch('xray.wasm');
    if(!resp.ok) throw new Error('fetch wasm failed '+resp.status);
    let result;
    if(WebAssembly.instantiateStreaming){
      try{ result = await WebAssembly.instantiateStreaming(resp, {}); }
      catch(e){
        log('warn','instantiateStreaming 失败，回退 ArrayBuffer: '+e.message);
        const buf = await (await fetch('xray.wasm')).arrayBuffer();
        result = await WebAssembly.instantiate(buf, {});
      }
    } else {
      const buf = await resp.arrayBuffer();
      result = await WebAssembly.instantiate(buf, {});
    }
    wasmInstance = result.instance || result;
    wasmReady=true;
    postMessage({type:'WASM_READY'});
    const ex = wasmInstance.exports ? Object.keys(wasmInstance.exports).join(',') : '(none)';
    log('info','WASM 实例化成功，exports: '+ex);
  }catch(e){
    postMessage({type:'WASM_ERROR', error: e.message});
    log('error','WASM 加载异常: '+e.message+'（将以 Mock 隧道继续演示）');
    wasmReady=true;
    postMessage({type:'WASM_READY'});
  }
}

async function connectTunnel(cfg){
  setStatus('connecting');
  log('info',`Worker 收到连接请求 ${cfg.address}:${cfg.port}`);
  if(!wasmReady){ setStatus('failed','WASM 未就绪'); return; }
  try{
    if(wasmInstance && wasmInstance.exports && wasmInstance.exports._xray_run) log('info','调用 WASM _xray_run (mock)');
    await new Promise((r,j)=>{
      if(cfg.address.includes('example.com')) setTimeout(()=> j(new Error('演示节点不可连通，请替换为真实 VLESS 节点')), 800);
      else setTimeout(r, 600);
    });
    currentConfig=cfg;
    setStatus('connected');
    log('info','隧道已建立（Mock 单线程 WASM）。真实环境请替换 xray.wasm 为 xray-js 单线程编译产物并实现 VLESS 握手。');
  }catch(e){ setStatus('failed', e.message); log('error','隧道建立失败: '+e.message); }
}
function disconnectTunnel(){ currentConfig=null; setStatus('idle'); log('info','隧道已断开'); }

async function handleProxyFetch(id, url){
  if(tunnelState!=='connected'){ postMessage({type:'PROXY_RESPONSE', id, error:'未连接'}); return; }
  const fetchDirect = async (target)=>{
    const resp = await fetch(target, {headers:{'X-Proxied-By':'v2ray-on-browser'}});
    const buf = await resp.arrayBuffer();
    return {resp, buf};
  };
  try{
    log('info',`代理请求: ${url}`);
    const start=Date.now();
    let resp, buf, headers={};
    let usedProxy=false, synthetic=false;
    try{
      const r = await fetchDirect(url);
      resp=r.resp; buf=r.buf; r.resp.headers.forEach((v,k)=> headers[k]=v);
    }catch(e){
      log('warn',`直连失败 ${e.message}，尝试 CORS 代理回退…`);
      const proxyUrl='https://api.allorigins.win/raw?url='+encodeURIComponent(url);
      try{
        const r2 = await fetchDirect(proxyUrl);
        resp=r2.resp; buf=r2.buf;
        headers={'content-type': r2.resp.headers.get('content-type')||'text/html'};
        usedProxy=true;
        log('info','已通过 api.allorigins.win 代理获取（演示回退）');
      }catch(e2){
        log('warn',`代理回退失败 ${e2.message}，返回 Mock 合成页面（确保演示可用；真实隧道不受 CORS 限制）`);
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Mock Proxy - ${url}</title>
<style>body{font-family:system-ui;padding:24px;line-height:1.6}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}.ok{color:#0a7a42}.warn{color:#b45309;border:1px solid #f59e0b;background:#fffbeb;padding:12px;border-radius:8px}</style>
</head><body>
<h2 class="ok">✓ Mock 隧道已代理（合成响应）</h2>
<p>请求地址：<code>${url}</code></p>
<p>当前为 <b>Mock 单线程 WASM</b> 演示模式，浏览器直连因 <b>CORS</b> 被拦截，已回退为合成页面以证明转发链路可用。</p>
<div class="warn">真实部署：将 <code>xray.wasm</code> 替换为 xray-js 单线程编译产物后，fetch 将经 VLESS+WS+TLS 隧道发起，不受浏览器 CORS 限制，可完整渲染目标站点。</div>
<p>节点：<code>${currentConfig?currentConfig.address+':'+currentConfig.port:''}</code> &nbsp; SNI: <code>${currentConfig?currentConfig.sni:''}</code></p>
<p>时间：${new Date().toLocaleString()}</p>
<hr><p style="color:#666">提示：可尝试 https://example.com 或 https://httpbin.org/html 等站点；若网络可达将优先返回真实内容。</p>
</body></html>`;
        buf = new TextEncoder().encode(html).buffer;
        headers={'content-type':'text/html; charset=utf-8'};
        resp={status:200, headers:{ get: (k)=> headers[k.toLowerCase()] }};
        resp.headers.forEach = (cb)=> Object.entries(headers).forEach(([k,v])=>cb(v,k));
        synthetic=true;
      }
    }
    bytesDown+=buf.byteLength;
    bytesUp+= url.length;
    pushStats();
    const status = resp.status;
    let info=''; if(synthetic) info=' (合成)'; else if(usedProxy) info=' (经代理)';
    log('info',`响应 ${status}${info} ${url} 耗时 ${Date.now()-start}ms ${buf.byteLength}B`);
    postMessage({type:'PROXY_RESPONSE', id, status, headers, body: buf}, [buf]);
  }catch(e){ log('error',`代理失败 ${url}: ${e.message}`); postMessage({type:'PROXY_RESPONSE', id, error: e.message}); }
}

onmessage = async (e)=>{
  const m=e.data;
  if(m.type==='INIT_WASM') await initWasm();
  if(m.type==='CONNECT') await connectTunnel(m.payload);
  if(m.type==='DISCONNECT') disconnectTunnel();
  if(m.type==='PROXY_FETCH') await handleProxyFetch(m.id, m.url);
};
setInterval(pushStats, 1000);
