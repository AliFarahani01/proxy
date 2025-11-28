import { WSProxy } from './WSProxy.js';

// worker.js (ES Module)
// All-in-one bepichon proxy worker
// Modes: rewrite (default), api (passthrough), http (HTTP forward-proxy-like when client sends full URL).
// Reads dns list from GitHub raw (dns.text) and caches in KV (if bound).
//
// Bindings (recommended):
// - DNS_KV (KV namespace)  [optional but recommended for caching]
// - (no AUTH by default; open public — you can add token check if wanted)

const DNS_RAW_URL = "https://raw.githubusercontent.com/AliFarahani01/proxy/refs/heads/main/dns.text";
const DNS_CACHE_KEY = "bepichon:dnslist";
const DNS_CACHE_TTL = 60 * 60; // seconds - 1 hour

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const params = url.searchParams;

    // admin endpoints:
    if (url.pathname === "/_admin/refresh") {
      // force refresh DNS list
      const ok = await refreshDnsList(env);
      return new Response(JSON.stringify({ ok }), { headers: { "Content-Type": "application/json" }});
    }
    if (url.pathname === "/_admin/status") {
      const dns = await loadDnsList(env);
      return new Response(JSON.stringify({ nodesCount: dns.length, sample: dns.slice(0,10) }), { headers: { "Content-Type": "application/json" }});
    }

    // UI (simple) if no url param and not http mode
    const mode = (params.get("mode") || "rewrite").toLowerCase(); // rewrite | api | http
    if (!params.has("url") && mode !== "http") {
      return uiPage();
    }

    // If http-proxy mode: client may set X-Target header or supply full target via path
    // Example: for system proxy you can request: GET /http://example.com/
    // We'll accept:
    // - query param: ?url=
    // - header: x-bepichon-target
    // - request path begins with /http:// or /https://  (legacy)
    let target = params.get("url") || req.headers.get("x-bepichon-target") || "";
    if (!target && req.url.includes("/http://") || req.url.includes("/https://")) {
      // path style: /http://example.com/...
      const path = new URL(req.url).pathname;
      const m = path.match(/\/(https?:\/.+)/);
      if (m) target = decodeURIComponent(m[1]);
    }
    if (!target && mode === "http") {
      // for http mode without url param, try host+path as target (full-url in first line)
      // e.g., client sent: GET http://example.com/ HTTP/1.1
      // Cloudflare normally rewrites request line; so this might not be present.
      return new Response("HTTP mode requires ?url= or x-bepichon-target header.", { status: 400 });
    }
    if (!target) return new Response("no target provided", { status: 400 });

    // Normalize
    let fixed = target.startsWith("http") ? target : "http://" + target;

    // Mode selection:
    // - rewrite: ideal for browsers. Worker fetches target directly, rewrites HTML, injects JS.
    // - api: passthrough, returns response without rewrite (good for app APIs).
    // - http: acts like forward-proxy-like: if node proxies are available and support path-forwarding,
    //         Worker will attempt to use node + path (node + fixed) otherwise direct fetch.
    try {
      // choose whether to use upstream proxy node discovered in dns.text (optional)
      const nodes = await loadDnsList(env); // array of raw lines
      // choose a working node (fast) but don't block too long
      const upstream = await chooseUpstream(nodes, { env, ctx });

      // If upstream is a proxy (http://host:port), attempt proxied request by building URL:
      // Many simple proxies accept requests as "http://target" in the path when requested to proxy:
      // e.g., fetch("http://proxy:port/http://example.com/")
      // This is not universal. If upstream is null or not usable, do direct fetch.
      const tryUpstream = upstream && upstream.startsWith("http");
      let fetchReqUrl = fixed;
      let fetchOpts = {
        method: req.method,
        headers: filterRequestHeaders(req.headers),
        redirect: "follow",
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        fetchOpts.body = await req.arrayBuffer();
      }

      if (tryUpstream && mode === "http") {
        // assemble proxied URL: upstream + fixed
        // ensure slash separation
        fetchReqUrl = upstream.replace(/\/+$/,'') + "/" + fixed;
      } else if (tryUpstream && mode === "api" && upstream.includes("/proxy/")) {
        // example for specialized proxy endpoints that require /proxy?url=...
        fetchReqUrl = upstream + "?url=" + encodeURIComponent(fixed);
      } else {
        // direct fetch to target
        fetchReqUrl = fixed;
      }

      // perform fetch with timeout
      const resp = await fetchWithTimeout(fetchReqUrl, fetchOpts, 30000);

      // build response
      const headers = new Headers(resp.headers);
      stripResponseHeaders(headers);

      let body;
      const ct = headers.get("content-type") || "";
      if (mode === "rewrite" && ct.includes("text/html")) {
        const html = await resp.text();
        body = rewriteHtml(html, fixed);
        headers.set("content-type", "text/html; charset=utf-8");
      } else if (mode === "api") {
        body = await resp.arrayBuffer();
      } else {
        // http mode: attempt binary passthrough
        body = await resp.arrayBuffer();
      }

      headers.set("access-control-allow-origin", "*");
      headers.set("via", "bepichon-worker");

      return new Response(body, { status: resp.status, headers });

    } catch (err) {
      return new Response("Proxy Error: " + String(err), { status: 502, headers: { "Content-Type": "text/plain" } });
    }
  }
};

/* ------------------- helpers ------------------- */

async function loadDnsList(env) {
  // Try KV first if available
  try {
    if (env && env.DNS_KV) {
      const cached = await env.DNS_KV.get(DNS_CACHE_KEY);
      if (cached) {
        return parseDnsText(cached);
      }
    }
  } catch (e) {
    // ignore KV errors, fall back to fetch
  }

  // fetch from Github raw
  const r = await fetch(DNS_RAW_URL);
  if (!r.ok) return [];
  const txt = await r.text();

  // store in KV if available
  try {
    if (env && env.DNS_KV) {
      env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL });
    }
  } catch (e) {}

  return parseDnsText(txt);
}

function parseDnsText(txt) {
  return txt.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    // keep http(s) urls, ip:port, domain names, doh urls
    .filter(l => {
      return l.startsWith("http://") || l.startsWith("https://") || /\d+\.\d+\.\d+\.\d+(:\d+)?/.test(l) || /^[a-z0-9.-]+(\.[a-z]{2,})?$/.test(l);
    })
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
  // set a sensible user-agent
  if (!out.has("user-agent")) out.set("user-agent", "bepichon/1.0");
  return out;
}

function stripResponseHeaders(h) {
  const drop = [
    "content-security-policy",
    "x-frame-options",
    "x-xss-protection",
    "content-encoding",
    "transfer-encoding",
    "connection",
  ];
  drop.forEach(x => h.delete(x));
}

async function chooseUpstream(nodes, { env, ctx } = {}) {
  // nodes: array of strings (from dns.text)
  // strategy:
  // 1) prefer explicit http(s) proxy URLs in the list
  // 2) test a small sample (concurrently) with short timeout and return fastest
  const proxies = nodes.filter(n => n.startsWith("http://") || n.startsWith("https://"));
  if (proxies.length === 0) return null;

  const sample = proxies.slice(0, 20);
  const tests = sample.map(async (p) => {
    try {
      const t0 = Date.now();
      // try HEAD to the proxy itself — many proxies respond to HEAD at root
      const res = await fetchWithTimeout(p, { method: "HEAD" }, 2500);
      if (res && (res.status >= 0)) {
        return { p, dt: Date.now() - t0 };
      }
    } catch (e) {}
    return null;
  });

  const results = (await Promise.all(tests)).filter(Boolean);
  if (results.length === 0) return proxies[0] || null;
  results.sort((a,b) => a.dt - b.dt);
  return results[0].p;
}

// simple fetch timeout wrapper
function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  opts.signal = controller.signal;
  const p = fetch(url, opts);
  const id = setTimeout(() => controller.abort(), timeout);
  return p.finally(() => clearTimeout(id));
}

/* HTML rewrite (basic) */
function rewriteHtml(html, base) {
  // rewrite href/src/action to point to worker ?url=
  const baseFor = (() => {
    try {
      const u = new URL(base);
      return u.origin + u.pathname.replace(/\/[^\/]*$/,'');
    } catch (e) { return base; }
  })();
  let out = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (m,a,u) => {
    const tgt = absolutize(u, baseFor);
    return `${a}="?url=${encodeURIComponent(tgt)}"`;
  });
  out = out.replace(/url\(([^)]+)\)/gi, (m,u) => {
    const inner = u.replace(/^['"]|['"]$/g,'').trim();
    return `url(?url=${encodeURIComponent(absolutize(inner, baseFor))})`;
  });
  // inject fetch override
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
  return `<script>
    (function(){
      const OF = window.fetch.bind(window);
      window.fetch = function(u,o){
        try {
          if (typeof u === 'string' && !u.startsWith('http')) u = location.origin + (u.startsWith('/')?u:('/'+u));
          if (typeof u === 'string') return OF('?url=' + encodeURIComponent(u), o);
        } catch(e){}
        return OF(u,o);
      };
    })();
  </script>`;
}

/* UI */
function uiPage() {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>bepichon</title>
  <style>body{background:#000;color:#0f0;font-family:monospace;text-align:center;padding-top:36px}input{width:60%;padding:10px;border-radius:6px;background:#111;color:#0f0;border:1px solid #0f0}button{padding:10px 14px;background:#0f0;color:#000;border:none;border-radius:6px;cursor:pointer}iframe{width:98%;height:70vh;margin-top:20px;border-radius:8px;border:1px solid #0f0}</style>
  </head><body>
  <h1>bepichon — All-In-One Proxy</h1>
  <p>modes: rewrite (default) | api | http  — use ?mode=api or ?mode=http</p>
  <input id="u" placeholder="https://example.com">
  <button onclick="go()">GO</button>
  <p><small>Open admin: /_admin/status  — refresh list: /_admin/refresh</small></p>
  <iframe id="fr"></iframe>
  <script>
    function go(){
      let u=document.getElementById('u').value; if(!u) return;
      if(!u.startsWith('http')) u='http://'+u;
      document.getElementById('fr').src='?url='+encodeURIComponent(u);
    }
  </script>
  </body></html>`, { headers: { "content-type":"text/html; charset=utf-8" }});
}

export { WSProxy };
