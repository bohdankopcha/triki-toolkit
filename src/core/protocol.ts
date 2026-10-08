// Константы протокола Triki. Источник: Flopsstuff/triki docs/guide/ble-protocol.md, imu-streaming.md
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
export const NUS_CTRL = '6e400004-b5a3-f393-e0a9-e50e24dcca9e'
export const BATTERY_SERVICE = 'battery_service'
export const BATTERY_LEVEL = 'battery_level'

export const FRAME_LEN = 14
export const HEADER = [0x22, 0x00] as const

/** LSM6DSL: ±16 g -> 2048 LSB/g; ±2000 dps -> 14.286 LSB/(deg/s). */
export const ACCEL_LSB_PER_G = 2048
export const GYRO_LSB_PER_DPS = 14.286

export const SUPPORTED_RATES_HZ = [26, 52, 104, 208, 416] as const
export type RateHz = (typeof SUPPORTED_RATES_HZ)[number]

/** Документированная команда старта IMU. Байты 5-6 - частота (uint16 LE), остальное фиксировано. */
export function startCmd(hz: RateHz): Uint8Array {
  return Uint8Array.of(0x20, 0x10, 0x00, 0xd0, 0x07, hz & 0xff, (hz >> 8) & 0xff, 0x03)
}
