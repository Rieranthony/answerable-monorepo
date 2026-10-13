import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { buildDependencies, charts, check, crdSchemas, kubernetesVersion, type Manifest, overlays, render, run, templateArguments } from "./helm"

// The charts' invariants, read from what `helm template` renders for the defaults and for every overlay. Needs `helm` and
// `kubeconform` on the path and the network for the dependency charts and the schemas; no cluster and no Docker.

const tag = "sha-0123456789abcdef0123456789abcdef01234567"
// Cloudflare's published ranges (api.cloudflare.com/client/v4/ips, etag 38f79d050aa027e3be3865e495dcc9bc, read 13 October 2026).
const cloudflare = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]
const environments = {
  "values-civo-staging.yaml": { id: "id.answerable-staging.uk", toolbox: "toolbox.answerable-staging.uk", adminMcp: "admin-mcp.answerable-staging.uk", network: "10.10.0.0/24" },
  "values-civo-production.yaml": { id: "id.answerable.org", toolbox: "toolbox.answerable.org", adminMcp: "admin-mcp.answerable.org", network: "10.20.0.0/24" },
} as const

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
      const manifests = render("answerable", values, { "image.tag": tag, "ops.bootstrap": "true", "ops.register": "true" })

      test("renders no namespace, Secret or database certificate: Terraform, the deploy and the Jobs own those", () => {
        expect(manifests.filter(manifest => ["Namespace", "Secret"].includes(manifest.kind))).toEqual([])
        expect(named(manifests, "ConfigMap", "postgres-ca")).toBeUndefined()
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
              if (/SECRET|PASSWORD|TOKEN|DATABASE(_MIGRATION)?_URL$/.test(variable.name)) expect(variable.valueFrom?.secretKeyRef, `${workload.metadata.name} ${variable.name}`).toBeDefined()
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
        const bootstrap = named(manifests, "Job", "ops-bootstrap")
        // The kind stack names no ops image until the ops image exists (brief B3), so its Jobs are absent there.
        if (name === "values-local.yaml") return expect(bootstrap).toBeUndefined()
        expect(bootstrap!.metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade")
        for (const job of migrations) expect(weight(job)).toBeGreaterThan(weight(bootstrap!))
        expect(named(manifests, "Job", "ops-register")!.metadata.annotations?.["helm.sh/hook"]).toBe("post-install,post-upgrade")
      })

      test("the services never receive an owner login, and mount the database's certificate authority", () => {
        for (const deployment of manifests.filter(manifest => manifest.kind === "Deployment")) {
          expect(secretReferences(deployment).filter(secret => secret.endsWith("-owner")), deployment.metadata.name).toEqual([])
          expect(podSpec(deployment).automountServiceAccountToken).toBe(false)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expect(podSpec(deployment).volumes.find((volume: any) => volume.configMap?.name === "postgres-ca")).toBeDefined()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expect(containersOf(deployment)[0].volumeMounts.find((mount: any) => mount.mountPath === "/etc/ssl/db")).toMatchObject({ readOnly: true })
        }
      })

      test("each Deployment rolls with no unavailable pod, probes readiness, spreads over nodes and has a disruption budget", () => {
        const deployments = manifests.filter(manifest => manifest.kind === "Deployment")
        expect(deployments.map(deployment => deployment.metadata.name).sort()).toEqual(name === "values-local.yaml" ? ["id", "toolbox"] : ["admin-mcp", "id", "toolbox"])
        for (const deployment of deployments) {
          expect(deployment.spec.strategy).toMatchObject({ type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0 } })
          expect(containersOf(deployment)[0].readinessProbe?.httpGet?.path).toBe(deployment.metadata.name === "id" ? "/readyz" : "/health")
          expect(containersOf(deployment)[0].livenessProbe).toBeDefined()
          expect(podSpec(deployment).topologySpreadConstraints?.[0]).toMatchObject({ topologyKey: "kubernetes.io/hostname", maxSkew: 1 })
          expect(manifests.find(manifest => manifest.kind === "PodDisruptionBudget" && manifest.spec.selector.matchLabels["app.kubernetes.io/component"] === deployment.spec.selector.matchLabels["app.kubernetes.io/component"])).toBeDefined()
        }
      })

      test("one Ingress per hostname, behind the origin-pull certificate check, with a certificate from cert-manager", () => {
        const ingresses = manifests.filter(manifest => manifest.kind === "Ingress")
        expect(ingresses.length).toBe(name === "values-local.yaml" ? 2 : 3)
        for (const ingress of ingresses) {
          expect(ingress.spec.ingressClassName).toBe("traefik")
          expect(ingress.metadata.annotations).toMatchObject({
            "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
            "traefik.ingress.kubernetes.io/router.tls": "true",
            // The TLSOption charts/platform renders in this namespace: Cloudflare's origin-pull certificate required.
            "traefik.ingress.kubernetes.io/router.tls.options": "answerable-origin-pull@kubernetescrd",
            "cert-manager.io/cluster-issuer": expect.any(String),
          })
          expect(ingress.spec.rules.length).toBe(1)
          expect(ingress.spec.tls).toEqual([{ hosts: [ingress.spec.rules[0].host], secretName: `${ingress.metadata.name}-tls` }])
        }
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
    test(`${file} names the environment's hostnames, issuer and resources, and trusts Cloudflare, the private network and the pod range`, () => {
      const manifests = render("answerable", [file], { "image.tag": tag })
      const id = named(manifests, "Deployment", "id")!
      const toolbox = named(manifests, "Deployment", "toolbox")!
      const admin = named(manifests, "Deployment", "admin-mcp")!
      const issuer = `https://${expected.id}`
      expect(env(id, "BETTER_AUTH_URL").value).toBe(issuer)
      expect(env(id, "TRUSTED_PROXY_CIDRS").value.split(",")).toEqual([...cloudflare, expected.network, "10.42.0.0/16"])
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

  test("the ops Jobs render only when switched on and an ops image is named", () => {
    const off = render("answerable", [], { "image.tag": tag })
    expect(off.filter(manifest => manifest.metadata.name.startsWith("ops-"))).toEqual([])
    const noImage = render("answerable", [], { "image.tag": tag, "ops.bootstrap": "true", "ops.register": "true", "images.ops.repository": "" })
    expect(noImage.filter(manifest => manifest.kind === "Job" && manifest.metadata.name.startsWith("ops-"))).toEqual([])
  })

  test("an image with a digest runs by digest, the exact bytes verified; one without runs by the shared tag", () => {
    const digests = { id: "a".repeat(64), toolbox: "b".repeat(64), "admin-mcp": "c".repeat(64), ops: "d".repeat(64) }
    const set = Object.fromEntries([["image.tag", tag], ["ops.bootstrap", "true"], ["ops.register", "true"], ...Object.entries(digests).map(([image, hex]) => [`images.${image}.digest`, `sha256:${hex}`])])
    const pinned = render("answerable", ["values-civo-production.yaml"], set)
    const images = new Set(workloads(pinned).flatMap(workload => containersOf(workload).map((container: { image: string }) => container.image)))
    expect(images).toEqual(new Set(Object.entries(digests).map(([image, hex]) => `ghcr.io/rieranthony/answerable/${image}@sha256:${hex}`)))
    // Only the Toolbox pinned: the others keep the tag.
    const mixed = render("answerable", ["values-civo-production.yaml"], { "image.tag": tag, "images.toolbox.digest": `sha256:${digests.toolbox}` })
    expect(containersOf(named(mixed, "Deployment", "toolbox")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/toolbox@sha256:${digests.toolbox}`)
    expect(containersOf(named(mixed, "Deployment", "id")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/id:${tag}`)
    expect(containersOf(named(mixed, "Job", "toolbox-migrate")!)[0].image).toBe(`ghcr.io/rieranthony/answerable/toolbox@sha256:${digests.toolbox}`)
    // A digest that is not sha256 and 64 hex digits is refused, rather than deployed as something else.
    const bad = run(templateArguments("answerable", [], { "image.tag": tag, "images.id.digest": "sha256:abc" }))
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr).toContain("images.id.digest")
  })

  test("without an image tag the images say so, rather than falling back to a mutable tag", () => {
    for (const workload of workloads(render("answerable"))) for (const container of containersOf(workload)) expect(container.image).toEndWith(":unset")
  })

  test("the servers connect as their runtime logins and the migrations as the owners, with the role to provision", () => {
    const manifests = render("answerable", [], { "image.tag": tag })
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
  test("pins Traefik, cert-manager and the Grafana agent, named as Terraform's values address them, all from OCI", async () => {
    const chart = Bun.YAML.parse(await Bun.file(join(charts, "platform/Chart.yaml")).text()) as { dependencies: { name: string; version: string; repository: string }[] }
    expect(chart.dependencies.map(dependency => [dependency.name, dependency.version])).toEqual([["traefik", "41.7.1"], ["cert-manager", "v1.21.2"], ["k8s-monitoring", "4.5.3"]])
    for (const dependency of chart.dependencies) expect(dependency.repository).toStartWith("oci://")
  })

  for (const [name, values] of [["the defaults", []], ...overlays("platform").map(file => [file, [file]])] as [string, string[]][]) {
    test(`${name}: Traefik keeps forwarded headers only from Terraform's trusted addresses and appends its peer, refuses conflicting TLS options, and listens on 443 only`, () => {
      const manifests = render("platform", values, { "traefik.ports.websecure.forwardedHeaders.trustedIPs": "{203.0.113.0/24,10.10.0.0/24}", "traefik.service.annotations.kubernetes\\.civo\\.com/firewall-id": "fw" })
      const deployment = manifests.find(manifest => manifest.kind === "Deployment" && manifest.metadata.name === "platform-traefik")!
      const args: string[] = deployment.spec.template.spec.containers.find((container: { name: string }) => container.name === "platform-traefik").args
      expect(args).toContain("--entryPoints.websecure.forwardedHeaders.trustedIPs=203.0.113.0/24,10.10.0.0/24")
      expect(args.filter(arg => /notAppendXForwardedFor=true|forwardedHeaders\.insecure/.test(arg))).toEqual([])
      expect(args).toContain("--core.strictTLSOptions=true")
      expect(args).toContain("--providers.kubernetesingress.crossProviderNamespaces=answerable")
      expect(args).toContain("--providers.kubernetescrd.defaultTLSResourcesNamespace=answerable")
      const service = manifests.find(manifest => manifest.kind === "Service" && manifest.metadata.name === "platform-traefik")!
      expect(service.metadata.annotations?.["kubernetes.civo.com/firewall-id"]).toBe("fw")
      // Plain HTTP is Cloudflare's to redirect: nothing listens on port 80 behind the load balancer.
      expect(service.spec.ports.map((port: { port: number }) => port.port)).toEqual([443])
      expect(manifests.filter(manifest => manifest.kind === "Namespace")).toEqual([])
    })
  }

  test("every TLS connection must present Cloudflare's origin-pull certificate: the Ingresses' option and Traefik's default", () => {
    const options = render("platform").filter(manifest => manifest.kind === "TLSOption")
    expect(options.map(option => `${option.metadata.namespace}/${option.metadata.name}`).sort()).toEqual(["answerable/default", "answerable/origin-pull"])
    for (const option of options) {
      expect(option.spec).toEqual({
        minVersion: "VersionTLS12",
        sniStrict: true,
        clientAuth: { secretNames: ["cloudflare-origin-pull-ca"], clientAuthType: "RequireAndVerifyClientCert" },
      })
    }
  })

  test("the Civo overlays issue certificates from Let's Encrypt through Cloudflare, and the kind stack from its own CA", () => {
    for (const file of ["values-civo-staging.yaml", "values-civo-production.yaml"]) {
      const issuer = render("platform", [file]).find(manifest => manifest.kind === "ClusterIssuer" && manifest.metadata.name === "letsencrypt")!
      expect(issuer.spec.acme.server).toBe("https://acme-v02.api.letsencrypt.org/directory")
      expect(issuer.spec.acme.solvers[0].dns01.cloudflare.apiTokenSecretRef).toEqual({ name: "cloudflare-api-token", key: "api-token" })
    }
    const local = render("platform", ["values-local.yaml"])
    expect(local.find(manifest => manifest.kind === "ClusterIssuer" && manifest.metadata.name === "local")?.spec).toEqual({ ca: { secretName: "local-ca" } })
    expect(local.find(manifest => manifest.kind === "ClusterIssuer" && manifest.metadata.name === "letsencrypt")).toBeUndefined()
  })
})

describe("lint and schemas", () => {
  for (const chart of ["answerable", "platform"]) {
    for (const values of [[], ...overlays(chart).map(file => [file])]) {
      test(`${chart} ${values[0] ?? "defaults"}: helm lint --strict and kubeconform -strict against Kubernetes ${kubernetesVersion}`, () => {
        const files = values.flatMap(file => ["--values", join(charts, chart, file)])
        check(["helm", "lint", "--strict", join(charts, chart), ...files])
        const rendered = check(templateArguments(chart, values, chart === "answerable" ? { "image.tag": tag, "ops.bootstrap": "true", "ops.register": "true" } : {}))
        const result = run(["kubeconform", "-strict", "-summary", "-ignore-missing-schemas", "-kubernetes-version", kubernetesVersion, "-schema-location", "default", "-schema-location", crdSchemas, "-"], { stdin: rendered })
        expect(result.exitCode, result.stdout + result.stderr).toBe(0)
        expect(result.stdout).toContain("Invalid: 0, Errors: 0")
      }, 120_000)
    }
  }
})
