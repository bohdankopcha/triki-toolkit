import {
  BATTERY_LEVEL, BATTERY_SERVICE, NUS_CTRL, NUS_RX, NUS_SERVICE, NUS_TX, startCmd, type RateHz,
} from '../core/protocol'

export interface TrikiHandlers {
  onData(chunk: Uint8Array): void
  onBattery(percent: number): void
  onDisconnect(): void
}

/**
 * Тонкий слой над Web Bluetooth. Только чтение + две документированные записи:
 * команда старта IMU (RX) и флаг зелёного светодиода (ctrl). Больше ничего на устройство не шлём.
 */
export class TrikiLink {
  private device: BluetoothDevice | null = null
  private rx: BluetoothRemoteGATTCharacteristic | null = null
  private ctrl: BluetoothRemoteGATTCharacteristic | null = null
  constructor(private h: TrikiHandlers) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth
  }

  get hasLed(): boolean {
    return this.ctrl !== null
  }

  /** Вызывать из обработчика клика (нужен жест пользователя). */
  async connect(rate: RateHz): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      // prefix в Web Bluetooth чувствителен к регистру, поэтому оба написания
      filters: [{ namePrefix: 'TRIKI' }, { namePrefix: 'Triki' }],
      optionalServices: [NUS_SERVICE, BATTERY_SERVICE],
    })
    this.device = device
    device.addEventListener('gattserverdisconnected', this.onGone)
    const gatt = await device.gatt!.connect()
    try {
      const svc = await gatt.getPrimaryService(NUS_SERVICE)
      this.rx = await svc.getCharacteristic(NUS_RX)
      const tx = await svc.getCharacteristic(NUS_TX)
      this.ctrl = await svc.getCharacteristic(NUS_CTRL).catch(() => null)
      tx.addEventListener('characteristicvaluechanged', this.onNotify)
      await tx.startNotifications()
      void this.readBattery(gatt)
      await this.setRate(rate)
    } catch (e) {
      if (gatt.connected) gatt.disconnect()
      throw e
    }
  }

  /** Повторная отправка команды старта с новой частотой (так делает и референс). */
  async setRate(rate: RateHz): Promise<void> {
    if (!this.rx) throw new Error('Не подключено')
    await this.rx.writeValueWithoutResponse(startCmd(rate) as BufferSource)
  }

  async setLed(on: boolean): Promise<void> {
    if (!this.ctrl) throw new Error('LED недоступен')
    await this.ctrl.writeValue(Uint8Array.of(on ? 1 : 0))
  }

  /** Чтение регистра светодиода (документирован как read/write). null, если регистра нет. */
  async readLed(): Promise<boolean | null> {
    if (!this.ctrl) return null
    const v = await this.ctrl.readValue()
    return v.byteLength ? v.getUint8(0) !== 0 : null
  }

  disconnect(): void {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect()
  }

  private onNotify = (e: Event): void => {
    const v = (e.target as BluetoothRemoteGATTCharacteristic).value
    if (v) this.h.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
  }

  private onGone = (): void => {
    this.rx = this.ctrl = null
    this.h.onDisconnect()
  }

  private async readBattery(gatt: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const c = await (await gatt.getPrimaryService(BATTERY_SERVICE)).getCharacteristic(BATTERY_LEVEL)
      const v = await c.readValue()
      if (v.byteLength) this.h.onBattery(v.getUint8(0))
    } catch {
      /* батарейного сервиса может не быть */
    }
  }
}
