import { expect, test } from "bun:test"
import { declaredMcps } from "./declared"

test("the chart's list parses to each MCP's name, where it runs and its database mode, other keys dropped", () => {
  const list = [{ name: "e2e", serve: "both", database: "shared", scopes: ["e2e:read"] }, { name: "acme", serve: "toolbox", database: "own" }]
  expect(declaredMcps.parse(JSON.stringify(list))).toEqual([{ name: "e2e", serve: "both", database: "shared" }, { name: "acme", serve: "toolbox", database: "own" }])
  expect(declaredMcps.parse("[]")).toEqual([])
})

test("anything but a list of valid, distinct MCPs is refused with a reason", () => {
  const issues = (text: string) => declaredMcps.safeParse(text).error?.issues.map(issue => issue.message)
  expect(issues("not json")).toEqual(["Expected the chart's list of MCPs as JSON"])
  expect(issues(JSON.stringify([{ name: "Acme", serve: "toolbox", database: "shared" }]))).toEqual(["Expected an MCP's name: a lowercase letter then up to 11 lowercase letters or digits"])
  expect(issues(JSON.stringify([{ name: "acme", serve: "web", database: "shared" }]))).toHaveLength(1)
  expect(issues(JSON.stringify([{ name: "acme", serve: "toolbox", database: "shared" }, { name: "acme", serve: "both", database: "own" }]))).toEqual(["An MCP is listed twice"])
})
