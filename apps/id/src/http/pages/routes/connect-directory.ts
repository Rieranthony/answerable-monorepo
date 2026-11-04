import type { Hono } from "hono";
import { jsx } from "hono/jsx";

import {
  connectDirectoryAccount,
  findDirectoryConnection,
} from "../../../auth/directory-connection.ts";
import type { RefusedIdentity } from "../../../auth/refused-identity.ts";
import { createClientBudget } from "../../../lib/client-budget.ts";
import { logEvent } from "../../../lib/log.ts";
import { attemptMagicLinkCode } from "../../../services/magic-link-codes.ts";
import type { AppEnvironment } from "../../context.ts";
import { errorFields } from "../../problem.ts";
import { describeError } from "../error-copy.ts";
import {
  applyCookies,
  isOwnOriginPost,
  serviceOrigin,
  type PageContext,
} from "../gateway.ts";
import { pendingOfErrorPage } from "../login-routing.ts";
import {
  holdSignInCookie,
  readSignInCookie,
  signInCookieValue,
} from "../sign-in-cookie.ts";
import {
  ConnectDirectory,
  Connected,
  NoConnection,
} from "../views/connect-directory.tsx";
import { resumableQuery, startSignIn } from "./login.ts";
import { codePattern, logFailure, whoAsked } from "./magic-link.ts";

const page = "/connect-directory";

/**
 * A verified directory sign-in refused for an address someone here already holds. Where a code
 * from that mailbox could connect the two, store the identity against this browser, mail the
 * code and ask for it; no session exists. A person may reach the callback with no sign-in cookie,
 * so it is set here. The callback is a GET, which `SameSite=Lax` lets through on a directory's
 * redirect. Null leaves the refusal as it was.
 */
export async function askMailboxToConnect(
  context: PageContext,
  refusal: Response,
  identity: RefusedIdentity,
) {
  const requests = context.get("magicLinks");
  if (!requests) return null;
  const browser = signInCookieValue(context);
  const carried = new URL(refusal.headers.get("location")!, context.req.url)
    .searchParams;
  try {
    const answer = await requests.connectDirectory({
      identity,
      browser,
      client: context.get("clientIp") ?? "unresolved",
      pendingQuery: await resumableQuery(context, pendingOfErrorPage(carried)),
    });
    if (answer === "conflict") return null;
  } catch (error) {
    logEvent("magic link", "magic_link_job_failed", errorFields(error));
    return null;
  }
  holdSignInCookie(context, browser);
  applyCookies(context, refusal.headers.getSetCookie());
  return context.redirect(page, 303);
}

const renderNoConnection = (context: PageContext) =>
  context.render(
    jsx(NoConnection, {
      description: describeError("connect_directory_unavailable"),
    }),
    { title: "Sign in" },
  );

/**
 * The right code connected the account, and only a directory sign-in makes a session. Should that
 * not start, the account stays connected and the sign-in page gets the person there.
 */
async function signInThroughDirectory(
  context: PageContext,
  {
    organizationSlug,
    email,
    pendingQuery,
  }: { organizationSlug: string; email: string; pendingQuery: string | null },
) {
  const pending = await resumableQuery(context, pendingQuery);
  const query = pending ? `?${pending}` : "";
  try {
    const result = await startSignIn(
      context,
      { organizationSlug, loginHint: email },
      `${serviceOrigin(context)}/login${query}`,
      context.req.header("origin") ?? null,
      pending,
    );
    if (result.ok && result.data?.url)
      return context.redirect(result.data.url, 303);
  } catch {
    /* startSignIn's call has logged it. */
  }
  return context.render(jsx(Connected, { query }), { title: "Sign in" });
}

export function registerConnectDirectory(app: Hono<AppEnvironment>) {
  // 60 per 10 s per client, as on `POST /magic-link/code`, and refused alike.
  const budget = createClientBudget({ max: 60, windowMs: 10_000 });
  const renderRefused = (context: PageContext) =>
    context.render(
      jsx(ConnectDirectory, {
        message: describeError("connect_directory_code_refused"),
      }),
      { title: "Sign in" },
    );

  // Nothing here reads a URL or a form: a browser with no stored proof gets nothing at all.
  app.get(page, async (context) => {
    const browser = readSignInCookie(context);
    if (browser) {
      try {
        const row = await findDirectoryConnection(context.get("db"), browser);
        if (row) {
          const query = await resumableQuery(context, row.pendingOauthQuery);
          return context.render(
            jsx(ConnectDirectory, { email: row.email, query: query ?? "" }),
            { title: "Sign in" },
          );
        }
      } catch (error) {
        logFailure(context, page, error);
      }
    }
    return renderNoConnection(context);
  });

  app.post(page, async (context) => {
    if (!isOwnOriginPost(context)) {
      context.status(403);
      return renderRefused(context);
    }
    if (!budget.take(context.get("clientIp") ?? "unresolved"))
      return renderRefused(context);
    const body = await context.req.parseBody();
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const browser = readSignInCookie(context);
    // Not a code, or no browser to hold one: this counts for nothing and answers alike.
    if (!browser || !codePattern.test(code)) return renderRefused(context);
    try {
      const row = await attemptMagicLinkCode(
        context.get("db"),
        context.get("environment"),
        {
          browser,
          client: context.get("clientIp") ?? "unresolved",
          code,
          purpose: "connect_directory",
        },
        whoAsked(context),
      );
      if (row) {
        const connected = await connectDirectoryAccount(
          context.get("db"),
          row,
          whoAsked(context),
        );
        if (connected) return await signInThroughDirectory(context, connected);
        return context.render(
          jsx(NoConnection, {
            description: describeError("connect_directory_refused"),
          }),
          { title: "Sign in" },
        );
      }
    } catch (error) {
      logFailure(context, page, error);
    }
    return renderRefused(context);
  });
}
