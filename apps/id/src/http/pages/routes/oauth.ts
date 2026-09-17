import type { Hono } from "hono";
import { jsx } from "hono/jsx";
import { z } from "zod";
import type { AppEnvironment } from "../../context.ts";
import {
  applyCookies,
  callAuth,
  serviceOrigin,
  type PageContext,
} from "../gateway.ts";
import { OAuthRequest, type OAuthFlow } from "../views/oauth-request.tsx";
import { startSignIn } from "./login.ts";

const unavailable =
  "This request has expired or is unavailable. Start again from the application.";
const accessUnavailable =
  "Access is unavailable for this organisation. Sign in again or ask its administrator to check your access.";
const signInUnavailable =
  "We couldn't start your organisation's sign-in. Please try again.";
const consentUnavailable =
  "Your choice could not be recorded. Try again, or start a new request from the application.";

async function loadFlow(context: PageContext) {
  try {
    const result = await callAuth<OAuthFlow>(context, {
      method: "POST",
      path: "/auth/oauth2/flow",
      body: { oauth_query: new URL(context.req.url).searchParams.toString() },
      origin: serviceOrigin(context),
    });
    applyCookies(context, result.setCookies);
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}
async function renderFlow(
  context: PageContext,
  consent: boolean,
  message: string | null = null,
) {
  const flow = await loadFlow(context);
  return context.render(
    jsx(OAuthRequest, {
      consent,
      flow,
      query: new URL(context.req.url).searchParams.toString(),
      message: message ?? (flow ? null : unavailable),
    }),
    { title: consent ? "Allow access" : "Choose an organisation" },
  );
}
export function registerOAuth(app: Hono<AppEnvironment>) {
  app.get("/authorize", (context) => renderFlow(context, false));
  app.get("/consent", (context) => renderFlow(context, true));
  app.post("/authorize", async (context) => {
    const body = await context.req.parseBody();
    const memberId = z.uuid().safeParse(body.member);
    if (!memberId.success) return renderFlow(context, false, accessUnavailable);
    const flow = await loadFlow(context);
    const member = flow?.memberships.find(
      (entry) => entry.memberId === memberId.data,
    );
    if (!member) return renderFlow(context, false, accessUnavailable);
    const query = new URL(context.req.url).searchParams.toString();
    try {
      const result = member.authenticated
        ? await callAuth(context, {
            method: "POST",
            path: "/auth/oauth2/continue",
            body: {
              oauth_query: query,
              postLogin: true,
              memberId: member.memberId,
            },
            origin: context.req.header("origin") ?? null,
          })
        : await startSignIn(
            context,
            { organizationSlug: member.slug },
            `${serviceOrigin(context)}/authorize?${query}`,
            context.req.header("origin") ?? null,
          );
      if (member.authenticated) applyCookies(context, result.setCookies);
      if (result.ok && result.data?.url)
        return context.redirect(result.data.url, 302);
    } catch {
      /* Reload the request so the browser can retry. */
    }
    return renderFlow(
      context,
      false,
      member.authenticated ? accessUnavailable : signInUnavailable,
    );
  });
  app.post("/consent", async (context) => {
    const body = await context.req.parseBody();
    if (body.decision === "accept" || body.decision === "deny") {
      try {
        const result = await callAuth(context, {
          method: "POST",
          path: "/auth/oauth2/consent",
          body: {
            oauth_query: new URL(context.req.url).searchParams.toString(),
            accept: body.decision === "accept",
          },
          origin: context.req.header("origin") ?? null,
        });
        applyCookies(context, result.setCookies);
        if (result.ok && result.data?.url)
          return context.redirect(result.data.url, 302);
      } catch {
        /* Reload the request so the browser can retry. */
      }
    }
    return renderFlow(context, true, consentUnavailable);
  });
}
