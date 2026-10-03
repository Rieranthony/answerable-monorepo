import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { startId } from "./id"

const manifest = {
  idOrigin: "http://127.0.0.1:47600",
  adminResource: "http://127.0.0.1:47600/api/admin",
  rootSecret: "root-secret",
  tenants: [{ slug: "acme", email: "tester@acme.example.test", organizationId: crypto.randomUUID() }],
  spares: [],
}
const tenants = [{ slug: "acme", signIns: 2 }]
const spare = {
  slug: "spare",
  domain: "spare.example.test",
  email: "tester@spare.example.test",
  issuer: "http://127.0.0.1:50001",
  authorizationEndpoint: "http://127.0.0.1:50001/authorize",
  tokenEndpoint: "http://127.0.0.1:50001/token",
  jwksEndpoint: "http://127.0.0.1:50001/jwks",
  clientId: "spare",
  clientSecret: "local-fixture-only",
}
const platformManifest = { ...manifest, tenants: [], platform: { organizationId: crypto.randomUUID(), domain: "answerable.example.test", email: "staff@answerable.example.test" }, spares: [spare] }
const log = spyOn(console, "log").mockImplementation(() => {})
afterAll(() => log.mockRestore())

let spawned: { mockRestore(): void } | undefined
afterEach(() => spawned?.mockRestore())

/** `Bun.spawn` replaced: Compose commands succeed, and the fixture writes `written` as its manifest and runs until it is killed. */
function fakeSpawn(written: object = manifest) {
  const commands: string[][] = []
  const signals: string[] = []
  const spawn = (command: string[]) => {
    commands.push(command)
    if (command[0] === "docker") return { exitCode: null, exited: Promise.resolve(0), kill() {} }
    void Bun.write(command[3]!, JSON.stringify(written))
    let stop: (code: number) => void = () => {}
    const exited = new Promise<number>(resolve => (stop = resolve))
    return { exitCode: null, exited, kill: (signal: string) => (signals.push(signal), stop(137)) }
  }
  spawned = spyOn(Bun, "spawn").mockImplementation(spawn as never)
  return { commands, signals, directory: () => dirname(commands.find(command => command[0] !== "docker")![2]!) }
}

test("startId runs Compose, hands the fixture its plan, returns the manifest and an admin, and stop() undoes it all", async () => {
  const fake = fakeSpawn()
  const id = await startId({ tenants })
  expect(id.manifest).toEqual(manifest)
  expect(fake.commands[0]!.slice(0, 4)).toEqual(["docker", "compose", "-p", "answerable-mcp-e2e"])
  expect(fake.commands[0]!.slice(-3)).toEqual(["up", "-d", "--wait"])
  expect(fake.commands[1]!.slice(1)).toEqual([expect.stringMatching(/mcp-e2e-fixture\.ts$/), expect.stringMatching(/plan\.json$/), expect.stringMatching(/manifest\.json$/), "--isolated-mcp-fixture"])
  expect(await Bun.file(fake.commands[1]![2]!).json()).toEqual({ tenants })
  expect(id.admin).toBeFunction()
  await id.stop()
  await id.stop()
  expect(fake.signals).toEqual(["SIGKILL"])
  expect(fake.commands.filter(command => command.includes("down") && command.includes("--volumes"))).toHaveLength(1)
  expect(existsSync(fake.directory())).toBe(false)
})

test("the platform and spare plan fields reach the fixture, and the manifest returns what it wrote", async () => {
  const fake = fakeSpawn(platformManifest)
  const id = await startId({ tenants: [], platform: { signIns: 1 }, spares: [{ slug: "spare", signIns: 2 }] })
  expect(await Bun.file(fake.commands[1]![2]!).json()).toEqual({ tenants: [], platform: { signIns: 1 }, spares: [{ slug: "spare", signIns: 2 }] })
  expect(id.manifest).toEqual(platformManifest)
  await id.stop()
})
