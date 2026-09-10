/** Descriptive metadata only. Reject oversized/control/non-ASCII values, never truncate. */
export function boundedUserAgent(
  value: string | null | undefined,
): string | null {
  return value && /^[\x20-\x7e]{1,512}$/.test(value) ? value : null;
}
