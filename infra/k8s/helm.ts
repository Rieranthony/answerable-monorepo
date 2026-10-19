import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The repository root and the charts directory. */
export const repo = Bun.fileURLToPath(new URL("../../", import.meta.url))
export const charts = join(repo, "charts")

/** The Kubernetes version kubeconform validates against: Civo's, as `infra/check.ts` does. */
export const kubernetesVersion = "1.33.0"
/** Where kubeconform finds the schemas of custom resources (Traefik's), as `infra/check.ts` does. */
export const crdSchemas = "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"

/** A rendered Kubernetes object, loosely typed: the tests read paths they assert on. */
export type Manifest = {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [field: string]: any
}

type RunOptions = { cwd?: string; stdin?: string; env?: Record<string, string | undefined> }

/** Run a command to completion and return its exit code and output, without a shell. */
export function run(command: string[], options: RunOptions = {}) {
  const result = Bun.spawnSync(command, { cwd: options.cwd ?? repo, env: options.env ?? process.env, stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin), stdout: "pipe", stderr: "pipe" })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

/** Run a command and return its standard output; throw with its standard error when it fails. */
export function check(command: string[], options: RunOptions = {}) {
  const result = run(command, options)
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${result.exitCode}: ${result.stderr || result.stdout}`)
  return result.stdout
}

/** The values overlays of a chart, `values-*.yaml`, sorted. */
export function overlays(chart: string) {
  return readdirSync(join(charts, chart)).filter(name => /^values-.+\.ya?ml$/.test(name)).sort()
}

/** The `helm template` arguments for a chart with its defaults, then each values file, then each `--set`, then each `--set-file` (value from a file's contents). */
export function templateArguments(chart: string, values: string[] = [], set: Record<string, string> = {}, files: Record<string, string> = {}) {
  return [
    "helm", "template", chart, join(charts, chart), "--namespace", chart,
    ...values.flatMap(file => ["--values", join(charts, chart, file)]),
    ...Object.entries(set).flatMap(([key, value]) => ["--set", `${key}=${value}`]),
    ...Object.entries(files).flatMap(([key, path]) => ["--set-file", `${key}=${path}`]),
  ]
}

/** Render a chart and parse every object it produces. */
export function render(chart: string, values: string[] = [], set: Record<string, string> = {}, files: Record<string, string> = {}): Manifest[] {
  const documents = Bun.YAML.parse(check(templateArguments(chart, values, set, files))) as unknown
  return (Array.isArray(documents) ? documents : [documents]).filter((document): document is Manifest => document !== null && typeof document === "object")
}

/**
 * Build a chart's dependencies from its Chart.lock. `helm dependency build` resolves an HTTPS repository only once it is
 * added, so each one is added first to a repository list of this process's own, never the user's.
 */
export function buildDependencies(chart: string) {
  const declared = Bun.YAML.parse(readFileSync(join(charts, chart, "Chart.yaml"), "utf8")) as { dependencies?: { name: string; repository: string }[] }
  for (const dependency of declared.dependencies ?? []) {
    if (dependency.repository.startsWith("https://")) check(["helm", "repo", "add", dependency.name, dependency.repository, "--force-update"], { env: helmEnv })
  }
  check(["helm", "dependency", "build", join(charts, chart)], { env: helmEnv })
}

const helmHome = mkdtempSync(join(tmpdir(), "answerable-helm-"))
/** Helm's environment for dependency builds: a repository list and cache of this process's own. */
export const helmEnv = { ...process.env, HELM_REPOSITORY_CONFIG: join(helmHome, "repositories.yaml"), HELM_REPOSITORY_CACHE: join(helmHome, "repository") }
