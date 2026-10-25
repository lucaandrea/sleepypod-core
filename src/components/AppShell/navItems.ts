import type { LucideIcon } from 'lucide-react'
import { BedDouble, Calendar, Moon, Radio, Settings, Sparkles, Thermometer, House, Ellipsis } from 'lucide-react'

export type NavId = 'temp' | 'base' | 'autopilot' | 'schedule' | 'sleep' | 'system' | 'settings' | 'home' | 'more'

export interface NavItem {
  id: NavId
  label: string
  icon: LucideIcon
  href: string
  /** Legacy paths that should highlight this tab. */
  aliases?: string[]
}

/** User documentation (setup, features, troubleshooting). */
export const DOCS_URL = 'https://sleepypod.github.io/'

/** Secondary routes stay available through Tonight and More. */
export const DETAIL_NAV_ITEMS: NavItem[] = [
  { id: 'base', label: 'Base', icon: BedDouble, href: '/base' },
  { id: 'schedule', label: 'Schedule', icon: Calendar, href: '/schedule' },
  { id: 'system', label: 'System', icon: Radio, href: '/system', aliases: ['/sensors', '/debug', '/status'] },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
]

export const NAV_ITEMS: NavItem[] = [
  { id: 'temp', label: 'Tonight', icon: Thermometer, href: '/' },
  { id: 'sleep', label: 'Sleep', icon: Moon, href: '/sleep', aliases: ['/data'] },
  { id: 'autopilot', label: 'Autopilot', icon: Sparkles, href: '/autopilot' },
  { id: 'home', label: 'Home', icon: House, href: '/home' },
  { id: 'more', label: 'More', icon: Ellipsis, href: '/more' },
]

export function primaryNavId(pathname: string | null | undefined): NavId {
  const detail = activeNavId(pathname)
  if (detail === 'base') return 'temp'
  if (['settings', 'system', 'schedule'].includes(detail)) return 'more'
  return detail
}

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
  const p = pathWithoutLang(pathname)
  for (const item of [...NAV_ITEMS, ...DETAIL_NAV_ITEMS]) {
    if (item.href === '/') continue
    const prefixes = [item.href, ...(item.aliases ?? [])]
    if (prefixes.some(h => p === h || p.startsWith(`${h}/`))) return item.id
  }
  return 'temp'
}
