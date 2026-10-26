// The repository's root .env, which bun mcp reads wherever it runs (Bun loads a .env from the working directory only) and bun mcp setup writes.
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { parseEnv } from "node:util"
import { ConfigError } from "@answerable/config"
import { mcpCliConfig } from "./config"
import { Refusal } from "./io"

/** The variables of the root `.env` with the process's own on top, as Bun gives a script run with `--env-file=.env`; an empty value counts as unset. */
async function readEnvironment(root: string, env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file = Bun.file(join(root, ".env"))
  const merged: Record<string, string | undefined> = { ...((await file.exists()) ? parseEnv(await file.text()) : {}), ...env }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => Boolean(entry[1])))
}

/**
 * Set variables in the root `.env`, each in place where a line already names it and appended otherwise, leaving every other line as it is; the file
 * is made readable by its owner only when this makes it. The values are written as they are: a client's id and secret and an organisation's slug,
 * which have no space, quote or `#`.
 */
export async function writeEnvironment(root: string, values: Record<string, string>) {
  const path = join(root, ".env")
  const file = Bun.file(path)
  const existed = await file.exists()
  const text = existed ? (await file.text()).replace(/\n$/, "") : ""
  const lines = text ? text.split("\n") : []
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex(line => line.startsWith(`${name}=`))
    if (index < 0) lines.push(`${name}=${value}`)
    else lines[index] = `${name}=${value}`
  }
  await Bun.write(path, `${lines.join("\n")}\n`)
  if (!existed) await chmod(path, 0o600)
}

/** bun mcp's configuration from the environment `readEnvironment` gives, with that environment; an invalid variable is refused naming it and the file to fix. */
export async function readSettings(root: string) {
  const env = await readEnvironment(root)
  try {
    return { env, settings: mcpCliConfig.read(env) }
  } catch (error) {
    throw error instanceof ConfigError ? new Refusal("invalid-configuration", `${error.message}; fix it in ${join(root, ".env")}`, "bun mcp setup") : error
  }
}
