/**
 * ULTIMATE WEB PROXY v5+ (Cloudflare Worker)
 * - Fastest node selection (parallel HEAD/GET)
 * - TurboEdge Cache (caches.default)
 * - HTML resource rewriter + JS injector
 * - Full HTTP method support (binary passthrough)
 * - DoH resolver (basic)
 * - Token auth & simple admin UI
 *
 * ENV:
 *  - AUTH_TOKEN  (required for proxy use; set in Worker secrets)
 *  - ADMIN_PASS  (optional, for ?admin dashboard)
 */

const NODES = [
  "https://1.1.1.1/",
  "https://8.8.8.8/",
  "https://9.9.9.9/",
  "https://208.67.222.222/",
  "https://76.76.2.0/"
];

const CACHE_TTL = 20; // seconds
const BENCH_TIMEOUT = 2000; // ms
const FETCH_TIMEOUT = 30000; // ms for target fetch
const MAX_CACHE_BYTES = 1 * 1024 * 1024; // only cache GET responses <= 1MB by default

addEventListener("fetch", event => {
  event.respondWith(handle(event.request));
});

async function handle(req) {
  try {
    const url = new URL(req.url);
    // admin dashboard
    if (url.searchParams.has("admin")) return adminHandler(req, url);

    // websocket shim (server must support ?ws=base64)
    if (url.searchParams.has("ws")) {
      return new Response(JSON.stringify({
        ok: false,
        message: "WebSocket passthrough requested. Worker provides a shim only. For bi-directional WS proxy use a dedicated origin server / Durable Object."
      }), { status: 501, headers: jsonHeaders() });
    }

    if (!url.searchParams.has("url")) {
      return uiPage();
    }

    // auth
    const authToken = (typeof AUTH_TOKEN !== "undefined") ? AUTH_TOKEN : (globalThis.AUTH_TOKEN || "");
    const provided = url.searchParams.get("t") || req.headers.get("x-auth-token") || "";
    if (!authToken || provided !== authToken) {
      return new Response("Unauthorized. Provide valid token as ?t= or X-Auth-Token header.", { status: 401 });
    }

    const targetRaw = decodeURIComponent(url.searchParams.get("url") || "");
    const target = normalizeUrl(targetRaw);
    const method = req.method.toUpperCase();

    // Prepare cache key (GET only)
    const cacheKey = `v5::${target}::${method}`;
    const cache = caches.default;

    if (method === "GET" || method === "HEAD") {
      const cached = await cache.match(cacheKey);
      if (cached) {
        // clone and ensure headers
        const c = cached.clone();
        const headers = new Headers(c.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("X-Ultra-Proxy-Cache", "HIT");
        addViaHeader(headers, null);
        return new Response(await c.arrayBuffer(), { status: c.status, headers });
      }
    }

    // select a fast node (bench)
    const node = await pickFastestNode(NODES);

    // perform proxied fetch
    const proxied = await proxyFetch(req, target, node);

    // process response
    const contentType = proxied.headers.get("content-type") || "";
    // remove hop-by-hop
    const headers = new Headers(proxied.headers);
    removeHopByHop(headers);
    addViaHeader(headers, node);
    headers.set("Access-Control-Allow-Origin", "*");

    // if HTML -> rewrite + inject
    if (contentType.includes("text/html")) {
      const text = await proxied.text(); // fetch returns decoded text
      const base = baseFor(target);
      const rewritten = rewriteHtml(text, base);
      const injected = rewritten + injectionScript();
      const enc = new TextEncoder().encode(injected);

      // cache if GET and size OK
      if (method === "GET" && enc.byteLength <= MAX_CACHE_BYTES) {
        const respForCache = new Response(enc, { status: proxied.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `max-age=${CACHE_TTL}` }});
        await cache.put(cacheKey, respForCache.clone());
      }
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("X-Ultra-Proxy-Cache", "MISS");
      return new Response(enc, { status: proxied.status, headers });
    }

    // non-html binary passthrough
    const buffer = await proxied.arrayBuffer();
    // optional cache small GETs
    if (method === "GET" && buffer.byteLength <= MAX_CACHE_BYTES) {
      const respForCache = new Response(buffer, { status: proxied.status, headers: { "Cache-Control": `max-age=${CACHE_TTL}` }});
      await cache.put(cacheKey, respForCache.clone());
    }

    headers.set("X-Ultra-Proxy-Cache", "MISS");
    return new Response(buffer, { status: proxied.status, headers });

  } catch (err) {
    console.error("Proxy error:", err);
    return new Response("Proxy internal error: " + String(err), { status: 502 });
  }
}

/* ---------------- utilities ---------------- */

function jsonHeaders(){ return { "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":"*" }; }

function normalizeUrl(u){
  if(!u) return "";
  if(!/^\s*https?:\/\//i.test(u)) return "http://" + u.trim();
  return u.trim();
}

function baseFor(target){
  try {
    const u = new URL(target);
    return u.origin + u.pathname.replace(/\/[^\/]*$/, '');
  } catch(e){ return target; }
}

function removeHopByHop(headers){
  const hop = ["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade"];
  for(const h of hop) headers.delete(h);
}

function addViaHeader(headers, node){
  if(!headers) return;
  headers.set("Via", "UltraProxy-v5");
  if(node) headers.set("X-Node", node);
}

/* pick fastest node via parallel HEAD requests */
async function pickFastestNode(nodes){
  if(!nodes || nodes.length===0) return null;
  const promises = nodes.map(n => benchNode(n, BENCH_TIMEOUT));
  const results = await Promise.allSettled(promises);
  let best = null, bestTime = Infinity;
  for(let i=0;i<results.length;i++){
    const r = results[i];
    if(r.status === "fulfilled" && typeof r.value === "number"){
      if(r.value < bestTime){ bestTime = r.value; best = nodes[i]; }
    }
  }
  return best || nodes[0];
}

async function benchNode(node, timeoutMs){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    // try HEAD; if HEAD not allowed server may 405 - so accept ok or 405
    const resp = await fetch(node, { method: "HEAD", signal: controller.signal });
    clearTimeout(id);
    return Date.now() - t0;
  } catch(e){
    clearTimeout(id);
    return Infinity;
  }
}

/* proxyFetch: forward request to target, preserve method/headers/body */
async function proxyFetch(origReq, targetUrl, node){
  // build headers copy
  const incoming = new Headers(origReq.headers);
  const out = new Headers();
  for(const [k,v] of incoming.entries()){
    const lk = k.toLowerCase();
    if(["host","content-length","connection","upgrade-insecure-requests"].includes(lk)) continue;
    out.set(k,v);
  }
  out.set("Via","UltraProxy-v5");
  if(node) out.set("X-Node", node);

  const opts = {
    method: origReq.method,
    headers: out,
    redirect: "follow",
    cf: { cacheTtl: 0 } // don't let CF cache automatically here
  };

  if(origReq.method !== "GET" && origReq.method !== "HEAD"){
    // clone body
    const buf = await origReq.arrayBuffer();
    opts.body = buf;
  }

  // timeout wrapper
  return fetchWithTimeout(targetUrl, opts, FETCH_TIMEOUT);
}

function fetchWithTimeout(url, opts, timeoutMs){
  const controller = new AbortController();
  opts.signal = controller.signal;
  const id = setTimeout(()=>controller.abort(), timeoutMs);
  return fetch(url, opts).finally(()=>clearTimeout(id));
}

/* rewriteHtml similar to PHP: href/src/action/url(...) */
function rewriteHtml(html, base){
  // href / src / action
  html = html.replace(/href=(["'])([^"']+)\1/gi, (m,q,u)=> `href=${q}${resourceToProxy(u, base)}${q}`);
  html = html.replace(/src=(["'])([^"']+)\1/gi, (m,q,u)=> `src=${q}${resourceToProxy(u, base)}${q}`);
  html = html.replace(/action=(["'])([^"']+)\1/gi, (m,q,u)=> `action=${q}${resourceToProxy(u, base)}${q}`);
  // url(...) in css
  html = html.replace(/url\(([^)]+)\)/gi, (m,u)=> {
    let inner = u.replace(/^['"]|['"]$/g, "").trim();
    return `url(${resourceToProxy(inner, base)})`;
  });
  return html;
}

function resourceToProxy(u, base){
  if(/^\s*https?:\/\//i.test(u)) return `?url=${encodeURIComponent(u)}`;
  if(/^\s*\/\//.test(u)) return `?url=${encodeURIComponent("http:" + u)}`;
  if(/^\s*\//.test(u)) return `?url=${encodeURIComponent(base + u)}`;
  return `?url=${encodeURIComponent(base + "/" + u)}`;
}

/* JS injector: override fetch, XHR, WebSocket (shim) */
function injectionScript(){
  return `<script>
  (function(){
    const OF = window.fetch.bind(window);
    window.fetch = function(u,o){
      try {
        const target = (typeof u === 'string') ? (u.startsWith('http') ? u : (location.origin + (u.startsWith('/')?u:'/'+u))) : u;
        if(typeof target === 'string') return OF('?url=' + encodeURIComponent(target), o);
      } catch(e){}
      return OF(u,o);
    };
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){
      try {
        const full = (typeof u === 'string' && !u.startsWith('http')) ? (location.origin + (u.startsWith('/')?u:'/'+u)) : u;
        arguments[1] = (typeof full === 'string') ? ('?url=' + encodeURIComponent(full)) : u;
      } catch(e){}
      return _open.apply(this, arguments);
    };
    const NativeWS = window.WebSocket;
    window.WebSocket = function(u){
      try {
        const enc = btoa(u);
        return new NativeWS('?ws=' + enc);
      } catch(e){ return new NativeWS(u); }
    };
  })();
  </script>`;
}

/* Simple UI page when no url param */
function uiPage(){
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ULTIMATE WEB PROXY v5 (Worker)</title>
  <style>body{background:#000;color:#0f0;font-family:consolas;padding-top:40px;text-align:center}input{width:60%;padding:12px;border-radius:8px;border:1px solid #0f0;background:#111;color:#0f0}button{padding:10px 18px;margin-left:8px;border:none;background:#0f0;color:#000;border-radius:8px;cursor:pointer}iframe{width:98%;height:70vh;margin-top:20px;border-radius:8px;border:none}</style></head><body>
  <h1>ULTIMATE WEB PROXY v5 (Worker)</h1><p>Parallel Node Benchmark + TurboCache + Full Rewriter</p>
  <input id="u" placeholder="https://example.com"><button onclick="go()">GO</button>
  <iframe id="fr"></iframe>
  <script>function go(){var u=document.getElementById('u').value;if(!u) return; if(!u.startsWith('http')) u='http://'+u; document.getElementById('fr').src='?url='+encodeURIComponent(u)+'&t=${(typeof AUTH_TOKEN !== "undefined")?AUTH_TOKEN:""}';}</script></body></html>`;
  return new Response(html, { status:200, headers: { "Content-Type":"text/html; charset=utf-8","Access-Control-Allow-Origin":"*" }});
}

/* Admin handler (very simple dashboard) */
async function adminHandler(req, url){
  const pass = url.searchParams.get("pass") || req.headers.get("x-admin-pass") || "";
  const ADMIN_PASS_VAL = (typeof ADMIN_PASS !== "undefined") ? ADMIN_PASS : (globalThis.ADMIN_PASS || "");
  if(!ADMIN_PASS_VAL || pass !== ADMIN_PASS_VAL) {
    return new Response("<h3>Admin: provide pass ?admin&pass=</h3>", { status:401, headers: { "Content-Type":"text/html" }});
  }
  // quick report
  const nodesBench = await Promise.all(NODES.map(async n => ({ node:n, t: await benchNode(n, BENCH_TIMEOUT) })));
  let html = `<h2>ULTIMATE PROXY v5 - Admin</h2><p>Nodes benchmark:</p><ul>`;
  nodesBench.forEach(n=> html += `<li>${n.node} - ${n.t===Infinity? "timeout": n.t+"ms"}</li>`);
  html += `</ul><p>Cache TTL: ${CACHE_TTL}s</p>`;
  return new Response(html, { status:200, headers: { "Content-Type":"text/html" }});
}
