import { join } from "node:path"
import { exists, type Context } from "./context"
import { SetupError, UsageError } from "./errors"
import { commandLine } from "./run"

/** The state bucket's credential as the S3 backend reads it, for Terraform's environment only. */
export type StateEnv = { AWS_ACCESS_KEY_ID: string; AWS_SECRET_ACCESS_KEY: string }

/**
 * The state bucket's credential from the operator's environment. Once `first-apply` has moved the state into the
 * bucket, every command that reads Terraform's outputs needs it.
 */
export function stateEnv(env: Context["env"]): StateEnv {
  const id = env.AWS_ACCESS_KEY_ID?.trim()
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!id || !secret)
    throw new UsageError(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must hold the Terraform state bucket's credential: first-apply printed " +
        "the key ID, and `civo objectstore credential secret -a <key id>` (or the Civo dashboard, Object stores > " +
        "Credentials) shows the secret. Keep both where you keep CIVO_TOKEN",
    )
  return { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret }
}

/** Initialise the Terraform root on this machine when it has not been: the outputs are read through its backend. */
export async function ensureInitialised(context: Context, envDir: string, state: StateEnv): Promise<void> {
  if (await exists(join(envDir, ".terraform/terraform.tfstate"))) return
  const argv = ["terraform", "init", "-input=false"]
  context.out(`$ ${commandLine(argv)}\n`)
  const result = await context.run(argv, { cwd: envDir, env: state, onOutput: context.out })
  if (result.exitCode !== 0) throw new SetupError(`terraform init failed with exit code ${result.exitCode}`)
}

/**
 * One Terraform output, read with `terraform output -raw` into memory. The value is never printed, whether or not the
 * output is sensitive.
 */
export async function readOutput(context: Context, envDir: string, name: string, state: StateEnv): Promise<string> {
  await ensureInitialised(context, envDir, state)
  const argv = ["terraform", "output", "-raw", name]
  context.out(`$ ${commandLine(argv)}\n`)
  const result = await context.run(argv, { cwd: envDir, env: state })
  if (result.exitCode !== 0)
    throw new SetupError(`terraform output ${name} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
  if (!result.stdout.trim()) throw new SetupError(`terraform output ${name} is empty: has the environment been applied?`)
  return result.stdout
}
