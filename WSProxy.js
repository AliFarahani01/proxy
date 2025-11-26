export class WSProxy {
  constructor(state, env) {
    this.state = state;
    this.sockets = new Set();
  }

  async fetch(req) {
    // WebSocket upgrade
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    const url = new URL(req.url);
    const targetUrl = decodeURIComponent(url.searchParams.get("url"));
    
    this.sockets.add(client);

    client.addEventListener("message", evt => {
      try { server.send(evt.data); } catch {}
    });
    server.addEventListener("message", evt => {
      try { client.send(evt.data); } catch {}
    });

    const cleanup = () => this.sockets.delete(client);
    client.addEventListener("close", cleanup);
    server.addEventListener("close", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}
