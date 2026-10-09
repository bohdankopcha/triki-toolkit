import type { TrikiRecording } from 'triki-kit'

/**
 * Сохранить запись в recordings/ через dev-сервер (плагин в vite.config.ts). Если сервер недоступен (сборка, не dev),
 * файл скачивается. Возвращает текст для пользователя.
 */
export async function saveRecording(json: TrikiRecording): Promise<string> {
  try {
    const res = await fetch('/__recordings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })
    if (!res.ok) throw new Error(String(res.status))
    const { file } = (await res.json()) as { file: string }
    return `сохранено: ${file}`
  } catch {
    downloadRecording(json)
    return 'dev-сервер недоступен: файл скачан, положите его в recordings/'
  }
}

export function downloadRecording(json: TrikiRecording): void {
  const kind = String(json.meta?.kind ?? 'session')
  const blob = new Blob([JSON.stringify(json)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
