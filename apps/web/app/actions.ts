"use server"

import { submitWaitlist, type WaitlistState } from "@/lib/waitlist"

export type { WaitlistState }

export async function joinWaitlist(
  _previous: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  return submitWaitlist(String(formData.get("email") ?? ""))
}
