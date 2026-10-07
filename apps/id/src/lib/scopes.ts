/** Each scope once, in code-point order: the stored and compared form of a scope set. */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** The scopes named by an OAuth `scope` parameter; absent or blank names none. */
export function parseScope(value: string | null | undefined): string[] {
  return value?.split(" ").filter(Boolean) ?? [];
}
