import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { interrupt, listening, processStarter } from "./machine"

const sleeping = (extra = "") => [process.execPath, "-e", `${extra}setInterval(() => {}, 1000)`]
const options = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } }

test("a started process runs with exactly the environment it was given, until it is stopped with SIGTERM", async () => {
  const running = processStarter(5000)([process.execPath, "-e", "process.exit(process.env.ONLY === '1' && !process.env.HOME ? 7 : 1)"], { ...options, env: { ...options.env, ONLY: "1" } })
  expect(await running.exited).toBe(7)
  const long = processStarter(5000)(sleeping(), options)
  let code: number | undefined
  void long.exited.then(done => (code = done))
  await Bun.sleep(50)
  expect(code).toBeUndefined()
  await long.stop()
  expect(await long.exited).toBe(143)
})

test("a process that ignores SIGTERM is killed once the grace period has passed", async () => {
  const stubborn = processStarter(100)(sleeping("process.on('SIGTERM', () => {}); "), options)
  await Bun.sleep(200)
  const started = performance.now()
  await stubborn.stop()
  expect(await stubborn.exited).toBe(137)
  expect(performance.now() - started).toBeLessThan(3000)
})

test("stop ends the whole group: a server that outlives its wrapper, and ignores SIGTERM as a bun --hot server does, is killed with it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-mcp-machine-"))
  const pidFile = join(directory, "server.pid")
  try {
    const server = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    // The wrapper starts the server and ends at SIGTERM at once, as bun run dev does when the server is left behind.
    const wrapper = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(server)}], { stdout: 'inherit' }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`
    const running = processStarter(300)([process.execPath, "-e", wrapper], options)
    for (let waited = 0; !(await Bun.file(pidFile).exists()) && waited < 100; waited++) await Bun.sleep(50)
    const pid = Number(await readFile(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await running.stop()
    await Bun.sleep(50)
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("listening says whether something accepts connections on a port", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  expect(await listening("127.0.0.1", server.port)).toBe(true)
  const { port } = server
  server.stop(true)
  await Bun.sleep(20)
  expect(await listening("127.0.0.1", port)).toBe(false)
})

test("interrupt aborts its signal on the first SIGINT or SIGTERM, and not before; a second one changes nothing", () => {
  const before = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") }
  const signal = interrupt()
  expect(signal.aborted).toBe(false)
  process.emit("SIGINT")
  process.emit("SIGINT")
  expect(signal.aborted).toBe(true)
  for (const [name, known] of [["SIGINT", before.int], ["SIGTERM", before.term]] as const) {
    for (const listener of process.listeners(name)) if (!known.includes(listener)) process.off(name, listener)
  }
})
