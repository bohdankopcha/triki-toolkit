import type { RateHz } from './core/protocol.js'
import { Triki, type TrikiOptions } from './triki.js'

/**
 * Запись сессии: сырые куски notification с временем прихода и метки действий пользователя.
 * Только данные IMU: серийного номера и MAC здесь нет.
 */
export interface TrikiRecording {
  format: 'triki-recording'
  version: 1
  /** ISO-время начала записи (для имени и порядка, в обработке не участвует) */
  startedAt: string
  rateHz: RateHz
  /** время прихода каждого куска, мс (часы performance.now) */
  t: number[]
  /** куски в base64 */
  data: string[]
  /** действия пользователя: к какому куску (индекс) привязаны */
  marks: RecordingMark[]
  /** что угодно ещё, например, результаты, которые видел пользователь */
  meta?: Record<string, unknown>
}

export interface RecordingMark {
  /** действие выполнено после обработки куска с этим индексом (-1: до первого) */
  chunk: number
  type: string
  data?: unknown
}

/** Пишет сырой поток Triki. Подключить до connect(): `const rec = new Recorder(triki)`. */
export class Recorder {
  readonly t: number[] = []
  readonly data: string[] = []
  readonly marks: RecordingMark[] = []
  private readonly startedAt = new Date().toISOString()
  private readonly off: () => void

  constructor(private readonly triki: Triki, private readonly maxChunks = 200_000) {
    this.off = triki.on('raw', ({ bytes, t }) => {
      if (this.t.length >= this.maxChunks) return
      this.t.push(t)
      this.data.push(toBase64(bytes))
    })
  }

  /** Метка на текущем месте потока. */
  mark(type: string, data?: unknown): void {
    this.marks.push({ chunk: this.t.length - 1, type, data })
  }

  clear(): void {
    this.t.length = 0
    this.data.length = 0
    this.marks.length = 0
  }

  dispose(): void {
    this.off()
  }

  toJSON(meta?: Record<string, unknown>): TrikiRecording {
    return {
      format: 'triki-recording', version: 1, startedAt: this.startedAt, rateHz: this.triki.getState().rateHz,
      t: [...this.t], data: [...this.data], marks: [...this.marks], meta,
    }
  }
}

export interface ReplayHandlers {
  /** вызывается сразу после создания Triki: подписаться на sample и т.п. */
  setup?(triki: Triki): void
  /** после обработки каждого куска; метки этого куска передаются тут же */
  chunk?(index: number, marks: RecordingMark[]): void
}

/**
 * Повтор записи: новый Triki с часами из записи, куски скармливаются в исходном порядке. При тех же опциях и тех же
 * действиях в обработчиках результат совпадает с живой сессией бит в бит.
 */
export function replayRecording(rec: TrikiRecording, handlers: ReplayHandlers = {}, options: TrikiOptions = {}): Triki {
  let now = rec.t[0] ?? 0
  const triki = new Triki({ rate: rec.rateHz, ...options, now: () => now })
  // тот же сброс конвейера, что делает connect() (в том числе сдвиг часов сессии): без него метки времени кадров
  // отличаются на константу и шаг по ним округляется иначе. Транспорта нет, поэтому на устройство ничего не уходит
  void triki.setRate(rec.rateHz)
  handlers.setup?.(triki)
  const byChunk = new Map<number, RecordingMark[]>()
  for (const m of rec.marks) byChunk.set(m.chunk, [...(byChunk.get(m.chunk) ?? []), m])
  const before = byChunk.get(-1)
  if (before) handlers.chunk?.(-1, before)
  for (let i = 0; i < rec.data.length; i++) {
    now = rec.t[i]
    triki.push(fromBase64(rec.data[i]))
    handlers.chunk?.(i, byChunk.get(i) ?? [])
  }
  triki.flush()
  return triki
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
