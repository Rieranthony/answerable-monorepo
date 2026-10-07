import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { z } from "zod"
import { createAdmin } from "./admin"
import { cleanup, onCleanup } from "./cleanup"
import { step } from "./step"

const compose = ["docker", "compose", "-p", "answerable-mcp-e2e", "-f", Bun.fileURLToPath(new URL("../compose.yaml", import.meta.url))]
const cwd = Bun.fileURLToPath(new URL("../../../apps/id/", import.meta.url))

const spareSchema = z.object({
  slug: z.string(),
  domain: z.string(),
  email: z.string(),
  issuer: z.url(),
  authorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  jwksEndpoint: z.url(),
  clientId: z.string(),
  clientSecret: z.string(),
})
const manifestSchema = z.object({
  idOrigin: z.url(),
  adminResource: z.url(),
  rootSecret: z.string(),
  tenants: z.array(z.object({ slug: z.string(), email: z.string(), organizationId: z.uuid() })),
  platform: z.object({ organizationId: z.uuid(), domain: z.string(), email: z.string() }).optional(),
  spares: z.array(spareSchema),
})

/** A spare company directory the fixture started and trusted, bound to no organisation: its `slug`, the `domain` and `email` of its person, and the `issuer`, endpoints, `clientId` and `clientSecret` that point an organisation's single sign-on at it (see `setSsoProvider`). */
export type Spare = z.infer<typeof spareSchema>

async function run(command: string[], stderr: "ignore" | "inherit" = "inherit") {
  if ((await Bun.spawn(command, { cwd, stdout: "ignore", stderr }).exited) !== 0) throw new Error(`Command failed: ${command.slice(0, 4).join(" ")}; check that Docker is running and port 47532 is free`)
}

/**
 * Start a real Answerable ID on its own database and return what a journey needs.
 * Starts the Compose PostgreSQL (port 47532), runs `apps/id/scripts/mcp-e2e-fixture.ts` (ID on port 47600, through its production migrations and restricted runtime role)
 * and waits up to `timeoutMs` (90 seconds) for its manifest. The fixture creates one organisation per tenant, with its domain and a local test company directory that accepts `signIns` sign-ins.
 * `platform` gives the platform organisation (Answerable staff) a domain and such a directory too, so a staff member can sign in: `signIns` times, or, given a list,
 * one sign-in per person listed, in order, each `<person>@answerable.example.test`, so that a second member, such as `colleague`, can sign in between two of `staff`'s.
 * `spares` start directories that are trusted at boot but belong to no organisation, for organisations a journey creates later: `setSsoProvider` points one at a spare.
 * Everything else is provisioned through `admin`.
 * `stop()` ends ID, brings PostgreSQL down with its volume, removes the temporary directory and closes everything else the kit opened. It is safe to call twice, and it runs on Ctrl-C and SIGTERM.
 * A start that throws has already stopped.
 */
export async function startId({
  tenants,
  platform,
  spares,
  timeoutMs = 90_000,
}: {
  tenants: readonly { slug: string; signIns: number }[]
  platform?: { signIns: number | readonly string[] }
  spares?: readonly { slug: string; signIns: number }[]
  timeoutMs?: number
}) {
  const directory = await mkdtemp(join(tmpdir(), "answerable-mcp-acceptance-"))
  let fixture: ReturnType<typeof Bun.spawn> | undefined
  onCleanup(async () => {
    fixture?.kill("SIGKILL")
    await fixture?.exited
    // On Ctrl-C the terminal's pipes may already be closed, and Compose dies writing to them.
    await run([...compose, "down", "--volumes"], "ignore").catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  try {
    step("Starting isolated PostgreSQL")
    await run([...compose, "up", "-d", "--wait"])
    const plan = join(directory, "plan.json")
    const manifestPath = join(directory, "manifest.json")
    await Bun.write(plan, JSON.stringify({ tenants, platform, spares }))
    fixture = Bun.spawn([process.execPath, "scripts/mcp-e2e-fixture.ts", plan, manifestPath, "--isolated-mcp-fixture"], { cwd, stdout: "inherit", stderr: "inherit" })
    const deadline = Date.now() + timeoutMs
    while (!(await Bun.file(manifestPath).exists())) {
      if (fixture.exitCode !== null) throw new Error(`ID fixture stopped (${fixture.exitCode}); its output above says why`)
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for the ID fixture; run again on a quieter machine, or pass a larger timeoutMs to startId`)
      await Bun.sleep(200)
    }
    const manifest = manifestSchema.parse(await Bun.file(manifestPath).json())
    return { manifest, admin: createAdmin(manifest), stop: cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * What `startId` returns: `manifest`, `admin` and `stop`. The manifest holds `idOrigin`, `adminResource`, `rootSecret`, each tenant's `slug`, `email` and `organizationId`,
 * `platform` (the platform organisation's `organizationId`, its `domain` and its staff member's `email`; only when the plan had `platform`) and `spares` (see `Spare`).
 */
export type Id = Awaited<ReturnType<typeof startId>>

/** Create the database `name` on the PostgreSQL `startId` started (port 47532), and connect to it; the connection closes when the kit stops. */
export async function createDatabase(name: string) {
  const postgres = "postgres://answerable:answerable@127.0.0.1:47532"
  const server = new SQL({ url: `${postgres}/answerable_id_test`, max: 1 })
  await server.unsafe(`create database ${name}`)
  await server.close()
  const db = new SQL({ url: `${postgres}/${name}`, max: 4 })
  onCleanup(() => db.close())
  return db
}
