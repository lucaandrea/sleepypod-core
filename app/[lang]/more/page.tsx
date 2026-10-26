import type { Metadata } from 'next'
import { MoreScreen } from '@/src/components/More/MoreScreen'

export const metadata: Metadata = { title: 'More' }

export default function MorePage() {
  return <MoreScreen />
}
