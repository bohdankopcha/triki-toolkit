import type { PositionSegment } from './position.js'

/** Направления на столе в мировых осях: up - от пользователя (+Y), right - вправо (+X). */
export type Dir2D = 'up' | 'down' | 'left' | 'right' | 'upright' | 'upleft' | 'downright' | 'downleft'

const D = Math.SQRT1_2
export const DIR2D_VEC: Record<Dir2D, readonly [number, number]> = {
  up: [0, 1], down: [0, -1], right: [1, 0], left: [-1, 0],
  upright: [D, D], upleft: [-D, D], downright: [D, -D], downleft: [-D, -D],
}

export const DIR2D_LABEL: Record<Dir2D, string> = {
  up: 'вверх (от себя)', down: 'вниз (к себе)', right: 'вправо', left: 'влево',
  upright: 'вверх-вправо', upleft: 'вверх-влево', downright: 'вниз-вправо', downleft: 'вниз-влево',
}

/**
 * Пары «туда - обратно»: после каждой пары жетон должен вернуться в исходную точку, поэтому сантиметры не нужны.
 * Невозврат после пары и отклонение направления показывают ошибку оценки.
 */
export const SEQUENCE_2D: readonly Dir2D[] = [
  'up', 'down', 'right', 'left', 'left', 'right', 'down', 'up',
  'upright', 'downleft', 'upleft', 'downright', 'downright', 'upleft', 'downleft', 'upright',
]

export interface StepResult {
  index: number
  dir: Dir2D
  /** смещение по столу, м: [x, y] */
  d: [number, number]
  t0: number
  t1: number
  rotDeg: number
  skipped?: boolean
}

/**
 * Проведение эксперимента: каждый законченный трекером сегмент длиннее minStepM засчитывается как очередной шаг.
 * Мелкие сегменты (дрожь после остановки) игнорируются. Пользователь может отменить шаг или пропустить его.
 */
export class Experiment2D {
  readonly results: StepResult[] = []

  constructor(readonly sequence: readonly Dir2D[] = SEQUENCE_2D, readonly minStepM = 0.03) {}

  get index(): number {
    return this.results.length
  }

  get done(): boolean {
    return this.results.length >= this.sequence.length
  }

  get expected(): Dir2D | null {
    return this.sequence[this.index] ?? null
  }

  onSegment(seg: PositionSegment): StepResult | null {
    const dir = this.expected
    if (!dir) return null
    const d: [number, number] = [seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]]
    if (Math.hypot(d[0], d[1]) < this.minStepM) return null
    const r: StepResult = { index: this.index, dir, d, t0: seg.t0, t1: seg.t1, rotDeg: seg.rotDeg }
    this.results.push(r)
    return r
  }

  undo(): void {
    this.results.pop()
  }

  skip(): void {
    const dir = this.expected
    if (dir) this.results.push({ index: this.index, dir, d: [0, 0], t0: 0, t1: 0, rotDeg: 0, skipped: true })
  }
}

export interface StepScore {
  index: number
  dir: Dir2D
  lengthCm: number
  /** угол от ожидаемого направления до фактического, градусы, + против часовой */
  angleErrDeg: number
}

export interface PairScore {
  first: number
  /** насколько не вернулись в исходную точку после пары, см */
  closureCm: number
  /** то же в процентах от средней длины движения пары */
  closurePct: number
  /** длина обратного движения к длине прямого */
  lengthRatio: number
}

export interface ExperimentScore {
  steps: StepScore[]
  pairs: PairScore[]
  /** средняя ошибка направления со знаком: общий поворот осей (heading) */
  meanAngleDeg: number
  /** средний модуль ошибки направления после вычета общего поворота: разброс */
  scatterAngleDeg: number
  maxAbsAngleDeg: number
  meanClosureCm: number
  meanClosurePct: number
  /** конец последовательности от начала (в идеале 0), см */
  finalCm: number
  pathCm: number
  /** finalCm / pathCm, % */
  driftPct: number
  skipped: number
}

const deg = (r: number) => (r * 180) / Math.PI
const wrap = (a: number) => ((a + 540) % 360) - 180

export function scoreExperiment(results: readonly StepResult[]): ExperimentScore {
  const valid = results.filter((r) => !r.skipped)
  const steps: StepScore[] = valid.map((r) => {
    const [ex, ey] = DIR2D_VEC[r.dir]
    const a = Math.atan2(ex * r.d[1] - ey * r.d[0], ex * r.d[0] + ey * r.d[1])
    return { index: r.index, dir: r.dir, lengthCm: Math.hypot(r.d[0], r.d[1]) * 100, angleErrDeg: deg(a) }
  })
  const pairs: PairScore[] = []
  for (let i = 0; i + 1 < results.length; i += 2) {
    const a = results[i]
    const b = results[i + 1]
    if (a.skipped || b.skipped) continue
    const la = Math.hypot(a.d[0], a.d[1])
    const lb = Math.hypot(b.d[0], b.d[1])
    const c = Math.hypot(a.d[0] + b.d[0], a.d[1] + b.d[1])
    pairs.push({ first: i, closureCm: c * 100, closurePct: (c / ((la + lb) / 2)) * 100, lengthRatio: lb / la })
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
  const meanAngle = mean(steps.map((s) => s.angleErrDeg))
  const end = valid.reduce((p, r) => [p[0] + r.d[0], p[1] + r.d[1]], [0, 0])
  const pathCm = mean(steps.map((s) => s.lengthCm)) * steps.length
  const finalCm = Math.hypot(end[0], end[1]) * 100
  return {
    steps,
    pairs,
    meanAngleDeg: meanAngle,
    scatterAngleDeg: mean(steps.map((s) => Math.abs(wrap(s.angleErrDeg - meanAngle)))),
    maxAbsAngleDeg: Math.max(0, ...steps.map((s) => Math.abs(s.angleErrDeg))),
    meanClosureCm: mean(pairs.map((p) => p.closureCm)),
    meanClosurePct: mean(pairs.map((p) => p.closurePct)),
    finalCm,
    pathCm,
    driftPct: pathCm > 0 ? (finalCm / pathCm) * 100 : 0,
    skipped: results.length - valid.length,
  }
}
