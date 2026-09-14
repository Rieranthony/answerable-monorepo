import type { Context } from "hono";
import type { AppEnvironment } from "../context.ts";
import { isAllowedAuthRoute } from "../auth-allowlist.ts";
import { serviceUrl } from "../../lib/service-url.ts";

export type PageContext = Context<AppEnvironment>;

export function serviceOrigin(context: PageContext): string {
  return serviceUrl(context.get("environment"));
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
  const headers = new Headers({
    accept: "application/json",
    "x-request-id": context.get("requestId"),
  });
  if (input.body !== undefined) headers.set("content-type", "application/json");
  if (input.origin !== null) headers.set("origin", input.origin);
  for (const name of ["cookie", "user-agent", "x-forwarded-for"]) {
    const value = context.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  const response = await context
    .get("auth")
    .handler(
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
}

export function applyCookies(context: PageContext, setCookies: string[]) {
  for (const value of setCookies)
    context.header("set-cookie", value, { append: true });
}
