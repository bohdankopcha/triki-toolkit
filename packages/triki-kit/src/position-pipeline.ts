import { PositionTracker, type PositionOptions, type PositionSegment } from './core/position.js'
import type { Triki, TrikiSample } from './triki.js'

/**
 * Трекер позиции, подключённый к потоку Triki: шаг времени по меткам кадров, усиление Madgwick по подсказке трекера
 * (почти 0 в движении). Один и тот же код в живой странице и в повторе записи, поэтому результаты совпадают.
 */
export class PositionPipeline {
  tracker: PositionTracker
  private lastT: number | null = null
  private readonly off: () => void

  constructor(
    private readonly triki: Triki,
    private options: PositionOptions = {},
    private readonly onFrame?: (s: TrikiSample, seg: PositionSegment | null) => void,
  ) {
    this.tracker = new PositionTracker(options)
    this.off = triki.on('sample', (s) => this.frame(s))
  }

  /** Новый трекер (например, при подключении или смене опций). */
  reset(options: PositionOptions = this.options): void {
    this.options = options
    this.tracker = new PositionTracker(options)
    this.lastT = null
  }

  dispose(): void {
    this.off()
  }

  private frame(s: TrikiSample): void {
    const dt = this.lastT === null ? 0 : s.t - this.lastT
    this.lastT = s.t
    if (dt <= 0 || dt > 0.2) return // первый кадр или разрыв сессии
    const seg = this.tracker.push(s, dt)
    this.triki.setBeta(this.tracker.suggestBeta())
    this.onFrame?.(s, seg)
  }
}
