import { expect, test } from "bun:test"
import { join } from "node:path"
import type { Running } from "./io"
import { startToolbox, toolbox } from "./servers"
import { servers as recorded, testIo } from "./test/io"

const health = (providers: string[]) => (async () => Response.json({ status: "ok", providers })) as unknown as typeof fetch
const fast = { timeoutMs: 200, pollMs: 5 }

test("the Toolbox is started with bun run dev in its workspace and exactly the environment given, and the wait ends when its health lists the MCP", async () => {
  const { start, started } = recorded()
  let polls = 0
  const fetch = (async () => Response.json({ providers: ++polls < 3 ? ["other"] : ["other", "acme"] })) as unknown as typeof globalThis.fetch
  const { io } = testIo([], "/repo", { fetch, start })
  const running: Running[] = []
  await startToolbox(io, "/repo", "acme", { A: "1" }, running, fast)
  expect([polls, running.length]).toEqual([3, 1])
  expect(started).toMatchObject([{ command: [process.execPath, "run", "--silent", "dev"], cwd: join("/repo", "mcps/toolbox"), env: { A: "1" } }])
  expect(toolbox.port).toBe(47400)
})

test("a Toolbox whose health never lists the MCP is a failure after the time given, and it is already in the list to be stopped", async () => {
  const { start } = recorded()
  const { io } = testIo([], "/repo", { fetch: health(["other"]), start })
  const running: Running[] = []
  await expect(startToolbox(io, "/repo", "acme", {}, running, fast)).rejects.toThrow("the Toolbox did not list acme at http://localhost:47400/health within 0.2 s; its output above says why")
  expect(running).toHaveLength(1)
})

test("a Toolbox that answers nothing, or answers something that is not JSON, is waited for as one that is not up yet; one that stops ends the wait with its exit code", async () => {
  const { start } = recorded(() => 3)
  const failing = (async () => { throw new TypeError("Unable to connect") }) as unknown as typeof globalThis.fetch
  const html = (async () => new Response("<html>", { status: 502 })) as unknown as typeof globalThis.fetch
  for (const fetch of [failing, html]) {
    const { io } = testIo([], "/repo", { fetch, start })
    await expect(startToolbox(io, "/repo", "acme", {}, [], fast)).rejects.toThrow("the Toolbox stopped with exit code 3 before http://localhost:47400/health listed acme; its output above says why")
  }
})
