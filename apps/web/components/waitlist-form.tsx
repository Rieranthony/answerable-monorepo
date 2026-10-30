"use client"

import { useActionState, useEffect, useRef } from "react"

import { joinWaitlist } from "@/app/actions"
import type { WaitlistState } from "@/lib/waitlist"
import { Button } from "@answerable/ui/components/button"
import { CountrySelect } from "@answerable/ui/components/country-select"
import { Field, FieldLabel, FieldError } from "@answerable/ui/components/field"
import { Form } from "@answerable/ui/components/form"
import { Input } from "@answerable/ui/components/input"

const initialState: WaitlistState = { status: "idle" }

export function WaitlistForm({
  autoFocus = true,
  inline = false,
}: {
  /** Focus the email field on mount. Off where something else is playing, such as a splash. */
  autoFocus?: boolean
  /** Email and country side by side from `sm`, the country narrower, across the full width. */
  inline?: boolean
}) {
  const [state, formAction, pending] = useActionState(
    joinWaitlist,
    initialState,
  )
  const inputRef = useRef<HTMLInputElement>(null)

  // React does not reapply `autoFocus` to server-rendered markup during
  // hydration, so focus here — without scrolling, since the field sits far
  // enough down the page to yank the reader past the declaration.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true })
  }, [autoFocus])

  if (state.status === "success") {
    return (
      <p className="text-sm/6">
        You&apos;re on the list. We&apos;ll email {state.email} the programme
        details when enrolment opens.
      </p>
    )
  }

  return (
    <Form
      action={formAction}
      errors={state.status === "error" ? state.errors : undefined}
      // The inline form sits under a sticky header on phones; the margin keeps it clear.
      className={inline ? "w-full scroll-mt-24 gap-3" : "w-full max-w-sm"}
    >
      <div
        className={
          inline ? "grid gap-3 sm:grid-cols-[3fr_2fr]" : "flex flex-col gap-4"
        }
      >
        <Field name="email">
          <FieldLabel>Email</FieldLabel>
          <Input
            ref={inputRef}
            type="text"
            inputMode="email"
            name="email"
            autoComplete="email"
            placeholder="you@practice.com"
          />
          <FieldError />
        </Field>
        <Field name="country">
          <FieldLabel nativeLabel={false}>Country</FieldLabel>
          <CountrySelect
            name="country"
            placeholder={inline ? "Select" : undefined}
          />
          <FieldError />
        </Field>
      </div>
      <Button type="submit" disabled={pending} className="w-full gap-1.5">
        {pending ? "Registering…" : "Register your interest"}
        <span
          aria-hidden="true"
          className="font-system text-primary-foreground"
        >
          ⏎
        </span>
      </Button>
      {state.status === "error" && state.message && (
        <p role="alert" className="text-sm/6 font-medium">
          {state.message}
        </p>
      )}
    </Form>
  )
}
