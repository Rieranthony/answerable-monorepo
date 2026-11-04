import {
  GOOGLE_LOGO,
  MICROSOFT_LOGO,
} from "@answerable/ui/lib/directory-logos";

import type { classifyIssuer } from "../../../services/federation.ts";
import type { ErrorDescription } from "../error-copy.ts";
import { Button } from "../ui/button.tsx";
import { DirectoryLogo } from "../ui/directory-logo.tsx";
import { maxLoginAddressLength } from "../login-routing.ts";
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
  method,
  query,
  message,
}: {
  email: string;
  method: "directory" | "magic_link";
  query: string;
  message?: ErrorDescription;
}) {
  return (
    <section aria-labelledby="signed-in-heading">
      <h1 id="signed-in-heading" class="text-xl/6 font-bold">
        Signed in
      </h1>
      <p class="mt-2 text-sm/6">Signed in as {email}</p>
      {method === "directory" && (
        <p class="mt-4 text-sm/6">
          <a href="/security" class="underline underline-offset-4">
            Verify sign-in or connect a work account
          </a>
        </p>
      )}
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
        login, or email you a sign-in link.
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
            maxlength={maxLoginAddressLength}
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

/** What the button says and shows for a directory, from its issuer's kind. */
const directories = {
  entra: { name: "Microsoft", mark: MICROSOFT_LOGO },
  google: { name: "Google", mark: GOOGLE_LOGO },
  oidc: { name: "company sign-in", mark: null },
};

/** The address, kept with a method: hidden when it is known, otherwise asked for here. */
function AddressField({ email }: { email?: string }) {
  return email ? (
    <input type="hidden" name="email" value={email} />
  ) : (
    <label class="flex flex-col gap-2 text-sm/6">
      Work email
      <Input
        type="email"
        name="email"
        required
        maxlength={maxLoginAddressLength}
        autocomplete="email"
        placeholder="you@company.com"
        class="text-sm"
      />
    </label>
  );
}

/** The form that asks for a link: the page's own way, and what an error page offers. */
export function LinkForm({ email, query }: { email?: string; query: string }) {
  return (
    <form
      method="post"
      action={`/login?${query}`}
      class="mt-4 flex flex-col gap-4"
    >
      <input type="hidden" name="method" value="link" />
      <AddressField email={email} />
      <Button type="submit" variant="secondary">
        Email me a sign-in link
      </Button>
    </form>
  );
}

/**
 * A firm with both methods: the person chooses, and nothing redirects, because a person blocked
 * by IT must be able to reach the link. It depends on the firm alone, never on the address.
 */
export function ChooseSignIn({
  directory,
  directoryAction,
  email,
  member,
  query,
  message,
}: {
  directory: ReturnType<typeof classifyIssuer>["kind"];
  /** Where the directory's button posts: `/login`, or `/authorize` for a chosen member. */
  directoryAction: string;
  email?: string;
  member?: string;
  query: string;
  message?: ErrorDescription;
}) {
  const { name, mark } = directories[directory];
  return (
    <section aria-labelledby="choose-sign-in-heading">
      <h1 id="choose-sign-in-heading" class="text-xl/6 font-bold">
        Sign in
      </h1>
      <p class="text-muted-foreground mt-2 text-sm/6">
        {email
          ? `Choose how to sign in as ${email}.`
          : "Choose how to sign in."}
      </p>
      <form method="post" action={directoryAction} class="mt-8 flex flex-col">
        <input type="hidden" name="method" value="directory" />
        {email && <input type="hidden" name="email" value={email} />}
        {member && <input type="hidden" name="member" value={member} />}
        <Button type="submit">
          {mark && <DirectoryLogo mark={mark} class="size-4 shrink-0" />}
          Continue with {name}
        </Button>
      </form>
      <LinkForm email={email} query={query} />
      <Message message={message} />
    </section>
  );
}
