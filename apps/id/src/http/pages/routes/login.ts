import type { Hono } from "hono";
import { jsx } from "hono/jsx";
import type { AppEnvironment } from "../../context.ts";
import {
  applyCookies,
  callAuth,
  serviceOrigin,
  type PageContext,
} from "../gateway.ts";
import { decideLoginRoute, pendingOAuthQuery } from "../login-routing.ts";
import { describeSSOError, type ErrorDescription } from "../error-copy.ts";
import { LoginForm, SignedIn } from "../views/login.tsx";

export async function startSignIn(
  context: PageContext,
  identity: { email: string } | { organizationSlug: string },
  callbackURL: string,
  origin: string | null,
) {
  const pending = pendingOAuthQuery(new URL(context.req.url).searchParams);
  const result = await callAuth(context, {
    method: "POST",
    path: "/auth/sign-in/sso",
    origin,
    body: {
      ...identity,
      callbackURL,
      errorCallbackURL: `${serviceOrigin(context)}/error`,
      ...(pending ? { oauth_query: pending } : {}),
    },
  });
  applyCookies(context, result.setCookies);
  return result;
}

async function renderLogin(context: PageContext, message?: ErrorDescription) {
  const query = new URL(context.req.url).searchParams;
  const pending = pendingOAuthQuery(query);
  const parameters = new URLSearchParams(pending ?? "");
  const mustAuthenticate =
    parameters.get("prompt")?.split(" ").includes("login") ||
    parameters.has("max_age");
  let email: string | undefined;
  try {
    const session = await callAuth<{ user?: { email: string } }>(context, {
      method: "GET",
      path: "/auth/get-session",
      origin: serviceOrigin(context),
    });
    applyCookies(context, session.setCookies);
    if (session.ok) email = session.data?.user?.email;
  } catch {
    /* An unreachable service leaves the sign-in form available. */
  }
  const route = decideLoginRoute(query);
  if (email && !mustAuthenticate) {
    if (pending) return context.redirect(`/authorize?${pending}`, 302);
    return context.render(
      jsx(SignedIn, { email, query: query.toString(), message }),
      { title: "Sign in" },
    );
  }
  if (route.mode === "auto" && !message) {
    try {
      const result = await startSignIn(
        context,
        { organizationSlug: route.organizationSlug },
        `${serviceOrigin(context)}/login?${query}`,
        serviceOrigin(context),
      );
      if (result.ok && result.data?.url)
        return context.redirect(result.data.url, 302);
      message = describeSSOError(result.data?.code);
    } catch {
      message = describeSSOError(undefined);
    }
  }
  return context.render(
    jsx(LoginForm, {
      email: route.mode === "form" ? route.email : undefined,
      query: query.toString(),
      message,
    }),
    { title: "Sign in" },
  );
}

export function registerLogin(app: Hono<AppEnvironment>) {
  app.get("/login", (context) => renderLogin(context));
  app.post("/login", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const body = await context.req.parseBody();
    const email = typeof body.email === "string" ? body.email.trim() : "";
    let message = describeSSOError(undefined);
    if (email) {
      try {
        const result = await startSignIn(
          context,
          { email },
          `${serviceOrigin(context)}/login?${query}`,
          context.req.header("origin") ?? null,
        );
        if (result.ok && result.data?.url)
          return context.redirect(result.data.url, 302);
        message = describeSSOError(result.data?.code);
      } catch {
        message = describeSSOError(undefined);
      }
    }
    return context.render(
      jsx(LoginForm, { email, query: query.toString(), message }),
      { title: "Sign in" },
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
