"use client"

import { useActionState, useEffect, useRef } from "react"

import { joinWaitlist, type WaitlistState } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const initialState: WaitlistState = { status: "idle" }

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(joinWaitlist, initialState)
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
        You&apos;re on the list. We&apos;ll email {state.email} when signing
        opens.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <form
        action={formAction}
        className="flex w-full max-w-sm items-center border border-border p-1 transition-colors focus-within:border-ring"
      >
        <Input
          ref={inputRef}
          type="email"
          name="email"
          required
          autoComplete="email"
          aria-label="Email address"
          placeholder="you@practice.com"
          className="h-9 bg-transparent px-2 text-sm focus-visible:ring-0"
        />
        <Button
          type="submit"
          disabled={pending}
          className="h-9 gap-1.5 px-3 text-sm"
        >
          {pending ? "Joining…" : "Join waitlist"}
          <span
            aria-hidden="true"
            className="font-system text-primary-foreground/60"
          >
            ⏎
          </span>
        </Button>
      </form>
      {state.status === "error" && (
        <p role="alert" className="text-sm/6 font-medium">
          {state.message}
        </p>
      )}
    </div>
  )
}
