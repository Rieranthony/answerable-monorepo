import type { App } from "../app.ts";

type SignInInput = {
  providerId?: string;
  organizationSlug?: string;
  email?: string;
  callbackURL: string;
  errorCallbackURL?: string;
};

function cookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

export async function signInThroughIdp(app: App, input: SignInInput) {
  const start = await app.request("/auth/sign-in/sso", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: new URL(input.callbackURL).origin,
    },
    body: JSON.stringify(input),
  });
  const { url } = (await start.json()) as { url: string };
  const stateCookie = cookieHeader(start.headers);
  const authorization = await fetch(url, { redirect: "manual" });
  const callback = new URL(authorization.headers.get("location")!);
  const completed = await app.request(`${callback.pathname}${callback.search}`, {
    headers: { Cookie: stateCookie },
  });

  return {
    location: completed.headers.get("location"),
    cookies: completed.headers.getSetCookie(),
  };
}
