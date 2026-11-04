import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the SSO callback verified of a person it refused with `email_conflict`: the directory's
 * row at its revision, the address, and the identity an account keys on. No token and no claim
 * beyond these.
 */
export type RefusedIdentity = {
  organizationId: string;
  providerId: string;
  providerRevision: number;
  email: string;
  issuer: string;
  subject: string;
  directoryUserId: string;
};

const held = new AsyncLocalStorage<{ identity?: RefusedIdentity }>();

/**
 * Run one call to Better Auth, and say what its callback refused of a verified sign-in. The
 * refusal rolls back everything written inside the callback's transaction, and what is left is
 * a redirect anyone can write by hand. So the identity crosses in this request's memory, from
 * the resolver to the caller, and never by a URL, a form or a cookie.
 */
export async function capturingRefusedIdentity(run: () => Promise<Response>) {
  const store: { identity?: RefusedIdentity } = {};
  const response = await held.run(store, run);
  return { response, identity: store.identity };
}

/** Only the callback's resolver calls this, with claims it has verified. */
export function noteRefusedIdentity(identity: RefusedIdentity) {
  const store = held.getStore();
  if (store) store.identity = identity;
}
