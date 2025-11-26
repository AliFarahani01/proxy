export default {
  async fetch(req) {
    const url = new URL(req.url);

    // اگر ورودی نداد، UI
    if (!url.searchParams.has("url"))
      return ui();

    const target = decodeURIComponent(url.searchParams.get("url"));
    const fixed = target.startsWith("http") ? target : "http://" + target;

    try {
      const resp = await fetch(fixed, {
        method: req.method,
        headers: cleanHeaders(req.headers),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "follow",
      });

      const headers = new Headers(resp.headers);
      strip(headers);

      let body;

      // اگر HTML بود = بازنویسی کامل
      if ((headers.get("content-type") || "").includes("text/html")) {
        const html = await resp.text();
        body = rewrite(html, fixed) + inject();
        headers.set("content-type", "text/html; charset=utf-8");
      } else {
        body = await resp.arrayBuffer();
      }

      headers.set("access-control-allow-origin", "*");
      headers.set("via", "bepichon-worker");

      return new Response(body, { status: resp.status, headers });

    } catch (e) {
      return new Response("Proxy Error:\n" + e.toString(), { status: 500 });
    }
  }
};

/* ---- Utils ---- */
function cleanHeaders(h) {
  const out = new Headers();
  h.forEach((v,k)=>{
    if (!["host","content-length","connection"].includes(k.toLowerCase()))
      out.set(k,v);
  });
  return out;
}

function strip(h) {
  ["content-security-policy","x-frame-options","x-xss-protection","content-encoding",
  "transfer-encoding","connection"].forEach(x => h.delete(x));
}

function rewrite(html, base) {
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (m,a,u)=>{
    return `${a}="?url=${encodeURIComponent(ab(u,base))}"`;
  });
  html = html.replace(/url\(([^)]+)\)/gi, (m,u)=>{
    return `url(?url=${encodeURIComponent(ab(u.replace(/['"]/g,''),base))})`;
  });
  return html;
}

function ab(u, base) {
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return "http:" + u;
  if (u.startsWith("/")) return base + u;
  return base + "/" + u;
}

function inject() {
  return `<script>
  (function(){
    const F = window.fetch.bind(window);
    window.fetch = (u,o)=>F('?url='+encodeURIComponent(u),o);
  })();
  </script>`;
}

function ui() {
  return new Response(`
  <html><body style="background:#000;color:#0f0;text-align:center;font-family:monospace;padding-top:40px">
    <h1>bepichon</h1>
    <input id="u" placeholder="https://example.com" style="width:60%;padding:10px">
    <button onclick="go()" style="padding:10px;margin-left:10px">GO</button>
    <iframe id="f" style="width:90%;height:70vh;margin-top:20px;border:1px solid #0f0"></iframe>
    <script>
      function go(){
        let u=document.getElementById('u').value;
        if(!u.startsWith('http'))u='http://'+u;
        document.getElementById('f').src='?url='+encodeURIComponent(u);
      }
    </script>
  </body></html>`,
  { headers: {"content-type":"text/html"} });
}
