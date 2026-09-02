const allowedAuthRoutes = new Set(["GET /auth/ok"]);

export function isAllowedAuthRoute(method: string, path: string): boolean {
  return allowedAuthRoutes.has(`${method.toUpperCase()} ${path}`);
}
