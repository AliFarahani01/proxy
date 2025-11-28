import { WSProxy } from '.WSProxy.js';

const DNS_RAW_URL = "https://raw.githubusercontent.com/AliFarahani01/proxy/refs/heads/main/dns.text";
const DNS_CACHE_KEY = "bepichon:dnslist";
const DNS_CACHE_TTL = 60*60; // 1h
const DEFAULT_TIMEOUT = 20000; // ms
const BENCH_TIMEOUT = 2000; // ping test

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const params = url.searchParams;

    try {
      // ---------- Admin ----------
      if (path === "/_admin/refresh") {
        const ok = await refreshDnsList(env);
        return json({ ok });
      }
      if (path === "/_admin/status") {
        const nodes = await loadDnsList(env);
        const fastest = await pickFastestNode(nodes);
        return json({ total: nodes.length, fastest });
      }

      // ---------- WebSocket / Tunnel ----------
      if (path === "/_tunnel") return handleTunnel(req);

      // ---------- DoH ----------
      if (path === "/doh") {
        const name = params.get("name");
        const type = params.get("type") || "A";
        if (!name) return new Response("missing name", {status:400});
        const doh = await resolveDoH(name, type, env);
        return new Response(JSON.stringify(doh), { headers:{ "Content-Type":"application/json"} });
      }

      // ---------- DNS Forward ----------
      if (path === "/dns") {
        const name = params.get("name");
        const type = params.get("type") || "A";
        const format = (params.get("format")||"json").toLowerCase();
        if (!name) return new Response("missing name", {status:400});
        const dohJson = await resolveDoH(name,type,env);
        if(format==="json") return json(dohJson);
        const wire = await resolveDoHWire(name,type,env).catch(()=>null);
        return wire ? new Response(wire,{ headers:{ "Content-Type":"application/dns-message"} }) : json(dohJson);
      }

      // ---------- Web / HTTP Proxy ----------
      let mode = (params.get("mode") || "rewrite").toLowerCase();
      let target = params.get("url") || req.headers.get("x-bepichon-target") || "";
      if(!target) return uiPage();
      target = target.startsWith("http") ? target : "http://"+target;

      const nodes = await loadDnsList(env);
      const upstream = await chooseUpstreamProxy(nodes);

      const opts = { method: req.method, headers: filterRequestHeaders(req.headers), redirect:"follow" };
      if(req.method!=="GET" && req.method!=="HEAD") opts.body = await req.arrayBuffer();

      let fetchUrl = target;
      if(upstream && mode==="http") fetchUrl = upstream.replace(/\/+$/,'') + "/" + target;

      const resp = await fetchWithTimeout(fetchUrl, opts, DEFAULT_TIMEOUT);
      const headers = new Headers(resp.headers);
      stripResponseHeaders(headers);

      const ct = headers.get("content-type")||"";
      let body;
      if(mode==="rewrite" && ct.includes("text/html")) {
        const html = await resp.text();
        body = rewriteHtml(html,target);
        headers.set("content-type","text/html; charset=utf-8");
      } else body = await resp.arrayBuffer();

      headers.set("access-control-allow-origin","*");
      headers.set("via","bepichon");
      headers.set("x-node",upstream||"none");

      return new Response(body,{status:resp.status,headers});
    } catch(e) {
      return new Response("bepichon error: "+String(e), {status:502});
    }
  }
};

/* -------------------- Utilities -------------------- */
function json(v){ return new Response(JSON.stringify(v),{ headers:{"Content-Type":"application/json"} }); }
async function fetchWithTimeout(url, opts={}, timeout=15000){
  const c = new AbortController(); opts.signal=c.signal;
  const id = setTimeout(()=>c.abort(),timeout);
  return fetch(url,opts).finally(()=>clearTimeout(id));
}
function filterRequestHeaders(h){
  const out = new Headers();
  h.forEach((v,k)=>{
    const lk = k.toLowerCase();
    if(!["host","connection","content-length","upgrade-insecure-requests"].includes(lk)) out.set(k,v);
  });
  if(!out.has("user-agent")) out.set("user-agent","bepichon/1.0");
  return out;
}
function stripResponseHeaders(h){ ["content-security-policy","x-frame-options","x-xss-protection","content-encoding","transfer-encoding","connection"].forEach(x=>h.delete(x)); }

/* --------- DNS / DoH --------- */
async function loadDnsList(env){
  try{
    if(env?.DNS_KV){
      const cached = await env.DNS_KV.get(DNS_CACHE_KEY);
      if(cached) return parseDnsText(cached);
    }
  } catch{}
  const r = await fetch(DNS_RAW_URL);
  const txt = await r.text();
  if(env?.DNS_KV) try{ await env.DNS_KV.put(DNS_CACHE_KEY,txt,{expirationTtl:DNS_CACHE_TTL}); } catch{}
  return parseDnsText(txt);
}
function parseDnsText(txt){ return txt.split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#")); }
async function refreshDnsList(env){ try{ const r = await fetch(DNS_RAW_URL); const txt = await r.text(); if(env?.DNS_KV) try{ await env.DNS_KV.put(DNS_CACHE_KEY,txt,{expirationTtl:DNS_CACHE_TTL}); } catch{} return true; } catch{return false;} }
async function resolveDoH(name,type="A",env){
  const nodes = await loadDnsList(env);
  const dohNodes = nodes.filter(n=>/^https?:\/\//i.test(n) && /\bdns\b|\bdoh\b|dns-query|dns.google/.test(n));
  const sample = dohNodes.slice(0,6); if(!sample.length) sample.push("https://dns.google/resolve");
  const tasks = sample.map(async d=>{
    try{
      let u = d + (d.endsWith("/")?"":"/") + "resolve?name="+encodeURIComponent(name)+"&type="+encodeURIComponent(type);
      const r = await fetchWithTimeout(u,{headers:{"accept":"application/json"}} ,3000);
      if(r.ok) return await r.json();
    } catch{} return null;
  });
  const results = (await Promise.all(tasks)).filter(Boolean);
  return results[0] || await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`).then(r=>r.json());
}
async function resolveDoHWire(name,type="A",env){
  const nodes = await loadDnsList(env);
  const dohNodes = nodes.filter(n=>/^https?:\/\//i.test(n) && /\bdns\b|\bdoh\b|dns-query|dns.google/.test(n));
  for(const d of dohNodes.slice(0,6)){
    try{
      const u = d + (d.includes("?")?"&":"?")+"name="+encodeURIComponent(name)+"&type="+encodeURIComponent(type);
      const r = await fetchWithTimeout(u,{headers:{"accept":"application/dns-message"}},3000);
      if(r.ok) return await r.arrayBuffer();
    } catch{}
  }
  throw new Error("wire DoH failed");
}
async function pickFastestNode(nodes){
  const sample = nodes.slice(0,10);
  const tests = sample.map(async n=>{
    try{ const t0=Date.now(); await fetchWithTimeout(n,{method:"HEAD"},BENCH_TIMEOUT); return {n, dt:Date.now()-t0}; } catch{return {n, dt:Infinity}; }
  });
  const res = (await Promise.all(tests));
  res.sort((a,b)=>a.dt-b.dt);
  return res[0]?.n || null;
}

/* --------- Proxy helpers --------- */
async function chooseUpstreamProxy(nodes){
  const proxies = nodes.filter(n=>/^https?:\/\//i.test(n) || /:\d+$/.test(n));
  if(!proxies.length) return null;
  const normalized = proxies.map(p=>p.startsWith("http")?p:"http://"+p);
  return normalized[0];
}

/* ---------- HTML rewrite / fetch override ---------- */
function rewriteHtml(html, base){ 
  const baseFor = (()=>{try{ const u=new URL(base); return u.origin+u.pathname.replace(/\/[^\/]*$/,''); } catch{return base;}})();
  let out = html.replace(/(href|src|action)=["']([^"']+)["']/gi,(m,a,u)=>`${a}="?url=${encodeURIComponent(absolutize(u,baseFor))}"`);
  out = out.replace(/url\(([^)]+)\)/gi,(m,u)=>`url(?url=${encodeURIComponent(absolutize(u.replace(/^['"]|['"]$/g,''),baseFor))})`);
  return out + injectFetchOverride();
}
function absolutize(u, base){ if(!u) return u; if(/^\s*https?:\/\//i.test(u)) return u; if(/^\s*\/\//.test(u)) return "http:"+u; if(/^\s*\//.test(u)) return base.replace(/\/$/,'')+u; return base.replace(/\/$/,'')+"/"+u; }
function injectFetchOverride(){ return `<script>(function(){const OF=window.fetch.bind(window);window.fetch=function(u,o){if(typeof u==='string' && !u.startsWith('http')) u=location.origin+(u.startsWith('/')?u:('/'+u)); return OF('?url='+encodeURIComponent(u),o);};})();</script>`; }

/* ---------- WebSocket Tunnel ---------- */
async function handleTunnel(req){
  if(req.headers.get("Upgrade")!=="websocket") return new Response("Upgrade required",{status:400});
  const [client,server] = new WebSocketPair();
  server.accept();
  server.addEventListener("message",async ev=>{
    try{
      const msg = JSON.parse(ev.data);
      if(msg.cmd==="fetch" && msg.url){
        try{
          const r = await fetchWithTimeout(msg.url,{method:msg.method||"GET", headers:msg.headers||{}},DEFAULT_TIMEOUT);
          const headers={}; r.headers.forEach((v,k)=>headers[k]=v);
          const body=await r.arrayBuffer();
          server.send(JSON.stringify({type:"response",status:r.status,headers,body:arrayBufferToBase64(body)}));
        } catch(e){ server.send(JSON.stringify({type:"error",message:String(e)})); }
      }
    } catch{}
  });
  return new Response(null,{status:101,webSocket:client});
}
function arrayBufferToBase64(buf){ const bytes=new Uint8Array(buf); let str=""; for(let i=0;i<bytes.length;i++) str+=String.fromCharCode(bytes[i]); return btoa(str); }

/* ---------- UI ---------- */
function uiPage(){ return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>bepichon</title>
<style>body{background:#111;color:#0f0;font-family:monospace;text-align:center;padding-top:30px}input{width:60%;padding:10px;margin:5px;border-radius:6px;border:1px solid #0f0;background:#111;color:#0f0}button{padding:8px 12px;border:none;background:#0f0;color:#000;border-radius:6px;cursor:pointer}iframe{width:98%;height:60vh;margin-top:12px;border:1px solid #0f0}</style></head><body>
<h1>bepichon — All-in-One Proxy</h1>
<p>Web/HTTP Proxy | DoH | DNS Forward | Tunnel</p>
<input id="u" placeholder="https://example.com"><button onclick="go()">GO</button>
<iframe id="fr"></iframe>
<script>function go(){let u=document.getElementById('u').value;if(!u) return;if(!u.startsWith('http')) u='http://'+u;document.getElementById('fr').src='?url='+encodeURIComponent(u);}</script>
</body></html>`,{headers:{"content-type":"text/html"}});

export { WSProxy };
