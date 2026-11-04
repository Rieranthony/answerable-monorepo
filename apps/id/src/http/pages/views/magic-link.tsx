import { describeError } from "../error-copy.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";

const link = "underline underline-offset-4";

export function CodeForm({
  action,
  submit = "Sign in",
}: {
  action: string;
  submit?: string;
}) {
  return (
    <form method="post" action={action} class="mt-8 flex flex-col gap-4">
      <label class="flex flex-col gap-2 text-sm/6">
        Code
        <Input
          name="code"
          required
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{8}"
          maxlength={8}
          class="text-sm"
        />
      </label>
      <Button type="submit">{submit}</Button>
    </form>
  );
}

/** Whatever became of the request: it says "if", and names only what was typed. */
export function CheckEmail({
  email,
  query,
  sender,
}: {
  email: string;
  query: string;
  /** The address the mail comes from, which a firm's IT team would allow. */
  sender: string;
}) {
  return (
    <section aria-labelledby="check-email-heading">
      <h1 id="check-email-heading" class="text-xl/6 font-bold">
        Check your email
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">
        If {email} can sign in here, we&apos;ve sent it a link and a code. Open
        the link in this browser. If you read your email somewhere else, enter
        the code here.
      </p>
      <CodeForm action={`/magic-link/code?${query}`} />
      <p class="text-muted-foreground mt-4 text-sm/6">
        If nothing arrives, check your junk or quarantine folder. You can ask
        again after a minute. If it still doesn&apos;t come, ask your IT team to
        allow email from {sender}.
      </p>
      <p class="mt-4 text-sm/6">
        <a href={`/login?${query}`} class={link}>
          Use another email
        </a>
      </p>
    </section>
  );
}

/** The one answer to a code, whatever was wrong with it. */
export function CodeRefused({ query }: { query: string }) {
  const { title, body } = describeError("magic_link_code_refused");
  return (
    <section aria-labelledby="code-refused-heading">
      <h1 id="code-refused-heading" class="text-xl/6 font-bold">
        {title}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">{body}</p>
      <CodeForm action={`/magic-link/code?${query}`} />
      <p class="mt-4 text-sm/6">
        <a href={`/login?${query}`} class={link}>
          Ask for a new link
        </a>
      </p>
    </section>
  );
}

/** The browser the link was asked for. Names the address, and consumes nothing. */
export function ContinueWithLink({
  email,
  token,
}: {
  email: string;
  token: string;
}) {
  return (
    <section aria-labelledby="continue-heading">
      <h1 id="continue-heading" class="text-xl/6 font-bold">
        Sign in
      </h1>
      <p class="mt-2 text-sm/6">Continue as {email}</p>
      <form method="post" action="/magic-link" class="mt-8">
        <input type="hidden" name="token" value={token} />
        <Button type="submit">Continue</Button>
      </form>
    </section>
  );
}

/** Every other browser, and every token that no longer works. Names no address. */
export function LinkElsewhere() {
  const { title, body } = describeError("magic_link_elsewhere");
  return (
    <section aria-labelledby="link-elsewhere-heading">
      <h1 id="link-elsewhere-heading" class="text-xl/6 font-bold">
        {title}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">{body}</p>
      <p class="mt-8 text-sm/6">
        <a href="/login" class={link}>
          Ask for a new link
        </a>
      </p>
    </section>
  );
}
