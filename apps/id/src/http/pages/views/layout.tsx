import type { Child } from "hono/jsx";
import { Logo } from "../ui/logo.tsx";

export function Document({
  title,
  children,
}: {
  title: string;
  children: Child;
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
        <div class="flex min-h-svh flex-col">
          <header class="px-6 py-6">
            <Logo class="h-auto w-32" />
          </header>
          <main class="flex grow items-center justify-center px-6 py-16">
            <section class="w-full max-w-sm">{children}</section>
          </main>
        </div>
      </body>
    </html>
  );
}
