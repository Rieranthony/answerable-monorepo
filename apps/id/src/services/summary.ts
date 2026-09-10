import { type PlatformReadContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/summary.ts";
import { classifyIssuer } from "./federation.ts";

export async function getPlatformSummary(context: PlatformReadContext) {
  const now = new Date();
  const [summary, { succeeded, rejected, rejectedByReason }] =
    await Promise.all([
      queries.platformSummary(context, {
        now,
      }),
      queries.platformSignInStats(context, {
        since: new Date(now.getTime() - 86_400_000),
      }),
    ]);
  return { ...summary, signIns24h: { succeeded, rejected, rejectedByReason } };
}

export async function getOrganizationSummary(
  context: TenantReadContext<"directory">,
) {
  const now = new Date();
  const { provider, organization, ...summary } =
    await queries.organizationSummary(context, { now });
  const { succeeded, lastSucceededAt } = await queries.organizationSignInStats(
    context,
    {
      since: new Date(now.getTime() - 7 * 86_400_000),
    },
  );
  return {
    // The context holds a shared lock on this existing organisation.
    organization: organization!,
    ...summary,
    ssoProvider: {
      configured: provider !== null,
      kind: provider ? classifyIssuer(provider.issuer).kind : null,
      issuer: provider?.issuer ?? null,
    },
    signIns7d: { succeeded, lastSucceededAt },
  };
}
