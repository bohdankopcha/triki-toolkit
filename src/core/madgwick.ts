import type { Quat } from './quat'

const DEG2RAD = Math.PI / 180

/** 6-осевой Madgwick (гироскоп + акселерометр, без магнитометра): yaw дрейфует. */
export class Madgwick {
  private q: Quat = [1, 0, 0, 0]
  constructor(public beta = 0.08) {}

  reset(): void {
    this.q = [1, 0, 0, 0]
  }

  quaternion(): Quat {
    return this.q
  }

  /** gyro в deg/s, accel в g (достаточно направления), dt в секундах. */
  update(gxDeg: number, gyDeg: number, gzDeg: number, ax: number, ay: number, az: number, dt: number): void {
    let [q0, q1, q2, q3] = this.q
    const gx = gxDeg * DEG2RAD
    const gy = gyDeg * DEG2RAD
    const gz = gzDeg * DEG2RAD

    let d0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz)
    let d1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy)
    let d2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx)
    let d3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx)

    const an = Math.hypot(ax, ay, az)
    if (an > 0) {
      ax /= an
      ay /= an
      az /= an
      // градиент целевой функции (gravity = [0,0,1])
      let s0 = 4 * q0 * q2 * q2 + 2 * q2 * ax + 4 * q0 * q1 * q1 - 2 * q1 * ay
      let s1 = 4 * q1 * q3 * q3 - 2 * q3 * ax + 4 * q0 * q0 * q1 - 2 * q0 * ay - 4 * q1 + 8 * q1 * q1 * q1 + 8 * q1 * q2 * q2 + 4 * q1 * az
      let s2 = 4 * q0 * q0 * q2 + 2 * q0 * ax + 4 * q2 * q3 * q3 - 2 * q3 * ay - 4 * q2 + 8 * q2 * q1 * q1 + 8 * q2 * q2 * q2 + 4 * q2 * az
      let s3 = 4 * q1 * q1 * q3 - 2 * q1 * ax + 4 * q2 * q2 * q3 - 2 * q2 * ay
      const sn = Math.hypot(s0, s1, s2, s3)
      if (sn > 0) {
        s0 /= sn; s1 /= sn; s2 /= sn; s3 /= sn
        d0 -= this.beta * s0
        d1 -= this.beta * s1
        d2 -= this.beta * s2
        d3 -= this.beta * s3
      }
    }

    q0 += d0 * dt
    q1 += d1 * dt
    q2 += d2 * dt
    q3 += d3 * dt
    const n = Math.hypot(q0, q1, q2, q3)
    this.q = [q0 / n, q1 / n, q2 / n, q3 / n]
  }
}
