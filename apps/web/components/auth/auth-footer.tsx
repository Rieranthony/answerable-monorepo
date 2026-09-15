"use client"

import { useSelectedLayoutSegment } from "next/navigation"

import { DirectoryAvailability } from "@/components/auth/directory-availability"

/** Bottom of the auth pages: which company accounts work, on sign-in only. */
export function AuthFooter({ className }: { className?: string }) {
  return useSelectedLayoutSegment() === "login" ? (
    <DirectoryAvailability className={className} />
  ) : null
}
