import type { ErrorDescription } from "../error-copy.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";

function Message({ message }: { message?: ErrorDescription }) {
  return message ? (
    <p role="alert" class="mt-4 text-sm/6 font-medium">
      <span class="block">{message.title}</span>
      <span class="block font-normal">{message.body}</span>
    </p>
  ) : null;
}
export function SignedIn({
  email,
  query,
  message,
}: {
  email: string;
  query: string;
  message?: ErrorDescription;
}) {
  return (
    <section aria-labelledby="signed-in-heading">
      <h1 id="signed-in-heading" class="text-xl/6 font-bold">
        Signed in
      </h1>
      <p class="mt-2 text-sm/6">Signed in as {email}</p>
      <p class="mt-4 text-sm/6">
        <a href="/security" class="underline underline-offset-4">
          Verify sign-in or connect a work account
        </a>
      </p>
      <form method="post" action={`/sign-out?${query}`}>
        <Button type="submit" class="mt-8">
          Sign out
        </Button>
      </form>
      <Message message={message} />
    </section>
  );
}
export function LoginForm({
  email = "",
  query,
  message,
}: {
  email?: string;
  query: string;
  message?: ErrorDescription;
}) {
  return (
    <section aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading" class="text-xl/6 font-bold">
        Sign in
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">
        Use your work email. We&apos;ll take you to your organisation&apos;s
        login.
      </p>
      <form
        method="post"
        action={`/login?${query}`}
        class="mt-8 flex flex-col gap-4"
      >
        <label class="flex flex-col gap-2 text-sm/6">
          Work email
          <Input
            type="email"
            name="email"
            value={email}
            required
            autocomplete="email"
            placeholder="you@company.com"
            class="text-sm"
          />
        </label>
        <Button type="submit">Continue</Button>
      </form>
      <Message message={message} />
    </section>
  );
}
