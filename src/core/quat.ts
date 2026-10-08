export type Quat = readonly [w: number, x: number, y: number, z: number]
export type Vec3 = readonly [number, number, number]

export const QUAT_IDENTITY: Quat = [1, 0, 0, 0]

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ]
}

export function quatAboutZ(rad: number): Quat {
  return [Math.cos(rad / 2), 0, 0, Math.sin(rad / 2)]
}

export function yawOf(q: Quat): number {
  return Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3]))
}

/** Поворот вектора кватернионом: v' = q v q*. Из системы датчика в мировую. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q
  const [vx, vy, vz] = v
  // t = 2 * (q.xyz × v)
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)]
}

/** Матрица 3x3 (row-major, 9 чисел) из кватерниона. */
export function toMatrix(q: Quat): number[] {
  const [w, x, y, z] = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]
}
