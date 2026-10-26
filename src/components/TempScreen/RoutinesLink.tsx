'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import { langFromPath } from '@/src/components/AppShell/navItems'

/** Keep routines reachable from both the 3D and accessible card views of Tonight. */
export function RoutinesLink({ className }: { className?: string }) {
  const lang = langFromPath(usePathname())
  return (
    <Link href={`/${lang}/schedule`} className={cn('inline-flex min-h-11 items-center justify-center gap-2 rounded-ctl px-3 text-sm text-inherit no-underline hover:bg-active hover:no-underline', className)}>
      <Calendar size={16} aria-hidden />
      Routines
    </Link>
  )
}
