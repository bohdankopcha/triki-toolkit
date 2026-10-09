import './style.css'
import {
  SUPPORTED_RATES_HZ, createTriki, isWebBluetoothSupported, tiltAngles, type PostureName, type RateHz, type TrikiEvent,
} from 'triki-kit'
import { renderCombos, renderVocab } from './ui/combos'
import { LineChart } from './ui/chart'
import { mountModel } from './ui/model'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const connectBtn = $<HTMLButtonElement>('connect')
const disconnectBtn = $<HTMLButtonElement>('disconnect')
const rezeroBtn = $<HTMLButtonElement>('rezero')
const ledBtn = $<HTMLButtonElement>('led')
const rateSel = $<HTMLSelectElement>('rate')
const betaIn = $<HTMLInputElement>('beta')
const frameSel = $<HTMLSelectElement>('frame')
const status = $('status')
const logEl = $('log')
const combosEl = $('combos')

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
}

// --- тулкит: вся логика потока, фильтров, детекторов и жестов живёт в пакете ---
const triki = createTriki({ frame: store.get('triki.frame') === 'world' ? 'world' : 'body' })

// --- UI ---
for (const hz of SUPPORTED_RATES_HZ) rateSel.add(new Option(`${hz} Гц`, String(hz), hz === 104, hz === 104))
frameSel.value = triki.getState().frame

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
const colors = () => ['--x', '--y', '--z'].map(css)
const accChart = new LineChart($('acc') as HTMLCanvasElement, colors(), 2)
const gyroChart = new LineChart($('gyro') as HTMLCanvasElement, colors(), 250)
const linChart = new LineChart($('lin') as HTMLCanvasElement, colors(), 1)
const model = mountModel($('scene'), '/triki.glb')
$('mount').onclick = () => model.rotateMount()
renderVocab($('vocab'))
renderCombos(combosEl, [])

// поток кадров: только графики (модель и углы читаются в requestAnimationFrame)
triki.on('sample', (s) => {
  accChart.push(s.accel)
  gyroChart.push(s.gyro)
  linChart.push(s.linear)
})

// журнал и комбо
const CONF = { high: 'высокая', medium: 'средняя', rough: 'грубо' }
function addLog(ev: TrikiEvent): void {
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
triki.on('event', addLog)
triki.on('gesture', () => renderCombos(combosEl, triki.gestures))
$('clearLog').onclick = () => (logEl.innerHTML = '')
$('clearCombos').onclick = () => {
  triki.clearGestures()
  renderCombos(combosEl, [])
}

triki.on('led', (on) => model.setLed(on))

const POSTURE_RU: Record<PostureName, string> = {
  flat: 'Лежит ровно', tilted: 'Наклонён', edge: 'На ребре', 'tilted-down': 'Наклонён лицом вниз', flipped: 'Перевёрнут',
}

// состояние: редкие изменения, рисуем по подписке
function renderState(): void {
  const st = triki.getState()
  const on = st.status === 'streaming'
  connectBtn.disabled = on || st.status === 'connecting'
  disconnectBtn.disabled = !on
  rezeroBtn.disabled = !on
  ledBtn.disabled = !on || !st.hasLed
  $('bat').textContent = st.battery === null ? '-' : `${st.battery}%`
  $('hz').textContent = st.measuredHz === null ? '-' : String(st.measuredHz)
  $('chipMove').textContent = on ? (st.moving ? 'Движение' : 'Покой') : '-'
  $('chipMove').classList.toggle('on', on && st.moving)
  $('chipPosture').textContent = on ? POSTURE_RU[st.posture] : '-'
  $('chipTilt').textContent = on ? `наклон ${st.tiltDeg}°` : '-'
  status.textContent = {
    idle: 'Не подключено',
    connecting: 'Подключение...',
    streaming: st.aligned
      ? 'Выровнено: светодиод жетона = от вас (в экран). Дрейф yaw лечится кнопкой Re-zero.'
      : 'Подключено, идёт поток. Положите жетон ровно на стол светодиодом ОТ СЕБЯ (в экран) на пару секунд: так выровняются калибровка и направления.',
    disconnected: 'Отключено',
    error: `Ошибка: ${st.error ?? ''}`,
  }[st.status]
}
triki.subscribe(renderState)
renderState()

// --- управление ---
connectBtn.onclick = () => void triki.connect()
disconnectBtn.onclick = () => triki.disconnect()
rateSel.onchange = () => void triki.setRate(Number(rateSel.value) as RateHz).catch(() => undefined)
rezeroBtn.onclick = () => triki.rezero()
ledBtn.onclick = () => void triki.setLed(!triki.getState().led).catch((e: Error) => (status.textContent = `LED: ${e.message}`))
betaIn.oninput = () => {
  triki.setBeta(Number(betaIn.value))
  $('betaOut').textContent = betaIn.value
}
frameSel.onchange = () => {
  const f = frameSel.value === 'world' ? 'world' : 'body'
  triki.setFrame(f)
  store.set('triki.frame', f)
}

// модель и углы: читаем последнюю ориентацию каждый кадр отрисовки
function loop(): void {
  accChart.draw()
  gyroChart.draw()
  linChart.draw()
  model.setQuat(triki.orientation)
  const live = triki.getState().status === 'streaming' && triki.sample
  const a = live ? tiltAngles(triki.orientation) : null
  $('roll').textContent = a ? `${a.rollDeg.toFixed(0)}°` : '-'
  $('pitch').textContent = a ? `${a.pitchDeg.toFixed(0)}°` : '-'
  $('yaw').textContent = a ? `${a.yawDeg.toFixed(0)}° (дрейфует)` : '-'
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

if (!isWebBluetoothSupported()) {
  $('unsupported').hidden = false
  connectBtn.disabled = true
}
