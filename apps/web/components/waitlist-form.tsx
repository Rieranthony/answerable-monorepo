"use client"

import { useActionState, useEffect, useRef } from "react"

import { joinWaitlist, type WaitlistState } from "@/app/actions"
import { Button } from "@answerable/ui/components/button"
import { CountrySelect } from "@answerable/ui/components/country-select"
import { Field, FieldLabel, FieldError } from "@answerable/ui/components/field"
import { Form } from "@answerable/ui/components/form"
import { Input } from "@answerable/ui/components/input"

const initialState: WaitlistState = { status: "idle" }

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(
    joinWaitlist,
    initialState,
  )
  const inputRef = useRef<HTMLInputElement>(null)

  // React does not reapply `autoFocus` to server-rendered markup during
  // hydration, so focus here — without scrolling, since the field sits far
  // enough down the page to yank the reader past the declaration.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

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
      className="w-full max-w-sm"
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
        <CountrySelect name="country" />
        <FieldError />
      </Field>
      <Button type="submit" disabled={pending} className="w-fit gap-1.5">
        {pending ? "Registering…" : "Register your interest"}
        <span
          aria-hidden="true"
          className="font-system text-primary-foreground/60"
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
