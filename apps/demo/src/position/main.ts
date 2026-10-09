import '../style.css'
import {
  PositionPipeline, Recorder, SUPPORTED_RATES_HZ, createTriki, isWebBluetoothSupported,
  type PositionSegment, type RateHz, type TrikiSample, type Vec3,
} from 'triki-kit'
import { saveRecording } from '../recording'
import { mountPositionScene, type View } from './scene'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const connectBtn = $<HTMLButtonElement>('connect')
const disconnectBtn = $<HTMLButtonElement>('disconnect')
const rezeroBtn = $<HTMLButtonElement>('rezero')
const rateSel = $<HTMLSelectElement>('rate')
const planarIn = $<HTMLInputElement>('planar')
const status = $('status')

// по умолчанию только плоскость стола: вертикаль у жетона самая ненадёжная (в покое акселерометр даёт 1.024 g)
try {
  planarIn.checked = localStorage.getItem('triki.planar') !== '0'
} catch { /* без хранилища - по умолчанию */ }
const logEl = $('log')

// beta в покое ниже, чем в основном демо: за первые миллисекунды движения ориентация меньше наклоняется под ускорение.
// Дальше beta на каждый кадр подсказывает трекер (почти 0 в движении, повышенная после вращения).
const TRIKI_OPTIONS = { rate: 104, beta: 0.03 } as const
const triki = createTriki(TRIKI_OPTIONS)
// сырой поток пишется всегда: кнопкой «Сохранить запись» его можно отдать в recordings/ для разбора
const rec = new Recorder(triki)
const view = mountPositionScene($('scene'), '/triki.glb')

for (const hz of SUPPORTED_RATES_HZ) rateSel.add(new Option(`${hz} Гц`, String(hz), hz === 104, hz === 104))

// --- оценка позиции ---
let segStartIdx = 0
let latest: TrikiSample | null = null
let frameStart = 0

// замеры скорости
let costSum = 0
let costN = 0
let lastArrival = 0
let burstStart = 0
let burstFrames = 0
let burstInterval = 0
let burstSize = 0
let ageEma = 0

// замер пачек и времени расчёта: этот слушатель подписан раньше трекера и срабатывает перед ним
triki.on('sample', (s) => {
  latest = s
  const now = performance.now()
  frameStart = now
  if (now - lastArrival > 3) {
    // новая пачка notification
    if (burstStart) {
      burstInterval = burstInterval * 0.9 + (now - burstStart) * 0.1
      burstSize = burstSize * 0.9 + burstFrames * 0.1
    }
    burstStart = now
    burstFrames = 0
  }
  burstFrames++
  lastArrival = now
})

let wasMoving = false
const pipeline = new PositionPipeline(triki, { planar: planarIn.checked }, (_s, seg) => {
  const tracker = pipeline.tracker
  costSum += performance.now() - frameStart
  costN++
  if (!wasMoving && tracker.moving) segStartIdx = Math.max(0, view.trail.length - 1)
  wasMoving = tracker.moving
  if (seg) {
    // живой хвост сегмента заменяем путём после поправки ZUPT
    view.trail.truncate(segStartIdx)
    for (const p of seg.path) view.trail.push(p)
    view.addStop(seg.to)
    onSegment(seg)
  } else if (tracker.moving) {
    view.trail.push(tracker.shown)
  }
})

// --- сегменты ---
const fmt = (v: number) => (Math.abs(v) < 0.05 ? '0.0' : v.toFixed(1))
const cm3 = (v: Vec3) => v.map((x) => fmt(x * 100)).join(', ') + ' см'
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function onSegment(seg: PositionSegment): void {
  renderSegment(seg)
  const d = sub(seg.to, seg.from)
  if (len(d) < 0.01) return // дрожь после остановки, в журнал не пишем
  if (logEl.firstElementChild?.classList.contains('muted')) logEl.innerHTML = ''
  const li = document.createElement('li')
  const time = document.createElement('time')
  time.textContent = `${(seg.t1 - seg.t0).toFixed(2)}с`
  const text = document.createElement('span')
  text.textContent = `Δ ${cm3(d)} · ${(len(d) * 100).toFixed(1)} см`
  li.append(time, text)
  const warn = !seg.valid ? 'ненадёжно' : seg.rotDeg > 40 ? 'крутили' : ''
  if (warn) {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = warn
    li.append(tag)
  }
  logEl.prepend(li)
  while (logEl.children.length > 60) logEl.lastElementChild?.remove()
}

function resetTracking(): void {
  rec.mark('reset', { planar: planarIn.checked })
  pipeline.reset({ planar: planarIn.checked })
  wasMoving = false
  segStartIdx = 0
  view.clear()
  renderSegment(null)
}

function renderSegment(seg: PositionSegment | null): void {
  $('segD').textContent = seg ? cm3(sub(seg.to, seg.from)) : '-'
  $('segT').textContent = seg ? `${(seg.t1 - seg.t0).toFixed(2)} с${seg.valid ? '' : ' (слишком долго, ненадёжно)'}` : '-'
}

$('clearLog').onclick = () => (logEl.innerHTML = '')

// --- состояние и управление ---
function renderState(): void {
  const st = triki.getState()
  const on = st.status === 'streaming'
  connectBtn.disabled = on || st.status === 'connecting'
  disconnectBtn.disabled = !on
  rezeroBtn.disabled = !on
  $('hz').textContent = st.measuredHz === null ? '-' : `${st.measuredHz} Гц`
  status.textContent = {
    idle: 'Не подключено',
    connecting: 'Подключение...',
    streaming: st.aligned
      ? 'Двигайте жетон короткими движениями с остановками: в момент остановки позиция уточняется (точки на сцене).'
      : 'Положите жетон ровно на стол светодиодом ОТ СЕБЯ на пару секунд: калибровка гироскопа и выравнивание осей.',
    disconnected: 'Отключено',
    error: `Ошибка: ${st.error ?? ''}`,
  }[st.status]
}
triki.subscribe(renderState)
renderState()

connectBtn.onclick = async () => {
  rec.clear()
  resetTracking()
  await triki.connect()
}
disconnectBtn.onclick = () => triki.disconnect()
rateSel.onchange = () => {
  // смена частоты меняет поток: прежняя запись к нему не подходит
  rec.clear()
  void triki.setRate(Number(rateSel.value) as RateHz).catch(() => undefined)
  resetTracking()
}
rezeroBtn.onclick = () => {
  rec.mark('rezero')
  triki.rezero()
}
$('zero').onclick = () => {
  rec.mark('zero')
  pipeline.tracker.zero()
  segStartIdx = 0
  view.clear()
}
planarIn.onchange = () => {
  try {
    localStorage.setItem('triki.planar', planarIn.checked ? '1' : '0')
  } catch { /* не критично */ }
  resetTracking()
}
const saveBtn = $<HTMLButtonElement>('save')
saveBtn.onclick = async () => {
  saveBtn.disabled = true
  const note = window.prompt('Что делали и что пошло не так? (необязательно)') ?? ''
  $('saved').textContent = 'сохраняю...'
  $('saved').textContent = await saveRecording(rec.toJSON({ kind: 'position', trikiOptions: TRIKI_OPTIONS, trackerOptions: { planar: planarIn.checked }, note }))
  saveBtn.disabled = false
}
$<HTMLSelectElement>('view').onchange = (e) => view.setView((e.target as HTMLSelectElement).value as View)
$<HTMLInputElement>('follow').onchange = (e) => view.setFollow((e.target as HTMLInputElement).checked)

// --- отрисовка ---
let lastStats = 0
function loop(now: number): void {
  const tracker = pipeline.tracker
  view.trail.commit()
  if (latest) view.setPose(tracker.shown, latest.quat)
  view.render()
  if (lastArrival) ageEma = ageEma * 0.95 + (now - lastArrival) * 0.05

  if (now - lastStats > 200) {
    lastStats = now
    $('pos').textContent = cm3(tracker.shown)
    $('state').textContent = tracker.moving ? `движение ${tracker.segmentS.toFixed(1)} с` : 'покой'
    $('state').classList.toggle('hot', tracker.moving && tracker.segmentS > 2)
    $('cost').textContent = costN ? `${((costSum / costN) * 1000).toFixed(1)} мкс/кадр` : '-'
    if (burstInterval) {
      $('burst').textContent = `каждые ${burstInterval.toFixed(0)} мс по ${burstSize.toFixed(1)} кадра`
      $('age').textContent = `${ageEma.toFixed(0)} мс`
    }
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

if (!isWebBluetoothSupported()) {
  $('unsupported').hidden = false
  connectBtn.disabled = true
}
