'use client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Gesture } from './core/gestures.js'
import { Triki, type TrikiEventMap, type TrikiOptions, type TrikiState } from './triki.js'

/**
 * Хук-обёртка над Triki. Состояние обновляется редко (не с частотой потока), поэтому перерисовок немного.
 * Непрерывные данные (ориентация, графики) берите через triki.on('sample') или читайте triki.sample в requestAnimationFrame.
 * При размонтировании соединение закрывается. Экземпляр создаётся один раз; опции читаются только при первом рендере.
 * Next.js: использовать только в клиентских компонентах; подключение (triki.connect) вызывать из обработчика клика.
 */
export function useTriki(options?: TrikiOptions): { triki: Triki; state: TrikiState } {
  const [triki] = useState(() => new Triki(options))
  const state = useSyncExternalStore(triki.subscribe, triki.getState, triki.getState)
  useEffect(() => () => triki.disconnect(), [triki])
  return { triki, state }
}

/** Подписка на событие потока на время жизни компонента; обработчик можно менять между рендерами. */
export function useTrikiEvent<K extends keyof TrikiEventMap>(triki: Triki, name: K, handler: (payload: TrikiEventMap[K]) => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => triki.on(name, (p) => ref.current(p)), [triki, name])
}

/** Подписка на жест по шаблону id ("flip", "roll.*.90", "circle.cw"). См. Triki.onGesture. */
export function useGesture(triki: Triki, pattern: string, handler: (g: Gesture) => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => triki.onGesture(pattern, (g) => ref.current(g)), [triki, pattern])
}
