import { describe, expect, it } from 'vitest'
import { FrameParser } from './parser.js'
import { startCmd } from './protocol.js'
import { Madgwick } from './madgwick.js'
import { linearAccelWorld } from './linear.js'
import { rotate, quatAboutZ, yawOf } from './quat.js'

function frame(gx: number, gy: number, gz: number, ax: number, ay: number, az: number): Uint8Array {
  const b = new Uint8Array(14)
  b[0] = 0x22
  const dv = new DataView(b.buffer)
  ;[gx, gy, gz, ax, ay, az].forEach((v, i) => dv.setInt16(2 + i * 2, v, true))
  return b
}

describe('startCmd', () => {
  it('104 Hz совпадает с документацией', () => {
    expect([...startCmd(104)]).toEqual([0x20, 0x10, 0x00, 0xd0, 0x07, 0x68, 0x00, 0x03])
  })
  it('416 Hz кодируется как uint16 LE', () => {
    const c = startCmd(416)
    expect([c[5], c[6]]).toEqual([0xa0, 0x01])
  })
})

describe('FrameParser', () => {
  it('декодирует масштабы: 2048 = 1 g', () => {
    const [s] = new FrameParser().push(frame(0, 0, 0, 0, 0, 2048))
    expect(s.az).toBeCloseTo(1)
  })
  it('собирает кадр, разрезанный на два notification', () => {
    const p = new FrameParser()
    const f = frame(1, 2, 3, 4, 5, 6)
    expect(p.push(f.slice(0, 7))).toHaveLength(0)
    expect(p.push(f.slice(7))).toHaveLength(1)
  })
  it('пачка из нескольких кадров + мусор в начале', () => {
    const p = new FrameParser()
    const junk = Uint8Array.of(1, 2, 3)
    const f = frame(0, 0, 0, 0, 0, 2048)
    const all = new Uint8Array([...junk, ...f, ...f, ...f])
    expect(p.push(all)).toHaveLength(3)
  })
  it('заголовок, разрезанный между чанками', () => {
    const p = new FrameParser()
    const f = frame(0, 0, 0, 0, 0, 2048)
    expect(p.push(f.slice(0, 1))).toHaveLength(0)
    expect(p.push(f.slice(1))).toHaveLength(1)
  })
})

describe('Madgwick', () => {
  it('в покое лёжа остаётся около identity без NaN', () => {
    const m = new Madgwick()
    for (let i = 0; i < 500; i++) m.update(0, 0, 0, 0, 0, 1, 1 / 104)
    const q = m.quaternion()
    expect(q.every(Number.isFinite)).toBe(true)
    expect(Math.abs(q[0])).toBeGreaterThan(0.999)
  })
  it('сходится к перевёрнутой ориентации (az = -1)', () => {
    const m = new Madgwick(0.5)
    // ax != 0: при идеальном az=-1 из identity градиент нулевой (особая точка), на шумных данных так не бывает
    for (let i = 0; i < 2000; i++) m.update(0, 0, 0, 0.02, 0, -1, 1 / 104)
    const up = rotate(m.quaternion(), [0, 0, -1])
    expect(up[2]).toBeGreaterThan(0.99) // показание -1g по Z -> мировая +Z
  })
  it('интегрирует гироскоп: 90 deg/s вокруг Z за 1 с даёт ~90 градусов yaw', () => {
    const m = new Madgwick(0)
    for (let i = 0; i < 104; i++) m.update(0, 0, 90, 0, 0, 1, 1 / 104)
    expect((yawOf(m.quaternion()) * 180) / Math.PI).toBeCloseTo(90, 0)
  })
})

describe('linearAccelWorld', () => {
  it('в покое лёжа = 0', () => {
    const a = linearAccelWorld([1, 0, 0, 0], [0, 0, 1])
    a.forEach((v) => expect(v).toBeCloseTo(0))
  })
  it('толчок по мировому X при повороте датчика на 90 градусов по Z', () => {
    const q = quatAboutZ(Math.PI / 2) // sensor X -> world Y
    const a = linearAccelWorld(q, [0.5, 0, 1])
    expect(a[1]).toBeCloseTo(0.5)
    expect(a[0]).toBeCloseTo(0)
  })
})
