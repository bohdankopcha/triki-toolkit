import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// В разработке и сборке демо берёт пакет из исходников: dist пересобирать не нужно.
export default defineConfig({
  resolve: {
    alias: { 'triki-kit': fileURLToPath(new URL('../../packages/triki-kit/src/index.ts', import.meta.url)) },
  },
})
