import { WSProxy } from './WSProxy.js';

const DNS_RAW_URL = "https://raw.githubusercontent.com/AliFarahani01/proxy/refs/heads/main/dns.text";
const DNS_CACHE_KEY = "bepichon:dnslist";
const DNS_CACHE_TTL = 60 * 60; // 1 hour
const DEFAULT_TIMEOUT = 20000; // ms

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const params = url.searchParams;

      // Admin endpoints
      if (path === "/_admin/refresh") return json({ ok: await refreshDns(env) });
      if (path === "/_admin/status") {
        const nodes = await loadDns(env);
        return json({ count: nodes.length, sample: nodes.slice(0, 40) });
      }

      // WS tunnel
      if (path === "/_tunnel") return handleTunnel(req);

      // DoH resolver
      if (path === "/doh") {
        const name = params.get("name");
        const type = params.get("type") || "A";
        if (!name) return new Response("Missing name", { status: 400 });
        const doh = await resolveDoH(name, type, env);
        return json(doh);
      }

      // DNS forwarder
      if (path === "/dns") {
        const name = params.get("name");
        const type = params.get("type") || "A";
        const format = (params.get("format") || "json").toLowerCase();
        if (!name) return new Response("Missing name", { status: 400 });
        const dohJson = await resolveDoH(name, type, env);
        if (format === "json") return json(dohJson);
        const wire = await resolveDoHWire(name, type, env).catch(()=>null);
        if (wire) return new Response(wire, { headers: { "Content-Type":"application/dns-message" }});
        return json(dohJson);
      }

      // Main proxy
      const mode = (params.get("mode") || "rewrite").toLowerCase();
      let target = params.get("url") || req.headers.get("x-bepichon-target") || "";
      if (!target) return uiPage();

      const fixed = /^\s*https?:\/\//i.test(target) ? target.trim() : "http://" + target.trim();
      const nodes = await loadDns(env);
      const upstream = await chooseUpstream(nodes);

      const opts = { method: req.method, headers: filterReq(req.headers), redirect: "follow" };
      if (req.method !== "GET" && req.method !== "HEAD") opts.body = await req.arrayBuffer();

      let fetchUrl = fixed;
      if (upstream && mode === "http") fetchUrl = upstream.replace(/\/+$/,'') + "/" + fixed;

      const resp = await fetchWithTimeout(fetchUrl, opts, DEFAULT_TIMEOUT);
      const headers = new Headers(resp.headers);
      stripResp(headers);

      let body;
      const contentType = (headers.get("content-type") || "").toLowerCase();
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

    } catch (e) {
      return new Response("bepichon error: " + String(e), { status: 502 });
    }
  }
};

/* -------- Utilities -------- */
function json(v){ return new Response(JSON.stringify(v), { headers:{ "Content-Type":"application/json" } }); }

function fetchWithTimeout(url, opts={}, timeout=15000){
  const c = new AbortController(); opts.signal=c.signal;
  const p = fetch(url, opts);
  const id = setTimeout(()=>c.abort(),timeout);
  return p.finally(()=>clearTimeout(id));
}

async function loadDns(env){
  try{
    if(env && env.DNS_KV){
      const cached = await env.DNS_KV.get(DNS_CACHE_KEY);
      if(cached) return parseDns(cached);
    }
  }catch{}
  const r = await fetch(DNS_RAW_URL);
  const txt = r.ok ? await r.text() : "";
  if(env && env.DNS_KV) try{ await env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL }); } catch{}
  return parseDns(txt);
}

async function refreshDns(env){
  const r = await fetch(DNS_RAW_URL);
  if(!r.ok) return false;
  const txt = await r.text();
  if(env && env.DNS_KV) try{ await env.DNS_KV.put(DNS_CACHE_KEY, txt, { expirationTtl: DNS_CACHE_TTL }); } catch{}
  return true;
}

function parseDns(txt){ return txt.split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#")); }

function filterReq(inHeaders){
  const out = new Headers();
  inHeaders.forEach((v,k)=>{ if(!["host","connection","content-length","upgrade-insecure-requests"].includes(k.toLowerCase())) out.set(k,v); });
  if(!out.has("user-agent")) out.set("user-agent","bepichon/1.0");
  return out;
}

function stripResp(h){ ["content-security-policy","x-frame-options","x-xss-protection","content-encoding","transfer-encoding","connection"].forEach(x=>h.delete(x)); }

/* -------- DoH -------- */
async function resolveDoH(name,type="A",env){
  const nodes = await loadDns(env);
  const dohNodes = nodes.filter(n=>/^https?:\/\//i.test(n) && /\bdns\b|\bdoh\b|\bdns-query\b/.test(n));
  if(!dohNodes.length) dohNodes.push("https://dns.google/resolve");
  for(const d of dohNodes.slice(0,6)){
    try{
      let u = d.endsWith("/")? d : d+"/";
      const r = await fetchWithTimeout(u+"resolve?name="+encodeURIComponent(name)+"&type="+encodeURIComponent(type), { method:"GET", headers:{ "accept":"application/json" } },3000);
      if(r && r.ok) try{return await r.json();}catch{}
    }catch{}
  }
  // fallback
  const f = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const r = await fetchWithTimeout(f, { method:"GET", headers:{ "accept":"application/json" } },5000);
  if(!r.ok) throw new Error("DoH failed");
  return await r.json();
}

async function resolveDoHWire(name,type="A",env){
  const nodes = await loadDns(env);
  const dohNodes = nodes.filter(n=>/^https?:\/\//i.test(n) && /\bdns\b|\bdoh\b|\bdns-query\b/.test(n));
  if(!dohNodes.length) dohNodes.push("https://dns.google/resolve");
  for(const d of dohNodes.slice(0,6)){
    try{
      const u = d + (d.includes("?") ? "&" : "?") + "name="+encodeURIComponent(name)+"&type="+encodeURIComponent(type);
      const r = await fetchWithTimeout(u, { method:"GET", headers:{ "accept":"application/dns-message" } },3000);
      if(r && r.ok) return await r.arrayBuffer();
    }catch{}
  }
  throw new Error("wire DoH failed");
}

/* -------- Upstream -------- */
async function chooseUpstream(nodes){
  const proxies = nodes.filter(n=>/^https?:\/\//i.test(n) || /:\d+$/.test(n));
  if(!proxies.length) return null;
  const normalized = proxies.map(p=>/^https?:\/\//i.test(p)?p:"http://"+p);
  const sample = normalized.slice(0,12);
  const tests = sample.map(async p=>{
    try{
      const t0=Date.now();
      const r = await fetchWithTimeout(p, { method:"HEAD" },2000);
      if(r) return { p, dt: Date.now()-t0 };
    }catch{}
    return null;
  });
  const res = (await Promise.all(tests)).filter(Boolean);
  if(!res.length) return normalized[0];
  res.sort((a,b)=>a.dt-b.dt);
  return res[0].p;
}

/* -------- HTML Rewrite -------- */
function rewriteHtml(html, base){
  const baseFor = (()=>{ try{ const u=new URL(base); return u.origin+u.pathname.replace(/\/[^\/]*$/,''); }catch{return base;} })();
  let out = html.replace(/(href|src|action)=["']([^"']+)["']/gi,(m,a,u)=>{
    return `${a}="?url=${encodeURIComponent(absolutize(u,baseFor))}"`;
  });
  out = out.replace(/url\(([^)]+)\)/gi,(m,u)=>{
    const inner = u.replace(/^['"]|['"]$/g,'').trim();
    return `url(?url=${encodeURIComponent(absolutize(inner,baseFor))})`;
  });
  return out + injectFetch();
}
function absolutize(u, base){
  if(!u) return u;
  if(/^\s*https?:\/\//i.test(u)) return u;
  if(/^\s*\/\//.test(u)) return "http:"+u;
  if(/^\s*\//.test(u)) return base.replace(/\/$/,'')+u;
  return base.replace(/\/$/,'')+"/"+u;
}
function injectFetch(){ return `<script>(function(){const OF=window.fetch.bind(window);window.fetch=function(u,o){try{if(typeof u==='string'&&!u.startsWith('http'))u=location.origin+(u.startsWith('/')?u:('/'+u));return OF('?url='+encodeURIComponent(u),o);}catch(e){}return OF(u,o);};})();</script>`; }

/* -------- WS Tunnel -------- */
async function handleTunnel(req){
  if(req.headers.get("Upgrade")!=="websocket") return new Response("Upgrade required",{status:400});
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  server.addEventListener("message",async ev=>{
    try{
      const msg = typeof ev.data==="string"?JSON.parse(ev.data):null;
      if(!msg) return;
      if(msg.cmd==="fetch" && msg.url){
        try{
          const r = await fetchWithTimeout(msg.url,{ method: msg.method||"GET", headers: msg.headers||{} },DEFAULT_TIMEOUT);
          const headers={}; r.headers.forEach((v,k)=>headers[k]=v);
          const body=await r.arrayBuffer();
          server.send(JSON.stringify({ type:"response", status:r.status, headers, body: arrayBufferToBase64(body) }));
        }catch(e){ server.send(JSON.stringify({ type:"error", message:String(e) })); }
      }else server.send(JSON.stringify({ type:"unknown", msg:"unsupported" }));
    }catch{}
  });
  return new Response(null,{ status:101, webSocket:client });
}
function arrayBufferToBase64(buf){ let bin=""; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.byteLength;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin); }

/* -------- UI -------- */
function uiPage(){
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>bepichon</title>
  <style>body{background:#000;color:#0f0;font-family:monospace;text-align:center;padding-top:28px}input{width:60%;padding:10px;margin:6px;border-radius:6px;border:1px solid #0f0;background:#111;color:#0f0}button{padding:8px 12px;border:none;background:#0f0;color:#000;border-radius:6px;cursor:pointer}iframe{width:98%;height:62vh;margin-top:12px;border:1px solid #0f0}</style></head><body>
  <h1>bepichon — All-in-One Proxy</h1>
  <p>Use: <code>?url=...</code> (rewrite) • <code>/doh?name=...&type=A</code> • <code>/dns?name=...</code> • <code>/_tunnel</code></p>
  <input id="u" placeholder="https://example.com"><button onclick="go()">GO</button>
  <iframe id="fr"></iframe>
  <script>function go(){let u=document.getElementById('u').value;if(!u)return;if(!u.startsWith('http'))u='http://'+u;document.getElementById('fr').src='?url='+encodeURIComponent(u);}</script>
  </body></html>`, { headers:{ "content-type":"text/html; charset=utf-8" }});
}

export { WSProxy };
