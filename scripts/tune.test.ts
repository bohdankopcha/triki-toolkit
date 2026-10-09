/**
 * Сравнение вариантов настроек трекера на записях из recordings/. Запуск:
 *   VARIANTS='[["база",{}],["форма 1",{"zuptShape":1}]]' npx vitest run scripts/tune.test.ts
 * Таблица пишется в recordings/tune.md. Без VARIANTS тест пропускается.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { replayExperiment } from './recordings.test.js'
import type { PositionOptions, TrikiRecording } from '../packages/triki-kit/src/index.js'

const DIR = new URL('../recordings/', import.meta.url)
const VARIANTS = process.env.VARIANTS

describe.skipIf(!VARIANTS || !existsSync(DIR))('подбор настроек', () => {
  it('варианты', () => {
    const names = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
    const recs = names.map((n) => JSON.parse(readFileSync(new URL(n, DIR), 'utf8')) as TrikiRecording)
      .filter((r) => (r.meta as { kind?: string } | undefined)?.kind === 'experiment-2d')
    const variants = JSON.parse(VARIANTS!) as [string, PositionOptions][]
    const L = ['| вариант | ' + names.map((n) => `${n}: шагов, разброс°, пара см, конец см`).join(' | ') + ' | среднее |', '|---'.repeat(names.length + 2) + '|']
    for (const [name, opts] of variants) {
      const cells: string[] = []
      let sc = 0, cl = 0, fi = 0
      for (const rec of recs) {
        const { results, score } = replayExperiment(rec, { ...((rec.meta as { trackerOptions?: PositionOptions }).trackerOptions ?? {}), ...opts })
        cells.push(`${results.length}, ±${score.scatterAngleDeg.toFixed(1)}, ${score.meanClosureCm.toFixed(1)}, ${score.finalCm.toFixed(1)}`)
        sc += score.scatterAngleDeg / recs.length
        cl += score.meanClosureCm / recs.length
        fi += score.finalCm / recs.length
      }
      L.push(`| ${name} | ${cells.join(' | ')} | ±${sc.toFixed(1)}°, ${cl.toFixed(2)} см, ${fi.toFixed(1)} см |`)
    }
    writeFileSync(new URL('tune.md', DIR), L.join('\n'))
  })
})
