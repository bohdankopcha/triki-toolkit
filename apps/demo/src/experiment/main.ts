import '../style.css'
import {
  DIR2D_LABEL, DIR2D_VEC, Experiment2D, PositionPipeline, Recorder, createTriki, isWebBluetoothSupported, rotate,
  scoreExperiment, type Dir2D, type StepResult,
} from 'triki-kit'
import { saveRecording } from '../recording'
import { PlaneView } from './plane'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const connectBtn = $<HTMLButtonElement>('connect')
const disconnectBtn = $<HTMLButtonElement>('disconnect')
const rezeroBtn = $<HTMLButtonElement>('rezero')
const startBtn = $<HTMLButtonElement>('start')
const undoBtn = $<HTMLButtonElement>('undo')
const skipBtn = $<HTMLButtonElement>('skip')
const downloadBtn = $<HTMLButtonElement>('download')
const status = $('status')

// Те же опции, что в повторе записи (scripts/recordings.test.ts): иначе результаты не совпадут
const TRIKI_OPTIONS = { rate: 104, beta: 0.03 } as const
const TRACKER_OPTIONS = { planar: true }

const triki = createTriki(TRIKI_OPTIONS)
const rec = new Recorder(triki)
const view = new PlaneView($<HTMLCanvasElement>('plane'))
let exp: Experiment2D | null = null
let segStartIdx = 0
let saved = false

const pipeline = new PositionPipeline(triki, TRACKER_OPTIONS, (_s, seg) => {
  const tr = pipeline.tracker
  if (seg) {
    view.replaceTail(segStartIdx < 0 ? view.path.length : segStartIdx, seg.path)
    view.stops.push([seg.to[0], seg.to[1]])
    const r = exp?.onSegment(seg)
    if (r) onStep(r)
  } else if (tr.moving) {
    if (segStartIdx < 0) segStartIdx = Math.max(0, view.path.length - 1)
    view.path.push([tr.shown[0], tr.shown[1]])
  }
  if (!tr.moving) segStartIdx = -1
})

// --- шаги ---
const ARROW: Record<Dir2D, string> = {
  up: '↑', down: '↓', left: '←', right: '→', upright: '↗', upleft: '↖', downright: '↘', downleft: '↙',
}

function renderPrompt(): void {
  const dir = exp?.expected ?? null
  view.next = dir ? DIR2D_VEC[dir] : null
  if (!exp) return
  if (exp.done) {
    $('arrow').textContent = '✓'
    $('stepNo').textContent = 'Готово'
    $('stepText').textContent = 'Эксперимент закончен. Запись сохраняется, итог справа.'
    return
  }
  $('arrow').textContent = ARROW[dir!]
  $('stepNo').textContent = `Шаг ${exp.index + 1} из ${exp.sequence.length}`
  $('stepText').textContent = `${DIR2D_LABEL[dir!]}, затем остановка`
}

function onStep(_r: StepResult): void {
  $('prompt').classList.remove('flash')
  void $('prompt').offsetWidth
  $('prompt').classList.add('flash')
  renderAll()
  if (exp?.done) void save()
}

function renderAll(): void {
  renderPrompt()
  renderButtons()
  const results = exp?.results ?? []
  const sc = scoreExperiment(results)
  const tbody = $('steps')
  tbody.innerHTML = ''
  const pairByFirst = new Map(sc.pairs.map((p) => [p.first, p]))
  for (const r of results) {
    const st = sc.steps.find((x) => x.index === r.index)
    const pair = pairByFirst.get(r.index - 1)
    const tr = document.createElement('tr')
    const cells = [
      String(r.index + 1),
      `${ARROW[r.dir]} ${DIR2D_LABEL[r.dir]}`,
      r.skipped ? 'пропущен' : `${st!.lengthCm.toFixed(1)} см`,
      r.skipped ? '' : `${st!.angleErrDeg > 0 ? '+' : ''}${st!.angleErrDeg.toFixed(0)}°`,
      pair ? `${pair.closureCm.toFixed(1)} см` : '',
    ]
    for (const c of cells) {
      const td = document.createElement('td')
      td.textContent = c
      tr.append(td)
    }
    tbody.prepend(tr)
  }
  if (!results.length) {
    $('sAngle').textContent = $('sClosure').textContent = $('sFinal').textContent = '-'
    return
  }
  $('sAngle').textContent = `общий поворот ${sc.meanAngleDeg.toFixed(0)}°, разброс ±${sc.scatterAngleDeg.toFixed(0)}°, макс ${sc.maxAbsAngleDeg.toFixed(0)}°`
  $('sClosure').textContent = sc.pairs.length ? `${sc.meanClosureCm.toFixed(1)} см (${sc.meanClosurePct.toFixed(0)}% длины)` : '-'
  $('sFinal').textContent = `${sc.finalCm.toFixed(1)} см за путь ${sc.pathCm.toFixed(0)} см`
}

function renderButtons(): void {
  const st = triki.getState()
  const on = st.status === 'streaming'
  connectBtn.disabled = on || st.status === 'connecting'
  disconnectBtn.disabled = !on
  rezeroBtn.disabled = !on
  startBtn.disabled = !on || !st.aligned
  startBtn.textContent = exp ? 'Начать заново' : 'Начать'
  const running = !!exp && !exp.done
  undoBtn.disabled = !running || !exp?.results.length
  skipBtn.disabled = !running
  downloadBtn.disabled = !rec.t.length
}

// --- действия: каждое пишется меткой в запись, чтобы повтор сделал то же самое в том же месте потока ---
function act(type: 'start' | 'undo' | 'skip' | 'rezero'): void {
  rec.mark(type)
  if (type === 'start') {
    exp = new Experiment2D()
    pipeline.tracker.zero()
    view.clear()
    segStartIdx = -1
    saved = false
    $('sSaved').textContent = '-'
  } else if (type === 'undo') exp?.undo()
  else if (type === 'skip') exp?.skip()
  else triki.rezero()
  renderAll()
}

startBtn.onclick = () => act('start')
undoBtn.onclick = () => act('undo')
skipBtn.onclick = () => act('skip')
rezeroBtn.onclick = () => act('rezero')
document.addEventListener('keydown', (e) => {
  if (!exp || exp.done || e.target instanceof HTMLInputElement) return
  if (e.key === 'Backspace' && exp.results.length) act('undo')
  else if (e.key === ' ') {
    e.preventDefault()
    act('skip')
  }
})

connectBtn.onclick = async () => {
  rec.clear()
  pipeline.reset()
  exp = null
  view.clear()
  segStartIdx = -1
  renderAll()
  await triki.connect()
}
disconnectBtn.onclick = () => triki.disconnect()

// --- сохранение ---
function recordingJSON() {
  const results = exp?.results ?? []
  return rec.toJSON({ kind: 'experiment-2d', trikiOptions: TRIKI_OPTIONS, trackerOptions: TRACKER_OPTIONS, results, score: scoreExperiment(results) })
}

async function save(): Promise<void> {
  if (saved) return
  saved = true
  $('sSaved').textContent = 'сохраняю...'
  $('sSaved').textContent = await saveRecording(recordingJSON())
}

// в любой момент, даже если эксперимент не закончен: например, чтобы показать, что пошло не так
downloadBtn.onclick = async () => {
  const note = window.prompt('Что делали и что пошло не так? (необязательно)') ?? ''
  $('sSaved').textContent = 'сохраняю...'
  $('sSaved').textContent = await saveRecording({ ...recordingJSON(), meta: { ...recordingJSON().meta, note } })
}

// --- состояние и отрисовка ---
function renderStatus(): void {
  const st = triki.getState()
  renderButtons()
  if (exp) return
  status.textContent = {
    idle: 'Не подключено',
    connecting: 'Подключение...',
    streaming: st.aligned
      ? 'Готово. Нажмите «Начать» и делайте движения по подсказке.'
      : 'Положите жетон ровно на стол светодиодом ОТ СЕБЯ и не трогайте пару секунд: калибровка.',
    disconnected: 'Отключено',
    error: `Ошибка: ${st.error ?? ''}`,
  }[st.status]
  if (!st.aligned) $('stepText').textContent = status.textContent ?? ''
}
triki.subscribe(renderStatus)
renderStatus()
renderAll()

function loop(): void {
  const tr = pipeline.tracker
  view.pos = [tr.shown[0], tr.shown[1]]
  if (triki.sample) {
    const led = rotate(triki.orientation, [0, -1, 0])
    view.heading = Math.atan2(led[1], led[0])
  }
  view.draw()
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

if (!isWebBluetoothSupported()) {
  $('unsupported').hidden = false
  connectBtn.disabled = true
}
