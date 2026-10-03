import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ],
  resolve: {
    alias: {
      // mpg123-decoder's package.json "exports" only exposes ./index.js.
      // That root file imports MPEGDecoderWebWorker which calls `new Worker()`
      // at class-definition time — crashing in Cloudflare Workers.
      // We alias the deep src path so Vite can resolve it despite the exports
      // restriction, giving us only the pure WASM decoder with no WebWorker dep.
      'mpg123-decoder/src/MPEGDecoder.js': resolve(
        __dirname,
        'node_modules/mpg123-decoder/src/MPEGDecoder.js'
      )
    }
  }
})
