import { describe, expect, it } from 'vitest'
import { createTriki } from './triki.js'
import { Recorder, replayRecording } from './recording.js'
import { PositionTracker } from './core/position.js'
import { synthesizeImu } from './core/synth.js'
import { ACCEL_LSB_PER_G, GYRO_LSB_PER_DPS } from './core/protocol.js'
import type { Sample } from './core/parser.js'
import type { Vec3 } from './core/quat.js'

function encodeFrame(s: Sample): Uint8Array {
  const b = new Uint8Array(14)
  const dv = new DataView(b.buffer)
  b[0] = 0x22
  ;[s.gx, s.gy, s.gz].forEach((v, i) => dv.setInt16(2 + i * 2, Math.round(v * GYRO_LSB_PER_DPS), true))
  ;[s.ax, s.ay, s.az].forEach((v, i) => dv.setInt16(8 + i * 2, Math.round(v * ACCEL_LSB_PER_G), true))
  return b
}

describe('запись и повтор', () => {
  it('повтор воспроизводит живую обработку бит в бит, включая действия по меткам', () => {
    const track = synthesizeImu([[0, 0, 0], [0.2, 0, 0], [0.2, 0.15, 0]])
    let now = 1000
    const live = createTriki({ now: () => now, stateThrottleMs: 0, beta: 0.03 })
    const rec = new Recorder(live)
    const run = (triki: ReturnType<typeof createTriki>) => {
      const tracker = new PositionTracker({ planar: true })
      const out: Vec3[] = []
      triki.on('sample', (s) => {
        tracker.push(s, 1 / 104)
        triki.setBeta(tracker.suggestBeta())
        out.push(tracker.pos)
      })
      return { tracker, out }
    }
    void live.setRate(104) // как connect(): сброс конвейера и сдвиг часов сессии
    const a = run(live)
    // пачками по 4 кадра, как BLE, с неровными интервалами
    for (let i = 0; i < track.samples.length; i += 4) {
      const chunk = track.samples.slice(i, i + 4).map(encodeFrame)
      const bytes = new Uint8Array(chunk.length * 14)
      chunk.forEach((f, k) => bytes.set(f, k * 14))
      now += 4 * (1000 / 104) + ((i * 7) % 5) - 2
      live.push(bytes)
      if (i === 200) {
        a.tracker.zero()
        rec.mark('zero')
      }
    }
    const json = JSON.parse(JSON.stringify(rec.toJSON()))
    let b!: ReturnType<typeof run>
    replayRecording(json, {
      setup: (t) => (b = run(t)),
      chunk: (_, marks) => marks.forEach((m) => m.type === 'zero' && b.tracker.zero()),
    }, { stateThrottleMs: 0, beta: 0.03 })
    expect(b.out).toEqual(a.out)
    expect(a.tracker.pos[0]).toBeGreaterThan(0.15)
  })
})
