import { loadEnvironment } from "./env.ts";
import { errorFields } from "./http/problem.ts";
import { logEvent } from "./lib/log.ts";
import { startRuntime } from "./runtime.ts";

const environment = loadEnvironment();
const runtime = await startRuntime(environment);

const shutdown = () =>
  void runtime.shutdown().catch((error: unknown) => {
    // Never the message: driver errors can carry credentials in it.
    logEvent("error", "shutdown_failed", errorFields(error));
    process.exitCode = 1;
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Answerable ID listening on ${runtime.server.url}`);
