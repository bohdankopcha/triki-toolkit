import type { RateHz } from './core/protocol.js'

export interface TrikiTransportHandlers {
  /** сырой кусок notification с NUS TX */
  onData(chunk: Uint8Array): void
  onBattery(percent: number): void
  onDisconnect(): void
}

/**
 * Канал до жетона. Реализации: Web Bluetooth (браузер), подмена для тестов и повторов,
 * в перспективе Node (noble) для macOS-утилиты.
 */
export interface TrikiTransport {
  attach(handlers: TrikiTransportHandlers): void
  /** Для Web Bluetooth вызывать из обработчика клика (нужен жест пользователя). */
  connect(rate: RateHz): Promise<void>
  setRate(rate: RateHz): Promise<void>
  setLed(on: boolean): Promise<void>
  /** null, если регистра светодиода нет */
  readLed(): Promise<boolean | null>
  disconnect(): void
  readonly hasLed: boolean
}
