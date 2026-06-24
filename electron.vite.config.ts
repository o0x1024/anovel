import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['better-sqlite3', 'node-llama-cpp'],
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
          'perplexity-worker': path.resolve(__dirname, 'src/main/perplexity/perplexity-worker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload'
    }
  },
  renderer: {
    build: {
      outDir: 'out/renderer'
    },
    plugins: [vue()],
    resolve: {
      alias: {
        '@': './src'
      }
    }
  }
})
