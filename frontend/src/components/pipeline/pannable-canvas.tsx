'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from 'react-zoom-pan-pinch'

export const PAN_DISABLED_CLASS = 'panningDisabled'
export const WHEEL_DISABLED_CLASS = 'wheelDisabled'

interface PannableCanvasProps {
  children: ReactNode
}

export function PannableCanvas({ children }: PannableCanvasProps) {
  const [isPanning, setIsPanning] = useState(false)

  const clearPanning = useCallback(() => setIsPanning(false), [])

  const recoverInvalidTransform = useCallback((ref: ReactZoomPanPinchRef) => {
    const { scale, positionX, positionY } = ref.state
    if (
      !Number.isFinite(scale) ||
      !Number.isFinite(positionX) ||
      !Number.isFinite(positionY)
    ) {
      ref.resetTransform(0)
      clearPanning()
    }
  }, [clearPanning])

  useEffect(() => {
    const handleGlobalPointerEnd = () => clearPanning()
    window.addEventListener('mouseup', handleGlobalPointerEnd)
    window.addEventListener('touchend', handleGlobalPointerEnd)
    window.addEventListener('blur', handleGlobalPointerEnd)
    return () => {
      window.removeEventListener('mouseup', handleGlobalPointerEnd)
      window.removeEventListener('touchend', handleGlobalPointerEnd)
      window.removeEventListener('blur', handleGlobalPointerEnd)
    }
  }, [clearPanning])

  return (
    <div
      className="relative w-full h-full"
      style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
    >
      <TransformWrapper
        limitToBounds={false}
        centerZoomedOut={false}
        centerOnInit={false}
        minScale={0.3}
        maxScale={2}
        doubleClick={{ disabled: true }}
        alignmentAnimation={{ disabled: true }}
        panning={{ excluded: [PAN_DISABLED_CLASS] }}
        wheel={{ excluded: [WHEEL_DISABLED_CLASS], step: 0.1 }}
        onInit={(ref) => {
          recoverInvalidTransform(ref)
        }}
        onTransformed={(ref) => {
          recoverInvalidTransform(ref)
        }}
        onPanningStart={() => setIsPanning(true)}
        onPanningStop={clearPanning}
      >
        {({ resetTransform }) => (
          <>
            <button
              type="button"
              className="absolute right-3 top-3 z-20 rounded-md border border-border/70 bg-card/80 px-2 py-1 text-xs text-foreground shadow-sm backdrop-blur panningDisabled wheelDisabled hover:bg-accent/70"
              onClick={() => resetTransform(150)}
              title="Recenter canvas"
            >
              Recenter
            </button>
            <TransformComponent
              wrapperStyle={{ width: '100%', height: '100%' }}
              contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {children}
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  )
}
