import { existsSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { type Child } from "hono/jsx";
import { jsxRenderer } from "hono/jsx-renderer";
import { secureHeaders } from "hono/secure-headers";
import { tailwind } from "hono-tailwind";
import type { AppEnvironment } from "../context.ts";
import fontPath from "./fonts/PublicSans-Variable.woff2";
import { Document } from "./views/layout.tsx";
import { registerLogin } from "./routes/login.ts";
import { registerOAuth } from "./routes/oauth.ts";
import { registerSecurity } from "./routes/security.ts";
import { registerError } from "./routes/error.ts";

declare module "hono" {
  interface ContextRenderer {
    (
      content: Child,
      props: { title: string; footer?: Child },
    ): Response | Promise<Response>;
  }
}
const pages = [
  "/login",
  "/sign-out",
  "/authorize",
  "/consent",
  "/error",
  "/security",
  "/security/verify",
  "/security/link",
];
const assets = ["/assets/tailwind.css", "/assets/fonts/public-sans.woff2"];
export function isPagePath(path: string): boolean {
  return pages.includes(path) || assets.includes(path);
}
export function createPagesApp(): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      styleSrc: ["'self'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
    },
    // OAuth clients may run this flow in a popup that needs window.opener.
    crossOriginOpenerPolicy: false,
    // Under no-referrer, browsers send Origin: null on form posts, which
    // Better Auth refuses whenever the request carries a cookie.
    referrerPolicy: "same-origin",
    xFrameOptions: "DENY",
  });
  for (const route of [...pages, ...assets]) app.use(route, headers);
  for (const route of pages) {
    app.use(route, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    });
    app.use(
      route,
      jsxRenderer(
        ({ children, title, footer }) => Document({ children, title, footer }),
        {
          docType: true,
        },
      ),
    );
  }
  // The build writes the compiled stylesheet next to the bundle; source runs
  // compile it on each request.
  const stylesheet = path.join(import.meta.dir, "tailwind.css");
  app.get(
    "/assets/tailwind.css",
    tailwind({
      in: path.join(import.meta.dir, "styles.css"),
      ...(existsSync(stylesheet) ? { out: stylesheet } : {}),
    }),
  );
  app.get("/assets/fonts/public-sans.woff2", () => {
    return new Response(Bun.file(new URL(fontPath, import.meta.url)), {
      headers: {
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });
  registerLogin(app);
  registerOAuth(app);
  registerSecurity(app);
  registerError(app);
  return app;
}
