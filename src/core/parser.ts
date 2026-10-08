import { ACCEL_LSB_PER_G, FRAME_LEN, GYRO_LSB_PER_DPS, HEADER } from './protocol'

export interface Sample {
  /** deg/s */
  gx: number
  gy: number
  gz: number
  /** g */
  ax: number
  ay: number
  az: number
}

export function decodeFrame(f: Uint8Array): Sample {
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength)
  return {
    gx: dv.getInt16(2, true) / GYRO_LSB_PER_DPS,
    gy: dv.getInt16(4, true) / GYRO_LSB_PER_DPS,
    gz: dv.getInt16(6, true) / GYRO_LSB_PER_DPS,
    ax: dv.getInt16(8, true) / ACCEL_LSB_PER_G,
    ay: dv.getInt16(10, true) / ACCEL_LSB_PER_G,
    az: dv.getInt16(12, true) / ACCEL_LSB_PER_G,
  }
}

/** Накапливает куски notification, ищет заголовок 22 00, отдаёт целые 14-байтовые кадры. */
export class FrameParser {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): Sample[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged

    const out: Sample[] = []
    for (;;) {
      const i = this.findHeader()
      if (i < 0) {
        // оставляем последний байт: это может быть половина заголовка
        if (this.buf.length > 0) this.buf = this.buf.slice(this.buf.length - 1)
        break
      }
      if (i > 0) this.buf = this.buf.slice(i)
      if (this.buf.length < FRAME_LEN) break
      out.push(decodeFrame(this.buf.subarray(0, FRAME_LEN)))
      this.buf = this.buf.slice(FRAME_LEN)
    }
    return out
  }

  reset(): void {
    this.buf = new Uint8Array(0)
  }

  private findHeader(): number {
    for (let i = 0; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === HEADER[0] && this.buf[i + 1] === HEADER[1]) return i
    }
    return -1
  }
}
