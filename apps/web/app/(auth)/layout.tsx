import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-svh w-full max-w-sm flex-col px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <Logo className="h-auto w-32" />
        <ThemeToggle />
      </header>
      <main className="flex grow flex-col justify-center py-16">
        {children}
      </main>
    </div>
  )
}
