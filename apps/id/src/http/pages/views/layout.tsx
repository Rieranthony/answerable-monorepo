import type { Child } from "hono/jsx";
import { Logo } from "../ui/logo.tsx";

export function Document({
  title,
  children,
  footer,
}: {
  title: string;
  children: Child;
  footer?: Child;
}) {
  return (
    <html lang="en" class="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <title>{title}</title>
        <link rel="stylesheet" href="/assets/tailwind.css" />
      </head>
      <body>
        <div class="grid min-h-svh grid-rows-[1fr_auto_1fr] gap-y-16 px-6 py-6">
          <header class="self-start">
            <Logo class="h-auto w-32" />
          </header>
          <main class="mx-auto w-full max-w-sm">{children}</main>
          {footer}
        </div>
      </body>
    </html>
  );
}
