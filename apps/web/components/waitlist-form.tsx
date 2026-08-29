"use client"

import { useActionState } from "react"

import { joinWaitlist, type WaitlistState } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const initialState: WaitlistState = { status: "idle" }

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(joinWaitlist, initialState)

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
          type="email"
          name="email"
          required
          autoComplete="email"
          aria-label="Email address"
          placeholder="you@practice.com"
          className="h-6 bg-transparent px-1 text-sm focus-visible:ring-0"
        />
        <Button type="submit" disabled={pending} className="h-6 px-2 text-xs">
          {pending ? "Joining…" : "Join waitlist"}
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
