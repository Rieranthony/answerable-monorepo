import type { Context } from "hono";
import type { AppEnvironment } from "../context.ts";
import { isAllowedAuthRoute } from "../auth-allowlist.ts";
import { errorFields } from "../problem.ts";
import { readSessionOrigin } from "../../db/queries/sessions.ts";
import { logEvent } from "../../lib/log.ts";

export type PageContext = Context<AppEnvironment>;

export function serviceOrigin(context: PageContext): string {
  return context.get("environment").betterAuthUrl;
}

/** What an in-process call to Better Auth carries of the browser's request. */
export function authCallHeaders(context: PageContext) {
  const headers = new Headers({
    accept: "application/json",
    "x-request-id": context.get("requestId"),
  });
  for (const name of [
    "cookie",
    "user-agent",
    "cf-connecting-ip",
    "x-forwarded-for",
  ]) {
    const value = context.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export async function callAuth<T = { url?: string; code?: string }>(
  context: PageContext,
  input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    origin: string | null;
  },
) {
  if (!isAllowedAuthRoute(input.method, input.path))
    throw new Error("Page attempted a non-public auth route");
  const headers = authCallHeaders(context);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  if (input.origin !== null) headers.set("origin", input.origin);
  try {
    const response = await context.get("auth").handler(
      new Request(`${serviceOrigin(context)}${input.path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      }),
    );
    const data: T | null = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : null;
    return {
      status: response.status,
      ok: response.ok,
      data,
      setCookies: response.headers.getSetCookie(),
    };
  } catch (error) {
    // The pages answer with a friendly message; this line keeps the failure
    // visible to operators, as problemHandler does for the API.
    logEvent("page", "page_auth_call_failed", {
      requestId: context.get("requestId"),
      path: input.path,
      ...errorFields(error),
    });
    throw error;
  }
}

export function applyCookies(context: PageContext, setCookies: string[]) {
  for (const value of setCookies)
    context.header("set-cookie", value, { append: true });
}

/**
 * The form only ever lives on ID's own origin. A browser always sends Origin
 * on a post; a request without one is not a cross-site browser form.
 */
export function isOwnOriginPost(context: PageContext): boolean {
  const origin = context.req.header("origin");
  if (origin !== undefined && origin !== new URL(serviceOrigin(context)).origin)
    return false;
  return context.req.header("sec-fetch-site") !== "cross-site";
}

/** The browser's session as the pages treat it, or null when it reads as signed out. Better
 * Auth's read still answers for a magic-link session whose firm turned links off; nothing it
 * could do with it would work, so a page must not say it is signed in. */
export async function readPageSession(context: PageContext) {
  const result = await callAuth<{
    session?: { id: string };
    user?: { email: string };
  }>(context, {
    method: "GET",
    path: "/auth/get-session",
    origin: serviceOrigin(context),
  });
  applyCookies(context, result.setCookies);
  if (!result.ok) throw new Error("Session unavailable");
  const email = result.data?.user?.email;
  if (!email) return null;
  const id = result.data?.session?.id;
  const origin = id ? await readSessionOrigin(context.get("db"), id) : null;
  if (origin?.kind === "magic_link")
    return origin.live ? { email, method: "magic_link" as const } : null;
  return { email, method: "directory" as const };
}
