import { exists, type Context } from "./context"
import { shown, type Paths } from "./environments"
import { SetupError } from "./errors"
import { commandLine } from "./run"

/** `sops`'s own arguments: the configuration this command was told to use, never one found by searching upwards. */
function sops(paths: Paths, ...argv: string[]): string[] {
  return ["sops", "--config", paths.sopsConfig, ...argv]
}

/** The environment's key for `sops`, when its file is where `age-init` puts it; otherwise `sops` finds one itself. */
async function keyEnv(paths: Paths): Promise<Record<string, string>> {
  return (await exists(paths.keyFile)) ? { SOPS_AGE_KEY_FILE: paths.keyFile } : {}
}

/** Encrypt a YAML document under the creation rule of the environment's Secrets file. Answers the encrypted text. */
export async function encrypt(context: Context, paths: Paths, plaintext: string): Promise<string> {
  if (!(await exists(paths.sopsConfig)))
    throw new SetupError(`${shown(paths, paths.sopsConfig)} does not exist: run age-init first`)
  const argv = sops(paths, "encrypt", "--filename-override", paths.secretsFile)
  context.out(`$ ${commandLine(argv)} < (the Secrets, from memory)\n`)
  const result = await context.run(argv, { input: plaintext })
  if (result.exitCode !== 0 || !result.stdout.includes("sops:"))
    throw new SetupError(`sops could not encrypt (exit ${result.exitCode}): ${result.stderr.trim()}`)
  return result.stdout
}

/** Decrypt the environment's Secrets file into memory. */
export async function decrypt(context: Context, paths: Paths): Promise<string> {
  const argv = sops(paths, "decrypt", paths.secretsFile)
  context.out(`$ ${commandLine(argv)}\n`)
  const result = await context.run(argv, { env: await keyEnv(paths) })
  if (result.exitCode !== 0)
    throw new SetupError(
      `sops could not decrypt ${shown(paths, paths.secretsFile)} (exit ${result.exitCode}): ${result.stderr.trim()}. ` +
        `Its key is ${paths.keyFile}, or SOPS_AGE_KEY`,
    )
  return result.stdout
}
