import { describe, expect, it } from 'vitest'
import { MotionAnalyzer } from './analyzer.js'
import type { Vec3 } from './quat.js'

const DT = 1 / 104
const BIAS: Vec3 = [1.25, -2.77, -1.73]

/** Жетон лежит ровно; гироскоп показывает смещение + rate (°/с) + небольшой шум. */
function feed(an: MotionAnalyzer, seconds: number, rate: Vec3 = [0, 0, 0], seed = 1): void {
  let s = seed
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    an.push({ gx: BIAS[0] + rate[0] + noise(), gy: BIAS[1] + rate[1] + noise(), gz: BIAS[2] + rate[2] + noise(), ax: 0, ay: 0, az: 1 }, [1, 0, 0, 0], DT)
  }
}
const err = (an: MotionAnalyzer) => Math.hypot(an.gyroBias[0] - BIAS[0], an.gyroBias[1] - BIAS[1], an.gyroBias[2] - BIAS[2])

describe('смещение нуля гироскопа', () => {
  it('сходится к настоящему в покое', () => {
    const an = new MotionAnalyzer()
    feed(an, 3)
    expect(err(an)).toBeLessThan(0.08)
  })

  it('медленный поворот в покое (палец на жетоне) не портит уже найденное смещение', () => {
    const an = new MotionAnalyzer()
    feed(an, 3)
    feed(an, 0.6, [0, 0, 2])
    expect(err(an)).toBeLessThan(0.1)
  })

  it('если при подключении жетон медленно поворачивали, смещение всё равно исправляется, когда он ляжет', () => {
    const an = new MotionAnalyzer()
    feed(an, 2, [0, 0, 2.5]) // держат в руке и плавно поворачивают
    feed(an, 6) // положили на стол
    expect(err(an)).toBeLessThan(0.1)
  })
})
