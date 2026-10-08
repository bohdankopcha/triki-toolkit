export type Pt = readonly [number, number]

export interface Circle {
  /** сколько градусов траектория «намотала» вокруг своего центра; > 0 = против часовой при взгляде сверху (X вправо, Y вперёд) */
  windingDeg: number
  /** средний радиус, м */
  radiusM: number
  /** разброс радиуса / средний радиус: 0 = идеальная окружность, ~ линия даёт > 0.6 */
  roundness: number
}

/** Анализ траектории на «круговость». null, если точек мало или траектория вырождена. */
export function analyzeCircle(path: readonly Pt[]): Circle | null {
  const n = path.length
  if (n < 8) return null
  let cx = 0
  let cy = 0
  for (const [x, y] of path) {
    cx += x
    cy += y
  }
  cx /= n
  cy /= n
  const r = path.map(([x, y]) => Math.hypot(x - cx, y - cy))
  const mean = r.reduce((a, b) => a + b, 0) / n
  if (mean < 1e-6) return null
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / n)

  let wind = 0
  for (let i = 1; i < n; i++) {
    if (r[i] < mean * 0.3 || r[i - 1] < mean * 0.3) continue // около центра угол шумит
    const a0 = Math.atan2(path[i - 1][1] - cy, path[i - 1][0] - cx)
    const a1 = Math.atan2(path[i][1] - cy, path[i][0] - cx)
    let d = a1 - a0
    if (d > Math.PI) d -= 2 * Math.PI
    else if (d < -Math.PI) d += 2 * Math.PI
    wind += d
  }
  return { windingDeg: (wind * 180) / Math.PI, radiusM: mean, roundness: sd / mean }
}
