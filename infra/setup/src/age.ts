import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { exists, type Context } from "./context"
import type { EnvironmentName, Paths } from "./environments"
import { shown } from "./environments"
import { SetupError } from "./errors"
import { commandLine } from "./run"

/** The `path_regex` of an environment's creation rule: its encrypted Secrets file and nothing else. */
export function ruleRegex(environment: EnvironmentName): string {
  return `infra/civo/envs/${environment}/secrets\\.enc\\.yaml$`
}

/**
 * What `sops` encrypts in the Secrets file: the values under `data` and `stringData` only, so that `metadata.name` and
 * the keys stay readable and a reviewer sees which Secret and which key changed. The MAC still covers every value.
 */
export const ENCRYPTED_REGEX = "^(data|stringData)$"

const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/

type Rule = Record<string, unknown>
type SopsConfig = { rules: Rule[]; rest: Record<string, unknown> }

function parseConfig(text: string, path: string): SopsConfig {
  let parsed: unknown
  try {
    parsed = text.trim() ? Bun.YAML.parse(text) : {}
  } catch (error) {
    throw new SetupError(`${path} is not YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new SetupError(`${path} must be a mapping with creation_rules`)
  const { creation_rules: rules = [], ...rest } = parsed as Record<string, unknown>
  if (!Array.isArray(rules) || !rules.every((rule) => rule !== null && typeof rule === "object" && !Array.isArray(rule)))
    throw new SetupError(`${path}: creation_rules must be a list of rules`)
  return { rules: rules as Rule[], rest }
}

// A string that YAML reads back unchanged without quotes; anything else is written as JSON, which YAML also reads.
function scalar(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][\w./\\$-]*$/.test(value) ? value : JSON.stringify(value)
}

/** `.sops.yaml` as this command writes it: a comment, the other top-level keys, then one rule per environment. */
export function formatConfig(config: SopsConfig): string {
  const lines = [
    "# sops' creation rules: each environment's Secrets file is encrypted to that environment's age recipient (D23).",
    "# Written by `bun run setup age-init` (infra/setup/README.md). The first rule that matches a path wins.",
  ]
  for (const [key, value] of Object.entries(config.rest)) lines.push(`${key}: ${JSON.stringify(value)}`)
  lines.push("creation_rules:")
  for (const rule of config.rules) {
    const entries = Object.entries(rule)
    entries.forEach(([key, value], index) => lines.push(`${index === 0 ? "  - " : "    "}${key}: ${scalar(value)}`))
  }
  return `${lines.join("\n")}\n`
}

/** What `age-init` does. */
export type AgeInitOptions = { environment: EnvironmentName; paths: Paths; force?: boolean }

/**
 * Give an environment its `age` key pair and its creation rule in `.sops.yaml`. The key is created with `age-keygen`
 * only when its file is absent (mode 0600); the private key is never read into this process or printed.
 */
export async function ageInit(options: AgeInitOptions, context: Context): Promise<void> {
  const { paths, environment } = options
  const keyShown = shown(paths, paths.keyFile)
  if (await exists(paths.keyFile)) {
    const mode = (await stat(paths.keyFile)).mode & 0o777
    context.out(`Using the existing key ${keyShown}.\n`)
    if (mode & 0o077)
      context.out(`Warning: ${keyShown} can be read by other users of this machine (mode ${mode.toString(8)}); run chmod 600 on it.\n`)
  } else {
    await mkdir(dirname(paths.keyFile), { recursive: true, mode: 0o700 })
    const argv = ["age-keygen", "-o", paths.keyFile]
    context.out(`$ ${commandLine(argv)}\n`)
    const created = await context.run(argv)
    if (created.exitCode !== 0) throw new SetupError(`age-keygen failed with exit code ${created.exitCode}: ${created.stderr.trim()}`)
    await chmod(paths.keyFile, 0o600)
    context.out(`Created ${keyShown} (mode 600).\n`)
  }

  const read = await context.run(["age-keygen", "-y", paths.keyFile])
  const recipient = read.stdout.trim()
  if (read.exitCode !== 0 || !RECIPIENT.test(recipient))
    throw new SetupError(`age-keygen -y could not read a recipient from ${keyShown} (exit ${read.exitCode}): ${read.stderr.trim()}`)

  const configShown = shown(paths, paths.sopsConfig)
  const config = (await exists(paths.sopsConfig))
    ? parseConfig(await readFile(paths.sopsConfig, "utf8"), configShown)
    : { rules: [], rest: {} }
  const regex = ruleRegex(environment)
  const rule = config.rules.find((candidate) => candidate.path_regex === regex)
  const otherKey = rule !== undefined && rule.age !== recipient
  if (otherKey && !options.force)
    throw new SetupError(
      `${configShown} encrypts ${environment} to another recipient (${String(rule.age)}), not to ${keyShown}. ` +
        "Files encrypted to it stay readable only with its key. Run again with --force to switch the rule to this key, " +
        "then re-encrypt the environment's file with `sops updatekeys`",
    )
  if (!rule) {
    config.rules.push({ path_regex: regex, age: recipient, encrypted_regex: ENCRYPTED_REGEX })
    await writeFile(paths.sopsConfig, formatConfig(config))
    context.out(`Added the ${environment} rule in ${configShown}.\n`)
  } else if (!otherKey && rule.encrypted_regex === ENCRYPTED_REGEX) {
    context.out(`${configShown} already encrypts ${environment} to this key; unchanged.\n`)
  } else {
    const changes = [
      ...(otherKey ? ["switched it to this key"] : []),
      ...(rule.encrypted_regex === ENCRYPTED_REGEX ? [] : [`set encrypted_regex to ${ENCRYPTED_REGEX}`]),
    ]
    rule.age = recipient
    rule.encrypted_regex = ENCRYPTED_REGEX
    await writeFile(paths.sopsConfig, formatConfig(config))
    context.out(`Updated the ${environment} rule in ${configShown}: ${changes.join(" and ")}.\n`)
    if (await exists(paths.secretsFile))
      context.out(
        `${shown(paths, paths.secretsFile)} keeps the form it was encrypted in until it is encrypted again: ` +
          "init-secrets --rotate <key> re-encrypts it under this rule.\n",
      )
  }

  context.out(`
Recipient (public, committed in ${configShown}): ${recipient}
Private key: ${paths.keyFile}. It never leaves that file: keep a copy where you keep your own secrets,
because whoever holds it reads every secret of ${environment}. publish-env hands it to GitHub as SOPS_AGE_KEY.
Next: commit ${configShown}, then run first-apply.
`)
}
