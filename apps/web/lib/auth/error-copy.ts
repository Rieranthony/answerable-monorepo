export interface ErrorDescription {
  title: string
  body: string
}

const FALLBACK: ErrorDescription = {
  title: "We couldn't sign you in",
  body: "Something interrupted sign-in. Try again with your work email. If it keeps happening, ask your IT team for help.",
}

const ERRORS: Record<string, ErrorDescription> = {
  provider_not_found: {
    title: "We couldn't find your organisation",
    body: "We couldn't find a company sign-in for that email address. Check the address, or ask your IT team whether your organisation uses Answerable ID.",
  },
  organization_disabled: {
    title: "Your organisation's sign-in is unavailable",
    body: "Sign-in has been paused for your organisation. Ask your IT team for help.",
  },
  directory_mismatch: {
    title: "Use your organisation's account",
    body: "This account belongs to a different company directory. Try again with the work account provided by your organisation.",
  },
  guest_account: {
    title: "Use a member account",
    body: "This account is a guest in your organisation's directory. Answerable ID only accepts members. Ask your IT team, or sign in with your own company account.",
  },
  personal_account: {
    title: "Use your work account",
    body: "Personal accounts cannot sign in here. Try again with the account provided by your organisation.",
  },
  email_unverified: {
    title: "Verify your email address",
    body: "Your sign-in provider has not confirmed this email address. Verify it there, then try again.",
  },
  domain_not_allowed: {
    title: "This email domain isn't enabled",
    body: "Your organisation has not enabled this email domain for Answerable ID. Ask your IT team, or try another work email.",
  },
  hosted_domain_mismatch: {
    title: "Use your organisation's account",
    body: "This account is managed by a different organisation. Try again with your company account.",
  },
  user_disabled: {
    title: "This account is unavailable",
    body: "Your Answerable ID account has been disabled. Ask your IT team for help.",
  },
  identity_conflict: {
    title: "This account is already connected",
    body: "That company account is connected to another Answerable ID account. Ask your IT team for help.",
  },
  email_conflict: {
    title: "This email is already in use",
    body: "That email address belongs to another Answerable ID account. Ask your IT team for help.",
  },
  invalid_provider: {
    title: "Company sign-in could not be verified",
    body: "The sign-in service did not match your organisation's trusted provider. Ask your IT team for help.",
  },
  token_not_verified: {
    title: "Sign-in could not be verified",
    body: "Your company sign-in response could not be confirmed. Try again, or ask your IT team for help.",
  },
  access_denied: {
    title: "Access wasn't allowed",
    body: "You chose not to allow access, or your organisation did not permit it. You can try again with another account.",
  },
}

export function describeError(code: string | null): ErrorDescription {
  return (code && ERRORS[code]) || FALLBACK
}
