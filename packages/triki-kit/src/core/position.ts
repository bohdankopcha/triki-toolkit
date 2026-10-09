import type { Vec3 } from './quat.js'

const G = 9.80665

export interface PositionOptions {
  /** покой: сглаженный модуль гироскопа ниже, °/с */
  stillGyroDps?: number
  /** покой: модуль сглаженного линейного ускорения (без гравитации и остаточного смещения) ниже, g */
  stillLinG?: number
  /** постоянная времени сглаживания для детектора покоя, с: шум датчика и дрожь руки иначе мешают низкому порогу */
  stillSmoothS?: number
  /**
   * Второй признак покоя, не зависящий от ориентации: показания акселерометра в осях датчика почти не меняются
   * (СКО за окно ниже steadyAccG) и модуль ≈ g. Нужен после вращения: ошибка наклона даёт постоянное «линейное»
   * ускорение, и по первому признаку жетон на столе выглядел бы движущимся. Линейное при этом всё же ниже steadyMaxLinG.
   * Учитывается, только если в текущем (или, пока выравнивается наклон, в прошлом) движении жетон повернули больше чем
   * на steadyAfterRotDeg: иначе медленное плавное движение по столу тоже выглядело бы «устойчивым».
   */
  steadyAfterRotDeg?: number
  steadyAccG?: number
  steadyMagG?: number
  steadyMaxLinG?: number
  steadyWindowS?: number
  /**
   * Перестаём доверять акселерометру как гравитации (см. trustAccel), как только его показание отличается от
   * показания steadyWindowS назад больше чем на столько, g. Чем ниже, тем меньше ориентация успевает наклониться под
   * плавный разгон, но шум не должен сам по себе пересекать порог.
   */
  trustAccG?: number
  /** покой должен продержаться столько, с, прежде чем обнулить скорость (ZUPT) */
  stillHoldS?: number
  /**
   * При равномерном движении ускорение тоже около нуля. Поэтому короткий покой засчитывается, только если жетон
   * перед этим затормозил: скорость ниже zuptMaxVel, м/с, или её проекция на направление пиковой скорости за сегмент
   * упала до доли zuptPeakRatio от пика. Иначе нужен длинный покой longHoldS: на записях медленное скольжение по
   * столу (почти без ускорения) держалось до ~0.4 с, и при 0.35 с скорость обнулялась посреди движения.
   */
  zuptMaxVel?: number
  zuptPeakRatio?: number
  longHoldS?: number
  /**
   * После движения с вращением (больше steadyAfterRotDeg) наклон обычно ошибается на градусы, и в покое это видно как
   * «линейное» ускорение. Пока оно не упадёт ниже settleOffG, ориентация быстро выравнивается по гравитации
   * (см. suggestBeta), а смещение быстро вычитается. Без вращения так не делаем: начало плавного движения выглядит
   * так же, и быстрое выравнивание «съело» бы его.
   */
  settleOffG?: number
  /** выравнивание не дольше этого, с: на случай, если смещение так и не ушло ниже settleOffG */
  settleMaxS?: number
  /**
   * Форма поправки ZUPT: остаточная скорость вычитается долей (t/T)^zuptShape. 1 - постоянная ошибка ускорения
   * (скорость уплывает линейно); 2 - ошибка ускорения растёт со временем, как от наклона, накопленного гироскопом
   * за движение (в покое смещение вычтено, и ошибка в начале сегмента около нуля). На записях живого жетона 2 даёт
   * меньше ошибки: невозврат после пары туда-обратно 2.1 см против 2.6 при 1.
   */
  zuptShape?: number
  /** за сколько секунд показываемая позиция догоняет оценку после остановки или поправки ZUPT */
  displayCatchUpS?: number
  /** только плоскость стола: вертикальную составляющую не интегрируем */
  planar?: boolean
  /** сегмент движения длиннее этого принудительно закрывается как ненадёжный: иначе позиция улетает на метры, с */
  maxSegmentS?: number
  /** сколько кадров до старта движения добавить в сегмент (ускорение ниже порога покоя), с */
  prerollS?: number
}

/** Кадр для трекера. TrikiSample подходит как есть. */
export interface PositionInput {
  /** °/с, смещение нуля уже вычтено */
  gyro: Vec3
  /** g, оси датчика */
  accel: Vec3
  /** линейное ускорение в мировых осях, g */
  linear: Vec3
}

/** Итог сегмента «покой - движение - покой». Координаты мировые, метры. */
export interface PositionSegment {
  t0: number
  t1: number
  from: Vec3
  /** позиция после поправки ZUPT */
  to: Vec3
  /** скорость в момент остановки до обнуления, м/с: на сколько ошиблось интегрирование (в идеале 0) */
  residualVel: Vec3
  /** насколько поправка ZUPT сдвинула конечную точку, м */
  correction: Vec3
  /** путь сегмента после поправки (точки по кадрам, начиная с from) */
  path: Vec3[]
  /** false: сегмент слишком длинный, оценке верить нельзя */
  valid: boolean
  /** суммарный угол вращения за сегмент, градусы */
  rotDeg: number
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
const ZERO: Vec3 = [0, 0, 0]

/** СКО векторов за окно: корень из суммы дисперсий по осям. */
function windowStd(w: readonly Vec3[]): number {
  const n = w.length
  if (n < 2) return 1
  let m0 = 0, m1 = 0, m2 = 0
  for (const v of w) {
    m0 += v[0]
    m1 += v[1]
    m2 += v[2]
  }
  m0 /= n
  m1 /= n
  m2 /= n
  let s = 0
  for (const v of w) s += (v[0] - m0) ** 2 + (v[1] - m1) ** 2 + (v[2] - m2) ** 2
  return Math.sqrt(s / n)
}

/**
 * Оценка позиции двойным интегрированием линейного ускорения в мировых осях с обнулением скорости в покое (ZUPT).
 * Пока жетон движется, позиция - «живая» (без поправки, плывёт). Когда он снова лёг, остаточная скорость считается
 * накопленной ошибкой: она вычитается по всему сегменту, конечная точка и путь пересчитываются.
 * Отдельно ведётся «сырая» оценка без ZUPT, чтобы видеть, как быстро уплывает чистый интеграл.
 * Чистая логика: ни DOM, ни BLE.
 */
export class PositionTracker {
  readonly opts: Required<PositionOptions>

  /** м, мировые оси (X вправо, Y от пользователя, Z вверх) */
  pos: Vec3 = ZERO
  /**
   * Позиция для отображения. Когда жетон затормозил и ускорение пропало (вероятная остановка), она замирает и не
   * уплывает вместе с остаточной скоростью, а после ZUPT плавно доезжает до исправленной точки.
   */
  shown: Vec3 = ZERO
  /** м/с */
  vel: Vec3 = ZERO
  /** двойной интеграл без ZUPT, м: только для сравнения */
  rawPos: Vec3 = ZERO
  rawVel: Vec3 = ZERO
  /** идёт сегмент движения (скорость интегрируется) */
  moving = false
  /** длительность текущего сегмента, с */
  segmentS = 0
  /** остаточное «линейное» ускорение в покое (ошибка наклона и калибровки), g */
  linBias: Vec3 = ZERO

  private t = 0
  private ready = false
  private stillS = 0
  /** прошлое движение было с вращением (или это старт), и наклон ещё выравнивается */
  private settling = true
  /** сглаженное линейное ускорение (вектор, без вычета смещения): в покое это ошибка наклона */
  private linRest: Vec3 = ZERO
  private settleS = 0
  private braked = true
  private aSmooth: Vec3 = ZERO
  private gSmooth = 0
  /** показания акселерометра за последнее окно steadyWindowS (оси датчика) */
  private accWin: Vec3[] = []
  private accStd = 1
  private accDev = 0
  private gRest = 1
  private peakVel: Vec3 = ZERO
  private segStart: Vec3 = ZERO
  private segT0 = 0
  private segAcc: Vec3[] = []
  private segRot = 0
  private preroll: Vec3[] = []

  constructor(options: PositionOptions = {}) {
    this.opts = {
      stillGyroDps: options.stillGyroDps ?? 8,
      stillLinG: options.stillLinG ?? 0.02,
      stillSmoothS: options.stillSmoothS ?? 0.04,
      steadyAccG: options.steadyAccG ?? 0.01,
      steadyMagG: options.steadyMagG ?? 0.02,
      steadyMaxLinG: options.steadyMaxLinG ?? 0.1,
      steadyWindowS: options.steadyWindowS ?? 0.1,
      steadyAfterRotDeg: options.steadyAfterRotDeg ?? 30,
      trustAccG: options.trustAccG ?? 0.012,
      stillHoldS: options.stillHoldS ?? 0.15,
      zuptMaxVel: options.zuptMaxVel ?? 0.05,
      zuptPeakRatio: options.zuptPeakRatio ?? 0.5,
      longHoldS: options.longHoldS ?? 0.5,
      settleOffG: options.settleOffG ?? 0.006,
      settleMaxS: options.settleMaxS ?? 1.5,
      displayCatchUpS: options.displayCatchUpS ?? 0.1,
      zuptShape: options.zuptShape ?? 2,
      planar: options.planar ?? false,
      maxSegmentS: options.maxSegmentS ?? 3,
      prerollS: options.prerollS ?? 0.08,
    }
  }

  /**
   * Можно ли сейчас доверять акселерометру как датчику гравитации. Во время движения нет: Madgwick наклонит
   * ориентацию под кажущуюся гравитацию и «съест» часть линейного ускорения. Проверка мгновенная (без сглаживания),
   * чтобы перестать доверять с первого кадра движения.
   */
  get trustAccel(): boolean {
    return !this.moving && this.stillS >= this.opts.stillHoldS && this.accDev < this.opts.trustAccG
  }

  /**
   * Рекомендуемое усиление Madgwick на следующий кадр: почти 0 в движении (ориентацию ведёт гироскоп), повышенное в
   * покое, пока виден накопленный при вращении наклон, и обычное в покое. Обычное - низкое: в первые миллисекунды
   * движения, до того как трекер его заметит, ориентация меньше успевает наклониться под ускорение.
   */
  suggestBeta(rest = 0.03, settle = 0.2, moving = 0.002): number {
    if (!this.trustAccel) return moving
    return this.settling ? settle : rest
  }

  /** Вернуть позицию в ноль (и сырую тоже). Смещение покоя сохраняется. */
  zero(): void {
    this.pos = ZERO
    this.shown = ZERO
    this.vel = ZERO
    this.rawPos = ZERO
    this.rawVel = ZERO
    this.segStart = ZERO
    this.segAcc = []
  }

  reset(): void {
    const opts = this.opts
    Object.assign(this, new PositionTracker(opts))
  }

  /** Один кадр. Возвращает сегмент, если на этом кадре закончилось движение. */
  push(s: PositionInput, dt: number): PositionSegment | null {
    const o = this.opts
    this.t += dt
    const k = (tau: number) => Math.min(1, dt / tau)

    const gm = norm(s.gyro)
    this.linRest = add(this.linRest, sub(s.linear, this.linRest), k(0.1))
    this.gSmooth += (gm - this.gSmooth) * k(o.stillSmoothS)
    let a = sub(s.linear, this.linBias)
    if (o.planar) a = [a[0], a[1], 0]
    this.aSmooth = add(this.aSmooth, sub(a, this.aSmooth), k(o.stillSmoothS))
    const linS = norm(this.aSmooth)

    // устойчивость акселерометра в осях датчика: от ошибки ориентации не зависит. Окно честное, не экспоненциальное:
    // сразу после быстрого вращения оно уже чистое, а экспоненциальное среднее ещё долго «помнило» бы вращение
    // мгновенное отличие от показания начала окна: им снимаем доверие к акселерометру с первого кадра движения
    this.accDev = this.accWin.length ? norm(sub(s.accel, this.accWin[0])) : 0
    this.accWin.push(s.accel)
    const win = Math.max(2, Math.round(o.steadyWindowS / dt))
    if (this.accWin.length > win) this.accWin.splice(0, this.accWin.length - win)
    this.accStd = windowStd(this.accWin)
    const amag = norm(s.accel)
    const steady = this.accStd < o.steadyAccG && Math.abs(amag - this.gRest) < o.steadyMagG && linS < o.steadyMaxLinG

    const rotated = this.moving ? this.segRot > o.steadyAfterRotDeg : this.settling
    const still = this.gSmooth < o.stillGyroDps && (linS < o.stillLinG || (steady && rotated))
    this.stillS = still ? this.stillS + dt : 0
    if (steady && !this.moving) this.gRest += (amag - this.gRest) * k(2)

    // первые полсекунды только оцениваем смещение покоя
    if (!this.ready) {
      if (still) this.trackBias(s.linear, dt, 0.15)
      if (this.stillS > 0.5) this.ready = true
      return null
    }

    // сырой интеграл: всегда, без обнуления
    this.rawVel = add(this.rawVel, a, G * dt)
    this.rawPos = add(this.rawPos, this.rawVel, dt)

    const before = this.pos
    const seg = this.step(a, s.linear, gm, still, dt)
    // Показываемая позиция идёт за оценкой, но стоит, пока жетон, похоже, остановился (иначе её уносит остаточной
    // скоростью). Посреди движения не замирает: ускорение проходит через ноль и на пике скорости, и стоп-кадры дали бы
    // «волнистую» линию. На кадре ZUPT оценка прыгает в исправленную точку: прыжок не повторяем, а выбираем плавно.
    if (this.moving && this.stillS > 0 && this.braked) return seg
    if (!seg) this.shown = add(this.shown, sub(this.pos, before))
    this.shown = add(this.shown, sub(this.pos, this.shown), k(o.displayCatchUpS))
    return seg
  }

  private step(a: Vec3, linear: Vec3, gm: number, still: boolean, dt: number): PositionSegment | null {
    const o = this.opts
    if (!this.moving) {
      if (still) {
        this.settleS += dt
        if (norm(this.linRest) < o.settleOffG || this.settleS > o.settleMaxS) this.settling = false
        // пока ориентация выравнивается, «линейное» смещение быстро меняется: следим быстрее
        this.trackBias(linear, dt, this.settling ? 0.1 : 0.8)
        this.preroll.push(a)
        const keep = Math.max(1, Math.round(o.prerollS / dt))
        if (this.preroll.length > keep) this.preroll.splice(0, this.preroll.length - keep)
        return null
      }
      this.startSegment(dt)
    }

    this.addSample(a, gm, dt)
    this.segmentS = this.segAcc.length * dt
    const speed = norm(this.vel)
    const peak = norm(this.peakVel)
    if (!still && speed > peak) this.peakVel = this.vel
    const along = peak > 0 ? (this.vel[0] * this.peakVel[0] + this.vel[1] * this.peakVel[1] + this.vel[2] * this.peakVel[2]) / peak : speed
    const slow = speed < o.zuptMaxVel
    this.braked = slow || along < peak * o.zuptPeakRatio

    if (this.segmentS > o.maxSegmentS) return this.finishSegment(dt)
    if (this.stillS < o.stillHoldS) return null
    if (this.stillS < o.longHoldS && !this.braked) return null
    return this.finishSegment(dt)
  }

  private addSample(a: Vec3, gm: number, dt: number): void {
    this.segRot += gm * dt
    this.segAcc.push(a)
    this.vel = add(this.vel, a, G * dt)
    this.pos = add(this.pos, this.vel, dt)
  }

  private trackBias(linear: Vec3, dt: number, tauS: number): void {
    const l: Vec3 = this.opts.planar ? [linear[0], linear[1], this.linBias[2]] : linear
    this.linBias = add(this.linBias, sub(l, this.linBias), Math.min(1, dt / tauS))
  }

  /** Начало движения: прокручиваем предысторию, где ускорение ещё было ниже порога. */
  private startSegment(dt: number): void {
    this.moving = true
    this.settling = false
    this.segStart = this.pos
    this.segT0 = this.t - (this.preroll.length + 1) * dt
    this.segAcc = []
    this.segRot = 0
    this.vel = ZERO
    this.peakVel = ZERO
    this.braked = true
    for (const a of this.preroll) this.addSample(a, 0, dt)
    this.preroll = []
  }

  /** ZUPT: скорость к концу сегмента должна быть 0, остаток вычитаем по времени (см. zuptShape) и пересчитываем путь. */
  private finishSegment(dt: number): PositionSegment {
    const n = this.segAcc.length
    const residualVel = this.vel
    const path: Vec3[] = [this.segStart]
    let v: Vec3 = ZERO
    let p: Vec3 = this.segStart
    for (let i = 0; i < n; i++) {
      v = add(v, this.segAcc[i], G * dt)
      p = add(p, add(v, residualVel, -(((i + 1) / n) ** this.opts.zuptShape)), dt)
      path.push(p)
    }
    const seg: PositionSegment = {
      t0: this.segT0,
      t1: this.t,
      from: this.segStart,
      to: p,
      residualVel,
      correction: sub(p, this.pos),
      path,
      valid: n * dt <= this.opts.maxSegmentS,
      rotDeg: this.segRot,
    }
    this.pos = p
    this.vel = ZERO
    this.settling = this.segRot > this.opts.steadyAfterRotDeg
    this.settleS = 0
    this.moving = false
    this.segmentS = 0
    this.segAcc = []
    return seg
  }
}
