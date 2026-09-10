// Local synthetic traffic only. Requires Bun and Node; no database access.
import { clientRun } from "./id-request-reuse-probe.mjs";
import { Hono } from "../apps/id/node_modules/hono/dist/index.js";
import {
  limitRequestBody,
  maxRequestBodyBytes,
} from "../apps/id/src/http/request-limits.ts";

// The independent parser supplies the bytes it rejected, rather than inferring
// connection state from a failed HTTP status alone.
const source = `
const http = require('node:http');
const server = http.createServer((request, response) => {
  if (request.url === '/healthz') return response.end('ok');
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > 262144 && !response.writableEnded) {
      response.statusCode = 413;
      response.end('Payload Too Large');
    }
  });
});
server.on('clientError', (error, socket) => {
  console.error(JSON.stringify({
    code: error.code, reason: error.reason, bytesParsed: error.bytesParsed,
    packet: error.rawPacket?.toString().replace(/\\x00+/g, '<NUL>').slice(-2048)
  }));
  socket.end('HTTP/1.1 400 Bad Request\\r\\nConnection: close\\r\\n\\r\\n');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;
const child = Bun.spawn(["node", "-e", source], {
  stdout: "pipe",
  stderr: "pipe",
});
const errors = new Response(child.stderr).text();
let independentServer;
try {
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  const port = Number(new TextDecoder().decode(value).trim());
  if (!Number.isInteger(port) || port < 1)
    throw new Error("No local Node listener");
  independentServer = await clientRun(`http://127.0.0.1:${port}`, 500, false);
} finally {
  child.kill();
  await child.exited;
}
const parserErrors = (await errors)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const app = new Hono();
app.use("*", limitRequestBody);
app.post("/upload", (c) => c.text("accepted"));
let healthCalls = 0;
app.get("/healthz", (c) => {
  healthCalls++;
  return c.text("ok");
});
const server = Bun.serve({
  port: 0,
  maxRequestBodySize: maxRequestBodyBytes,
  fetch: app.fetch,
});
let freshUpload;
try {
  freshUpload = await clientRun(server.url, 500, true, true);
} finally {
  server.stop(true);
}
const version = Bun.spawnSync(["node", "--version"]);
console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      node: version.stdout.toString().trim(),
      independentServer,
      parserErrors,
      freshUpload: { ...freshUpload, healthCalls },
    },
    null,
    2,
  ),
);
