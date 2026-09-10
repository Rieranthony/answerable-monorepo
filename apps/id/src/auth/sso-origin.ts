import { boundedUserAgent } from "../lib/user-agent.ts";
import type { SSOOptions } from "@better-auth/sso";
import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentAdapter, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { ssoProviders } from "../db/schema/index.ts";
import { resolveFederatedUser } from "../services/federation.ts";
import { authTransaction } from "./database-adapter.ts";

type SessionHooks = NonNullable<
  NonNullable<BetterAuthOptions["databaseHooks"]>["session"]
>;
type Origin = {
  authenticationOrganizationId: string;
  authenticationProviderId: string;
  authenticationProviderRevision: number;
};

/** Native SSO resolution and session creation share one transaction adapter.
 * The caller's request fields never supply authentication origin.
 */
export function createSsoOriginBoundary() {
  const origins = new WeakMap<object, Origin>();
  const requests = new AsyncLocalStorage<Map<string, number>>();
  function run<T>(work: () => T): T {
    return requests.run(new Map(), work);
  }
  function observeProvider(row: unknown) {
    const request = requests.getStore();
    if (!request || !row || typeof row !== "object") return;
    const provider = row as { id?: unknown; revision?: unknown };
    if (
      typeof provider.id !== "string" ||
      typeof provider.revision !== "number"
    )
      return;
    if (!request.has(provider.id)) request.set(provider.id, provider.revision);
  }
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
      .where(eq(ssoProviders.providerId, input.providerId));
    if (!provider)
      throw new Error("Accepted SSO provider is no longer available");
    if (
      requests.getStore()?.get(provider.authenticationProviderId) !==
      provider.authenticationProviderRevision
    )
      return {
        action: "reject",
        code: "SSO_PROVIDER_CHANGED",
        message: "SSO configuration changed. Start sign-in again.",
      };
    const resolution = await resolveFederatedUser(input, database);
    if (resolution.action === "reject") return resolution;
    origins.set(database, provider);
    return resolution;
  };
  const before: NonNullable<
    NonNullable<SessionHooks["create"]>["before"]
  > = async (session, context) => {
    const adapter = context
      ? await getCurrentAdapter(context.context.adapter)
      : undefined;
    const origin = adapter ? origins.get(adapter) : undefined;
    if (origin) authTransaction(adapter!);
    if (adapter) origins.delete(adapter);
    if (context?.path === "/sso/callback" && !origin)
      throw new APIError("FORBIDDEN", {
        code: "authentication_origin_missing",
      });
    return {
      data: {
        ...session,
        // Header-derived addresses and the provider's development fallback are
        // not verified transport evidence.
        ipAddress: null,
        userAgent: boundedUserAgent(session.userAgent),
        authenticationOrganizationId:
          origin?.authenticationOrganizationId ?? null,
        authenticationProviderId: origin?.authenticationProviderId ?? null,
        authenticationProviderRevision:
          origin?.authenticationProviderRevision ?? null,
      },
    };
  };
  return { resolveUser, before, run, observeProvider };
}
