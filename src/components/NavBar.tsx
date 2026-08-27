"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Bottom tab bar.
 *
 * Bottom rather than top because this is used one-handed on a phone — the top
 * of a modern iPhone screen is out of thumb reach. The padding below the row
 * clears the home indicator via the safe-area inset; without it the last few
 * pixels of the tab bar are permanently under the system gesture area.
 */

/**
 * Six destinations is the practical ceiling for a phone tab bar, and this app
 * genuinely has six things you go to. Ordered by how often you'd tap them:
 * the three daily ones first, then the three you review periodically.
 */
const TABS = [
  { href: "/", label: "Today", icon: TodayIcon },
  { href: "/habits", label: "Habits", icon: HabitsIcon },
  { href: "/journal", label: "Journal", icon: JournalIcon },
  { href: "/trends", label: "Trends", icon: TrendsIcon },
  { href: "/sleep", label: "Sleep", icon: SleepIcon },
  { href: "/coach", label: "Coach", icon: CoachIcon },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t backdrop-blur"
      style={{
        background: "color-mix(in srgb, var(--surface) 90%, transparent)",
        borderColor: "var(--hairline)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="mx-auto flex w-full max-w-4xl">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          const Icon = tab.icon;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className="flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] transition-colors sm:text-[11px]"
              style={{ color: active ? "var(--series-1)" : "var(--ink-muted)" }}
            >
              <Icon />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/* Inline icons rather than an icon package — four glyphs is not worth a
   dependency, and these inherit currentColor for free. */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function TodayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function TrendsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
      <path d="M3 17l5-6 4 4 6-8" />
      <path d="M15 7h4v4" />
    </svg>
  );
}

function SleepIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
      <path d="M20 14a8 8 0 1 1-9.9-9.8A7 7 0 0 0 20 14z" />
    </svg>
  );
}

function HabitsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
      <path d="M9 11l2 2 4-4" />
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M8 2v4M16 2v4" />
    </svg>
  );
}

function JournalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
      <path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2z" />
      <path d="M8 7h7M8 11h7" />
    </svg>
  );
}

function CoachIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8z" />
    </svg>
  );
}
