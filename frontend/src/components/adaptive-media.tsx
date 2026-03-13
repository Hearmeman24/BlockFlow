'use client'

import { useState } from 'react'

const DEFAULT_ASPECT_RATIO = 16 / 9
const MIN_ASPECT_RATIO = 1 / 3
const MAX_ASPECT_RATIO = 3

function clampAspectRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ASPECT_RATIO
  return Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, value))
}

function useAdaptiveAspectRatio() {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_ASPECT_RATIO)

  return {
    aspectRatio,
    setFromDimensions: (width: number, height: number) => {
      if (width > 0 && height > 0) {
        setAspectRatio(clampAspectRatio(width / height))
      }
    },
  }
}

interface AdaptiveVideoFrameProps {
  src: string
  className?: string
  controls?: boolean
}

export function AdaptiveVideoFrame({
  src,
  className = 'w-full h-full object-contain',
  controls = true,
}: AdaptiveVideoFrameProps) {
  const { aspectRatio, setFromDimensions } = useAdaptiveAspectRatio()

  return (
    <div
      className="relative w-full rounded overflow-hidden bg-black"
      style={{ aspectRatio }}
    >
      <video
        src={src}
        controls={controls}
        className={className}
        preload="metadata"
        onLoadedMetadata={(event) => {
          setFromDimensions(event.currentTarget.videoWidth, event.currentTarget.videoHeight)
        }}
      />
    </div>
  )
}

interface AdaptiveImageFrameProps {
  src: string
  alt?: string
  className?: string
}

export function AdaptiveImageFrame({
  src,
  alt = 'image',
  className = 'w-full h-full object-contain',
}: AdaptiveImageFrameProps) {
  const { aspectRatio, setFromDimensions } = useAdaptiveAspectRatio()

  return (
    <div
      className="relative w-full rounded overflow-hidden bg-black"
      style={{ aspectRatio }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic output URLs */}
      <img
        src={src}
        alt={alt}
        className={className}
        onLoad={(event) => {
          setFromDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
        }}
      />
    </div>
  )
}
