import { describe, expect, it } from 'vitest'
import { MotionAnalyzer, type TrikiEvent } from './analyzer'
import { classifyPolygon } from './shapes'
import { GestureMapper } from './gestures'
import type { Pt } from './circle'
import type { Sample } from './parser'

const DT = 1 / 104
const G = 9.80665

const polyline = (v: Pt[], perEdge = 20): Pt[] => {
  const out: Pt[] = []
  v.forEach((a, i) => {
    const b = v[(i + 1) % v.length]
    for (let k = 0; k < perEdge; k++) out.push([a[0] + ((b[0] - a[0]) * k) / perEdge, a[1] + ((b[1] - a[1]) * k) / perEdge])
  })
  return out
}
const SQ: Pt[] = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]] // против часовой
const TR: Pt[] = [[0, 0], [0.12, 0], [0.06, 0.104]] // против часовой
const rev = (v: Pt[]) => [...v].reverse()

describe('classifyPolygon', () => {
  it('квадрат: направление определяется', () => {
    expect(classifyPolygon(polyline(SQ))).toMatchObject({ shape: 'square', ccw: true })
    expect(classifyPolygon(polyline(rev(SQ)))).toMatchObject({ shape: 'square', ccw: false })
  })
  it('треугольник: направление определяется', () => {
    expect(classifyPolygon(polyline(TR))).toMatchObject({ shape: 'triangle', ccw: true })
    expect(classifyPolygon(polyline(rev(TR)))).toMatchObject({ shape: 'triangle', ccw: false })
  })
  it('прямоугольник 2:1 считается квадратом, 4:1 нет', () => {
    const r = (w: number): Pt[] => [[0, 0], [w, 0], [w, 0.1], [0, 0.1]]
    expect(classifyPolygon(polyline(r(0.2)))?.shape).toBe('square')
    expect(classifyPolygon(polyline(r(0.4)))).toBeNull()
  })
  it('круг, линия туда-обратно и незамкнутая «П» не фигуры', () => {
    const circle: Pt[] = Array.from({ length: 120 }, (_, i) => [0.05 * Math.cos((i / 120) * 2 * Math.PI), 0.05 * Math.sin((i / 120) * 2 * Math.PI)])
    expect(classifyPolygon(circle)).toBeNull()
    const line = polyline([[0, 0], [0.15, 0]], 30)
    expect(classifyPolygon(line)).toBeNull()
    const u = polyline([[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]]).slice(0, 60)
    expect(classifyPolygon(u)).toBeNull()
  })
  it('слишком мелкая фигура не считается', () => {
    expect(classifyPolygon(polyline(SQ.map(([x, y]) => [x * 0.2, y * 0.2] as Pt)))).toBeNull()
  })
})

/** Движение по вершинам: каждое ребро от покоя до покоя (smoothstep), между рёбрами пауза dwell. */
function strokes(vertices: Pt[], speed = 0.25, dwell = 0, closed = true) {
  const pos: Pt[] = []
  const pad = 4
  const hold = (p: Pt, n: number) => { for (let i = 0; i < n; i++) pos.push(p) }
  hold(vertices[0], pad)
  const n = closed ? vertices.length : vertices.length - 1
  for (let e = 0; e < n; e++) {
    const a = vertices[e]
    const b = vertices[(e + 1) % vertices.length]
    const steps = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / speed / DT))
    for (let k = 1; k <= steps; k++) {
      const x = k / steps
      const s = 3 * x * x - 2 * x * x * x
      pos.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s])
    }
    if (dwell && e < n - 1) hold(b, Math.round(dwell / DT))
  }
  hold(vertices[closed ? 0 : vertices.length - 1], pad)
  return pos.map((_, i) => {
    const p0 = pos[Math.max(0, i - 1)]
    const p1 = pos[i]
    const p2 = pos[Math.min(pos.length - 1, i + 1)]
    return { ax: (p2[0] - 2 * p1[0] + p0[0]) / DT ** 2 / G, ay: (p2[1] - 2 * p1[1] + p0[1]) / DT ** 2 / G }
  })
}

function drive(acc: { ax: number; ay: number }[], noise = 0, seed = 7): TrikiEvent[] {
  let sd = seed
  const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647 - 0.5) * 2
  const a = new MotionAnalyzer()
  const ev: TrikiEvent[] = []
  const push = (s: Partial<Sample>) => ev.push(...a.push({ gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 1, ...s }, [1, 0, 0, 0], DT))
  for (let i = 0; i < 160; i++) push({})
  for (const m of acc) push({ ax: m.ax + rnd() * noise, ay: m.ay + rnd() * noise, az: 1 + rnd() * noise })
  for (let i = 0; i < 100; i++) push({})
  return ev
}
const shapes = (ev: TrikiEvent[]) => ev.filter((e) => e.kind === 'shape')

describe('фигуры из движения', () => {
  it.each([
    ['квадрат против часовой', SQ, 'square', 'ccw'],
    ['квадрат по часовой', rev(SQ), 'square', 'cw'],
    ['треугольник против часовой', TR, 'triangle', 'ccw'],
    ['треугольник по часовой', rev(TR), 'triangle', 'cw'],
  ] as const)('непрерывно: %s', (_n, v, shape, dir) => {
    const ev = drive(strokes(v as Pt[]))
    expect(shapes(ev)).toHaveLength(1)
    expect(shapes(ev)[0].data).toMatchObject({ shape, dir, strokes: 1 })
    expect(ev.filter((e) => e.kind === 'circle')).toHaveLength(0)
  })

  it('штрихами с паузой 0.5 с на каждом углу: те же фигуры, 4 штриха', () => {
    const ev = drive(strokes(SQ, 0.25, 0.5))
    expect(shapes(ev)).toHaveLength(1)
    expect(shapes(ev)[0].data).toMatchObject({ shape: 'square', dir: 'ccw', strokes: 4 })
    expect(ev.filter((e) => e.kind === 'move')).toHaveLength(3) // штрихи 1-3 ушли отдельными смещениями
  })

  it('треугольник штрихами', () => {
    const ev = drive(strokes(rev(TR), 0.25, 0.5))
    expect(shapes(ev)[0].data).toMatchObject({ shape: 'triangle', dir: 'cw', strokes: 3 })
  })

  it('с шумом акселерометра 0.01 g', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const ev = drive(strokes(SQ), 0.01, seed)
      expect(shapes(ev).map((e) => e.data?.shape)).toEqual(['square'])
    }
  })

  it('«П» из трёх штрихов и прямой ход туда-обратно фигурой не считаются', () => {
    expect(shapes(drive(strokes([[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]], 0.25, 0.5, false)))).toHaveLength(0)
    expect(shapes(drive(strokes([[0, 0], [0.12, 0], [0, 0]], 0.25, 0.5, false)))).toHaveLength(0)
  })

  it('лента: штрихи заменяются одной фигурой', () => {
    const ev = drive(strokes(SQ, 0.25, 0.5))
    const m = new GestureMapper()
    ev.forEach((e) => m.push(e))
    expect(m.list.map((g) => g.id)).toEqual(['square.ccw'])
  })
})
