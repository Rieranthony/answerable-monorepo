import { expect, test } from "bun:test"
import { join } from "node:path"
import { budget, connectionsAtCeilings } from "./connections"

const root = join(import.meta.dir, "../..")

test("the budget's numbers are the deployment's: each overlay's autoscaling ceilings, and ID's default pool size", async () => {
  const ceilings = async (environment: string) => {
    const values = Bun.YAML.parse(await Bun.file(join(root, `charts/answerable/values-civo-${environment}.yaml`)).text()) as Record<string, { autoscaling: { maxReplicas: number } }>
    return Object.fromEntries(["id", "toolbox", "adminMcp"].map(server => [server, values[server]!.autoscaling.maxReplicas]))
  }
  expect({ staging: await ceilings("staging"), production: await ceilings("production") }).toEqual(budget.replicas)
  const inventory = await Bun.file(join(root, "packages/config/inventory.json")).json() as { name: string; fields: { name: string; fallback?: string }[] }[]
  expect(Number(inventory.find(group => group.name === "ID")!.fields.find(field => field.name === "DATABASE_POOL_MAX")!.fallback)).toBe(budget.pool.id)
})

test("the shared pools at the ceilings, and ten connections per Toolbox replica for each own MCP, whatever its serve", () => {
  expect(connectionsAtCeilings([], "staging")).toEqual({ total: 4 * 20 + 3 * 10 + 3 * 20, own: 0 })
  expect(connectionsAtCeilings([{ database: "shared" }], "staging")).toEqual({ total: 4 * 20 + 3 * 10 + 3 * 20, own: 0 })
  expect(connectionsAtCeilings([{ database: "own" }, { database: "own" }, { database: "own" }], "production"))
    .toEqual({ total: 6 * 20 + 4 * 10 + 4 * 20 + 4 * 10 * 3, own: 120 })
})
