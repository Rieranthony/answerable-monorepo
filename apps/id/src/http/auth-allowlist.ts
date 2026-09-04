const allowedAuthRoutes = new Set([
  "GET /auth/ok",
  "POST /auth/sign-in/sso",
  "GET /auth/sso/callback",
  "GET /auth/get-session",
  "POST /auth/sign-out",
]);

export function isAllowedAuthRoute(method: string, path: string): boolean {
  return allowedAuthRoutes.has(`${method.toUpperCase()} ${path}`);
}
