import { analyzeCircle } from './circle.js'
import { classifyPolygon } from './shapes.js'
import { linearAccelWorld } from './linear.js'
import { rotate, type Quat, type Vec3 } from './quat.js'

export type DispFrame = 'world' | 'body'
/** «Верх» жетона = светодиод, над логотипом Ż: ось -Y датчика, в плоскости платы [x, y]. Это данность, не настройка. */
export const LED_UP: readonly [number, number] = [0, -1]
import type { Sample } from './parser.js'

const G = 9.80665
const RAD2DEG = 180 / Math.PI

/** Направления в системе жетона (светодиод = up). cw/ccw при взгляде на плату; out/in - вдоль нормали платы. */
export type Dir = 'up' | 'down' | 'left' | 'right' | 'upleft' | 'upright' | 'downleft' | 'downright' | 'cw' | 'ccw' | 'out' | 'in'

export type Confidence = 'high' | 'medium' | 'rough'

export interface TrikiEvent {
  /** секунды от начала потока */
  t: number
  kind: 'posture' | 'rotate' | 'move' | 'lift' | 'circle' | 'shape'
  text: string
  confidence: Confidence
  data?: {
    axis?: 'x' | 'y' | 'z'
    angleDeg?: number
    /** смещение: [вправо, вверх(LED), по нормали платы] см в режиме жетона; подъём: [0, 0, ±см] */
    dispCm?: Vec3
    dir?: Dir
    /** вращение сразу по нескольким осям */
    complex?: boolean
    posture?: string
    tiltDeg?: number
    radiusCm?: number
    shape?: 'square' | 'triangle'
    /** сколько штрихов (сегментов движения) собрано в фигуру */
    strokes?: number
    perimeterCm?: number
  }
}

export type PostureName = 'flat' | 'tilted' | 'edge' | 'tilted-down' | 'flipped'

export interface AnalyzerState {
  moving: boolean
  posture: PostureName
  tiltDeg: number
}

// смещение нуля гироскопа: окно разброса, порог «тихо», насколько далеко от оценки ещё верим, постоянная времени
const BIAS_WIN_S = 0.15
const BIAS_QUIET_DPS = 0.6
const BIAS_NEAR_DPS = 1
const BIAS_CONVERGE_S = 1
const BIAS_TAU_S = 3
const BIAS_RELOCK_S = 1.5

const POSTURE_BOUNDS = [15, 75, 105, 165] // градусы наклона оси Z датчика от вертикали
const POSTURE_HYST = 5
const POSTURE_HOLD_S = 0.35

const ROT_START_DPS = 20
const ROT_QUIET_DPS = 10
const ROT_QUIET_S = 0.15
const ROT_MIN_DEG = 30

const MOVE_START_G = 0.06
const MOVE_MIN_CM = 3
const MOVE_MAX_S = 6
const STILL_HOLD_S = 0.3
const MOVE_MAX_ROT_DEG = 40 // сегмент, где жетон в основном крутился, смещением не считаем
const PREROLL = 12

// круг: траектория за сегмент движения «намотала» >= 315° вокруг центра и достаточно круглая
// фигуры: штрихи с паузой до CHAIN_GAP_S склеиваются в цепочку и проверяются на замкнутый квадрат/треугольник
const CHAIN_GAP_S = 0.8
const CHAIN_MAX_SEGS = 6
const CIRCLE_MIN_DEG = 315
const CIRCLE_MIN_RADIUS_M = 0.02
const CIRCLE_MAX_RADIUS_M = 0.6
const CIRCLE_MAX_ROUNDNESS = 0.5
const CIRCLE_MAX_TILT_ROT_DEG = 90 // вращение вокруг горизонтальных осей: оно портит оценку, вращение вокруг вертикали нет

// подъём/опускание: «доли» вертикальной скорости, интеграл с утечкой, без ожидания полной остановки
const LIFT_LEAK_S = 2
const LIFT_ENTER_MS = 0.05
const LIFT_MIN_PEAK_MS = 0.15
const LIFT_MIN_CM = 2
const LIFT_MAX_S = 2.5
const LIFT_STILL_S = 0.12

function classify(tilt: number, prev: number): number {
  let idx = 0
  for (let i = 0; i < POSTURE_BOUNDS.length; i++) {
    const above = prev > i ? tilt > POSTURE_BOUNDS[i] - POSTURE_HYST : tilt > POSTURE_BOUNDS[i] + POSTURE_HYST
    if (!above) break
    idx = i + 1
  }
  return idx
}

const POSTURE_NAMES = ['flat', 'tilted', 'edge', 'tilted-down', 'flipped'] as const

/**
 * Состояния и события поверх ориентации: покой/движение, положение, прокрут (интеграл гироскопа
 * за сегмент вращения), смещение (двойное интегрирование линейного ускорения с ZUPT на сегмент).
 * Чистая логика: ни DOM, ни BLE. Мировая система: Z вверх, Y «вперёд» (по heading после re-zero).
 */
export class MotionAnalyzer {
  state: AnalyzerState = { moving: false, posture: 'flat', tiltDeg: 0 }

  /**
   * Система координат для смещения. 'world': Y = heading при подключении/re-zero (дрейфует).
   * 'body': оси самого жетона на момент начала движения: вверх = светодиод, вправо/влево/вниз от него.
   */
  frame: DispFrame = 'world'

  /** Текущая оценка смещения нуля гироскопа (deg/s): её стоит вычитать и перед фильтром ориентации. */
  get gyroBias(): Vec3 {
    return this.bias
  }

  private t = 0
  private bias: Vec3 = [0, 0, 0]
  /** сырые показания гироскопа за последние BIAS_WIN_S: по их разбросу видно, лежит ли жетон по-настоящему */
  private gWin: Vec3[] = []
  /** сколько секунд тихого покоя уже ушло на оценку смещения */
  private biasS = 0
  /** сколько секунд подряд гироскоп тихий */
  private quietS = 0
  private linBias: Vec3 = [0, 0, 0]
  private stillCount = 0

  private committed = -1
  private pending = -1
  private pendT = 0

  private rotActive = false
  private rotAngle: [number, number, number] = [0, 0, 0]
  private rotQuiet = 0

  private moveActive = false
  private moveBuf: Vec3[] = []
  private preRoll: Vec3[] = []
  private moveStartQ: Quat = [1, 0, 0, 0]
  private moveRot = 0
  private tiltRot = 0
  private moveStartT = 0
  private chain: [number, number][] = []
  private chainEndT = -1e9
  private chainSegs = 0

  private vz = 0
  private lobeSign = 0
  private lobePeak = 0
  private lobeH = 0
  private lobeT = 0
  private lobeRot = 0

  reset(): void {
    const { frame } = this
    Object.assign(this, new MotionAnalyzer())
    this.frame = frame
  }

  push(s: Sample, q: Quat, dt: number): TrikiEvent[] {
    const out: TrikiEvent[] = []
    this.t += dt
    const ready = this.t > 1

    const g: Vec3 = [s.gx - this.bias[0], s.gy - this.bias[1], s.gz - this.bias[2]]
    const gm = Math.hypot(g[0], g[1], g[2])
    const amag = Math.hypot(s.ax, s.ay, s.az)
    const lin = linearAccelWorld(q, [s.ax, s.ay, s.az])
    const linc: Vec3 = [lin[0] - this.linBias[0], lin[1] - this.linBias[1], lin[2] - this.linBias[2]]
    const linm = Math.hypot(linc[0], linc[1], linc[2])

    const still = gm < 5 && Math.abs(amag - 1) < 0.04 && (linm < 0.05 || !ready)
    this.stillCount = still ? this.stillCount + 1 : 0
    this.updateBias(s, amag, dt)
    if (still) {
      // в покое подстраиваем остаточное «линейное» ускорение (ошибка наклона)
      const a = Math.min(1, dt / 0.8)
      if (this.stillCount * dt > 0.15 || !ready) {
        this.linBias = [0, 1, 2].map((i) => this.linBias[i] + (lin[i] - this.linBias[i]) * a) as unknown as Vec3
      }
    }
    this.state.moving = this.stillCount * dt < 0.25

    this.updatePosture(q, dt, ready, out)
    this.updateRotation(g, gm, dt, ready, out)
    this.updateMove(linc, linm, g, gm, q, dt, ready, out)
    this.updateLift(linc[2], gm, dt, ready, out)
    return out
  }

  /**
   * Смещение нуля гироскопа. Оно стабильно (у живого жетона около 3 °/с и почти не меняется за сессию), поэтому
   * подстраиваем его только в «тихом» покое: малый разброс сырых показаний за окно и среднее рядом с текущей оценкой.
   * Иначе медленное скольжение или палец на жетоне (настоящие повороты 1-5 °/с) впитываются в смещение, и ошибка
   * 0.5 °/с за двухсекундное движение наклоняет ориентацию на градус: это ~0.02 g ложного ускорения.
   * Если же гироскоп долго (BIAS_RELOCK_S) тихий, но далеко от оценки - неверна сама оценка (например, при подключении
   * жетон держали в руке и плавно поворачивали): тогда переучиваемся. Без этого ошибка смещения оставалась навсегда,
   * и направление (yaw) уплывало на градусы в секунду, за минуту разворачивая оси.
   */
  private updateBias(s: Sample, amag: number, dt: number): void {
    this.gWin.push([s.gx, s.gy, s.gz])
    const n = Math.max(3, Math.round(BIAS_WIN_S / dt))
    if (this.gWin.length > n) this.gWin.splice(0, this.gWin.length - n)
    if (this.gWin.length < n || Math.abs(amag - 1) > 0.04) {
      this.quietS = 0
      return
    }
    const m = [0, 1, 2].map((k) => this.gWin.reduce((acc, w) => acc + w[k], 0) / n)
    const sd = Math.sqrt(this.gWin.reduce((acc, w) => acc + (w[0] - m[0]) ** 2 + (w[1] - m[1]) ** 2 + (w[2] - m[2]) ** 2, 0) / n)
    const converged = this.biasS > BIAS_CONVERGE_S
    const near = Math.hypot(m[0] - this.bias[0], m[1] - this.bias[1], m[2] - this.bias[2]) < BIAS_NEAR_DPS
    if (sd > BIAS_QUIET_DPS) {
      this.quietS = 0
      return
    }
    this.quietS += dt
    const relock = this.quietS > BIAS_RELOCK_S
    if (converged && !near && !relock) return
    // долгий тихий покой (жетон лежит) - самый надёжный момент: сходимся быстро; короткие паузы - медленно
    const a = Math.min(1, dt / (!converged ? 0.3 : relock ? 0.5 : BIAS_TAU_S))
    this.bias = [0, 1, 2].map((i) => this.bias[i] + ([s.gx, s.gy, s.gz][i] - this.bias[i]) * a) as unknown as Vec3
    this.biasS += dt
  }

  private updatePosture(q: Quat, dt: number, ready: boolean, out: TrikiEvent[]): void {
    const up = rotate(q, [0, 0, 1])
    const tilt = Math.acos(Math.max(-1, Math.min(1, up[2]))) * RAD2DEG
    const idx = classify(tilt, this.committed < 0 ? 0 : this.committed)
    this.state.tiltDeg = tilt
    this.state.posture = POSTURE_NAMES[this.committed < 0 ? idx : this.committed]

    if (this.committed < 0) {
      if (ready) {
        this.committed = idx // первое положение фиксируем молча
        this.pending = idx
      }
      return
    }
    if (idx === this.committed) {
      this.pending = idx
      this.pendT = 0
      return
    }
    this.pendT = idx === this.pending ? this.pendT + dt : 0
    this.pending = idx
    if (this.pendT < POSTURE_HOLD_S) return

    this.committed = idx
    this.pendT = 0
    this.state.posture = POSTURE_NAMES[idx]
    const leanDir: Dir = Math.abs(up[1]) >= Math.abs(up[0]) ? (up[1] > 0 ? 'up' : 'down') : up[0] > 0 ? 'right' : 'left'
    const lean = { up: 'вперёд', down: 'назад', right: 'вправо', left: 'влево' }[leanDir as 'up' | 'down' | 'right' | 'left']
    const deg = Math.round(tilt)
    const text = [
      'Лежит ровно (лицом вверх)',
      `Наклонён на ${deg}° (лицом ${lean})`,
      'Стоит на ребре',
      `Наклонён лицом вниз (${deg}°)`,
      'Перевёрнут (лицом вниз)',
    ][idx]
    out.push({ t: this.t, kind: 'posture', text, confidence: 'high', data: { posture: POSTURE_NAMES[idx], tiltDeg: tilt, dir: leanDir } })
  }

  private updateRotation(g: Vec3, gm: number, dt: number, ready: boolean, out: TrikiEvent[]): void {
    if (!this.rotActive) {
      if (gm <= ROT_START_DPS) return
      this.rotActive = true
      this.rotAngle = [0, 0, 0]
      this.rotQuiet = 0
    }
    for (let i = 0; i < 3; i++) this.rotAngle[i] += g[i] * dt
    this.rotQuiet = gm < ROT_QUIET_DPS ? this.rotQuiet + dt : 0
    if (this.rotQuiet < ROT_QUIET_S) return

    this.rotActive = false
    if (!ready) return
    const abs = this.rotAngle.map(Math.abs)
    const di = abs.indexOf(Math.max(...abs))
    const dom = this.rotAngle[di]
    if (Math.abs(dom) < ROT_MIN_DEG) return
    const second = Math.max(...abs.filter((_, i) => i !== di))
    const deg = Math.round(Math.abs(dom))
    const axis = (['x', 'y', 'z'] as const)[di]
    let text: string
    const complex = second > Math.abs(dom) * 0.5
    const dir: Dir = di === 0 ? (dom > 0 ? 'up' : 'down') : di === 1 ? (dom < 0 ? 'right' : 'left') : dom > 0 ? 'ccw' : 'cw'
    if (complex) {
      text = `Сложное вращение (около ${deg}° по доминирующей оси ${axis.toUpperCase()})`
    } else if (di === 0) {
      // оси датчика развёрнуты на 180° относительно пользователя при «светодиод от себя»: X датчика = влево,
      // поэтому вращение +X наклоняет лицевую сторону к светодиоду (вперёд)
      text = `Прокрут ${dom > 0 ? 'вперёд (к светодиоду)' : 'назад'} на ${deg}° (вокруг X)`
    } else if (di === 1) {
      text = `Прокрут ${dom < 0 ? 'вправо' : 'влево'} на ${deg}° (вокруг Y)`
    } else {
      text = `Поворот на месте ${dom > 0 ? 'против часовой' : 'по часовой'} на ${deg}° (вокруг Z)`
    }
    out.push({ t: this.t, kind: 'rotate', text, confidence: 'medium', data: { axis, angleDeg: dom, dir, complex } })
  }

  private updateMove(linc: Vec3, linm: number, g: Vec3, gm: number, q: Quat, dt: number, ready: boolean, out: TrikiEvent[]): void {
    if (!this.moveActive) {
      this.preRoll.push(linc)
      if (this.preRoll.length > PREROLL) this.preRoll.shift()
      if (!ready || linm < MOVE_START_G) return
      this.moveActive = true
      this.moveBuf = [...this.preRoll]
      this.moveStartQ = q
      this.moveRot = 0
      this.tiltRot = 0
      this.moveStartT = this.t - this.preRoll.length * dt
      return
    }
    this.moveBuf.push(linc)
    this.moveRot += gm * dt
    const gw = rotate(q, g)
    this.tiltRot += Math.hypot(gw[0], gw[1]) * dt
    const tooLong = this.moveBuf.length * dt > MOVE_MAX_S
    if (!tooLong && this.stillCount * dt < STILL_HOLD_S) return

    this.moveActive = false
    this.preRoll = []
    if (tooLong) return // слишком долго: ZUPT не сработал, оценка бессмысленна
    const n = this.moveBuf.length - this.stillCount
    if (n < 2) return

    // скорость = ∫a, затем вычитаем линейный дрейф так, чтобы в конце v = 0 (ZUPT)
    const v: Vec3[] = []
    let acc: Vec3 = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      acc = [acc[0] + this.moveBuf[i][0] * G * dt, acc[1] + this.moveBuf[i][1] * G * dt, acc[2] + this.moveBuf[i][2] * G * dt]
      v.push(acc)
    }
    const vEnd = acc
    let pos: Vec3 = [0, 0, 0]
    const path: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const k = (i + 1) / n
      pos = [pos[0] + (v[i][0] - vEnd[0] * k) * dt, pos[1] + (v[i][1] - vEnd[1] * k) * dt, pos[2] + (v[i][2] - vEnd[2] * k) * dt]
      path.push([pos[0], pos[1]])
    }
    if (this.emitShape(path, dt, out)) return
    if (this.emitCircle(path, out)) {
      this.resetChain()
      return
    }
    if (this.moveRot > MOVE_MAX_ROT_DEG) return // жетон крутили, а не двигали: ускорение в основном ошибка ориентации
    const cm: Vec3 = [pos[0] * 100, pos[1] * 100, pos[2] * 100]
    const { c, names, skipZ } = this.frame === 'body' ? this.toBody(cm) : { c: cm, names: WORLD_NAMES, skipZ: true }
    // вертикальную составляющую в мире ловит детектор подъёма/опускания, здесь её не дублируем
    const used = skipZ ? [0, 1] : [0, 1, 2]
    const maxC = Math.max(...used.map((i) => Math.abs(c[i])))
    if (maxC < MOVE_MIN_CM) return
    const parts = used
      .filter((i) => Math.abs(c[i]) >= MOVE_MIN_CM && Math.abs(c[i]) >= maxC * 0.25)
      .map((i) => `${names[i][c[i] > 0 ? 0 : 1]} ${Math.round(Math.abs(c[i]))} см`)
    out.push({
      t: this.t,
      kind: 'move',
      text: `Смещение: ${parts.join(', ')}`,
      confidence: 'rough',
      data: { dispCm: [c[0], c[1], skipZ ? 0 : c[2]] },
    })
  }

  private resetChain(): void {
    this.chain = []
    this.chainSegs = 0
  }

  /** Квадрат/треугольник в мировой плоскости XY из одного или нескольких штрихов. */
  private emitShape(path: [number, number][], dt: number, out: TrikiEvent[]): boolean {
    if (this.tiltRot > CIRCLE_MAX_TILT_ROT_DEG) {
      this.resetChain()
      return false
    }
    if (this.moveStartT - this.chainEndT > CHAIN_GAP_S || this.chainSegs >= CHAIN_MAX_SEGS) this.resetChain()
    const base: [number, number] = this.chain.length ? this.chain[this.chain.length - 1] : [0, 0]
    if (!this.chain.length) this.chain.push([0, 0])
    for (const p of path) this.chain.push([base[0] + p[0], base[1] + p[1]])
    this.chainSegs++
    this.chainEndT = this.t - this.stillCount * dt

    const r = classifyPolygon(this.chain)
    if (!r) return false
    const strokes = this.chainSegs
    this.resetChain()
    const name = r.shape === 'square' ? 'квадрат' : 'треугольник'
    out.push({
      t: this.t,
      kind: 'shape',
      text: `Фигура: ${name} ${r.ccw ? 'против часовой' : 'по часовой'} (${strokes > 1 ? strokes + ' штрихов, ' : ''}периметр ~${Math.round(r.perimeterM * 100)} см)`,
      confidence: 'rough',
      data: { shape: r.shape, dir: r.ccw ? 'ccw' : 'cw', strokes, perimeterCm: r.perimeterM * 100 },
    })
    return true
  }

  /** Круг в мировой плоскости XY (вид сверху): против часовой = положительная намотка. */
  private emitCircle(path: [number, number][], out: TrikiEvent[]): boolean {
    if (this.tiltRot > CIRCLE_MAX_TILT_ROT_DEG) return false
    const c = analyzeCircle(path)
    if (!c || Math.abs(c.windingDeg) < CIRCLE_MIN_DEG) return false
    if (c.radiusM < CIRCLE_MIN_RADIUS_M || c.radiusM > CIRCLE_MAX_RADIUS_M || c.roundness > CIRCLE_MAX_ROUNDNESS) return false
    const dir: Dir = c.windingDeg > 0 ? 'ccw' : 'cw'
    const loops = Math.max(1, Math.round(Math.abs(c.windingDeg) / 360))
    out.push({
      t: this.t,
      kind: 'circle',
      text: `Движение по кругу ${dir === 'cw' ? 'по часовой' : 'против часовой'} (${loops > 1 ? loops + ' круга, ' : ''}радиус ~${Math.round(c.radiusM * 100)} см)`,
      confidence: 'rough',
      data: { dir, angleDeg: c.windingDeg, radiusCm: c.radiusM * 100 },
    })
    return true
  }

  /**
   * Подъём/опускание: вертикальная скорость из линейного ускорения (интеграл с утечкой 2 с,
   * в покое обнуляется). Событие = одна «доля» скорости (разгон и торможение), высота = площадь доли.
   * Не требует остановки, поэтому работает и когда жетон держат в руке.
   */
  private updateLift(linZ: number, gm: number, dt: number, ready: boolean, out: TrikiEvent[]): void {
    const stillLong = this.stillCount * dt >= LIFT_STILL_S
    if (!ready) {
      this.vz = 0
      this.lobeSign = 0
      return
    }
    if (stillLong) {
      this.endLobe(out)
      this.vz = 0
      return
    }
    this.vz += linZ * G * dt
    this.vz *= 1 - dt / LIFT_LEAK_S
    const sign = this.vz > LIFT_ENTER_MS ? 1 : this.vz < -LIFT_ENTER_MS ? -1 : 0

    if (this.lobeSign !== 0 && sign === this.lobeSign) {
      this.lobePeak = Math.max(this.lobePeak, Math.abs(this.vz))
      this.lobeH += Math.abs(this.vz) * dt
      this.lobeT += dt
      this.lobeRot += gm * dt
      if (this.lobeT > LIFT_MAX_S) {
        this.lobeSign = 0
        this.vz = 0
      }
      return
    }
    this.endLobe(out)
    if (sign !== 0) {
      this.lobeSign = sign
      this.lobePeak = Math.abs(this.vz)
      this.lobeH = 0
      this.lobeT = 0
      this.lobeRot = 0
    }
  }

  private endLobe(out: TrikiEvent[]): void {
    const sign = this.lobeSign
    this.lobeSign = 0
    if (sign === 0) return
    const cm = this.lobeH * 100
    // при вращении жетона вертикальное «ускорение» в основном ошибка ориентации: отбрасываем
    if (this.lobePeak < LIFT_MIN_PEAK_MS || cm < LIFT_MIN_CM || this.lobeRot > MOVE_MAX_ROT_DEG) return
    out.push({
      t: this.t,
      kind: 'lift',
      text: `${sign > 0 ? 'Поднят' : 'Опущен'} на ${Math.round(cm)} см`,
      confidence: 'rough',
      data: { dispCm: [0, 0, sign * cm] },
    })
  }

  /** Мировое смещение -> оси жетона на начало движения: [вправо, вверх(LED), по нормали платы]. */
  private toBody(cm: Vec3): { c: Vec3; names: [string, string][]; skipZ: boolean } {
    const qs = this.moveStartQ
    const d = rotate([qs[0], -qs[1], -qs[2], -qs[3]], cm) // обратный поворот: мир -> датчик
    const [ux, uy] = LED_UP
    const right = d[0] * uy + d[1] * -ux // r = u × Z, при взгляде на плату со стороны +Z
    const up = d[0] * ux + d[1] * uy
    const flat = Math.abs(rotate(qs, [0, 0, 1])[2]) > 0.9 // нормаль платы вертикальна: это подъём, его ловит updateLift
    return {
      c: [right, up, d[2]],
      names: [['вправо', 'влево'], ['вверх (к светодиоду)', 'вниз'], ['из лицевой стороны', 'в обратную сторону']],
      skipZ: flat,
    }
  }
}

const WORLD_NAMES: [string, string][] = [['вправо', 'влево'], ['вперёд', 'назад'], ['вверх', 'вниз']]
