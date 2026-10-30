"use client"

import { useEffect, useState, type MouseEvent } from "react"

import { cn } from "@answerable/ui/lib/utils"

/**
 * Takes the reader to the form and puts the cursor in the email field: the
 * section from lg, the form itself on phones, so the fields are what shows
 * above the keyboard. A plain `#join` link looks dead whenever the form is
 * already on screen, or the page cannot scroll far enough to move; the hash
 * stays as the no-JS fallback.
 */
function goToForm(event: MouseEvent<HTMLAnchorElement>) {
  const join = document.getElementById("join")
  const email = join?.querySelector<HTMLInputElement>('input[name="email"]')
  if (!join || !email) return
  const target = window.matchMedia("(min-width: 64rem)").matches
    ? join
    : (email.form ?? join)

  event.preventDefault()
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches
  target.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth" })
  email.focus({ preventScroll: true })
}

/**
 * Shows only while the form is off screen, since it has nothing to add when
 * the form is already in view. It starts visible, so without JS it stays.
 */
export function RegisterLink() {
  const [formInView, setFormInView] = useState(false)

  useEffect(() => {
    const form = document.querySelector("#join form")
    if (!form) return
    const observer = new IntersectionObserver(([entry]) =>
      setFormInView(entry?.isIntersecting ?? false),
    )
    observer.observe(form)
    return () => observer.disconnect()
  }, [])

  return (
    <a
      href="#join"
      onClick={goToForm}
      className={cn(
        "text-sm font-bold decoration-2 underline-offset-4 transition-[opacity,visibility] duration-150 hover:underline motion-reduce:transition-none",
        formInView && "invisible opacity-0",
      )}
    >
      Register your interest
    </a>
  )
}
