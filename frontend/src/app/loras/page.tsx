import { redirect } from 'next/navigation'

export default function LorasPage() {
  redirect('/models?folder=loras')
}
