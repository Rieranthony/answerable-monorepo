import { expect, test } from "bun:test"
import { spawn, tail } from "./io"

test("a command spawned runs to its end with its output, and a failure shows its last lines", async () => {
  expect(await spawn([process.execPath, "-e", "console.log('out'); console.error('err'); process.exit(3)"], { cwd: import.meta.dir, env: { EXTRA: "1" } })).toEqual({ code: 3, output: "out\nerr\n" })
  expect(tail("a\nb\nc\n\n", 2)).toBe("b\nc")
})
