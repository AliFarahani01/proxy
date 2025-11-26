export class WSProxy {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(req) {
    // فقط WebSocket پشتیبانی می‌کنیم
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 400 });
    }

    // ساخت WebSocketPair
    const pair = new WebSocketPair();
    const client = pair[0]; // WebSocket برای client
    const server = pair[1]; // WebSocket برای server

    // اضافه کردن socket به مجموعه
    this.sockets.add(client);

    // رله کردن پیام‌ها بین client و server
    const relay = (src, dest) => {
      src.addEventListener("message", evt => {
        try {
          if (dest.readyState === 1) dest.send(evt.data);
        } catch {}
      });
    };

    relay(client, server);
    relay(server, client);

    // پاکسازی در هنگام بسته شدن
    const cleanup = () => this.sockets.delete(client);
    client.addEventListener("close", cleanup);
    server.addEventListener("close", cleanup);

    // پاسخ با WebSocket client
    return new Response(null, { status: 101, webSocket: client });
  }

  // ارسال پیام به همه کلاینت‌ها (اختیاری)
  broadcast(message) {
    for (const ws of this.sockets) {
      try {
        if (ws.readyState === 1) ws.send(message);
      } catch {}
    }
  }
}
