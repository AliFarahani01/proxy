import { WSProxy } from './WSProxy.js';
// worker.js  (ES Module)
// bepichon — All-in-One Worker proxy (Web Proxy, DoH proxy, DNS-HTTPS forwarder, HTTP forward using upstream proxies, HTTP/WebSocket tunnel)
//
// Recommended bindings (optional but recommended):
//   - DNS_KV    -> KV namespace for caching dns.text (binding name in wrangler)
//   - LOG_KV    -> optional KV for lightweight logs
//
// NOTES:
//  - This worker intentionally runs open by default (no auth). Add token checks in the fetch handler if you want auth.
//  - Real SOCKS5/CONNECT (raw TCP) is not possible in a Worker. See "VPS integration" later.

const DNS_RAW_URL = "https://raw.githubusercontent.com/AliFarahani01/proxy/refs/heads/main/dns.text";
const DNS_CACHE_KEY = "bepichon:dnslist";
const DNS_CACHE_TTL = 60 * 60; // seconds
const DEFAULT_TIMEOUT = 20000; // ms

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const params = url.searchParams;

      // Admin endpoints (no auth by default)
      if (path === "/_admin/refresh") {
        const ok = await refreshDnsList(env);
        return json({ ok });
      }
      if (path === "/_admin/status") {
        const nodes = await loadDnsList(env);
        return json({ count: nodes.length, sample: nodes.slice(0, 40) });
      }

      // WebSocket tunnel endpoint (client upgrades to WS and worker relays messages)
      // Client must connect with: ws(s)://yourworker/_tunnel?target=wss://remote or wss://yourworker/_tunnel?target=http://...
      if (path === "/_tunnel") {
        return handleTunnel(request);
      }

      // DoH resolver: /doh?name=example.com&type=A
      if (path === "/doh") {
        const name = params.get("name");
        const type = params.get("type") || "A";
        if (!name) return new Response("missing name", { status: 400 });
        const doh = await resolveDoH(name, type, env);
        return new Response(JSON.stringify(doh), { headers: { "Content-Type": "application/json" }});
      }

      // DNS forwarder: /dns?name=example.com&type=A&format=json|wire
      if (path === "/dns") {
        const name = params.get("name");
        const type = params.get("type") || "A";
        const format = (params.get("format") || "json").toLowerCase();
        if (!name) return new Response("missing name", { status: 400 });
        const dohJson = await resolveDoH(name, type, env);
        if (format === "json") return new Response(JSON.stringify(dohJson), { headers: { "Content-Type":"application/json" }});
        // try wire format
        const wire = await resolveDoHWire(name, type, env).catch(()=>null);
        if (wire) return new Response(wire, { headers: { "Content-Type":"application/dns-message" }});
        return new Response(JSON.stringify(dohJson), { headers: { "Content-Type":"application/json" }});
      }

      // Main proxy routes — Web rewrite or direct http forward
      // Usage:
      //   /?url=https://example.com            -> rewrite mode (default)
      //   /?mode=http&url=http://example.com   -> http forward mode (attempt upstream proxying)
      //   header x-bepichon-target: ...        -> alternative way to pass target
      const mode = (params.get("mode") || "rewrite").toLowerCase();
      let target = params.get("url") || request.headers.get("x-bepichon-target") || "";
      if (!target && mode === "http") {
        // allow path-style: /http://example.com/...
        const m = request.url.match(/https?:\/\/[^/]+\/(https?:\/.+)/);
        if (m) target = decodeURIComponent(m[1]);
      }
      if (!target) return uiPage();

      const fixed = /^\s*https?:\/\//i.test(target) ? target.trim() : "http://" + target.trim();

      // choose upstream proxy if any
      const nodes = await loadDnsList(env);
      const upstream = await chooseUpstreamProxy(nodes);

      // build request options
      const opts = {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        redirect: "follow",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        opts.body = await request.arrayBuffer();
      }

      // If upstream proxy exists and mode==http try path-style proxy
      let fetchUrl = fixed;
      if (upstream && mode === "http") {
        // many public proxies accept /http://target or absolute URI in request line; try path-style fallback
        const cleaned = upstream.replace(/\/+$/,"");
        fetchUrl = cleaned + "/" + fixed;
      }

      // fetch with timeout
      const resp = await fetchWithTimeout(fetchUrl, opts, DEFAULT_TIMEOUT);

      // process response
      const headers = new Headers(resp.headers);
      stripResponseHeaders(headers);

      const contentType = (headers.get("content-type") || "").toLowerCase();
      let body;
      if (mode === "rewrite" && contentType.includes("text/html")) {
        const html = await resp.text();
        body = rewriteHtml(html, fixed);
        headers.set("content-type", "text/html; charset=utf-8");
      } else {
        body = await resp.arrayBuffer();
      }

      headers.set("access-control-allow-origin", "*");
      headers.set("via", "bepichon");

      return new Response(body, { status: resp.status, headers });
    } catch (err) {
      return new Response("bepichon error: " + String(err), { status: 502 });
    }
  }
};

/* ------------------ Utilities ------------------ */

function json(v){ return new Response(JSON.stringify(v), { headers: { "Content-Type":"application/json" } }); }

function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  opts.signal = controller.signal;
  const p = fetch(url, opts);
  const id = setTimeout(()=>controller.abort(), timeout);
  return p.finally(()=>clearTimeout(id));
}

// load dns list from KV (DNS_KV) or raw GitHub
async function loadDnsList(env) {
  try {
    if (env && env.DNS_KV) {
      const cached = await env.DNS_KV.get(DNS_CACHE_KEY);
      if (cached) return parseDnsText(cached);
    }
  } catch(e){ /* ignore kv errors */ }
  const r = await fetch(DNS_RAW_URL);
  if (!r.ok) return [];
  const txt = await r.text();
  if (env && env.DNS_KV) try { env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL }); } catch(e){}
  return parseDnsText(txt);
}

async function refreshDnsList(env) {
  try {
    const r = await fetch(DNS_RAW_URL);
    if (!r.ok) return false;
    const txt = await r.text();
    if (env && env.DNS_KV) try { await env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL }); } catch(e){}
    return true;
  } catch(e){ return false; }
}

function parseDnsText(txt) {
  return txt.split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#"));
}

function filterRequestHeaders(inHeaders) {
  const out = new Headers();
  inHeaders.forEach((v,k) => {
    const lk = k.toLowerCase();
    if (!["host","connection","content-length","upgrade-insecure-requests"].includes(lk)) out.set(k,v);
  });
  if (!out.has("user-agent")) out.set("user-agent","bepichon/1.0");
  return out;
}

function stripResponseHeaders(h) {
  ["content-security-policy","x-frame-options","x-xss-protection","content-encoding","transfer-encoding","connection"].forEach(x=>h.delete(x));
}

/* --------- DoH helpers ---------- */

async function resolveDoH(name, type="A", env) {
  const nodes = await loadDnsList(env);
  const dohCandidates = nodes.filter(n => /^https?:\/\//i.test(n) && /\bdns\b|\bdoh\b|\bdns-query\b|dns.google/.test(n));
  if (dohCandidates.length === 0) dohCandidates.push("https://dns.google/resolve");
  // try a few in parallel (short timeout)
  const sample = dohCandidates.slice(0,6);
  const tasks = sample.map(async d => {
    try {
      let base = d;
      if (!base.endsWith("/")) base += "/";
      // try /resolve JSON style
      const u = base + "resolve?name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type);
      const r = await fetchWithTimeout(u, { method: "GET", headers: { "accept":"application/json" } }, 3000);
      if (r && r.ok) {
        try { return await r.json(); } catch(e){}
      }
      // try generic query params
      const u2 = d + (d.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type);
      const r2 = await fetchWithTimeout(u2, { method: "GET", headers: { "accept":"application/dns-json, application/json" } }, 3000);
      if (r2 && r2.ok) {
        try { return await r2.json(); } catch(e){}
      }
    } catch(e){}
    return null;
  });
  const results = (await Promise.all(tasks)).filter(Boolean);
  if (results.length) return results[0];
  // fallback to google
  const f = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const r = await fetchWithTimeout(f, { method: "GET", headers: { "accept":"application/json" } }, 5000);
  if (!r.ok) throw new Error("DoH failed");
  return await r.json();
}

async function resolveDoHWire(name, type="A", env) {
  const nodes = await loadDnsList(env);
  const dohCandidates = nodes.filter(n => /^https?:\/\//i.test(n) && /\bdns\b|\bdoh\b|\bdns-query\b|dns.google/.test(n));
  if (dohCandidates.length === 0) dohCandidates.push("https://dns.google/resolve");
  for (const d of dohCandidates.slice(0,6)) {
    try {
      const u = d + (d.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type);
      const r = await fetchWithTimeout(u, { method: "GET", headers: { "accept":"application/dns-message" } }, 3000);
      if (r && r.ok) return await r.arrayBuffer();
    } catch(e){}
  }
  throw new Error("wire DoH failed");
}

/* --------- choose upstream proxy ---------- */
async function chooseUpstreamProxy(nodes) {
  // nodes may include many formats (ip:port, http://..., https://...)
  const proxies = nodes.filter(n => /^https?:\/\//i.test(n) || /:\d+$/.test(n));
  if (!proxies.length) return null;
  // normalize to http://ip:port if needed
  const normalized = proxies.map(p => {
    if (/^https?:\/\//i.test(p)) return p;
    const m = p.match(/^([^:]+):(\d+)$/);
    if (m) return "http://" + p;
    return p;
  });
  // bench first N
  const sample = normalized.slice(0, 12);
  const tests = sample.map(async p => {
    try {
      const t0 = Date.now();
      const r = await fetchWithTimeout(p, { method: "HEAD" }, 2000);
      if (r) return { p, dt: Date.now() - t0 };
    } catch(e){}
    return null;
  });
  const res = (await Promise.all(tests)).filter(Boolean);
  if (!res.length) return normalized[0];
  res.sort((a,b)=>a.dt-b.dt);
  return res[0].p;
}

/* ---------- HTML rewrite ---------- */
function rewriteHtml(html, base) {
  const baseFor = (() => { try { const u = new URL(base); return u.origin + u.pathname.replace(/\/[^\/]*$/,''); } catch(e){ return base; } })();
  let out = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (m, a, u) => {
    const tgt = absolutize(u, baseFor);
    return `${a}="?url=${encodeURIComponent(tgt)}"`;
  });
  out = out.replace(/url\(([^)]+)\)/gi, (m, u) => {
    const inner = u.replace(/^['"]|['"]$/g,'').trim();
    return `url(?url=${encodeURIComponent(absolutize(inner, baseFor))})`;
  });
  return out + injectFetchOverride();
}
function absolutize(u, base) {
  if (!u) return u;
  if (/^\s*https?:\/\//i.test(u)) return u;
  if (/^\s*\/\//.test(u)) return "http:" + u;
  if (/^\s*\//.test(u)) return base.replace(/\/$/,'') + u;
  return base.replace(/\/$/,'') + "/" + u;
}
function injectFetchOverride() {
  return `<script>(function(){const OF=window.fetch.bind(window);window.fetch=function(u,o){try{if(typeof u==='string'&&!u.startsWith('http'))u=location.origin+(u.startsWith('/')?u:('/'+u));if(typeof u==='string')return OF('?url='+encodeURIComponent(u),o);}catch(e){}return OF(u,o);};})();</script>`;
}

/* ---------- WebSocket / HTTP tunnel handler (limited) ---------- */
async function handleTunnel(request) {
  // This implements a WS-relay: client connects to Worker with WebSocket,
  // and sends JSON messages instructing Worker to open HTTP(s) requests or relay base64 chunked data.
  // This is a limited tunnel: requires client-side logic that knows the protocol.
  // If client can't do WS, you can use long-poll HTTP tunnel variant (not implemented here).
  if (request.headers.get("Upgrade") !== "websocket") return new Response("Upgrade required", { status: 400 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  server.addEventListener("message", async (ev) => {
    // Expect JSON commands: { cmd:"fetch", method:"GET", url:"https://..." } or {cmd:"raw", data:base64}
    try {
      const msg = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
      if (!msg) return;
      if (msg.cmd === "fetch" && msg.url) {
        try {
          const r = await fetchWithTimeout(msg.url, { method: msg.method || "GET", headers: msg.headers || {} }, DEFAULT_TIMEOUT);
          const headers = {};
          r.headers.forEach((v,k)=> headers[k]=v);
          const body = await r.arrayBuffer();
          server.send(JSON.stringify({ type:"response", status: r.status, headers, body: arrayBufferToBase64(body) }));
        } catch(e) {
          server.send(JSON.stringify({ type:"error", message: String(e) }));
        }
      } else {
        // echo raw
        server.send(JSON.stringify({ type:"unknown", msg: "unsupported" }));
      }
    } catch(e){}
  });

  server.addEventListener("close", ()=>{ /* nothing */ });
  return new Response(null, { status: 101, webSocket: client });
}

// helper: ArrayBuffer -> base64
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/* ---------- UI (simple) ---------- */
function uiPage(){
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>bepichon</title>
  <style>body{background:#000;color:#0f0;font-family:monospace;text-align:center;padding-top:28px}input{width:60%;padding:10px;margin:6px;border-radius:6px;border:1px solid #0f0;background:#111;color:#0f0}button{padding:8px 12px;border:none;background:#0f0;color:#000;border-radius:6px;cursor:pointer}iframe{width:98%;height:62vh;margin-top:12px;border:1px solid #0f0}</style></head><body>
  <h1>bepichon — All-in-One Proxy</h1>
  <p>Use: <code>?url=...</code> (rewrite) • <code>/doh?name=...&type=A</code> • <code>/dns?name=...</code> • <code>/_tunnel</code></p>
  <input id="u" placeholder="https://example.com"><button onclick="go()">GO</button>
  <iframe id="fr"></iframe>
  <script>function go(){let u=document.getElementById('u').value; if(!u) return; if(!u.startsWith('http')) u='http://'+u; document.getElementById('fr').src='?url='+encodeURIComponent(u);} </script>
  </body></html>`, { headers: { "content-type":"text/html; charset=utf-8" }});
}

export { WSProxy };
