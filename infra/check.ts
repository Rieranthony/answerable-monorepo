// `bun run infra:check`: every infrastructure gate that needs no cloud account, no credential and no Docker.
// The steps run in order; the first failure stops the run and names its step. CI runs the same script.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

const repo = Bun.fileURLToPath(new URL("../", import.meta.url))
const infra = join(repo, "infra")
const charts = join(repo, "charts")

// Rendered manifests are validated against the schemas of this Kubernetes version, and custom resources against the
// community catalogue; a kind with no schema anywhere is reported as skipped in the summary rather than failing.
const kubernetesVersion = "1.33.0"
const crdSchemas =
  "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"

// One plugin cache for every Terraform directory, so a provider downloads once per checkout rather than once per
// module. It lives inside this checkout (ignored by Git, skipped by every scan) and not in the home directory: the
// cache is not safe for concurrent use, and on macOS a provider binary rewritten in place by another checkout's run is
// killed on start (exit 137). Terraform reports an error for a cache directory that does not exist, so it is created.
const pluginCache =
  process.env.TF_PLUGIN_CACHE_DIR ?? join(infra, ".terraform/plugin-cache")
mkdirSync(pluginCache, { recursive: true })
const terraformEnv = {
  ...process.env,
  TF_IN_AUTOMATION: "1",
  TF_PLUGIN_CACHE_DIR: pluginCache,
}

// Helm's repository list and cache for the dependency builds, in a directory of this run's own.
const helmHome = mkdtempSync(join(tmpdir(), "answerable-infra-check-helm-"))
const helmEnv = {
  ...process.env,
  HELM_REPOSITORY_CONFIG: join(helmHome, "repositories.yaml"),
  HELM_REPOSITORY_CACHE: join(helmHome, "repository"),
}

const show = (path: string) => relative(repo, path) || "."

async function run(
  command: string[],
  cwd = repo,
  env: Record<string, string | undefined> = process.env,
) {
  console.log(
    `$ ${command.join(" ")}${cwd === repo ? "" : `  (in ${show(cwd)})`}`,
  )
  const code = await Bun.spawn(command, {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).exited
  if (code !== 0) throw new Error(`${command[0]} exited with ${code}`)
}

// `helm template … | kubeconform …`, failing when either side fails.
async function pipe(from: string[], to: string[]) {
  console.log(`$ ${from.join(" ")} | ${to.join(" ")}`)
  const source = Bun.spawn(from, {
    cwd: repo,
    stdout: "pipe",
    stderr: "inherit",
  })
  const sink = Bun.spawn(to, {
    cwd: repo,
    stdin: source.stdout,
    stdout: "inherit",
    stderr: "inherit",
  })
  const [sourceCode, sinkCode] = await Promise.all([source.exited, sink.exited])
  if (sourceCode !== 0) throw new Error(`${from[0]} exited with ${sourceCode}`)
  if (sinkCode !== 0) throw new Error(`${to[0]} exited with ${sinkCode}`)
}

// Every directory under `infra/` holding `.tf` files, skipping Terraform's own working directories.
function terraformDirectories(dir = infra): string[] {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true })
  const here = entries.some(
    (entry) => entry.isFile() && entry.name.endsWith(".tf"),
  )
    ? [dir]
    : []
  const below = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        ![".terraform", "node_modules"].includes(entry.name),
    )
    .flatMap((entry) => terraformDirectories(join(dir, entry.name)))
  return [...here, ...below].sort()
}

// A root module carries a backend and a committed lock file; a shared module has neither.
const isRoot = (dir: string) => existsSync(join(dir, "backend.tf"))
const testFiles = (dir: string) =>
  existsSync(join(dir, "tests"))
    ? readdirSync(join(dir, "tests"))
        .filter((name) => name.endsWith(".tftest.hcl"))
        .sort()
    : []
const hasTests = (dir: string) => testFiles(dir).length > 0

// The `terraform test` runs of one directory. A module's tests run in one go. A root with per-environment values
// (envs/<environment>.tfvars) runs each environment's file, tests/<environment>.tftest.hcl, with those values, as
// terraform.sh plans it; an environment without its test file, or a test file without its values, fails the check.
function testRuns(dir: string): string[][] {
  const envs = join(dir, "envs")
  if (!existsSync(envs)) return [[]]
  const environments = readdirSync(envs)
    .filter((name) => name.endsWith(".tfvars"))
    .map((name) => name.slice(0, -".tfvars".length))
    .sort()
  const tested = testFiles(dir).map((name) =>
    name.slice(0, -".tftest.hcl".length),
  )
  const missing = [
    ...environments
      .filter((name) => !tested.includes(name))
      .map((name) => `tests/${name}.tftest.hcl`),
    ...tested
      .filter((name) => !environments.includes(name))
      .map((name) => `envs/${name}.tfvars`),
  ]
  if (missing.length > 0)
    throw new Error(
      `${show(dir)} pairs each envs/<environment>.tfvars with tests/<environment>.tftest.hcl; missing ${missing.join(", ")}`,
    )
  return environments.map((name) => [
    `-filter=tests/${name}.tftest.hcl`,
    `-var-file=envs/${name}.tfvars`,
  ])
}

function chartDirectories() {
  if (!existsSync(charts)) return []
  return readdirSync(charts, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(charts, entry.name, "Chart.yaml")),
    )
    .map((entry) => join(charts, entry.name))
    .sort()
}

// The certificates Terraform and the deploy pass to each chart (`--set-file`), without which the chart refuses to render:
// the real ones are per environment under infra/civo/envs, so a placeholder PEM stands in for them here.
const suppliedCertificates: Record<string, string> = {
  answerable: "database.caPem",
  platform: "originPull.caPem",
}
const placeholderPem = join(
  mkdtempSync(join(tmpdir(), "answerable-infra-check-ca-")),
  "placeholder-ca.pem",
)
writeFileSync(
  placeholderPem,
  "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n",
)

// The values files a chart is rendered with: the defaults alone, then each overlay on top of them.
function valuesOverlays(chart: string) {
  return readdirSync(chart)
    .filter((name) => /^values-.+\.ya?ml$/.test(name))
    .sort()
}

async function helmSteps() {
  const found = chartDirectories()
  if (found.length === 0) {
    console.log(
      "No charts/ directory with a Chart.yaml: the Helm steps are skipped.",
    )
    return
  }
  for (const chart of found) {
    const name = chart.split("/").at(-1)!
    const declared = Bun.YAML.parse(
      readFileSync(join(chart, "Chart.yaml"), "utf8"),
    ) as { dependencies?: { name: string; repository: string }[] }
    if (declared.dependencies?.length) {
      // `helm dependency build` resolves an HTTPS repository only once it is added; an OCI one needs nothing. Today every
      // dependency is OCI; an HTTPS one would be added to a repository list of this run's own, never the user's.
      for (const dependency of declared.dependencies)
        if (dependency.repository.startsWith("https://"))
          await run(
            [
              "helm",
              "repo",
              "add",
              dependency.name,
              dependency.repository,
              "--force-update",
            ],
            repo,
            helmEnv,
          )
      await run(["helm", "dependency", "build", show(chart)], repo, helmEnv)
    }
    const supplied = suppliedCertificates[name]
      ? ["--set-file", `${suppliedCertificates[name]}=${placeholderPem}`]
      : []
    await run(["helm", "lint", "--strict", show(chart), ...supplied])
    for (const overlay of [undefined, ...valuesOverlays(chart)]) {
      const values = [
        ...(overlay ? ["--values", join(show(chart), overlay)] : []),
        ...supplied,
      ]
      if (overlay)
        await run(["helm", "lint", "--strict", show(chart), ...values])
      await pipe(
        ["helm", "template", name, show(chart), "--namespace", name, ...values],
        [
          "kubeconform",
          "-strict",
          "-summary",
          "-ignore-missing-schemas",
          "-kubernetes-version",
          kubernetesVersion,
          "-schema-location",
          "default",
          "-schema-location",
          crdSchemas,
          "-",
        ],
      )
    }
  }
}

const steps: { name: string; run: () => Promise<void> | void }[] = [
  { name: "Helm lint and kubeconform", run: helmSteps },
  {
    name: "terraform fmt",
    run: () =>
      run(["terraform", "fmt", "-check", "-recursive", "-diff", "infra"]),
  },
  {
    name: "terraform init and validate",
    run: async () => {
      for (const dir of terraformDirectories()) {
        await run(
          [
            "terraform",
            "init",
            "-backend=false",
            "-input=false",
            ...(isRoot(dir) ? ["-lockfile=readonly"] : []),
          ],
          dir,
          terraformEnv,
        )
        await run(["terraform", "validate"], dir, terraformEnv)
      }
    },
  },
  {
    name: "terraform test",
    run: async () => {
      for (const dir of terraformDirectories().filter(hasTests))
        for (const options of testRuns(dir))
          await run(["terraform", "test", ...options], dir, terraformEnv)
    },
  },
  {
    name: "tflint",
    run: () =>
      run(
        ["tflint", "--recursive", "--config", join(infra, ".tflint.hcl")],
        infra,
      ),
  },
  {
    name: "trivy config",
    run: async () => {
      for (const target of [infra, charts].filter((dir) => existsSync(dir))) {
        await run([
          "trivy",
          "config",
          "--quiet",
          "--skip-check-update",
          "--severity",
          "HIGH,CRITICAL",
          "--exit-code",
          "1",
          "--skip-dirs",
          "**/.terraform",
          // The dependency archives `helm dependency build` downloads are upstream charts (Traefik), not ours:
          // their findings are not ours to fix. Our own templates are scanned, and rendered and validated by the
          // Helm step.
          "--skip-dirs",
          "charts/*/charts",
          show(target),
        ])
      }
    },
  },
  {
    // The workflow files by name, so that actionlint needs no Git checkout around them.
    name: "actionlint",
    run: () =>
      run([
        "actionlint",
        ...[
          ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
            cwd: repo,
            dot: true,
          }),
        ].sort(),
      ]),
  },
]

for (const step of steps) {
  console.log(`\n== infra:check: ${step.name}`)
  try {
    await step.run()
  } catch (error) {
    console.error(
      `\ninfra:check failed at "${step.name}": ${(error as Error).message}`,
    )
    process.exit(1)
  }
}
console.log("\ninfra:check passed.")
