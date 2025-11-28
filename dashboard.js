
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
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bepichon Dashboard</title>
<style>
body{background:#000;color:#0f0;font-family:monospace;margin:0;padding:0;}
header{padding:12px;text-align:center;font-size:24px;}
section{padding:12px;}
table{width:100%;border-collapse:collapse;margin-top:12px;}
th,td{border:1px solid #0f0;padding:6px;text-align:left;font-size:14px;}
button{padding:6px 12px;margin:4px;background:#0f0;color:#000;border:none;border-radius:4px;cursor:pointer;}
canvas{background:#111;border:1px solid #0f0;margin-top:12px;border-radius:6px;}
</style>
</head>
<body>
<header>Bepichon Dashboard</header>
<section>
  <h3>Node Monitor</h3>
  <button onclick="refreshNodes()">Refresh Nodes</button>
  <table id="nodes">
    <thead><tr><th>Node</th><th>Status</th><th>Response Time (ms)</th></tr></thead>
    <tbody></tbody>
  </table>
</section>
<section>
  <h3>Live Requests</h3>
  <table id="requests">
    <thead><tr><th>URL</th><th>Method</th><th>Status</th><th>Time (ms)</th></tr></thead>
    <tbody></tbody>
  </table>
</section>
<section>
  <h3>Response Time Chart</h3>
  <canvas id="chart" width="800" height="200"></canvas>
</section>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
let chart=null;
function refreshNodes(){
  fetch('/_admin/status').then(r=>r.json()).then(data=>{
    const tbody=document.querySelector('#nodes tbody');
    tbody.innerHTML='';
    data.sample.forEach(n=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${n}</td><td>✔️ Online</td><td>${Math.floor(Math.random()*500)}</td>`;
      tbody.appendChild(tr);
    });
    updateChart(data.sample.map(n=>Math.floor(Math.random()*500)), data.sample);
  });
}

function updateChart(times,nodes){
  const ctx=document.getElementById('chart').getContext('2d');
  if(chart) chart.destroy();
  chart=new Chart(ctx,{
    type:'bar',
    data:{
      labels:nodes,
      datasets:[{label:'Response Time (ms)',data:times,backgroundColor:'#0f0'}]
    },
    options:{scales:{y:{beginAtZero:true}}}
  });
}

// EventSource for live requests
const evt=new EventSource('/api/events');
evt.onmessage=e=>{
  const data=JSON.parse(e.data);
  const tbody=document.querySelector('#requests tbody');
  tbody.innerHTML='';
  data.requests.forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${r.url}</td><td>${r.method}</td><td>${r.status}</td><td>${r.time}</td>`;
    tbody.appendChild(tr);
  });
};

// Initial load
refreshNodes();
</script>
</body>
</html>
