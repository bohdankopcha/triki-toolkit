import type { Vec3 } from 'triki-kit'

type P = readonly [number, number]

/**
 * Вид сверху на стол (canvas 2D). Мир: X вправо, Y от пользователя (на экране вверх), метры.
 * Масштаб подстраивается так, чтобы путь помещался, но не меньше ±30 см.
 */
export class PlaneView {
  path: P[] = []
  stops: P[] = []
  pos: P = [0, 0]
  /** направление светодиода, радианы от +X против часовой; null - не рисовать */
  heading: number | null = null
  /** куда двигать дальше: единичный вектор или null */
  next: P | null = null
  private range = 0.3
  private readonly ctx: CanvasRenderingContext2D

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
  }

  clear(): void {
    this.path = []
    this.stops = []
    this.pos = [0, 0]
    this.range = 0.3
  }

  /** Обрезать путь до n точек и дописать точки (исправленный путь сегмента). */
  replaceTail(n: number, pts: readonly Vec3[]): void {
    this.path.length = Math.min(n, this.path.length)
    for (const p of pts) this.path.push([p[0], p[1]])
  }

  draw(): void {
    const { canvas, ctx } = this
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    let need = 0.3
    for (const p of [...this.path, this.pos]) need = Math.max(need, Math.abs(p[0]) * 1.15, Math.abs(p[1]) * 1.15)
    this.range = need > this.range ? need : this.range * 0.98 + need * 0.02
    const s = Math.min(w, h) / 2 / this.range
    const X = (x: number) => w / 2 + x * s
    const Y = (y: number) => h / 2 - y * s
    const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

    // сетка 5 см, каждые 10 см ярче
    const lim = Math.ceil((Math.max(w, h) / 2 / s) * 20) / 20
    for (let k = -lim; k <= lim + 1e-9; k += 0.05) {
      const major = Math.round(k * 100) % 10 === 0
      ctx.strokeStyle = major ? css('--border') : css('--panel')
      ctx.lineWidth = major ? 1 : 1
      ctx.beginPath()
      ctx.moveTo(X(k), 0)
      ctx.lineTo(X(k), h)
      ctx.moveTo(0, Y(k))
      ctx.lineTo(w, Y(k))
      ctx.stroke()
    }
    ctx.strokeStyle = css('--muted')
    ctx.beginPath()
    ctx.moveTo(X(0), 0)
    ctx.lineTo(X(0), h)
    ctx.moveTo(0, Y(0))
    ctx.lineTo(w, Y(0))
    ctx.stroke()
    ctx.fillStyle = css('--muted')
    ctx.font = '12px system-ui, sans-serif'
    ctx.fillText('от себя ↑', X(0) + 6, 16)
    ctx.fillText(`сетка 5 см`, 8, h - 8)

    // путь и остановки
    if (this.path.length > 1) {
      ctx.strokeStyle = css('--z')
      ctx.lineWidth = 2
      ctx.beginPath()
      this.path.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
      ctx.stroke()
    }
    ctx.fillStyle = css('--lift')
    for (const p of this.stops) {
      ctx.beginPath()
      ctx.arc(X(p[0]), Y(p[1]), 3.5, 0, Math.PI * 2)
      ctx.fill()
    }

    // куда дальше
    const [px, py] = this.pos
    if (this.next) {
      const L = 0.15
      const ex = px + this.next[0] * L
      const ey = py + this.next[1] * L
      ctx.strokeStyle = css('--y')
      ctx.lineWidth = 2
      ctx.setLineDash([6, 5])
      ctx.beginPath()
      ctx.moveTo(X(px), Y(py))
      ctx.lineTo(X(ex), Y(ey))
      ctx.stroke()
      ctx.setLineDash([])
      const a = Math.atan2(-(ey - py), ex - px)
      ctx.fillStyle = css('--y')
      ctx.beginPath()
      ctx.moveTo(X(ex), Y(ey))
      ctx.lineTo(X(ex) - 12 * Math.cos(a - 0.4), Y(ey) - 12 * Math.sin(a - 0.4))
      ctx.lineTo(X(ex) - 12 * Math.cos(a + 0.4), Y(ey) - 12 * Math.sin(a + 0.4))
      ctx.fill()
    }

    // жетон: кружок и треугольник в сторону светодиода
    ctx.fillStyle = css('--fg')
    ctx.beginPath()
    ctx.arc(X(px), Y(py), 7, 0, Math.PI * 2)
    ctx.fill()
    if (this.heading !== null) {
      const a = -this.heading
      ctx.fillStyle = css('--y')
      ctx.beginPath()
      ctx.moveTo(X(px) + 14 * Math.cos(a), Y(py) + 14 * Math.sin(a))
      ctx.lineTo(X(px) + 7 * Math.cos(a + 2.2), Y(py) + 7 * Math.sin(a + 2.2))
      ctx.lineTo(X(px) + 7 * Math.cos(a - 2.2), Y(py) + 7 * Math.sin(a - 2.2))
      ctx.fill()
    }
  }
}
