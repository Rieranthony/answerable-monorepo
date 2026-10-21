// bun infra/ops/src/cli.ts bootstrap|register|make-admin: the ops image's entry point (infra/ops/README.md). The logic and its tests are in commands.ts.
import { main, pgSql } from "./commands"
import { fetchPresentedChain } from "./database-ca"
import { inClusterKubernetes } from "./kubernetes"

process.exitCode = await main(process.argv.slice(2), process.env, {
  database: pgSql,
  kubernetes: env => inClusterKubernetes(env),
  fetchChain: (host, port) => fetchPresentedChain(host, port),
  fetch: globalThis.fetch,
  log: line => console.log(line),
  error: line => console.error(line),
})
