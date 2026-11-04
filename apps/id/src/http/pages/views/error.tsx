import type { ErrorDescription } from "../error-copy.ts";
import { LinkForm } from "./login.tsx";

export function ErrorView({
  description,
  details,
  query = "",
  offersLink = false,
}: {
  description: ErrorDescription;
  details: string | null;
  /** The signed query this sign-in was resuming, when it verified. */
  query?: string;
  /** The firm this sign-in was for has links on, so a person IT blocks can still get in. */
  offersLink?: boolean;
}) {
  return (
    <section aria-labelledby="error-heading">
      <h1 id="error-heading" class="text-xl/6 font-bold">
        {description.title}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">{description.body}</p>
      {details && (
        <p class="bg-muted mt-4 px-2 py-2 text-sm/6 break-words whitespace-pre-wrap">
          {details}
        </p>
      )}
      {offersLink && <LinkForm query={query} />}
      <a
        href={query ? `/login?${query}` : "/login"}
        class="mt-8 inline-block text-sm/6 underline underline-offset-4"
      >
        Try another email
      </a>
    </section>
  );
}
