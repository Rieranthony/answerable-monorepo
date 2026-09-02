import { loadEnvironment } from "./env.ts";
import { startRuntime } from "./runtime.ts";

const environment = loadEnvironment();
const runtime = startRuntime(environment);

process.once("SIGINT", runtime.shutdown);
process.once("SIGTERM", runtime.shutdown);

console.log(`Answerable ID listening on ${runtime.server.url}`);
