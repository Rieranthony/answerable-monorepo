import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { createAdmin } from "./admin"
import { cleanup, onCleanup } from "./cleanup"
import { step } from "./step"

const compose = ["docker", "compose", "-p", "answerable-mcp-e2e", "-f", new URL("../compose.yaml", import.meta.url).pathname]
const cwd = new URL("../../../apps/id/", import.meta.url).pathname

const manifestSchema = z.object({
  idOrigin: z.url(),
  adminResource: z.url(),
  rootSecret: z.string(),
  tenants: z.array(z.object({ slug: z.string(), email: z.string(), organizationId: z.uuid() })),
})

type Child = { readonly exitCode: number | null; readonly exited: Promise<number>; kill(signal: "SIGKILL"): void }
/** `Bun.spawn`, or a fake in tests. */
export type Spawn = (command: string[], options: { cwd: string; stdout: "ignore" | "inherit"; stderr: "ignore" | "inherit" }) => Child

async function run(spawn: Spawn, command: string[], stderr: "ignore" | "inherit" = "inherit") {
  if ((await spawn(command, { cwd, stdout: "ignore", stderr }).exited) !== 0) throw new Error(`Command failed: ${command.slice(0, 4).join(" ")}`)
}

/**
 * Start a real Answerable ID on its own database and return what a journey needs.
 * Starts the Compose PostgreSQL (port 47532), runs `apps/id/scripts/mcp-e2e-fixture.ts` (ID on port 47600, through its production migrations and restricted runtime role)
 * and waits up to `timeoutMs` (90 seconds) for its manifest. The fixture creates one organisation per tenant, with its domain and a local test company directory that accepts `signIns` sign-ins.
 * Everything else is provisioned through `admin`.
 * `stop()` ends ID, brings PostgreSQL down with its volume, removes the temporary directory and closes everything else the kit opened. It is safe to call twice, and it runs on Ctrl-C and SIGTERM.
 * A start that throws has already stopped. `spawn` replaces `Bun.spawn`, for the kit's own tests.
 */
export async function startId({ tenants, spawn = Bun.spawn, timeoutMs = 90_000 }: { tenants: readonly { slug: string; signIns: number }[]; spawn?: Spawn; timeoutMs?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "answerable-mcp-acceptance-"))
  let fixture: Child | undefined
  onCleanup(async () => {
    fixture?.kill("SIGKILL")
    await fixture?.exited
    // On Ctrl-C the terminal's pipes may already be closed, and Compose dies writing to them.
    await run(spawn, [...compose, "down", "--volumes"], "ignore").catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  try {
    step("Starting isolated PostgreSQL")
    await run(spawn, [...compose, "up", "-d", "--wait"])
    const plan = join(directory, "plan.json")
    const manifestPath = join(directory, "manifest.json")
    await Bun.write(plan, JSON.stringify({ tenants }))
    fixture = spawn([process.execPath, "scripts/mcp-e2e-fixture.ts", plan, manifestPath, "--isolated-mcp-fixture"], { cwd, stdout: "inherit", stderr: "inherit" })
    const deadline = Date.now() + timeoutMs
    while (!(await Bun.file(manifestPath).exists())) {
      if (fixture.exitCode !== null) throw new Error(`ID fixture stopped (${fixture.exitCode})`)
      if (Date.now() > deadline) throw new Error("Timed out waiting for the ID fixture")
      await Bun.sleep(200)
    }
    const manifest = manifestSchema.parse(await Bun.file(manifestPath).json())
    return { manifest, admin: createAdmin(manifest), stop: cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** What `startId` returns: `manifest` (`idOrigin`, `adminResource`, `rootSecret` and each tenant's `slug`, `email` and `organizationId`), `admin` and `stop`. */
export type Id = Awaited<ReturnType<typeof startId>>
