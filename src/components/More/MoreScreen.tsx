'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowUpRight, Calendar, Cog, House, KeyRound, Palette, Radio, Sparkles } from 'lucide-react'
import { PageHeader } from '@/src/components/ds'
import { DOCS_URL, langFromPath } from '@/src/components/AppShell/navItems'
import { useBaseAvailable } from '@/src/components/AppShell/useBaseAvailable'

const SECTIONS = [
  { title: 'Routines & wake alarms', description: 'Plan temperatures, bedtime and waking for each side.', href: '/schedule', icon: Calendar },
  { title: 'Appearance', description: 'Choose your theme, temperature controls and display preferences.', href: '/settings?section=appearance', icon: Palette },
  { title: 'Browser connection', description: 'Manage this browser’s owner session and view the controller source.', href: '/settings?section=connection', icon: KeyRound },
  { title: 'Device settings', description: 'Manage your Pod configuration and maintenance.', href: '/settings?section=device', icon: Cog },
  { title: 'System health', description: 'Inspect connectivity, sensor availability and diagnostics.', href: '/system', icon: Radio },
  { title: 'Home connections', description: 'Configure MQTT and Apple Home, and map bedroom measurements.', href: '/home', icon: House },
]

/** A stable settings hub; hardware controls remain on their existing guarded routes. */
export function MoreScreen() {
  const lang = langFromPath(usePathname())
  const hasBase = useBaseAvailable()
  return (
    <>
      <PageHeader title="More" />
      <div className="mb-2 flex flex-col gap-2">
        <h2 className="text-2xl font-medium tracking-tight">Make it yours.</h2>
        <p className="max-w-xl text-sm text-fg-2">Your routines, connections and preferences, all in one place.</p>
      </div>
      <div className="grid gap-3.5 min-[700px]:grid-cols-2">
        {SECTIONS.map(section => (
          <Link key={section.href} href={`/${lang}${section.href}`} className="group relative flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface p-[20px] text-fg no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cool hover:border-line-2 hover:bg-active hover:no-underline min-[700px]:flex-row min-[700px]:gap-4">
            <section.icon size={21} className="mt-0.5 shrink-0 text-cool" aria-hidden />
            <div className="min-w-0 flex-1 break-words min-[700px]:pr-5">
              <h3 className="text-base font-medium">{section.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-2">{section.description}</p>
            </div>
            <ArrowUpRight size={16} className="absolute right-[20px] top-[24px] text-fg-3" aria-hidden />
          </Link>
        ))}
      </div>
      {hasBase && (
        <Link href={`/${lang}/base`} className="rounded-card border border-line bg-surface p-5 text-fg no-underline hover:bg-active hover:no-underline">
          <h3 className="text-base font-medium">Adjustable base</h3>
          <p className="mt-2 text-sm text-fg-2">Open position controls, presets and Stop. Movement affects the whole bed.</p>
        </Link>
      )}
      <section className="flex flex-col items-start gap-4 rounded-card border border-line bg-surface p-[20px] min-[700px]:flex-row">
        <Sparkles size={21} className="mt-0.5 shrink-0 text-fg-2" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-2 break-words text-sm">
          <h3 className="text-base font-medium">AI & personal history</h3>
          <p className="max-w-2xl leading-relaxed text-fg-2">Use the native app for Apple Health history and private model settings. Review the Pod’s comfort learning and automation activity in Autopilot.</p>
          <Link href={`/${lang}/autopilot`} className="min-h-11 content-center text-link">Open Autopilot</Link>
        </div>
      </section>
      <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="min-h-11 content-center text-sm text-link">Setup & documentation ↗</a>
    </>
  )
}
