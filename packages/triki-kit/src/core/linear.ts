import { rotate, type Quat, type Vec3 } from './quat.js'

/**
 * Линейное ускорение в мировых осях (g): поворачиваем показание акселерометра в мировую
 * систему и вычитаем гравитацию (мировая +Z). Точность зависит от качества ориентации.
 */
export function linearAccelWorld(q: Quat, a: Vec3): Vec3 {
  const w = rotate(q, a)
  return [w[0], w[1], w[2] - 1]
}
