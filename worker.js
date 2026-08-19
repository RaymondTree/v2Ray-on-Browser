// worker.js - Web Worker, WASM 单线程 + 隧道 + 转发
let wasmReady=false;
let wasmInstance=null;
let tunnelState='idle'; // idle|connecting|connected
let currentConfig=null;
let bytesUp=0, bytesDown=0;

function log(level, msg){
  postMessage({type:'LOG', level, msg, ts: Date.now()});
}
function setStatus(state, error){
  tunnelState=state;
  postMessage({type:'STATUS', state, error});
}
function pushStats(){
  postMessage({type:'STATS', bytesUp, bytesDown});
}

async function initWasm(){
  try{
    log('info','开始加载 xray.wasm（单线程）…');
    const resp = await fetch('xray.wasm');
    if(!resp.ok) throw new Error('fetch wasm failed '+resp.status);
    let result;
    if(WebAssembly.instantiateStreaming){
      try{
        result = await WebAssembly.instantiateStreaming(resp, {env:{}, wasi_snapshot_preview1:{}});
      }catch(e){
        log('warn','instantiateStreaming 失败，回退 ArrayBuffer: '+e.message);
        const buf = await (await fetch('xray.wasm')).arrayBuffer();
        result = await WebAssembly.instantiate(buf, {env:{}, wasi_snapshot_preview1:{}});
      }
    } else {
      const buf = await resp.arrayBuffer();
      result = await WebAssembly.instantiate(buf, {});
    }
    wasmInstance = result.instance || result;
    wasmReady=true;
    postMessage({type:'WASM_READY'});
    log('info','WASM 实例化成功，exports: '+(wasmInstance.exports?Object.keys(wasmInstance.exports).join(','):'(none)'));
  }catch(e){
    postMessage({type:'WASM_ERROR', error: e.message});
    log('error','WASM 加载异常: '+e.message+'（将以 Mock 隧道继续演示）');
    // 即便失败也标记 ready 以允许 mock 连接演示
    wasmReady=true;
    postMessage({type:'WASM_READY'});
  }
}

// Mock 隧道：校验后延迟模拟连接；真实 xray-js 替换点在此
async function connectTunnel(cfg){
  setStatus('connecting');
  log('info',`Worker 收到连接请求 ${cfg.address}:${cfg.port}`);
  // 单线程 WASM 已就绪校验
  if(!wasmReady){ setStatus('failed','WASM 未就绪'); return; }
  // 模拟真实 xray-js 调用：若存在 wasm 导出则尝试调用
  try{
    if(wasmInstance && wasmInstance.exports && wasmInstance.exports._xray_run){
      log('info','调用 WASM _xray_run (mock)');
    }
    // WebSocket 可达性探测（不暴露真实 VLESS，仅做连通性演示）
    // 浏览器无法直接创建原始 TLS，需经节点 WS；此处仅演示握手流程
    await new Promise((r,j)=>{
      // 简单校验：若 address 包含 example.com 则模拟失败，提示替换
      if(cfg.address.includes('example.com')){
        setTimeout(()=> j(new Error('演示节点不可连通，请替换为真实 VLESS 节点')), 800);
      } else {
        setTimeout(r, 900);
      }
    });
    currentConfig=cfg;
    setStatus('connected');
    log('info','隧道已建立（Mock 单线程 WASM）。真实环境请替换 xray.wasm 为 xray-js 单线程编译产物并实现 VLESS 握手。');
  }catch(e){
    setStatus('failed', e.message);
    log('error','隧道建立失败: '+e.message);
  }
}

function disconnectTunnel(){
  currentConfig=null;
  setStatus('idle');
  log('info','隧道已断开');
}

// 代理转发：经隧道 fetch；Mock 模式下直接 fetch（演示流量统计）
async function handleProxyFetch(id, url){
  if(tunnelState!=='connected'){
    postMessage({type:'PROXY_RESPONSE', id, error:'未连接'});
    return;
  }
  try{
    log('info',`代理请求: ${url}`);
    const start=Date.now();
    // 真实实现应经 WASM 隧道发起；此处为演示：直接 fetch，并在日志中标注
    // 若站点禁止跨域，则捕获错误并回传
    const resp = await fetch(url, {headers:{'X-Proxied-By':'v2ray-on-browser'}});
    const buf = await resp.arrayBuffer();
    bytesDown+=buf.byteLength;
    bytesUp+= url.length; // 粗略
    pushStats();
    const headers={};
    resp.headers.forEach((v,k)=> headers[k]=v);
    log('info',`响应 ${resp.status} ${url} 耗时 ${Date.now()-start}ms ${buf.byteLength}B`);
    postMessage({type:'PROXY_RESPONSE', id, status:resp.status, headers, body: buf}, [buf]);
  }catch(e){
    log('error',`代理失败 ${url}: ${e.message}`);
    postMessage({type:'PROXY_RESPONSE', id, error: e.message});
  }
}

onmessage = async (e)=>{
  const m=e.data;
  if(m.type==='INIT_WASM') await initWasm();
  if(m.type==='CONNECT') await connectTunnel(m.payload);
  if(m.type==='DISCONNECT') disconnectTunnel();
  if(m.type==='PROXY_FETCH') await handleProxyFetch(m.id, m.url);
};

// 定期推送统计
setInterval(pushStats, 1000);
