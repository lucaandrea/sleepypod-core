import type { LucideIcon } from 'lucide-react'
import { BedDouble, Calendar, ChartNoAxesColumn, CircleEllipsis, MoonStar, Radio, Settings, Sparkles, House } from 'lucide-react'

export type NavId = 'tonight' | 'sleep' | 'autopilot' | 'home' | 'more'
type SecondaryNavId = 'base' | 'schedule' | 'system' | 'settings'

export interface NavItem<Id extends string = NavId> {
  id: Id
  label: string
  icon: LucideIcon
  href: string
  /** Legacy paths that should highlight this tab. */
  aliases?: string[]
}

/** User documentation (setup, features, troubleshooting). */
export const DOCS_URL = 'https://sleepypod.github.io/'

/** The same five destinations and order as the independently implemented native app. */
export const NAV_ITEMS: NavItem[] = [
  { id: 'tonight', label: 'Tonight', icon: MoonStar, href: '/', aliases: ['/base', '/schedule'] },
  { id: 'sleep', label: 'Sleep', icon: ChartNoAxesColumn, href: '/sleep', aliases: ['/data'] },
  { id: 'autopilot', label: 'Autopilot', icon: Sparkles, href: '/autopilot' },
  { id: 'home', label: 'Home', icon: House, href: '/home' },
  { id: 'more', label: 'More', icon: CircleEllipsis, href: '/more', aliases: ['/settings', '/system', '/sensors', '/debug', '/status'] },
]

/** Secondary routes remain bookmark-compatible and reachable from Tonight or More. */
export const SECONDARY_NAV_ITEMS: NavItem<SecondaryNavId>[] = [
  { id: 'schedule', label: 'Routines & wake alarms', icon: Calendar, href: '/schedule' },
  { id: 'base', label: 'Base', icon: BedDouble, href: '/base' },
  { id: 'system', label: 'System', icon: Radio, href: '/system', aliases: ['/sensors', '/debug', '/status'] },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
]

export const PHONE_NAV_ITEMS = NAV_ITEMS

/** Strip the /[lang] prefix: /en/schedule → /schedule. */
export function pathWithoutLang(pathname: string | null | undefined): string {
  if (!pathname) return '/'
  const rest = '/' + pathname.split('/').slice(2).join('/')
  return rest === '' ? '/' : rest
}

export function langFromPath(pathname: string | null | undefined): string {
  return pathname?.split('/')[1] || 'en'
}

export function activeNavId(pathname: string | null | undefined): NavId {
  return matchedNavItem(pathname)?.id ?? 'tonight'
}

/** Unknown paths have no swipe target, even though the shell defaults to Tonight. */
export function matchedNavItem(pathname: string | null | undefined): NavItem | undefined {
  const path = pathWithoutLang(pathname)
  return NAV_ITEMS.find(item => [item.href, ...(item.aliases ?? [])]
    .some(prefix => path === prefix || (prefix !== '/' && path.startsWith(`${prefix}/`))))
}
