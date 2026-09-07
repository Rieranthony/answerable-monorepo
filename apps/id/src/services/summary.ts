import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/summary.ts";
import type { Environment } from "../env.ts";
import { ProblemError } from "../http/problem.ts";
import { classifyIssuer } from "./federation.ts";

export async function getPlatformSummary(
  db: Database,
  environment: Environment,
) {
  const now = new Date();
  const [summary, { succeeded, rejected, rejectedByReason }] =
    await Promise.all([
      queries.platformSummary(db, {
        platformOrganizationSlug: environment.platformOrganizationSlug,
        now,
      }),
      queries.signInStats(db, { since: new Date(now.getTime() - 86_400_000) }),
    ]);
  return { ...summary, signIns24h: { succeeded, rejected, rejectedByReason } };
}

export async function getOrganizationSummary(
  db: Database,
  organizationId: string,
) {
  const now = new Date();
  const { provider, organization, ...summary } =
    await queries.organizationSummary(db, organizationId, { now });
  if (!organization)
    throw new ProblemError(404, "not_found", "Organisation not found");
  const { succeeded, lastSucceededAt } = await queries.signInStats(db, {
    organizationId,
    since: new Date(now.getTime() - 7 * 86_400_000),
  });
  return {
    organization,
    ...summary,
    ssoProvider: {
      configured: provider !== null,
      kind: provider ? classifyIssuer(provider.issuer).kind : null,
      issuer: provider?.issuer ?? null,
    },
    signIns7d: { succeeded, lastSucceededAt },
  };
}
