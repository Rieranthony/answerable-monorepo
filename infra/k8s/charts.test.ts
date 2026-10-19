import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDependencies, charts, check, crdSchemas, kubernetesVersion, type Manifest, overlays, render, run, templateArguments } from "./helm"

// The charts' invariants, read from what `helm template` renders for the defaults and for every overlay. Needs `helm` and
// `kubeconform` on the path and the network for the dependency chart and the schemas; no cluster and no Docker.

const tag = "sha-0123456789abcdef0123456789abcdef01234567"
const environments = {
  "values-civo-staging.yaml": { id: "id.answerable-staging.uk", toolbox: "toolbox.answerable-staging.uk", adminMcp: "admin-mcp.answerable-staging.uk", network: "10.10.0.0/24" },
  "values-civo-production.yaml": { id: "id.answerable.org", toolbox: "toolbox.answerable.org", adminMcp: "admin-mcp.answerable.org", network: "10.20.0.0/24" },
} as const

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

      test("every image is one of ours at the given tag, never latest", () => {
        for (const workload of workloads(manifests)) {
          for (const container of containersOf(workload)) {
            expect(container.image).toMatch(new RegExp(`^ghcr\\.io/rieranthony/answerable/(id|toolbox|admin-mcp|ops):${tag}$`))
          }
        }
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

      test("the migrations are pre-install and pre-upgrade hooks after the bootstrap, each with only its own owner login", () => {
        const migrations = ["id-migrate", "toolbox-migrate", "admin-migrate"].map(job => named(manifests, "Job", job)!)
        expect(migrations.map(weight)).toEqual([...migrations.map(weight)].sort((a, b) => a - b))
        for (const [job, owner] of [[migrations[0], "id-database-owner"], [migrations[1], "toolbox-database-owner"], [migrations[2], "admin-database-owner"]] as const) {
          expect(job.metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade")
          expect(new Set(secretReferences(job))).toEqual(new Set([owner]))
          expect(podSpec(job).restartPolicy).toBe("Never")
          expect(podSpec(job).automountServiceAccountToken).toBe(false)
        }
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
        expect(ingresses.length).toBe(3)
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
        for (const server of ["toolbox", "admin-mcp"]) expect(named(manifests, "Deployment", server)!.spec.template.metadata.annotations, server).toBeUndefined()
      })

      test("the ops Jobs: one attempt, the token of their own ServiceAccount where they call Kubernetes, the administrative login or the ID token from Secrets", () => {
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
          expect(env(job, "OPS_NAMESPACE").valueFrom).toEqual({ fieldRef: { fieldPath: "metadata.namespace" } })
        }
        expect(new Set(secretReferences(bootstrap))).toEqual(new Set(["postgres-admin"]))
        expect(env(bootstrap, "OPS_DATABASE_ADMIN_URL").valueFrom.secretKeyRef).toEqual({ name: "postgres-admin", key: "OPS_DATABASE_ADMIN_URL" })
        expect(containersOf(bootstrap)[0].env.map((variable: { name: string }) => variable.name).filter((variable: string) => variable.startsWith("OPS_"))).toEqual(["OPS_NAMESPACE", "OPS_DATABASE_ADMIN_URL"])
        // A staff token when the operator has stored one, else the root secret; either may be absent, and the command says which it needs.
        expect(env(register, "OPS_ID_TOKEN").valueFrom.secretKeyRef).toEqual({ name: "ops-staff-token", key: "OPS_ID_TOKEN", optional: true })
        expect(env(register, "OPS_ID_ROOT_SECRET").valueFrom.secretKeyRef).toEqual({ name: "id-env", key: "ROOT_ADMIN_SECRET", optional: true })
        expect(env(register, "OPS_ID_URL").value).toBe(env(named(manifests, "Deployment", "toolbox")!, "TOOLBOX_ID_ISSUER").value)
        expect(env(register, "OPS_TOOLBOX_URL").value).toBe(env(named(manifests, "Deployment", "toolbox")!, "TOOLBOX_RESOURCE_URL").value.replace(/\/mcp$/, ""))
        expect(env(register, "OPS_ADMIN_MCP_URL").value).toBe(env(named(manifests, "Deployment", "admin-mcp")!, "ADMIN_RESOURCE_URL").value.replace(/\/mcp$/, ""))
        const replicas = name === "values-local.yaml" ? 1 : 2
        expect(env(register, "OPS_START_DEPLOYMENTS").value).toBe(`toolbox=${replicas},admin-mcp=${replicas}`)
        // No staff directory unless the overlay names one.
        expect(env(register, "OPS_STAFF_DOMAIN")).toBeUndefined()
        expect(env(register, "OPS_ENTRA_TENANT")).toBeUndefined()
        // make-admin calls only ID, with the root secret: no Kubernetes token, no Secret but id-env's.
        expect(podSpec(makeAdmin).serviceAccountName).toBeUndefined()
        expect(podSpec(makeAdmin).automountServiceAccountToken).toBe(false)
        expect(new Set(secretReferences(makeAdmin))).toEqual(new Set(["id-env"]))
        expect(env(makeAdmin, "OPS_ID_ROOT_SECRET").valueFrom.secretKeyRef).toEqual({ name: "id-env", key: "ROOT_ADMIN_SECRET", optional: true })
        expect(env(makeAdmin, "OPS_ADMIN_EMAIL").value).toBe("you@answerable.org")
        expect(env(makeAdmin, "OPS_ID_URL").value).toBe(env(register, "OPS_ID_URL").value)
      })

      test("the ops ServiceAccount reads and patches exactly the Secrets and the ConfigMap its Jobs own, and only register touches the two Deployments", () => {
        const databaseCa = [
          { apiGroups: [""], resources: ["configmaps"], resourceNames: ["postgres-ca"], verbs: ["get", "patch"] },
          { apiGroups: [""], resources: ["configmaps"], verbs: ["create"] },
        ]
        const role = named(manifests, "Role", "ops")!
        expect(role.rules).toEqual([
          { apiGroups: [""], resources: ["secrets"], resourceNames: ["id-database-owner", "id-database", "toolbox-database-owner", "toolbox-database", "admin-database-owner", "admin-database", "toolbox-id-client", "admin-id-client"], verbs: ["get", "patch"] },
          { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
          ...databaseCa,
          { apiGroups: ["apps"], resources: ["deployments"], resourceNames: ["toolbox", "admin-mcp"], verbs: ["get", "patch"] },
        ])
        expect(named(manifests, "ServiceAccount", "ops")!.automountServiceAccountToken).toBe(false)
        expect(named(manifests, "RoleBinding", "ops")).toMatchObject({ roleRef: { kind: "Role", name: "ops" }, subjects: [{ kind: "ServiceAccount", name: "ops" }] })
        const bootstrapOnly = renderSupplied("answerable", values, { "image.tag": tag, "ops.bootstrap": "true" })
        expect(named(bootstrapOnly, "Role", "ops")!.rules).toEqual([
          { apiGroups: [""], resources: ["secrets"], resourceNames: ["id-database-owner", "id-database", "toolbox-database-owner", "toolbox-database", "admin-database-owner", "admin-database"], verbs: ["get", "patch"] },
          { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
          ...databaseCa,
        ])
        expect(named(bootstrapOnly, "Role", "ops")!.metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade")
        const registerOnly = renderSupplied("answerable", values, { "image.tag": tag, "ops.register": "true" })
        expect(named(registerOnly, "Role", "ops")!.rules[0].resourceNames).toEqual(["toolbox-id-client", "admin-id-client"])
        expect(named(registerOnly, "Role", "ops")!.rules.some((rule: { resources: string[] }) => rule.resources.includes("configmaps"))).toBe(false)
        expect(named(registerOnly, "Role", "ops")!.metadata.annotations?.["helm.sh/hook"]).toBe("post-install,post-upgrade")
      })

      test("the Toolbox and the admin MCP wait at zero replicas while their client Secret is missing, which helm template, with no cluster, always finds", () => {
        expect(named(manifests, "Deployment", "toolbox")!.spec.replicas).toBe(0)
        expect(named(manifests, "Deployment", "admin-mcp")!.spec.replicas).toBe(0)
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
      expect(manifests.filter(manifest => manifest.kind === "Ingress").map(ingress => ingress.spec.rules[0].host).sort()).toEqual([expected.adminMcp, expected.id, expected.toolbox].sort())
      const autoscalers = manifests.filter(manifest => manifest.kind === "HorizontalPodAutoscaler")
      expect(autoscalers.map(autoscaler => autoscaler.spec.scaleTargetRef.name).sort()).toEqual(["admin-mcp", "id", "toolbox"])
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
    const digests = { id: "a".repeat(64), toolbox: "b".repeat(64), "admin-mcp": "c".repeat(64), ops: "d".repeat(64) }
    const set = Object.fromEntries([["image.tag", tag], ...Object.entries(allJobs), ...Object.entries(digests).map(([image, hex]) => [`images.${image}.digest`, `sha256:${hex}`])])
    const pinned = renderSupplied("answerable", ["values-civo-production.yaml"], set)
    const images = new Set(workloads(pinned).flatMap(workload => containersOf(workload).map((container: { image: string }) => container.image)))
    expect(images).toEqual(new Set(Object.entries(digests).map(([image, hex]) => `ghcr.io/rieranthony/answerable/${image}@sha256:${hex}`)))
    // Only the Toolbox pinned: the others keep the tag.
    const mixed = renderSupplied("answerable", ["values-civo-production.yaml"], { "image.tag": tag, "images.toolbox.digest": `sha256:${digests.toolbox}` })
    expect(containersOf(named(mixed, "Deployment", "toolbox")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/toolbox@sha256:${digests.toolbox}`)
    expect(containersOf(named(mixed, "Deployment", "id")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/id:${tag}`)
    expect(containersOf(named(mixed, "Job", "toolbox-migrate")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/toolbox@sha256:${digests.toolbox}`)
    // A digest that is not sha256 and 64 hex digits is refused, rather than deployed as something else.
    const bad = run(templateArguments("answerable", [], { "image.tag": tag, "images.id.digest": "sha256:abc" }))
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr).toContain("images.id.digest")
  })

  test("without an image tag the images say so, rather than falling back to a mutable tag", () => {
    for (const workload of workloads(renderSupplied("answerable"))) for (const container of containersOf(workload)) expect(container.image).toEndWith(":unset")
  })

  test("the servers connect as their runtime logins and the migrations as the owners, with the role to provision", () => {
    const manifests = renderSupplied("answerable", [], { "image.tag": tag })
    for (const [deployment, variable, secret] of [["id", "DATABASE_URL", "id-database"], ["toolbox", "TOOLBOX_DATABASE_URL", "toolbox-database"], ["admin-mcp", "ADMIN_DATABASE_URL", "admin-database"]]) {
      expect(env(named(manifests, "Deployment", deployment!)!, variable!).valueFrom.secretKeyRef).toEqual({ name: secret, key: variable })
    }
    for (const [job, prefix, role] of [["id-migrate", "", "answerable_id_runtime"], ["toolbox-migrate", "TOOLBOX_", "answerable_toolbox_runtime"], ["admin-migrate", "ADMIN_", "answerable_admin_runtime"]]) {
      const migration = named(manifests, "Job", job!)!
      expect(env(migration, `${prefix}DATABASE_MIGRATION_URL`).valueFrom.secretKeyRef.key).toBe(`${prefix}DATABASE_MIGRATION_URL`)
      expect(env(migration, `${prefix}DATABASE_RUNTIME_ROLE`).value).toBe(role)
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
