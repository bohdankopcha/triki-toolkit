import { describe, expect, it } from 'vitest'
import { createTriki } from '../triki.js'
import { DIR2D_VEC, Experiment2D, SEQUENCE_2D, scoreExperiment } from './experiment.js'
import { PositionTracker } from './position.js'
import { synthesizeImu } from './synth.js'
import type { Vec3 } from './quat.js'

/** Точки последовательности: каждый шаг на 15 см в своём направлении. */
export function sequenceWaypoints(len = 0.15): Vec3[] {
  const pts: Vec3[] = [[0, 0, 0]]
  for (const d of SEQUENCE_2D) {
    const [x, y] = pts[pts.length - 1]
    pts.push([x + DIR2D_VEC[d][0] * len, y + DIR2D_VEC[d][1] * len, 0])
  }
  return pts
}

describe('Experiment2D', () => {
  it('синтетика по последовательности: все шаги засчитаны, направления и возвраты точные', () => {
    const track = synthesizeImu(sequenceWaypoints(), { speed: 0.35, dwellS: 0.8 })
    const triki = createTriki({ warmupFrames: 0, stateThrottleMs: 0, beta: 0.03 })
    const tracker = new PositionTracker({ planar: true })
    const exp = new Experiment2D()
    triki.on('sample', (s) => {
      const seg = tracker.push(s, track.dt)
      triki.setBeta(tracker.suggestBeta())
      if (seg) exp.onSegment(seg)
    })
    triki.feed(track.samples, track.dt)
    expect(exp.done).toBe(true)
    const sc = scoreExperiment(exp.results)
    expect(sc.maxAbsAngleDeg).toBeLessThan(5)
    expect(sc.meanClosureCm).toBeLessThan(1.5)
    expect(sc.finalCm).toBeLessThan(3)
  })

  it('оценка: общий поворот осей отделяется от разброса, пропуски не ломают пары', () => {
    const rot = (v: readonly [number, number], a: number): [number, number] =>
      [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)]
    const results = SEQUENCE_2D.map((dir, index) => ({
      index, dir, d: rot(DIR2D_VEC[dir], Math.PI / 18).map((x) => x * 0.1) as [number, number], t0: 0, t1: 0, rotDeg: 0,
    }))
    const sc = scoreExperiment(results)
    expect(sc.meanAngleDeg).toBeCloseTo(10, 5)
    expect(sc.scatterAngleDeg).toBeCloseTo(0, 5)
    expect(sc.meanClosureCm).toBeCloseTo(0, 5)
    const exp = new Experiment2D()
    exp.skip()
    expect(exp.index).toBe(1)
    expect(scoreExperiment(exp.results).skipped).toBe(1)
  })
})
