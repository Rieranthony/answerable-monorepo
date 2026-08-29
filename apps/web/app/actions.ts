"use server"

export type WaitlistState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; email: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function joinWaitlist(
  _previous: WaitlistState,
  formData: FormData
): Promise<WaitlistState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase()

  if (!email) {
    return { status: "error", message: "Please enter your email address." }
  }

  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return {
      status: "error",
      message: "That doesn't look like a valid email address.",
    }
  }

  // TODO: persist the email — no backend yet.
  return { status: "success", email }
}
