import type { Hono } from "hono";
import { jsx } from "hono/jsx";
import type { AppEnvironment } from "../../context.ts";
import {
  applyCookies,
  callAuth,
  readPageSession,
  serviceOrigin,
  type PageContext,
} from "../gateway.ts";
import { describeError } from "../error-copy.ts";
import { Security } from "../views/security.tsx";

async function renderSecurity(context: PageContext, message: string | null) {
  let session: Awaited<ReturnType<typeof readPageSession>> = null;
  try {
    session = await readPageSession(context);
  } catch {
    message = "We couldn't check your sign-in. Please try again.";
  }
  return context.render(
    jsx(Security, {
      email: session?.email ?? null,
      method: session?.method ?? null,
      message,
    }),
    { title: "Account security" },
  );
}
export function registerSecurity(app: Hono<AppEnvironment>) {
  app.get("/security", (context) => {
    const error = new URL(context.req.url).searchParams.get("error");
    return renderSecurity(context, error ? describeError(error).body : null);
  });
  for (const purpose of ["verify", "link"] as const) {
    app.post(`/security/${purpose}`, async (context) => {
      const body = await context.req.parseBody();
      const provider =
        typeof body.provider === "string" ? body.provider.trim() : "";
      let message = describeError(null).body;
      if (purpose === "verify" || provider) {
        try {
          const result = await callAuth(context, {
            method: "POST",
            path:
              purpose === "verify"
                ? "/auth/sso/reauthenticate"
                : "/auth/sso/link",
            origin: context.req.header("origin") ?? null,
            body: {
              callbackURL: `${serviceOrigin(context)}/security`,
              errorCallbackURL: `${serviceOrigin(context)}/security`,
              ...(purpose === "link" ? { providerId: provider } : {}),
            },
          });
          applyCookies(context, result.setCookies);
          if (result.ok && result.data?.url)
            return context.redirect(result.data.url, 302);
          message = describeError(
            typeof result.data?.code === "string" ? result.data.code : null,
          ).body;
        } catch {
          message = "We couldn't start verification. Please try again.";
        }
      }
      return renderSecurity(context, message);
    });
  }
}
