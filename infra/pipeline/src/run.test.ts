import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { commandLine, systemRunner } from "./run"

const bun = process.execPath

describe("systemRunner", () => {
  test("captures output and the exit code of a command", async () => {
    const result = await systemRunner([bun, "-e", "console.log('out'); console.error('err'); process.exit(3)"])
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" })
  })

  test("streams output to the listener while it captures it", async () => {
    const heard: string[] = []
    const result = await systemRunner([bun, "-e", "console.log('one'); console.error('two')"], {
      onOutput: (text) => heard.push(text),
    })
    expect(heard.join("")).toContain("one\n")
    expect(heard.join("")).toContain("two\n")
    expect(result.stdout).toBe("one\n")
  })

  test("sends input to standard input without echoing it", async () => {
    const heard: string[] = []
    const result = await systemRunner([bun, "-e", "await Bun.stdin.text()"], {
      input: "secret value",
      onOutput: (text) => heard.push(text),
    })
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(heard).toEqual([])
    const echoed = await systemRunner([bun, "-e", "process.stdout.write((await Bun.stdin.text()).toUpperCase())"], {
      input: "secret value",
    })
    expect(echoed.stdout).toBe("SECRET VALUE")
  })

  test("adds variables to the environment and runs in the given directory", async () => {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/answerable-run-`))
    try {
      const result = await systemRunner(
        [bun, "-e", "process.stdout.write(process.env.PIPELINE_TEST_VARIABLE + '|' + process.cwd())"],
        { env: { PIPELINE_TEST_VARIABLE: "present" }, cwd: directory },
      )
      expect(result.stdout).toBe(`present|${directory}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reports a missing program as exit code 127 instead of throwing", async () => {
    const result = await systemRunner(["answerable-no-such-program", "--flag"])
    expect(result.exitCode).toBe(127)
    expect(result.stdout).toBe("")
    expect(result.stderr).toStartWith("answerable-no-such-program: ")
  })

  test("reports a working directory that does not exist the same way", async () => {
    const result = await systemRunner([bun, "-e", "0"], { cwd: "/answerable/no/such/directory" })
    expect(result.exitCode).toBe(127)
  })
})

describe("commandLine", () => {
  test("joins the arguments, quoting the ones that need it", () => {
    expect(commandLine(["helm", "upgrade", "--set", "a=b c", "plain"])).toBe("helm upgrade --set 'a=b c' plain")
  })

  test("escapes single quotes inside an argument", () => {
    expect(commandLine(["echo", "it's"])).toBe("echo 'it'\\''s'")
  })
})
