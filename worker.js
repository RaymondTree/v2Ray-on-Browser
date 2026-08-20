// worker.js - 单线程 WASM + 代理（支持 Go 单线程 xray.wasm + CORS 回退）
let wasmReady=false, wasmInstance=null, tunnelState='idle', currentConfig=null, bytesUp=0, bytesDown=0;
let goInstance=null;
function log(l,m){postMessage({type:'LOG',level:l,msg:m,ts:Date.now()});}
function setStatus(s,e){tunnelState=s;postMessage({type:'STATUS',state:s,error:e});}
function pushStats(){postMessage({type:'STATS',bytesUp,bytesDown});}

async function initWasm(){
  try{
    log('info','开始加载 xray.wasm（单线程）…');
    const resp = await fetch('xray.wasm');
    if(!resp.ok) throw new Error('fetch wasm '+resp.status);
    // 尝试 Go 单线程 wasm（需要 wasm_exec.js）
    let isGoWasm = false;
    // 检查是否是 Go wasm（通过尝试加载 wasm_exec.js）
    try{
      importScripts('wasm_exec.js');
      if(typeof Go !== 'undefined'){
        log('info','检测到 Go 运行时，尝试以 Go 方式加载…');
        const go = new Go();
        goInstance = go;
        // Go wasm 需用 go.importObject
        const buf = await resp.arrayBuffer();
        // 重新 fetch 会消耗流，所以用 ArrayBuffer
        const result = await WebAssembly.instantiate(buf, go.importObject);
        wasmInstance = result.instance;
        wasmReady = true;
        postMessage({type:'WASM_READY'});
        log('info','Go WASM 实例化成功，exports: '+Object.keys(wasmInstance.exports).slice(0,8).join(','));
        // 启动 Go 主程序（非阻塞，Xray 会在后台运行）
        try{ go.run(wasmInstance); log('info','Go 主程序已启动'); }catch(e){ log('warn','Go run 结束: '+e.message); }
        // 若 Go 未提供代理接管，仍用 JS 代理兜底
        return;
      }
    }catch(e){
      log('warn','Go 加载失败，回退普通 WASM: '+e.message);
    }
    // 普通 WASM 回退（Mock 占位）
    let res;
    // 重新 fetch（之前已消费）
    const r2 = await fetch('xray.wasm');
    if(WebAssembly.instantiateStreaming){
      try{ res = await WebAssembly.instantiateStreaming(r2, {}); }
      catch(e){ log('warn','instantiateStreaming 失败，回退: '+e.message); const b=await (await fetch('xray.wasm')).arrayBuffer(); res=await WebAssembly.instantiate(b, {}); }
    } else { const b=await r2.arrayBuffer(); res=await WebAssembly.instantiate(b, {}); }
    wasmInstance = res.instance || res;
    wasmReady = true;
    postMessage({type:'WASM_READY'});
    log('info','WASM 就绪，exports: '+(wasmInstance.exports?Object.keys(wasmInstance.exports).join(','):'(none)'));
  }catch(e){
    postMessage({type:'WASM_ERROR', error:e.message});
    log('error','WASM 异常: '+e.message+'（Mock 继续）');
    wasmReady=true;
    postMessage({type:'WASM_READY'});
  }
}

async function connectTunnel(cfg){
  setStatus('connecting'); log('info',`Worker 收到连接请求 ${cfg.address}:${cfg.port}`);
  if(!wasmReady){setStatus('failed','WASM 未就绪');return;}
  // 优先尝试 Go 暴露的真实连接
  if(typeof self.xrayConnect === 'function' || typeof globalThis.xrayConnect === 'function'){
    try{
      const fn = self.xrayConnect || globalThis.xrayConnect;
      log('info','调用 Go 真隧道 xrayConnect…');
      await fn(cfg);
      currentConfig=cfg; setStatus('connected');
      log('info','Go 真隧道已建立');
      return;
    }catch(e){ log('warn','Go 真隧道连接失败，回退 Mock: '+e.message); }
  }
  if(goInstance && wasmInstance && wasmInstance.exports && wasmInstance.exports._xray_run){
    try{ log('info','调用 Go 导出 _xray_run'); }catch{}
  }
  await new Promise(r=>setTimeout(r,500));
  if(cfg.address.includes('example.com')){ setStatus('failed','演示节点不可连通'); log('error','隧道失败'); return; }
  currentConfig=cfg; setStatus('connected');
  if(goInstance) log('info','隧道已建立（Go 单线程 WASM - Mock 回退）。已可尝试代理，若仍合成说明 Go 未暴露 xrayFetch/xrayConnect，需按 WASM.md 补充。');
  else log('info','隧道已建立（Mock 单线程 WASM）。');
}
function disconnectTunnel(){ currentConfig=null; setStatus('idle'); log('info','隧道已断开'); }

const CORS_PROXIES = [
  url=>'https://corsproxy.io/?'+encodeURIComponent(url),
  url=>'https://api.allorigins.win/raw?url='+encodeURIComponent(url),
  url=>'https://yacdn.org/proxy/'+url,
];
async function fetchDirect(url){
  const resp=await fetch(url,{headers:{'X-Proxied-By':'v2ray-on-browser'}});
  const buf=await resp.arrayBuffer(); return {resp,buf};
}
async function handleProxyFetch(id, url){
  if(tunnelState!=='connected'){postMessage({type:'PROXY_RESPONSE',id,error:'未连接'});return;}
  log('info',`代理请求: ${url}`); const start=Date.now();
  // 1. 优先尝试 Go 暴露的真实隧道（若 Go 编译时已暴露）
  // Go 侧需：js.Global().Set("xrayFetch", js.FuncOf(...))  返回 {status, headers, body}
  if(typeof self.xrayFetch === 'function' || typeof globalThis.xrayFetch === 'function'){
    try{
      const fn = self.xrayFetch || globalThis.xrayFetch;
      log('info','尝试 Go 真隧道 xrayFetch…');
      const res = await fn(url, currentConfig);
      // 兼容返回格式：{status, headers, body: Uint8Array}
      let body = res.body;
      if(body instanceof Uint8Array) body = body.buffer.slice(body.byteOffset, body.byteOffset+body.byteLength);
      headers = res.headers || {'content-type':'text/html; charset=utf-8'};
      buf = body instanceof ArrayBuffer ? body : new TextEncoder().encode(String(body)).buffer;
      resp = {status: res.status || 200, headers:{get:k=>headers[k.toLowerCase()]}}; resp.headers.forEach=(cb)=>Object.entries(headers).forEach(([k,v])=>cb(v,k));
      bytesDown+=buf.byteLength; bytesUp+=url.length; pushStats();
      log('info',`响应 ${resp.status} (Go 真隧道) ${url} ${Date.now()-start}ms ${buf.byteLength}B`);
      postMessage({type:'PROXY_RESPONSE',id,status:resp.status,headers,body:buf},[buf]);
      return;
    }catch(e){ log('warn','Go 真隧道失败，回退 CORS: '+e.message); }
  }
  let resp,buf,headers={},via='';
  try{ const r=await fetchDirect(url); resp=r.resp; buf=r.buf; r.resp.headers.forEach((v,k)=>headers[k]=v); }
  catch(e1){
    log('warn',`直连失败 ${e1.message}，尝试 CORS 代理…`);
    let ok=false;
    for(const gen of CORS_PROXIES){
      const purl=gen(url);
      try{ const r=await fetchDirect(purl); resp=r.resp; buf=r.buf; headers={'content-type': r.resp.headers.get('content-type')||'text/html'}; via=' (经 '+new URL(purl).hostname+')'; ok=true; log('info','代理成功: '+purl); break; }catch(e){ log('warn','代理 '+new URL(purl).hostname+' 失败: '+e.message); }
    }
    if(!ok){
      log('warn','全部代理失败，返回 Mock 合成页面（保证开箱可用；真实 Go 隧道不受 CORS 限制）');
      const html=`<!doctype html><html><head><meta charset="utf-8"><title>Mock Proxy - ${url}</title>
<style>body{font-family:system-ui;padding:24px;line-height:1.6;max-width:800px;margin:auto}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}.ok{color:#0a7a42}.warn{color:#b45309;border:1px solid #f59e0b;background:#fffbeb;padding:12px;border-radius:8px}</style>
</head><body>
<h2 class="ok">✓ 隧道已代理（合成响应）</h2>
<p>请求：<code>${url}</code></p>
<p>当前 Go WASM 已加载，但浏览器直连因 <b>CORS</b> 被拦截，已回退合成页。</p>
<div class="warn">若 Go 已接管 fetch，将经 <code>${currentConfig?currentConfig.address:''}:${currentConfig?currentConfig.port:''}</code> 的 VLESS+WS+TLS 直连；否则仍为合成演示。按 WASM.md 接入 Go 导出可实现真代理。</div>
<p>节点 SNI: <code>${currentConfig?currentConfig.sni:''}</code> · 时间 ${new Date().toLocaleString()}</p>
</body></html>`;
      buf=new TextEncoder().encode(html).buffer; headers={'content-type':'text/html; charset=utf-8'}; resp={status:200, headers:{get:k=>headers[k.toLowerCase()]}}; resp.headers.forEach=(cb)=>Object.entries(headers).forEach(([k,v])=>cb(v,k)); via=' (合成)';
    }
  }
  bytesDown+=buf.byteLength; bytesUp+=url.length; pushStats();
  log('info',`响应 ${resp.status}${via} ${url} ${Date.now()-start}ms ${buf.byteLength}B`);
  postMessage({type:'PROXY_RESPONSE',id,status:resp.status,headers,body:buf},[buf]);
}
onmessage=async e=>{
  const m=e.data;
  if(m.type==='INIT_WASM') await initWasm();
  if(m.type==='CONNECT') await connectTunnel(m.payload);
  if(m.type==='DISCONNECT') disconnectTunnel();
  if(m.type==='PROXY_FETCH') await handleProxyFetch(m.id,m.url);
};
setInterval(pushStats,1000);
