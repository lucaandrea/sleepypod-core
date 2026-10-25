'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { activeNavId, langFromPath, PHONE_NAV_ITEMS } from './navItems'

/** Phone bottom tab bar (< 900px). Respects the safe-area inset. */
export function TabBar({ className }: { className?: string }) {
  const items = PHONE_NAV_ITEMS
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)
  const { isActive: scheduleActive } = useScheduleActive()

  return (
    <nav
      aria-label="Main"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(52px, 1fr))` }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 grid overflow-x-auto border-t border-line bg-app px-2 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5 font-mono',
        'text-[11px] uppercase tracking-[0.06em]',
        className,
      )}
    >
      {items.map((n) => {
        const on = n.id === active
        return (
          <Link
            key={n.id}
            href={`/${lang}${n.href === '/' ? '' : n.href}`}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex min-h-11 flex-col items-center gap-1 no-underline hover:no-underline',
              on ? 'text-fg' : 'text-fg-3',
            )}
          >
            <span className="relative">
              <n.icon size={19} />
              {n.id === 'schedule' && scheduleActive && (
                <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-ok" />
              )}

            </span>
            {n.label}
          </Link>
        )
      })}
    </nav>
  )
}
