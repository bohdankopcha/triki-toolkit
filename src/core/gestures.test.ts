import { describe, expect, it } from 'vitest'
import type { Dir, TrikiEvent } from './analyzer'
import { GestureMapper, groupCombos, snap, ANGLES, DISTANCES, VOCAB } from './gestures'

const rot = (t: number, angleDeg: number, dir: Dir, complex = false): TrikiEvent => ({
  t, kind: 'rotate', text: '', confidence: 'medium', data: { angleDeg, dir, complex },
})
const posture = (t: number, name: string, dir: Dir = 'up'): TrikiEvent => ({
  t, kind: 'posture', text: '', confidence: 'high', data: { posture: name, dir },
})
const move = (t: number, d: [number, number, number]): TrikiEvent => ({ t, kind: 'move', text: '', confidence: 'rough', data: { dispCm: d } })

describe('snap', () => {
  it('углы только из набора', () => {
    expect(snap(30, ANGLES)).toBe(45)
    expect(snap(-70, ANGLES)).toBe(90)
    expect(snap(115, ANGLES)).toBe(135)
    expect(snap(170, ANGLES)).toBe(180)
    expect(snap(350, ANGLES)).toBe(360)
    expect(snap(5000, ANGLES)).toBe(720)
  })
  it('расстояния', () => {
    expect(snap(3, DISTANCES)).toBe(5)
    expect(snap(14, DISTANCES)).toBe(10)
    expect(snap(16, DISTANCES)).toBe(20)
    expect(snap(80, DISTANCES)).toBe(30)
  })
})

describe('GestureMapper', () => {
  it('поворот квантуется и получает стабильный id', () => {
    const m = new GestureMapper()
    m.push(rot(1, 82, 'up'))
    m.push(rot(5, -48, 'cw'))
    expect(m.list.map((g) => g.id)).toEqual(['roll.up.90', 'spin.cw.45'])
  })

  it('сложное вращение = twist без направления', () => {
    const m = new GestureMapper()
    m.push(rot(1, 200, 'up', true))
    expect(m.list[0].id).toBe('twist.180')
  })

  it('поворот на 180 + смена стороны сливаются в один переворот', () => {
    const m = new GestureMapper()
    m.push(rot(1, 178, 'right'))
    m.push(posture(1.5, 'flipped'))
    expect(m.list.map((g) => g.id)).toEqual(['flip.right'])
    m.push(rot(6, 181, 'right'))
    m.push(posture(6.5, 'flat')) // обратно: тоже переворот
    expect(m.list.map((g) => g.id)).toEqual(['flip.right', 'flip.right'])
  })

  it('положение, объяснённое поворотом на 90, отдельным жестом не дублируется', () => {
    const m = new GestureMapper()
    m.push(rot(1, 90, 'up'))
    m.push(posture(1.4, 'edge'))
    expect(m.list.map((g) => g.id)).toEqual(['roll.up.90'])
  })

  it('положение без вращения даёт жест', () => {
    const m = new GestureMapper()
    m.push(posture(10, 'edge'))
    expect(m.list.map((g) => g.id)).toEqual(['edge'])
  })

  it('смещение: ось, диагональ, нормаль', () => {
    const m = new GestureMapper()
    m.push(move(1, [11, 1, 0])) // вправо
    m.push(move(3, [-2, 9, 0])) // вверх
    m.push(move(5, [8, 9, 0])) // диагональ
    m.push(move(7, [1, 1, -22])) // вдоль нормали, внутрь
    expect(m.list.map((g) => g.id)).toEqual(['slide.right.10', 'slide.up.10', 'slide.upright.10', 'push.in.20'])
  })

  it('подъём и опускание', () => {
    const m = new GestureMapper()
    m.push({ t: 1, kind: 'lift', text: '', confidence: 'rough', data: { dispCm: [0, 0, 9] } })
    m.push({ t: 3, kind: 'lift', text: '', confidence: 'rough', data: { dispCm: [0, 0, -4] } })
    expect(m.list.map((g) => g.id)).toEqual(['lift.up.10', 'lift.down.5'])
  })
})

describe('круг', () => {
  it('круг -> id circle.<dir>.<кругов>', () => {
    const m = new GestureMapper()
    m.push({ t: 1, kind: 'circle', text: '', confidence: 'rough', data: { dir: 'cw', angleDeg: -370 } })
    m.push({ t: 5, kind: 'circle', text: '', confidence: 'rough', data: { dir: 'ccw', angleDeg: 730 } })
    expect(m.list.map((g) => g.id)).toEqual(['circle.cw.1', 'circle.ccw.2'])
  })
})

describe('groupCombos', () => {
  it('склеивает жесты с паузой до 1.5 с', () => {
    const m = new GestureMapper()
    m.push(rot(1, 90, 'up'))
    m.push(rot(2, 90, 'up'))
    m.push(rot(2.8, 180, 'cw'))
    m.push(rot(10, 90, 'left'))
    expect(groupCombos(m.list).map((r) => r.length)).toEqual([3, 1])
  })
})

describe('VOCAB', () => {
  it('id всех жестов уникальны и покрывают то, что выдаёт маппер', () => {
    const ids = new Set<string>()
    for (const v of VOCAB) {
      const dirs = v.dirs.length ? v.dirs : [undefined]
      for (const d of dirs) for (const val of v.values ?? [undefined]) {
        const id = [v.kind, d, val].filter((x) => x !== undefined).join('.')
        expect(ids.has(id)).toBe(false)
        ids.add(id)
      }
    }
    expect(ids.has('roll.up.90') && ids.has('flip.up') && ids.has('slide.upright.10') && ids.has('lift.up.10')).toBe(true)
  })
})
