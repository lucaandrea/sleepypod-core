import Link from 'next/link'
import { OwnerSessionControls } from '@/src/components/AppShell/OwnerSessionControls'

const destinations = [
  { href: '/schedule', title: 'Routines & wake alarms', detail: 'The timing and temperatures your night is built around.' },
  { href: '/base', title: 'Bed position', detail: 'Reported angles, position previews and a prominent Stop control.' },
  { href: '/settings', title: 'Connections & preferences', detail: 'Your sides, appearance, Apple Home and MQTT.' },
  { href: '/system', title: 'System health', detail: 'Connection freshness, diagnostics, backups and controller status.' },
]

export default async function MorePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params
  return (
    <>
      <header>
        <p className="text-sm text-fg-2">YOUR SPACE</p>
        <h1 className="mt-2 text-3xl font-medium">Make it yours.</h1>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {destinations.map(item => (
          <Link key={item.href} href={`/${lang}${item.href}`} className="rounded-card border border-line bg-surface p-6 no-underline hover:border-cool hover:no-underline">
            <h2 className="text-lg font-medium text-fg">{item.title}</h2>
            <p className="mt-2 text-sm text-fg-2">{item.detail}</p>
          </Link>
        ))}
      </div>
      <OwnerSessionControls />
      <section className="rounded-card border border-line bg-surface p-6 text-sm text-fg-2">
        <h2 className="mb-2 text-lg text-fg">Built on open foundations</h2>
        <p>Local control built on SleepyPod Core. The source includes our Pod 4 compatibility and owner-access changes.</p>
        <a href="https://github.com/lucaandrea/sleepypod-core" className="mt-3 inline-block text-link" target="_blank" rel="noopener noreferrer">Controller source & AGPL license</a>
      </section>
    </>
  )
}
