import { WSProxy } from './wsproxy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.searchParams.has("ws")) {
      // اینجا env.WS_DO همان Binding است
      const id = env.WS_DO.idFromName(url.toString());
      const obj = env.WS_DO.get(id);
      return obj.fetch(request);
    }

    // بقیه کد پروکسی HTTP/HTTPS
    return new Response("HTTP proxy active", { status: 200 });
  }
};
