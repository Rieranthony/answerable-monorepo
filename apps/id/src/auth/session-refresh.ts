import type { HookEndpointContext } from "@better-auth/core";
import type { BetterAuthPlugin } from "better-auth";
import {
  createAuthMiddleware,
  setShouldSkipSessionRefresh,
} from "better-auth/api";

/**
 * A session a day old is refreshed on any read, and the refresh sets the session cookie. The
 * OAuth provider's after-hook takes that cookie for a new sign-in whenever the request carries
 * an authorisation: it runs the authorisation again and replaces the response (measured: the
 * selection and consent pages failed, consent ended with no code, and a directory's refusal
 * became the old session's selection page). So those requests keep the session as it is. An
 * application's `/oauth2/authorize` and `/get-session` carry none, and they still slide it.
 * A sign-in's new session sets its cookie whatever this says, and that is what resumes.
 */
export function sessionRefreshBoundary() {
  return {
    id: "answerable-session-refresh",
    hooks: {
      before: [
        {
          matcher: (ctx: HookEndpointContext) =>
            !!ctx.body?.oauth_query || ctx.path === "/sso/callback",
          handler: createAuthMiddleware(async () => {
            await setShouldSkipSessionRefresh(true);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
