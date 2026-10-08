import { groupCombos, VOCAB, type Gesture } from '../core/gestures'
import { iconSvg } from './icons'

const CAT: Record<string, string> = {
  roll: 'var(--z)', spin: 'var(--spin)', twist: 'var(--spin)', flip: 'var(--x)',
  slide: 'var(--y)', circle: 'var(--y)', push: 'var(--y)', lift: 'var(--lift)', edge: 'var(--muted)', flat: 'var(--muted)', tilt: 'var(--muted)',
}

function token(kind: Gesture['kind'], dir: Gesture['dir'], caption: string, title: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tok'
  el.style.setProperty('--cat', CAT[kind])
  el.title = title
  el.innerHTML = iconSvg(kind, dir)
  const cap = document.createElement('span')
  cap.className = 'val'
  cap.textContent = caption
  el.append(cap)
  return el
}

const caption = (g: Gesture) =>
  g.value === undefined ? '' : g.kind === 'circle' ? `×${g.value}` : `${g.value}${g.kind === 'roll' || g.kind === 'spin' || g.kind === 'twist' ? '°' : ''}`

/** Новые комбо сверху; в каждом ряду жесты слева направо в порядке выполнения. */
export function renderCombos(el: HTMLElement, list: readonly Gesture[], maxRows = 6): void {
  const rows = groupCombos(list).slice(-maxRows).reverse()
  el.replaceChildren()
  if (!rows.length) {
    const p = document.createElement('p')
    p.className = 'muted-text'
    p.textContent = 'Выполните жест: прокрут, переворот, смещение, подъём...'
    el.append(p)
    return
  }
  rows.forEach((row, ri) => {
    const r = document.createElement('div')
    r.className = 'combo-row'
    const time = document.createElement('time')
    time.textContent = `${row[0].t.toFixed(1)}с`
    r.append(time)
    row.forEach((g, gi) => {
      const tok = token(g.kind, g.dir, caption(g), `${g.label}\n${g.id}`)
      if (ri === 0 && gi === row.length - 1) tok.classList.add('latest')
      r.append(tok)
    })
    el.append(r)
  })
}

/** Каталог: что можно ловить. */
export function renderVocab(el: HTMLElement): void {
  el.replaceChildren()
  for (const v of VOCAB) {
    const row = document.createElement('div')
    row.className = 'vocab-row'
    const icons = document.createElement('div')
    icons.className = 'vocab-icons'
    for (const d of v.dirs.length ? v.dirs : [undefined]) icons.append(token(v.kind, d, '', `${v.kind}${d ? '.' + d : ''}`))
    const txt = document.createElement('div')
    const title = document.createElement('b')
    title.textContent = v.title
    const vals = document.createElement('div')
    vals.className = 'muted-text'
    vals.textContent = v.values ? `значения: ${v.values.join(' / ')}${v.unit ?? ''}` : 'без значения'
    txt.append(title, vals)
    row.append(icons, txt)
    el.append(row)
  }
}
