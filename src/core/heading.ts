import { quatAboutZ, rotate, type Quat } from './quat'

/**
 * Поправка yaw, после которой светодиод жетона смотрит в мировую +Y («от пользователя, в экран»).
 * Применять как quatMul(offset, q). null, если светодиод почти вертикален и heading не определён.
 */
export function ledAwayOffset(q: Quat, ledUp: readonly [number, number]): Quat | null {
  const v = rotate(q, [ledUp[0], ledUp[1], 0])
  if (Math.hypot(v[0], v[1]) < 0.3) return null
  return quatAboutZ(Math.PI / 2 - Math.atan2(v[1], v[0]))
}
