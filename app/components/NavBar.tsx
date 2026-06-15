"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function BrandMark() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2 font-bold text-foreground">
      <span
        className="grid h-8 w-8 place-items-center rounded-lg text-white"
        style={{ backgroundImage: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </span>
      <span className="text-[15px] tracking-tight">QuizCraft</span>
    </Link>
  );
}

export default function NavBar() {
  const pathname = usePathname();

  const links = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/generate", label: "Generate" },
  ];

  return (
    <header className="sticky top-0 z-30 border-b backdrop-blur-md" style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--surface) 80%, transparent)" }}>
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <BrandMark />
          <nav className="hidden items-center gap-1 sm:flex">
            {links.map((l) => {
              const active = pathname === l.href;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
                  style={
                    active
                      ? { backgroundColor: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--primary)" }
                      : { color: "var(--muted)" }
                  }
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <Link
          href="/generate"
          className="rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors sm:hidden"
          style={{ color: "var(--primary)" }}
        >
          New
        </Link>
      </div>
    </header>
  );
}
