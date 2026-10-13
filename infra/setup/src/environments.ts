import { join, relative } from "node:path"
import { UsageError } from "./errors"

/** The two environments, each in its own Civo account (D28). */
export const ENVIRONMENTS = ["staging", "production"] as const

/** One of {@link ENVIRONMENTS}. */
export type EnvironmentName = (typeof ENVIRONMENTS)[number]

/** The GitHub repository whose environments the deploy workflows use. */
export const REPOSITORY = "Rieranthony/answerable-monorepo"

/** The Kubernetes namespace of the application, where the three Secrets of the `sops` file go. */
export const NAMESPACE = "answerable"

/** The slug ID gives the platform organisation it seeds at its first start. */
export const PLATFORM_SLUG = "answerable"

/** Each environment's Cloudflare zone (D12). */
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

/** The Cloudflare zone an environment's hostnames live in. */
export function zoneFor(environment: EnvironmentName): string {
  return ZONES[environment]
}

/**
 * The operators' addresses for the Kubernetes API, `ALLOWED_API_CIDRS` (or Terraform's own `TF_VAR_allowed_api_cidrs`):
 * a JSON list of CIDRs, normalised. Staging may leave it out (its API is open by its own switch, D30); production
 * cannot, because those addresses are its only way in.
 */
export function allowedApiCidrs(env: Readonly<Record<string, string | undefined>>, environment: EnvironmentName): string | undefined {
  const text = env.ALLOWED_API_CIDRS?.trim() || env.TF_VAR_allowed_api_cidrs?.trim()
  if (!text) {
    if (environment === "production")
      throw new UsageError(
        "ALLOWED_API_CIDRS is not set: production's Kubernetes API admits only these addresses, e.g. '[\"198.51.100.7/32\"]'",
      )
    return undefined
  }
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    list = undefined
  }
  const cidr = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-fA-F:]+\/\d{1,3}$/
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && cidr.test(item)))
    throw new UsageError("ALLOWED_API_CIDRS must be a JSON list of CIDRs, such as '[\"198.51.100.7/32\"]'")
  if (environment === "production" && list.length === 0)
    throw new UsageError("ALLOWED_API_CIDRS is empty: production's Kubernetes API admits only these addresses")
  return JSON.stringify(list)
}

/** Every file a setup command reads or writes for one environment, as absolute paths. */
export type Paths = {
  /** The repository root. */
  root: string
  /** The environment's Terraform root, `infra/civo/envs/<env>`. */
  envDir: string
  /** The `sops`-encrypted Secret manifests. */
  secretsFile: string
  /** The origin-pull CA's public certificate, which Terraform hands to the platform chart. */
  edgeCa: string
  /** The database's CA certificate, which the deploy hands to the application chart. */
  databaseCa: string
  /** The application chart's values for the environment, where the hostnames are. */
  valuesFile: string
  /** `sops`'s configuration, the repository's `.sops.yaml` unless `--sops-config` names another. */
  sopsConfig: string
  /** The environment's `age` identity, `answerable-<env>.txt` in `--key-dir` (default `~/.config/sops/age`). */
  keyFile: string
}

/** Where the command line may move the `sops` configuration and the `age` key, for a dry run against throwaway files. */
export type PathOptions = { root: string; home: string; sopsConfig?: string; keyDir?: string }

/** The files of one environment. */
export function pathsFor(environment: EnvironmentName, options: PathOptions): Paths {
  const envDir = join(options.root, "infra/civo/envs", environment)
  return {
    root: options.root,
    envDir,
    secretsFile: join(envDir, "secrets.enc.yaml"),
    edgeCa: join(envDir, "edge-ca/ca.pem"),
    databaseCa: join(envDir, "database-ca.pem"),
    valuesFile: join(options.root, `charts/answerable/values-civo-${environment}.yaml`),
    sopsConfig: options.sopsConfig ?? join(options.root, ".sops.yaml"),
    keyFile: join(options.keyDir ?? join(options.home, ".config/sops/age"), `answerable-${environment}.txt`),
  }
}

/** A path as the operator should read it: relative to the repository root when it is inside it. */
export function shown(paths: Pick<Paths, "root">, path: string): string {
  const inside = relative(paths.root, path)
  return inside.startsWith("..") || inside === "" ? path : inside
}
