import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  accounts,
  grantContexts,
  sessions,
  ssoProviders,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

/** A session authenticated by the organisation's SSO provider, as a grant requires.
 * Creates the provider and the user's account with it when they are missing. */
export async function insertOriginSession(
  db: Executor,
  input: {
    userId: string;
    organizationId: string;
    id?: string;
    createdAt?: Date;
    expiresAt?: Date;
    upstreamAuthTime?: Date | null;
  },
) {
  let [provider] = await db
    .select()
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.organizationId, input.organizationId),
        isNull(ssoProviders.deletedAt),
      ),
    );
  if (!provider) {
    const name = createId();
    [provider] = await db
      .insert(ssoProviders)
      .values({
        id: createId(),
        organizationId: input.organizationId,
        issuer: `https://${name}.idp.example`,
        providerId: name,
        domain: `${name}.example`,
      })
      .returning();
  }
  let [account] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, input.userId),
        eq(accounts.issuer, provider!.issuer),
        eq(accounts.providerId, provider!.providerId),
        isNull(accounts.deletedAt),
      ),
    );
  if (!account)
    [account] = await db
      .insert(accounts)
      .values({
        id: createId(),
        userId: input.userId,
        issuer: provider!.issuer,
        providerId: provider!.providerId,
        accountId: createId(),
      })
      .returning();
  const createdAt = input.createdAt ?? new Date();
  const [session] = await db
    .insert(sessions)
    .values({
      id: input.id ?? createId(),
      userId: input.userId,
      token: createId(),
      createdAt,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
      authenticationOrganizationId: input.organizationId,
      authenticationProviderId: provider!.id,
      authenticationProviderRevision: provider!.revision,
      authenticationAccountId: account!.id,
      upstreamAuthTime: input.upstreamAuthTime ?? null,
    })
    .returning();
  return session!;
}

type GrantEvidence =
  | "authenticationAccountId"
  | "authenticationProviderId"
  | "authenticationProviderRevision"
  | "upstreamAuthTime";

/** Insert a grant whose authentication evidence copies its session's origin. */
export async function insertGrantContext(
  db: Executor,
  values: Omit<
    typeof grantContexts.$inferInsert,
    GrantEvidence | "authTime"
  > & {
    authTime?: Date;
  },
) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, values.authenticationSessionId));
  const [grant] = await db
    .insert(grantContexts)
    .values({
      ...values,
      authTime: values.authTime ?? session!.createdAt,
      authenticationAccountId: session!.authenticationAccountId!,
      authenticationProviderId: session!.authenticationProviderId!,
      authenticationProviderRevision: session!.authenticationProviderRevision!,
      upstreamAuthTime: session!.upstreamAuthTime,
    })
    .returning();
  return grant!;
}
