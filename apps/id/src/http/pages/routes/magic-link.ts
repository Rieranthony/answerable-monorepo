import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { Hono } from "hono";
import { jsx } from "hono/jsx";

import { findLiveLinkRequest } from "../../../auth/magic-link-confirm.ts";
import { createClientBudget } from "../../../lib/client-budget.ts";
import { logEvent } from "../../../lib/log.ts";
import { attemptMagicLinkCode } from "../../../services/magic-link-codes.ts";
import type { AppEnvironment } from "../../context.ts";
import { errorFields } from "../../problem.ts";
import { describeError } from "../error-copy.ts";
import {
  applyCookies,
  authCallHeaders,
  isOwnOriginPost,
  serviceOrigin,
  type PageContext,
} from "../gateway.ts";
import { readSignInCookie } from "../sign-in-cookie.ts";
import { ErrorView } from "../views/error.tsx";
import {
  CodeRefused,
  ContinueWithLink,
  LinkElsewhere,
} from "../views/magic-link.tsx";

/** A token is 32 letters; nothing much longer can be one. */
const maxTokenLength = 128;
const codePattern = /^\d{8}$/;

const renderElsewhere = (context: PageContext) =>
  context.render(jsx(LinkElsewhere, {}), { title: "Sign in" });

const renderCodeRefused = (context: PageContext) =>
  context.render(
    jsx(CodeRefused, {
      query: new URL(context.req.url).searchParams.toString(),
    }),
    { title: "Sign in" },
  );

const renderRemoved = (context: PageContext) =>
  context.render(
    jsx(ErrorView, {
      description: describeError("magic_link_access_removed"),
      details: null,
    }),
    { title: "Can't sign in" },
  );

const whoAsked = (context: PageContext) => ({
  requestId: context.get("requestId"),
  ip: context.get("clientIp"),
  userAgent: context.req.header("user-agent") ?? null,
});

/** The pages answer with the same words; this keeps a failure visible to operators. */
function logFailure(context: PageContext, path: string, error: unknown) {
  logEvent("page", "page_auth_call_failed", {
    requestId: context.get("requestId"),
    path,
    ...errorFields(error),
  });
}

/**
 * Sign in on a request this browser holds, in process. A signed query that has since expired
 * is left out, so a link that outlives its authorisation signs in and lands on `/login`.
 * Better Auth's provider resumes the rest through its after-hook, which needs a request.
 */
async function confirm(
  context: PageContext,
  row: {
    tokenIdentifier: string | null;
    pendingOauthQuery: string | null;
  },
  browser: string,
  proof: "link" | "code",
) {
  const auth = context.get("auth");
  const { secret } = await auth.$context;
  const pending =
    row.pendingOauthQuery !== null &&
    (await verifyOAuthQueryParams(row.pendingOauthQuery, secret))
      ? row.pendingOauthQuery
      : undefined;
  const headers = authCallHeaders(context);
  const response = await auth.api.confirmMagicLink({
    request: new Request(`${serviceOrigin(context)}/auth/magic-link/confirm`, {
      method: "POST",
      headers,
    }),
    headers,
    body: {
      identifier: row.tokenIdentifier!,
      browser,
      proof,
      ...(pending ? { oauth_query: pending } : {}),
    },
    asResponse: true,
  });
  const setCookies = response.headers.getSetCookie();
  applyCookies(context, setCookies);
  const data = (await response.json()) as {
    url?: string;
    refused?: "removed" | "invalid";
  };
  // The session is committed by the time the provider resumes, so a resume that failed still
  // signed the person in.
  if (data.url) return context.redirect(data.url, 303);
  if (setCookies.length > 0) return context.redirect("/login", 303);
  return data.refused === "removed" ? renderRemoved(context) : null;
}

export function registerMagicLink(app: Hono<AppEnvironment>) {
  // 60 per 10 s per client, as on `POST /login`. Over it these two answer as they answer a
  // refusal, with no database work: what a flood costs is the point, and neither says why.
  const budget = createClientBudget({ max: 60, windowMs: 10_000 });
  const withinBudget = (context: PageContext) =>
    budget.take(context.get("clientIp") ?? "unresolved");

  // Scanners fetch links: GET and HEAD consume nothing and count nothing, for anyone.
  app.get("/magic-link", async (context) => {
    const token = context.req.query("token");
    const browser = readSignInCookie(context);
    if (!token || token.length > maxTokenLength || !browser)
      return renderElsewhere(context);
    try {
      const row = await findLiveLinkRequest(context.get("db"), token, browser);
      if (row)
        return context.render(
          jsx(ContinueWithLink, { email: row.email, token }),
          {
            title: "Sign in",
          },
        );
    } catch (error) {
      logFailure(context, "/magic-link", error);
    }
    return renderElsewhere(context);
  });

  app.post("/magic-link", async (context) => {
    if (!isOwnOriginPost(context)) {
      context.status(403);
      return renderElsewhere(context);
    }
    if (!withinBudget(context)) return renderElsewhere(context);
    const body = await context.req.parseBody();
    const browser = readSignInCookie(context);
    if (
      typeof body.token !== "string" ||
      !body.token ||
      body.token.length > maxTokenLength ||
      !browser
    )
      return renderElsewhere(context);
    try {
      // A form-filling scanner has no cookie, so it finds nothing and cannot burn the link.
      const row = await findLiveLinkRequest(
        context.get("db"),
        body.token,
        browser,
      );
      if (row) {
        const answer = await confirm(context, row, browser, "link");
        if (answer) return answer;
      }
    } catch (error) {
      logFailure(context, "/magic-link", error);
    }
    return renderElsewhere(context);
  });

  app.post("/magic-link/code", async (context) => {
    if (!isOwnOriginPost(context)) {
      context.status(403);
      return renderCodeRefused(context);
    }
    if (!withinBudget(context)) return renderCodeRefused(context);
    const body = await context.req.parseBody();
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const browser = readSignInCookie(context);
    // Not a code, or no browser to hold one: this counts for nothing and answers alike.
    if (!browser || !codePattern.test(code)) return renderCodeRefused(context);
    try {
      const row = await attemptMagicLinkCode(
        context.get("db"),
        context.get("environment"),
        {
          browser,
          client: context.get("clientIp") ?? "unresolved",
          code,
        },
        whoAsked(context),
      );
      if (row) {
        const answer = await confirm(context, row, browser, "code");
        if (answer) return answer;
      }
    } catch (error) {
      logFailure(context, "/magic-link/code", error);
    }
    return renderCodeRefused(context);
  });
}
