import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Gesture } from './core/gestures.js'
import type { Sample } from './core/parser.js'
import type { RateHz } from './core/protocol.js'
import { rotate } from './core/quat.js'
import type { TrikiTransport, TrikiTransportHandlers } from './transport.js'
import { Triki, createTriki } from './triki.js'

class FakeTransport implements TrikiTransport {
  h!: TrikiTransportHandlers
  hasLed = true
  led = false
  failWith: Error | null = null
  rates: RateHz[] = []
  attach(h: TrikiTransportHandlers) { this.h = h }
  async connect(rate: RateHz) { if (this.failWith) throw this.failWith; this.rates.push(rate) }
  async setRate(rate: RateHz) { this.rates.push(rate) }
  async setLed(on: boolean) { this.led = on }
  async readLed() { return this.led }
  disconnect() { this.h?.onDisconnect() }
}

const DT = 1 / 104
const rest: Sample = { gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 1 }
const still = (n: number): Sample[] => Array.from({ length: n }, () => rest)
const seconds = (s: number) => Math.round(s / DT)

function make(opts: ConstructorParameters<typeof Triki>[0] = {}) {
  const transport = new FakeTransport()
  const triki = createTriki({ transport, warmupFrames: 0, stateThrottleMs: 0, ...opts })
  return { transport, triki }
}

function frame(s: Sample): Uint8Array {
  const b = new Uint8Array(14)
  b[0] = 0x22
  const dv = new DataView(b.buffer)
  const raw = [s.gx * 14.286, s.gy * 14.286, s.gz * 14.286, s.ax * 2048, s.ay * 2048, s.az * 2048]
  raw.forEach((v, i) => dv.setInt16(2 + i * 2, Math.round(v), true))
  return b
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('подключение', () => {
  it('connect: статусы, светодиод, частота передаётся в транспорт', async () => {
    const { triki, transport } = make({ rate: 208 })
    const statuses: string[] = []
    triki.on('status', (s) => statuses.push(s))
    transport.led = true
    expect(await triki.connect()).toBe(true)
    await Promise.resolve()
    expect(statuses).toEqual(['connecting', 'streaming'])
    expect(transport.rates).toEqual([208])
    expect(triki.getState()).toMatchObject({ status: 'streaming', hasLed: true, led: true })
  })

  it('ошибка подключения: status=error, событие error, connect не бросает', async () => {
    const { triki, transport } = make()
    transport.failWith = new Error('GATT: boom')
    const errors: Error[] = []
    triki.on('error', (e) => errors.push(e))
    expect(await triki.connect()).toBe(false)
    expect(triki.getState()).toMatchObject({ status: 'error', error: 'GATT: boom' })
    expect(errors).toHaveLength(1)
  })

  it('отмена выбора устройства: возврат в idle без ошибки', async () => {
    const { triki, transport } = make()
    const e = new Error('User cancelled')
    e.name = 'NotFoundError'
    transport.failWith = e
    expect(await triki.connect()).toBe(false)
    expect(triki.getState()).toMatchObject({ status: 'idle', error: null })
  })

  it('отключение и управление светодиодом', async () => {
    const { triki, transport } = make()
    await expect(triki.setLed(true)).rejects.toThrow()
    await triki.connect()
    const leds: boolean[] = []
    triki.on('led', (v) => leds.push(v))
    await triki.setLed(true)
    expect(transport.led).toBe(true)
    transport.h.onBattery(87)
    expect(triki.getState().battery).toBe(87)
    triki.disconnect()
    expect(triki.getState()).toMatchObject({ status: 'disconnected', led: false })
    expect(leds).toEqual([true])
  })
})

describe('поток данных', () => {
  it('сырые байты, разрезанные на куски, доходят до жестов', async () => {
    const { triki, transport } = make()
    await triki.connect()
    const got: Gesture[] = []
    triki.on('gesture', (g) => got.push(g))
    const stream = [...still(seconds(1.6)), ...Array.from({ length: seconds(0.5) }, () => ({ ...rest, gx: 180 })), ...still(seconds(0.8))]
    const bytes = new Uint8Array(stream.length * 14)
    stream.forEach((s, i) => bytes.set(frame(s), i * 14))
    for (let i = 0; i < bytes.length; i += 20) transport.h.onData(bytes.slice(i, i + 20)) // как 20-байтовые notification
    expect(got.map((g) => g.id)).toEqual(['roll.up.90'])
  })

  it('feed: жест, шаблоны onGesture и снимок состояния', () => {
    const { triki } = make()
    const hits: Record<string, number> = { exact: 0, wild: 0, kind: 0, other: 0 }
    triki.onGesture('roll.up.90', () => hits.exact++)
    triki.onGesture('roll.*.90', () => hits.wild++)
    triki.onGesture('roll', () => hits.kind++)
    triki.onGesture('flip', () => hits.other++)
    const states: number[] = []
    triki.subscribe(() => states.push(triki.getState().gestures.length))
    triki.feed([...still(seconds(1.6)), ...Array.from({ length: seconds(0.5) }, () => ({ ...rest, gx: 180 })), ...still(seconds(0.8))])
    expect(hits).toEqual({ exact: 1, wild: 1, kind: 1, other: 0 })
    expect(triki.getState().gestures.map((g) => g.id)).toEqual(['roll.up.90'])
    expect(states.at(-1)).toBe(1)
    triki.clearGestures()
    expect(triki.getState().gestures).toHaveLength(0)
  })

  it('событие sample и ориентация: лёжа ровно ориентация около identity, линейное ускорение около 0', () => {
    const { triki } = make({ autoAlign: false })
    let last: ReturnType<typeof triki.on> | undefined
    const samples: number[] = []
    last = triki.on('sample', (s) => samples.push(Math.hypot(...s.linear)))
    triki.feed(still(seconds(1)))
    last()
    expect(samples).toHaveLength(seconds(1))
    expect(Math.max(...samples)).toBeLessThan(0.01)
    expect(triki.sample?.quat[0]).toBeGreaterThan(0.999)
  })

  it('автовыравнивание: после ~2 с покоя yaw выровнен, светодиод смотрит в +Y', () => {
    const { triki } = make()
    expect(triki.getState().aligned).toBe(false)
    triki.feed(still(seconds(2.5)))
    expect(triki.getState().aligned).toBe(true)
    // жетон лежит платой вверх: светодиод (-Y датчика) после поправки смотрит в мировую +Y («в экран»)
    const led = rotate(triki.orientation, [0, -1, 0])
    expect(led[0]).toBeCloseTo(0, 1)
    expect(led[1]).toBeGreaterThan(0.99)
  })

  it('warmup: первые кадры отбрасываются', () => {
    const { triki } = make({ warmupFrames: 50 })
    const n: number[] = []
    triki.on('sample', () => n.push(1))
    triki.feed(still(60))
    expect(n).toHaveLength(10)
  })

  it('сессии не склеиваются: после переподключения жесты в новом комбо', async () => {
    const { triki } = make()
    const spin = () => [...still(seconds(1.6)), ...Array.from({ length: seconds(0.5) }, () => ({ ...rest, gx: 180 })), ...still(seconds(0.8))]
    await triki.connect()
    triki.feed(spin())
    triki.disconnect()
    await triki.connect()
    triki.feed(spin())
    const [a, b] = triki.gestures
    expect(b.t - a.t).toBeGreaterThan(5)
  })
})

describe('состояние для React', () => {
  it('getState возвращает один и тот же объект, пока ничего не менялось', () => {
    const { triki } = make()
    const a = triki.getState()
    expect(triki.getState()).toBe(a)
    triki.feed(still(10))
    triki.flush()
    expect(triki.getState()).toBe(triki.getState())
  })

  it('уведомления подписчиков троттлятся', () => {
    vi.useFakeTimers()
    const { triki } = make({ stateThrottleMs: 50 })
    let n = 0
    triki.subscribe(() => n++)
    triki.setFrame('world')
    triki.setFrame('body')
    triki.setFrame('world')
    expect(n).toBe(0)
    vi.advanceTimersByTime(60)
    expect(n).toBe(1)
    expect(triki.getState().frame).toBe('world')
  })

  it('subscribe возвращает отписку, dispose снимает всё', () => {
    const { triki } = make()
    let n = 0
    const off = triki.subscribe(() => n++)
    triki.setFrame('world')
    off()
    triki.setFrame('body')
    expect(n).toBe(1)
    let g = 0
    triki.on('gesture', () => g++)
    triki.dispose()
    triki.feed([...still(seconds(1.6)), ...Array.from({ length: seconds(0.5) }, () => ({ ...rest, gx: 180 })), ...still(seconds(0.8))])
    expect(g).toBe(0)
  })

  it('ошибка в слушателе не ломает конвейер: остальные слушатели получают жест, ошибка всплывает отдельно', () => {
    const thrown: unknown[] = []
    vi.stubGlobal('queueMicrotask', (fn: () => void) => {
      try { fn() } catch (e) { thrown.push(e) }
    })
    const { triki } = make()
    const seen: string[] = []
    triki.on('gesture', () => { throw new Error('listener bug') })
    triki.on('gesture', (g) => seen.push(g.id))
    triki.feed([...still(seconds(1.6)), ...Array.from({ length: seconds(0.5) }, () => ({ ...rest, gx: 180 })), ...still(seconds(0.8))])
    expect(seen).toEqual(['roll.up.90'])
    expect(thrown).toHaveLength(1)
  })
})
