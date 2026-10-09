import { LED_UP, MotionAnalyzer, type DispFrame, type PostureName, type TrikiEvent } from './core/analyzer.js'
import { GestureMapper, type Gesture } from './core/gestures.js'
import { ledAwayOffset } from './core/heading.js'
import { linearAccelWorld } from './core/linear.js'
import { Madgwick } from './core/madgwick.js'
import { FrameParser, type Sample } from './core/parser.js'
import type { RateHz } from './core/protocol.js'
import { quatAboutZ, quatMul, yawOf, type Quat, type Vec3 } from './core/quat.js'
import { Emitter } from './emitter.js'
import type { TrikiTransport } from './transport.js'
import { WebBluetoothTransport } from './transports/web-bluetooth.js'

export type TrikiStatus = 'idle' | 'connecting' | 'streaming' | 'disconnected' | 'error'

export interface TrikiOptions {
  /** Частота потока, Гц. По умолчанию 104. */
  rate?: RateHz
  /** Система координат смещений: 'body' - оси жетона (верх = светодиод), 'world' - по heading. По умолчанию 'body'. */
  frame?: DispFrame
  /** После подключения, когда жетон лежит спокойно, один раз выровнять yaw: светодиод от пользователя. По умолчанию true. */
  autoAlign?: boolean
  /** Усиление фильтра Madgwick. По умолчанию 0.08. */
  beta?: number
  /** Сколько первых кадров после старта потока отбрасывать как шум. По умолчанию 20. */
  warmupFrames?: number
  /** Канал до жетона. По умолчанию Web Bluetooth (создаётся при первом connect, SSR безопасен). */
  transport?: TrikiTransport
  /** Не чаще раза в N мс уведомлять подписчиков состояния (subscribe). 0 - синхронно. По умолчанию 50. */
  stateThrottleMs?: number
  /** Сколько последних жестов держать в состоянии. По умолчанию 50. */
  maxGestures?: number
  /** Источник времени (мс) для оценки реальной частоты кадров. Для тестов. */
  now?: () => number
}

/** Один кадр после обработки: сырые данные и производные величины. Приходит с частотой потока. */
export interface TrikiSample {
  /** секунды: монотонные часы тулкита (между сессиями подключения сдвигаются вперёд) */
  t: number
  /** deg/s, с поправкой на смещение нуля */
  gyro: Vec3
  /** g, в осях датчика */
  accel: Vec3
  /** ориентация [w, x, y, z], мир: X вправо, Y от пользователя, Z вверх (после автовыравнивания) */
  quat: Quat
  /** линейное ускорение в мировых осях, g, без гравитации */
  linear: Vec3
}

/** Снимок состояния. Меняется редко (не с частотой потока): годится для React. */
export interface TrikiState {
  status: TrikiStatus
  error: string | null
  rateHz: RateHz
  /** фактическая частота кадров, Гц; null пока не измерена */
  measuredHz: number | null
  battery: number | null
  led: boolean
  hasLed: boolean
  moving: boolean
  posture: PostureName
  /** наклон оси Z датчика от вертикали, градусы, целое */
  tiltDeg: number
  /** yaw выровнен (автоматически или через rezero) */
  aligned: boolean
  frame: DispFrame
  /** последние жесты, старые первыми */
  gestures: readonly Gesture[]
}

export interface TrikiEventMap {
  sample: TrikiSample
  /** событие анализатора со структурными данными, текстом и уверенностью */
  event: TrikiEvent
  /** дискретный квантованный жест (см. VOCAB) */
  gesture: Gesture
  status: TrikiStatus
  battery: number
  led: boolean
  error: Error
}

const IDENTITY: Quat = [1, 0, 0, 0]
const SESSION_GAP_S = 10

export class Triki {
  private readonly opts: Required<Pick<TrikiOptions, 'autoAlign' | 'warmupFrames' | 'stateThrottleMs' | 'maxGestures'>>
  private readonly now: () => number
  private readonly emitter = new Emitter<TrikiEventMap>()
  private readonly listeners = new Set<() => void>()
  private transport: TrikiTransport | null
  private attached = false

  private readonly parser = new FrameParser()
  private readonly madgwick: Madgwick
  private readonly analyzer = new MotionAnalyzer()
  private readonly mapper = new GestureMapper()

  private yawOffset: Quat = IDENTITY
  private q: Quat = IDENTITY
  private frames = 0
  private dt: number
  private clock = 0
  private timeBase = 0
  private autoAligned = false
  private hzCount = 0
  private hzSince: number
  private gestureVersion = 0
  private lastSample: TrikiSample | null = null

  private draft: TrikiState
  private snapshot: TrikiState
  private snapshotGestureVersion = -1
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TrikiOptions = {}) {
    this.opts = {
      autoAlign: options.autoAlign ?? true,
      warmupFrames: options.warmupFrames ?? 20,
      stateThrottleMs: options.stateThrottleMs ?? 50,
      maxGestures: options.maxGestures ?? 50,
    }
    this.now = options.now ?? (() => performance.now())
    this.transport = options.transport ?? null
    this.madgwick = new Madgwick(options.beta ?? 0.08)
    this.analyzer.frame = options.frame ?? 'body'
    const rate = options.rate ?? 104
    this.dt = 1 / rate
    this.hzSince = this.now()
    this.draft = {
      status: 'idle', error: null, rateHz: rate, measuredHz: null, battery: null, led: false, hasLed: false,
      moving: true, posture: 'flat', tiltDeg: 0, aligned: false, frame: this.analyzer.frame, gestures: [],
    }
    this.snapshot = { ...this.draft }
  }

  // --- подписки ---------------------------------------------------------------------------

  /** Подписка на поток событий. Возвращает функцию отписки. */
  on<K extends keyof TrikiEventMap>(name: K, fn: (payload: TrikiEventMap[K]) => void): () => void {
    return this.emitter.on(name, fn)
  }

  /**
   * Подписка на жесты по шаблону id. Сегменты через точку, "*" - любой сегмент, шаблон короче id совпадает по префиксу:
   * "flip" ловит flip и flip.up; "roll.*.90" - прокрут на 90° в любую сторону; "circle.cw" - круг по часовой.
   */
  onGesture(pattern: string, fn: (g: Gesture) => void): () => void {
    const want = pattern.split('.')
    return this.on('gesture', (g) => {
      const have = g.id.split('.')
      if (want.length <= have.length && want.every((w, i) => w === '*' || w === have[i])) fn(g)
    })
  }

  /** Подписка на изменения состояния (для useSyncExternalStore). Стрелочное поле: можно передавать без bind. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Текущий снимок состояния. Объект тот же, пока ничего не изменилось. */
  getState = (): TrikiState => this.snapshot

  /** Последний обработанный кадр (удобно читать из requestAnimationFrame). */
  get sample(): TrikiSample | null {
    return this.lastSample
  }

  /** Текущая ориентация (с учётом выравнивания yaw). */
  get orientation(): Quat {
    return this.q
  }

  get gestures(): readonly Gesture[] {
    return this.mapper.list
  }

  // --- управление -------------------------------------------------------------------------

  /**
   * Подключиться. Для Web Bluetooth вызывать из обработчика клика. Не бросает: результат в state.status / state.error
   * и в событии 'error'. Отмена выбора устройства пользователем возвращает false без ошибки.
   */
  async connect(): Promise<boolean> {
    if (this.draft.status === 'connecting' || this.draft.status === 'streaming') return true
    this.resetPipeline()
    this.setStatus('connecting', { error: null })
    try {
      const tr = this.ensureTransport()
      await tr.connect(this.draft.rateHz)
      this.set({ hasLed: tr.hasLed })
      this.setStatus('streaming')
      void tr.readLed().then((v) => {
        if (v !== null) this.setLedState(v)
      }, () => undefined)
      return true
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (err.name === 'NotFoundError') {
        this.setStatus('idle') // пользователь закрыл окно выбора устройства
        return false
      }
      this.setStatus('error', { error: err.message })
      this.emitter.emit('error', err)
      return false
    }
  }

  disconnect(): void {
    this.transport?.disconnect()
  }

  /** Сменить частоту потока. Фильтры и детекторы сбрасываются. Без подключения просто запоминает значение. */
  async setRate(hz: RateHz): Promise<void> {
    this.set({ rateHz: hz })
    this.resetPipeline()
    if (this.draft.status === 'streaming') await this.transport?.setRate(hz)
  }

  /** Включить/выключить зелёный светодиод жетона (документированный регистр). */
  async setLed(on: boolean): Promise<void> {
    if (!this.transport || this.draft.status !== 'streaming') throw new Error('Не подключено')
    await this.transport.setLed(on)
    this.setLedState(on)
  }

  /** Повернуть heading так, чтобы светодиод жетона смотрел от пользователя (+Y мира). Жетон должен лежать плоско. */
  rezero(): void {
    this.yawOffset = ledAwayOffset(this.madgwick.quaternion(), LED_UP) ?? quatAboutZ(-yawOf(this.madgwick.quaternion()))
    this.autoAligned = true
    this.set({ aligned: true })
  }

  setFrame(frame: DispFrame): void {
    this.analyzer.frame = frame
    this.set({ frame })
  }

  setBeta(beta: number): void {
    this.madgwick.beta = beta
  }

  clearGestures(): void {
    this.mapper.clear()
    this.gestureVersion++
    this.markDirty()
  }

  /** Освободить ресурсы: отключиться и снять все подписки. */
  dispose(): void {
    this.disconnect()
    this.emitter.clear()
    this.listeners.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  // --- данные -----------------------------------------------------------------------------

  /** Скормить сырой кусок notification (его обычно вызывает транспорт). Кадры могут быть разрезаны. */
  push(chunk: Uint8Array): void {
    const samples = this.parser.push(chunk)
    if (!samples.length) return
    for (const s of samples) this.process(s, this.dt, true)
    this.tickRate()
    this.syncAnalyzerState()
  }

  /**
   * Скормить уже разобранные кадры (повтор записи, тесты, свой источник). dt - шаг между кадрами, с;
   * по умолчанию 1/rate. Первые warmupFrames кадров отбрасываются, как и в живом потоке.
   */
  feed(samples: readonly Sample[], dt: number = 1 / this.draft.rateHz): void {
    for (const s of samples) this.process(s, dt, false)
    this.syncAnalyzerState()
  }

  // --- внутреннее -------------------------------------------------------------------------

  private ensureTransport(): TrikiTransport {
    this.transport ??= new WebBluetoothTransport()
    if (!this.attached) {
      this.attached = true
      this.transport.attach({
        onData: (chunk) => this.push(chunk),
        onBattery: (p) => {
          this.set({ battery: p })
          this.emitter.emit('battery', p)
        },
        onDisconnect: () => {
          this.set({ led: false })
          this.setStatus('disconnected')
        },
      })
    }
    return this.transport
  }

  private resetPipeline(): void {
    this.parser.reset()
    this.madgwick.reset()
    this.analyzer.reset()
    this.yawOffset = IDENTITY
    this.q = IDENTITY
    this.frames = 0
    this.dt = 1 / this.draft.rateHz
    this.autoAligned = false
    this.hzCount = 0
    this.hzSince = this.now()
    this.clock += SESSION_GAP_S // жесты разных сессий не склеиваются в одно комбо
    this.timeBase = this.clock
    this.lastSample = null
    this.set({ aligned: false, measuredHz: null, moving: true, posture: 'flat', tiltDeg: 0 })
  }

  private process(s: Sample, dt: number, countHz: boolean): void {
    if (++this.frames <= this.opts.warmupFrames) return
    if (countHz) this.hzCount++
    this.clock += dt

    const b = this.analyzer.gyroBias // смещение нуля гироскопа иначе копится в yaw
    this.madgwick.update(s.gx - b[0], s.gy - b[1], s.gz - b[2], s.ax, s.ay, s.az, dt)
    this.q = quatMul(this.yawOffset, this.madgwick.quaternion())

    const accel: Vec3 = [s.ax, s.ay, s.az]
    this.lastSample = {
      t: this.clock,
      gyro: [s.gx - b[0], s.gy - b[1], s.gz - b[2]],
      accel,
      quat: this.q,
      linear: linearAccelWorld(this.q, accel),
    }
    this.emitter.emit('sample', this.lastSample)

    for (const raw of this.analyzer.push(s, this.q, dt)) {
      const ev: TrikiEvent = { ...raw, t: this.timeBase + raw.t }
      this.emitter.emit('event', ev)
      if (this.mapper.push(ev)) {
        this.gestureVersion++
        this.emitter.emit('gesture', this.mapper.list[this.mapper.list.length - 1])
        this.markDirty()
      }
    }
    this.maybeAutoAlign()
  }

  private maybeAutoAlign(): void {
    if (!this.opts.autoAlign || this.autoAligned) return
    if (this.frames < this.opts.warmupFrames + 2 * this.draft.rateHz) return
    if (this.analyzer.state.moving || this.analyzer.state.tiltDeg > 30) return
    this.rezero()
  }

  /** Реальный шаг между кадрами = время / число кадров за окно: пачки BLE и потери кадров искажают номинал. */
  private tickRate(): void {
    const now = this.now()
    const el = now - this.hzSince
    if (el < 1000) return
    if (this.hzCount > 20) {
      const rate = this.draft.rateHz
      const meas = el / 1000 / this.hzCount
      this.dt = Math.min(2 / rate, Math.max(0.5 / rate, this.dt * 0.5 + meas * 0.5))
      this.set({ measuredHz: Math.round((this.hzCount * 1000) / el) })
    }
    this.hzCount = 0
    this.hzSince = now
  }

  private syncAnalyzerState(): void {
    const st = this.analyzer.state
    const tilt = Math.round(st.tiltDeg)
    if (st.moving !== this.draft.moving || st.posture !== this.draft.posture || tilt !== this.draft.tiltDeg) {
      this.set({ moving: st.moving, posture: st.posture, tiltDeg: tilt })
    }
  }

  private setLedState(on: boolean): void {
    this.set({ led: on })
    this.emitter.emit('led', on)
  }

  private setStatus(status: TrikiStatus, patch: Partial<TrikiState> = {}): void {
    this.set({ ...patch, status })
    this.emitter.emit('status', status)
  }

  private set(patch: Partial<TrikiState>): void {
    let changed = false
    for (const k of Object.keys(patch) as (keyof TrikiState)[]) {
      if (this.draft[k] !== patch[k]) {
        ;(this.draft as unknown as Record<string, unknown>)[k] = patch[k]
        changed = true
      }
    }
    if (changed) this.markDirty()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.opts.stateThrottleMs <= 0) return this.flush()
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.opts.stateThrottleMs)
    }
  }

  /** Сразу опубликовать накопленные изменения состояния подписчикам (обычно не нужно). */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    if (this.snapshotGestureVersion !== this.gestureVersion) {
      this.draft.gestures = this.mapper.list.slice(-this.opts.maxGestures)
      this.snapshotGestureVersion = this.gestureVersion
    }
    this.snapshot = { ...this.draft }
    for (const l of [...this.listeners]) l()
  }
}

export function createTriki(options?: TrikiOptions): Triki {
  return new Triki(options)
}
