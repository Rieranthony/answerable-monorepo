import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readOutput, stateEnv } from "./terraform"
import { createContext, createFakeRunner, createRoot } from "./testing"

const STATE = { AWS_ACCESS_KEY_ID: "key-id", AWS_SECRET_ACCESS_KEY: "state-secret" }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("stateEnv", () => {
  test("reads the state bucket's credential, or says where to find it", () => {
    expect(stateEnv({ AWS_ACCESS_KEY_ID: " key-id ", AWS_SECRET_ACCESS_KEY: "state-secret\n" })).toEqual(STATE)
    expect(() => stateEnv({ AWS_ACCESS_KEY_ID: "key-id" })).toThrow("civo objectstore credential secret -a <key id>")
    expect(() => stateEnv({})).toThrow("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
  })
})

describe("readOutput", () => {
  test("initialises the root once, then reads the output quietly with the state credential", async () => {
    const root = await createRoot({ "env/main.tf": "" })
    cleanups.push(root.remove)
    const envDir = join(root.path, "env")
    const runner = createFakeRunner(async (call) => {
      if (call.argv[1] === "init") {
        await Bun.write(join(envDir, ".terraform/terraform.tfstate"), "{}")
        return { stdout: "Terraform has been successfully initialized!\n" }
      }
      return { stdout: "postgres://admin:secret@10.0.0.5:5432/postgres" }
    })
    const { context, output } = createContext({ run: runner.run })
    expect(await readOutput(context, envDir, "database_admin_url", STATE)).toBe("postgres://admin:secret@10.0.0.5:5432/postgres")
    expect(await readOutput(context, envDir, "database_port", STATE)).toBe("postgres://admin:secret@10.0.0.5:5432/postgres")
    expect(runner.commands()).toEqual([
      "terraform init -input=false",
      "terraform output -raw database_admin_url",
      "terraform output -raw database_port",
    ])
    expect(runner.calls.every((call) => call.options.cwd === envDir && call.options.env === STATE)).toBe(true)
    expect(runner.calls[1]!.options.onOutput).toBeUndefined()
    expect(output()).toContain("successfully initialized")
    expect(output()).not.toContain("secret@")
  })

  test("fails when init or the output fails, or the output is empty", async () => {
    const root = await createRoot({ "env/.terraform/terraform.tfstate": "{}" })
    cleanups.push(root.remove)
    const envDir = join(root.path, "env")
    const failing = createFakeRunner(() => ({ exitCode: 1, stderr: "Error: Output not found\n" }))
    await expect(readOutput(createContext({ run: failing.run }).context, envDir, "x", STATE)).rejects.toThrow(
      "terraform output x failed with exit code 1: Error: Output not found",
    )
    const empty = createFakeRunner(() => ({ stdout: "\n" }))
    await expect(readOutput(createContext({ run: empty.run }).context, envDir, "x", STATE)).rejects.toThrow("terraform output x is empty")
    const fresh = join(root.path, "fresh")
    await expect(readOutput(createContext({ run: failing.run }).context, fresh, "x", STATE)).rejects.toThrow(
      "terraform init failed with exit code 1",
    )
  })
})
