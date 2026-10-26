import { UsageError } from "./errors"

/** The two GitHub environments, each backed by its own Civo account. */
export const ENVIRONMENTS = ["staging", "production"] as const

/** The name of a GitHub environment the pipeline deploys to. */
export type EnvironmentName = (typeof ENVIRONMENTS)[number]

/** The Kubernetes namespace the application chart installs into. */
export const NAMESPACE = "answerable"

/** The Helm release name of the application chart. */
export const RELEASE = "answerable"

/** The application chart, relative to the repository root. */
export const CHART = "charts/answerable"

/** Where the images live (`infra/pipeline/images.json`); each is `<registry>/<image>:sha-<commit>`, built for amd64, which Civo's nodes run. */
export const REGISTRY = "ghcr.io/rieranthony/answerable"

/** The public hostnames of one environment: ID, the Toolbox, the admin MCP and `mcp`, where the Toolbox serves each standalone MCP at `/<name>/mcp`. */
export type Hosts = { id: string; toolbox: string; admin: string; mcp: string }

const ZONES: Record<EnvironmentName, string> = {
  staging: "answerable-staging.uk",
  production: "answerable.org",
}

/** Read `--environment`: it must be one of {@link ENVIRONMENTS}. */
export function parseEnvironment(value: string | undefined): EnvironmentName {
  const found = ENVIRONMENTS.find((name) => name === value)
  if (!found) throw new UsageError(`--environment must be one of ${ENVIRONMENTS.join(", ")}`)
  return found
}

/** The hostnames of an environment: ID, the Toolbox, the admin MCP and that of the MCPs the Toolbox serves alone. */
export function hostsFor(environment: EnvironmentName): Hosts {
  const zone = ZONES[environment]
  return { id: `id.${zone}`, toolbox: `toolbox.${zone}`, admin: `admin-mcp.${zone}`, mcp: `mcp.${zone}` }
}

/** The Helm values overlay for an environment, relative to the repository root. */
export function defaultValuesFile(environment: EnvironmentName): string {
  return `charts/answerable/values-civo-${environment}.yaml`
}
