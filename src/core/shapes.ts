import type { Pt } from './circle'

export interface PolygonShape {
  shape: 'square' | 'triangle'
  /** true = против часовой при взгляде сверху (X вправо, Y вперёд) */
  ccw: boolean
  /** периметр траектории, м */
  perimeterM: number
}

const N = 60 // точек после равномерной передискретизации по длине
const W = 4 // окно хорд для оценки поворота, точек
const CORNER_MIN_DEG = 45 // окружность даёт ~24° на окно, углы квадрата/треугольника 60-120°
const MIN_PERIMETER_M = 0.1
const MAX_PERIMETER_M = 3
const MAX_CLOSURE = 0.18 // зазор между концом и началом / периметр

const wrap = (a: number) => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a)
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

function resampleClosed(pts: readonly Pt[]): Pt[] {
  const ring: Pt[] = [...pts, pts[0]]
  const cum = [0]
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + dist(ring[i - 1], ring[i]))
  const total = cum[cum.length - 1]
  const out: Pt[] = []
  let seg = 1
  for (let k = 0; k < N; k++) {
    const target = (k * total) / N
    while (seg < cum.length - 1 && cum[seg] < target) seg++
    const l = cum[seg] - cum[seg - 1]
    const f = l > 0 ? (target - cum[seg - 1]) / l : 0
    out.push([ring[seg - 1][0] + f * (ring[seg][0] - ring[seg - 1][0]), ring[seg - 1][1] + f * (ring[seg][1] - ring[seg - 1][1])])
  }
  return out
}

/**
 * Квадрат или треугольник по замкнутой траектории: считаем число «углов» (всплесков поворота направления),
 * у окружности их нет, у линии «туда-обратно» два по 180°. Прямоугольник до 2:1 считается квадратом.
 */
export function classifyPolygon(path: readonly Pt[]): PolygonShape | null {
  if (path.length < 8) return null
  let len = 0
  for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i])
  const gap = dist(path[0], path[path.length - 1])
  const perimeter = len + gap
  if (perimeter < MIN_PERIMETER_M || perimeter > MAX_PERIMETER_M || gap > MAX_CLOSURE * perimeter) return null

  const P = resampleClosed(path)
  let area = 0
  for (let i = 0; i < N; i++) {
    const a = P[i]
    const b = P[(i + 1) % N]
    area += a[0] * b[1] - b[0] * a[1]
  }
  if (Math.abs(area) < 1e-9) return null

  const turn: number[] = []
  for (let i = 0; i < N; i++) {
    const p = P[(i - W + N) % N]
    const q = P[i]
    const r = P[(i + W) % N]
    const t = wrap(Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0]))
    turn.push((t * 180) / Math.PI)
  }

  const sign = Math.sign(area)
  const hot = turn.map((t) => Math.abs(t) >= CORNER_MIN_DEG)
  const start = hot.indexOf(false)
  if (start < 0) return null
  const corners: { idx: number; deg: number }[] = []
  let best = -1
  for (let k = 1; k <= N; k++) {
    const i = (start + k) % N
    if (hot[i]) {
      if (best < 0 || Math.abs(turn[i]) > Math.abs(turn[best])) best = i
    } else if (best >= 0) {
      corners.push({ idx: best, deg: turn[best] })
      best = -1
    }
  }
  if (best >= 0) corners.push({ idx: best, deg: turn[best] })

  const K = corners.length
  if (K !== 3 && K !== 4) return null
  if (corners.some((c) => Math.sign(c.deg) !== sign)) return null
  const edges = corners.map((c, i) => (corners[(i + 1) % K].idx - c.idx + N) % N)
  const ratio = Math.min(...edges) / Math.max(...edges)
  const strengths = corners.map((c) => Math.abs(c.deg))
  if (K === 4) {
    if (ratio < 0.45 || strengths.some((s) => s < 55 || s > 150)) return null
    return { shape: 'square', ccw: area > 0, perimeterM: perimeter }
  }
  if (ratio < 0.3 || strengths.some((s) => s < 70 || s > 165)) return null
  return { shape: 'triangle', ccw: area > 0, perimeterM: perimeter }
}
