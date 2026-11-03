/**
 * How many requests one client address may make in a window, in this process: replicas
 * multiply it, as they do Better Auth's, and it is not a volumetric defence. At most
 * `maxClients` windows are held. A new one past that replaces the oldest, which costs a
 * client the rest of its count and never costs memory.
 */
export function createClientBudget({
  max,
  windowMs,
  maxClients = 10_000,
  now = Date.now,
}: {
  max: number;
  windowMs: number;
  maxClients?: number;
  now?: () => number;
}) {
  // A Map keeps insertion order, and a new window always goes in last: the first is the oldest.
  const windows = new Map<string, { startedAt: number; count: number }>();
  return {
    /** Count this request, and say whether it is within the budget. */
    take(client: string) {
      const time = now();
      let current = windows.get(client);
      if (!current || time - current.startedAt >= windowMs) {
        windows.delete(client);
        if (windows.size >= maxClients)
          windows.delete(windows.keys().next().value!);
        current = { startedAt: time, count: 0 };
        windows.set(client, current);
      }
      current.count++;
      return current.count <= max;
    },
    /** How many clients it holds a window for. */
    get size() {
      return windows.size;
    },
  };
}
