"use server"

import {
  submitWaitlist,
  type WaitlistState as SubmitWaitlistState,
} from "@/lib/waitlist"

// Declared as an alias rather than `export type { … }`: Next's server-action
// transform treats a re-export as a value export and fails at module load.
export type WaitlistState = SubmitWaitlistState

export async function joinWaitlist(
  _previous: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  return submitWaitlist(String(formData.get("email") ?? ""))
}
