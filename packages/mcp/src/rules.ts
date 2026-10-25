/**
 * Check a provider id, which is also an MCP's name: a lowercase letter, then up to 11 lowercase letters or digits. Returns what is wrong, to follow
 * the subject, or `undefined`.
 *
 * @example
 * ```ts
 * checkProviderId("Acme") // '"Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme'
 * ```
 */
export function checkProviderId(id: string): string | undefined {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(id)) return `"${id}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`
}

/**
 * Check a tool's or a mutation's name: `<domain>.<operation>`, each part a lowercase letter, then up to 15 lowercase letters or digits. Returns what
 * is wrong, to follow the subject, or `undefined`.
 *
 * @example
 * ```ts
 * checkToolName("notes") // '"notes" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list'
 * ```
 */
export function checkToolName(name: string): string | undefined {
  if (!/^[a-z][a-z0-9]{0,15}\.[a-z][a-z0-9]{0,15}$/.test(name)) {
    return `"${name}" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list`
  }
}

/**
 * Check a description, a provider's, a tool's or a mutation's: 40 to 1,000 characters. Returns what is wrong, to follow the word "description",
 * or `undefined`.
 *
 * @example
 * ```ts
 * checkDescription("Gets notes.") // "is 11 characters; write 40 to 1,000 saying what it does, when to use it and its limits"
 * ```
 */
export function checkDescription(description: string): string | undefined {
  const { length } = description
  if (length < 40 || length > 1000) return `is ${length} characters; write 40 to 1,000 saying what it does, when to use it and its limits`
}

/**
 * Check a mutation's description for what the conformance kit's `descriptions_operational` requires: that it says the mutation prepares an
 * intent, with the word "prepare" or "intent". Returns what is wrong, to follow "a mutation's description", or `undefined`.
 *
 * @example
 * ```ts
 * checkMutationDescription("Add a note to your organisation's notes.") // 'must say that it prepares an intent; use the word "prepare" or "intent"'
 * ```
 */
export function checkMutationDescription(description: string): string | undefined {
  if (!/prepare|intent/i.test(description)) return 'must say that it prepares an intent; use the word "prepare" or "intent"'
}
