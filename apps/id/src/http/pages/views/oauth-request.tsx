import { Button } from "../ui/button.tsx";
const scopeCopy: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "Read your name",
  email: "Read your email address",
  offline_access: "Stay connected after you leave",
};

export type OAuthFlow = {
  client: { clientId: string; name: string | null; uri: string | null };
  resource: { identifier: string; name: string } | null;
  scopes: string[];
  memberships: {
    memberId: string;
    organizationId: string;
    name: string;
    slug: string;
    authenticated: boolean;
  }[];
  selectedMemberId: string | null;
  status: "selection" | "consent";
};
export function OAuthRequest({
  consent,
  flow,
  query,
  message,
}: {
  consent: boolean;
  flow: OAuthFlow | null;
  query: string;
  message: string | null;
}) {
  const selected = flow?.memberships.find(
    (member) => member.memberId === flow.selectedMemberId,
  );
  return (
    <section aria-labelledby="oauth-heading">
      <h1 id="oauth-heading" class="text-xl/6 font-bold">
        {consent ? "Allow access" : "Choose an organisation"}
      </h1>
      {flow && (
        <>
          <p class="text-muted-foreground mt-2 text-sm/6">
            {flow.client.name ?? "This application"} is asking to use your
            Answerable ID.
          </p>
          <dl class="mt-6 flex flex-col gap-3 text-sm/6">
            <div>
              <dt class="font-bold">Application</dt>
              <dd class="break-words">
                {flow.client.name ?? flow.client.clientId}
              </dd>
            </div>
            {flow.client.uri && (
              <div>
                <dt class="font-bold">Application address</dt>
                <dd class="break-all">{flow.client.uri}</dd>
              </div>
            )}
            {flow.resource && (
              <div>
                <dt class="font-bold">Service</dt>
                <dd>{flow.resource.name}</dd>
                <dd class="text-muted-foreground break-all">
                  {flow.resource.identifier}
                </dd>
              </div>
            )}
            {selected && (
              <div>
                <dt class="font-bold">Organisation</dt>
                <dd>{selected.name}</dd>
              </div>
            )}
          </dl>
          {consent && flow.status === "consent" && selected ? (
            <>
              <h2 class="mt-6 text-sm/6 font-bold">Requested access</h2>
              <ul class="mt-2 list-disc space-y-2 pl-5 text-sm/6">
                {flow.scopes.map((scope) => (
                  <li key={scope}>
                    {scopeCopy[scope] ?? (
                      <code class="font-mono text-xs">{scope}</code>
                    )}
                  </li>
                ))}
              </ul>
              <form
                method="post"
                action={`/consent?${query}`}
                class="mt-8 flex gap-2"
              >
                <Button type="submit" name="decision" value="accept">
                  Accept
                </Button>
                <Button
                  type="submit"
                  name="decision"
                  value="deny"
                  variant="secondary"
                >
                  Deny
                </Button>
              </form>
              <p class="text-muted-foreground mt-4 text-sm/6">
                To use another organisation, deny this request and start again
                from the application.
              </p>
            </>
          ) : flow.status === "selection" ? (
            <>
              <p class="mt-6 text-sm/6">
                Choose the organisation you want to use. Each organisation
                requires its own company sign-in.
              </p>
              <ul class="mt-4 space-y-4">
                {flow.memberships.map((member) => (
                  <li
                    key={member.memberId}
                    class="border-border flex items-center justify-between gap-4 border-b pb-4"
                  >
                    <span class="text-sm/6">{member.name}</span>
                    <form method="post" action={`/authorize?${query}`}>
                      <input
                        type="hidden"
                        name="member"
                        value={member.memberId}
                      />
                      <Button type="submit" variant="secondary">
                        {member.authenticated ? "Continue" : "Sign in"}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
              {flow.memberships.length === 0 && (
                <p class="mt-4 text-sm/6">
                  No organisation is available for this account.
                </p>
              )}
              <p class="mt-6 text-sm/6">
                <a href="/security" class="underline underline-offset-4">
                  Connect another work account
                </a>
              </p>
            </>
          ) : (
            <p class="mt-6 text-sm/6">
              Return to the application&apos;s access request to continue.
            </p>
          )}
        </>
      )}
      {message && (
        <p role="alert" class="mt-4 text-sm/6">
          {message}
        </p>
      )}
    </section>
  );
}
