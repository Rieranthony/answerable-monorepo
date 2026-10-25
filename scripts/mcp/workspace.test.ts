import { expect, test } from "bun:test"
import { z } from "zod"
import { spawn, tail } from "./io"
import { declaration } from "./workspace"

test("mcp.json's JSON schema is the declaration the CLI validates with", async () => {
  expect(await Bun.file(new URL("mcp.schema.json", import.meta.url)).json()).toEqual(z.toJSONSchema(declaration))
})

test("a command spawned runs to its end with its output, and a failure shows its last lines", async () => {
  expect(await spawn([process.execPath, "-e", "console.log('out'); console.error('err'); process.exit(3)"], { cwd: import.meta.dir, env: { EXTRA: "1" } })).toEqual({ code: 3, output: "out\nerr\n" })
  expect(tail("a\nb\nc\n\n", 2)).toBe("b\nc")
})
