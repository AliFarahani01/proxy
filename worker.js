import { WSProxy } from './WSProxy.js';
// worker.js (ES Module) - bepichon: All-in-One proxy (Web / DoH / DNS-HTTPS / HTTP-forward / WS-tunnel)
// Bindings recommended:
// - DNS_KV  (KV namespace)  -> optional but recommended for caching dns.text
// NOTE: This worker intentionally runs without auth by default (open). Add token checks if you want protection.

const DNS_RAW_URL = "https://raw.githubusercontent.com/AliFarahani01/proxy/refs/heads/main/dns.text";
const DNS_CACHE_KEY = "bepichon:dnslist";
const DNS_CACHE_TTL = 60 * 60; // 1 hour

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const params = url.searchParams;

    // Admin endpoints
    if (pathname === "/_admin/refresh") {
      const ok = await refreshDnsList(env);
      return json({ ok });
    }
    if (pathname === "/_admin/status") {
      const nodes = await loadDnsList(env);
      return json({ count: nodes.length, sample: nodes.slice(0, 20) });
    }

    // WS-tunnel endpoint: /wsproxy?url=wss://echo.websocket.org
    if (pathname === "/wsproxy") {
      const target = params.get("url");
      if (!target) return new Response("missing url", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Upgrade required", { status: 400 });
      }
      try {
        // Create client/server WebSocket pair for client connection
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        // open remote websocket from worker -> remote
        const remote = await openRemoteWebSocket(target);

        // forward messages both ways
        remote.addEventListener("message", ev => {
          try { server.send(ev.data); } catch {}
        });
        server.addEventListener("message", ev => {
          try { remote.send(ev.data); } catch {}
        });
        const cleanup = () => {
          try { remote.close(); } catch {}
          try { server.close(); } catch {}
        };
        remote.addEventListener("close", cleanup);
        server.addEventListener("close", cleanup);

        server.accept();
        return new Response(null, { status: 101, webSocket: client });
      } catch (e) {
        return new Response("WS proxy error: " + e.toString(), { status: 502 });
      }
    }

    // DoH proxy endpoint: /doh?name=example.com&type=A
    if (pathname === "/doh") {
      const name = params.get("name");
      const type = params.get("type") || "A";
      if (!name) return new Response("missing name", { status: 400 });
      try {
        const res = await resolveDoH(name, type, env);
        // res is JSON from DoH server (dns.google style) or wire base64 if raw
        return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" }});
      } catch (e) {
        return new Response("DoH error: " + e.toString(), { status: 502 });
      }
    }

    // DNS forwarder via HTTPS (JSON/wire): /dns?name=...&type=A&format=json|wire
    if (pathname === "/dns") {
      const name = params.get("name");
      const type = params.get("type") || "A";
      const format = (params.get("format") || "json").toLowerCase();
      if (!name) return new Response("missing name", { status: 400 });
      try {
        const dohJson = await resolveDoH(name, type, env); // returns JSON
        if (format === "json") {
          return new Response(JSON.stringify(dohJson), { headers: { "Content-Type": "application/json" }});
        } else {
          // try to fetch wire format from the chosen DoH endpoint if possible
          const wire = await resolveDoHWire(name, type, env);
          return new Response(wire, { headers: { "Content-Type": "application/dns-message" }});
        }
      } catch (e) {
        return new Response("DNS error: " + e.toString(), { status: 502 });
      }
    }

    // Main proxy modes:
    // - Web rewrite: ?url=... or ?mode=rewrite
    // - API passthrough: ?mode=api&url=...
    // - HTTP forward-like: ?mode=http&url=...
    //
    // For HTTP forward mode the client may provide header x-bepichon-target

    const mode = (params.get("mode") || "rewrite").toLowerCase();
    let target = params.get("url") || request.headers.get("x-bepichon-target") || "";

    if (!target) {
      // In http mode, attempt to parse full URL from request path
      if (mode === "http") {
        const p = pathname.match(/\/(https?:\/.+)/);
        if (p) target = decodeURIComponent(p[1]);
      }
    }

    if (!target) {
      // no URL -> show UI
      return uiPage();
    }

    const fixed = target.startsWith("http") ? target : "http://" + target;

    try {
      // choose upstream proxy (http(s) type) if any in dns list
      const nodes = await loadDnsList(env);
      const upstream = await chooseUpstreamProxy(nodes);

      // Build fetch url and options. If upstream available and it is an HTTP proxy that accepts path-style proxying,
      // try upstream + fixed; otherwise direct fetch to fixed.
      let fetchUrl = fixed;
      let fetchOpts = {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        redirect: "follow",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOpts.body = await request.arrayBuffer();
      }

      // heuristics: if upstream present and starts with http:// or https:// try path-proxying
      if (upstream && (upstream.startsWith("http://") || upstream.startsWith("https://"))) {
        // some proxies accept root HEAD; some accept path like http://proxy/http://target
        // we'll attempt path-style proxying for http mode
        if (mode === "http") {
          fetchUrl = upstream.replace(/\/+$/,'') + "/" + fixed;
        } else {
          // for rewrite/api default to direct fetch (fewer surprises)
          fetchUrl = fixed;
        }
      }

      const resp = await fetchWithTimeout(fetchUrl, fetchOpts, 30000);

      // process response headers
      const headers = new Headers(resp.headers);
      stripResponseHeaders(headers);

      const contentType = (headers.get("content-type") || "").toLowerCase();
      let body;
      if (mode === "rewrite" && contentType.includes("text/html")) {
        const html = await resp.text();
        body = rewriteHtml(html, fixed);
        headers.set("content-type", "text/html; charset=utf-8");
      } else {
        // binary passthrough
        body = await resp.arrayBuffer();
      }

      headers.set("access-control-allow-origin", "*");
      headers.set("via", "bepichon-worker");

      return new Response(body, { status: resp.status, headers });
    } catch (err) {
      return new Response("Proxy Error: " + String(err), { status: 502 });
    }
  }
};

/* -------------------- Helpers -------------------- */

function json(v){ return new Response(JSON.stringify(v), { headers: { "Content-Type":"application/json" } }); }

// fetch with timeout
function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  opts.signal = controller.signal;
  const promise = fetch(url, opts);
  const id = setTimeout(() => controller.abort(), timeout);
  return promise.finally(() => clearTimeout(id));
}

// load dns list from KV or GitHub raw
async function loadDnsList(env) {
  try {
    if (env && env.DNS_KV) {
      const cached = await env.DNS_KV.get(DNS_CACHE_KEY);
      if (cached) return parseDnsText(cached);
    }
  } catch (e) {
    // ignore
  }
  const r = await fetch(DNS_RAW_URL);
  if (!r.ok) return [];
  const txt = await r.text();
  try {
    if (env && env.DNS_KV) {
      env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL });
    }
  } catch (e) {}
  return parseDnsText(txt);
}

async function refreshDnsList(env) {
  try {
    const r = await fetch(DNS_RAW_URL);
    if (!r.ok) return false;
    const txt = await r.text();
    if (env && env.DNS_KV) await env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL });
    return true;
  } catch { return false; }
}

function parseDnsText(txt) {
  return txt.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(l => l);
}

function filterRequestHeaders(inHeaders) {
  const out = new Headers();
  inHeaders.forEach((v,k) => {
    const lk = k.toLowerCase();
    if (!["host","connection","content-length","upgrade-insecure-requests"].includes(lk)) {
      out.set(k, v);
    }
  });
  if (!out.has("user-agent")) out.set("user-agent", "bepichon/1.0");
  return out;
}

function stripResponseHeaders(h) {
  ["content-security-policy","x-frame-options","x-xss-protection","content-encoding","transfer-encoding","connection"].forEach(x => h.delete(x));
}

/* --------- DoH helpers --------- */
// resolveDoH returns JSON like dns.google/resolve
async function resolveDoH(name, type = "A", env) {
  const nodes = await loadDnsList(env);
  const dohCandidates = nodes.filter(n => n.startsWith("https://") && (n.includes("dns") || n.includes("doh") || n.includes("dns-query") || n.includes("dns.google")));
  // fallback list
  if (dohCandidates.length === 0) dohCandidates.push("https://dns.google/resolve");

  // test small sample concurrently (short timeout)
  const sample = dohCandidates.slice(0, 6);
  const tasks = sample.map(async (d) => {
    try {
      // try dns.google style first if host is dns.google
      if (d.includes("dns.google")) {
        const u = `${d}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
        const r = await fetchWithTimeout(u, { method: "GET", headers: { "accept":"application/json" } }, 3000);
        if (r && r.ok) return await r.json();
      } else {
        // If server supports RFC8484 JSON endpoint at /resolve
        let base = d;
        if (!base.endsWith("/")) base += "/";
        // try /resolve
        const u = base + "resolve?name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type);
        const r = await fetchWithTimeout(u, { method: "GET", headers: { "accept":"application/json" } }, 3000);
        if (r && r.ok) {
          try { return await r.json(); } catch(e){}
        }
        // try generic dns-query with application/dns-json
        const u2 = d + (d.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type);
        const r2 = await fetchWithTimeout(u2, { method: "GET", headers: { "accept":"application/dns-json" } }, 3000);
        if (r2 && r2.ok) {
          try { return await r2.json(); } catch(e){}
        }
      }
    } catch(e){}
    return null;
  });

  const results = (await Promise.all(tasks)).filter(Boolean);
  if (results.length > 0) return results[0];
  // last resort: google
  const fallback = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const r = await fetchWithTimeout(fallback, { method: "GET", headers: { "accept":"application/json" } }, 5000);
  if (!r.ok) throw new Error("All DoH lookups failed");
  return await r.json();
}

// try to fetch wire-format DNS message from DoH endpoint (application/dns-message)
async function resolveDoHWire(name, type = "A", env) {
  const nodes = await loadDnsList(env);
  const dohCandidates = nodes.filter(n => n.startsWith("https://") && (n.includes("dns") || n.includes("doh") || n.includes("dns-query") || n.includes("dns.google")));
  if (dohCandidates.length === 0) dohCandidates.push("https://dns.google/resolve");
  for (const d of dohCandidates.slice(0,5)) {
    try {
      const url = d + (d.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type);
      const r = await fetchWithTimeout(url, { method: "GET", headers: { "accept":"application/dns-message" } }, 3000);
      if (r && r.ok) return await r.arrayBuffer();
    } catch(e){}
  }
  // fallback failure
  throw new Error("failed to fetch wire-format DoH");
}

/* --------- choose upstream proxy from dns list (http(s) proxies) --------- */
async function chooseUpstreamProxy(nodes) {
  const proxies = nodes.filter(n => /^https?:\/\//i.test(n) && (n.includes(":") || n.includes("proxy") || n.includes("3128") || n.includes("8080") || n.includes("1080") || n.includes("proxy")));
  if (proxies.length === 0) return null;
  // quick concurrent HEAD bench
  const sample = proxies.slice(0, 12);
  const tests = sample.map(async p => {
    try {
      const t0 = Date.now();
      const r = await fetchWithTimeout(p, { method: "HEAD" }, 2000);
      if (r) return { p, dt: Date.now() - t0 };
    } catch(e){}
    return null;
  });
  const results = (await Promise.all(tests)).filter(Boolean);
  if (results.length === 0) return proxies[0];
  results.sort((a,b) => a.dt - b.dt);
  return results[0].p;
}

/* ---------- HTML rewrite ---------- */
function rewriteHtml(html, base) {
  const baseFor = (function(){
    try {
      const u = new URL(base); return u.origin + u.pathname.replace(/\/[^\/]*$/,'');
    } catch(e){ return base; }
  })();
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

/* ---------- open a remote WebSocket (worker -> remote) ---------- */
async function openRemoteWebSocket(target) {
  // Cloudflare supports fetch to websocket URLs? No — Worker can open WebSocket outbound only via WebSocket API in limited fashions.
  // We simulate by creating a WebSocket to the remote via fetch with Upgrade if remote supports it.
  // Use native WebSocket constructor in Workers runtime:
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(target);
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", (e) => reject(e));
    } catch (e) { reject(e); }
  });
}

/* ---------- UI ---------- */
function uiPage() {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>bepichon</title>
  <style>body{background:#000;color:#0f0;font-family:monospace;text-align:center;padding-top:32px}input{width:60%;padding:8px;margin:6px;border-radius:6px;border:1px solid #0f0;background:#111;color:#0f0}button{padding:8px 12px;border:none;background:#0f0;color:#000;border-radius:6px;cursor:pointer}</style></head><body>
    <h1>bepichon — All-in-One Proxy</h1>
    <p>Use ?url=..., or /doh?name=... , /dns?name=..., /wsproxy?url=...</p>
    <input id="u" placeholder="https://example.com"><button onclick="go()">GO</button>
    <p><small>Admin: /_admin/status  /_admin/refresh</small></p>
    <iframe id="fr" style="width:98%;height:70vh;margin-top:16px;border:1px solid #0f0;"></iframe>
    <script>function go(){let u=document.getElementById('u').value; if(!u) return; if(!u.startsWith('http')) u='http://'+u; document.getElementById('fr').src='?url='+encodeURIComponent(u);} </script>
  </body></html>`, { headers: { "content-type":"text/html; charset=utf-8" }});
}

export { WSProxy };
