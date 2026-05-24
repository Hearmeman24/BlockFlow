import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'BlockFlow',
  description: 'Local-only pipeline UI for video and image generation.',
}

export default function Home() {
  redirect('/generate')
}
