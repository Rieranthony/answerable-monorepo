// Run with Bun from the repository root. No database or remote service is used.
import { Hono } from "../apps/id/node_modules/hono/dist/index.js";
import {
  limitRequestBody,
  maxRequestBodyBytes,
} from "../apps/id/src/http/request-limits.ts";

export async function clientRun(
  url,
  attempts,
  freshConnections,
  freshUploadOnly = false,
) {
  const failures = [];
  for (let iteration = 0; iteration < attempts; iteration++) {
    let remaining = 262145;
    const upload = await fetch(new URL("/upload", url), {
      method: "POST",
      duplex: "half",
      ...(freshConnections ? { keepalive: false } : {}),
      body: new ReadableStream({
        pull(output) {
          if (!remaining) return output.close();
          const count = Math.min(16384, remaining);
          remaining -= count;
          output.enqueue(new Uint8Array(count));
        },
      }),
    });
    await upload.arrayBuffer();
    const health = await fetch(new URL("/healthz", url), {
      ...(freshConnections && !freshUploadOnly ? { keepalive: false } : {}),
    });
    const body = await health.text();
    if (upload.status !== 413 || health.status !== 200 || body !== "ok")
      failures.push({
        iteration,
        upload: upload.status,
        health: health.status,
        body,
      });
  }
  return { attempts, failures };
}

if (import.meta.main) {
  const results = [];
  for (const scenario of [
    { name: "native-cap-bun-client", nativeCap: true },
    { name: "native-cap-close-bun-client", nativeCap: true, close: true },
    { name: "higher-cap-close-bun-client", nativeCap: false, close: true },
    { name: "native-cap-fresh-bun-client", nativeCap: true, fresh: true },
    { name: "native-cap-node-client", nativeCap: true, node: true },
  ]) {
    const app = new Hono();
    app.use("*", limitRequestBody);
    app.post("/upload", async (c) =>
      c.text(String((await c.req.raw.arrayBuffer()).byteLength)),
    );
    let healthCalls = 0;
    app.get("/healthz", (c) => {
      healthCalls++;
      return c.text("ok");
    });
    const server = Bun.serve({
      port: 0,
      // The higher cap is an isolation experiment, not a proposed production limit.
      maxRequestBodySize: scenario.nativeCap ? maxRequestBodyBytes : 1024 ** 3,
      async fetch(request) {
        const response = await app.fetch(request);
        if (scenario.close && response.status >= 400)
          response.headers.set("Connection", "close");
        return response;
      },
    });
    try {
      let result;
      if (scenario.node) {
        const source = `(${clientRun.toString()})(process.argv[1], 500, false).then(r => console.log(JSON.stringify(r)))`;
        const child = Bun.spawn(["node", "-e", source, server.url.toString()], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`Node probe failed: ${stderr}`);
        result = JSON.parse(stdout);
      } else result = await clientRun(server.url, 500, scenario.fresh ?? false);
      results.push({ scenario: scenario.name, healthCalls, ...result });
    } finally {
      server.stop(true);
    }
  }
  console.log(JSON.stringify({ bun: Bun.version, results }, null, 2));
}
