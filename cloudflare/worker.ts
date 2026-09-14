// Hosting bootstrap only. The autonomous studio still runs in the Node harness.
export default {
  fetch(request: Request): Response {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...headers, Allow: "GET, HEAD" },
      });
    }
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      const body = JSON.stringify({ service: "theartist", status: "ok", studioRuntime: "not-connected" });
      return new Response(request.method === "HEAD" ? null : body, {
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (path === "/") {
      const body = "Theartist\nOpen-source autonomous studio.\nHosting is ready; the studio runtime is not connected yet.\nhttps://github.com/mbodge/theartist\n";
      return new Response(request.method === "HEAD" ? null : body, {
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers });
  },
};
