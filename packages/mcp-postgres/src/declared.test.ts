import { expect, test } from "bun:test"
import { declaredMcps } from "./declared"

test("the chart's list parses to each MCP's name, where it runs, its database mode and its scopes, other keys dropped", () => {
  const list = [{ name: "e2e", serve: "both", database: "shared", scopes: ["e2e:read"], grants: ["e2e"] }, { name: "acme", serve: "toolbox", database: "own", scopes: [] }]
  expect(declaredMcps.parse(JSON.stringify(list))).toEqual([{ name: "e2e", serve: "both", database: "shared", scopes: ["e2e:read"] }, { name: "acme", serve: "toolbox", database: "own", scopes: [] }])
  expect(declaredMcps.parse("[]")).toEqual([])
})

test("anything but a list of valid, distinct MCPs with their scopes is refused with a reason", () => {
  const issues = (text: string) => declaredMcps.safeParse(text).error?.issues.map(issue => issue.message)
  expect(issues("not json")).toEqual(["Expected the chart's list of MCPs as JSON"])
  expect(issues(JSON.stringify([{ name: "Acme", serve: "toolbox", database: "shared", scopes: [] }]))).toEqual(["Expected an MCP's name: a lowercase letter then up to 11 lowercase letters or digits"])
  expect(issues(JSON.stringify([{ name: "acme", serve: "web", database: "shared", scopes: [] }]))).toHaveLength(1)
  expect(issues(JSON.stringify([{ name: "acme", serve: "toolbox", database: "shared" }]))).toHaveLength(1)
  expect(issues(JSON.stringify([{ name: "acme", serve: "toolbox", database: "shared", scopes: [""] }]))).toHaveLength(1)
  expect(issues(JSON.stringify([{ name: "acme", serve: "toolbox", database: "shared", scopes: [] }, { name: "acme", serve: "both", database: "own", scopes: [] }]))).toEqual(["An MCP is listed twice"])
})
