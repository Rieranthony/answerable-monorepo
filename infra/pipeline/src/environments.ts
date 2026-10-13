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

/** Where the four images live; each is `<registry>/<image>:sha-<commit>`, a manifest list for amd64 and arm64. */
export const REGISTRY = "ghcr.io/rieranthony/answerable"

/** The three public hostnames of one environment. */
export type Hosts = { id: string; toolbox: string; admin: string }

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

/** The hostnames of an environment: ID, the Toolbox and the admin MCP. */
export function hostsFor(environment: EnvironmentName): Hosts {
  const zone = ZONES[environment]
  return { id: `id.${zone}`, toolbox: `toolbox.${zone}`, admin: `admin-mcp.${zone}` }
}

/** The Helm values overlay for an environment, relative to the repository root. */
export function defaultValuesFile(environment: EnvironmentName): string {
  return `charts/answerable/values-civo-${environment}.yaml`
}

/** The `sops`-encrypted Secret manifests of an environment, relative to the repository root. */
export function defaultSecretsFile(environment: EnvironmentName): string {
  return `infra/civo/envs/${environment}/secrets.enc.yaml`
}
