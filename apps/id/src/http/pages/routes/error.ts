import type { Hono } from "hono";
import { jsx } from "hono/jsx";
import type { AppEnvironment } from "../../context.ts";
import { describeError } from "../error-copy.ts";
import { ErrorView } from "../views/error.tsx";

export function registerError(app: Hono<AppEnvironment>) {
  app.get("/error", (context) => {
    const query = new URL(context.req.url).searchParams;
    return context.render(
      jsx(ErrorView, {
        description: describeError(query.get("error")),
        details: query.get("error_description"),
      }),
      { title: "Can't sign in" },
    );
  });
}
