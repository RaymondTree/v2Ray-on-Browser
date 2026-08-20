// v2Ray-on-Browser - 主线程
const PRESETS = [
  {
    name: "SG:443 WS=/ SNI=raymondtree.ccwu.cc",
    address: "178.128.20.158",
    port: 443,
    uuid: "295db427-d187-415b-889b-8951e34d571c",
    wsPath: "/",
    sni: "raymondtree.ccwu.cc"
  },
];

// 解析 vless://uuid@host:port?params 链接，返回 VlessConfig 或 null
function parseVless(link){
  try{
    link=link.trim();
    if(!link.toLowerCase().startsWith('vless://')) return null;
    // 处理 vless 链接中以 &amp; 编码的情况
    link=link.replace(/&amp;/g,'&');
    const u=new URL(link);
    const uuid=decodeURIComponent(u.username || u.pathname.replace(/^\/\//,'').split('@')[0] || '');
    // URL 解析对 vless 不完全兼容，手动回退解析
    let hostPort = u.host;
    let uuid2=uuid;
    if(!hostPort || !uuid2){
      const m=link.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)/i);
      if(m){ uuid2=m[1]; hostPort=m[2]+':'+m[3]; }
    }
    const address = u.hostname || hostPort.split(':')[0] || '';
    const port = parseInt(u.port || hostPort.split(':')[1] || '443',10);
    const wsPath = u.searchParams.get('path') || '/';
    const sni = u.searchParams.get('sni') || u.searchParams.get('peer') || u.searchParams.get('host') || address;
    // uuid 可能含在 username
    const finalUuid = uuid2 || u.username;
    if(!finalUuid || !address) return null;
    return { address, port, uuid: finalUuid, wsPath: decodeURIComponent(wsPath), sni };
  }catch{ return null; }
}

const LS_KEY = "v2ray-custom-nodes";

const els = {
  modeRadios: [...document.querySelectorAll('input[name="nodeMode"]')],
  presetWrap: document.getElementById('presetWrap'),
  presetSelect: document.getElementById('presetSelect'),
  address: document.getElementById('inpAddress'),
  port: document.getElementById('inpPort'),
  uuid: document.getElementById('inpUuid'),
  wsPath: document.getElementById('inpWsPath'),
  sni: document.getElementById('inpSni'),
  badge: document.getElementById('statusBadge'),
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnClearStorage: document.getElementById('btnClearStorage'),
  wasmStatus: document.getElementById('wasmStatus'),
  inpUrl: document.getElementById('inpUrl'),
  btnGo: document.getElementById('btnGo'),
  btnBack: document.getElementById('btnBack'),
  btnForward: document.getElementById('btnForward'),
  btnRefresh: document.getElementById('btnRefresh'),
  browserView: document.getElementById('browserView'),
  browserStatus: document.getElementById('browserStatus'),
  trafficStat: document.getElementById('trafficStat'),
  logPanel: document.getElementById('logPanel'),
  logFilter: document.getElementById('logFilter'),
  btnClearLog: document.getElementById('btnClearLog'),
  btnExportLog: document.getElementById('btnExportLog'),
  statUp: document.getElementById('statUp'),
  statDown: document.getElementById('statDown'),
  statReq: document.getElementById('statReq'),
};

let state = "idle"; // idle|connecting|connected|failed
let worker;
let bytesUp = 0, bytesDown = 0, reqCount = 0;
let historyStack = ["https://example.com"];
let historyIndex = 0;
let logs = [];

function formatBytes(n){
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(2)+' MB';
}

function pushLog(level, msg){
  const entry = {level, msg, ts: Date.now()};
  logs.push(entry);
  if(logs.length>1000) logs.shift();
  renderLogs();
  if(level==='error') console.error(msg);
}
function renderLogs(){
  const filter = els.logFilter.value;
  els.logPanel.innerHTML = '';
  logs.filter(l=>filter==='all'||l.level===filter).slice(-300).forEach(l=>{
    const div=document.createElement('div');
    div.className=`log-line ${l.level}`;
    const t=new Date(l.ts).toLocaleTimeString();
    div.textContent=`[${t}] [${l.level}] ${l.msg}`;
    els.logPanel.appendChild(div);
  });
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function setStatus(s, err){
  state=s;
  els.badge.textContent = {idle:'未连接', connecting:'连接中', connected:'已连接', failed:'连接失败'}[s];
  els.badge.className='badge '+s;
  els.btnConnect.disabled = s==='connecting'||s==='connected';
  els.btnDisconnect.disabled = s!=='connected'&&s!=='connecting';
  // disable form when connected/preset
  const isPreset = getMode()==='preset';
  const disabled = s==='connected'||s==='connecting'||isPreset;
  // in preset mode always readonly; in connected also readonly
  [els.address, els.port, els.uuid, els.wsPath, els.sni].forEach(i=> i.disabled = isPreset || s==='connected' || s==='connecting');
  els.presetSelect.disabled = s==='connected'||s==='connecting';
  if(err) pushLog('error', err);
}

function getMode(){ return document.querySelector('input[name="nodeMode"]:checked').value; }
function getFormConfig(){
  return {
    address: els.address.value.trim(),
    port: parseInt(els.port.value,10),
    uuid: els.uuid.value.trim(),
    wsPath: els.wsPath.value.trim()||"/",
    sni: els.sni.value.trim()||els.address.value.trim(),
  };
}
function setFormConfig(c){
  els.address.value=c.address||"";
  els.port.value=c.port||443;
  els.uuid.value=c.uuid||"";
  els.wsPath.value=c.wsPath||"/";
  els.sni.value=c.sni||"";
}
function validate(cfg){
  if(!cfg.address) return "地址不能为空";
  if(!cfg.port||cfg.port<1||cfg.port>65535) return "端口需 1-65535";
  const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuidRe.test(cfg.uuid)) return "UUID 格式不正确";
  if(!cfg.wsPath.startsWith("/")) return "WebSocket 路径需以 / 开头";
  if(cfg.sni && !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(cfg.sni) && !/^\d+\.\d+\.\d+\.\d+$/.test(cfg.sni)) return "SNI 格式不正确";
  return null;
}

function saveCustom(){
  if(getMode()!=='custom') return;
  localStorage.setItem(LS_KEY, JSON.stringify(getFormConfig()));
}
function loadCustom(){
  try{
    const v=JSON.parse(localStorage.getItem(LS_KEY)||"null");
    if(v) setFormConfig(v);
  }catch{}
}

function initPresetSelect(){
  els.presetSelect.innerHTML='';
  PRESETS.forEach((p,i)=>{
    const o=document.createElement('option');
    o.value=i; o.textContent=`${p.name} - ${p.address}:${p.port}`;
    els.presetSelect.appendChild(o);
  });
  els.presetSelect.addEventListener('change', ()=>{
    const p=PRESETS[parseInt(els.presetSelect.value,10)];
    if(p) setFormConfig(p);
  });
  if(PRESETS[0]) setFormConfig(PRESETS[0]);
}

function updateModeUI(){
  const mode=getMode();
  if(mode==='preset'){
    els.presetWrap.classList.remove('hidden');
    const p=PRESETS[parseInt(els.presetSelect.value,10)]||PRESETS[0];
    if(p) setFormConfig(p);
  } else {
    els.presetWrap.classList.add('hidden');
    loadCustom();
  }
  setStatus(state);
}

// Worker bridge
function initWorker(){
  worker = new Worker('worker.js');
  worker.onmessage = (e)=>{
    const m=e.data;
    if(m.type==='WASM_READY'){ els.wasmStatus.textContent='WASM: 就绪（单线程）'; pushLog('info','WASM 加载成功'); }
    if(m.type==='WASM_ERROR'){ els.wasmStatus.textContent='WASM: 加载失败 - '+m.error; pushLog('error','WASM 错误: '+m.error); }
    if(m.type==='STATUS'){ setStatus(m.state, m.error); if(m.state==='connected') pushLog('info','隧道已建立'); if(m.state==='failed') pushLog('error','连接失败: '+(m.error||'')); }
    if(m.type==='LOG'){ pushLog(m.level, m.msg); }
    if(m.type==='STATS'){ bytesUp=m.bytesUp; bytesDown=m.bytesDown; els.statUp.textContent=formatBytes(bytesUp); els.statDown.textContent=formatBytes(bytesDown); els.trafficStat.textContent=`↑ ${formatBytes(bytesUp)} · ↓ ${formatBytes(bytesDown)}`; }
    if(m.type==='PROXY_RESPONSE'){ handleProxyResponse(m); }
  };
  worker.onerror=(e)=>{ pushLog('error','Worker 异常: '+e.message); setStatus('failed', e.message); };
  worker.postMessage({type:'INIT_WASM'});
  pushLog('info','Worker 已启动，正在加载 WASM…');
}

let pendingFetches = new Map();
let lastBlobUrl=null;

function proxyFetch(url){
  if(state!=='connected'){ pushLog('warn','未连接，无法代理请求: '+url); els.browserStatus.textContent='未连接'; return; }
  const id=Math.random().toString(36).slice(2);
  reqCount++; els.statReq.textContent=reqCount;
  pushLog('info',`HTTP ${url}`);
  els.browserStatus.textContent='加载中…';
  pendingFetches.set(id, url);
  worker.postMessage({type:'PROXY_FETCH', id, url});
}

function handleProxyResponse(m){
  const url=pendingFetches.get(m.id);
  pendingFetches.delete(m.id);
  if(m.error){ pushLog('error',`请求失败 ${url}: ${m.error}`); els.browserStatus.textContent='加载失败'; return; }
  // update stats from worker already via STATS, but also count here
  if(m.body) bytesDown+=m.body.byteLength;
  els.browserStatus.textContent=`${m.status} · ${url}`;
  let blob;
  const ct=(m.headers['content-type']||'').toLowerCase();
  if(ct.includes('text/html')){
    let text=new TextDecoder().decode(m.body);
    try{
      const u=new URL(url);
      const base=`<base href="${u.origin}/" target="_self">`;
      const interceptScript=`<script>
(function(){
  document.addEventListener('click', function(e){
    const a=e.target.closest('a');
    if(!a||!a.href) return;
    if(a.target==='_blank') a.removeAttribute('target');
    if(a.href.startsWith('http')){
      e.preventDefault();
      parent.postMessage({type:'iframe-navigate', url:a.href}, '*');
    }
  }, true);
  const _open=window.open;
  window.open=function(u){ if(u) parent.postMessage({type:'iframe-navigate', url:u}, '*'); return null; };
})();
</scr`+`ipt>`;
      if(text.includes('<head>')) text=text.replace('<head>', `<head>${base}${interceptScript}`);
      else text=base+interceptScript+text;
      text=text.replace(/target\s*=\s*["_']_blank["_']/gi, 'target="_self"');
    }catch{}
    blob=new Blob([text], {type:'text/html'});
  } else {
    const type=ct||'application/octet-stream';
    blob=new Blob([m.body], {type});
  }
  if(lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  lastBlobUrl=URL.createObjectURL(blob);
  els.browserView.src=lastBlobUrl;
}

window.addEventListener('message', e=>{ if(e.data && e.data.type==='iframe-navigate' && e.data.url){ let u=e.data.url; try{ if(!/^https?:\/\//i.test(u)) u=new URL(u, els.inpUrl.value).href; }catch{} pushLog('info','iframe 内导航: '+u); navigate(u); } });

function navigate(url, pushHistory=true){
  // normalize
  if(!/^https?:\/\//i.test(url)) url='https://'+url;
  try{ new URL(url); }catch{ pushLog('error','URL 不合法: '+url); return; }
  els.inpUrl.value=url;
  if(pushHistory){
    historyStack = historyStack.slice(0, historyIndex+1);
    historyStack.push(url);
    historyIndex=historyStack.length-1;
  }
  proxyFetch(url);
}

// Events
els.modeRadios.forEach(r=> r.addEventListener('change', updateModeUI));
els.presetSelect.addEventListener('change', ()=>{ if(getMode()==='preset') { const p=PRESETS[parseInt(els.presetSelect.value,10)]; if(p) setFormConfig(p); }});
['input','change'].forEach(ev=>{
  [els.address, els.port, els.uuid, els.wsPath, els.sni].forEach(el=> el.addEventListener(ev, saveCustom));
});
function normalizeConfig(cfg){
  // 若 address 栏误粘贴整条 vless 链接，自动解析
  if(cfg.address && cfg.address.toLowerCase().startsWith('vless://')){
    const p=parseVless(cfg.address);
    if(p){ pushLog('info','检测到 vless 链接，已自动解析为地址/端口/UUID/WS路径/SNI'); return p; }
  }
  return cfg;
}
els.btnConnect.addEventListener('click', ()=>{
  let cfg = getMode()==='preset' ? PRESETS[parseInt(els.presetSelect.value,10)] : getFormConfig();
  cfg = normalizeConfig(cfg);
  if(getMode()!=='preset' && cfg.address!==getFormConfig().address) setFormConfig(cfg);
  const err=validate(cfg);
  if(err){ pushLog('error', err); setStatus('failed', err); return; }
  setStatus('connecting');
  pushLog('info',`正在连接 ${cfg.address}:${cfg.port} WS=${cfg.wsPath} SNI=${cfg.sni}`);
  worker.postMessage({type:'CONNECT', payload: cfg});
});
els.btnDisconnect.addEventListener('click', ()=>{
  worker.postMessage({type:'DISCONNECT'});
  setStatus('idle');
  pushLog('info','已断开');
});
els.btnClearStorage.addEventListener('click', ()=>{
  localStorage.removeItem(LS_KEY);
  pushLog('info','已清除本地保存');
});
els.btnGo.addEventListener('click', ()=> navigate(els.inpUrl.value));
els.inpUrl.addEventListener('keydown', e=>{ if(e.key==='Enter') navigate(els.inpUrl.value); });
els.btnBack.addEventListener('click', ()=>{
  if(historyIndex>0){ historyIndex--; navigate(historyStack[historyIndex], false); }
});
els.btnForward.addEventListener('click', ()=>{
  if(historyIndex<historyStack.length-1){ historyIndex++; navigate(historyStack[historyIndex], false); }
});
els.btnRefresh.addEventListener('click', ()=>{ const u=historyStack[historyIndex]||els.inpUrl.value; proxyFetch(u); });
els.btnClearLog.addEventListener('click', ()=>{ logs=[]; renderLogs(); });
els.logFilter.addEventListener('change', renderLogs);
els.btnExportLog.addEventListener('click', ()=>{
  const blob=new Blob([JSON.stringify(logs,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='v2ray-log.json'; a.click();
});

// init
initPresetSelect();
loadCustom();
updateModeUI();
initWorker();
setStatus('idle');
pushLog('info','页面已就绪。请选择节点并连接后使用代理浏览。');
