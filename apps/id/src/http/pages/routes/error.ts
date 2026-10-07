import type { Hono } from "hono";
import { jsx } from "hono/jsx";
import type { AppEnvironment } from "../../context.ts";
import { describeError } from "../error-copy.ts";
import { ErrorView } from "../views/error.tsx";

// Anyone can write a link to this page, so only a code-shaped description is
// shown; free text would speak with the identity domain's voice.
const detailsPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export function registerError(app: Hono<AppEnvironment>) {
  app.get("/error", (context) => {
    const query = new URL(context.req.url).searchParams;
    const details = query.get("error_description");
    return context.render(
      jsx(ErrorView, {
        description: describeError(query.get("error")),
        details:
          details !== null && detailsPattern.test(details) ? details : null,
      }),
      { title: "Can't sign in" },
    );
  });
}
