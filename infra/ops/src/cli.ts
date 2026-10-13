// bun infra/ops/src/cli.ts bootstrap|register: the ops image's entry point (infra/ops/README.md). The logic and its tests are in commands.ts.
import { bunSql, main } from "./commands"
import { inClusterKubernetes } from "./kubernetes"

process.exitCode = await main(process.argv.slice(2), process.env, {
  database: bunSql,
  kubernetes: env => inClusterKubernetes(env),
  fetch: globalThis.fetch,
  log: line => console.log(line),
  error: line => console.error(line),
})
