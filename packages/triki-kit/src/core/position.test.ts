import { describe, expect, it } from 'vitest'
import { createTriki } from '../triki.js'
import { PositionTracker, type PositionSegment } from './position.js'
import { synthesizeImu, type SynthOptions } from './synth.js'
import type { Vec3 } from './quat.js'

/** Синтетика через весь конвейер Triki (Madgwick, смещение нуля, выравнивание) и трекер позиции. */
function run(waypoints: Vec3[], synth: SynthOptions = {}, planar = false) {
  const track = synthesizeImu(waypoints, synth)
  const triki = createTriki({ warmupFrames: 0, stateThrottleMs: 0, beta: 0.03 })
  const tracker = new PositionTracker({ planar })
  const segs: PositionSegment[] = []
  triki.on('sample', (s) => {
    const seg = tracker.push(s, track.dt)
    triki.setBeta(tracker.suggestBeta())
    if (seg && dist(seg.from, seg.to) > 0.02) segs.push(seg) // мелкие сегменты - дрожь ориентации после остановки
  })
  triki.feed(track.samples, track.dt)
  return { tracker, segs }
}

const cm = (v: Vec3) => v.map((x) => Math.round(x * 1000) / 10)
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('PositionTracker', () => {
  // Пороги на синтетике с запасом: поправка ZUPT подобрана по записям живого жетона (scripts/recordings.test.ts),
  // где ошибка устроена иначе, чем в синтетике
  it('без шума: отрезок 20 см вправо с точностью до 1.5 см', () => {
    const { tracker, segs } = run([[0, 0, 0], [0.2, 0, 0]], { accNoiseG: 0, gyroNoiseDps: 0, quantize: false })
    expect(segs).toHaveLength(1)
    expect(dist(tracker.pos, [0.2, 0, 0])).toBeLessThan(0.015)
  })

  it('квадрат 20 см с шумом датчика: каждая вершина в пределах 2.5 см, ZUPT держит позицию в покое', () => {
    const sq: Vec3[] = [[0, 0, 0], [0.2, 0, 0], [0.2, 0.2, 0], [0, 0.2, 0], [0, 0, 0]]
    const { tracker, segs } = run(sq, { accBiasG: [0.004, -0.003, 0.002], gyroBiasDps: [0.4, -0.3, 0.2] })
    expect(segs).toHaveLength(4)
    segs.forEach((s, i) => expect(dist(s.to, sq[i + 1]), `вершина ${i + 1}: ${cm(s.to)}`).toBeLessThan(0.025))
    expect(dist(tracker.pos, [0, 0, 0])).toBeLessThan(0.03)
    expect(segs.every((s) => s.valid)).toBe(true)
  })

  it('подъём на 15 см ловится по Z', () => {
    const { tracker } = run([[0, 0, 0], [0, 0, 0.15]])
    expect(Math.abs(tracker.pos[2] - 0.15)).toBeLessThan(0.02)
  })

  it('режим плоскости: Z не интегрируется', () => {
    const { tracker } = run([[0, 0, 0], [0.1, 0.1, 0.1]], {}, true)
    expect(tracker.pos[2]).toBe(0)
    expect(dist(tracker.pos, [0.1, 0.1, 0])).toBeLessThan(0.02)
  })

  it('без шума остаточная скорость при остановке мала: ориентация не «съедает» разгон', () => {
    const track = synthesizeImu([[0, 0, 0], [0.2, 0, 0]], { accNoiseG: 0, gyroNoiseDps: 0, quantize: false })
    const triki = createTriki({ warmupFrames: 0, stateThrottleMs: 0, beta: 0.03 })
    const tracker = new PositionTracker()
    let v0 = Infinity
    triki.on('sample', (s) => {
      const seg = tracker.push(s, track.dt)
      triki.setBeta(tracker.suggestBeta())
      if (seg) v0 = Math.hypot(...seg.residualVel)
    })
    triki.feed(track.samples, track.dt)
    expect(v0).toBeLessThan(0.08)
  })

  it('после остановки показываемая позиция не уплывает дальше, даже при большой остаточной скорости', () => {
    // beta 0.08 в покое: ориентация успевает «съесть» часть разгона, остаточная скорость ~5-10 см/с, как бывает вживую
    const track = synthesizeImu([[0, 0, 0], [0.2, 0, 0]], { tailS: 2 })
    const triki = createTriki({ warmupFrames: 0, stateThrottleMs: 0, beta: 0.08 })
    const tracker = new PositionTracker()
    const stopIdx = track.truth.findIndex((p) => p[0] >= 0.2)
    let i = 0
    let shownMax = -Infinity
    let posMax = -Infinity
    let zuptS = -1
    let residual = 0
    triki.on('sample', (s) => {
      const seg = tracker.push(s, track.dt)
      triki.setBeta(tracker.suggestBeta(0.08, 0.08))
      if (i >= stopIdx) {
        shownMax = Math.max(shownMax, tracker.shown[0])
        posMax = Math.max(posMax, tracker.pos[0])
        if (seg && zuptS < 0) {
          zuptS = (i - stopIdx) * track.dt
          residual = Math.hypot(...seg.residualVel)
        }
      }
      i++
    })
    triki.feed(track.samples, track.dt)
    expect(residual, 'сценарий действительно с заметной остаточной скоростью').toBeGreaterThan(0.05)
    expect(zuptS, 'остановка признана быстро').toBeLessThan(0.3)
    // наружу уплывает только «живая» оценка (pos), но не то, что показываем
    expect(shownMax - Math.max(tracker.pos[0], 0.2)).toBeLessThan(0.01)
    expect(dist(tracker.shown, tracker.pos)).toBeLessThan(0.001)
    expect(posMax).toBeGreaterThanOrEqual(tracker.pos[0])
  })

  it('вращение во время движения (поворот 180°, наклон 30°, ошибка гироскопа 3%): все остановки найдены, ошибка < 10 см', () => {
    const sq: Vec3[] = [[0, 0, 0], [0.2, 0, 0], [0.2, 0.2, 0], [0, 0.2, 0], [0, 0, 0]]
    const { tracker, segs } = run(sq, { speed: 0.4, dwellS: 0.5, spinDeg: 180, tiltDeg: 30, gyroScaleErr: 0.03 })
    expect(segs).toHaveLength(4)
    segs.forEach((s, i) => expect(dist(s.to, sq[i + 1]), `вершина ${i + 1}: ${cm(s.to)}`).toBeLessThan(0.1))
    expect(dist(tracker.pos, [0, 0, 0])).toBeLessThan(0.1)
  })

  it('медленное движение (0.25 м/с) и прямая с сильным шумом распознаются', () => {
    const sq: Vec3[] = [[0, 0, 0], [0.2, 0, 0], [0.2, 0.2, 0]]
    expect(run(sq, { speed: 0.25 }).segs).toHaveLength(2)
    const line = run([[0, 0, 0], [0.3, 0, 0]], { speed: 0.4, accNoiseG: 0.009, gyroNoiseDps: 0.45 })
    expect(dist(line.tracker.pos, [0.3, 0, 0])).toBeLessThan(0.02)
  })

  it('без ZUPT позиция уплывает заметно сильнее', () => {
    const { tracker } = run([[0, 0, 0], [0.2, 0, 0], [0, 0, 0]], { accBiasG: [0.01, 0, 0], tailS: 5 })
    expect(dist(tracker.pos, [0, 0, 0])).toBeLessThan(0.03)
    expect(dist(tracker.rawPos, [0, 0, 0])).toBeGreaterThan(dist(tracker.pos, [0, 0, 0]) * 3)
  })
})
