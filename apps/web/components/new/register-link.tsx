"use client"

import type { MouseEvent } from "react"

/**
 * Takes the reader to the form and puts the cursor in the email field. A plain
 * `#join` link looks dead whenever the form is already on screen, or the page
 * cannot scroll far enough to move; the hash stays as the no-JS fallback.
 */
function goToForm(event: MouseEvent<HTMLAnchorElement>) {
  const join = document.getElementById("join")
  const email = join?.querySelector<HTMLInputElement>('input[name="email"]')
  if (!join || !email) return

  event.preventDefault()
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches
  join.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth" })
  email.focus({ preventScroll: true })
}

export function RegisterLink() {
  return (
    <a
      href="#join"
      onClick={goToForm}
      className="text-sm font-bold decoration-2 underline-offset-4 hover:underline"
    >
      Register your interest
    </a>
  )
}
