export type PublicAuthRoute = {
  method: "GET" | "POST";
  path: string;
  operationId: string;
  summary: string;
  tag: "Sign-in" | "Session";
};

export const publicAuthRoutes: ReadonlyArray<PublicAuthRoute> = [
  {
    method: "GET",
    path: "/auth/ok",
    operationId: "ok",
    summary: "Check that Answerable ID is reachable",
    tag: "Session",
  },
  {
    method: "POST",
    path: "/auth/sign-in/sso",
    operationId: "signInWithSso",
    summary: "Start sign-in through the organisation's identity provider",
    tag: "Sign-in",
  },
  {
    method: "GET",
    path: "/auth/sso/callback",
    operationId: "ssoCallback",
    summary: "Complete sign-in after the identity provider redirects back",
    tag: "Sign-in",
  },
  {
    method: "GET",
    path: "/auth/get-session",
    operationId: "getSession",
    summary: "Read the current session",
    tag: "Session",
  },
  {
    method: "POST",
    path: "/auth/sign-out",
    operationId: "signOut",
    summary: "End the current session",
    tag: "Session",
  },
];

const allowedAuthRoutes = new Set(
  publicAuthRoutes.map(({ method, path }) => `${method} ${path}`),
);

export function isAllowedAuthRoute(method: string, path: string): boolean {
  return allowedAuthRoutes.has(`${method.toUpperCase()} ${path}`);
}
