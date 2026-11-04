/**
 * Fixed windows, one per key, in this process: replicas multiply them. A key's window starts at
 * its first request and ends a set time later, however often it was used, so a limit means what
 * it says. At most `maxKeys` are held. A new one past that replaces the oldest, which costs a
 * key the rest of its count and never costs memory.
 */
function createFixedWindows(maxKeys: number, now: () => number) {
  // A Map keeps insertion order, and a new window always goes in last: the first is the oldest.
  const windows = new Map<string, { startedAt: number; count: number }>();
  return {
    /** Count this request: whether it is within `max`, and how long its window has left. */
    take(key: string, max: number, windowMs: number) {
      const time = now();
      let current = windows.get(key);
      if (!current || time - current.startedAt >= windowMs) {
        windows.delete(key);
        if (windows.size >= maxKeys)
          windows.delete(windows.keys().next().value!);
        current = { startedAt: time, count: 0 };
        windows.set(key, current);
      }
      current.count++;
      return {
        allowed: current.count <= max,
        leftMs: current.startedAt + windowMs - time,
      };
    },
    /** How many keys it holds a window for. */
    get size() {
      return windows.size;
    },
  };
}

/** How many requests one client address may make in a window, in this process. */
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
  const windows = createFixedWindows(maxClients, now);
  return {
    /** Count this request, and say whether it is within the budget. */
    take: (client: string) => windows.take(client, max, windowMs).allowed,
    /** How many clients it holds a window for. */
    get size() {
      return windows.size;
    },
  };
}

/**
 * Better Auth's `rateLimit.customStorage`, on the same windows. Better Auth's own store resets a
 * count only after a full window with no request, so a steady rate well under a rule trips it
 * (measured: 60 per 10 s refused 20% of 2 requests a second). A key names a client and a path,
 * so more are held than for one budget: as many as Better Auth's own store holds.
 */
export function createRateLimitStorage({
  maxKeys = 100_000,
  now = Date.now,
}: { maxKeys?: number; now?: () => number } = {}) {
  const windows = createFixedWindows(maxKeys, now);
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const { allowed, leftMs } = windows.take(
        key,
        rule.max,
        rule.window * 1_000,
      );
      return {
        allowed,
        retryAfter: allowed ? null : Math.ceil(leftMs / 1_000),
      };
    },
    /** How many keys it holds a window for. */
    get size() {
      return windows.size;
    },
  };
}
