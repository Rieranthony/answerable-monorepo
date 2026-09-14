import type { ErrorDescription } from "../error-copy.ts";
export function ErrorView({
  description,
  details,
}: {
  description: ErrorDescription;
  details: string | null;
}) {
  return (
    <section aria-labelledby="error-heading">
      {/* SSO redirects to the bare errorCallbackURL, so the signed OAuth query
          is unavailable here. Keep the recovery link deliberately plain. */}
      <h1 id="error-heading" class="text-xl/6 font-bold">
        {description.title}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">{description.body}</p>
      {details && (
        <p class="bg-muted mt-4 px-2 py-2 text-sm/6 break-words whitespace-pre-wrap">
          {details}
        </p>
      )}
      <a
        href="/login"
        class="mt-8 inline-block text-sm/6 underline underline-offset-4"
      >
        Try another email
      </a>
    </section>
  );
}
