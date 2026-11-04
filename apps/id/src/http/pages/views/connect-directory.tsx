import type { ErrorDescription } from "../error-copy.ts";
import { CodeForm } from "./magic-link.tsx";

const link = "underline underline-offset-4";

/** The other proof of a directory: no session exists, and the code signs nobody in. */
export function ConnectDirectory({
  email,
  query = "",
  message,
}: {
  /** Absent on a refusal: that answer is the same whatever was wrong. */
  email?: string;
  /** The signed query of the authorisation this resumes, for starting again. */
  query?: string;
  message?: ErrorDescription;
}) {
  return (
    <section aria-labelledby="connect-directory-heading">
      <h1 id="connect-directory-heading" class="text-xl/6 font-bold">
        {message?.title ?? "Connect your company sign-in"}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">
        {message?.body ??
          `${email} already has an account here, so we've emailed it a code. Enter the code to connect your company sign-in to that account, then sign in with your company account again. Nobody at Answerable or your firm will ask you for it.`}
      </p>
      <CodeForm action="/connect-directory" submit="Connect" />
      <p class="mt-4 text-sm/6">
        <a href={query ? `/login?${query}` : "/login"} class={link}>
          Start again
        </a>
      </p>
    </section>
  );
}

/** No code is waiting in this browser, or the connection was refused. Names no address. */
export function NoConnection({
  description,
}: {
  description: ErrorDescription;
}) {
  return (
    <section aria-labelledby="no-connection-heading">
      <h1 id="no-connection-heading" class="text-xl/6 font-bold">
        {description.title}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">{description.body}</p>
      <p class="mt-8 text-sm/6">
        <a href="/login" class={link}>
          Go to sign-in
        </a>
      </p>
    </section>
  );
}

/** Connected, with the directory's sign-in not started. Rare, and nothing is lost. */
export function Connected({ query }: { query: string }) {
  return (
    <section aria-labelledby="connected-heading">
      <h1 id="connected-heading" class="text-xl/6 font-bold">
        Your company sign-in is connected
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">
        Sign in with your company account to continue.
      </p>
      <p class="mt-8 text-sm/6">
        <a href={`/login${query}`} class={link}>
          Go to sign-in
        </a>
      </p>
    </section>
  );
}
