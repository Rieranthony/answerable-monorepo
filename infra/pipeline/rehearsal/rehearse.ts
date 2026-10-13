// Runs the pipeline scripts for real: kubectl, helm and sops against a throwaway kind cluster, signed in with a
// namespace-scoped ServiceAccount token, the way the deploy workflows sign in. A stand-in chart replaces
// charts/answerable, so this proves the scripts and the tools, not the chart.
//
//   bun run --filter @answerable/infra-pipeline rehearse [-- --secrets multi-document|list]
//
// Needs Docker, kind, kubectl, helm, sops and age-keygen. It creates a cluster named
// answerable-pipeline-rehearsal with its own kubeconfig, so your kubeconfig and contexts are never touched, and it
// deletes the cluster at the end. It takes two to three minutes.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { currentTag, deploy, runJob, type Deps } from "../src/deploy"
import { PipelineError } from "../src/errors"
import { systemRunner } from "../src/run"

const CLUSTER = "answerable-pipeline-rehearsal"
const TAG = `sha-${"1".repeat(40)}`
const NEXT_TAG = `sha-${"2".repeat(40)}`
const SECOND_TAG = `sha-${"3".repeat(40)}`
// What `bun run setup database-ca` writes: public, and rendered into the postgres-ca ConfigMap by the chart.
const DATABASE_CA = "-----BEGIN CERTIFICATE-----\nMIIBrehearsal\n-----END CERTIFICATE-----\n"
// What the registry would answer; the rehearsal pushes no image, so it hands the digests over.
const DIGESTS = {
  id: `sha256:${"a".repeat(64)}`,
  toolbox: `sha256:${"b".repeat(64)}`,
  "admin-mcp": `sha256:${"c".repeat(64)}`,
  ops: `sha256:${"d".repeat(64)}`,
}

const CHART = {
  "Chart.yaml": "apiVersion: v2\nname: answerable\nversion: 0.0.0\n",
  "values.yaml": `image:
  tag: ""
images:
  id: {digest: ""}
  toolbox: {digest: ""}
  admin-mcp: {digest: ""}
  ops: {digest: ""}
database:
  caPem: ""
failMigrate: false
ops:
  bootstrap: false
  register: false
`,
  "templates/postgres-ca.yaml": `apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-ca
data:
  ca.pem: {{ .Values.database.caPem | quote }}
`,
  "templates/deployments.yaml": `{{- range $name := list "id" "toolbox" "admin-mcp" }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: answerable-{{ $name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ $name }}
  template:
    metadata:
      labels:
        app: {{ $name }}
      annotations:
        image-tag: {{ $.Values.image.tag | quote }}
        image-digest: {{ (index $.Values.images $name).digest | quote }}
    spec:
      containers:
        - name: app
          image: busybox:1.36
          command: ["sh", "-c", "sleep 3600"]
          readinessProbe:
            exec:
              command: ["true"]
            periodSeconds: 1
---
{{- end }}
`,
  "templates/jobs.yaml": `apiVersion: batch/v1
kind: Job
metadata:
  name: answerable-id-migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "0"
    helm.sh/hook-delete-policy: before-hook-creation
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              echo "migrating for {{ .Values.image.tag }}"
              {{- if .Values.failMigrate }}
              echo "migration exploded: relation users does not exist"
              exit 3
              {{- else }}
              echo "migrated"
              {{- end }}
{{- if .Values.ops.bootstrap }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: answerable-ops-bootstrap
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-10"
    helm.sh/hook-delete-policy: before-hook-creation
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: bootstrap
          image: busybox:1.36
          command: ["sh", "-c", "echo bootstrapped"]
{{- end }}
{{- if .Values.ops.register }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: answerable-ops-register
  annotations:
    helm.sh/hook: post-install,post-upgrade
    helm.sh/hook-delete-policy: before-hook-creation
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: register
          image: busybox:1.36
          command: ["sh", "-c", "echo registered"]
{{- end }}
`,
}

const SECRETS = {
  "multi-document": `apiVersion: v1
kind: Secret
metadata:
  name: id-env
stringData:
  BETTER_AUTH_SECRET: rehearsal-secret-value-one
---
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
stringData:
  api-token: rehearsal-secret-value-two
`,
  list: `apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: id-env
    stringData:
      BETTER_AUTH_SECRET: rehearsal-secret-value-one
  - apiVersion: v1
    kind: Secret
    metadata:
      name: cloudflare-api-token
    stringData:
      api-token: rehearsal-secret-value-two
`,
}

const { values: options } = parseArgs({ options: { secrets: { type: "string", default: "multi-document" } } })
if (options.secrets !== "multi-document" && options.secrets !== "list")
  throw new Error("--secrets must be multi-document or list")
const secretsShape = options.secrets

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

async function run(argv: string[], input?: string) {
  return systemRunner(argv, { input })
}

for (const tool of ["docker", "kind", "kubectl", "helm", "sops", "age-keygen"]) {
  if ((await run(["which", tool])).exitCode !== 0) throw new Error(`${tool} is not on the path`)
}

const work = await mkdtemp(join(tmpdir(), "pipeline-rehearsal-"))
const kubeconfig = join(work, "admin-kubeconfig")
const kubectl = (...args: string[]) => run(["kubectl", "--kubeconfig", kubeconfig, ...args])

try {
  console.log(`Creating the kind cluster ${CLUSTER} ...`)
  const created = await run(["kind", "create", "cluster", "--name", CLUSTER, "--kubeconfig", kubeconfig, "--wait", "180s"])
  if (created.exitCode !== 0) throw new Error(`kind create cluster failed: ${created.stderr}`)

  // The deployer: an admin of the answerable namespace and of nothing else, as the Terraform root will make it.
  await kubectl("create", "namespace", "answerable")
  await kubectl("create", "serviceaccount", "deployer", "-n", "answerable")
  await kubectl("create", "rolebinding", "deployer", "-n", "answerable", "--clusterrole=admin", "--serviceaccount=answerable:deployer")
  const token = (await kubectl("create", "token", "deployer", "-n", "answerable", "--duration=1h")).stdout.trim()
  const view = JSON.parse((await kubectl("config", "view", "--minify", "--raw", "-o", "json")).stdout)
  const server = view.clusters[0].cluster.server as string
  const authority = view.clusters[0].cluster["certificate-authority-data"] as string
  check("the deployer token and the cluster details were obtained", token.length > 20 && authority.length > 100, server)

  // A throwaway age key and a file encrypted to it.
  const keygen = await run(["age-keygen"])
  const publicKey = /public key: (age1\w+)/.exec(keygen.stderr + keygen.stdout)?.[1]
  const secretKey = /(AGE-SECRET-KEY-\w+)/.exec(keygen.stdout)?.[1]
  if (!publicKey || !secretKey) throw new Error("age-keygen printed no key")
  process.env.SOPS_AGE_KEY = secretKey

  const root = join(work, "repository")
  for (const [name, content] of Object.entries(CHART)) {
    await mkdir(join(root, "charts/answerable", name, ".."), { recursive: true })
    await writeFile(join(root, "charts/answerable", name), content)
  }
  await writeFile(join(root, "charts/answerable/values-civo-staging.yaml"), "{}\n")
  await writeFile(join(root, "charts/answerable/values-fail.yaml"), "failMigrate: true\n")
  await mkdir(join(root, "infra/civo/envs/staging"), { recursive: true })
  await writeFile(join(root, "infra/civo/envs/staging/database-ca.pem"), DATABASE_CA)
  await writeFile(join(work, "plain.yaml"), SECRETS[secretsShape])
  const encrypted = await run([
    "sops", "--encrypt", "--age", publicKey, "--input-type", "yaml", "--output-type", "yaml",
    "--encrypted-regex", "^(data|stringData)$", join(work, "plain.yaml"),
  ])
  check(`sops encrypts the ${secretsShape} secrets file`, encrypted.exitCode === 0, encrypted.stderr.trim().slice(0, 160))
  if (encrypted.exitCode !== 0) throw new Error("cannot continue without an encrypted secrets file")
  await writeFile(join(root, "infra/civo/envs/staging/secrets.enc.yaml"), encrypted.stdout)

  const logs: string[] = []
  const deps: Deps = {
    run: systemRunner,
    log: (text) => logs.push(text),
    env: { KUBE_SERVER: server, KUBE_CA: authority, KUBE_TOKEN: token },
    root,
  }
  const log = () => logs.join("")
  const jsonpath = async (resource: string, name: string, path: string) =>
    (await kubectl("get", resource, name, "-n", "answerable", "-o", `jsonpath=${path}`)).stdout
  const pinned = (deployment: string) => jsonpath("deployment", deployment, "{.spec.template.metadata.annotations.image-digest}")
  const releaseRunsTheDigests = async () => {
    const actual = await releaseDigests()
    return Object.entries(DIGESTS).every(([name, digest]) => actual[name] === digest) && Object.keys(actual).length === 4
  }
  const releaseValues = async () =>
    JSON.parse((await run(["helm", "--kubeconfig", kubeconfig, "get", "values", "answerable", "-n", "answerable", "-o", "json"])).stdout)
  const releaseDigests = async () => {
    const values = await releaseValues()
    return Object.fromEntries(Object.entries(values.images ?? {}).map(([name, value]) => [name, (value as { digest: string }).digest]))
  }

  // The first deploy, with the bootstrap Job. No client Secret exists yet, so it registers by itself.
  try {
    await deploy({ environment: "staging", imageTag: TAG, digests: DIGESTS, bootstrap: true }, deps)
    check("deploy succeeds", true)
  } catch (error) {
    check("deploy succeeds", false, (error as Error).message)
    console.log(log())
  }
  check("the log shows no secret value and no token", !log().includes("rehearsal-secret-value") && !log().includes(token))
  const applied = await jsonpath("secret", "id-env", "{.data.BETTER_AUTH_SECRET}")
  check("the decrypted Secrets were applied", Buffer.from(applied, "base64").toString() === "rehearsal-secret-value-one")
  check("the release runs the tag", (await jsonpath("deployment", "answerable-toolbox", "{.spec.template.metadata.annotations.image-tag}")) === TAG)
  check("all four images are pinned by digest, admin-mcp's hyphenated key included", await releaseRunsTheDigests())
  check("the Deployments run the digests", (await pinned("answerable-id")) === DIGESTS.id && (await pinned("answerable-admin-mcp")) === DIGESTS["admin-mcp"])
  check("--bootstrap ran the bootstrap Job", (await kubectl("get", "job", "answerable-ops-bootstrap", "-n", "answerable", "-o", "name")).exitCode === 0)
  check("current-tag reads the tag back", (await currentTag(deps)) === TAG)
  check("the first deploy registered by itself, and said why", log().includes("toolbox-id-client and admin-id-client do not exist in answerable yet, so this upgrade also runs register"))
  check("the register Job ran in that upgrade", (await jsonpath("job", "answerable-ops-register", "{.status.succeeded}")) === "1")
  check("the database's CA file reached the chart through --set-file", (await jsonpath("configmap", "postgres-ca", "{.data.ca\\.pem}")) === DATABASE_CA)

  // What the real register Job writes. With both Secrets there, the next deploy must not register again: once a person
  // holds platform:write, ID refuses the root secret register would use.
  for (const [name, key] of [["toolbox-id-client", "TOOLBOX_ID_CLIENT_SECRET"], ["admin-id-client", "ADMIN_ID_CLIENT_SECRET"]] as const)
    await kubectl("create", "secret", "generic", name, "-n", "answerable", `--from-literal=${key}=rehearsal`)
  logs.length = 0
  try {
    await deploy({ environment: "staging", imageTag: SECOND_TAG, digests: DIGESTS }, deps)
    check("the second deploy succeeds", true)
  } catch (error) {
    check("the second deploy succeeds", false, (error as Error).message)
    console.log(log())
  }
  check("the second deploy did not register again", !log().includes("also runs register") && (await releaseValues()).ops?.register === undefined)
  check("the second deploy moved the release to its tag", (await currentTag(deps)) === SECOND_TAG)

  // run-job register: the Job completes, then the Toolbox and the admin MCP restart, and ID does not.
  try {
    await runJob({ environment: "staging", job: "register" }, deps)
    check("run-job register succeeds", true)
  } catch (error) {
    check("run-job register succeeds", false, (error as Error).message)
  }
  check("the register Job completed", (await jsonpath("job", "answerable-ops-register", "{.status.succeeded}")) === "1")
  const restartedAt = "{.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}"
  check("the Toolbox restarted", (await jsonpath("deployment", "answerable-toolbox", restartedAt)) !== "")
  check("the admin MCP restarted", (await jsonpath("deployment", "answerable-admin-mcp", restartedAt)) !== "")
  check("ID did not restart", (await jsonpath("deployment", "answerable-id", restartedAt)) === "")
  check("run-job kept the image tag", (await currentTag(deps)) === SECOND_TAG)
  check("run-job kept the digests the release runs", await releaseRunsTheDigests())

  // A migration that fails: the deploy fails, the Job's logs are printed, the release stays where it was.
  logs.length = 0
  let failure: unknown
  try {
    await deploy({ environment: "staging", imageTag: NEXT_TAG, digests: DIGESTS, valuesFile: "charts/answerable/values-fail.yaml", timeout: "2m" }, deps)
  } catch (error) {
    failure = error
  }
  check("a failing migration fails the deploy", failure instanceof PipelineError, (failure as Error | undefined)?.message)
  check("the migration's own logs are printed", log().includes("migration exploded: relation users does not exist"))
  check("the release stays on the earlier tag", (await currentTag(deps)) === SECOND_TAG)

  // The token reaches its namespace and nothing else, and the scripts use it rather than the admin kubeconfig.
  await writeFile(join(work, "ca.pem"), Buffer.from(authority, "base64").toString())
  await writeFile(join(work, "empty-kubeconfig"), "")
  const as = (bearer: string, ...args: string[]) =>
    run(["kubectl", "--kubeconfig", join(work, "empty-kubeconfig"), "--server", server, "--token", bearer, "--certificate-authority", join(work, "ca.pem"), ...args])
  const forbidden = (stderr: string) => /forbidden/i.test(stderr)
  const nodes = await as(token, "get", "nodes")
  check("the token cannot read cluster-wide resources", nodes.exitCode !== 0 && forbidden(nodes.stderr))
  const system = await as(token, "get", "secrets", "-n", "kube-system")
  check("the token cannot read another namespace", system.exitCode !== 0 && forbidden(system.stderr))
  check("the token can read its own namespace", (await as(token, "get", "secrets", "-n", "answerable")).exitCode === 0)
  let refused: unknown
  try {
    await currentTag({ ...deps, env: { ...deps.env, KUBE_TOKEN: "invalid-token" } })
  } catch (error) {
    refused = error
  }
  check("the cluster refuses a wrong token", refused instanceof PipelineError)
} finally {
  console.log(`Deleting the kind cluster ${CLUSTER} ...`)
  await run(["kind", "delete", "cluster", "--name", CLUSTER, "--kubeconfig", kubeconfig])
  await rm(work, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(failed.length ? `\n${failed.length} of ${results.length} checks FAILED` : `\nAll ${results.length} checks passed`)
process.exitCode = failed.length ? 1 : 0
