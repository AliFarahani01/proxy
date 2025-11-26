import { WSProxy } from './wsproxy.js';


const NODES = [
  "https://1.1.1.1/",
  "https://8.8.8.8/",
  "https://9.9.9.9/",
  "https://208.67.222.222/",
  "https://76.76.2.0/"
];

const CACHE_TTL = 20;
const BENCH_TIMEOUT = 1500;
const FETCH_TIMEOUT = 25000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024; // 2MB

addEventListener("fetch", e => e.respondWith(handleRequest(e.request)));

async function handleRequest(req) {
  const url = new URL(req.url);

  // Admin dashboard
  if (url.searchParams.has("admin")) return handleAdmin(req, url);

  // WebSocket upgrade -> Durable Object
  if (url.searchParams.has("ws")) {
    const id = WS_DO.idFromName(url.toString());
    const obj = WS_DO.get(id);
    return obj.fetch(req);
  }

  // UI if no ?url
  if (!url.searchParams.has("url")) return uiPage();

  // Auth
  const token = globalThis.AUTH_TOKEN || "";
  const provided = url.searchParams.get("t") || req.headers.get("x-auth-token") || "";
  if (!token || provided !== token) return new Response("Unauthorized", { status: 401 });

  const target = normalizeUrl(decodeURIComponent(url.searchParams.get("url")));
  const method = req.method.toUpperCase();
  const cacheKey = `v6::${target}::${method}`;
  const cache = caches.default;

  // Cache GET/HEAD
  if (method === "GET" || method === "HEAD") {
    const cached = await cache.match(cacheKey);
    if (cached) return addHeaders(cached, "HIT");
  }

  // Fastest node
  const node = await pickFastestNode(NODES);

  // Proxy fetch
  const resp = await proxyFetch(req, target, node);

  // Headers
  const headers = new Headers(resp.headers);
  removeHopHeaders(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Via", "UltraProxy-v6");
  if (node) headers.set("X-Node", node);

  // HTML rewrite + JS injection
  const contentType = headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await resp.text();
    const rewritten = rewriteHTML(html, baseFor(target));
    const injected = rewritten + injectJS();
    const buffer = new TextEncoder().encode(injected);

    if (method === "GET" && buffer.byteLength <= MAX_CACHE_BYTES) {
      const respCache = new Response(buffer, { status: resp.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `max-age=${CACHE_TTL}` }});
      await cache.put(cacheKey, respCache.clone());
    }

    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(buffer, { status: resp.status, headers });
  }

  // Binary passthrough
  const buffer = await resp.arrayBuffer();
  if (method === "GET" && buffer.byteLength <= MAX_CACHE_BYTES) {
    const respCache = new Response(buffer, { status: resp.status, headers: { "Cache-Control": `max-age=${CACHE_TTL}` }});
    await cache.put(cacheKey, respCache.clone());
  }

  return new Response(buffer, { status: resp.status, headers });
}

/* ---------------- Utilities ---------------- */
function jsonJSON(){ return { "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":"*" }; }
function addHeaders(resp, cacheHit="MISS") {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Ultra-Proxy-Cache", cacheHit);
  return new Response(resp.body, { status: resp.status, headers });
}
function normalizeUrl(u){ return /^\s*https?:\/\//i.test(u) ? u.trim() : "http://" + u.trim(); }
function removeHopHeaders(headers){ ["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade"].forEach(h=>headers.delete(h)); }
function baseFor(target){ try { const u = new URL(target); return u.origin + u.pathname.replace(/\/[^\/]*$/,''); } catch { return target; } }

/* Node benchmarking */
async function pickFastestNode(nodes){
  const results = await Promise.all(nodes.map(n=>benchNode(n,BENCH_TIMEOUT)));
  let best = nodes[0], bestTime = Infinity;
  results.forEach((t,i)=>{ if(t<bestTime){ bestTime=t; best=nodes[i]; }});
  return best;
}
async function benchNode(node, timeout){
  const c=new AbortController(), id=setTimeout(()=>c.abort(),timeout);
  const start=Date.now();
  try{ const r=await fetch(node,{method:"HEAD",signal:c.signal}); clearTimeout(id); return Date.now()-start; }
  catch{ clearTimeout(id); return Infinity; }
}

/* Proxy fetch */
async function proxyFetch(req,target,node){
  const headers=new Headers();
  req.headers.forEach((v,k)=>{ if(!["host","content-length","connection","upgrade-insecure-requests"].includes(k.toLowerCase())) headers.set(k,v); });
  headers.set("Via","UltraProxy-v6"); if(node) headers.set("X-Node",node);
  const opts={method:req.method,headers,redirect:"follow",cf:{cacheTtl:0}};
  if(req.method!=="GET" && req.method!=="HEAD") opts.body=await req.arrayBuffer();
  return fetchWithTimeout(target,opts,FETCH_TIMEOUT);
}
function fetchWithTimeout(url,opts,timeout){ const c=new AbortController(); opts.signal=c.signal; const id=setTimeout(()=>c.abort(),timeout); return fetch(url,opts).finally(()=>clearTimeout(id)); }

/* HTML rewrite + JS injector */
function rewriteHTML(html,base){
  html=html.replace(/(href|src|action)=["']([^"']+)["']/gi,(m,a,u)=>`${a}="${resourceProxy(u,base)}"`);
  html=html.replace(/url\(([^)]+)\)/gi,(m,u)=>`url(${resourceProxy(u.replace(/^['"]|['"]$/g,''),base)})`);
  return html;
}
function resourceProxy(u,base){
  if(/^\s*https?:\/\//i.test(u)) return `?url=${encodeURIComponent(u)}`;
  if(/^\s*\/\//.test(u)) return `?url=${encodeURIComponent("http:"+u)}`;
  if(/^\s*\//.test(u)) return `?url=${encodeURIComponent(base+u)}`;
  return `?url=${encodeURIComponent(base+"/"+u)}`;
}
function injectJS(){ return `<script>(function(){const F=window.fetch.bind(window);window.fetch=(u,o)=>{if(typeof u==='string')u=u.startsWith('http')?u:location.origin+(u.startsWith('/')?u:'/'+u);return F('?url='+encodeURIComponent(u),o);};const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&!u.startsWith('http'))u=location.origin+(u.startsWith('/')?u:'/'+u);arguments[1]='?url='+encodeURIComponent(u);return X.apply(this,arguments);};const W=window.WebSocket;window.WebSocket=function(u){try{return new W('?ws='+btoa(u));}catch(e){return new W(u);}};})();</script>`; }

/* UI */
function uiPage(){
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>Ultra Proxy v6</title>
  <style>body{background:#111;color:#0f0;font-family:monospace;text-align:center;padding-top:40px}input{width:60%;padding:10px;margin:5px;border-radius:6px;border:1px solid #0f0;background:#000;color:#0f0}button{padding:10px 16px;border:none;background:#0f0;color:#000;border-radius:6px;cursor:pointer}iframe{width:98%;height:70vh;margin-top:20px;border-radius:6px;border:none}</style></head><body>
  <h1>Ultra Proxy v6</h1><input id="u" placeholder="https://example.com"><button onclick="go()">GO</button><iframe id="fr"></iframe>
  <script>function go(){let u=document.getElementById('u').value;if(!u) return;if(!u.startsWith('http')) u='http://'+u;document.getElementById('fr').src='?url='+encodeURIComponent(u)+'&t=${globalThis.AUTH_TOKEN||""}';}</script></body></html>`;
  return new Response(html,{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Access-Control-Allow-Origin":"*"}});
}

/* Admin */
async function handleAdmin(req,url){
  const pass=url.searchParams.get("pass")||req.headers.get("x-admin-pass")||"";
  const ADMIN_PASS_VAL=globalThis.ADMIN_PASS||"";
  if(!ADMIN_PASS_VAL||pass!==ADMIN_PASS_VAL) return new Response("<h3>Admin: provide pass ?admin&pass=</h3>",{status:401,headers:{"Content-Type":"text/html"}});
  const nodesStats=await Promise.all(NODES.map(async n=>({node:n,t:await benchNode(n,BENCH_TIMEOUT)})));
  let html=`<h2>Ultra Proxy v6 - Admin</h2><ul>`;
  nodesStats.forEach(n=> html+=`<li>${n.node} - ${n.t===Infinity?"timeout":n.t+"ms"}</li>`);
  html+=`</ul><p>Cache TTL: ${CACHE_TTL}s</p>`;
  return new Response(html,{status:200,headers:{"Content-Type":"text/html"}});
}


