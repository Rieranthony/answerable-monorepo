import assert from "node:assert/strict"
import { join } from "node:path"

const checkpoint = process.argv[2] === "startup" ? "[e2e] Starting isolated PostgreSQL" : "[e2e] Authenticating"
const root = new URL("../../../", import.meta.url).pathname
const child = Bun.spawn([process.execPath, "mcps/e2e/scripts/id-e2e.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" })
let interrupted = false
let recent = ""
const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000)
let errors = ""
const outputReader = child.stdout.getReader()
const errorReader = child.stderr.getReader()
const capture = async (reader: ReadableStreamDefaultReader<Uint8Array>, append: (text: string) => void) => {
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    append(decoder.decode(value, { stream: true }))
  }
}
const output = capture(outputReader, text => {
  recent = (recent + text).slice(-10_000)
  if (!interrupted && recent.includes(checkpoint)) {
    interrupted = true
    child.kill("SIGTERM")
  }
})
const errorOutput = capture(errorReader, text => { errors = (errors + text).slice(-10_000) })
try {
  const exit = await child.exited
  await Promise.all([outputReader.cancel(), errorReader.cancel()])
  await Promise.all([output, errorOutput])
  assert.ok(interrupted, "Runner reached the chosen checkpoint before interruption")
  assert.equal(exit, 143, "Runner terminates after SIGTERM cleanup")
  const compose = Bun.spawn(["docker", "compose", "-p", "answerable-mcp-e2e", "-f", join(root, "mcps/e2e/compose.yaml"), "ps", "-q"], { stdout: "pipe", stderr: "pipe" })
  assert.equal(await compose.exited, 0)
  assert.equal((await new Response(compose.stdout).text()).trim(), "", "No fixture container remains")
  for (const port of [47532, 47600, 47602, 47603, 47604]) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") })
    probe.stop(true)
  }
  console.log(`[e2e] PASS: SIGTERM at ${process.argv[2] === "startup" ? "startup" : "browser login"} removes the fixture container and releases all reserved ports`)
} catch (error) {
  console.error(recent, errors)
  throw error
} finally {
  clearTimeout(timeout)
  if (child.exitCode === null) child.kill("SIGTERM")
  await child.exited
}
