import { recordAuditEvent } from "../db/queries/audit.ts";
import { createId } from "../lib/id.ts";
import { boundedUserAgent } from "../lib/user-agent.ts";
import type { SSOOptions } from "@better-auth/sso";
import { getCurrentAdapter, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { and, isNull, eq } from "drizzle-orm";
import { accounts, members, ssoProviders } from "../db/schema/index.ts";
import { resolveFederatedUser } from "../services/federation.ts";
import { authTransaction } from "./database-adapter.ts";
import type { VerifiedSso } from "./verified-sso.ts";

type SessionHooks = NonNullable<
  NonNullable<BetterAuthOptions["databaseHooks"]>["session"]
>;
type Origin = {
  authenticationOrganizationId: string;
  authenticationProviderId: string;
  authenticationProviderRevision: number;
  authenticationAccountId: string;
  upstreamAuthTime: Date | null;
  userId: string;
};

/** Native SSO resolution and session creation share one transaction adapter.
 * The caller's request fields never supply authentication origin.
 */
export function createSsoOriginBoundary(verifiedSso?: VerifiedSso) {
  const origins = new WeakMap<object, Origin>();
  const resolveUser: NonNullable<SSOOptions["resolveUser"]> = async (
    input,
    { database },
  ) => {
    const [provider] = await authTransaction(database)
      .select({
        authenticationOrganizationId: ssoProviders.organizationId,
        authenticationProviderId: ssoProviders.id,
        authenticationProviderRevision: ssoProviders.revision,
      })
      .from(ssoProviders)
      .where(
        and(
          isNull(ssoProviders.deletedAt),
          eq(ssoProviders.providerId, input.providerId),
        ),
      );
    if (!provider)
      throw new Error("Accepted SSO provider is no longer available");
    const authTime =
      input.protocol === "oidc"
        ? input.verifiedIdTokenClaims.auth_time
        : undefined;
    if (
      authTime !== undefined &&
      (typeof authTime !== "number" ||
        !Number.isSafeInteger(authTime) ||
        authTime < 0 ||
        authTime > Math.floor(Date.now() / 1000))
    )
      return {
        action: "reject",
        code: "invalid_auth_time",
        message: "Upstream authentication time is invalid",
      };
    const upstreamAuthTime =
      authTime === undefined ? null : new Date((authTime as number) * 1000);
    const resolution =
      (await verifiedSso?.resolve(input, database, upstreamAuthTime)) ??
      (await resolveFederatedUser(input, database));
    if (resolution.action === "reject") return resolution;
    // The resolver has established this exact verified issuer/subject binding.
    // Native authentication must select the same user when it creates a session.
    const [account] = await authTransaction(database)
      .select({ id: accounts.id, userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.issuer, input.accountKey.issuer),
          eq(accounts.accountId, input.accountKey.accountId),
          isNull(accounts.deletedAt),
        ),
      );
    if (!account)
      throw new Error("Accepted SSO account is no longer available");
    // A first sign-in or link to an organisation provisions an active membership
    // in this transaction, before the session. An existing row is left as it is;
    // federation and the verified flow have already refused an ineffective one.
    await authTransaction(database)
      .insert(members)
      .values({
        id: createId(),
        organizationId: provider.authenticationOrganizationId,
        userId: account.userId,
      })
      .onConflictDoNothing({
        target: [members.organizationId, members.userId],
      });
    origins.set(database, {
      ...provider,
      authenticationAccountId: account.id,
      userId: account.userId,
      upstreamAuthTime,
    });
    return resolution;
  };
  const before: NonNullable<
    NonNullable<SessionHooks["create"]>["before"]
  > = async (session, context) => {
    const adapter = context
      ? await getCurrentAdapter(context.context.adapter)
      : undefined;
    const origin = adapter ? origins.get(adapter) : undefined;
    if (origin) {
      const tx = authTransaction(adapter!);
      await verifiedSso?.beforeSession(tx, origin.upstreamAuthTime);
    }
    if (adapter) origins.delete(adapter);
    if (origin && origin.userId !== session.userId)
      throw new APIError("FORBIDDEN", {
        code: "authentication_origin_mismatch",
      });
    if (context?.path === "/sso/callback" && !origin)
      throw new APIError("FORBIDDEN", {
        code: "authentication_origin_missing",
      });
    const id = session.id ?? createId();
    if (origin) {
      // The native create.after hook is deferred until commit. Insert here using
      // the transaction and reserve the session ID before the adapter creates it.
      await recordAuditEvent(authTransaction(adapter!), {
        actorType: "user",
        actorId: session.userId,
        organizationId: origin.authenticationOrganizationId,
        action: "auth.signin.succeeded",
        targetType: "session",
        targetId: id,
        outcome: "success",
        requestId: context?.headers?.get("x-request-id") ?? null,
        ip: session.ipAddress,
        userAgent: boundedUserAgent(session.userAgent),
        data: {
          userId: session.userId,
          authenticationAccountId: origin.authenticationAccountId,
          authenticationProviderId: origin.authenticationProviderId,
          authenticationProviderRevision: origin.authenticationProviderRevision,
          upstreamAuthTime: origin.upstreamAuthTime?.toISOString() ?? null,
        },
      });
    }
    return {
      data: {
        ...session,
        id,
        userAgent: boundedUserAgent(session.userAgent),
        authenticationAccountId: origin?.authenticationAccountId ?? null,
        upstreamAuthTime: origin?.upstreamAuthTime ?? null,
        authenticationOrganizationId:
          origin?.authenticationOrganizationId ?? null,
        authenticationProviderId: origin?.authenticationProviderId ?? null,
        authenticationProviderRevision:
          origin?.authenticationProviderRevision ?? null,
      },
    };
  };
  return { resolveUser, before };
}
