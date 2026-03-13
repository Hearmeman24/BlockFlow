'use client'

export function StatusBar({ message }: { message: string }) {
  if (!message) return null
  return (
    <div className="text-xs text-muted-foreground px-1 py-2">
      {message}
    </div>
  )
}
