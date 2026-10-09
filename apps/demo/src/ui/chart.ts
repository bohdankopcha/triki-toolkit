/** Скролл-график на canvas. Хранит кольцевые буферы, рисует последние `windowSize` точек. */
export class LineChart {
  private data: Float32Array[]
  private head = 0
  private count = 0
  private ctx: CanvasRenderingContext2D
  private range: number
  windowSize = 520

  constructor(
    private canvas: HTMLCanvasElement,
    private colors: string[],
    private minRange: number,
    private capacity = 4096,
  ) {
    this.data = colors.map(() => new Float32Array(capacity))
    this.ctx = canvas.getContext('2d')!
    this.range = minRange
  }

  push(values: readonly number[]): void {
    values.forEach((v, i) => (this.data[i][this.head] = v))
    this.head = (this.head + 1) % this.capacity
    this.count = Math.min(this.count + 1, this.capacity)
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

    const n = Math.min(this.windowSize, this.count)
    let peak = 0
    for (const s of this.data) {
      for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(s[(this.head - 1 - k + this.capacity) % this.capacity]))
    }
    // автомасштаб: быстро растёт, медленно сжимается
    const target = Math.max(this.minRange, peak * 1.1)
    this.range = target > this.range ? target : this.range * 0.97 + target * 0.03

    ctx.strokeStyle = 'rgba(128,128,128,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()
    ctx.fillStyle = 'rgba(128,128,128,0.9)'
    ctx.font = '11px ui-monospace, monospace'
    ctx.fillText(`±${this.range.toFixed(this.range < 10 ? 1 : 0)}`, 6, 13)

    if (n < 2) return
    this.data.forEach((s, si) => {
      ctx.strokeStyle = this.colors[si]
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let k = 0; k < n; k++) {
        const v = s[(this.head - n + k + this.capacity) % this.capacity]
        const x = (k / (this.windowSize - 1)) * w + (w - (n / (this.windowSize - 1)) * w)
        const y = h / 2 - (v / this.range) * (h / 2 - 4)
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    })
  }
}
