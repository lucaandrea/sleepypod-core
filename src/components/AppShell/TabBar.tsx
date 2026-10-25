'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { primaryNavId, langFromPath, NAV_ITEMS } from './navItems'
import { usePodHealth } from './usePodHealth'

/** Phone bottom tab bar (< 900px). Respects the safe-area inset. */
export function TabBar({ className }: { className?: string }) {
  const items = NAV_ITEMS
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = primaryNavId(pathname)
  const { isActive: scheduleActive } = useScheduleActive()
  const { footer } = usePodHealth()

  return (
    <nav
      aria-label="Main"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(52px, 1fr))` }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 grid overflow-x-auto border-t border-line bg-app/90 backdrop-blur-xl px-2 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5 font-sans',
        'text-[11px] tracking-normal',
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
              {n.id === 'temp' && scheduleActive && (
                <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-ok" />
              )}
              {/* Pod health, as the sidebar footer shows it on wider screens. */}
              {n.id === 'more' && footer.tone !== 'muted' && (
                <span
                  className={cn('absolute -right-1 -top-0.5 size-1.5 rounded-full', footer.tone === 'warn' ? 'bg-warn' : 'bg-ok')}
                  data-testid="system-health-dot"
                  data-tone={footer.tone}
                />
              )}
            </span>
            {n.label}
            {n.id === 'more' && footer.tone === 'warn' && <span className="sr-only">{`, ${footer.summary}`}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
