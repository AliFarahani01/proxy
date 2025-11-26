import { WSProxy } from './WSProxy.js';

// ----------------- Config -----------------
const NODES = [
  "http://49.205.160.115:8080",
  "http://124.83.51.80:8082",
  "http://181.214.1.158:80",
  "http://190.239.220.57:999",
  "http://8.211.42.167:3129",
  "http://36.37.86.26:9812",
  "http://8.213.128.6:7777",
  "http://45.43.81.220:5867",
   "http://185.162.230.46:80",
  "http://185.162.229.49:80",
   "http://104.19.40.29:80",
  "185.162.230.157:80",
   "http://185.162.229.12:80",
  "http://185.162.229.227:80",
  "http://104.19.32.209:80"
];
const CACHE_TTL = 20; 
const BENCH_TIMEOUT = 1500; 
const FETCH_TIMEOUT = 25000; 
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

// ----------------- Entry Point -----------------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Admin dashboard (بدون رمز)
    if (url.searchParams.has("admin")) 
        return handleAdmin(req, url, env);

    // WebSocket upgrade
    if (url.searchParams.has("ws")) {
      const id = env.WS_DO.idFromName(url.toString());
      const obj = env.WS_DO.get(id);
      return obj.fetch(req);
    }

    // UI
    if (!url.searchParams.has("url")) return uiPage();

    // بدون نیاز به توکن یا رمز
    const target = normalizeUrl(decodeURIComponent(url.searchParams.get("url")));
    const method = req.method.toUpperCase();
    const cacheKey = `bepichon::${target}::${method}`;
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
    headers.set("Via", "bepichon");
    if (node) headers.set("X-Node", node);

    const contentType = headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      const html = await resp.text();
      const rewritten = rewriteHTML(html, baseFor(target));
      const injected = rewritten + injectJS();
      const buffer = new TextEncoder().encode(injected);

      if (method === "GET" && buffer.byteLength <= MAX_CACHE_BYTES) {
        const respCache = new Response(buffer, {
          status: resp.status,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `max-age=${CACHE_TTL}` }
        });
        await cache.put(cacheKey, respCache.clone());
      }

      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(buffer, { status: resp.status, headers });
    }

    // Binary
    const buffer = await resp.arrayBuffer();
    if (method === "GET" && buffer.byteLength <= MAX_CACHE_BYTES) {
      const respCache = new Response(buffer, {
        status: resp.status,
        headers: { "Cache-Control": `max-age=${CACHE_TTL}` }
      });
      await cache.put(cacheKey, respCache.clone());
    }

    return new Response(buffer, { status: resp.status, headers });
  }
};

/* ---------------- Utilities ---------------- */
function addHeaders(resp, cacheHit="MISS") {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Bepichon-Cache", cacheHit);
  return new Response(resp.body, { status: resp.status, headers });
}

function normalizeUrl(u) {
  return /^\s*https?:\/\//i.test(u) ? u.trim() : "http://" + u.trim();
}

function removeHopHeaders(headers) {
  ["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade"].forEach(h => headers.delete(h));
}

function baseFor(target) {
  try {
    const u = new URL(target);
    return u.origin + u.pathname.replace(/\/[^\/]*$/,'');
  } catch {
    return target;
  }
}
async function pickWorkingNode(nodes) {
  for (let n of nodes) {
    try {
      const res = await fetch(n, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.ok) return n;
    } catch(e) { /* ignore */ }
  }
  return null;
}

async function pickFastestNode(nodes) {
  const results = await Promise.all(nodes.map(n => benchNode(n, BENCH_TIMEOUT)));
  let best = nodes[0], bestTime = Infinity;
  results.forEach((t,i) => { if(t < bestTime){ bestTime = t; best = nodes[i]; }});
  return best;
}
async function benchNode(node, timeout) {
  const c = new AbortController(), id = setTimeout(()=>c.abort(),timeout);
  const start = Date.now();
  try { const r = await fetch(node,{method:"HEAD",signal:c.signal}); clearTimeout(id); return Date.now() - start; }
  catch { clearTimeout(id); return Infinity; }
}

async function proxyFetch(req, target, node) {
  const headers = new Headers();
  req.headers.forEach((v,k)=>{ 
    if(!["host","content-length","connection","upgrade-insecure-requests"].includes(k.toLowerCase())) 
        headers.set(k,v); 
  });
  headers.set("Via","bepichon");
  if(node) headers.set("X-Node", node);
  const opts = { method: req.method, headers, redirect:"follow", cf:{cacheTtl:0} };
  if(req.method !== "GET" && req.method !== "HEAD") opts.body = await req.arrayBuffer();
  return fetchWithTimeout(target, opts, FETCH_TIMEOUT);
}
function fetchWithTimeout(url, opts, timeout) {
  const c = new AbortController(); opts.signal = c.signal; const id = setTimeout(()=>c.abort(),timeout);
  return fetch(url, opts).finally(()=>clearTimeout(id));
}

function rewriteHTML(html, base) {
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi,(m,a,u)=>`${a}="${resourceProxy(u,base)}"`);
  html = html.replace(/url\(([^)]+)\)/gi,(m,u)=>`url(${resourceProxy(u.replace(/^['"]|['"]$/g,''),base)})`);
  return html;
}
function resourceProxy(u, base) {
  if(/^\s*https?:\/\//i.test(u)) return `?url=${encodeURIComponent(u)}`;
  if(/^\s*\/\//.test(u)) return `?url=${encodeURIComponent("http:"+u)}`;
  if(/^\s*\//.test(u)) return `?url=${encodeURIComponent(base+u)}`;
  return `?url=${encodeURIComponent(base+"/"+u)}`;
}

function injectJS() {
  return `<script>(function(){const F=window.fetch.bind(window);window.fetch=(u,o)=>{if(typeof u==='string')u=u.startsWith('http')?u:location.origin+(u.startsWith('/')?u:'/'+u);return F('?url='+encodeURIComponent(u),o);};const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&!u.startsWith('http'))u=location.origin+(u.startsWith('/')?u:'/'+u);arguments[1]='?url='+encodeURIComponent(u);return X.apply(this,arguments);};})();</script>`;
}

/* UI */
function uiPage() {
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>bepichon</title>
  <style>body{background:#111;color:#0f0;font-family:monospace;text-align:center;padding-top:40px}input{width:60%;padding:10px;margin:5px;border-radius:6px;border:1px solid #0f0;background:#000;color:#0f0}button{padding:10px 16px;border:none;background:#0f0;color:#000;border-radius:6px;cursor:pointer}iframe{width:98%;height:70vh;margin-top:20px;border-radius:6px;border:none}</style></head><body>
  <h1>bepichon</h1><input id="u" placeholder="https://example.com"><button onclick="go()">GO</button><iframe id="fr"></iframe>
  <script>function go(){let u=document.getElementById('u').value;if(!u)return;if(!u.startsWith('http'))u='http://'+u;document.getElementById('fr').src='?url='+encodeURIComponent(u);} </script>
  </body></html>`;
  return new Response(html, { status:200, headers:{"Content-Type":"text/html; charset=utf-8","Access-Control-Allow-Origin":"*"}});
}

/* Admin بدون رمز */
async function handleAdmin(req, url, env) {
  const nodesStats = await Promise.all(NODES.map(async n => ({ node:n, t:await benchNode(n,BENCH_TIMEOUT) })));
  let html = `<h2>bepichon - Admin</h2><ul>`;
  nodesStats.forEach(n => html += `<li>${n.node} - ${n.t===Infinity?"timeout":n.t+"ms"}</li>`);
  html += `</ul><p>Cache TTL: ${CACHE_TTL}s</p>`;
  return new Response(html, {status:200, headers:{"Content-Type":"text/html"}});
}

export { WSProxy };
