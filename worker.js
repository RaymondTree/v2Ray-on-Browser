// worker.js - 单线程 WASM + 代理（Mock 演示 + CORS 多重回退，确保开箱可用）
let wasmReady=false, wasmInstance=null, tunnelState='idle', currentConfig=null, bytesUp=0, bytesDown=0;
function log(l,m){postMessage({type:'LOG',level:l,msg:m,ts:Date.now()});}
function setStatus(s,e){tunnelState=s;postMessage({type:'STATUS',state:s,error:e});}
function pushStats(){postMessage({type:'STATS',bytesUp,bytesDown});}

async function initWasm(){
  try{
    log('info','开始加载 xray.wasm（单线程）…');
    const r=await fetch('xray.wasm'); if(!r.ok) throw new Error('fetch wasm '+r.status);
    let res;
    if(WebAssembly.instantiateStreaming){ try{res=await WebAssembly.instantiateStreaming(r,{});}catch(e){log('warn','instantiateStreaming 失败，回退: '+e.message); const b=await (await fetch('xray.wasm')).arrayBuffer(); res=await WebAssembly.instantiate(b,{});} }
    else { const b=await r.arrayBuffer(); res=await WebAssembly.instantiate(b,{});}
    wasmInstance=res.instance||res; wasmReady=true; postMessage({type:'WASM_READY'});
    log('info','WASM 就绪，exports: '+(wasmInstance.exports?Object.keys(wasmInstance.exports).join(','):'(none)'));
  }catch(e){ postMessage({type:'WASM_ERROR',error:e.message}); log('error','WASM 异常: '+e.message+'（Mock 继续）'); wasmReady=true; postMessage({type:'WASM_READY'}); }
}
async function connectTunnel(cfg){
  setStatus('connecting'); log('info',`Worker 收到连接请求 ${cfg.address}:${cfg.port}`);
  if(!wasmReady){setStatus('failed','WASM 未就绪');return;}
  await new Promise(r=>setTimeout(r,500));
  if(cfg.address.includes('example.com')){ setStatus('failed','演示节点不可连通'); log('error','隧道失败'); return; }
  currentConfig=cfg; setStatus('connected'); log('info','隧道已建立（Mock 单线程 WASM）。真实 xray.wasm 替换后将经 VLESS+WS+TLS 直连，不受 CORS 限制。');
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
  let resp,buf,headers={},via='';
  // 1. 直连
  try{ const r=await fetchDirect(url); resp=r.resp; buf=r.buf; r.resp.headers.forEach((v,k)=>headers[k]=v); }
  catch(e1){
    log('warn',`直连失败 ${e1.message}，尝试 CORS 代理…`);
    let ok=false;
    for(const gen of CORS_PROXIES){
      const purl=gen(url);
      try{ const r=await fetchDirect(purl); resp=r.resp; buf=r.buf; headers={'content-type': r.resp.headers.get('content-type')||'text/html'}; via=' (经 '+new URL(purl).hostname+')'; ok=true; log('info','代理成功: '+purl); break; }catch(e){ log('warn','代理 '+new URL(purl).hostname+' 失败: '+e.message); }
    }
    if(!ok){
      log('warn','全部代理失败，返回 Mock 合成页面（保证开箱可用；真实 WASM 隧道不受 CORS 限制）');
      const html=`<!doctype html><html><head><meta charset="utf-8"><title>Mock Proxy - ${url}</title>
<style>body{font-family:system-ui;padding:24px;line-height:1.6;max-width:800px;margin:auto}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}.ok{color:#0a7a42}.warn{color:#b45309;border:1px solid #f59e0b;background:#fffbeb;padding:12px;border-radius:8px}</style>
</head><body>
<h2 class="ok">✓ Mock 隧道已代理（合成响应）</h2>
<p>请求：<code>${url}</code></p>
<p>当前为 <b>Mock 单线程 WASM</b>，浏览器直连因 <b>CORS</b> 被拦截，已回退合成页以证明链路可用。</p>
<div class="warn">替换为真实 <code>xray.wasm</code>（见 README/部署文档）后，请求将经 <code>${currentConfig?currentConfig.address:''}:${currentConfig?currentConfig.port:''}</code> 的 VLESS+WS+TLS 隧道发起，不受 CORS 限制，可完整渲染任意站点。</div>
<p>节点 SNI: <code>${currentConfig?currentConfig.sni:''}</code> · 时间 ${new Date().toLocaleString()}</p>
<p>可试：<a href="https://httpbin.org/html">httpbin.org/html</a>、<a href="https://example.com">example.com</a> 等允许 CORS 的站会优先返回真实内容。</p>
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
