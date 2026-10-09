/**
 * Повтор записей из recordings/ (страница apps/demo/experiment.html сохраняет их туда в dev).
 * Обработка та же, что на странице: PositionPipeline + Experiment2D + действия пользователя по меткам.
 * Отчёт: recordings/report.md. Запуск: npm run analyze
 *
 * Это и регрессионный тест: на каждой записи 2D-эксперимента должны найтись все шаги, а ошибки - не выйти за пороги.
 * Если алгоритм поменялся с момента записи, результат отличается от того, что видел пользователь: это нормально,
 * расхождение пишется в отчёт для сравнения.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  Experiment2D, PositionPipeline, replayRecording, scoreExperiment,
  type ExperimentScore, type PositionOptions, type StepResult, type TrikiRecording,
} from '../packages/triki-kit/src/index.js'

const DIR = new URL('../recordings/', import.meta.url)
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : []

/** Пороги качества на живых записях (с запасом от достигнутого: разброс ±3-5°, невозврат ~2 см, конец 2-5 см). */
const LIMITS = { scatterDeg: 7, closureCm: 3, finalCm: 7 }

export function replayExperiment(rec: TrikiRecording, trackerOptions?: PositionOptions) {
  const meta = (rec.meta ?? {}) as { trikiOptions?: object; trackerOptions?: PositionOptions }
  let pipeline!: PositionPipeline
  let exp: Experiment2D | null = null
  replayRecording(rec, {
    setup: (triki) => {
      pipeline = new PositionPipeline(triki, trackerOptions ?? meta.trackerOptions ?? {}, (_s, seg) => {
        if (seg) exp?.onSegment(seg)
      })
    },
    chunk: (_i, marks) => {
      for (const m of marks) {
        if (m.type === 'start') {
          exp = new Experiment2D()
          pipeline.tracker.zero()
        } else if (m.type === 'undo') exp?.undo()
        else if (m.type === 'skip') exp?.skip()
      }
    },
  }, { stateThrottleMs: 0, ...(meta.trikiOptions ?? {}) })
  const results: StepResult[] = exp ? (exp as Experiment2D).results : []
  return { results, score: scoreExperiment(results) }
}

export function summary(sc: ExperimentScore): string {
  return `направление: поворот ${sc.meanAngleDeg.toFixed(1)}°, разброс ±${sc.scatterAngleDeg.toFixed(1)}°, макс ${sc.maxAbsAngleDeg.toFixed(0)}°; ` +
    `невозврат пары ${sc.meanClosureCm.toFixed(1)} см (${sc.meanClosurePct.toFixed(0)}%); конец ${sc.finalCm.toFixed(1)} см за ${sc.pathCm.toFixed(0)} см; пропущено ${sc.skipped}`
}

describe.skipIf(!files.length)('записи 2D-эксперимента', () => {
  const report: string[] = ['# Повтор записей', '', `Пороги: разброс < ${LIMITS.scatterDeg}°, невозврат пары < ${LIMITS.closureCm} см, конец < ${LIMITS.finalCm} см.`, '']
  for (const f of files) {
    it(f, () => {
      const rec = JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as TrikiRecording
      const meta = rec.meta as { kind?: string; results?: StepResult[]; score?: ExperimentScore } | undefined
      if (meta?.kind !== 'experiment-2d') return
      const { results, score } = replayExperiment(rec)
      report.push(`## ${f}`, '', `${rec.data.length} кусков, ${((rec.t[rec.t.length - 1] - rec.t[0]) / 1000).toFixed(0)} с`, '')
      report.push(`Сейчас: ${summary(score)}`, '')
      if (meta.score) report.push(`В момент записи: ${summary(meta.score)}`, '')
      report.push('| # | куда | длина, см | угол, ° | пара, см |', '|---|---|---|---|---|')
      const pairs = new Map(score.pairs.map((p) => [p.first + 1, p]))
      for (const r of results) {
        const st = score.steps.find((s) => s.index === r.index)
        report.push(`| ${r.index + 1} | ${r.dir} | ${st ? st.lengthCm.toFixed(1) : 'пропущен'} | ${st ? st.angleErrDeg.toFixed(0) : ''} | ${pairs.get(r.index)?.closureCm.toFixed(1) ?? ''} |`)
      }
      report.push('')
      writeFileSync(new URL('report.md', DIR), report.join('\n'))

      const live = meta.results ?? []
      expect(results.length, 'все шаги найдены').toBe(live.length)
      expect(score.skipped).toBe(live.filter((r) => r.skipped).length)
      expect(score.scatterAngleDeg, 'разброс направлений').toBeLessThan(LIMITS.scatterDeg)
      expect(score.meanClosureCm, 'невозврат после пары').toBeLessThan(LIMITS.closureCm)
      expect(score.finalCm, 'конец от начала').toBeLessThan(LIMITS.finalCm)
    })
  }
})
