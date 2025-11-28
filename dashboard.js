
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if(url.pathname === "/") return uiPage();
    if(url.pathname === "/_api/nodes") return getNodes(env);
    if(url.pathname === "/_api/refresh") return refreshDns(env);
    if(url.pathname === "/_api/events") return handleEvents(req, env);
    return new Response("Not Found", { status: 404 });
  }
};

async function loadDns(env){
  try{
    const txt = await env.DNS_KV.get("bepichon:dnslist");
    return txt ? txt.split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#")) : [];
  }catch(e){ return []; }
}

async function getNodes(env){
  const nodes = await loadDns(env);
  const results = await Promise.all(nodes.slice(0,20).map(async n=>{
    try{
      const t0 = Date.now();
      const r = await fetch(n,{method:"HEAD"});
      if(r) return {node:n,time:Date.now()-t0,status:r.status};
    }catch(e){ return {node:n,time:null,status:"timeout"}; }
  }));
  return json(results.filter(Boolean));
}

async function refreshDns(env){
  try{
    const r = await fetch("https://raw.githubusercontent.com/AliFarahani01/proxy/refs/heads/main/dns.text");
    const txt = await r.text();
    await env.DNS_KV.put("bepichon:dnslist", txt, { expirationTtl: 3600 });
    return json({ok:true});
  }catch(e){ return json({ok:false,error:String(e)}); }
}

function json(v){ return new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}}); }

/* ---------- EventSource ---------- */
async function handleEvents(req, env){
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };
  const body = new ReadableStream({
    async start(controller){
      const encoder = new TextEncoder();
      const send = async ()=>{
        try{
          const nodes = await loadDns(env);
          const results = await Promise.all(nodes.slice(0,20).map(async n=>{
            try{
              const t0 = Date.now();
              const r = await fetch(n,{method:"HEAD"});
              if(r) return {node:n,time:Date.now()-t0,status:r.status};
            }catch(e){ return {node:n,time:null,status:"timeout"}; }
          }));
          const data = results.filter(Boolean);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }catch(e){
          controller.enqueue(encoder.encode(`data: []\n\n`));
        }
      };
      // send every 5 seconds
      const interval = setInterval(send,5000);
      send();
      req.signal.addEventListener("abort",()=>clearInterval(interval));
    }
  });
  return new Response(body,{headers});
}

/* ---------- UI Page ---------- */
function uiPage(){
  return new Response(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Bepichon Live Dashboard</title>
<style>
body{background:#111;color:#0f0;font-family:monospace;padding:20px;}
table{border-collapse:collapse;width:100%;margin-top:20px;}
td,th{border:1px solid #0f0;padding:4px;text-align:left;}
canvas{background:#000;display:block;margin-top:20px;}
</style>
</head>
<body>
<h1>Bepichon Live Dashboard</h1>
<button onclick="refreshDns()">Refresh DNS</button>
<h2>Node Status</h2>
<table id="nodes"><tr><th>Node</th><th>Status</th><th>Time (ms)</th></tr></table>
<h2>Response Times (ms)</h2>
<canvas id="chart" width="800" height="300"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
const ctx = document.getElementById('chart').getContext('2d');
let chart = new Chart(ctx,{
  type:'bar',
  data:{labels:[],datasets:[{label:'Response Time (ms)',data:[],backgroundColor:'rgba(0,255,0,0.5)'}]},
  options:{scales:{y:{beginAtZero:true}}}
});

const evt = new EventSource('/_api/events');
evt.onmessage = e=>{
  const nodes = JSON.parse(e.data);
  const table = document.getElementById('nodes');
  table.innerHTML='<tr><th>Node</th><th>Status</th><th>Time (ms)</th></tr>';
  const labels = [];
  const data = [];
  nodes.forEach(n=>{
    const row = table.insertRow();
    row.insertCell(0).innerText = n.node;
    row.insertCell(1).innerText = n.status;
    row.insertCell(2).innerText = n.time || '-';
    labels.push(n.node);
    data.push(n.time || 0);
  });
  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.update();
};

async function refreshDns(){
  await fetch('/_api/refresh');
  alert('DNS refreshed!');
}
</script>
</body>
</html>`, {headers:{"Content-Type":"text/html; charset=utf-8"}});
}
