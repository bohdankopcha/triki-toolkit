import { describe, expect, it } from 'vitest'
import { MotionAnalyzer, type TrikiEvent } from './analyzer.js'
import { ledAwayOffset } from './heading.js'
import type { Sample } from './parser.js'
import { quatAboutZ, quatMul, rotate, type Quat } from './quat.js'

const DT = 1 / 104
const FLAT: Quat = [1, 0, 0, 0]
const FLIPPED: Quat = [0, 1, 0, 0] // 180° вокруг X

function run(a: MotionAnalyzer, seconds: number, make: (i: number) => { s?: Partial<Sample>; q?: Quat }): TrikiEvent[] {
  const ev: TrikiEvent[] = []
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    const { s = {}, q = FLAT } = make(i)
    ev.push(...a.push({ gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 1, ...s }, q, DT))
  }
  return ev
}

describe('MotionAnalyzer', () => {
  it('в покое лёжа событий нет', () => {
    const a = new MotionAnalyzer()
    expect(run(a, 3, () => ({}))).toHaveLength(0)
    expect(a.state.moving).toBe(false)
    expect(a.state.posture).toBe('flat')
  })

  it('переворот даёт одно событие', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const ev = run(a, 1, () => ({ q: FLIPPED, s: { az: -1 } }))
    expect(ev).toHaveLength(1)
    expect(ev[0].text).toMatch(/Перевёрнут/)
  })

  it('прокрут: 180 °/с по X за 0.5 с = 90° "вперёд" (лицо к светодиоду)', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const ev = [...run(a, 0.5, () => ({ s: { gx: 180 } })), ...run(a, 0.6, () => ({}))].filter((e) => e.kind === 'rotate')
    expect(ev).toHaveLength(1)
    expect(ev[0].data?.angleDeg).toBeCloseTo(90, 0)
    expect(ev[0].text).toMatch(/вперёд/)
  })

  it('прокрут вправо: отрицательный gy', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const ev = [...run(a, 0.5, () => ({ s: { gy: -180 } })), ...run(a, 0.6, () => ({}))].filter((e) => e.kind === 'rotate')
    expect(ev[0].text).toMatch(/вправо/)
  })

  it('полный оборот вокруг Z считается как ~360°', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const ev = [...run(a, 1, () => ({ s: { gz: -360 } })), ...run(a, 0.6, () => ({}))].filter((e) => e.kind === 'rotate')
    expect(Math.abs(ev[0].data!.angleDeg!)).toBeCloseTo(360, -1)
    expect(ev[0].text).toMatch(/по часовой/)
  })

  it('смещение: разгон +0.2g и торможение 0.3 с даёт ~18 см вперёд', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const half = Math.round(0.3 / DT)
    const ev = [
      ...run(a, 0.6, (i) => ({ s: { ay: i < half ? 0.2 : -0.2 } })),
      ...run(a, 0.8, () => ({})),
    ].filter((e) => e.kind === 'move')
    expect(ev).toHaveLength(1)
    const d = ev[0].data!.dispCm!
    expect(d[1]).toBeGreaterThan(15)
    expect(d[1]).toBeLessThan(21)
    expect(Math.abs(d[0])).toBeLessThan(1)
    expect(ev[0].text).toMatch(/вперёд/)
  })

  it('шум сенсора в покое не порождает событий', () => {
    const a = new MotionAnalyzer()
    let seed = 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
    const ev = run(a, 10, () => ({ s: { gx: rnd() * 2, gy: rnd() * 2, gz: rnd() * 2, ax: rnd() * 0.01, ay: rnd() * 0.01, az: 1 + rnd() * 0.01 } }))
    expect(ev).toHaveLength(0)
  })

  describe('смещение в осях жетона (верх = светодиод)', () => {
    const pulse = (a: MotionAnalyzer, q: Quat, ay: number): TrikiEvent[] => {
      run(a, 1.5, () => ({ q }))
      const half = Math.round(0.3 / DT)
      return [...run(a, 0.6, (i) => ({ q, s: { ay: i < half ? ay : -ay } })), ...run(a, 0.8, () => ({ q }))].filter((e) => e.kind === 'move')
    }

    it('движение к светодиоду (-Y датчика) = "вверх", при любом yaw', () => {
      for (const q of [FLAT, quatAboutZ(Math.PI / 2), quatAboutZ(2.3)]) {
        const a = new MotionAnalyzer()
        a.frame = 'body'
        const ev = pulse(a, q, -0.2)
        expect(ev).toHaveLength(1)
        expect(ev[0].text).toMatch(/вверх \(к светодиоду\)/)
        const d = ev[0].data!.dispCm!
        expect(d[1]).toBeGreaterThan(15)
        expect(Math.abs(d[0])).toBeLessThan(1.5)
      }
    })

    it('движение по -X датчика = "вправо" (право Ż)', () => {
      const a = new MotionAnalyzer()
      a.frame = 'body'
      run(a, 1.5, () => ({}))
      const half = Math.round(0.3 / DT)
      const ev = [...run(a, 0.6, (i) => ({ s: { ax: i < half ? -0.2 : 0.2 } })), ...run(a, 0.8, () => ({}))].filter((e) => e.kind === 'move')
      expect(ev[0].text).toMatch(/вправо/)
    })

    it('reset() сохраняет выбранный режим', () => {
      const a = new MotionAnalyzer()
      a.frame = 'body'
      a.reset()
      expect(a.frame).toBe('body')
    })
  })

  describe('подъём и опускание', () => {
    const lift = (sign: number, wobble = 0) => {
      const a = new MotionAnalyzer()
      a.frame = 'body'
      run(a, 1.5, () => ({}))
      const half = Math.round(0.3 / DT)
      // wobble: жетон «в руке», никогда не бывает полностью неподвижным
      return [
        ...run(a, 0.6, (i) => ({ s: { az: 1 + sign * (i < half ? 0.1 : -0.1), gx: wobble } })),
        ...run(a, 0.8, (i) => ({ s: { gx: wobble ? wobble * Math.sin(i) : 0 } })),
      ]
    }

    it('поднятие на ~9 см даёт событие "Поднят", а не смещение', () => {
      const ev = lift(+1)
      const l = ev.filter((e) => e.kind === 'lift')
      expect(l).toHaveLength(1)
      expect(l[0].text).toMatch(/Поднят на (7|8|9|10) см/)
      expect(ev.filter((e) => e.kind === 'move')).toHaveLength(0)
    })

    it('опускание', () => {
      expect(lift(-1).filter((e) => e.kind === 'lift')[0].text).toMatch(/Опущен/)
    })

    it('в руке (без полной неподвижности) тоже ловится', () => {
      expect(lift(+1, 12).filter((e) => e.kind === 'lift')).toHaveLength(1)
    })

    it('слабый подъём ~5 см ловится', () => {
      const a = new MotionAnalyzer()
      run(a, 1.5, () => ({}))
      const half = Math.round(0.2 / DT) // 0.1 g, 0.2 с + 0.2 с => ~4 см
      const ev = [...run(a, 0.4, (i) => ({ s: { az: 1 + (i < half ? 0.1 : -0.1) } })), ...run(a, 0.8, () => ({}))]
      expect(ev.filter((e) => e.kind === 'lift')).toHaveLength(1)
    })
  })

  describe('вращение не считается перемещением', () => {
    it('быстрое вращение с «ускорением» от ошибки ориентации: ни смещения, ни подъёма', () => {
      const a = new MotionAnalyzer()
      run(a, 1.5, () => ({}))
      const half = Math.round(0.3 / DT)
      const ev = [
        ...run(a, 0.6, (i) => ({ s: { gx: 250, ay: i < half ? 0.25 : -0.25, az: 1 + (i < half ? 0.2 : -0.2) } })),
        ...run(a, 0.8, () => ({})),
      ]
      expect(ev.filter((e) => e.kind === 'move' || e.kind === 'lift')).toHaveLength(0)
      expect(ev.filter((e) => e.kind === 'rotate')).toHaveLength(1)
    })
  })
})

describe('движение по кругу', () => {
  /** Траектория: окружность радиуса R, угол по сглаженной кривой от 0 до sweep (старт и конец в покое). */
  function circle(sweepRad: number, R = 0.06, T = 1.2): (i: number) => { s: Partial<Sample> } {
    const n = Math.round(T / DT)
    const phi = (k: number) => {
      const x = Math.min(1, Math.max(0, k / n))
      return sweepRad * (3 * x * x - 2 * x * x * x)
    }
    const p = (k: number) => [R * Math.cos(phi(k)), R * Math.sin(phi(k))]
    return (i) => {
      const [x0, y0] = p(i - 1)
      const [x1, y1] = p(i)
      const [x2, y2] = p(i + 1)
      const G = 9.80665
      return { s: { ax: (x2 - 2 * x1 + x0) / DT ** 2 / G, ay: (y2 - 2 * y1 + y0) / DT ** 2 / G } }
    }
  }
  const circles = (ev: TrikiEvent[]) => ev.filter((e) => e.kind === 'circle')
  const feed = (sweep: number) => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    return [...run(a, 1.2, circle(sweep)), ...run(a, 0.8, () => ({}))]
  }

  it('круг против часовой (вид сверху)', () => {
    const ev = feed(2 * Math.PI)
    expect(circles(ev)).toHaveLength(1)
    expect(circles(ev)[0].data?.dir).toBe('ccw')
    expect(circles(ev)[0].data!.radiusCm!).toBeGreaterThan(4)
  })

  it('круг по часовой', () => {
    expect(circles(feed(-2 * Math.PI))[0].data?.dir).toBe('cw')
  })

  it('два круга', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const ev = [...run(a, 2.4, circle(4 * Math.PI, 0.06, 2.4)), ...run(a, 0.8, () => ({}))]
    expect(Math.abs(circles(ev)[0].data!.angleDeg!)).toBeGreaterThan(600)
  })

  it('полукруг и дуга круга не считаются', () => {
    expect(circles(feed(Math.PI))).toHaveLength(0)
    expect(circles(feed(1.4 * Math.PI))).toHaveLength(0)
  })

  it('прямое смещение туда-сюда кругом не считается', () => {
    const a = new MotionAnalyzer()
    run(a, 1.5, () => ({}))
    const half = Math.round(0.3 / DT)
    const ev = [...run(a, 0.6, (i) => ({ s: { ay: i < half ? 0.2 : -0.2 } })), ...run(a, 0.8, () => ({}))]
    expect(circles(ev)).toHaveLength(0)
  })
})

describe('ledAwayOffset', () => {
  it.each([0, 0.7, 2.0, -2.5])('после поправки светодиод смотрит в +Y при yaw %d рад', (yaw) => {
    const q = quatAboutZ(yaw)
    const off = ledAwayOffset(q, [0, -1])!
    const led = rotate(quatMul(off, q), [0, -1, 0])
    expect(led[0]).toBeCloseTo(0)
    expect(led[1]).toBeCloseTo(1)
  })
  it('светодиод вертикально: heading не определён', () => {
    expect(ledAwayOffset([Math.SQRT1_2, Math.SQRT1_2, 0, 0], [0, -1])).toBeNull()
  })
})
