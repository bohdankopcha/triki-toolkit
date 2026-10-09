import { ACCEL_LSB_PER_G, GYRO_LSB_PER_DPS } from './protocol.js'
import type { Sample } from './parser.js'
import { quatAboutZ, quatMul, rotate, type Quat, type Vec3 } from './quat.js'

const G = 9.80665

export interface SynthOptions {
  /** Гц */
  rate?: number
  /** пиковая скорость на отрезке, м/с */
  speed?: number
  /** покой перед движением, с (нужен на калибровку и выравнивание) */
  leadS?: number
  /** пауза в каждой вершине, с */
  dwellS?: number
  /** покой после движения, с */
  tailS?: number
  /** СКО шума акселерометра, g (у LSM6DSL порядка 0.002-0.004 g на 104 Гц) */
  accNoiseG?: number
  /** СКО шума гироскопа, °/с */
  gyroNoiseDps?: number
  /** постоянное смещение акселерометра, g, оси датчика */
  accBiasG?: Vec3
  /** постоянное смещение гироскопа, °/с */
  gyroBiasDps?: Vec3
  /** поворот вокруг вертикали за каждый отрезок, градусы (жетон крутят, пока двигают) */
  spinDeg?: number
  /** наклон вокруг оси X жетона туда и обратно за каждый отрезок, амплитуда в градусах */
  tiltDeg?: number
  /** ошибка масштаба гироскопа (0.02 = показывает на 2% больше) */
  gyroScaleErr?: number
  /** округлять до разрешения датчика (как в реальном кадре) */
  quantize?: boolean
  seed?: number
}

export interface SynthTrack {
  samples: Sample[]
  /** истинная позиция на каждом кадре, м, мировые оси */
  truth: Vec3[]
  dt: number
}

/**
 * Синтетический поток IMU для жетона, который лежит ровно светодиодом от пользователя и движется по вершинам
 * (мировые оси, м). Каждый отрезок - профиль минимального рывка от покоя до покоя. По желанию жетон при этом
 * поворачивают вокруг вертикали и наклоняют (датчик в центре вращения).
 * Нужен, чтобы мерить точность оценки позиции против известной траектории.
 */
export function synthesizeImu(waypoints: readonly Vec3[], options: SynthOptions = {}): SynthTrack {
  const o = {
    rate: 104, speed: 0.3, leadS: 3, dwellS: 0.6, tailS: 1, accNoiseG: 0.003, gyroNoiseDps: 0.15,
    accBiasG: [0, 0, 0] as Vec3, gyroBiasDps: [0, 0, 0] as Vec3, spinDeg: 0, tiltDeg: 0, gyroScaleErr: 0,
    quantize: true, seed: 1, ...options,
  }
  const dt = 1 / o.rate
  const rnd = gaussian(o.seed)
  const samples: Sample[] = []
  const truth: Vec3[] = []

  // светодиод (ось -Y датчика) смотрит в мировую +Y: датчик повёрнут на 180° вокруг Z
  const BASE = quatAboutZ(Math.PI)
  let yaw = 0
  let tilt = 0
  let qPrev: Quat = BASE
  const DEG = Math.PI / 180

  const emit = (p: Vec3, aw: Vec3): void => {
    const q = quatMul(quatMul(quatAboutZ(yaw * DEG), BASE), [Math.cos((tilt * DEG) / 2), Math.sin((tilt * DEG) / 2), 0, 0])
    // гироскоп: поворот от прошлого кадра к текущему в осях датчика
    const d = quatMul([qPrev[0], -qPrev[1], -qPrev[2], -qPrev[3]], q)
    const sn = Math.hypot(d[1], d[2], d[3])
    const ang = 2 * Math.atan2(sn, d[0]) * (d[0] < 0 ? -1 : 1)
    const w: Vec3 = sn > 1e-12 ? [(d[1] / sn) * ang, (d[2] / sn) * ang, (d[3] / sn) * ang] : [0, 0, 0]
    qPrev = q
    const as = rotate([q[0], -q[1], -q[2], -q[3]], [aw[0] / G, aw[1] / G, aw[2] / G + 1])
    const gs = (v: number) => (v / DEG / dt) * (1 + o.gyroScaleErr)
    const qz = (v: number, lsb: number) => (o.quantize ? Math.round(v * lsb) / lsb : v)
    samples.push({
      gx: qz(gs(w[0]) + o.gyroBiasDps[0] + rnd() * o.gyroNoiseDps, GYRO_LSB_PER_DPS),
      gy: qz(gs(w[1]) + o.gyroBiasDps[1] + rnd() * o.gyroNoiseDps, GYRO_LSB_PER_DPS),
      gz: qz(gs(w[2]) + o.gyroBiasDps[2] + rnd() * o.gyroNoiseDps, GYRO_LSB_PER_DPS),
      ax: qz(as[0] + o.accBiasG[0] + rnd() * o.accNoiseG, ACCEL_LSB_PER_G),
      ay: qz(as[1] + o.accBiasG[1] + rnd() * o.accNoiseG, ACCEL_LSB_PER_G),
      az: qz(as[2] + o.accBiasG[2] + rnd() * o.accNoiseG, ACCEL_LSB_PER_G),
    })
    truth.push(p)
  }
  const hold = (p: Vec3, s: number): void => {
    for (let i = 0, n = Math.round(s / dt); i < n; i++) emit(p, [0, 0, 0])
  }

  let cur = waypoints[0] ?? [0, 0, 0]
  hold(cur, o.leadS)
  for (const next of waypoints.slice(1)) {
    const d: Vec3 = [next[0] - cur[0], next[1] - cur[1], next[2] - cur[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    if (len > 0) {
      // минимальный рывок: s(τ) = 10τ³ - 15τ⁴ + 6τ⁵, пик скорости 1.875·L/T
      const T = (1.875 * len) / o.speed
      const n = Math.max(2, Math.round(T / dt))
      const yawStart = yaw
      for (let i = 1; i <= n; i++) {
        const tau = i / n
        const s = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5
        yaw = yawStart + o.spinDeg * s
        tilt = o.tiltDeg * Math.sin(Math.PI * s)
        const acc = (60 * tau - 180 * tau ** 2 + 120 * tau ** 3) / (T * T) // доля длины, 1/с²
        emit([cur[0] + d[0] * s, cur[1] + d[1] * s, cur[2] + d[2] * s], [(d[0] * acc), d[1] * acc, d[2] * acc])
      }
    }
    cur = next
    hold(cur, o.dwellS)
  }
  hold(cur, o.tailS)
  return { samples, truth, dt }
}

/** Детерминированный гауссов шум (mulberry32 + Бокс-Мюллер). */
function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uni = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(uni() || 1e-12)) * Math.cos(2 * Math.PI * uni())
}
