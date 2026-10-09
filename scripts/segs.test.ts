// Временно: сегменты трекера на записи
import { readFileSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { PositionPipeline, replayRecording, type PositionOptions, type TrikiRecording } from '../packages/triki-kit/src/index.js'
const DIR = new URL('../recordings/', import.meta.url)
it.skipIf(!process.env.REC)('segs', () => {
  const rec = JSON.parse(readFileSync(new URL(process.env.REC!, DIR), 'utf8')) as TrikiRecording
  const opts = JSON.parse(process.env.OPTS ?? '{}') as PositionOptions
  const L: string[] = []
  let p!: PositionPipeline
  replayRecording(rec, {
    setup: (t) => (p = new PositionPipeline(t, { planar: true, ...opts }, (s, seg) => {
      if (!seg) return
      const d = [(seg.to[0] - seg.from[0]) * 100, (seg.to[1] - seg.from[1]) * 100]
      L.push(`t ${seg.t0.toFixed(2)}-${seg.t1.toFixed(2)} (${(seg.t1 - seg.t0).toFixed(2)}s) d ${d.map((x) => x.toFixed(1)).join(',')} |d| ${Math.hypot(d[0], d[1]).toFixed(1)} v0 ${seg.residualVel.slice(0, 2).map((x) => (x * 100).toFixed(1)).join(',')} corr ${seg.correction.slice(0, 2).map((x) => (x * 100).toFixed(1)).join(',')} rot ${seg.rotDeg.toFixed(0)} valid ${seg.valid}`)
    })),
    chunk: (_i, marks) => { for (const m of marks) if (m.type === 'start') p.tracker.zero() },
  }, { stateThrottleMs: 0, beta: 0.03 })
  writeFileSync(process.env.OUT!, L.join('\n'))
})
