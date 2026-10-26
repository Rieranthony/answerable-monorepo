import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeclaredMcp } from "@answerable/mcp-postgres"
import { databasesFor } from "../ops/src/bootstrap"
import images from "../pipeline/images.json"
import { buildDependencies, charts, check, crdSchemas, kubernetesVersion, type Manifest, overlays, render, run, templateArguments } from "./helm"

// The charts' invariants, read from what `helm template` renders for the defaults and for every overlay. Needs `helm` and
// `kubeconform` on the path and the network for the dependency chart and the schemas; no cluster and no Docker. What the
// answerable chart renders per MCP is read from its mcps.json, as the chart reads it, never from fixed names.

const tag = "sha-0123456789abcdef0123456789abcdef01234567"
const environments = {
  "values-civo-staging.yaml": { id: "id.answerable-staging.uk", toolbox: "toolbox.answerable-staging.uk", adminMcp: "admin-mcp.answerable-staging.uk", mcp: "mcp.answerable-staging.uk", network: "10.10.0.0/24" },
  "values-civo-production.yaml": { id: "id.answerable.org", toolbox: "toolbox.answerable.org", adminMcp: "admin-mcp.answerable.org", mcp: "mcp.answerable.org", network: "10.20.0.0/24" },
} as const

const declared = (JSON.parse(readFileSync(join(charts, "answerable/mcps.json"), "utf8")) as { mcps: DeclaredMcp[] }).mcps
const listed = (mcps: DeclaredMcp[]) => mcps.map(({ name, serve, database, scopes }) => ({ name, serve, database, scopes }))
/** The MCPs the Toolbox serves alone, standalone or both: the mcp host's Ingress renders only while there is one. */
const alone = (mcps: DeclaredMcp[]) => mcps.filter(mcp => mcp.serve !== "toolbox")
const mcpIngress = alone(declared).length > 0
/** The Deployments the register Job starts, as the chart names them. */
const registered = ["toolbox", "admin-mcp"]
/** The Secrets the bootstrap writes for a list, as infra/ops names them: the ops Role must name exactly these. */
const bootstrapSecrets = (mcps: DeclaredMcp[]) => databasesFor(mcps).flatMap(database => [database.owner, ...database.runtime]).map(login => login.ref.secret)

// The origin-pull CA Terraform passes to charts/platform with --set-file, which its Civo overlays refuse to render
// without: a stand-in PEM here (the chart checks only that it is PEM), and one that is not PEM.
const certificates = mkdtempSync(join(tmpdir(), "answerable-charts-ca-"))
afterAll(() => rmSync(certificates, { recursive: true, force: true }))
const caPem = "-----BEGIN CERTIFICATE-----\nY2hhcnQgdGVzdCBDQQ==\n-----END CERTIFICATE-----\n"
const caFile = join(certificates, "ca.pem")
writeFileSync(caFile, caPem)
const notPem = join(certificates, "not.pem")
writeFileSync(notPem, "ca.crt\n")
const supplied: Record<string, Record<string, string>> = { answerable: {}, platform: { "originPull.caPem": caFile } }
/** Render a chart with the files Terraform supplies. */
const renderSupplied = (chart: string, values: string[] = [], set: Record<string, string> = {}) => render(chart, values, set, supplied[chart])
/** Every ops Job switched on, as the pipeline switches them one at a time. */
const allJobs = { "ops.bootstrap": "true", "ops.register": "true", "ops.makeAdmin": "true", "ops.adminEmail": "you@answerable.org" }

const podSpec = (manifest: Manifest) => manifest.spec?.template?.spec ?? manifest.spec?.jobTemplate?.spec?.template?.spec
const workloads = (manifests: Manifest[]) => manifests.filter(manifest => podSpec(manifest) !== undefined)
const named = (manifests: Manifest[], kind: string, name: string) => manifests.find(manifest => manifest.kind === kind && manifest.metadata.name === name)
const containersOf = (manifest: Manifest) => [...(podSpec(manifest).initContainers ?? []), ...podSpec(manifest).containers]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (manifest: Manifest, name: string) => containersOf(manifest).flatMap((container: any) => container.env ?? []).find((variable: { name: string }) => variable.name === name)
const secretReferences = (manifest: Manifest) => [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...containersOf(manifest).flatMap((container: any) => (container.env ?? []).flatMap((variable: any) => variable.valueFrom?.secretKeyRef ? [variable.valueFrom.secretKeyRef.name] : [])),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...containersOf(manifest).flatMap((container: any) => (container.envFrom ?? []).flatMap((source: any) => source.secretRef ? [source.secretRef.name] : [])),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...(podSpec(manifest).volumes ?? []).flatMap((volume: any) => volume.secret ? [volume.secret.secretName] : []),
]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountsDatabaseCa = (manifest: Manifest) => (podSpec(manifest).volumes ?? []).some((volume: any) => volume.configMap?.name === "postgres-ca")
const weight = (manifest: Manifest) => Number(manifest.metadata.annotations?.["helm.sh/hook-weight"] ?? 0)

beforeAll(() => {
  buildDependencies("platform")
})

describe("charts/answerable", () => {
  const cases = [["the defaults", []], ...overlays("answerable").map(file => [file, [file]])] as [string, string[]][]

  test("has the overlays the pipeline and the kind stack read", () => {
    expect(overlays("answerable")).toEqual(["values-civo-production.yaml", "values-civo-staging.yaml", "values-local.yaml"])
  })

  for (const [name, values] of cases) {
    describe(name, () => {
      const manifests = renderSupplied("answerable", values, { "image.tag": tag, ...allJobs })

      test("renders no namespace, Secret or ConfigMap: Terraform, the deploy and the Jobs own those", () => {
        expect(manifests.filter(manifest => ["Namespace", "Secret", "ConfigMap"].includes(manifest.kind))).toEqual([])
      })

      test("every pod meets the restricted Pod Security Standard and runs read-only, with requests and a memory limit", () => {
        expect(workloads(manifests).length).toBeGreaterThan(0)
        for (const workload of workloads(manifests)) {
          const spec = podSpec(workload)
          expect(spec.securityContext, workload.metadata.name).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } })
          // A Service named toolbox would otherwise set TOOLBOX_PORT=tcp://… in every pod, over the image's TOOLBOX_PORT.
          expect(spec.enableServiceLinks, workload.metadata.name).toBe(false)
          expect(spec.hostNetwork ?? false).toBe(false)
          expect(spec.hostPID ?? false).toBe(false)
          expect(spec.hostIPC ?? false).toBe(false)
          for (const container of containersOf(workload)) {
            const where = `${workload.metadata.name}/${container.name}`
            expect(container.securityContext, where).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } })
            expect(container.securityContext.privileged ?? false, where).toBe(false)
            expect(container.securityContext.capabilities.add, where).toBeUndefined()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((container.ports ?? []).filter((port: any) => port.hostPort), where).toEqual([])
            expect(container.resources?.requests, where).toMatchObject({ cpu: expect.any(String), memory: expect.any(String) })
            expect(container.resources?.limits?.memory, where).toEqual(expect.any(String))
          }
        }
      })

      test("every image is one of infra/pipeline/images.json at the given tag, never latest", () => {
        for (const workload of workloads(manifests)) {
          for (const container of containersOf(workload)) {
            expect(container.image).toMatch(new RegExp(`^ghcr\\.io/rieranthony/answerable/(${images.map(image => image.name).join("|")}):${tag}$`))
          }
        }
      })

      test("the servers of the mcps image each run their own entry point", () => {
        const commands = Object.fromEntries(manifests.filter(manifest => manifest.kind === "Deployment").map(deployment => [deployment.metadata.name, containersOf(deployment)[0].command]))
        expect(commands).toEqual({
          id: undefined,
          toolbox: ["bun", "mcps/toolbox/src/server.ts"],
          "admin-mcp": ["bun", "mcps/admin/src/server.ts"],
        })
      })

      test("no secret value is written in the manifests: every secret-looking variable comes from a Secret", () => {
        for (const workload of workloads(manifests)) {
          for (const container of containersOf(workload)) {
            for (const variable of container.env ?? []) {
              if (/SECRET|PASSWORD|TOKEN|DATABASE(_MIGRATION|_ADMIN)?_URL$/.test(variable.name)) expect(variable.valueFrom?.secretKeyRef, `${workload.metadata.name} ${variable.name}`).toBeDefined()
              expect(String(variable.value ?? "")).not.toMatch(/^postgres(ql)?:\/\//)
            }
          }
        }
      })

      test("the migrations are pre-install and pre-upgrade hooks after the bootstrap, in their order, each with only its own owner logins", () => {
        const owners = {
          "id-migrate": ["id-database-owner"],
          "toolbox-migrate": ["toolbox-database-owner", "mcps-database-owner", ...declared.filter(mcp => mcp.database === "own").map(mcp => `mcp-${mcp.name}-database-owner`)],
          "admin-migrate": ["admin-database-owner"],
        }
        const migrations = Object.keys(owners).map(job => named(manifests, "Job", job)!)
        expect(migrations.map(weight)).toEqual([-10, -9, -8])
        for (const job of migrations) {
          expect(job.metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade")
          expect(new Set(secretReferences(job)), job.metadata.name).toEqual(new Set(owners[job.metadata.name as keyof typeof owners]))
          expect(podSpec(job).restartPolicy).toBe("Never")
          expect(podSpec(job).automountServiceAccountToken).toBe(false)
        }
        // toolbox-migrate migrates the list the bootstrap provisions: one rendered value.
        expect(JSON.parse(env(named(manifests, "Job", "toolbox-migrate")!, "MCPS_DECLARED").value)).toEqual(listed(declared))
        const bootstrap = named(manifests, "Job", "ops-bootstrap")!
        expect(bootstrap.metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade")
        for (const job of migrations) expect(weight(job)).toBeGreaterThan(weight(bootstrap))
        const register = named(manifests, "Job", "ops-register")!
        const makeAdmin = named(manifests, "Job", "ops-make-admin")!
        for (const job of [register, makeAdmin]) expect(job.metadata.annotations?.["helm.sh/hook"]).toBe("post-install,post-upgrade")
        expect(weight(makeAdmin)).toBeGreaterThan(weight(register))
      })

      test("the services and the migrations mount the database's certificate authority, which the bootstrap writes; the ops Jobs do not", () => {
        for (const workload of workloads(manifests)) {
          const isOps = workload.metadata.name.startsWith("ops-")
          expect(mountsDatabaseCa(workload), workload.metadata.name).toBe(!isOps)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mount = containersOf(workload)[0].volumeMounts.find((mount: any) => mount.mountPath === "/etc/ssl/db")
          if (isOps) expect(mount, workload.metadata.name).toBeUndefined()
          else expect(mount, workload.metadata.name).toMatchObject({ name: "postgres-ca", readOnly: true })
        }
        for (const deployment of manifests.filter(manifest => manifest.kind === "Deployment")) {
          expect(secretReferences(deployment).filter(secret => secret.endsWith("-owner")), deployment.metadata.name).toEqual([])
          expect(podSpec(deployment).automountServiceAccountToken).toBe(false)
        }
      })

      test("each Deployment rolls with no unavailable pod, waits for Traefik before it stops, probes readiness, spreads over nodes and has a disruption budget", () => {
        const deployments = manifests.filter(manifest => manifest.kind === "Deployment")
        expect(deployments.map(deployment => deployment.metadata.name).sort()).toEqual(["admin-mcp", "id", "toolbox"])
        for (const deployment of deployments) {
          expect(deployment.spec.strategy).toMatchObject({ type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0 } })
          // Traefik keeps routing to a terminating pod for a few seconds; the pod waits longer than that before it stops.
          expect(containersOf(deployment)[0].lifecycle?.preStop?.exec?.command).toEqual(["sleep", "5"])
          expect(podSpec(deployment).terminationGracePeriodSeconds).toBeGreaterThanOrEqual(30)
          expect(containersOf(deployment)[0].readinessProbe?.httpGet?.path).toBe(deployment.metadata.name === "id" ? "/readyz" : "/health")
          expect(containersOf(deployment)[0].livenessProbe).toBeDefined()
          expect(podSpec(deployment).topologySpreadConstraints?.[0]).toMatchObject({ topologyKey: "kubernetes.io/hostname", maxSkew: 1 })
          expect(manifests.find(manifest => manifest.kind === "PodDisruptionBudget" && manifest.spec.selector.matchLabels["app.kubernetes.io/component"] === deployment.spec.selector.matchLabels["app.kubernetes.io/component"])).toBeDefined()
        }
      })

      test("one Ingress per hostname, serving the shared Secret origin-tls, with no issuer and no TLS option: Traefik's default one applies", () => {
        const ingresses = manifests.filter(manifest => manifest.kind === "Ingress")
        expect(ingresses.length).toBe(mcpIngress ? 4 : 3)
        for (const ingress of ingresses) {
          expect(ingress.spec.ingressClassName).toBe("traefik")
          expect(ingress.metadata.annotations).toEqual({
            "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
            "traefik.ingress.kubernetes.io/router.tls": "true",
          })
          expect(ingress.spec.rules.length).toBe(1)
          expect(ingress.spec.tls).toEqual([{ hosts: [ingress.spec.rules[0].host], secretName: "origin-tls" }])
        }
      })

      test("ID takes TRUSTED_PROXY_CIDRS from the ConfigMap trusted-proxies, and its pods carry the checksum of id-env", () => {
        const id = named(manifests, "Deployment", "id")!
        expect(env(id, "TRUSTED_PROXY_CIDRS")).toEqual({ name: "TRUSTED_PROXY_CIDRS", valueFrom: { configMapKeyRef: { name: "trusted-proxies", key: "cidrs" } } })
        expect(id.spec.template.metadata.annotations).toEqual({ "checksum/id-env": "" })
        expect(containersOf(id)[0].envFrom).toEqual([{ secretRef: { name: "id-env" } }])
        for (const server of registered) expect(named(manifests, "Deployment", server)!.spec.template.metadata.annotations, server).toBeUndefined()
      })

      test("the ops Jobs: one attempt, the token of their own ServiceAccount where they call Kubernetes, the administrative login or ID's root secret from Secrets", () => {
        const bootstrap = named(manifests, "Job", "ops-bootstrap")!
        const register = named(manifests, "Job", "ops-register")!
        const makeAdmin = named(manifests, "Job", "ops-make-admin")!
        for (const [job, command] of [[bootstrap, "bootstrap"], [register, "register"], [makeAdmin, "make-admin"]] as const) {
          expect(job.spec).toMatchObject({ backoffLimit: 0, ttlSecondsAfterFinished: expect.any(Number), activeDeadlineSeconds: expect.any(Number) })
          expect(podSpec(job).restartPolicy).toBe("Never")
          expect(containersOf(job)[0].command).toEqual(["bun", "infra/ops/src/cli.ts", command])
        }
        for (const job of [bootstrap, register]) {
          expect(podSpec(job)).toMatchObject({ serviceAccountName: "ops", automountServiceAccountToken: true })
        }
        expect(new Set(secretReferences(bootstrap))).toEqual(new Set(["postgres-admin"]))
        expect(env(bootstrap, "OPS_DATABASE_ADMIN_URL").valueFrom.secretKeyRef).toEqual({ name: "postgres-admin", key: "OPS_DATABASE_ADMIN_URL" })
        expect(containersOf(bootstrap)[0].env.map((variable: { name: string }) => variable.name).filter((variable: string) => variable.startsWith("OPS_"))).toEqual(["OPS_DATABASE_ADMIN_URL", "OPS_MCPS"])
        expect(JSON.parse(env(bootstrap, "OPS_MCPS").value)).toEqual(listed(declared))
        // The root secret mints register's own client on its first run; it may be absent, and the command says when it needs it.
        expect(env(register, "OPS_ID_TOKEN")).toBeUndefined()
        expect(env(register, "OPS_ID_ROOT_SECRET").valueFrom.secretKeyRef).toEqual({ name: "id-env", key: "ROOT_ADMIN_SECRET", optional: true })
        expect(env(register, "OPS_ID_URL").value).toBe(env(named(manifests, "Deployment", "toolbox")!, "TOOLBOX_ID_ISSUER").value)
        expect(env(register, "OPS_TOOLBOX_URL").value).toBe(env(named(manifests, "Deployment", "toolbox")!, "TOOLBOX_RESOURCE_URL").value.replace(/\/mcp$/, ""))
        expect(env(register, "OPS_ADMIN_MCP_URL").value).toBe(env(named(manifests, "Deployment", "admin-mcp")!, "ADMIN_RESOURCE_URL").value.replace(/\/mcp$/, ""))
        // Each standalone MCP's resource is <OPS_MCP_URL>/<name>/mcp, the origin the Toolbox serves it at; the list is the bootstrap's, scopes included.
        expect(env(register, "OPS_MCP_URL").value).toBe(env(named(manifests, "Deployment", "toolbox")!, "TOOLBOX_STANDALONE_ORIGIN").value)
        expect(env(register, "OPS_MCPS").value).toBe(env(bootstrap, "OPS_MCPS").value)
        const replicas = name === "values-local.yaml" ? 1 : 2
        expect(env(register, "OPS_START_DEPLOYMENTS").value).toBe(registered.map(server => `${server}=${replicas}`).join(","))
        // A staff directory only where the overlay names one: staging names the local ID setup's.
        if (name === "values-civo-staging.yaml") {
          expect(env(register, "OPS_STAFF_DOMAIN").value).toBe("omniaccelerator.ai")
          expect(env(register, "OPS_ENTRA_TENANT").value).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
        } else {
          expect(env(register, "OPS_STAFF_DOMAIN")).toBeUndefined()
          expect(env(register, "OPS_ENTRA_TENANT")).toBeUndefined()
        }
        // make-admin calls only ID, with the root secret: no Kubernetes token, no Secret but id-env's.
        expect(podSpec(makeAdmin).serviceAccountName).toBeUndefined()
        expect(podSpec(makeAdmin).automountServiceAccountToken).toBe(false)
        expect(new Set(secretReferences(makeAdmin))).toEqual(new Set(["id-env"]))
        expect(env(makeAdmin, "OPS_ID_ROOT_SECRET").valueFrom.secretKeyRef).toEqual({ name: "id-env", key: "ROOT_ADMIN_SECRET", optional: true })
        expect(env(makeAdmin, "OPS_ADMIN_EMAIL").value).toBe("you@answerable.org")
        expect(env(makeAdmin, "OPS_ID_URL").value).toBe(env(register, "OPS_ID_URL").value)
      })

      test("the ops ServiceAccount reads and patches exactly the Secrets and the ConfigMap its Jobs own, the bootstrap's derived from the list, and only register touches the Deployments it starts", () => {
        const databaseCa = [
          { apiGroups: [""], resources: ["configmaps"], resourceNames: ["postgres-ca"], verbs: ["get", "patch"] },
          { apiGroups: [""], resources: ["configmaps"], verbs: ["create"] },
        ]
        const clients = ["ops-id-client", "toolbox-id-client", "admin-id-client"]
        const role = named(manifests, "Role", "ops")!
        expect(role.rules).toEqual([
          { apiGroups: [""], resources: ["secrets"], resourceNames: [...bootstrapSecrets(declared), ...clients], verbs: ["get", "patch"] },
          { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
          ...databaseCa,
          { apiGroups: ["apps"], resources: ["deployments"], resourceNames: registered, verbs: ["get", "patch"] },
        ])
        expect(named(manifests, "ServiceAccount", "ops")!.automountServiceAccountToken).toBe(false)
        expect(named(manifests, "RoleBinding", "ops")).toMatchObject({ roleRef: { kind: "Role", name: "ops" }, subjects: [{ kind: "ServiceAccount", name: "ops" }] })
        const bootstrapOnly = renderSupplied("answerable", values, { "image.tag": tag, "ops.bootstrap": "true" })
        expect(named(bootstrapOnly, "Role", "ops")!.rules).toEqual([
          { apiGroups: [""], resources: ["secrets"], resourceNames: bootstrapSecrets(declared), verbs: ["get", "patch"] },
          { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
          ...databaseCa,
        ])
        expect(named(bootstrapOnly, "Role", "ops")!.metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade")
        const registerOnly = renderSupplied("answerable", values, { "image.tag": tag, "ops.register": "true" })
        expect(named(registerOnly, "Role", "ops")!.rules[0].resourceNames).toEqual(clients)
        expect(named(registerOnly, "Role", "ops")!.rules.some((rule: { resources: string[] }) => rule.resources.includes("configmaps"))).toBe(false)
        expect(named(registerOnly, "Role", "ops")!.metadata.annotations?.["helm.sh/hook"]).toBe("post-install,post-upgrade")
      })

      test("the Toolbox and the admin MCP wait at zero replicas while their client Secret is missing, which helm template, with no cluster, always finds", () => {
        for (const server of registered) expect(named(manifests, "Deployment", server)!.spec.replicas, server).toBe(0)
        const id = named(manifests, "Deployment", "id")!
        if (name === "values-local.yaml") expect(id.spec.replicas).toBe(1)
        else expect(id.spec.replicas).toBeUndefined()
      })

      test("NetworkPolicies deny by default, admit only Traefik to the services and let every pod resolve names", () => {
        const policies = manifests.filter(manifest => manifest.kind === "NetworkPolicy")
        const deny = policies.find(policy => Object.keys(policy.spec.podSelector).length === 0)
        expect(deny?.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] })
        for (const workload of workloads(manifests)) {
          const labels = podSpec(workload) && workload.spec.template?.metadata?.labels
          const selecting = policies.filter(policy => policy !== deny && Object.entries(policy.spec.podSelector.matchLabels ?? {}).every(([key, value]) => labels?.[key] === value))
          expect(selecting.length, workload.metadata.name).toBeGreaterThan(0)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expect(selecting.some(policy => (policy.spec.egress ?? []).some((rule: any) => rule.ports?.some((port: any) => port.port === 53))), workload.metadata.name).toBe(true)
          if (workload.kind === "Deployment") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sources = selecting.flatMap(policy => (policy.spec.ingress ?? []).flatMap((rule: any) => rule.from ?? []))
            expect(sources.length, workload.metadata.name).toBeGreaterThan(0)
            for (const source of sources) expect(source).toEqual({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "platform" } }, podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } } })
          }
        }
      })
    })
  }

  for (const [file, expected] of Object.entries(environments)) {
    test(`${file} names the environment's hostnames, issuer and resources, and the private network for the database`, () => {
      const manifests = renderSupplied("answerable", [file], { "image.tag": tag })
      const id = named(manifests, "Deployment", "id")!
      const toolbox = named(manifests, "Deployment", "toolbox")!
      const admin = named(manifests, "Deployment", "admin-mcp")!
      const issuer = `https://${expected.id}`
      expect(env(id, "BETTER_AUTH_URL").value).toBe(issuer)
      expect(env(toolbox, "TOOLBOX_ID_ISSUER").value).toBe(issuer)
      expect(env(toolbox, "TOOLBOX_RESOURCE_URL").value).toBe(`https://${expected.toolbox}/mcp`)
      expect(env(toolbox, "TOOLBOX_ID_ADMIN_RESOURCE").value).toBe(`${issuer}/api/admin`)
      expect(env(admin, "ADMIN_ID_ISSUER").value).toBe(issuer)
      expect(env(admin, "ADMIN_RESOURCE_URL").value).toBe(`https://${expected.adminMcp}/mcp`)
      expect(env(admin, "ADMIN_TOOLBOX_ADMIN_RESOURCE").value).toBe(`https://${expected.toolbox}/admin`)
      // The MCPs served alone are <origin>/<name>/mcp, which the Toolbox serves, register registers and standalone_enable names.
      expect(env(toolbox, "TOOLBOX_STANDALONE_ORIGIN").value).toBe(`https://${expected.mcp}`)
      expect(env(admin, "ADMIN_STANDALONE_ORIGIN").value).toBe(`https://${expected.mcp}`)
      const servers = ["admin-mcp", "id", "toolbox"]
      const hosts = [expected.adminMcp, expected.id, expected.toolbox, ...(mcpIngress ? [expected.mcp] : [])]
      expect(manifests.filter(manifest => manifest.kind === "Ingress").map(ingress => ingress.spec.rules[0].host).sort()).toEqual(hosts.sort())
      const autoscalers = manifests.filter(manifest => manifest.kind === "HorizontalPodAutoscaler")
      expect(autoscalers.map(autoscaler => autoscaler.spec.scaleTargetRef.name).sort()).toEqual(servers)
      for (const autoscaler of autoscalers) {
        expect(autoscaler.spec.metrics).toEqual([{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 60 } } }])
        if (file === "values-civo-production.yaml") expect(autoscaler.spec.minReplicas).toBeGreaterThanOrEqual(2)
      }
      // The database sits in the private network, and nothing else is reachable on its port.
      for (const policy of manifests.filter(manifest => manifest.kind === "NetworkPolicy")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const rule of (policy.spec.egress ?? []).filter((rule: any) => rule.ports?.some((port: any) => port.port === 5432))) expect(rule.to).toEqual([{ ipBlock: { cidr: expected.network } }])
      }
    })
  }

  test("the ops Jobs and their account render only when switched on and an ops image is named; their NetworkPolicy whenever the image is named", () => {
    const ops = (manifests: Manifest[]) => manifests.filter(manifest => manifest.metadata.name === "ops" || manifest.metadata.name.startsWith("ops-")).map(manifest => `${manifest.kind}/${manifest.metadata.name}`).sort()
    // The Jobs are hooks, which run before the release's own resources: the policy must already be there from the release before.
    expect(ops(renderSupplied("answerable", [], { "image.tag": tag }))).toEqual(["NetworkPolicy/ops"])
    expect(ops(renderSupplied("answerable", [], { "image.tag": tag, ...allJobs, "images.ops.repository": "" }))).toEqual([])
    expect(ops(renderSupplied("answerable", [], { "image.tag": tag, "ops.register": "true" }))).toEqual(["Job/ops-register", "NetworkPolicy/ops", "Role/ops", "RoleBinding/ops", "ServiceAccount/ops"])
    // make-admin alone needs no account: it calls only ID.
    expect(ops(renderSupplied("answerable", [], { "image.tag": tag, "ops.makeAdmin": "true", "ops.adminEmail": "you@answerable.org" }))).toEqual(["Job/ops-make-admin", "NetworkPolicy/ops"])
  })

  test("ops.makeAdmin without ops.adminEmail refuses to render, naming the value", () => {
    const missing = run(templateArguments("answerable", [], { "image.tag": tag, "ops.makeAdmin": "true" }))
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toContain("ops.makeAdmin needs ops.adminEmail")
  })

  test("id.staffDomain and id.entraTenant reach the register Job, and only it", () => {
    const manifests = renderSupplied("answerable", ["values-civo-staging.yaml"], { "image.tag": tag, ...allJobs, "id.staffDomain": "answerable.org", "id.entraTenant": "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0" })
    const register = named(manifests, "Job", "ops-register")!
    expect(env(register, "OPS_STAFF_DOMAIN").value).toBe("answerable.org")
    expect(env(register, "OPS_ENTRA_TENANT").value).toBe("0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0")
    for (const workload of workloads(manifests).filter(workload => workload !== register)) expect(env(workload, "OPS_STAFF_DOMAIN"), workload.metadata.name).toBeUndefined()
  })

  test("idEnvChecksum becomes the annotation of ID's pods, so a changed secret rolls them", () => {
    const sum = "f".repeat(64)
    const id = named(renderSupplied("answerable", ["values-civo-production.yaml"], { "image.tag": tag, idEnvChecksum: sum }), "Deployment", "id")!
    expect(id.spec.template.metadata.annotations).toEqual({ "checksum/id-env": sum })
  })

  for (const file of overlays("answerable")) {
    test(`${file}: the ops Jobs reach the Kubernetes API, the database and HTTPS, and nothing else`, () => {
      const policy = named(renderSupplied("answerable", [file], { "image.tag": tag }), "NetworkPolicy", "ops")!
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ports = policy.spec.egress.map((rule: any) => rule.ports.map((port: any) => port.port).sort((a: number, b: number) => a - b))
      expect(ports).toContainEqual([53, 53])
      expect(ports).toContainEqual([5432])
      expect(ports).toContainEqual(file === "values-local.yaml" ? [443, 6443] : [6443])
      expect(policy.spec.ingress).toBeUndefined()
    })
  }

  test("id.extraEgress adds to ID's policy alone", () => {
    const extra = { to: [{ ipBlock: { cidr: "192.0.2.10/32" } }], ports: [{ port: 47710, protocol: "TCP" }] }
    const manifests = renderSupplied("answerable", ["values-local.yaml"], { "image.tag": tag, "id.extraEgress[0].to[0].ipBlock.cidr": "192.0.2.10/32", "id.extraEgress[0].ports[0].port": "47710", "id.extraEgress[0].ports[0].protocol": "TCP" })
    for (const policy of manifests.filter(manifest => manifest.kind === "NetworkPolicy")) {
      expect(policy.spec.egress?.some((rule: unknown) => Bun.deepEquals(rule, extra)) ?? false, policy.metadata.name).toBe(policy.metadata.name === "id")
    }
  })

  test("an image with a digest runs by digest, the exact bytes verified; one without runs by the shared tag", () => {
    const digests = { id: "a".repeat(64), mcps: "b".repeat(64), ops: "d".repeat(64) }
    const set = Object.fromEntries([["image.tag", tag], ...Object.entries(allJobs), ...Object.entries(digests).map(([image, hex]) => [`images.${image}.digest`, `sha256:${hex}`])])
    const pinned = renderSupplied("answerable", ["values-civo-production.yaml"], set)
    const images = new Set(workloads(pinned).flatMap(workload => containersOf(workload).map((container: { image: string }) => container.image)))
    expect(images).toEqual(new Set(Object.entries(digests).map(([image, hex]) => `ghcr.io/rieranthony/answerable/${image}@sha256:${hex}`)))
    // Only the mcps image pinned: the others keep the tag.
    const mixed = renderSupplied("answerable", ["values-civo-production.yaml"], { "image.tag": tag, "images.mcps.digest": `sha256:${digests.mcps}` })
    for (const [kind, name] of [...registered.map(server => ["Deployment", server] as const), ["Job", "toolbox-migrate"], ["Job", "admin-migrate"]] as const)
      expect(containersOf(named(mixed, kind, name)!)[0].image, name).toBe(`ghcr.io/rieranthony/answerable/mcps@sha256:${digests.mcps}`)
    expect(containersOf(named(mixed, "Deployment", "id")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/id:${tag}`)
    // A digest that is not sha256 and 64 hex digits is refused, rather than deployed as something else.
    const bad = run(templateArguments("answerable", [], { "image.tag": tag, "images.id.digest": "sha256:abc" }))
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr).toContain("images.id.digest")
  })

  test("without an image tag the images say so, rather than falling back to a mutable tag", () => {
    for (const workload of workloads(renderSupplied("answerable"))) for (const container of containersOf(workload)) expect(container.image).toEndWith(":unset")
  })

  test("the servers connect as their runtime logins and the migrations as the owners, naming no role: each script provisions its service's", () => {
    const manifests = renderSupplied("answerable", [], { "image.tag": tag })
    for (const [deployment, variable, secret] of [
      ["id", "DATABASE_URL", "id-database"], ["toolbox", "TOOLBOX_DATABASE_URL", "toolbox-database"], ["admin-mcp", "ADMIN_DATABASE_URL", "admin-database"], ["toolbox", "TOOLBOX_MCPS_DATABASE_URL", "toolbox-mcps-database"],
    ]) {
      expect(env(named(manifests, "Deployment", deployment!)!, variable!).valueFrom.secretKeyRef).toEqual({ name: secret, key: variable })
    }
    for (const [job, prefix] of [["id-migrate", ""], ["toolbox-migrate", "TOOLBOX_"], ["admin-migrate", "ADMIN_"]]) {
      const migration = named(manifests, "Job", job!)!
      expect(env(migration, `${prefix}DATABASE_MIGRATION_URL`).valueFrom.secretKeyRef.key).toBe(`${prefix}DATABASE_MIGRATION_URL`)
      expect(env(migration, `${prefix}DATABASE_RUNTIME_ROLE`)).toBeUndefined()
    }
  })
})

describe("charts/answerable at 0, 1, 3 and 200 MCPs", () => {
  /** An MCP as the generator writes it into mcps.json: its declaration and two scopes. */
  const entry = (name: string, serve: DeclaredMcp["serve"], database: DeclaredMcp["database"]) => ({
    name, serve, database, scopes: [`${name}:read`, `${name}:write`],
  })
  const serves = ["toolbox", "standalone", "both"] as const
  const lists: Record<string, DeclaredMcp[]> = {
    0: [],
    1: [entry("acme", "standalone", "own")],
    3: [entry("alpha", "toolbox", "shared"), entry("beta", "standalone", "own"), entry("gamma", "both", "own")],
    // A third in each place, one in ten with a database of its own.
    200: Array.from({ length: 200 }, (_, index) => entry(`m${String(index).padStart(3, "0")}`, serves[index % 3]!, index % 10 === 0 ? "own" : "shared")),
  }
  const copies = mkdtempSync(join(tmpdir(), "answerable-chart-lists-"))
  afterAll(() => rmSync(copies, { recursive: true, force: true }))
  /** A copy of charts/answerable whose mcps.json is `text`: .Files.Get reads only the chart's own files. */
  function chartWith(name: string, text: string) {
    const chart = join(copies, name, "answerable")
    cpSync(join(charts, "answerable"), chart, { recursive: true })
    writeFileSync(join(chart, "mcps.json"), text)
    return chart
  }
  const file = (mcps: DeclaredMcp[]) => `${JSON.stringify({ $comment: "Written by bun mcp", mcps }, null, 2)}\n`
  const set = { "image.tag": tag, ...allJobs }
  const flags = (chart: string) => ["--namespace", "answerable", "--values", join(chart, "values-civo-production.yaml"), ...Object.entries(set).flatMap(([key, value]) => ["--set", `${key}=${value}`])]
  const renderCopy = (chart: string) => {
    const rendered = check(["helm", "template", "answerable", chart, ...flags(chart)])
    return { rendered, manifests: (Bun.YAML.parse(rendered) as (Manifest | null)[]).filter((manifest): manifest is Manifest => manifest !== null) }
  }

  for (const [count, mcps] of Object.entries(lists)) {
    test(`${count} MCPs: the mcp host's Ingress to the Toolbox only while one is standalone or both, its two paths per MCP, each own MCP's databases, the bootstrap's and the migration's list, and the ops Role from it`, () => {
      const chart = chartWith(count, file(mcps))
      const { rendered, manifests } = renderCopy(chart)
      const served = alone(mcps)
      const ingress = named(manifests, "Ingress", "mcp")
      if (!served.length) expect(ingress).toBeUndefined()
      else {
        expect(ingress!.spec.rules.map((rule: { host: string }) => rule.host)).toEqual(["mcp.answerable.org"])
        expect(ingress!.spec.rules[0].http.paths).toEqual(served.flatMap(({ name }) => [`/${name}/`, `/.well-known/oauth-protected-resource/${name}/`]).map(path => (
          { path, pathType: "Prefix", backend: { service: { name: "toolbox", port: { name: "http" } } } })))
      }
      expect(manifests.filter(manifest => manifest.metadata.name === "standalone")).toEqual([])
      // Each own MCP's database: its runtime login for the Toolbox, which serves every MCP, its owner for the migration; a shared MCP needs no variable.
      const ownVariables = (workload: Manifest, pattern: RegExp) => containersOf(workload).flatMap((container: { env: { name: string; valueFrom?: { secretKeyRef?: unknown } }[] }) => container.env)
        .filter(variable => pattern.test(variable.name)).map(variable => [variable.name, variable.valueFrom?.secretKeyRef])
      const own = (list: DeclaredMcp[], prefix: string, secret: string, key: string) => list.filter(mcp => mcp.database === "own").map(({ name }) => [`${prefix}MCP_${name.toUpperCase()}_DATABASE${key === "DATABASE_URL" ? "" : "_MIGRATION"}_URL`, { name: `mcp-${name}-${secret}`, key }])
      expect(ownVariables(named(manifests, "Deployment", "toolbox")!, /^TOOLBOX_MCP_/)).toEqual(own(mcps, "TOOLBOX_", "database", "DATABASE_URL"))
      expect(ownVariables(named(manifests, "Job", "toolbox-migrate")!, /^MCP_/)).toEqual(own(mcps, "", "database-owner", "DATABASE_MIGRATION_URL"))
      for (const [job, variable] of [["ops-bootstrap", "OPS_MCPS"], ["ops-register", "OPS_MCPS"], ["toolbox-migrate", "MCPS_DECLARED"]]) expect(JSON.parse(env(named(manifests, "Job", job!)!, variable!).value), job).toEqual(listed(mcps))
      const role = named(manifests, "Role", "ops")!
      expect(role.rules[0].resourceNames).toEqual([...bootstrapSecrets(mcps), "ops-id-client", "toolbox-id-client", "admin-id-client"])
      expect(role.rules.at(-1).resourceNames).toEqual(registered)
      expect(env(named(manifests, "Job", "ops-register")!, "OPS_START_DEPLOYMENTS").value).toBe(registered.map(server => `${server}=2`).join(","))
      // Hooks in order, whatever the list: RBAC, bootstrap, the three migrations, then register and make-admin.
      const hooks = manifests.filter(manifest => manifest.kind === "Job").map(job => [job.metadata.name, weight(job)])
      expect(hooks).toEqual([["id-migrate", -10], ["toolbox-migrate", -9], ["admin-migrate", -8], ["ops-bootstrap", -20], ["ops-register", 10], ["ops-make-admin", 20]])
      const validated = run(["kubeconform", "-strict", "-summary", "-ignore-missing-schemas", "-kubernetes-version", kubernetesVersion, "-schema-location", "default", "-schema-location", crdSchemas, "-"], { stdin: rendered })
      expect(validated.stdout, validated.stdout + validated.stderr).toContain("Invalid: 0, Errors: 0")
    }, 120_000)
  }

  test("at 200 MCPs, the release Helm stores (its JSON, gzipped, then base64, in one Secret) stays well under Kubernetes' 1 MiB", () => {
    const chart = chartWith("release", file(lists[200]!))
    const record = check(["helm", "install", "answerable", chart, "--dry-run=client", "--output", "json", ...flags(chart)])
    const stored = Buffer.from(Bun.gzipSync(Buffer.from(record), { level: 9 })).toString("base64").length
    const baseline = Buffer.from(Bun.gzipSync(Buffer.from(check(["helm", "install", "answerable", chartWith("baseline", file([])), "--dry-run=client", "--output", "json", ...flags(chart)])), { level: 9 })).toString("base64").length
    console.log(`The release at 200 MCPs: ${record.length} bytes of JSON, ${stored} bytes stored (${(stored / 1024).toFixed(1)} KiB, ${((stored / 1048576) * 100).toFixed(1)}% of 1 MiB); at 0 MCPs ${baseline} bytes stored`)
    expect(stored).toBeLessThan(1048576 / 4)
  }, 120_000)

  test("a list whose root is not an object, as fromJson would misread, fails the render, naming the file", () => {
    for (const text of ["[]", "not json"]) {
      const chart = chartWith(`broken-${text.length}`, text)
      const result = run(["helm", "template", "answerable", chart, ...flags(chart)])
      expect(result.exitCode, text).not.toBe(0)
      expect(result.stderr).toContain('charts/answerable/mcps.json must be { "mcps": [...] }, as bun mcp writes it')
    }
  })
})

describe("charts/platform", () => {
  test("has one dependency, Traefik, named as Terraform's values address it, from OCI", async () => {
    const chart = Bun.YAML.parse(await Bun.file(join(charts, "platform/Chart.yaml")).text()) as { dependencies: { name: string; version: string; repository: string }[] }
    expect(chart.dependencies).toEqual([{ name: "traefik", version: "41.7.1", repository: "oci://ghcr.io/traefik/helm" }])
    const lock = Bun.YAML.parse(await Bun.file(join(charts, "platform/Chart.lock")).text()) as { dependencies: { name: string }[] }
    expect(lock.dependencies.map(dependency => dependency.name)).toEqual(["traefik"])
  })

  for (const [name, values] of [["the defaults", []], ...overlays("platform").map(file => [file, [file]])] as [string, string[]][]) {
    test(`${name}: Traefik keeps forwarded headers only from Terraform's trusted addresses and appends its peer, refuses conflicting TLS options, and listens on 443 only`, () => {
      const manifests = renderSupplied("platform", values, { "traefik.ports.websecure.forwardedHeaders.trustedIPs": "{203.0.113.0/24,10.10.0.0/24}", "traefik.service.annotations.kubernetes\\.civo\\.com/firewall-id": "fw" })
      const deployment = manifests.find(manifest => manifest.kind === "Deployment" && manifest.metadata.name === "platform-traefik")!
      const args: string[] = deployment.spec.template.spec.containers.find((container: { name: string }) => container.name === "platform-traefik").args
      expect(args).toContain("--entryPoints.websecure.forwardedHeaders.trustedIPs=203.0.113.0/24,10.10.0.0/24")
      expect(args.filter(arg => /notAppendXForwardedFor=true|forwardedHeaders\.insecure/.test(arg))).toEqual([])
      expect(args).toContain("--core.strictTLSOptions=true")
      expect(args).toContain("--providers.kubernetescrd.defaultTLSResourcesNamespace=answerable")
      // No Ingress names a TLS option, so none may reach across providers.
      expect(args.filter(arg => arg.includes("crossProviderNamespaces"))).toEqual([])
      const service = manifests.find(manifest => manifest.kind === "Service" && manifest.metadata.name === "platform-traefik")!
      expect(service.metadata.annotations?.["kubernetes.civo.com/firewall-id"]).toBe("fw")
      // Plain HTTP is Cloudflare's to redirect: nothing listens on port 80 behind the load balancer.
      expect(service.spec.ports.map((port: { port: number }) => port.port)).toEqual([443])
      expect(manifests.filter(manifest => manifest.kind === "Namespace")).toEqual([])
      // Traefik and its own objects, the TLS option and the CA's Secret: no certificate manager, no metrics agent.
      expect(manifests.filter(manifest => /cert-manager|alloy|grafana|k8s-monitoring/i.test(JSON.stringify(manifest.metadata)) || /cert-manager\.io|monitoring\.coreos\.com/.test(manifest.apiVersion))).toEqual([])
    })
  }

  test("one TLS option, Traefik's default, demands Cloudflare's origin-pull certificate of every connection", () => {
    const options = renderSupplied("platform").filter(manifest => manifest.kind === "TLSOption")
    expect(options.map(option => `${option.metadata.namespace}/${option.metadata.name}`)).toEqual(["answerable/default"])
    expect(options[0]!.spec).toEqual({
      minVersion: "VersionTLS12",
      sniStrict: true,
      clientAuth: { secretNames: ["cloudflare-origin-pull-ca"], clientAuthType: "RequireAndVerifyClientCert" },
    })
  })

  test("originPull.caPem renders the Secret the TLS option names, in its namespace", () => {
    const secret = renderSupplied("platform", ["values-civo-production.yaml"]).find(manifest => manifest.kind === "Secret" && manifest.metadata.name === "cloudflare-origin-pull-ca")!
    expect(secret.metadata).toMatchObject({ name: "cloudflare-origin-pull-ca", namespace: "answerable" })
    expect(Buffer.from(secret.data["ca.crt"], "base64").toString()).toBe(caPem)
  })

  test("an empty originPull.caPem fails the Civo overlays' render, naming the value; the local overlay renders without it", () => {
    for (const file of ["values-civo-staging.yaml", "values-civo-production.yaml"]) {
      const missing = run(templateArguments("platform", [file]))
      expect(missing.exitCode, file).not.toBe(0)
      expect(missing.stderr).toContain("originPull.caPem is empty")
      expect(missing.stderr).toContain("Terraform's platform module passes it")
    }
    expect(render("platform", ["values-local.yaml"]).filter(manifest => manifest.kind === "Secret" && manifest.metadata.name === "cloudflare-origin-pull-ca")).toEqual([])
    const wrong = run(templateArguments("platform", [], {}, { "originPull.caPem": notPem }))
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.stderr).toContain("originPull.caPem must be a PEM certificate")
  })
})

describe("lint and schemas", () => {
  for (const chart of ["answerable", "platform"]) {
    for (const values of [[], ...overlays(chart).map(file => [file])]) {
      test(`${chart} ${values[0] ?? "defaults"}: helm lint --strict and kubeconform -strict against Kubernetes ${kubernetesVersion}`, () => {
        const files = [...values.flatMap(file => ["--values", join(charts, chart, file)]), ...Object.entries(supplied[chart]!).flatMap(([key, path]) => ["--set-file", `${key}=${path}`])]
        check(["helm", "lint", "--strict", join(charts, chart), ...files])
        const rendered = check(templateArguments(chart, values, chart === "answerable" ? { "image.tag": tag, ...allJobs } : {}, supplied[chart]))
        const result = run(["kubeconform", "-strict", "-summary", "-ignore-missing-schemas", "-kubernetes-version", kubernetesVersion, "-schema-location", "default", "-schema-location", crdSchemas, "-"], { stdin: rendered })
        expect(result.exitCode, result.stdout + result.stderr).toBe(0)
        expect(result.stdout).toContain("Invalid: 0, Errors: 0")
      }, 120_000)
    }
  }
})
