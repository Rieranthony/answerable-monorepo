import {
  findDomainSignInRoute,
  findOrganizationSignInRoute,
} from "../../../db/queries/organization-domains.ts";
import { classifyIssuer } from "../../../services/federation.ts";
import { createClientBudget } from "../../../lib/client-budget.ts";
import { DirectoryLogos } from "../views/directory-logos.tsx";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { Hono } from "hono";
import { jsx, type Child } from "hono/jsx";
import type { AppEnvironment } from "../../context.ts";
import {
  applyCookies,
  callAuth,
  isOwnOriginPost,
  readPageSession,
  serviceOrigin,
  type PageContext,
} from "../gateway.ts";
import {
  decideLoginRoute,
  isLoginAddress,
  maxLoginAddressLength,
  maxPendingQueryLength,
  pendingOAuthQuery,
} from "../login-routing.ts";
import { describeError, type ErrorDescription } from "../error-copy.ts";
import { holdSignInCookie } from "../sign-in-cookie.ts";
import { ChooseSignIn, LoginForm, SignedIn } from "../views/login.tsx";
import { CheckEmail } from "../views/magic-link.tsx";

export async function startSignIn(
  context: PageContext,
  identity: { organizationSlug: string; loginHint?: string },
  callbackURL: string,
  origin: string | null,
  pending = pendingOAuthQuery(new URL(context.req.url).searchParams),
) {
  // A failure names the firm and carries the signed query, so that the error page can offer a
  // link and the SSO callback can keep the application's place when it asks for a mailbox code.
  const failure = new URLSearchParams(pending ?? "");
  failure.set("firm", identity.organizationSlug);
  const result = await callAuth(context, {
    method: "POST",
    path: "/auth/sign-in/sso",
    origin,
    body: {
      ...identity,
      callbackURL,
      errorCallbackURL: `${serviceOrigin(context)}/error?${failure}`,
      ...(pending ? { oauth_query: pending } : {}),
    },
  });
  applyCookies(context, result.setCookies);
  return result;
}

/**
 * The signed query to resume with, or null. Refusing one costs the person their place in the
 * application, not the sign-in: an expired signature, or one past the bound.
 */
export async function resumableQuery(
  context: PageContext,
  pending: string | null,
) {
  if (pending === null || pending.length > maxPendingQueryLength) return null;
  const { secret } = await context.get("auth").$context;
  return (await verifyOAuthQueryParams(pending, secret)) ? pending : null;
}

export function renderSignIn(context: PageContext, view: Child) {
  return context.render(view, {
    title: "Sign in",
    footer: jsx(DirectoryLogos, {}),
  });
}

async function renderLogin(context: PageContext, message?: ErrorDescription) {
  const query = new URL(context.req.url).searchParams;
  const pending = pendingOAuthQuery(query);
  const parameters = new URLSearchParams(pending ?? "");
  const mustAuthenticate =
    parameters.get("prompt")?.split(" ").includes("login") ||
    parameters.has("max_age");
  let session: Awaited<ReturnType<typeof readPageSession>> = null;
  try {
    session = await readPageSession(context);
  } catch {
    /* An unreachable service leaves the sign-in form available. */
  }
  const route = decideLoginRoute(query);
  if (session && !mustAuthenticate) {
    if (pending) return context.redirect(`/authorize?${pending}`, 302);
    return renderSignIn(
      context,
      jsx(SignedIn, {
        email: session.email,
        method: session.method,
        query: query.toString(),
        message,
      }),
    );
  }
  // A firm whose only way in is a link has no sign-in to start: it asks for the address. A firm
  // with both asks which, since nothing may redirect past the link. If this read fails, sign-in
  // starts as it does for any firm and answers for itself.
  const firm =
    route.mode === "auto"
      ? await findOrganizationSignInRoute(
          context.get("db"),
          route.organizationSlug,
        ).catch(() => null)
      : null;
  if (firm?.magicLink && firm.directory !== null)
    return renderSignIn(
      context,
      jsx(ChooseSignIn, {
        directory: classifyIssuer(firm.directory).kind,
        directoryAction: `/login?${query}`,
        query: query.toString(),
        message,
      }),
    );
  if (route.mode === "auto" && !message && !firm?.magicLink) {
    try {
      const result = await startSignIn(
        context,
        { organizationSlug: route.organizationSlug },
        `${serviceOrigin(context)}/login?${query}`,
        serviceOrigin(context),
      );
      if (result.ok && result.data?.url)
        return context.redirect(result.data.url, 302);
      message = describeError(result.data?.code);
    } catch {
      message = describeError();
    }
  }
  return renderSignIn(
    context,
    jsx(LoginForm, {
      email: route.mode === "form" ? route.email : undefined,
      query: query.toString(),
      message,
    }),
  );
}

/**
 * The same page whatever becomes of this address, and the work that depends on it runs after
 * the response.
 */
async function askForLink(
  context: PageContext,
  email: string,
  query: URLSearchParams,
) {
  const browser = holdSignInCookie(context);
  context.get("magicLinks")?.request({
    address: email,
    browser,
    client: context.get("clientIp") ?? "unresolved",
    pendingQuery: await resumableQuery(context, pendingOAuthQuery(query)),
  });
  return context.render(jsx(CheckEmail, { email, query: query.toString() }), {
    title: "Sign in",
  });
}

export function registerLogin(app: Hono<AppEnvironment>) {
  // An office signs in through one egress address, so this is as wide as `/sign-in/sso`'s rule.
  // Without it a stranger's flood costs a transaction and a queue slot each, and drops real
  // requests. It depends on no address.
  const budget = createClientBudget({ max: 60, windowMs: 10_000 });
  app.get("/login", (context) => renderLogin(context));
  app.post("/login", async (context) => {
    const query = new URL(context.req.url).searchParams;
    if (!isOwnOriginPost(context)) {
      context.status(403);
      return renderSignIn(
        context,
        jsx(LoginForm, { query: query.toString(), message: describeError() }),
      );
    }
    if (!budget.take(context.get("clientIp") ?? "unresolved")) {
      context.status(429);
      context.header("Retry-After", "10");
      return renderSignIn(
        context,
        jsx(LoginForm, {
          query: query.toString(),
          message: describeError("sign_in_rate_limited"),
        }),
      );
    }
    const body = await context.req.parseBody();
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    let message = describeError();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const start = async (identity: Parameters<typeof startSignIn>[1]) => {
      const result = await startSignIn(
        context,
        identity,
        `${serviceOrigin(context)}/login?${query}`,
        context.req.header("origin") ?? null,
      );
      if (result.ok && result.data?.url)
        return context.redirect(result.data.url, 302);
      message = describeError(result.data?.code);
    };
    // The choice page of `?organization=` names a firm and no address.
    const named = email ? null : decideLoginRoute(query);
    if (body.method === "directory" && named?.mode === "auto") {
      try {
        const answer = await start({
          organizationSlug: named.organizationSlug,
        });
        if (answer) return answer;
      } catch {
        message = describeError();
      }
    }
    if (isLoginAddress(email)) {
      try {
        const route = await findDomainSignInRoute(context.get("db"), domain);
        if (!route) {
          message = describeError("provider_not_found");
        } else if (
          route.magicLink &&
          (route.directory === null || body.method === "link")
        ) {
          return await askForLink(context, email, query);
        } else if (route.magicLink && body.method !== "directory") {
          return renderSignIn(
            context,
            jsx(ChooseSignIn, {
              directory: classifyIssuer(route.directory!).kind,
              directoryAction: `/login?${query}`,
              email,
              query: query.toString(),
            }),
          );
        } else {
          const answer = await start({
            organizationSlug: route.slug,
            loginHint: email,
          });
          if (answer) return answer;
        }
      } catch {
        message = describeError();
      }
    }
    return renderSignIn(
      context,
      jsx(LoginForm, {
        // An address over the bound is not put back into the form.
        email: email.length <= maxLoginAddressLength ? email : undefined,
        query: query.toString(),
        message,
      }),
    );
  });
  app.post("/sign-out", async (context) => {
    try {
      const result = await callAuth(context, {
        method: "POST",
        path: "/auth/sign-out",
        body: {},
        origin: context.req.header("origin") ?? null,
      });
      applyCookies(context, result.setCookies);
      if (result.ok)
        return context.redirect(
          `/login?${new URL(context.req.url).searchParams}`,
          303,
        );
    } catch {
      /* Render the current session with a retry message. */
    }
    return renderLogin(context, {
      title: "We couldn't sign you out",
      body: "Please try again.",
    });
  });
}
