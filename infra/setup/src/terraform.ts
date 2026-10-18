import { join } from "node:path"
import { exists, type Context } from "./context"
import { SetupError, UsageError } from "./errors"
import { commandLine } from "./run"

/** The state bucket's credential, under the names the operator exports and the GitHub environments hold. */
export type StateEnv = { STATE_ACCESS_KEY_ID: string; STATE_SECRET_ACCESS_KEY: string }

/**
 * The state bucket's credential from the operator's environment. Once `first-apply` has moved the state into the
 * bucket, every command that reads Terraform's outputs needs it.
 */
export function stateEnv(env: Context["env"]): StateEnv {
  const id = env.STATE_ACCESS_KEY_ID?.trim()
  const secret = env.STATE_SECRET_ACCESS_KEY?.trim()
  if (!id || !secret)
    throw new UsageError(
      "STATE_ACCESS_KEY_ID and STATE_SECRET_ACCESS_KEY must hold the Terraform state bucket's credential: first-apply " +
        "printed the key ID, and `civo objectstore credential secret -a <key id>` (or the Civo dashboard, Object stores > " +
        "Credentials) shows the secret. Keep both where you keep CIVO_TOKEN",
    )
  return { STATE_ACCESS_KEY_ID: id, STATE_SECRET_ACCESS_KEY: secret }
}

/**
 * The credential as Terraform's S3 backend reads it, for Terraform's own environment and nothing else. The backend
 * takes a credential from these two fixed names or from `-backend-config`, which would write it into `.terraform/`
 * and into plan files. `infra/civo/terraform.sh` does the same for the workflows and for Terraform run by hand.
 */
export function backendEnv(state: StateEnv): Record<string, string> {
  return { AWS_ACCESS_KEY_ID: state.STATE_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: state.STATE_SECRET_ACCESS_KEY }
}

/** Initialise the Terraform root on this machine when it has not been: the outputs are read through its backend. */
async function ensureInitialised(context: Context, envDir: string, state: StateEnv): Promise<void> {
  if (await exists(join(envDir, ".terraform/terraform.tfstate"))) return
  const argv = ["terraform", "init", "-input=false"]
  context.out(`$ ${commandLine(argv)}\n`)
  const result = await context.run(argv, { cwd: envDir, env: backendEnv(state), onOutput: context.out })
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
  const result = await context.run(argv, { cwd: envDir, env: backendEnv(state) })
  if (result.exitCode !== 0)
    throw new SetupError(`terraform output ${name} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
  if (!result.stdout.trim()) throw new SetupError(`terraform output ${name} is empty: has the environment been applied?`)
  return result.stdout
}
