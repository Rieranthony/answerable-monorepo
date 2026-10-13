import { describe, expect, test } from "bun:test"
import { commandLine, systemRunner } from "./run"

describe("systemRunner", () => {
  test("captures output, passes input and added variables, and streams to onOutput", async () => {
    const seen: string[] = []
    const result = await systemRunner(["sh", "-c", 'cat; printf " %s" "$ADDED"; printf oops >&2'], {
      input: "in",
      env: { ADDED: "yes" },
      onOutput: (text) => seen.push(text),
    })
    expect(result).toEqual({ exitCode: 0, stdout: "in yes", stderr: "oops" })
    expect(seen.join("")).toContain("in yes")
  })

  test("closes standard input when there is none, and runs in the given directory", async () => {
    const result = await systemRunner(["sh", "-c", "cat; pwd"], { cwd: "/" })
    expect(result.stdout).toBe("/\n")
  })

  test("hands the terminal over for an interactive command and captures nothing", async () => {
    expect(await systemRunner(["sh", "-c", "exit 3"], { interactive: true })).toEqual({ exitCode: 3, stdout: "", stderr: "" })
  })

  test("kills a command that runs too long", async () => {
    const result = await systemRunner(["sleep", "5"], { timeoutMs: 50 })
    expect(result.exitCode).not.toBe(0)
  })

  test("answers 127 for a program that does not exist", async () => {
    const result = await systemRunner(["answerable-no-such-program"])
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toStartWith("answerable-no-such-program: ")
  })
})

test("commandLine quotes what a shell would split", () => {
  expect(commandLine(["gh", "secret", "set", "A B", "it's"])).toBe("gh secret set 'A B' 'it'\\''s'")
})
