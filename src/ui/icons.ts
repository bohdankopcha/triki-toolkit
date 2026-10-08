import type { Dir } from '../core/analyzer'
import type { GestureKind } from '../core/gestures'

/** Иконки жестов: статичные SVG-строки из констант (пользовательских данных внутри нет). */
const DEG: Partial<Record<Dir, number>> = {
  up: 0, upright: 45, right: 90, downright: 135, down: 180, downleft: 225, left: 270, upleft: 315,
}

const ARROW = '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'
const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
const rot = (inner: string, deg: number) => `<g transform="rotate(${deg} 12 12)">${inner}</g>`

export function iconSvg(kind: GestureKind, dir?: Dir): string {
  const deg = (dir && DEG[dir]) || 0
  switch (kind) {
    case 'slide':
      return svg(rot(ARROW, deg))
    case 'roll': // стрелка в кольце: вращение с наклоном в сторону
      return svg(`<circle cx="12" cy="12" r="10.5" stroke-width="1.5" opacity=".7"/><g transform="translate(12 12) scale(.58) translate(-12 -12)" stroke-width="3.4">${rot(ARROW, deg)}</g>`)
    case 'lift':
      return dir === 'down'
        ? svg('<path d="M6 3h12"/><path d="M12 7v13"/><path d="M6 14l6 6 6-6"/>')
        : svg('<path d="M6 21h12"/><path d="M12 17V4"/><path d="M6 10l6-6 6 6"/>')
    case 'flip':
      return svg(rot('<path d="M4 8h13"/><path d="M13 4l4 4-4 4"/><path d="M20 16H7"/><path d="M11 12l-4 4 4 4"/>', dir === 'up' || dir === 'down' ? 90 : 0))
    case 'spin': {
      const arc = '<path d="M20 12a8 8 0 1 1-2.8-6.1"/><path d="M20 4v5h-5"/>'
      return svg(dir === 'ccw' ? `<g transform="translate(24 0) scale(-1 1)">${arc}</g>` : arc)
    }
    case 'circle': { // большая круговая стрелка с точкой в центре: «ведут по кругу»
      const arc = '<path d="M21 12a9 9 0 1 1-3.2-6.9"/><path d="M21 3v5h-5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
      return svg(dir === 'ccw' ? `<g transform="translate(24 0) scale(-1 1)">${arc}</g>` : arc)
    }
    case 'twist':
      return svg('<path d="M4 7c4-4 12-4 16 0"/><path d="M4 12c4-4 12-4 16 0"/><path d="M4 17c4-4 12-4 16 0"/>')
    case 'push':
      return svg(dir === 'in'
        ? '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>'
        : '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>')
    case 'edge':
      return svg('<rect x="8.5" y="3" width="7" height="18" rx="2"/>')
    case 'flat':
      return svg('<rect x="3" y="8.5" width="18" height="7" rx="3"/>')
    case 'tilt':
      return svg(`${rot('<rect x="3" y="8.5" width="18" height="7" rx="3"/>', dir === 'left' || dir === 'down' ? 20 : -20)}`)
  }
}
