import './style.css'
import { TrikiLink } from './ble/triki'
import { FrameParser } from './core/parser'
import { SUPPORTED_RATES_HZ, type RateHz } from './core/protocol'
import { Madgwick } from './core/madgwick'
import { linearAccelWorld } from './core/linear'
import { quatAboutZ, quatMul, yawOf, rotate, type Quat } from './core/quat'
import { LED_UP, MotionAnalyzer, type TrikiEvent } from './core/analyzer'
import { ledAwayOffset } from './core/heading'
import { GestureMapper } from './core/gestures'
import { renderCombos, renderVocab } from './ui/combos'
import { LineChart } from './ui/chart'
import { mountModel } from './ui/model'

// Первые ~20 кадров после старта - шум (по документации, "to be verified")
const WARMUP_FRAMES = 20

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const connectBtn = $<HTMLButtonElement>('connect')
const disconnectBtn = $<HTMLButtonElement>('disconnect')
const rezeroBtn = $<HTMLButtonElement>('rezero')
const ledBtn = $<HTMLButtonElement>('led')
const rateSel = $<HTMLSelectElement>('rate')
const betaIn = $<HTMLInputElement>('beta')
const status = $('status')

for (const hz of SUPPORTED_RATES_HZ) rateSel.add(new Option(`${hz} Гц`, String(hz), hz === 104, hz === 104))

const XYZ = ['var(--x)', 'var(--y)', 'var(--z)']
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim()
const colors = () => XYZ.map(css)
const accChart = new LineChart($('acc') as HTMLCanvasElement, colors(), 2)
const gyroChart = new LineChart($('gyro') as HTMLCanvasElement, colors(), 250)
const linChart = new LineChart($('lin') as HTMLCanvasElement, colors(), 1)
const model = mountModel($('scene'), '/triki.glb')
$('mount').onclick = () => model.rotateMount()

const madgwick = new Madgwick(0.08)
const analyzer = new MotionAnalyzer()
const gestures = new GestureMapper()
const parser = new FrameParser()
let rate: RateHz = 104
let yawOffset: Quat = [1, 0, 0, 0]
let frames = 0
let lastQ: Quat = [1, 0, 0, 0]
let led = false
let hzCount = 0
let hzSince = performance.now()
let hzShown = 0
// Реальный шаг между кадрами = время / число кадров за окно (пачки BLE и потери кадров искажают номинал)
let dt = 1 / rate
let autoAligned = false

/** Один раз после подключения, когда жетон лежит спокойно: светодиод -> в экран (см. Re-zero). */
function autoAlign(): void {
  if (autoAligned || frames < WARMUP_FRAMES + 2 * rate) return
  if (analyzer.state.moving || analyzer.state.tiltDeg > 30) return
  autoAligned = true
  const off = ledAwayOffset(madgwick.quaternion(), LED_UP)
  if (off) yawOffset = off
  status.textContent = 'Выровнено: светодиод жетона = от вас (в экран). Дрейф yaw лечится кнопкой Re-zero.'
}

function tickRate(): void {
  const now = performance.now()
  const el = now - hzSince
  if (el < 1000) return
  if (hzCount > 20) {
    hzShown = Math.round((hzCount * 1000) / el)
    const meas = el / 1000 / hzCount
    dt = Math.min(2 / rate, Math.max(0.5 / rate, dt * 0.5 + meas * 0.5))
  }
  hzCount = 0
  hzSince = now
}

const link = new TrikiLink({
  onData(chunk) {
    for (const s of parser.push(chunk)) {
      if (++frames <= WARMUP_FRAMES) continue
      hzCount++
      // Пачки приходят разом, поэтому dt берём усреднённый за окно (см. tickRate), а не разницу времени прихода
      const b = analyzer.gyroBias // смещение нуля гироскопа иначе копится в yaw
      madgwick.update(s.gx - b[0], s.gy - b[1], s.gz - b[2], s.ax, s.ay, s.az, dt)
      lastQ = quatMul(yawOffset, madgwick.quaternion())
      const lin = linearAccelWorld(lastQ, [s.ax, s.ay, s.az])
      accChart.push([s.ax, s.ay, s.az])
      gyroChart.push([s.gx, s.gy, s.gz])
      linChart.push(lin)
      for (const ev of analyzer.push(s, lastQ, dt)) addEvent(ev)
      autoAlign()
    }
    tickRate()
  },
  onBattery: (p) => ($('bat').textContent = `${p}%`),
  onDisconnect() {
    setConnected(false)
    status.textContent = 'Отключено'
  },
})

const frameSel = $<HTMLSelectElement>('frame')
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
}
function applyFrameOpts(): void {
  analyzer.frame = frameSel.value === 'world' ? 'world' : 'body'
}
frameSel.value = store.get('triki.frame') ?? 'body'
if (!frameSel.value) frameSel.value = 'body'
applyFrameOpts()
frameSel.onchange = () => {
  applyFrameOpts()
  store.set('triki.frame', frameSel.value)
}

const logEl = $('log')
const CONF = { high: 'высокая', medium: 'средняя', rough: 'грубо' }
const combosEl = $('combos')
renderCombos(combosEl, [])
renderVocab($('vocab'))
$('clearCombos').onclick = () => {
  gestures.clear()
  renderCombos(combosEl, [])
}

function addEvent(ev: TrikiEvent): void {
  if (gestures.push(ev)) renderCombos(combosEl, gestures.list)
  if (logEl.firstElementChild?.classList.contains('muted')) logEl.innerHTML = ''
  const li = document.createElement('li')
  const time = document.createElement('time')
  time.textContent = `${ev.t.toFixed(1)}с`
  const text = document.createElement('span')
  text.textContent = ev.text
  const tag = document.createElement('span')
  tag.className = 'tag'
  tag.textContent = CONF[ev.confidence]
  li.append(time, text, tag)
  logEl.prepend(li)
  while (logEl.children.length > 50) logEl.lastElementChild?.remove()
}
$('clearLog').onclick = () => (logEl.innerHTML = '')

const POSTURE_RU: Record<string, string> = {
  flat: 'Лежит ровно', tilted: 'Наклонён', edge: 'На ребре', 'tilted-down': 'Наклонён лицом вниз', flipped: 'Перевёрнут',
}

function setConnected(on: boolean): void {
  connectBtn.disabled = on
  disconnectBtn.disabled = !on
  rezeroBtn.disabled = !on
  ledBtn.disabled = !on
}

connectBtn.onclick = async () => {
  status.textContent = 'Подключение...'
  try {
    rate = Number(rateSel.value) as RateHz
    parser.reset()
    madgwick.reset()
    analyzer.reset()
    yawOffset = [1, 0, 0, 0]
    frames = 0
    dt = 1 / rate
    autoAligned = false
    await link.connect(rate)
    setConnected(true)
    ledBtn.disabled = !link.hasLed
    status.textContent = 'Подключено, идёт поток. Положите жетон ровно на стол светодиодом ОТ СЕБЯ (в экран) на пару секунд: так выровняются калибровка и направления.'
  } catch (e) {
    setConnected(false)
    status.textContent = `Ошибка: ${(e as Error).message}`
  }
}
disconnectBtn.onclick = () => link.disconnect()
rateSel.onchange = async () => {
  rate = Number(rateSel.value) as RateHz
  analyzer.reset()
  dt = 1 / rate
  autoAligned = false
  frames = 0 // после перезапуска потока снова пропускаем шумные кадры
  parser.reset()
  try { await link.setRate(rate) } catch { /* не подключено */ }
}
rezeroBtn.onclick = () => {
  // светодиод (верх жетона) -> в мировую +Y, то есть в экран; если светодиод вертикален, просто обнуляем yaw
  const q = madgwick.quaternion()
  yawOffset = ledAwayOffset(q, LED_UP) ?? quatAboutZ(-yawOf(q))
}
ledBtn.onclick = async () => {
  led = !led
  try { await link.setLed(led) } catch (e) { status.textContent = `LED: ${(e as Error).message}` }
}
betaIn.oninput = () => {
  madgwick.beta = Number(betaIn.value)
  $('betaOut').textContent = betaIn.value
}

function loop(): void {
  accChart.draw()
  gyroChart.draw()
  linChart.draw()
  model.setQuat(lastQ)

  // углы считаем из кватерниона: roll/pitch из направления "вверх" датчика, yaw - heading
  const up = rotate(lastQ, [0, 0, 1])
  const deg = 180 / Math.PI
  $('roll').textContent = frames ? `${(Math.atan2(up[1], up[2]) * deg).toFixed(0)}°` : '-'
  $('pitch').textContent = frames ? `${(Math.asin(Math.max(-1, Math.min(1, up[0]))) * deg).toFixed(0)}°` : '-'
  $('yaw').textContent = frames ? `${(yawOf(lastQ) * deg).toFixed(0)}° (дрейфует)` : '-'
  $('hz').textContent = hzShown ? `${hzShown}` : '-'
  if (frames > WARMUP_FRAMES) {
    const st = analyzer.state
    $('chipMove').textContent = st.moving ? 'Движение' : 'Покой'
    $('chipMove').classList.toggle('on', st.moving)
    $('chipPosture').textContent = POSTURE_RU[st.posture]
    $('chipTilt').textContent = `наклон ${st.tiltDeg.toFixed(0)}°`
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

if (!TrikiLink.supported()) {
  $('unsupported').hidden = false
  connectBtn.disabled = true
}
