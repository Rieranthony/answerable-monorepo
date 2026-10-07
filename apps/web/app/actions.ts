"use server"

import { submitWaitlist, type WaitlistState } from "@/lib/waitlist"

export async function joinWaitlist(
  _previous: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  return submitWaitlist({
    email: String(formData.get("email") ?? ""),
    country: String(formData.get("country") ?? ""),
  })
}
