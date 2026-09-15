import { AuthFooter } from "@/components/auth/auth-footer"
import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Equal first and last rows hold the page at the true centre, with the
  // header at the top and the footer at the bottom.
  return (
    <div className="grid min-h-svh w-full grid-rows-[1fr_auto_1fr] gap-y-16 px-6 py-6">
      <header className="flex items-start justify-between gap-4 self-start">
        <Logo className="h-auto w-32" />
        <ThemeToggle />
      </header>
      <main className="mx-auto w-full max-w-sm">{children}</main>
      <AuthFooter className="self-end" />
    </div>
  )
}
