type PoolObservation = {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

function requestClass(path: string) {
  if (path === "/healthz") return "health";
  if (path === "/readyz") return "readiness";
  if (path === "/auth/oauth2/token") return "token";
  if (path.startsWith("/auth/")) return "authentication";
  if (path.startsWith("/api/admin/")) return "admin";
  if (path.startsWith("/.well-known/")) return "metadata";
  return "other";
}

/** Fixed route classes and HTTP statuses only. No request-derived labels or event buffer. */
export function createOperationalMetrics(pool: PoolObservation) {
  let active = 0,
    peakActive = 0,
    since = performance.now();
  const requests = new Map<
    string,
    {
      route: string;
      status: number;
      count: number;
      totalMs: number;
      maxMs: number;
    }
  >();
  return {
    begin(path: string) {
      const route = requestClass(path);
      const start = performance.now();
      active++;
      peakActive = Math.max(peakActive, active);
      return (status: number) => {
        active--;
        const key = `${route}:${status}`;
        const row = requests.get(key) ?? {
          route,
          status,
          count: 0,
          totalMs: 0,
          maxMs: 0,
        };
        const elapsed = performance.now() - start;
        row.count++;
        row.totalMs += elapsed;
        row.maxMs = Math.max(row.maxMs, elapsed);
        requests.set(key, row);
      };
    },
    snapshot() {
      const now = performance.now();
      const snapshot = {
        event: "operational_summary",
        windowMs: now - since,
        active,
        peakActive,
        pool: {
          total: pool.totalCount ?? 0,
          idle: pool.idleCount ?? 0,
          waiting: pool.waitingCount ?? 0,
        },
        requests: [...requests.values()],
      };
      since = now;
      peakActive = active;
      requests.clear();
      return snapshot;
    },
  };
}

export type OperationalMetrics = ReturnType<typeof createOperationalMetrics>;
