import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
export function Security({
  email,
  message,
}: {
  email: string | null;
  message: string | null;
}) {
  return (
    <section aria-labelledby="security-heading">
      <h1 id="security-heading" class="text-xl/6 font-bold">
        Account security
      </h1>
      {email ? (
        <>
          <p class="mt-2 text-sm/6">Signed in as {email}</p>
          <h2 class="mt-8 text-base/6 font-semibold">Verify your sign-in</h2>
          <p class="text-muted-foreground mt-2 text-sm/6">
            Security changes require a company sign-in from the last five
            minutes. After verifying, return to your action and try it again.
          </p>
          <form method="post" action="/security/verify">
            <Button type="submit" class="mt-4">
              Verify sign-in
            </Button>
          </form>
          <h2 class="mt-8 text-base/6 font-semibold">
            Connect another work account
          </h2>
          <p class="text-muted-foreground mt-2 text-sm/6">
            Keep this Answerable account when signing in through another
            organisation. Verify your current sign-in first, then sign in to the
            account you want to connect. Accounts already connected to another
            person cannot be moved here.
          </p>
          <form
            method="post"
            action="/security/link"
            class="mt-4 flex flex-col gap-4"
          >
            <label class="flex flex-col gap-2 text-sm/6">
              Organisation sign-in ID
              <Input
                name="provider"
                required
                maxlength={200}
                autocomplete="off"
                aria-describedby="provider-help"
              />
            </label>
            <p id="provider-help" class="text-muted-foreground text-sm/6">
              Use the sign-in ID supplied by that organisation’s administrator.
            </p>
            <Button type="submit">Connect work account</Button>
          </form>
        </>
      ) : (
        <p class="mt-4 text-sm/6">
          <a href="/login" class="underline underline-offset-4">
            Sign in
          </a>{" "}
          to verify or connect a work account.
        </p>
      )}
      {message && (
        <p role="alert" class="mt-4 text-sm/6">
          {message}
        </p>
      )}
    </section>
  );
}
