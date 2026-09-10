import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import {
  getOAuthProviderApi,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";

type Context = Parameters<typeof getOAuthProviderApi>[0];
type Adapter = Context["context"]["adapter"];
type Create = Adapter["create"];
type Authenticated = Awaited<
  ReturnType<ReturnType<typeof getOAuthProviderApi>["authenticateClient"]>
>;

/** Keep assertion consumption outside grant rollback while retaining native validation. */
export async function withNativeClientAuthentication<T>(
  ctx: Context,
  options: OAuthOptions<string[]>,
  grantType: "authorization_code" | "refresh_token",
  run: (
    authenticated: Authenticated,
    nativeCreate: (adapter: Pick<Adapter, "create">) => Create,
  ) => Promise<T>,
): Promise<T> {
  if (
    (await getCurrentDBAdapterAsyncLocalStorage()).getStore()
      ?.isTransactionActive
  )
    throw new Error("Client authentication requires autocommit");
  const consumed = new Map<string, unknown>();
  let active = true;
  const capture: Create = (async (input: Parameters<Create>[0]) => {
    const row = await ctx.context.adapter.create(input);
    if (input.model === "oauthClientAssertion")
      consumed.set(JSON.stringify(input), row);
    return row;
  }) as Create;
  try {
    const authenticated = await getOAuthProviderApi(
      {
        ...ctx,
        context: {
          ...ctx.context,
          adapter: { ...ctx.context.adapter, create: capture },
        },
      },
      options,
      grantType,
    ).authenticateClient({ requireCredentials: false });
    return await run(
      authenticated,
      (adapter) =>
        (async (input: Parameters<Create>[0]) => {
          if (!active)
            throw new Error("Client authentication context has expired");
          if (input.model !== "oauthClientAssertion")
            return adapter.create(input);
          // Native verification repeats against the same request and current client.
          // Acknowledge only its exact already-committed marker, once in this call.
          const key = JSON.stringify(input);
          if (!consumed.has(key))
            throw new APIError("BAD_REQUEST", { error: "invalid_client" });
          const row = consumed.get(key);
          consumed.delete(key);
          return row;
        }) as Create,
    );
  } finally {
    active = false;
    consumed.clear();
  }
}
