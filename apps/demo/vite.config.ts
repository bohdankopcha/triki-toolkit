import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const RECORDINGS_DIR = page('../../recordings')

/**
 * Только в dev: POST /__recordings сохраняет запись эксперимента в recordings/ в корне репозитория,
 * чтобы её можно было повторить в тестах (scripts/recordings.test.ts). Имя файла задаёт сервер.
 */
function recordingsPlugin(): Plugin {
  return {
    name: 'triki-recordings',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__recordings', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > 50 * 1024 * 1024) req.destroy()
          else chunks.push(c)
        })
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (body?.format !== 'triki-recording') throw new Error('не запись triki')
            const kind = String(body.meta?.kind ?? 'session').replace(/[^a-z0-9-]/gi, '')
            const file = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
            mkdirSync(RECORDINGS_DIR, { recursive: true })
            writeFileSync(`${RECORDINGS_DIR}/${file}`, JSON.stringify(body))
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ file: `recordings/${file}` }))
          } catch (e) {
            res.statusCode = 400
            res.end(String(e))
          }
        })
      })
    },
  }
}

// В разработке и сборке демо берёт пакет из исходников: dist пересобирать не нужно.
export default defineConfig({
  plugins: [recordingsPlugin()],
  resolve: {
    alias: { 'triki-kit': page('../../packages/triki-kit/src/index.ts') },
  },
  build: {
    rollupOptions: { input: { main: page('index.html'), position: page('position.html'), experiment: page('experiment.html') } },
  },
})
