import { describe, expect, test } from "bun:test"

import { describeError, describeSSOError } from "./error-copy"

const KNOWN_CODES = [
  "provider_not_found",
  "organization_disabled",
  "directory_mismatch",
  "guest_account",
  "personal_account",
  "email_unverified",
  "domain_not_allowed",
  "hosted_domain_mismatch",
  "user_disabled",
  "identity_conflict",
  "email_conflict",
  "invalid_provider",
  "token_not_verified",
  "access_denied",
] as const

describe("unit: authentication error copy", () => {
  test("describes every supported error without exposing its code", () => {
    for (const code of KNOWN_CODES) {
      const description = describeError(code)

      expect(description.title.length).toBeGreaterThan(0)
      expect(description.body.length).toBeGreaterThan(0)
      expect(`${description.title} ${description.body}`).not.toContain(code)
    }
  })

  test("explains why guest directory accounts cannot sign in", () => {
    expect(describeError("guest_account")).toEqual({
      title: "Use a member account",
      body: "This account is a guest in your organisation's directory. Answerable ID only accepts members. Ask your IT team, or sign in with your own company account.",
    })
  })

  test("uses a calm fallback for missing and unknown codes", () => {
    const fallback = {
      title: "We couldn't sign you in",
      body: "Something interrupted sign-in. Try again with your work email. If it keeps happening, ask your IT team for help.",
    }

    expect(describeError(null)).toEqual(fallback)
    expect(describeError("unexpected_server_detail")).toEqual(fallback)
  })
})

describe("unit: SSO start failures", () => {
  test("distinguishes a missing platform application from an unknown organisation", () => {
    expect(describeSSOError("platform_application_missing")).toEqual({
      title: "Sign-in is temporarily unavailable",
      body: "Sign-in is not available for your organisation right now. Ask Answerable staff for help.",
    })
    expect(describeSSOError("provider_not_found")).toEqual(
      describeError("provider_not_found"),
    )
  })

  test("preserves the existing fallback for other failures and a missing URL", () => {
    expect(describeSSOError("unexpected_error")).toEqual(
      describeError("provider_not_found"),
    )
    expect(describeSSOError(undefined)).toEqual(
      describeError("provider_not_found"),
    )
  })

  test("asks users to restart when redirect state no longer matches", () => {
    expect(describeError("invalid_state")).toEqual({
      title: "Start sign-in again",
      body: "Your sign-in could not be completed because its state no longer matched. Start again from the sign-in page.",
    })
  })
})
