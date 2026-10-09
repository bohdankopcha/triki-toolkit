import type { Dir, TrikiEvent } from './analyzer.js'

/**
 * Дискретные жесты поверх событий анализатора. Значения квантуются, поэтому набор конечен и стабилен:
 * поворот только 45/90/135/180/270/360/540/720, перемещение только 5/10/20/30 см.
 * Чистая логика (без DOM/BLE): переносится в будущую программу как есть.
 */
export type GestureKind = 'roll' | 'spin' | 'twist' | 'flip' | 'slide' | 'circle' | 'square' | 'triangle' | 'lift' | 'push' | 'edge' | 'flat' | 'tilt'

export interface Gesture {
  /** стабильный идентификатор для подписки, например "roll.up.90", "flip.up", "slide.upright.10" */
  id: string
  kind: GestureKind
  dir?: Dir
  /** градусы для поворотов, сантиметры для перемещений */
  value?: number
  /** секунды от начала потока */
  t: number
  label: string
  /** сколько предыдущих жестов этот заменил (переворот заменяет прокрут на 180°, фигура заменяет штрихи) */
  replaces?: number
}

export const ANGLES = [45, 90, 135, 180, 270, 360, 540, 720] as const
export const DISTANCES = [5, 10, 20, 30] as const

export function snap(v: number, steps: readonly number[]): number {
  const a = Math.abs(v)
  return steps.reduce((best, s) => (Math.abs(s - a) < Math.abs(best - a) ? s : best), steps[0])
}

const DIR_RU: Record<Dir, string> = {
  up: 'вверх', down: 'вниз', left: 'влево', right: 'вправо',
  upleft: 'вверх-влево', upright: 'вверх-вправо', downleft: 'вниз-влево', downright: 'вниз-вправо',
  cw: 'по часовой', ccw: 'против часовой', out: 'из лицевой стороны', in: 'в обратную сторону',
}
const ROLL_RU: Partial<Record<Dir, string>> = { up: 'вперёд (к светодиоду)', down: 'назад', left: 'влево', right: 'вправо' }

function make(kind: GestureKind, t: number, label: string, dir?: Dir, value?: number): Gesture {
  const id = [kind, dir, value].filter((x) => x !== undefined).join('.')
  return { id, kind, dir, value, t, label }
}

const ROTATIONS: GestureKind[] = ['roll', 'spin', 'twist', 'flip']

export class GestureMapper {
  list: Gesture[] = []
  private prevPosture = 'flat'

  /** true, если список изменился */
  push(ev: TrikiEvent): boolean {
    const d = ev.data
    switch (ev.kind) {
      case 'rotate': {
        if (!d?.angleDeg || !d.dir) return false
        const deg = snap(d.angleDeg, ANGLES)
        if (d.complex) return this.add(make('twist', ev.t, `Сложное вращение ~${deg}°`, undefined, deg))
        if (d.dir === 'cw' || d.dir === 'ccw') return this.add(make('spin', ev.t, `Поворот ${DIR_RU[d.dir]} на ${deg}°`, d.dir, deg))
        return this.add(make('roll', ev.t, `Прокрут ${ROLL_RU[d.dir]} на ${deg}°`, d.dir, deg))
      }
      case 'move': {
        if (!d?.dispCm) return false
        return this.add(this.slide(ev.t, d.dispCm))
      }
      case 'lift': {
        const z = d?.dispCm?.[2]
        if (!z) return false
        const v = snap(z, DISTANCES)
        return this.add(make('lift', ev.t, `${z > 0 ? 'Подъём' : 'Опускание'} на ~${v} см`, z > 0 ? 'up' : 'down', v))
      }
      case 'circle': {
        if (!d?.dir || !d.angleDeg) return false
        const loops = Math.min(3, Math.max(1, Math.round(Math.abs(d.angleDeg) / 360)))
        return this.add(make('circle', ev.t, `Круг ${DIR_RU[d.dir]}${loops > 1 ? ` ×${loops}` : ''}`, d.dir, loops))
      }
      case 'shape': {
        if (!d?.shape || !d.dir) return false
        // штрихи, из которых сложилась фигура, уже ушли в ленту как смещения: убираем их
        let replaces = 0
        for (let n = (d.strokes ?? 1) - 1; n > 0; n--) {
          const last = this.list.at(-1)
          if (last && (last.kind === 'slide' || last.kind === 'push') && ev.t - last.t <= 8) {
            this.list.pop()
            replaces++
          }
        }
        const name = d.shape === 'square' ? 'Квадрат' : 'Треугольник'
        return this.add({ ...make(d.shape, ev.t, `${name} ${DIR_RU[d.dir]}`, d.dir), replaces })
      }
      case 'posture':
        return this.posture(ev)
    }
  }

  clear(): void {
    this.list = []
  }

  private slide(t: number, [r, u, n]: readonly [number, number, number]): Gesture {
    const ar = Math.abs(r)
    const au = Math.abs(u)
    const planeMax = Math.max(ar, au)
    if (Math.abs(n) > planeMax) {
      const v = snap(n, DISTANCES)
      const dir: Dir = n > 0 ? 'out' : 'in'
      return make('push', t, `Смещение ${DIR_RU[dir]} ~${v} см`, dir, v)
    }
    if (Math.min(ar, au) >= planeMax * 0.5) {
      const dir = `${u > 0 ? 'up' : 'down'}${r > 0 ? 'right' : 'left'}` as Dir
      const v = snap(Math.hypot(r, u), DISTANCES)
      return make('slide', t, `Смещение ${DIR_RU[dir]} ~${v} см`, dir, v)
    }
    const dir: Dir = ar > au ? (r > 0 ? 'right' : 'left') : u > 0 ? 'up' : 'down'
    const v = snap(planeMax, DISTANCES)
    return make('slide', t, `Смещение ${DIR_RU[dir]} ~${v} см`, dir, v)
  }

  private posture(ev: TrikiEvent): boolean {
    const name = ev.data?.posture
    if (!name) return false
    const prev = this.prevPosture
    this.prevPosture = name
    const toFlipped = name === 'flipped'
    const backFlat = name === 'flat' && (prev === 'flipped' || prev === 'tilted-down')
    if (toFlipped || backFlat) {
      const last = this.list.at(-1)
      // поворот на 180° вокруг оси в плоскости платы + смена стороны = один переворот
      if (last?.kind === 'roll' && last.value === 180 && ev.t - last.t <= 2) {
        this.list[this.list.length - 1] = { ...make('flip', last.t, `Переворот (${ROLL_RU[last.dir!]})`, last.dir), replaces: 1 }
        return true
      }
      return this.add(make('flip', ev.t, 'Переворот'))
    }
    const last = this.list.at(-1)
    if (last && ROTATIONS.includes(last.kind) && ev.t - last.t <= 2) return false // положение уже объяснено вращением
    if (name === 'edge') return this.add(make('edge', ev.t, 'Поставлен на ребро'))
    if (name === 'flat') return this.add(make('flat', ev.t, 'Положен ровно'))
    if (name === 'tilted' && ev.data?.dir) return this.add(make('tilt', ev.t, 'Наклонён', ev.data.dir))
    return false
  }

  private add(g: Gesture): boolean {
    this.list.push(g)
    if (this.list.length > 200) this.list.shift()
    return true
  }
}

/** Склеивает жесты в комбо: следующий жест идёт в тот же ряд, если пауза не больше gapS. */
export function groupCombos(list: readonly Gesture[], gapS = 1.5): Gesture[][] {
  const rows: Gesture[][] = []
  for (const g of list) {
    const row = rows.at(-1)
    if (row && g.t - row[row.length - 1].t <= gapS) row.push(g)
    else rows.push([g])
  }
  return rows
}

const D4: Dir[] = ['up', 'down', 'left', 'right']
const D8: Dir[] = [...D4, 'upleft', 'upright', 'downleft', 'downright']

/** Полный словарь: что программа может поймать. */
export const VOCAB: { kind: GestureKind; title: string; dirs: Dir[]; values?: readonly number[]; unit?: string }[] = [
  { kind: 'roll', title: 'Прокрут (вперёд к светодиоду, назад, вправо, влево)', dirs: D4, values: ANGLES, unit: '°' },
  { kind: 'spin', title: 'Поворот на месте (по / против часовой)', dirs: ['cw', 'ccw'], values: ANGLES, unit: '°' },
  { kind: 'twist', title: 'Сложное вращение', dirs: [], values: ANGLES, unit: '°' },
  { kind: 'flip', title: 'Переворот (стороной плата/крышка)', dirs: D4 },
  { kind: 'slide', title: 'Смещение по плоскости жетона (светодиод = вверх)', dirs: D8, values: DISTANCES, unit: ' см' },
  { kind: 'circle', title: 'Движение по кругу (вид сверху)', dirs: ['cw', 'ccw'], values: [1, 2, 3], unit: ' кр.' },
  { kind: 'square', title: 'Квадрат (вид сверху, можно штрихами)', dirs: ['cw', 'ccw'] },
  { kind: 'triangle', title: 'Треугольник (вид сверху, можно штрихами)', dirs: ['cw', 'ccw'] },
  { kind: 'lift', title: 'Подъём / опускание', dirs: ['up', 'down'], values: DISTANCES, unit: ' см' },
  { kind: 'push', title: 'Смещение вдоль нормали платы (когда жетон не лежит)', dirs: ['out', 'in'], values: DISTANCES, unit: ' см' },
  { kind: 'edge', title: 'Поставлен на ребро', dirs: [] },
  { kind: 'flat', title: 'Положен ровно', dirs: [] },
  { kind: 'tilt', title: 'Наклонён (без вращения)', dirs: D4 },
]
