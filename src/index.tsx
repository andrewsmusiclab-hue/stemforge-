import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  OPENAI_API_KEY: string
  MUSICAPI_KEY: string
  MUREKA_API_KEY: string     // Mureka API key for stem separation (/v1/song/stem)
  ELEVENLABS_API_KEY: string  // ElevenLabs SFX API for One Shot Creator
  DB: D1Database             // Cloudflare D1 for persistent job storage
  IMAGES: R2Bucket           // Cloudflare R2 for permanent cover art storage
  // Auth + Payments (set via gsk hosted deploy or wrangler secret put)
  GOOGLE_CLIENT_ID: string          // Google OAuth App client ID
  GOOGLE_CLIENT_SECRET: string      // Google OAuth App client secret
  STRIPE_SECRET_KEY: string         // Stripe secret key (sk_live_... or sk_test_...)
  STRIPE_WEBHOOK_SECRET: string     // Stripe webhook signing secret
  STRIPE_CREATOR_PRICE_ID: string          // Stripe Price ID for Creator (current)
  STRIPE_PRO_PRICE_ID: string              // Stripe Price ID for Pro Artist (current)
  STRIPE_CREATOR_PRICE_ID_LEGACY?: string  // Old Creator price — keeps existing subs recognised
  STRIPE_PRO_PRICE_ID_LEGACY?: string      // Old Pro price — keeps existing subs recognised
  SESSION_SECRET: string            // 32+ char random string for session HMAC
  SITE_URL: string                  // e.g. https://473bb3a0-5a11-4e55-b6ea-c81157be4dc1.vip.gensparksite.com
  ADMIN_EMAIL: string               // Developer admin email — grants developer plan access
  STAGING_URL?: string              // Set by wrangler.staging.jsonc — shown in admin Publish tab
  CRON_SECRET?: string              // Secret token for /api/cron/free-reset endpoint
  CLOUDCONVERT_KEY?: string         // CloudConvert API key for MP3→WAV conversion (large files)
}

const app = new Hono<{ Bindings: Bindings }>()

// ── Global error handler — ensures ALL unhandled errors return JSON ──────────
// Without this, Cloudflare returns plain-text "Internal Server Error" which
// makes the frontend crash with "Unexpected token 'I' is not valid JSON".
app.onError((err, c) => {
  console.error('[StemForge Error]', err?.message || err)
  return c.json({ error: err?.message || 'Internal server error' }, 500)
})

// ── Middleware ─────────────────────────────────────────────────
app.use('/api/*', cors())

// ── Static assets ──────────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './' }))

// ═══════════════════════════════════════════════════════════════
//  PIPELINE CONSTANTS
// ═══════════════════════════════════════════════════════════════

const MUSICAPI_BASE = 'https://api.musicapi.ai/api/v1'
const MUSICAPI_SONIC  = `${MUSICAPI_BASE}/sonic`
const MUSICAPI_PRODUCER = `${MUSICAPI_BASE}/producer`
const OPENAI_BASE = 'https://api.openai.com/v1'
const MUREKA_BASE = 'https://api.mureka.ai/v1'
// ── D1-backed job store ───────────────────────────────────────
// Survives across Cloudflare Worker instances (no more "Job not found")
// Falls back to in-memory Map if DB is not bound (local dev without D1)
const memJobs = new Map<string, Job>()  // fallback for local dev

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
  ).run()
  // Migration-safe: add columns if they don't exist yet
  const migrations = [
    `ALTER TABLE jobs ADD COLUMN user_id TEXT`,
    `ALTER TABLE jobs ADD COLUMN deleted_at INTEGER`,
    `ALTER TABLE jobs ADD COLUMN is_oneshot INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN is_cover INTEGER NOT NULL DEFAULT 0`,
  ]
  for (const sql of migrations) {
    try { await db.prepare(sql).run() } catch { /* column already exists — ignore */ }
  }
}

async function getJob(db: D1Database | undefined, id: string): Promise<Job | null> {
  if (db) {
    try {
      const row = await db.prepare('SELECT data FROM jobs WHERE id = ?').bind(id).first<{ data: string }>()
      return row ? JSON.parse(row.data) as Job : null
    } catch {
      return null
    }
  }
  return memJobs.get(id) ?? null
}

async function setJob(db: D1Database | undefined, job: Job, userId?: string): Promise<void> {
  if (db) {
    await ensureTable(db)
    await db.prepare(
      `INSERT INTO jobs (id, data, created_at, user_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, user_id = COALESCE(excluded.user_id, jobs.user_id)`
    ).bind(job.id, JSON.stringify(job), job.created_at, userId || null).run()
  } else {
    memJobs.set(job.id, job)
  }
}

// ═══════════════════════════════════════════════════════════════
//  MP3 → TRUE PCM WAV CONVERSION
//  Uses mpg123-decoder (WASM-based, no Node.js APIs, runs in CF Workers).
//  Converts MP3 ArrayBuffer → 16-bit PCM WAV ArrayBuffer in-process.
//  M4A/AAC is decoded using @audio/decode-aac (FAAD2 WASM, 364KB) and then
//  re-encoded to MP3 via lamejs. Full M4A→MP3 and M4A→WAV pipelines supported.
// ═══════════════════════════════════════════════════════════════
// Import only the non-WebWorker MPEGDecoder — the main index.js also imports
// MPEGDecoderWebWorker which calls `new Worker()` at class definition time,
// crashing in Cloudflare Workers (no Web Worker API). Direct src import avoids this.
import MPEGDecoder from 'mpg123-decoder/src/MPEGDecoder.js'
import lamejs from '@breezystack/lamejs'
import decodeAac from '@audio/decode-aac'

/**
 * Convert an MP3 ArrayBuffer to a true 16-bit PCM WAV ArrayBuffer.
 * Throws if decoding fails — caller should catch and fall back to serving MP3.
 */
// ── MusicAPI WAV URL fetcher ─────────────────────────────────────────────────
// Uses POST /api/v1/sonic/download to get a stable CDN WAV URL.
// Suno converts the track server-side — no WASM decode needed in our Worker.
//
// MusicAPI /sonic/download response codes (official docs):
//   200  → ready; data.files[] has {format:'wav', url:'...'}
//   202  → WAV still being prepared by Suno (caller should retry in ~3s)
//   404  → clip too old / never existed — permanently unavailable
//   403  → insufficient MusicAPI credits (server-side API key issue, not user charge)
//
// IMPORTANT: This is a SINGLE-SHOT call. Do NOT sleep/poll inside a CF Worker —
// sleeping burns wall-clock time and makes the browser think the download stalled.
// Instead return '202' so the frontend retries the whole download after a short delay.
//
// Returns:
//   string      → stable CDN WAV URL, ready to proxy to the browser
//   '202'       → WAV still preparing — caller should tell browser to retry in 3 s
//   'NOT_FOUND' → 404/403 — clip expired or API key issue; return a clean error to user
//   null        → network/timeout error; caller may try fallback paths
async function getMusicApiWavUrl(clipId: string, apiKey: string): Promise<string | null | '202' | 'NOT_FOUND'> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 9000)  // 9 s hard timeout per CF wall-clock budget
  try {
    const res = await fetch(`${MUSICAPI_BASE}/sonic/download`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip_id: clipId, formats: ['wav'] })
    })
    clearTimeout(t)

    if (res.status === 202) {
      console.log(`[getMusicApiWavUrl] clip=${clipId} → 202 (Suno still preparing WAV)`)
      return '202'  // tell caller to retry after delay
    }
    if (res.status === 404 || res.status === 403) {
      console.log(`[getMusicApiWavUrl] clip=${clipId} → ${res.status} (permanently unavailable)`)
      return 'NOT_FOUND'
    }
    if (!res.ok) {
      console.log(`[getMusicApiWavUrl] clip=${clipId} → HTTP ${res.status} (error)`)
      return null
    }
    // 200 — parse
    const data: any = await res.json()
    const files: any[] = data?.data?.files || []
    const wavFile = files.find((f: any) => f.format === 'wav')
    if (wavFile?.url) {
      console.log(`[getMusicApiWavUrl] clip=${clipId} → WAV URL ready`)
      return wavFile.url as string
    }
    if (data?.data?.wav_url) return data.data.wav_url as string
    return null
  } catch (e: any) {
    clearTimeout(t)
    console.log(`[getMusicApiWavUrl] clip=${clipId} → fetch error: ${e?.message}`)
    return null
  }
}

async function mp3ToWav(mp3Buf: ArrayBuffer): Promise<ArrayBuffer> {
  const decoder = new (MPEGDecoder as any)({})
  await decoder.ready

  const { channelData, samplesDecoded, sampleRate } = await decoder.decode(new Uint8Array(mp3Buf))
  decoder.free()

  if (!samplesDecoded || samplesDecoded < 100) throw new Error('MP3 decode produced no samples')

  const numChannels  = channelData.length   // 1 or 2
  const bitsPerSample = 16
  const dataSize     = samplesDecoded * numChannels * 2   // 2 bytes per 16-bit sample
  const byteRate     = sampleRate * numChannels * 2

  const wavBuf = new ArrayBuffer(44 + dataSize)
  const view   = new DataView(wavBuf)
  const str    = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

  // RIFF header
  str(0,  'RIFF');  view.setUint32(4,  36 + dataSize, true)
  str(8,  'WAVE')
  // fmt chunk — PCM format (1), 16-bit
  str(12, 'fmt ');  view.setUint32(16, 16, true)
  view.setUint16(20, 1,            true)   // PCM
  view.setUint16(22, numChannels,  true)
  view.setUint32(24, sampleRate,   true)
  view.setUint32(28, byteRate,     true)
  view.setUint16(32, numChannels * 2, true)  // block align
  view.setUint16(34, bitsPerSample,   true)
  // data chunk
  str(36, 'data'); view.setUint32(40, dataSize, true)

  // Interleave float32 channel samples → int16 PCM
  let off = 44
  for (let i = 0; i < samplesDecoded; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channelData[ch][i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
      off += 2
    }
  }

  return wavBuf
}

/**
 * Convert a PCM WAV ArrayBuffer to an MP3 ArrayBuffer using lamejs.
 * Reads the WAV header to extract sample rate, bit depth, and channels,
 * then encodes with LAME at 192kbps. Throws on failure.
 */
function wavToMp3(wavBuf: ArrayBuffer): ArrayBuffer {
  const view = new DataView(wavBuf)
  // WAV fmt chunk starts at offset 12 (RIFF + chunk size + WAVE = 12 bytes)
  // fmt  sub-chunk id at 12, size at 16, audioFormat at 20, channels at 22,
  //      sampleRate at 24, byteRate at 28, blockAlign at 32, bitsPerSample at 34
  // data sub-chunk starts after fmt (20 bytes fmt body) at offset 36, data at 44
  const numChannels  = view.getUint16(22, true)
  const sampleRate   = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)

  if (numChannels < 1 || numChannels > 2) throw new Error(`Unsupported channel count: ${numChannels}`)
  if (bitsPerSample !== 16) throw new Error(`Unsupported bit depth: ${bitsPerSample} (need 16-bit PCM)`)

  // PCM samples start at byte 44 (standard WAV header)
  const pcmBytes   = new Int16Array(wavBuf, 44)
  const totalSamples = Math.floor(pcmBytes.length / numChannels)

  const mp3enc = new lamejs.Mp3Encoder(numChannels, sampleRate, 192)
  const blockSize = 1152  // LAME processes 1152 samples at a time

  const chunks: Uint8Array[] = []

  if (numChannels === 1) {
    for (let i = 0; i < totalSamples; i += blockSize) {
      const end   = Math.min(i + blockSize, totalSamples)
      const chunk = pcmBytes.subarray(i, end)
      const enc   = mp3enc.encodeBuffer(chunk)
      if (enc.length > 0) chunks.push(enc)
    }
  } else {
    // Deinterleave stereo L/R
    const leftSamples  = new Int16Array(totalSamples)
    const rightSamples = new Int16Array(totalSamples)
    for (let i = 0; i < totalSamples; i++) {
      leftSamples[i]  = pcmBytes[i * 2]
      rightSamples[i] = pcmBytes[i * 2 + 1]
    }
    for (let i = 0; i < totalSamples; i += blockSize) {
      const end  = Math.min(i + blockSize, totalSamples)
      const enc  = mp3enc.encodeBuffer(leftSamples.subarray(i, end), rightSamples.subarray(i, end))
      if (enc.length > 0) chunks.push(enc)
    }
  }

  // Flush remaining frames
  const flush = mp3enc.flush()
  if (flush.length > 0) chunks.push(flush)

  // Concatenate all chunks into one ArrayBuffer
  const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0)
  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output.buffer
}

/**
 * Convert M4A/AAC bytes → true 16-bit PCM WAV ArrayBuffer.
 * Uses @audio/decode-aac (FAAD2 WASM, 364KB) to decode AAC samples,
 * then writes a standard PCM WAV header around the int16 data.
 * Throws on failure — caller should catch and fall back.
 */
async function m4aToWav(m4aBuf: ArrayBuffer): Promise<ArrayBuffer> {
  const input = new Uint8Array(m4aBuf)
  const { channelData, sampleRate } = await (decodeAac as any)(input) as {
    channelData: Float32Array[]
    sampleRate: number
  }

  const numChannels   = channelData.length
  const samplesDecoded = channelData[0].length
  if (!samplesDecoded || samplesDecoded < 100) throw new Error('M4A decode produced no samples')

  const bitsPerSample = 16
  const dataSize      = samplesDecoded * numChannels * 2
  const byteRate      = sampleRate * numChannels * 2

  const wavBuf = new ArrayBuffer(44 + dataSize)
  const view   = new DataView(wavBuf)
  const str    = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

  str(0,  'RIFF'); view.setUint32(4,  36 + dataSize, true)
  str(8,  'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1,            true)  // PCM
  view.setUint16(22, numChannels,  true)
  view.setUint32(24, sampleRate,   true)
  view.setUint32(28, byteRate,     true)
  view.setUint16(32, numChannels * 2, true)
  view.setUint16(34, bitsPerSample,   true)
  str(36, 'data'); view.setUint32(40, dataSize, true)

  let off = 44
  for (let i = 0; i < samplesDecoded; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channelData[ch][i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
      off += 2
    }
  }
  return wavBuf
}

/**
 * Convert M4A bytes → true MP3.
 * Pipeline: M4A → FAAD2 WASM decode → PCM WAV → lamejs MP3 encode.
 * Throws on failure — caller should catch and serve M4A as fallback.
 */
async function m4aToMp3(m4aBuf: ArrayBuffer): Promise<ArrayBuffer> {
  const wavBuf = await m4aToWav(m4aBuf)
  return wavToMp3(wavBuf)
}

/**
 * Convert any audio source to MP3.
 * - MP3 → return as-is
 * - WAV → lamejs encode
 * - M4A → FAAD2 decode → lamejs encode (full pipeline)
 * Returns { buf, fmt } — fmt is what was actually produced (mp3 on success, or original fmt on failure).
 */
async function toMp3(srcBuf: ArrayBuffer, srcFmt: 'wav' | 'mp3' | 'm4a'): Promise<{ buf: ArrayBuffer; fmt: 'wav' | 'mp3' | 'm4a' }> {
  if (srcFmt === 'mp3') return { buf: srcBuf, fmt: 'mp3' }
  if (srcFmt === 'wav') {
    try {
      return { buf: wavToMp3(srcBuf), fmt: 'mp3' }
    } catch (e: any) {
      console.warn('[toMp3] WAV→MP3 failed:', e?.message)
      return { buf: srcBuf, fmt: 'wav' }
    }
  }
  // M4A → full pipeline: AAC decode (FAAD2) → PCM WAV → lamejs MP3
  try {
    const mp3Buf = await m4aToMp3(srcBuf)
    console.log(`[toMp3] M4A→MP3 done: ${Math.round(mp3Buf.byteLength/1024)}KB`)
    return { buf: mp3Buf, fmt: 'mp3' }
  } catch (e: any) {
    console.warn('[toMp3] M4A→MP3 failed, serving M4A:', e?.message)
    return { buf: srcBuf, fmt: 'm4a' }
  }
}

// ═══════════════════════════════════════════════════════════════
//  R2 AUDIO PERSISTENCE — saves beat audio permanently so CDN
//  expiry never breaks playback. Key pattern: beats/{jobId}.wav
//  Falls back silently if R2 is unavailable.
// ═══════════════════════════════════════════════════════════════

const R2_BEATS_PREFIX = 'beats'

// ═══════════════════════════════════════════════════════════════
//  R2 DOWNLOAD CACHE — convert once, store in R2, serve forever.
//  Key pattern: dl-cache/{jobId}.{fmt}
//  R2 egress is FREE; Class B reads are $0.36/million.
//  This eliminates repeated CPU-intensive transcoding per download.
// ═══════════════════════════════════════════════════════════════

const R2_DL_CACHE_PREFIX = 'dl-cache'

/**
 * Look up a pre-converted audio file in R2 download cache.
 * Returns the ArrayBuffer if found, null if not cached yet.
 */
async function getDlCache(r2: R2Bucket, jobId: string, fmt: string): Promise<ArrayBuffer | null> {
  try {
    const key = `${R2_DL_CACHE_PREFIX}/${jobId}.${fmt}`
    const obj = await r2.get(key)
    if (!obj) return null
    const buf = await obj.arrayBuffer()
    console.log(`[dl-cache] HIT job=${jobId} fmt=${fmt} size=${Math.round(buf.byteLength/1024)}KB`)
    return buf
  } catch (e: any) {
    console.warn(`[dl-cache] GET failed job=${jobId} fmt=${fmt}:`, e?.message)
    return null
  }
}

/**
 * Store a converted audio file in R2 download cache.
 * Fire-and-forget (non-fatal if it fails).
 */
async function putDlCache(r2: R2Bucket, jobId: string, fmt: string, buf: ArrayBuffer): Promise<void> {
  try {
    const key = `${R2_DL_CACHE_PREFIX}/${jobId}.${fmt}`
    await r2.put(key, buf, {
      httpMetadata: { contentType: audioMime(fmt as 'wav' | 'mp3' | 'm4a') }
    })
    console.log(`[dl-cache] PUT job=${jobId} fmt=${fmt} size=${Math.round(buf.byteLength/1024)}KB`)
  } catch (e: any) {
    console.warn(`[dl-cache] PUT failed job=${jobId} fmt=${fmt}:`, e?.message)
  }
}

/** Returns true if a URL already points to our own R2 proxy (i.e. permanent) */
function isR2BeatUrl(url: string, siteUrl: string): boolean {
  if (!url) return false
  return url.includes('/api/track-audio/') ||
         url.includes('/api/extend-audio-proxy/') ||
         url.includes('/api/oneshot-audio/')
}

/**
 * Detect the real audio format from magic bytes (first 12 bytes).
 * Returns 'wav', 'mp3', or 'm4a' regardless of what the URL or Content-Type says.
 */
function detectAudioFormat(buf: ArrayBuffer): 'wav' | 'mp3' | 'm4a' {
  const bytes = new Uint8Array(buf, 0, Math.min(12, buf.byteLength))
  // WAV: RIFF....WAVE
  if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 &&
      bytes[8]===0x57 && bytes[9]===0x41 && bytes[10]===0x56 && bytes[11]===0x45) return 'wav'
  // MP3: ID3 tag or sync bytes (FF Fx)
  if (bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33) return 'mp3'  // ID3
  if (bytes[0]===0xFF && (bytes[1] & 0xE0)===0xE0) return 'mp3'            // sync
  // M4A / MP4: ftyp box at offset 4
  if (bytes[4]===0x66 && bytes[5]===0x74 && bytes[6]===0x79 && bytes[7]===0x70) return 'm4a'
  // Default: trust Content-Type
  return 'wav'
}

/** Map real format to MIME type */
function audioMime(fmt: 'wav' | 'mp3' | 'm4a'): string {
  if (fmt === 'mp3') return 'audio/mpeg'
  if (fmt === 'm4a') return 'audio/mp4'
  return 'audio/wav'
}

/**
 * Fetch `cdnUrl`, upload the audio to R2 as `beats/{jobId}.{ext}` using the REAL format,
 * update the job record so stereo_url points to our proxy endpoint,
 * and return the permanent proxy URL.
 * Returns null (silently) if anything fails — caller keeps original URL.
 */
async function persistAudioToR2(
  cdnUrl: string,
  jobId: string,
  r2: R2Bucket,
  db: D1Database | undefined,
  siteUrl: string
): Promise<string | null> {
  try {
    // Fetch the audio from the CDN
    const resp = await fetch(cdnUrl, { headers: { 'User-Agent': 'StemForge/1.0' } })
    if (!resp.ok) {
      console.warn(`[R2 persist] CDN fetch failed for job=${jobId}: HTTP ${resp.status}`)
      return null
    }
    const buf = await resp.arrayBuffer()
    if (!buf || buf.byteLength < 1000) {
      console.warn(`[R2 persist] Audio too small for job=${jobId}: ${buf?.byteLength} bytes`)
      return null
    }

    // Detect REAL format from magic bytes — never trust URL extension or Content-Type header
    let realFmt = detectAudioFormat(buf)
    let finalBuf: ArrayBuffer = buf

    // Store MP3 as-is in R2 — on-demand WAV conversion happens at download time
    // via mp3ToWav (Workers Paid: 30ms CPU, safe for full songs).
    if (realFmt === 'mp3') {
      console.log(`[R2 persist] job=${jobId} storing MP3 as-is (${Math.round(buf.byteLength/1024)}KB)`)
      finalBuf = buf
      // realFmt stays 'mp3'
    }
    // M4A: no in-Worker AAC decoder available — store as-is with correct MIME
    const ctype = audioMime(realFmt)
    const ext   = realFmt
    const r2Key = `${R2_BEATS_PREFIX}/${jobId}.${ext}`
    console.log(`[R2 persist] job=${jobId} detected format=${realFmt} size=${Math.round(finalBuf.byteLength/1024)}KB`)

    // Upload to R2 (use finalBuf — may be converted WAV, not the raw CDN bytes)
    await r2.put(r2Key, finalBuf, {
      httpMetadata: { contentType: ctype },
      customMetadata: { jobId, source: 'pipeline', savedAt: Date.now().toString() }
    })

    // Build permanent proxy URL
    const proxyUrl = `${siteUrl}/api/track-audio/${jobId}`

    // Update the job record so audio URL is now permanent.
    // Updates whichever field was set: stereo_url (beats/remix/cover) or audio_url (one-shots).
    if (db) {
      try {
        const row = await db.prepare('SELECT data FROM jobs WHERE id = ?').bind(jobId).first<{ data: string }>()
        if (row) {
          const job = JSON.parse(row.data) as any
          // Update whichever URL field this track uses
          if (job.stereo_url && !job.stereo_url.includes('/api/track-audio/')) job.stereo_url = proxyUrl
          if (job.audio_url && !job.audio_url.includes('/api/track-audio/'))   job.audio_url  = proxyUrl
          ;(job as any).r2_audio_key = r2Key   // store key for direct R2 access
          await db.prepare('UPDATE jobs SET data = ? WHERE id = ?').bind(JSON.stringify(job), jobId).run()
        }
      } catch (dbErr: any) {
        console.warn(`[R2 persist] DB update failed for job=${jobId}:`, dbErr?.message)
        // Non-fatal — R2 file is saved, just the URL in DB didn't update
      }
    }

    console.log(`[R2 persist] Saved job=${jobId} → R2 key=${r2Key} (${Math.round(buf.byteLength/1024)}KB)`)
    return proxyUrl
  } catch (err: any) {
    console.warn(`[R2 persist] Failed for job=${jobId}:`, err?.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// primeCoverWav — Option A background WAV pre-bake for cover songs
// Called fire-and-forget via waitUntil() right after a cover is marked ready.
// Fetches the cover MP3 from its CDN URL (or R2 key), runs mp3ToWav() in the
// background Worker, and stores the resulting WAV in the R2 dl-cache so that
// the next /api/download-wav/:id hit returns instantly (X-Cache: HIT).
// If conversion fails (e.g. CPU limit on very long tracks) it silently swallows
// the error — the user still gets MP3 on download, which is the graceful fallback.
// ─────────────────────────────────────────────────────────────────────────────
async function primeCoverWav(
  jobId: string,
  audioUrl: string,
  r2: R2Bucket,
  siteUrl: string
): Promise<void> {
  try {
    // 1. Skip if WAV dl-cache already populated
    const existing = await getDlCache(r2, jobId, 'wav')
    if (existing) { console.log(`[prime-wav] job=${jobId} WAV already cached, skip`); return }

    // 2. Fetch the cover MP3 (try R2 first, then CDN URL)
    let rawBuf: ArrayBuffer | null = null
    // Try beats/<jobId>.mp3 in R2 first (faster, permanent)
    const r2Obj = await r2.get(`${R2_BEATS_PREFIX}/${jobId}.mp3`)
    if (r2Obj) {
      rawBuf = await r2Obj.arrayBuffer()
      console.log(`[prime-wav] job=${jobId} source=R2 size=${Math.round(rawBuf.byteLength/1024)}KB`)
    }
    // Fallback to CDN URL
    if (!rawBuf && audioUrl) {
      const resp = await fetch(audioUrl, { headers: { 'User-Agent': 'StemForge/1.0' } })
      if (resp.ok) {
        rawBuf = await resp.arrayBuffer()
        console.log(`[prime-wav] job=${jobId} source=CDN size=${Math.round(rawBuf.byteLength/1024)}KB`)
      }
    }
    if (!rawBuf || rawBuf.byteLength < 1000) {
      console.warn(`[prime-wav] job=${jobId} could not fetch source audio`)
      return
    }

    // 3. Convert MP3 → WAV (WASM — may hit CPU limit for very long tracks, that's OK)
    const fmt = detectAudioFormat(rawBuf)
    if (fmt !== 'mp3') {
      console.log(`[prime-wav] job=${jobId} source is ${fmt}, not MP3 — storing in dl-cache as-is`)
      await putDlCache(r2, jobId, fmt as 'wav', rawBuf)
      return
    }
    console.log(`[prime-wav] job=${jobId} starting MP3→WAV WASM conversion…`)
    const wavBuf = await mp3ToWav(rawBuf)
    console.log(`[prime-wav] job=${jobId} WAV converted: ${Math.round(wavBuf.byteLength/1024)}KB`)

    // 4. Store WAV in dl-cache — next /api/download-wav/:id returns it instantly
    await putDlCache(r2, jobId, 'wav', wavBuf)
    console.log(`[prime-wav] job=${jobId} WAV stored in R2 dl-cache ✓`)
  } catch (err: any) {
    // Silent failure — cover download falls back to MP3 gracefully
    console.warn(`[prime-wav] job=${jobId} failed (CPU limit?):`, err?.message?.slice(0, 120))
  }
}

// ═══════════════════════════════════════════════════════════════
//  AUTH — Users, Sessions, Google OAuth, Email/Password
//  Uses D1 for persistence. Falls back gracefully if secrets
//  are not yet configured (returns 503 with setup message).
// ═══════════════════════════════════════════════════════════════

interface User {
  id: string
  email: string
  name: string
  avatar?: string
  cover_image?: string
  avatar_position?: string   // CSS object-position e.g. '50% 30%'
  cover_position?: string    // CSS background-position
  plan: 'free' | 'creator' | 'pro' | 'developer'
  gens_used: number
  gens_limit: number       // base plan limit (resets on billing cycle)
  bonus_credits: number    // extra purchased credits (consumed FIRST, don't reset)
  stripe_customer_id?: string
  stripe_subscription_id?: string
  account_locked?: number   // 1 = locked, 0/null = active
  lock_reason?: string
  pending_downgrade?: string | null  // 'creator' | 'free' | null — stored in D1 at downgrade time
  downloads_used: number             // tracks downloaded this billing cycle (counts actual downloads)
  created_at: number
}

// ── D1 table bootstrap ────────────────────────────────────────
async function ensureAuthTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      gens_used INTEGER NOT NULL DEFAULT 0,
      gens_limit INTEGER NOT NULL DEFAULT 50,
      password_hash TEXT,
      google_id TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      registration_ip TEXT,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      discount_type TEXT NOT NULL DEFAULT 'percent',
      discount_value INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 0,
      uses_count INTEGER NOT NULL DEFAULT 0,
      plan_override TEXT,
      bonus_credits INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      terms TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS promo_redemptions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redeemed_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS credit_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      credits INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      stripe_price_id TEXT,
      active INTEGER NOT NULL DEFAULT 1
    )`),
  ])
  // Migration: add missing columns safely
  const migrations = [
    `ALTER TABLE users ADD COLUMN google_id TEXT`,
    `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  ]
  for (const sql of migrations) {
    try { await db.prepare(sql).run() } catch { /* already exists */ }
  }

  // ── Site version table — controls preview vs live for all users ──
  await db.prepare(`CREATE TABLE IF NOT EXISTS site_version (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run()
  await db.prepare(`INSERT OR IGNORE INTO site_version (key, value, updated_at) VALUES ('active_version', 'live', ?)`).bind(Date.now()).run()

  // ── Analytics page_views table ──
  await db.prepare(`CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    referrer TEXT,
    source TEXT,
    medium TEXT,
    campaign TEXT,
    created_at INTEGER NOT NULL
  )`).run()

  // ── Migrate: add country column to page_views (idempotent) ──
  try { await db.prepare(`ALTER TABLE page_views ADD COLUMN country TEXT`).run() } catch {}

  // ── Migrate: add registration_ip column if missing (idempotent) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN registration_ip TEXT`).run() } catch {}
  // ── Migrate: add account_locked + lock_reason columns (idempotent) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN account_locked INTEGER NOT NULL DEFAULT 0`).run() } catch {}
  try { await db.prepare(`ALTER TABLE users ADD COLUMN lock_reason TEXT`).run() } catch {}
  // ── Migrate: add bonus_credits column (tracks purchased extra credits separately) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN bonus_credits INTEGER NOT NULL DEFAULT 0`).run() } catch {}
  // ── Migrate: add pending_downgrade column (tracks scheduled plan downgrade) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN pending_downgrade TEXT`).run() } catch {}
  // ── Migrate: add downloads_used column (monthly download counter, resets each billing cycle) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN downloads_used INTEGER NOT NULL DEFAULT 0`).run() } catch {}
  // ── Migrate: add cycle_start column (tracks when free user's current 30-day window began) ──
  // Defaults to created_at so existing users get their first reset ~30 days after signup
  try { await db.prepare(`ALTER TABLE users ADD COLUMN cycle_start INTEGER`).run() } catch {}
  // ── Migrate: add cover_image column (stores R2 URL for profile banner/cover photo) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN cover_image TEXT`).run() } catch {}
  // ── Migrate: add avatar_position + cover_position (CSS position strings for drag crop) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN avatar_position TEXT`).run() } catch {}
  try { await db.prepare(`ALTER TABLE users ADD COLUMN cover_position  TEXT`).run() } catch {}
  // ── Migrate: add signup_source column (first referrer URL captured at registration) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN signup_source TEXT`).run() } catch {}
  try { await db.prepare(`ALTER TABLE users ADD COLUMN signup_referrer TEXT`).run() } catch {}
  // ── Migrate: add email_unsubscribed column (broadcast opt-out) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN email_unsubscribed INTEGER NOT NULL DEFAULT 0`).run() } catch {}
  // ── Migrate: add welcome_sent_at column (tracks when welcome email was successfully delivered) ──
  try { await db.prepare(`ALTER TABLE users ADD COLUMN welcome_sent_at INTEGER`).run() } catch {}
  // ── Migrate: broadcast tracking tables ──
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS broadcast_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT 'all',
      sent_count INTEGER NOT NULL DEFAULT 0,
      opened_count INTEGER NOT NULL DEFAULT 0,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run()
    await db.prepare(`CREATE TABLE IF NOT EXISTS broadcast_opens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      send_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run()
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_opens_unique ON broadcast_opens(send_id, token)`).run()
  } catch {}
  // ── Migrate: email_templates table for saved broadcast templates ──
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      blocks_json TEXT NOT NULL DEFAULT '[]',
      styles_json TEXT NOT NULL DEFAULT '{}',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run()
  } catch {}
  // ── Seed welcome template if not already present ──
  try {
    const existing = await db.prepare(`SELECT id FROM email_templates WHERE name='Welcome to StemForge' LIMIT 1`).first()
    if (!existing) {
      const welcomeBlocks = JSON.stringify([
        { id:'b1', type:'header', text:'Welcome to StemForge 🎵', fontSize:'28px', align:'center', bold:true },
        { id:'b2', type:'image', url:'https://stemforge.studio/static/logo.png', alt:'StemForge', width:'120px', align:'center' },
        { id:'b3', type:'spacer', height:'16px' },
        { id:'b4', type:'text', text:"Hey {{name}}, you're in! 🎉\n\nStemForge is an AI-powered music production studio built for creators who want to move fast. Split stems, isolate vocals, extend tracks, and create instrumentals — all from your browser, no plugins, no downloads.", align:'left', fontSize:'15px' },
        { id:'b5', type:'divider' },
        { id:'b6', type:'text', text:'Here\'s what you can do right now:', align:'left', fontSize:'14px', bold:true },
        { id:'b7', type:'text', text:'🎤  Vocal Remover — strip vocals from any track\n🥁  Stem Splitter — isolate drums, bass, melody\n🔁  Song Extender — AI extends your track seamlessly\n🎹  Instrumental Creator — generate custom backing tracks', align:'left', fontSize:'14px' },
        { id:'b8', type:'spacer', height:'8px' },
        { id:'b9', type:'button', text:'Start Creating Now →', url:'https://stemforge.studio', align:'center', bgColor:'#4e9fff', textColor:'#050c1a' },
        { id:'b10', type:'spacer', height:'16px' },
        { id:'b11', type:'text', text:'Made with 🎧 by the StemForge team\nstemforge.studio', align:'center', fontSize:'12px' }
      ])
      const welcomeStyles = JSON.stringify({ bgColor:'#080e1a', textColor:'#e2e8f0', accentColor:'#4e9fff', font:'Inter,system-ui,sans-serif', width:'600px' })
      await db.prepare(`INSERT INTO email_templates (name,subject,blocks_json,styles_json,is_system) VALUES (?,?,?,?,1)`)
        .bind('Welcome to StemForge', 'Welcome to StemForge — your AI music studio is ready 🎵', welcomeBlocks, welcomeStyles)
        .run()
    }
  } catch {}
  // Backfill: any free user without cycle_start gets created_at as their cycle start
  try { await db.prepare(`UPDATE users SET cycle_start = created_at WHERE plan = 'free' AND cycle_start IS NULL`).run() } catch {}
  // ── Opportunistic reset on cold start — catches any overdue free users ──
  try { await runFreeUserReset(db) } catch {}
  // ── Lock specific policy-violating accounts (idempotent) ──
  try {
    await db.prepare(
      `UPDATE users SET account_locked=1, lock_reason='Duplicate account — your household already has a free StemForge account. Only one free account is allowed per household. Contact support@stemforge.studio to appeal.' WHERE email='miriamsreality@gmail.com' AND account_locked=0`
    ).run()
  } catch {}

  // ── Migrate existing users to correct point limits (runs on every cold start, idempotent) ──
  // Free users: 60 pts (3 beats)
  await db.prepare(`UPDATE users SET gens_limit = 60   WHERE plan = 'free'      AND gens_limit < 60`).run()
  // Creator users below 900 → 900 pts
  await db.prepare(`UPDATE users SET gens_limit = 900  WHERE plan = 'creator'   AND gens_limit < 900`).run()
  // Pro users below 2000 → 2000 pts
  await db.prepare(`UPDATE users SET gens_limit = 2000 WHERE plan = 'pro'       AND gens_limit < 2000`).run()
  // Developer users below 2000 → 2000 pts
  await db.prepare(`UPDATE users SET gens_limit = 2000 WHERE plan = 'developer' AND gens_limit < 2000`).run()
  // ── API errors table — tracks capacity errors (Mureka/MusicAPI busy) ──
  await db.prepare(`CREATE TABLE IF NOT EXISTS api_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    error_type TEXT NOT NULL,
    user_id TEXT,
    created_at INTEGER NOT NULL
  )`).run()
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_errors_created_at ON api_errors (created_at)`).run() } catch {}

  // ── Signup click tracking table ──────────────────────────────────────────────
  // Records every time a user clicks the "Continue with Google" or email signup button
  await db.prepare(`CREATE TABLE IF NOT EXISTS signup_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL DEFAULT 'google',  -- 'google' | 'email'
    page TEXT NOT NULL DEFAULT 'login',          -- 'login' | 'signup'
    referrer TEXT,
    country TEXT,
    created_at INTEGER NOT NULL
  )`).run()
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_signup_clicks_created_at ON signup_clicks (created_at)`).run() } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_signup_clicks_event_type ON signup_clicks (event_type)`).run() } catch {}

  // ── Performance indexes (idempotent) ──
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views (created_at)`).run() } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id)`).run() } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at)`).run() } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_plan ON users (plan)`).run() } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)`).run() } catch {}
}

// ── Crypto helpers (Web Crypto API — works in CF Workers) ─────
async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    keyMaterial, 256
  )
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2,'0')).join('')
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('')
  return `pbkdf2:${saltHex}:${hashHex}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [, saltHex, hashHex] = stored.split(':')
    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
    const enc = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
      keyMaterial, 256
    )
    const newHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('')
    return newHex === hashHex
  } catch { return false }
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2,'0')).join('')
}

// ─── TIKTOK SERVER-SIDE EVENTS ───────────────────────────────────────────────
const TIKTOK_PIXEL_ID = 'D9SVAV3C77UA78AD7EU0'
const TIKTOK_PIXEL_ID_3 = 'DAFIT1JC77UES974NPK0'
const TIKTOK_PIXEL_ID_4 = 'DANT6N3C77U88MSNTF7G'
async function sha256Hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
}
async function sendTikTokEvent(opts: {
  token: string; token3?: string; event: 'CompleteRegistration' | 'Subscribe'
  email?: string; ip?: string; userAgent?: string; eventId?: string
  value?: number; currency?: string; url?: string
}): Promise<void> {
  try {
    if (!opts.token) return
    const hashedEmail = opts.email ? await sha256Hex(opts.email.toLowerCase().trim()) : undefined
    const eventData: Record<string, any> = {
      event: opts.event,
      event_id: opts.eventId || crypto.randomUUID(),
      event_time: Math.floor(Date.now() / 1000),
      user: {
        ...(hashedEmail ? { email: hashedEmail } : {}),
        ...(opts.ip ? { ip: opts.ip } : {}),
        ...(opts.userAgent ? { user_agent: opts.userAgent } : {}),
      },
      page: { url: opts.url || 'https://stemforge.studio' },
      properties: {}
    }
    if (opts.event === 'Subscribe' && opts.value) {
      eventData.properties = { value: opts.value, currency: opts.currency || 'USD' }
    }
    // Fire for pixel 1 (original account)
    await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'Access-Token': opts.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_source: 'web', event_source_id: TIKTOK_PIXEL_ID, data: [eventData] })
    })
    // Fire for pixel 3 (third account) — only if a third token is configured
    if (opts.token3) {
      await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
        method: 'POST',
        headers: { 'Access-Token': opts.token3, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_source: 'web', event_source_id: TIKTOK_PIXEL_ID_3, data: [eventData] })
      })
    }
  } catch (e) { console.error('[tiktok-event] failed:', e) }
}

// ── Send welcome email to new signup ─────────────────────────
async function sendWelcomeEmail(opts: { db: D1Database; resendKey?: string; mailerKey?: string; name: string; email: string; siteUrl: string; userId?: string }): Promise<void> {
  const { db, resendKey, mailerKey, name, email, siteUrl, userId } = opts
  console.log(`[welcome-email] triggered for ${email} resendKey=${!!resendKey} mailerKey=${!!mailerKey}`)
  if (!resendKey && !mailerKey) {
    console.error('[welcome-email] SKIP — no API key set (RESEND_API_KEY and MAILERSEND_API_KEY both missing)')
    return
  }
  const displayName = name?.split(' ')[0] || 'there'
  const url = siteUrl || 'https://stemforge.studio'

  // ── Hardcoded fallback HTML (always works even if D1 template query fails) ──
  const fallbackSubject = 'Welcome to StemForge — your AI music studio is ready 🎵'
  const fallbackHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#080e1a;font-family:Inter,system-ui,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;color:#e2e8f0">
<h1 style="margin:0 0 16px;font-size:28px;color:#e2e8f0;text-align:center;font-weight:700;line-height:1.6">Welcome to StemForge 🎵</h1>
<div style="height:16px"></div>
<p style="margin:0 0 16px;font-size:15px;color:#e2e8f0;text-align:left;font-weight:400;line-height:1.6">Hey ${displayName}, you're in! 🎉<br/><br/>StemForge is an AI-powered music generator built for creators who want to move fast. Split stems, isolate vocals, extend tracks, and create instrumentals — StemForge is designed to accelerate your creative process.</p>
<hr style="border:none;border-top:1px solid #1e293b;margin:16px 0"/>
<div style="height:8px"></div>
<div style="text-align:center;margin-bottom:16px"><a href="${url}" style="display:inline-block;background:#4e9fff;color:#050c1a;font-weight:700;font-size:15px;padding:13px 32px;border-radius:50px;text-decoration:none;font-family:Inter,system-ui,sans-serif">Start Creating Now →</a></div>
<div style="height:16px"></div>
<p style="margin:0 0 16px;font-size:12px;color:#e2e8f0;text-align:center;font-weight:400;line-height:1.6">stemforge.studio</p>
<div style="margin-top:40px;padding-top:16px;border-top:1px solid #1e293b;text-align:center;font-size:11px;color:#475569;font-family:sans-serif">
  You're receiving this because you signed up at <a href="${url}" style="color:#4e9fff">${url.replace('https://','')}</a><br/>
  <a href="${url}/api/unsubscribe?id=0&t=welcome" style="color:#475569">Unsubscribe</a>
</div>
</div>
</body></html>`

  let subject = fallbackSubject
  let html = fallbackHtml

  // ── Try to pull the latest saved welcome template from D1 ──
  try {
    const tpl = await db.prepare(
      `SELECT subject, blocks_json, styles_json FROM email_templates WHERE name='Welcome to StemForge' ORDER BY updated_at DESC LIMIT 1`
    ).first<{ subject: string; blocks_json: string; styles_json: string }>()

    if (tpl && tpl.blocks_json) {
      const blocks: any[] = JSON.parse(tpl.blocks_json || '[]')
      const styles: any = JSON.parse(tpl.styles_json || '{}')
      const bg = styles.bgColor || '#080e1a'
      const tc = styles.textColor || '#e2e8f0'
      const ac = styles.accentColor || '#4e9fff'
      const font = styles.font || 'Inter,system-ui,sans-serif'
      const width = styles.width || '600px'
      const unsubUrl = `${url}/api/unsubscribe?id=0&t=welcome`

      const blockHtml = blocks.map((b: any) => {
        if (b.type === 'header' || b.type === 'text') {
          const fs = b.fontSize ? (String(b.fontSize).includes('px') ? b.fontSize : b.fontSize + 'px') : (b.type === 'header' ? '24px' : '15px')
          const fw = b.bold ? '700' : '400'
          const tag = b.type === 'header' ? 'h1' : 'p'
          const txt = (b.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/{{name}}/g, displayName).replace(/\n/g,'<br/>')
          return `<${tag} style="margin:0 0 16px;font-size:${fs};color:${tc};text-align:${b.align||'left'};font-weight:${fw};font-family:${font};line-height:1.6">${txt}</${tag}>`
        }
        if (b.type === 'image') {
          const img = `<img src="${b.src||b.url||''}" alt="${b.alt||''}" width="${b.width||'100%'}" style="display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto 16px"/>`
          return b.link ? `<a href="${b.link}" style="display:block;text-align:${b.align||'center'}">${img}</a>` : `<div style="text-align:${b.align||'center'}">${img}</div>`
        }
        if (b.type === 'button') {
          return `<div style="text-align:${b.align||'center'};margin-bottom:16px"><a href="${b.url||'#'}" style="display:inline-block;background:${b.bgColor||ac};color:${b.textColor||'#050c1a'};font-weight:700;font-size:15px;padding:13px 32px;border-radius:50px;text-decoration:none;font-family:${font}">${(b.text||'Click Here').replace(/&/g,'&amp;')}</a></div>`
        }
        if (b.type === 'divider') return `<hr style="border:none;border-top:1px solid #1e293b;margin:16px 0"/>`
        if (b.type === 'spacer') return `<div style="height:${b.height ? (String(b.height).includes('px') ? b.height : b.height+'px') : '16px'}"></div>`
        return ''
      }).join('\n')

      const tplHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:${bg};font-family:${font}">
<div style="max-width:${width};margin:0 auto;padding:40px 20px;color:${tc}">
${blockHtml}
<div style="margin-top:40px;padding-top:16px;border-top:1px solid #1e293b;text-align:center;font-size:11px;color:#475569;font-family:sans-serif">
  You're receiving this because you signed up at <a href="${url}" style="color:${ac}">${url.replace('https://','')}</a><br/>
  <a href="${unsubUrl}" style="color:#475569">Unsubscribe</a>
</div>
</div>
</body></html>`

      if (tplHtml && tplHtml.length > 100) {
        subject = tpl.subject || subject
        html = tplHtml
        console.log('[welcome-email] using D1 template, blocks:', blocks.length)
      } else {
        console.warn('[welcome-email] D1 template rendered empty, using fallback')
      }
    } else {
      console.warn('[welcome-email] no D1 template found, using hardcoded fallback')
    }
  } catch (e) {
    console.error('[welcome-email] D1 template fetch failed, using fallback:', e)
    // continue with fallbackHtml — do NOT return
  }

  // ── Send via Resend (primary) or MailerSend (fallback) ──
  try {
    if (resendKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'StemForge <noreply@stemforge.studio>', to: [email], subject, html })
      })
      const resBody = await res.text()
      if (!res.ok) {
        console.error(`[welcome-email] Resend error ${res.status}:`, resBody)
      } else {
        console.log(`[welcome-email] Resend OK for ${email}:`, resBody)
        // ── Stamp welcome_sent_at on the user row ──
        if (userId) {
          try { await db.prepare(`UPDATE users SET welcome_sent_at=? WHERE id=?`).bind(Date.now(), userId).run() } catch {}
        } else {
          try { await db.prepare(`UPDATE users SET welcome_sent_at=? WHERE email=?`).bind(Date.now(), email.toLowerCase()).run() } catch {}
        }
      }
    } else if (mailerKey) {
      const res = await fetch('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mailerKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { email: 'noreply@stemforge.studio', name: 'StemForge' }, to: [{ email }], subject, html })
      })
      const resBody = await res.text()
      if (!res.ok) {
        console.error(`[welcome-email] MailerSend error ${res.status}:`, resBody)
      } else {
        console.log(`[welcome-email] MailerSend OK for ${email}:`, resBody)
        // ── Stamp welcome_sent_at on the user row ──
        if (userId) {
          try { await db.prepare(`UPDATE users SET welcome_sent_at=? WHERE id=?`).bind(Date.now(), userId).run() } catch {}
        } else {
          try { await db.prepare(`UPDATE users SET welcome_sent_at=? WHERE email=?`).bind(Date.now(), email.toLowerCase()).run() } catch {}
        }
      }
    }
  } catch (e) {
    console.error('[welcome-email] send failed:', e)
  }
}

function generateId(): string {
  return 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,8)
}

// ── Session helpers ───────────────────────────────────────────
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000  // 30 days

async function createSession(db: D1Database, userId: string): Promise<string> {
  await ensureAuthTables(db)
  const token = generateToken()
  const now = Date.now()
  await db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).bind(token, userId, now + SESSION_TTL, now).run()
  return token
}

async function getSessionUser(db: D1Database, token: string): Promise<User | null> {
  if (!token) return null
  try {
    const row = await db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > ?`
    ).bind(token, Date.now()).first<any>()
    if (!row) return null
    return {
      id: row.id, email: row.email, name: row.name, avatar: row.avatar,
      cover_image:      row.cover_image      ?? null,
      avatar_position:   row.avatar_position   ?? '50% 50%',
      cover_position:    row.cover_position    ?? '50% 50%',
      plan: row.plan, gens_used: row.gens_used, gens_limit: row.gens_limit,
      bonus_credits: row.bonus_credits ?? 0,
      stripe_customer_id: row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
      account_locked: row.account_locked ?? 0,
      lock_reason: row.lock_reason ?? null,
      pending_downgrade: row.pending_downgrade ?? null,
      downloads_used: row.downloads_used ?? 0,
      created_at: row.created_at
    }
  } catch { return null }
}

function getSessionCookie(req: Request): string {
  const cookie = req.headers.get('Cookie') || ''
  const match = cookie.match(/sf_session=([a-f0-9]{64})/)
  return match ? match[1] : ''
}

function setSessionCookie(token: string, siteUrl: string): string {
  const secure = siteUrl.startsWith('https') ? '; Secure' : ''
  return `sf_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30*24*3600}${secure}`
}

function clearSessionCookie(): string {
  return `sf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

// ── Admin panel secondary verification cookie (4-hour gate) ──
function getAdminVerifiedCookie(req: Request): boolean {
  const cookie = req.headers.get('Cookie') || ''
  return /sf_admin_v=1/.test(cookie)
}
function setAdminVerifiedCookie(siteUrl: string): string {
  const secure = siteUrl.startsWith('https') ? '; Secure' : ''
  return `sf_admin_v=1; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${4*3600}${secure}`
}
function clearAdminVerifiedCookie(): string {
  return `sf_admin_v=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`
}

// ── User DB helpers ───────────────────────────────────────────
async function getUserByEmail(db: D1Database, email: string): Promise<any | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<any>()
}

async function createUser(db: D1Database, data: {
  id: string, email: string, name: string, avatar?: string,
  password_hash?: string, google_id?: string, plan?: string, registration_ip?: string,
  signup_source?: string, signup_referrer?: string
}): Promise<void> {
  await ensureAuthTables(db)
  const planLimits: Record<string, number> = { free:60, creator:900, pro:2000 }
  const plan = data.plan || 'free'
  const now = Date.now()
  await db.prepare(
    `INSERT INTO users (id, email, name, avatar, plan, gens_used, gens_limit, password_hash, google_id, registration_ip, created_at, cycle_start, signup_source, signup_referrer)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(data.id, data.email, data.name, data.avatar || null, plan,
    planLimits[plan] || 60, data.password_hash || null, data.google_id || null,
    data.registration_ip || null, now, plan === 'free' ? now : null,
    data.signup_source || null, data.signup_referrer || null).run()
}

async function updateUserPlan(db: D1Database, userId: string, plan: string,
  stripeCustomerId: string, stripeSubId: string): Promise<void> {
  const planLimits: Record<string, number> = { free:60, creator:900, pro:2000 }
  // Apply rollover: unused downloads carry over, capped at 500
  const currentUser = await db.prepare('SELECT gens_used, gens_limit FROM users WHERE id=?').bind(userId).first<{gens_used:number,gens_limit:number}>()
  const newLimit = planLimits[plan] || 60
  let rolledLimit = newLimit
  if (currentUser) {
    const unused = Math.max(0, currentUser.gens_limit - currentUser.gens_used)
    rolledLimit = Math.min(5000, newLimit + unused)
  }
  await db.prepare(
    `UPDATE users SET plan=?, gens_limit=?, gens_used=0, stripe_customer_id=?, stripe_subscription_id=? WHERE id=?`
  ).bind(plan, rolledLimit, stripeCustomerId, stripeSubId, userId).run()
}

// ── Monthly reset with rollover (called on invoice.paid Stripe event) ─────
async function resetMonthlyDownloads(db: D1Database, customerId: string, plan: string): Promise<void> {
  const planLimits: Record<string, number> = { free:60, creator:900, pro:2000 }
  const newMonthBase = planLimits[plan] || 60
  const currentUser = await db.prepare('SELECT gens_used, gens_limit FROM users WHERE stripe_customer_id=?').bind(customerId).first<{gens_used:number,gens_limit:number}>()
  if (!currentUser) return
  const unused = Math.max(0, currentUser.gens_limit - currentUser.gens_used)
  const rolledLimit = Math.min(5000, newMonthBase + unused)
  // Reset gens_used, roll over unused plan points (NOT bonus_credits — those expire), reset download counter
  await db.prepare(
    `UPDATE users SET gens_used=0, gens_limit=?, bonus_credits=0, downloads_used=0 WHERE stripe_customer_id=?`
  ).bind(rolledLimit, customerId).run()
}

// ── Admin subscription email notification ────────────────────────────────────
async function sendAdminSubscriptionEmail(
  env: Bindings,
  info: { userName: string; userEmail: string; plan: string; event: string; timestamp: string }
): Promise<void> {
  const adminEmail = (env as any).ADMIN_EMAIL || 'andrewsmusiclab@gmail.com'
  const resendKey = (env as any).RESEND_API_KEY
  const mailerKey = (env as any).MAILERSEND_API_KEY
  const fromEmail = (env as any).FEEDBACK_FROM_EMAIL || ''

  const subject = `[StemForge] ${info.event} — ${info.plan} plan`
  const bodyHtml = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0d0d1a;color:#e2e8f0;padding:32px;border-radius:12px">
  <h2 style="margin:0 0 20px;color:#4e9fff;font-size:1.3rem">🎉 ${info.event}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:.9rem">
    <tr><td style="padding:8px 0;color:#94a3b8;width:120px">Name</td><td style="padding:8px 0;color:#e2e8f0;font-weight:600">${info.userName}</td></tr>
    <tr><td style="padding:8px 0;color:#94a3b8">Email</td><td style="padding:8px 0;color:#e2e8f0">${info.userEmail}</td></tr>
    <tr><td style="padding:8px 0;color:#94a3b8">Plan</td><td style="padding:8px 0;color:#10b981;font-weight:700;text-transform:capitalize">${info.plan}</td></tr>
    <tr><td style="padding:8px 0;color:#94a3b8">Time</td><td style="padding:8px 0;color:#e2e8f0">${info.timestamp}</td></tr>
  </table>
  <p style="margin:24px 0 0;font-size:.8rem;color:#475569">Sent automatically by StemForge on subscription event.</p>
</div>`

  // Try MailerSend first
  if (mailerKey && fromEmail) {
    try {
      const res = await fetch('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mailerKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { email: fromEmail, name: 'StemForge' },
          to: [{ email: adminEmail }],
          subject,
          html: bodyHtml
        })
      })
      if (res.ok || res.status === 202) return
    } catch (e) { console.error('[sub-email] MailerSend failed:', e) }
  }

  // Fallback: Resend
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'StemForge <noreply@stemforge.studio>',
          to: [adminEmail],
          subject,
          html: bodyHtml
        })
      })
      if (res.ok) return
      const err = await res.json() as any
      console.error('[sub-email] Resend error:', err)
    } catch (e) { console.error('[sub-email] Resend failed:', e) }
  }

  // Final fallback: log to console
  console.log(`[sub-email] ${info.event} | ${info.userEmail} | plan=${info.plan}`)
}

// ── Stripe helpers ────────────────────────────────────────────
const STRIPE_BASE = 'https://api.stripe.com/v1'

async function stripeRequest(method: string, path: string, body: Record<string,string>, key: string): Promise<any> {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method !== 'GET' ? new URLSearchParams(body).toString() : undefined,
  })
  const data = await res.json() as any
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`)
  return data
}

async function createStripeCheckoutSession(
  stripeKey: string, priceId: string, customerEmail: string,
  userId: string, siteUrl: string
): Promise<string> {
  const data = await stripeRequest('POST', '/checkout/sessions', {
    'payment_method_types[]': 'card',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    mode: 'subscription',
    customer_email: customerEmail,
    'metadata[user_id]': userId,
    success_url: `${siteUrl}/dashboard?payment=success`,
    cancel_url: `${siteUrl}/pricing`,
    'allow_promotion_codes': 'true',
  }, stripeKey)
  return data.url as string
}

async function verifyStripeWebhook(payload: string, sigHeader: string, secret: string): Promise<any> {
  const parts = sigHeader.split(',').reduce((acc: Record<string,string>, part) => {
    const [k, v] = part.split('='); acc[k] = v; return acc
  }, {})
  const timestamp = parts['t']
  const signature = parts['v1']
  if (!timestamp || !signature) throw new Error('Invalid stripe-signature header')

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const signed = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`))
  const computed = Array.from(new Uint8Array(signed)).map(b => b.toString(16).padStart(2,'0')).join('')
  if (computed !== signature) throw new Error('Webhook signature mismatch')
  return JSON.parse(payload)
}

// ── Google OAuth helpers ──────────────────────────────────────
function googleAuthUrl(clientId: string, siteUrl: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${siteUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function exchangeGoogleCode(code: string, clientId: string, clientSecret: string, siteUrl: string): Promise<{
  email: string, name: string, picture: string, sub: string
}> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: `${siteUrl}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }).toString()
  })
  const tokens = await tokenRes.json() as any
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Google token exchange failed')

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  })
  const info = await infoRes.json() as any
  if (!infoRes.ok) throw new Error('Failed to fetch Google user info')
  return { email: info.email, name: info.name, picture: info.picture, sub: info.id }
}

// ── Helper: check if secrets are configured ───────────────────
function authConfigured(env: Bindings): boolean {
  return !!(env.SESSION_SECRET && !env.SESSION_SECRET.includes('PASTE_'))
}
function stripeConfigured(env: Bindings): boolean {
  return !!(env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.includes('PASTE_'))
}
function googleConfigured(env: Bindings): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SITE_URL &&
            !env.GOOGLE_CLIENT_ID.includes('PASTE_'))
}

// ── Plan name from Stripe price ID ───────────────────────────
function planFromPriceId(env: Bindings, priceId: string): string {
  // Current prices
  if (priceId === env.STRIPE_CREATOR_PRICE_ID) return 'creator'
  if (priceId === env.STRIPE_PRO_PRICE_ID) return 'pro'
  // Legacy prices — subscribers on the old price IDs are still recognised correctly.
  // These keep working until every subscriber has been migrated or renewed onto the new price.
  if (env.STRIPE_CREATOR_PRICE_ID_LEGACY && priceId === env.STRIPE_CREATOR_PRICE_ID_LEGACY) return 'creator'
  if (env.STRIPE_PRO_PRICE_ID_LEGACY && priceId === env.STRIPE_PRO_PRICE_ID_LEGACY) return 'pro'
  return 'free'
}

// ── Stem extraction types ──────────────────────────────────────
type StemName = 'vocals' | 'drums' | 'bass' | 'other' | 'instrumental'
// StemMode — maps to Mureka model:
//   'auto'           → audio-separation-1  (5 stems: vocals, drums, bass, other, instrumental)
//   'split_from_mix' → audio-separation-3  (2 stems: vocals + instrumental)
type StemMode = 'auto' | 'split_from_mix'

interface StemTrack {
  name: StemName | string   // stem label
  url: string               // zip-entry: URL or CDN URL for the stem WAV
}

interface StemJob {
  task_id: string
  mode: StemMode
  status: 'pending' | 'processing' | 'ready' | 'error'
  stems: StemTrack[]
  error?: string
  target_instrument?: string // for split_from_mix / advanced
  created_at: number
}

interface Job {
  id: string
  status: 'pending' | 'blueprint' | 'generating' | 'extracting' | 'ready' | 'error'
  created_at: number
  blueprint?: Blueprint
  stereo_url?: string
  stereo_task_id?: string
  error?: string
  prompt: string
  title?: string          // User-provided or AI-generated title
  user_lyrics?: string    // User lyrics/notes
  thumbnail_seed?: number // Deterministic color seed for thumbnail gradient
  image_url?: string      // Pollinations.ai generated cover art URL
  stem_jobs?: StemJob[]   // Stem extraction results keyed by mode
}

interface Blueprint {
  bpm: number
  key: string
  scale: string
  genre: string
  mood: string
  energy: string
  duration_seconds: number
  instruments: Instrument[]
  arrangement: string
  style_prompt: string
  sections: string[]
}

interface Instrument {
  name: string
  family: string
  role: string
  track_type: string
}


// ═══════════════════════════════════════════════════════════════
//  STEP 1 — OPENAI BLUEPRINT GENERATION
// ═══════════════════════════════════════════════════════════════

function makeJobId(): string {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

const ALL_KEYS = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']
function pickRandomKey(): string {
  return ALL_KEYS[Math.floor(Math.random() * ALL_KEYS.length)]
}

async function generateBlueprint(prompt: string, apiKey: string, titleHint?: string, userPlan?: string, userDurationSec?: number, explicitGenre?: string): Promise<Blueprint & { suggested_title?: string }> {
  const suggestedKey = pickRandomKey()

  // Use explicit genre if provided (from style chip / gen-style input), otherwise
  // fall back to extracting the first word/phrase from the prompt
  const genreMatch = prompt.match(/^([^.,]+?)[.,]/)
  const detectedGenre = explicitGenre?.trim() || (genreMatch ? genreMatch[1].trim() : '')

  const systemPrompt = `You are a professional music producer AI that creates beat blueprints.
You STRICTLY follow the user's genre, mood, and style — you NEVER substitute or drift.

ABSOLUTE RULES — violating any rule is a failure:
1. GENRE LOCK: The genre field MUST exactly match whatever genre/style the user wrote. If user says "hip hop" → genre = "hip hop". If user says "pop" → genre = "pop". If user says "drill" → genre = "drill". NEVER change it to jazz, R&B, soul, or anything else unless that is what the user wrote.
2. SOUND AUTHENTICITY: The entire blueprint — BPM, instruments, mood, style_prompt — MUST sound like the stated genre. Hip hop = punchy 808s + trap hi-hats + sampled chops or piano. Pop = bright synths + 4-on-floor kick + catchy lead. Drill = sliding 808s + rolling hi-hats + dark piano. R&B = silky pads + soft kit + groove. NEVER add jazz piano, walking bass, brushed snares, ride cymbal, swing feel, or laid-back jazz elements to hip hop, trap, drill, or R&B unless the user explicitly asked for jazz.
3. ANTI-JAZZ RULE FOR HIP HOP/TRAP/DRILL: These genres must use 808 bass (NOT walking bass), punchy kicks (NOT brush kit), trap hi-hats or boom bap snares (NOT ride cymbal), and straight or swung hip hop timing (NOT jazz swing). Any jazz reference in a hip hop/trap/drill beat is an automatic failure.
4. NO TRUMPET / SAXOPHONE IN HIP HOP/TRAP/DRILL/R&B UNLESS USER ASKED: Do NOT include trumpet, saxophone, trombone, flugelhorn, cornet, or any brass/woodwind jazz instrument in hip hop, trap, drill, or R&B beats. These genres NEVER use those instruments unless the user explicitly wrote "jazz" or "trumpet" or "sax" in their prompt. This rule overrides all other defaults.
5. BPM ACCURACY: Hip hop = 85–100 BPM. Trap = 130–145 BPM. Drill = 140–145 BPM. Pop = 100–128 BPM. R&B = 65–95 BPM. Lo-fi = 70–90 BPM. Afrobeats = 100–115 BPM. Always use the correct BPM range for the genre.
6. KEY VARIETY: Use the suggested_key provided. Never default to C minor every time.
7. TITLE: If user left title blank, create a 2–4 word creative track name that fits the genre.
8. style_prompt: MUST open with the exact genre name, then describe sound in detail (energy, instruments, feel). Max 200 chars. For hip hop/trap/drill, the style_prompt MUST contain "808" or "trap" elements — never "jazz", "swing", "walking bass", "ride cymbal", "trumpet", or "saxophone".
9. DURATION: ${userDurationSec ? `The user has requested a specific duration of approximately ${userDurationSec} seconds (${Math.floor(userDurationSec/60)}:${String(userDurationSec%60).padStart(2,'0')}). The duration_seconds field MUST be exactly ${userDurationSec}. Do not deviate from this value.` : 'All beats MUST be exactly 240 seconds (4:00) unless user specifies a different duration. Do not deviate.'}
Output valid JSON only — no markdown, no explanation.`

  const userPrompt = `Generate a beat blueprint for: "${prompt}"
${titleHint ? `Track title provided by user: "${titleHint}"` : 'No title given — create a creative genre-fitting title in suggested_title.'}
Suggested key: ${suggestedKey}

GENRE DETECTED FROM INPUT: "${detectedGenre || 'use whatever genre the user specified in the prompt above'}"
→ The entire blueprint MUST sound like this genre. Do not drift.

Genre-to-sound mapping examples (follow these exactly for the detected genre):
- "hip hop" → BPM 85–100, 808 bass, punchy kick, snappy snare, trap hi-hats, sampled chops or Rhodes, aggressive/confident mood. NO trumpet, NO saxophone, NO brass.
- "trap" → BPM 130–145, sliding 808s, rapid triplet hi-hats, heavy kick, dark melody, energy=high. NO trumpet, NO saxophone, NO brass.
- "drill" → BPM 140–145, sliding 808 glide, rolling hi-hats, dark minor piano, cold/menacing mood. NO trumpet, NO saxophone, NO brass.
- "pop" → BPM 100–128, bright lead synth, 4-on-the-floor kick, punchy snare, catchy melodic hook, energy=high
- "R&B" → BPM 65–95, silky pad, soft snare, soulful chords, intimate/smooth mood. NO trumpet, NO saxophone unless user asked.
- "lo-fi" → BPM 70–90, mellow piano, dusty vinyl crackle, boom-bap kit, nostalgic/chill mood
- "afrobeats" → BPM 100–115, talking drum pattern, afrobeats percussion, melodic guitar, energetic
- "soca" → BPM 120–145, driving soca rhythm, brass stabs, bouncy percussion, carnival energy, uplifting
- "dancehall" → BPM 90–110, riddim pattern, heavy bass, skank guitar chops, energetic/danceable
- "reggaeton" → BPM 95–105, dembow rhythm, heavy bass, perreo energy
- "jazz" → BPM 90–140, swing feel, walking bass, ride cymbal, trumpet, saxophone, chord voicings
- "cinematic" → BPM 60–100, orchestral strings, dramatic brass, epic pads, swelling dynamics

Return ONLY this JSON:
{
  "bpm": <correct BPM for the genre>,
  "key": <${suggestedKey} unless user specified otherwise>,
  "scale": <choose based on genre mood — hip hop/trap/drill = minor, pop = major, R&B = minor/major pentatonic>,
  "genre": <EXACT genre string from user input — do not change>,
  "mood": <specific mood word matching the genre e.g. "aggressive", "smooth", "dark", "uplifting">,
  "energy": <"low" | "medium" | "high">,
  "duration_seconds": <${userDurationSec ? userDurationSec : '240'}>,  // default is always 240 (4:00) unless user specified otherwise
  "sections": ["intro", "verse", "hook", "verse", "hook", "outro"],
  "arrangement": <one sentence describing how this genre sounds — be specific to the genre>,
  "suggested_title": <2–4 word track name that fits the genre, e.g. "Drip Season", "Gold Rush Pop", "Night Shift Trap">,
  "style_prompt": <MUST start with exact genre name, then describe sound: instruments, energy, feel. Example: "hip hop beat, punchy 808 bass, trap hi-hats, sampled Rhodes chops, aggressive energy, dark mood" — max 200 chars>,
  "instruments": [
    {
      "name": <genre-appropriate instrument name>,
      "family": <"drums" | "bass" | "keys" | "guitar" | "strings" | "brass" | "woodwind" | "synth" | "fx">,
      "role": <"rhythmic" | "harmonic" | "melodic" | "textural" | "transitional">,
      "track_type": <"vocals" | "accompaniment" | "bass" | "drums">
    }
  ]
}

Instrument rules:
- 6–10 instruments, always include kick + snare/hi-hats + bass at minimum
- All instruments MUST be genre-appropriate (no jazz brushes in hip hop, no 808s in jazz, no grand piano in drill unless specified)
- NAMING: instrument "name" MUST be the EXACT specific instrument name — e.g. "Trumpet" NOT "brass", "Flute" NOT "woodwind", "Violin" NOT "strings", "Rhodes Piano" NOT "keys", "808 Bass" NOT "bass", "Acoustic Guitar" NOT "guitar". Be as specific as possible.
- track_type: kick/snare/hats → "drums", 808/bass → "bass", keys/guitar/pad/strings → "accompaniment", fx/vox → "vocals"`

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.85,
      max_tokens: 1200,
      response_format: { type: 'json_object' }
    })
  })

  if (!res.ok) {
    const err = await res.json() as any
    throw new Error(`OpenAI error: ${err?.error?.message || res.status}`)
  }

  const data = await res.json() as any
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI returned empty response')

  try {
    return JSON.parse(content) as Blueprint
  } catch {
    throw new Error('OpenAI returned invalid JSON')
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2 — MUSICAPI PRODUCER INSTRUMENTAL GENERATION
//  Uses Producer (Google Lyria 3 Pro) endpoint — clean instrumentals,
//  no vocal bleed, guaranteed instrumental output.
// ═══════════════════════════════════════════════════════════════

async function startInstrumentalGeneration(blueprint: Blueprint, apiKey: string, vocalGender?: string, userDurationSec?: number): Promise<string> {
  let stylePrompt = blueprint.style_prompt || ''

  // Strip vocal references — Producer is strictly instrumental
  stylePrompt = stylePrompt
    .replace(/\bwith vocals?\b/gi, '')
    .replace(/\bvocal chops?\b/gi, '')
    .replace(/\bchops?\b/gi, '')
    .replace(/\bsinging\b/gi, '')
    .replace(/\blyrics\b/gi, '')
    .trim()
  if (!stylePrompt.includes('no vocals')) {
    stylePrompt = stylePrompt.replace(/,?\s*$/, '') + ', no vocals, purely instrumental'
  }

  // Anti-jazz for hip-hop family
  const genreLower = (blueprint.genre || '').toLowerCase()
  const isHipHopFamily = /hip.?hop|trap|drill|r.?b|rnb|rap|boom.?bap|grime/.test(genreLower)
  if (isHipHopFamily && !/(jazz|trumpet|sax|brass)/.test(stylePrompt.toLowerCase())) {
    stylePrompt = stylePrompt.replace(/,?\s*$/, '') +
      ', no trumpet, no saxophone, no jazz, no brass winds, no swing'
  }

  const durationSec = userDurationSec || blueprint.duration_seconds || 240

  // Build request body for Producer (Lyria 3 Pro)
  const body: Record<string, any> = {
    sound: stylePrompt.slice(0, 400),
    // Producer accepts duration in seconds
    duration: durationSec
  }

  const res = await fetch(`${MUSICAPI_PRODUCER}/create`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    if (res.status === 429 || res.status === 503 || String(err?.message || err?.error || '').toLowerCase().includes('concurrent')) {
      throw new Error('SERVER_BUSY: Our beat generation server is currently at capacity. Please try again in 30–60 seconds.')
    }
    throw new Error(`Stemforge generation error: ${err?.message || err?.error || res.status}`)
  }

  const data = await res.json() as any
  // Producer returns { task_id: "..." } or { data: { task_id: "..." } }
  const taskId = data.task_id || data.data?.task_id
  if (!taskId) throw new Error(`Stemforge returned no task ID: ${JSON.stringify(data).slice(0, 200)}`)
  return taskId as string
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2b — MUSICAPI SONIC SONG GENERATION (with user lyrics)
//  Uses Sonic (Suno v5.5-compatible) endpoint — supports lyrics
// ═══════════════════════════════════════════════════════════════

async function startSongGeneration(blueprint: Blueprint, apiKey: string, userLyrics: string, vocalGender?: string, userDurationSec?: number): Promise<string> {
  const durationSec = userDurationSec || blueprint.duration_seconds || 240

  // Build style/tags from blueprint — clean of instrumental-only descriptors
  let stylePrompt = (blueprint.style_prompt || '')
    .replace(/\bno vocals?\b/gi, '')
    .replace(/\bpurely instrumental\b/gi, '')
    .replace(/\bno vocal chops?\b/gi, '')
    .replace(/\binstrumental only\b/gi, '')
    .trim()
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/, '')
  if (vocalGender && vocalGender !== 'off') {
    stylePrompt = stylePrompt.replace(/,?\s*$/, '') + `, ${vocalGender} vocalist`
  }

  // If user provided real custom lyrics → custom_mode=true (prompt = their lyrics)
  // If no custom lyrics (AI scaffold '[Verse]\n[Chorus]') → custom_mode=false so Sonic
  // auto-generates lyrics from the style prompt instead of singing placeholder text
  const hasCustomLyrics = userLyrics && userLyrics !== '[Verse]\n[Chorus]' && userLyrics.trim().length > 10
  const body: Record<string, any> = hasCustomLyrics
    ? {
        custom_mode: true,
        tags: stylePrompt.slice(0, 200),
        prompt: userLyrics,
        duration: durationSec,
        mv: 'sonic-v5'
      }
    : {
        custom_mode: false,
        gpt_description_prompt: `${stylePrompt.slice(0, 200)}. Generate a song with vocals, verse and chorus structure.`,
        duration: durationSec,
        mv: 'sonic-v5'
      }

  const res = await fetch(`${MUSICAPI_SONIC}/create`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    if (res.status === 429 || res.status === 503 || String(err?.message || err?.error || '').toLowerCase().includes('concurrent')) {
      throw new Error('SERVER_BUSY: Our beat generation server is currently at capacity. Please try again in 30–60 seconds.')
    }
    throw new Error(`Stemforge error: ${err?.message || err?.error || res.status}`)
  }

  const data = await res.json() as any
  // Sonic returns { data: [{ id, state, ... }] } or { task_id }
  const taskId = data.task_id || data.data?.[0]?.id
  if (!taskId) throw new Error(`Stemforge returned no task ID: ${JSON.stringify(data).slice(0, 200)}`)
  return taskId as string
}

// Step 1+2: called once from POST /api/generate (fast — GPT + MusicAPI kick-off only)
async function startPipeline(jobId: string, env: Bindings, userPlan?: string, userDurationSec?: number, userLyrics?: string, explicitGenre?: string) {
  const db = env.DB
  let job = await getJob(db, jobId)
  if (!job) return

  try {
    // Step 1 — GPT blueprint (~2-3 s)
    job.status = 'blueprint'
    await setJob(db, { ...job })

    const userTitle = (job as any).title as string | undefined
    const blueprint = await generateBlueprint(job.prompt, env.OPENAI_API_KEY, userTitle, userPlan, userDurationSec, explicitGenre || (job as any).genre)

    // Auto-name the track if user left title blank
    if (!userTitle && (blueprint as any).suggested_title) {
      (job as any).title = (blueprint as any).suggested_title
    }

    // Generate deterministic thumbnail seed from job id
    job.thumbnail_seed = job.thumbnail_seed || (job.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360)

    job.blueprint = blueprint

    // Step 2 — kick off MusicAPI (instant — just submits the job)
    job.status = 'generating'
    await setJob(db, { ...job })

    // If user provided lyrics → route to MusicAPI Sonic (supports lyrics)
    // Otherwise → MusicAPI Producer (clean instrumental, Lyria 3 Pro)
    let stereoTaskId: string
    if (userLyrics) {
      stereoTaskId = await startSongGeneration(blueprint, env.MUSICAPI_KEY, userLyrics, (job as any).vocal_gender, userDurationSec)
      ;(job as any).extend_task_type = 'song_generate'  // tells advancePipeline to use Sonic task poll
    } else {
      stereoTaskId = await startInstrumentalGeneration(blueprint, env.MUSICAPI_KEY, (job as any).vocal_gender, userDurationSec)
    }

    job.stereo_task_id = stereoTaskId
    await setJob(db, { ...job })

  } catch (err: any) {
    job.status = 'error'
    const msg = err?.message || 'Pipeline start error'
    // Tag server-busy errors so the frontend can show a retry button instead of a hard fail
    job.error = msg.startsWith('SERVER_BUSY:') ? msg : msg
    ;(job as any).server_busy = msg.startsWith('SERVER_BUSY:')
    await setJob(db, { ...job })
    // Log capacity errors to DB for admin visibility
    if (msg.startsWith('SERVER_BUSY:') && db) {
      try {
        await db.prepare(`INSERT INTO api_errors (error_type, user_id, created_at) VALUES (?, ?, ?)`)
          .bind('musicapi_busy', (job as any).user_id || null, Date.now()).run()
      } catch { /* table may not exist on very first deploy — swallow */ }
    }
  }
}

// ── MusicAPI polling helpers ──────────────────────────────────────────────────
// Poll MusicAPI Producer task/:taskId — used for instrumental generation (beat creation)
// Returns { url1, url2, clipId1, clipId2 } when both clips ready, or null if still running
async function pollInstrumentalStatus(taskId: string, apiKey: string): Promise<{ url1: string; url2: string | null; clipId1: string | null; clipId2: string | null } | null> {
  const res = await fetch(`${MUSICAPI_PRODUCER}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  })
  const txt = await res.text()
  // 202 = still processing (not_ready) — normal, return null to retry
  if (res.status === 202) return null
  if (!res.ok) {
    // 500 with type=failed means the task itself failed upstream (credits refunded)
    try {
      const errData = JSON.parse(txt)
      if (errData.type === 'failed') throw new Error(errData.error || 'Stemforge generation failed')
    } catch (parseErr: any) {
      if (parseErr.message !== 'Stemforge generation failed' && !parseErr.message?.startsWith('MusicAPI')) {
        // JSON parse error — not a known failure shape, treat as not-ready
        return null
      }
      throw parseErr
    }
    return null
  }
  let data: any
  try { data = JSON.parse(txt) } catch { return null }
  // Producer returns { code: 200, data: [{ clip_id, audio_url, state, ... }, ...] }
  const clips = Array.isArray(data) ? data : (data.data || [])
  if (!clips.length) return null
  // Check all clips — if any still pending/running, not ready yet
  const allDone = clips.every((c: any) => c.state === 'succeeded' || c.state === 'failed')
  if (!allDone) return null
  if (clips.every((c: any) => c.state === 'failed')) throw new Error(clips[0]?.error || 'Stemforge instrumental generation failed')
  const clip1 = clips.find((c: any) => c.state === 'succeeded')
  if (!clip1) return null
  const clip2 = clips.find((c: any, i: number) => c.state === 'succeeded' && i !== clips.indexOf(clip1)) || null
  return {
    url1: clip1.audio_url || clip1.wav_url,
    url2: clip2 ? (clip2.audio_url || clip2.wav_url) : null,
    clipId1: clip1.clip_id || clip1.id || null,
    clipId2: clip2 ? (clip2.clip_id || clip2.id || null) : null
  }
}

// Poll MusicAPI Sonic task/:taskId — used for song extend results
// Returns { url, durationMs, clipId } or null if still running
async function pollSongExtendStatus(taskId: string, apiKey: string): Promise<{ url: string; urlAlt?: string; durationMs: number; clipId: string } | null> {
  const res = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  })
  if (!res.ok) return null
  const data = await res.json() as any
  const clips = Array.isArray(data) ? data : (data.data || [])
  if (!clips.length) return null
  const clip = clips[0]
  if (clip.state === 'succeeded') {
    const url = clip.audio_url || null
    if (!url) return null
    // MusicAPI returns duration in seconds — convert to ms; fall back to 0
    const durationMs: number = typeof clip.duration === 'number' ? Math.round(clip.duration * 1000) : 0
    const clipId: string = clip.id || clip.clip_id || ''
    // Sonic often returns 2 clip variations — capture alt if present and succeeded
    const clip2 = clips[1]
    const urlAlt: string | undefined = (clip2 && clip2.state === 'succeeded' && clip2.audio_url) ? clip2.audio_url : undefined
    return { url, urlAlt, durationMs, clipId }
  }
  if (clip.state === 'failed') throw new Error(clip.error || 'Stemforge extend failed')
  return null // still processing
}

// Step 2b+3: called on each POST /api/poll/:id from the frontend.
// Stems are NEVER auto-generated on beat creation (all plans).
// For song_extend jobs with chain_target_ms set, automatically chains multiple
// Mureka extend calls until total duration reaches the target.

// ── Song extend chain helper ───────────────────────────────────────────────────
// Fires the next MusicAPI extend call using the clip_id from previous step.
// Returns taskId on success, throws on failure.
// MusicAPI Sonic: use continue_clip_id — no re-upload needed.
// Vocal extends → Sonic; Instrumental extends → Producer (Lyria 3 Pro)
async function fireNextChainExtend(
  currentUrl: string,
  currentDurationMs: number,
  job: any,
  env: Bindings,
  clipId?: string
): Promise<string> {
  const isInstrumental = job.make_instrumental === true

  if (isInstrumental) {
    // ── Producer (Lyria 3 Pro) instrumental extend ──────────────────────────
    // Requires clip_id from previous step — use job.chain_clip_id
    const sourceClipId = clipId || job.chain_clip_id
    if (!sourceClipId) throw new Error('Chain extend (instrumental): no clip_id available')

    const styleSound = job.chain_style
      ? `${job.chain_style}, instrumental, no vocals`
      : 'instrumental continuation, no vocals'

    const extBody: Record<string, any> = {
      task_type: 'extend_music',
      clip_id: sourceClipId,
      sound: styleSound
      // lyrics intentionally omitted → instrumental
    }

    const extRes = await fetch(`${MUSICAPI_PRODUCER}/create`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(extBody)
    })
    if (!extRes.ok) {
      const t = await extRes.text()
      let msg = `${extRes.status}`
      try { msg = (JSON.parse(t) as any)?.error || msg } catch (_) {}
      throw new Error(`Chain extend (instrumental) failed: ${msg}`)
    }
    const extData = await extRes.json() as any
    const taskId = extData.task_id || extData.id
    if (!taskId) throw new Error(`Chain extend (instrumental) returned no task ID: ${JSON.stringify(extData).slice(0, 200)}`)
    return taskId

  } else {
    // ── Sonic (Suno-compatible) vocal extend ────────────────────────────────
    // Use continue_clip_id if available; fall back to upload-extend from URL
    const sourceclipId = clipId || job.chain_clip_id

    const chainLyrics = job.chain_lyrics && job.chain_lyrics.trim()
    const hasCustomLyrics = chainLyrics && chainLyrics !== '[Verse]' && chainLyrics !== '[Instrumental]'

    if (sourceclipId) {
      // Fast path — pass clip_id directly, no upload
      // custom_mode is REQUIRED for extend_music (MusicAPI docs)
      const extBody: Record<string, any> = {
        task_type: 'extend_music',
        continue_clip_id: sourceclipId,
        mv: 'sonic-v5',
        custom_mode: false  // required field; set true below if custom lyrics present
      }
      if (hasCustomLyrics) { extBody.custom_mode = true; extBody.prompt = chainLyrics }
      if (job.chain_style) extBody.tags = job.chain_style

      const extRes = await fetch(`${MUSICAPI_SONIC}/create`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(extBody)
      })
      if (!extRes.ok) {
        const t = await extRes.text()
        let msg = `${extRes.status}`
        try { msg = (JSON.parse(t) as any)?.error || msg } catch (_) {}
        throw new Error(`Chain extend (vocal) failed: ${msg}`)
      }
      const extData = await extRes.json() as any
      const taskId = extData.task_id || extData.id
      if (!taskId) throw new Error(`Chain extend (vocal) returned no task ID: ${JSON.stringify(extData).slice(0, 200)}`)
      return taskId
    } else {
      // Fallback — upload audio URL then extend
      const uploadBody = { url: currentUrl }   // MusicAPI /sonic/upload expects "url"
      const uploadRes = await fetch(`${MUSICAPI_SONIC}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadBody)
      })
      if (!uploadRes.ok) {
        const t = await uploadRes.text()
        throw new Error(`Chain upload failed: ${uploadRes.status} ${t.slice(0, 200)}`)
      }
      const uploadData = await uploadRes.json() as any
      const uploadTaskId = uploadData.task_id || uploadData.id
      if (!uploadTaskId) throw new Error('Chain upload returned no task ID')
      // Poll upload completion (typically fast)
      let uploadedClipId = ''
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const pollRes = await fetch(`${MUSICAPI_SONIC}/task/${uploadTaskId}`, {
          headers: { 'Authorization': `Bearer ${env.MUSICAPI_KEY}` }
        })
        if (pollRes.ok) {
          const pd = await pollRes.json() as any
          const clips = Array.isArray(pd) ? pd : (pd.data || [])
          if (clips[0]?.state === 'succeeded') { uploadedClipId = clips[0].id || clips[0].clip_id || ''; break }
          if (clips[0]?.state === 'failed') throw new Error('Chain upload task failed')
        }
      }
      if (!uploadedClipId) throw new Error('Chain upload timed out')

      // custom_mode is REQUIRED for extend_music (MusicAPI docs)
      const extBody: Record<string, any> = {
        task_type: 'extend_music',
        continue_clip_id: uploadedClipId,
        mv: 'sonic-v5',
        custom_mode: false  // required field; set true below if custom lyrics present
      }
      if (hasCustomLyrics) { extBody.custom_mode = true; extBody.prompt = chainLyrics }
      if (job.chain_style) extBody.tags = job.chain_style

      const extRes = await fetch(`${MUSICAPI_SONIC}/create`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(extBody)
      })
      if (!extRes.ok) {
        const t = await extRes.text()
        let msg = `${extRes.status}`
        try { msg = (JSON.parse(t) as any)?.error || msg } catch (_) {}
        throw new Error(`Chain extend (vocal fallback) failed: ${msg}`)
      }
      const extData = await extRes.json() as any
      const taskId = extData.task_id || extData.id
      if (!taskId) throw new Error(`Chain extend (vocal fallback) returned no task ID`)
      return taskId
    }
  }
}

async function advancePipeline(jobId: string, env: Bindings, skipStems = true): Promise<Job | null> {
  const db = env.DB
  let job = await getJob(db, jobId)
  if (!job) return null

  // Only advance jobs that are waiting on MusicAPI
  if (job.status !== 'generating' || !job.stereo_task_id) return job

  try {
    // Route polling based on task type:
    // - song_extend and song_generate use MusicAPI Sonic task endpoint
    // - Producer (instrumental) + remix use Producer task endpoint (no extend_task_type)
    const taskType = (job as any).extend_task_type
    const useSongQuery = taskType === 'song_extend' || taskType === 'song_generate'

    if (!useSongQuery) {
      // Instrumental path — Producer generates 2 clips, we save both
      const result = await pollInstrumentalStatus(job.stereo_task_id, env.MUSICAPI_KEY)
      if (!result) {
        const ageMs = Date.now() - job.created_at
        if (ageMs > 10 * 60 * 1000) {
          job.status = 'error'
          job.error = 'Stemforge generation timed out after 10 minutes'
          await setJob(db, { ...job })
        }
        return job
      }
      job.stereo_url = result.url1
      ;(job as any).stereo_url_alt = result.url2   // second clip from Producer
      ;(job as any).clip_id = result.clipId1
      ;(job as any).clip_id_alt = result.clipId2
      job.status = 'ready'
      await setJob(db, { ...job })
      // ── Persist audio to R2 immediately so URL never expires ──────────────
      if (env.IMAGES && result.url1 && env.SITE_URL) {
        // fire-and-forget inside waitUntil-compatible context
        persistAudioToR2(result.url1, jobId, env.IMAGES, db, env.SITE_URL)
          .catch((e: any) => console.warn('[R2 persist/instrumental] error:', e?.message))
      }
      return job
    }

    // ── Song query path (song_extend / song_generate) ──────────────────────────
    const result = await pollSongExtendStatus(job.stereo_task_id, env.MUSICAPI_KEY)

    if (!result) {
      // Not ready yet — check timeout (15 min max for chained extends)
      const ageMs = Date.now() - job.created_at
      const timeoutMs = (job as any).chain_target_ms ? 15 * 60 * 1000 : 10 * 60 * 1000
      if (ageMs > timeoutMs) {
        job.status = 'error'
        job.error = 'Stemforge generation timed out'
        await setJob(db, { ...job })
      }
      return job
    }

    const { url: stereoUrl, urlAlt: stereoUrlAlt, durationMs: resultDurationMs, clipId: resultClipId } = result

    // ── Chain extend logic ─────────────────────────────────────────────────────
    // chain_target_ms: target total output duration in ms (set at job creation)
    // chain_step: how many extend calls have completed so far (0-indexed)
    // chain_max_steps: safety cap (default 15)
    const chainTargetMs: number = (job as any).chain_target_ms || 0
    const chainStep: number = (job as any).chain_step || 0
    const chainMaxSteps: number = (job as any).chain_max_steps || 15

    // Determine current track duration: prefer the MusicAPI-reported duration
    // If MusicAPI didn't report duration (= 0), use last known
    const currentDurationMs = resultDurationMs > 0
      ? resultDurationMs
      : ((job as any).chain_last_duration_ms || 0)

    const shouldChain = chainTargetMs > 0
      && currentDurationMs > 0
      && currentDurationMs < chainTargetMs
      && chainStep < chainMaxSteps

    if (shouldChain) {
      // Fire the next extend call — pass clip_id for efficient chaining
      console.log(`[chain-extend] step=${chainStep + 1} currentDuration=${currentDurationMs}ms target=${chainTargetMs}ms jobId=${jobId}`)
      try {
        const nextTaskId = await fireNextChainExtend(stereoUrl, currentDurationMs, job as any, env, resultClipId)
        // Update job: new task ID, increment step, save last known duration + clipId
        const updatedJob = {
          ...(job as any),
          stereo_task_id: nextTaskId,
          stereo_url: null, // will be populated when next step completes
          chain_step: chainStep + 1,
          chain_last_duration_ms: currentDurationMs,
          chain_clip_id: resultClipId, // pass clip_id to next chain step
          // Keep status as 'generating' so polling continues
          status: 'generating'
        }
        await setJob(db, updatedJob)
        return updatedJob as unknown as Job
      } catch (chainErr: any) {
        // If chaining fails, mark ready with what we have so far (don't lose the output)
        console.error(`[chain-extend] step=${chainStep + 1} failed: ${chainErr?.message}`)
        job.stereo_url = stereoUrl
        ;(job as any).chain_error = chainErr?.message
        job.status = 'ready'
        await setJob(db, { ...job })
        // Still persist what we have to R2
        if (env.IMAGES && stereoUrl && env.SITE_URL) {
          persistAudioToR2(stereoUrl, jobId, env.IMAGES, db, env.SITE_URL)
            .catch((e: any) => console.warn('[R2 persist/chain-err] error:', e?.message))
        }
        return job
      }
    }

    // ── No more chaining needed — job is complete ─────────────────────────────
    // Do NOT pre-populate image_url here with a pollinations URL.
    // Cover art is generated on-demand by /api/cover-image/:jobId.
    job.stereo_url = stereoUrl
    // Sonic returns 2 clip variations — surface the alt for remix/cover jobs
    if (stereoUrlAlt) (job as any).stereo_url_alt = stereoUrlAlt
    // Save clip_id from Sonic so stems can skip the /sonic/upload call entirely
    // (mirrors the Producer path at line ~1098; without this, stems always fell back to upload)
    if (resultClipId) (job as any).clip_id = resultClipId
    if (resultDurationMs > 0) {
      (job as any).chain_final_duration_ms = resultDurationMs
    }
    job.status = 'ready'
    await setJob(db, { ...job })
    // ── Persist audio to R2 immediately so URL never expires ──────────────────
    if (env.IMAGES && stereoUrl && env.SITE_URL) {
      persistAudioToR2(stereoUrl, jobId, env.IMAGES, db, env.SITE_URL)
        .catch((e: any) => console.warn('[R2 persist/sonic] error:', e?.message))
    }

  } catch (err: any) {
    job.status = 'error'
    job.error = err?.message || 'Pipeline advance error'
    await setJob(db, { ...job })
  }

  return job
}

// ── ZIP parser for Mureka stem results ───────────────────────────────────────
// Mureka /v1/song/stem returns a zip_url containing WAV files: vocals.wav, drums.wav, etc.
// This minimal parser reads only the ZIP central directory (tail of the file via Range request)
// to extract file names + offsets — NEVER downloads the full ZIP into memory.
// zip-entry: URL format: zip-entry:<zipUrl>|<localOff>|<compSize>|<fileName>|<compMethod>|<uncompSize>
async function parseZipStems(zipUrl: string): Promise<StemTrack[]> {
  // Step 1: fetch the last 65536 bytes — enough to contain EOCD + central directory
  // for any typical stem ZIP (4-8 files × ~200 bytes each)
  const tailSize = 65536
  const headRes = await fetch(zipUrl, { method: 'HEAD' })
  const contentLength = headRes.ok ? parseInt(headRes.headers.get('content-length') || '0', 10) : 0

  if (!contentLength || contentLength <= 0) {
    // CDN didn't return content-length — cannot safely range-fetch without risking
    // downloading the entire ZIP into Worker memory (128MB limit exceeded on large stems).
    // Retry the HEAD with a different approach: try a small range to probe.
    const probeRes = await fetch(zipUrl, { headers: { 'Range': 'bytes=0-1' } })
    if (probeRes.status === 206) {
      // Range-request supported — fetch the tail
      const rangeForSize = await fetch(zipUrl, { headers: { 'Range': `bytes=0-0` } })
      const cr = rangeForSize.headers.get('content-range') // "bytes 0-0/12345"
      const total = cr ? parseInt(cr.split('/')[1], 10) : 0
      if (!total) throw new Error('ZIP size unknown — cannot parse stems (CDN did not return Content-Range)')
      const start2 = Math.max(0, total - tailSize)
      const rangeRes2 = await fetch(zipUrl, { headers: { 'Range': `bytes=${start2}-${total - 1}` } })
      if (!rangeRes2.ok && rangeRes2.status !== 206) throw new Error(`ZIP tail fetch failed: ${rangeRes2.status}`)
      const tailBuf2 = await rangeRes2.arrayBuffer()
      return parseZipTailBuffer(tailBuf2, total > tailSize ? total - tailSize : 0, zipUrl)
    }
    throw new Error('ZIP server does not support range requests — cannot parse stem ZIP safely')
  }

  const start = Math.max(0, contentLength - tailSize)
  const rangeRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${start}-${contentLength - 1}` } })
  if (!rangeRes.ok && rangeRes.status !== 206) throw new Error(`ZIP tail fetch failed: ${rangeRes.status}`)
  const tailBuf = await rangeRes.arrayBuffer()
  return parseZipTailBuffer(tailBuf, contentLength > tailSize ? contentLength - tailSize : 0, zipUrl)
}

// Parse ZIP central directory from a tail buffer — shared by both code paths in parseZipStems
function parseZipTailBuffer(tailBuf: ArrayBuffer, tailOffset: number, zipUrl = ''): StemTrack[] {
  const buf = new Uint8Array(tailBuf)
  const view = new DataView(tailBuf)
  const tracks: StemTrack[] = []

  // Find End of Central Directory record (signature 0x06054b50) scanning from end of tail
  let eocdLocal = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdLocal = i; break }
  }
  if (eocdLocal < 0) throw new Error('Not a valid ZIP file (EOCD not found in tail)')

  const cdAbsOffset = view.getUint32(eocdLocal + 16, true)   // absolute offset of central dir
  const cdCount     = view.getUint16(eocdLocal + 8, true)
  const cdLocalOff  = cdAbsOffset - tailOffset               // position within tailBuf

  if (cdLocalOff < 0) throw new Error('Central directory not in tail — ZIP too large for 64KB window')

  let pos = cdLocalOff
  for (let i = 0; i < cdCount; i++) {
    if (pos + 46 > buf.length) break
    if (view.getUint32(pos, true) !== 0x02014b50) break        // central dir signature
    const compMethod = view.getUint16(pos + 10, true)          // 0=store, 8=deflate
    const compSize  = view.getUint32(pos + 20, true)           // compressed size from CD entry
    const uncompSize= view.getUint32(pos + 24, true)           // uncompressed size
    const fnLen     = view.getUint16(pos + 28, true)
    const extraLen  = view.getUint16(pos + 30, true)
    const cmtLen    = view.getUint16(pos + 32, true)
    const localOff  = view.getUint32(pos + 42, true)           // absolute offset of local header
    const fnBytes   = buf.subarray(pos + 46, pos + 46 + fnLen)
    const fileName  = new TextDecoder().decode(fnBytes)
    pos += 46 + fnLen + extraLen + cmtLen

    // Extract stem name from filename (e.g. "vocals.wav" → "vocals")
    const base = fileName.split('/').pop() || fileName
    const stemName = base.replace(/\.(wav|mp3|flac|m4a)$/i, '').toLowerCase().replace(/\s+/g, '_')
    if (!stemName) continue

    // Skip full-mix stems — Mureka includes "song.wav" / "accompaniment.wav" in the ZIP but
    // these are the full stereo mix, not individual stems. Filter them out here so they
    // never reach the client. ("instrumental" is kept only for split_from_mix mode where
    // the caller explicitly requests it; filtering at the ZIP level is safe because the
    // split_from_mix branch re-aliases whatever stems arrive to vocals+instrumental.)
    const FULL_MIX_NAMES = ['song', 'mix', 'full_mix', 'accompaniment']
    if (FULL_MIX_NAMES.includes(stemName)) continue

    // Store localOff + compression method — proxy resolves exact data offset lazily
    // Format: zip-entry:<zipUrl>|<localOff>|<compSize>|<fileName>|<compMethod>|<uncompSize>
    const stemProxyUrl = `zip-entry:${zipUrl}|${localOff}|${compSize}|${fileName}|${compMethod}|${uncompSize}`
    tracks.push({ name: stemName, url: stemProxyUrl })
  }

  return tracks
}

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/generate — start a new generation job
app.post('/api/generate', async (c) => {
  const { prompt, genre, bpm, vocal_space, energy, duration, user_duration, instruments_include, instruments_exclude, title, vocal_gender, lyrics, vocal_mode } = await c.req.json()

  if (!prompt && !genre) {
    return c.json({ error: 'prompt is required' }, 400)
  }

  // ── Auth + generation limit check ────────────────────────────
  // Login is REQUIRED — beats must always be tied to a user account so they appear in the library.
  // Anonymous generation is disabled: beats generated without a user_id are invisible in the library.
  if (!c.env.DB || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Service not configured', login_required: true }, 503)
  }
  const token = getSessionCookie(c.req.raw)
  if (!token) {
    return c.json({ error: 'You must be logged in to generate beats. Your library saves all your music.', login_required: true }, 401)
  }
  const authUser = await getSessionUser(c.env.DB, token)
  if (!authUser) {
    return c.json({ error: 'Session expired — please log in again to generate beats.', login_required: true }, 401)
  }

  // Enforce per-plan generation limit (bonus_credits consumed first)
  const totalAvailable20 = (authUser.gens_limit - authUser.gens_used) + authUser.bonus_credits
  if (totalAvailable20 < 20) {
    return c.json({
      error: `Points limit reached. You have used all your points for this month. Upgrade your plan or get more credits to continue.`,
      limit_reached: true
    }, 403)
  }

  const userId: string = authUser.id
  const userPlan: string = authUser.plan

  // Deduct 20 pts — consume bonus_credits first, then gens_used
  if (authUser.bonus_credits >= 20) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - 20 WHERE id = ?`).bind(authUser.id).run()
  } else if (authUser.bonus_credits > 0) {
    const fromBonus = authUser.bonus_credits
    const fromMain = 20 - fromBonus
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id = ?`).bind(fromMain, authUser.id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + 20 WHERE id = ?`).bind(authUser.id).run()
  }

  // Build enriched prompt from all UI inputs
  const parts: string[] = []
  if (prompt) parts.push(prompt)
  if (genre) parts.push(`genre: ${genre}`)
  if (bpm) parts.push(`${bpm} BPM`)
  if (vocal_space) parts.push(`vocal space: ${vocal_space}`)
  if (energy) parts.push(`energy: ${energy}`)
  if (instruments_include?.length) parts.push(`include: ${instruments_include.join(', ')}`)
  if (instruments_exclude?.length) parts.push(`exclude: ${instruments_exclude.join(', ')}`)
  // Vocal gender instruction — always instrumental; vocal gender only affects the hook/melody feel
  if (vocal_gender && vocal_gender !== 'off') {
    parts.push(`vocal style: ${vocal_gender} vocal feel in melodic elements`)
  }

  const fullPrompt = parts.join(', ')
  const jobId = makeJobId()

  const job: Job = {
    id: jobId,
    status: 'pending',
    created_at: Date.now(),
    prompt: fullPrompt,
    title: title || undefined,
    thumbnail_seed: Math.floor(Math.random() * 360)
  }
  // vocal_mode: 'write' = user wants vocals (Sonic endpoint), 'instrumental' = no vocals (Producer endpoint)
  // When write mode, we always use Sonic — pass user lyrics if provided, otherwise a vocal scaffold
  // so the AI generates vocals from scratch rather than defaulting to instrumental.
  const isVocalMode = vocal_mode === 'write'
  const customLyrics = lyrics?.trim() || ''
  // Lyrics to send to pipeline: user's own if provided, else a minimal scaffold for AI-generated vocals
  const lyricsForPipeline = isVocalMode
    ? (customLyrics || '[Verse]\n[Chorus]')
    : undefined

  // Store vocal_gender and lyrics as extended job properties
  ;(job as any).vocal_gender = vocal_gender || 'off'
  ;(job as any).vocal_mode = vocal_mode || 'instrumental'
  if (customLyrics) {
    ;(job as any).user_lyrics = customLyrics
  }
  await setJob(c.env.DB, job, userId)

  // Parse user_duration. If the user provided lyrics, auto-calculate duration from word count
  // (avg rap: ~130 words/min, avg pop: ~110 words/min — use 120 wpm as a safe middle ground)
  let userDurationSec: number | undefined
  if (customLyrics) {
    const wordCount = customLyrics.split(/\s+/).length
    const estimatedSec = Math.round((wordCount / 120) * 60)
    // Clamp to 60–300 s, round up to nearest 15 s so Mureka gets a clean number
    const clamped = Math.max(60, Math.min(300, estimatedSec))
    userDurationSec = Math.ceil(clamped / 15) * 15
  } else if (user_duration) {
    userDurationSec = Math.max(30, Math.min(300, parseInt(String(user_duration), 10) || 0)) || undefined
  }

  // Start pipeline in background: Step 1 (GPT blueprint) + Step 2 kick-off (MusicAPI submit)
  // Both are fast (~3-5 s total). The long MusicAPI wait is handled client-side via /api/poll/:id
  c.executionCtx.waitUntil(startPipeline(jobId, c.env, userPlan, userDurationSec, lyricsForPipeline, genre || undefined))

  return c.json({ job_id: jobId, status: 'pending' })
})

// POST /api/poll/:id — called by frontend every ~5s while status=generating
// Does one MusicAPI status check; sets job to ready with stereo only (stems on-demand).
// Returns the same shape as GET /api/job/:id.
app.post('/api/poll/:id', async (c) => {
  const id = c.req.param('id')
  const job = await advancePipeline(id, c.env) // always skipStems=true
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const chainStep: number = (job as any).chain_step || 0
  const chainTargetMs: number = (job as any).chain_target_ms || 0
  const chainLastDurMs: number = (job as any).chain_last_duration_ms || 0
  const chainFinalDurMs: number = (job as any).chain_final_duration_ms || 0

  return c.json({
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    prompt: job.prompt,
    title: (job as any).title || null,
    thumbnail_seed: job.thumbnail_seed || null,
    // Only return image_url if it's a permanent cached URL (/api/cover-art/*)
    // Pollinations / data: URLs are intentionally excluded — the client fetches
    // /api/cover-image/ which generates once, saves to R2+D1, and returns the real URL.
    image_url: (() => { const u = (job as any).image_url; return (u && u.includes('/api/cover-art/')) ? u : null })(),
    blueprint: job.blueprint ? {
      bpm: job.blueprint.bpm,
      key: job.blueprint.key,
      scale: job.blueprint.scale,
      genre: job.blueprint.genre,
      mood: job.blueprint.mood,
      duration_seconds: job.blueprint.duration_seconds,
      arrangement: job.blueprint.arrangement,
      instrument_count: job.blueprint.instruments?.length || 0,
      instruments: (job.blueprint.instruments || []).map((ins: any) => ({
        name: ins.name,
        family: ins.family
      })),
      style_prompt: job.blueprint.style_prompt
    } : null,
    stereo_url: job.stereo_url || null,
    stereo_url_alt: (job as any).stereo_url_alt || null,
    clip_id: (job as any).clip_id || null,
    clip_id_alt: (job as any).clip_id_alt || null,
    error: job.error || null,
    server_busy: (job as any).server_busy || false,
    // Chain extend progress fields (only present for song_extend jobs with chaining)
    chain_step: chainStep > 0 ? chainStep : undefined,
    chain_target_ms: chainTargetMs > 0 ? chainTargetMs : undefined,
    chain_current_duration_ms: chainFinalDurMs > 0 ? chainFinalDurMs : (chainLastDurMs > 0 ? chainLastDurMs : undefined)
  })
})

// GET /api/job/:id — poll job status
app.get('/api/job/:id', async (c) => {
  const id = c.req.param('id')
  const job = await getJob(c.env.DB, id)

  if (!job) return c.json({ error: 'Job not found' }, 404)

  return c.json({
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    prompt: job.prompt,
    title: (job as any).title || null,
    user_lyrics: (job as any).user_lyrics || null,
    thumbnail_seed: job.thumbnail_seed || null,
    // Only return image_url if it's a permanent cached URL (/api/cover-art/*)
    image_url: (() => { const u = (job as any).image_url; return (u && u.includes('/api/cover-art/')) ? u : null })(),
    blueprint: job.blueprint ? {
      bpm: job.blueprint.bpm,
      key: job.blueprint.key,
      scale: job.blueprint.scale,
      genre: job.blueprint.genre,
      mood: job.blueprint.mood,
      duration_seconds: job.blueprint.duration_seconds,
      arrangement: job.blueprint.arrangement,
      instrument_count: job.blueprint.instruments?.length || 0,
      instruments: (job.blueprint.instruments || []).map((ins: any) => ({
        name: typeof ins === 'object' ? ins.name : ins,
        family: typeof ins === 'object' ? ins.family : null
      })),
      instruments_include: Array.isArray((job.blueprint as any).instruments_include) ? (job.blueprint as any).instruments_include : [],
      style_prompt: job.blueprint.style_prompt
    } : null,
    extend_task_type: (job as any).extend_task_type || null,
    stereo_url: job.stereo_url || null,
    stereo_url_alt: (job as any).stereo_url_alt || null,
    clip_id: (job as any).clip_id || null,
    clip_id_alt: (job as any).clip_id_alt || null,
    error: job.error || null
  })
})

// GET /api/zip-proxy?url=... — server-side proxy to fetch ZIP files from CDN
// Needed to avoid CORS issues when browser fetches Mureka CDN ZIPs directly
app.get('/api/zip-proxy', async (c) => {
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url param required' }, 400)

  // Only allow https:// URLs to prevent SSRF against internal/local addresses
  let parsed: URL
  try { parsed = new URL(url) } catch { return c.json({ error: 'Invalid URL' }, 400) }
  if (parsed.protocol !== 'https:') return c.json({ error: 'Only https URLs allowed' }, 400)
  // Block internal/private addresses
  const h = parsed.hostname
  if (h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h.startsWith('10.') || h.endsWith('.local')) {
    return c.json({ error: 'URL not allowed' }, 403)
  }

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'StemForge/1.0' },
      // Cloudflare Workers: follow redirects by default
    })
    if (!upstream.ok) return c.json({ error: `Upstream ${upstream.status}: ${upstream.statusText}` }, upstream.status as any)
    const data = await upstream.arrayBuffer()
    return new Response(data, {
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/zip',
        'Content-Length': String(data.byteLength),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Proxy fetch failed' }, 502)
  }
})

// GET /api/health
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'StemForge' }))

// ═══════════════════════════════════════════════════════════════
//  STEM EXTRACTION API — Mureka /v1/song/stem (synchronous ZIP)
//  Two modes:
//    auto          → audio-separation-1  (5 stems: vocals, drums, bass, other, instrumental)
//    split_from_mix → audio-separation-3  (2 stems: vocals + instrumental)
//
//  Mureka returns zip_url SYNCHRONOUSLY — no polling needed.
//  We call it inside waitUntil() so the Worker returns immediately,
//  then the background task writes zip: to D1 when done.
//  Lifecycle: POST /api/job/stems → queues stemwait:, returns immediately
//             GET  /api/job/stems/:jobId → first poll fires Mureka call in waitUntil(),
//                                         subsequent polls parse ZIP + return stems
// ═══════════════════════════════════════════════════════════════

// POST /api/job/stems — start stem extraction
app.post('/api/job/stems', async (c) => {
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Stemforge stem service not configured' }, 500)
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  // Stem splitting is locked on the free plan — Creator and Pro Artist have access
  if (user.plan === 'free') {
    return c.json({ error: 'Stem splitting is a Pro Artist feature. Upgrade to unlock all split modes.', locked: true, upgrade: true }, 403)
  }

  const body = await c.req.json<{
    job_id: string
    mode: StemMode
  }>()

  const { job_id, mode } = body
  if (!job_id || !mode) return c.json({ error: 'job_id and mode required' }, 400)

  const job = await getJob(c.env.DB, job_id)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!job.stereo_url) return c.json({ error: 'Beat not ready yet — no audio URL' }, 400)

  // Check if we already have a completed stem job for this mode (cache hit)
  const existingStems = Array.isArray((job as any).stem_jobs) ? (job as any).stem_jobs as StemJob[] : []
  if (existingStems.length > 0) {
    const cached = existingStems.find((s: StemJob) => s.mode === mode && s.status === 'ready')
    if (cached) return c.json({ ok: true, cached: true, task_id: cached.task_id, stems: cached.stems, status: 'ready' })

    // ── GUARD: already pending/processing for this mode — don't charge again ──
    const inFlight = existingStems.find((s: StemJob) => s.mode === mode && (s.status === 'pending' || s.status === 'processing'))
    if (inFlight) {
      console.log(`[stems/mureka] Already in-flight for ${job_id} mode=${mode} — returning existing task_id without charging`)
      return c.json({ ok: true, cached: false, task_id: inFlight.task_id, status: inFlight.status })
    }
  }

  // Deduct credits: 5-stem = 75pts, 2-stem vocals+instrumental = 30pts
  const stemCost = mode === 'auto' ? 30 : 70
  const stemFreshUser = await c.env.DB.prepare(`SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id=?`).bind(user.id).first<{gens_used:number,gens_limit:number,bonus_credits:number}>()
  const stemBonus = stemFreshUser?.bonus_credits ?? 0
  const stemMain = stemFreshUser ? (stemFreshUser.gens_limit - stemFreshUser.gens_used) : 0
  if (!stemFreshUser || stemMain + stemBonus < stemCost) {
    return c.json({ error: `Not enough points. ${mode === 'auto' ? 'Auto Split costs 30 points' : 'Vocals & Instrumental costs 70 points'} and you only have ${Math.max(0, stemMain + stemBonus)} remaining.`, limit_reached: true }, 403)
  }
  if (stemBonus >= stemCost) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - ? WHERE id=?`).bind(stemCost, user.id).run()
  } else if (stemBonus > 0) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id=?`).bind(stemCost - stemBonus, user.id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + ? WHERE id=?`).bind(stemCost, user.id).run()
  }

  // Mureka /v1/song/stem returns zip_url SYNCHRONOUSLY (no polling needed).
  // We queue a "stemwait:" task_id and fire the actual Mureka call in waitUntil()
  // from the first GET poll. This keeps the POST response fast (< 50ms).

  const stemwaitTaskId = `stemwait:${mode}:${Date.now()}`

  console.log(`[stems/mureka] Queuing ${mode} for job=${job_id} url=${job.stereo_url?.slice(0,80)}...`)

  // Store pending stem job
  const stemJob: StemJob = {
    task_id: stemwaitTaskId,
    mode,
    status: 'pending',
    stems: [],
    created_at: Date.now()
  }
  const updatedJob = { ...job } as any
  if (!Array.isArray(updatedJob.stem_jobs)) updatedJob.stem_jobs = []
  // Remove any old pending/error for same mode
  updatedJob.stem_jobs = updatedJob.stem_jobs.filter((s: StemJob) => s.mode !== mode || s.status === 'ready')
  updatedJob.stem_jobs.push(stemJob)
  await setJob(c.env.DB, updatedJob)

  return c.json({ ok: true, cached: false, task_id: stemwaitTaskId, status: 'pending' })
})

// GET /api/job/stems/:jobId — poll stem extraction status
app.get('/api/job/stems/:jobId', async (c) => {
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Stemforge stem service not configured' }, 500)
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const mode = c.req.query('mode') as StemMode | undefined
  const taskId = c.req.query('task_id') || ''

  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const stemJobs = Array.isArray((job as any).stem_jobs) ? (job as any).stem_jobs as StemJob[] : []
  if (!stemJobs.length) return c.json({ status: 'not_started' })

  // Find stemJob: exact task_id match first, then fall back to mode-based lookup
  let stemJob: StemJob | undefined = taskId ? stemJobs.find(s => s.task_id === taskId) : undefined
  if (!stemJob) {
    // Derive mode from stemwait: task_id (e.g. "stemwait:auto:123")
    let lookupMode = mode
    if (taskId?.startsWith('stemwait:')) {
      lookupMode = (taskId.split(':')[1] as StemMode) || mode
    }
    stemJob = lookupMode ? stemJobs.find(s => s.mode === lookupMode) : stemJobs[0]
  }

  if (!stemJob) return c.json({ status: 'not_started' })

  // Already completed — return cached
  if (stemJob.status === 'ready') {
    return c.json({ status: 'ready', stems: stemJob.stems, task_id: stemJob.task_id })
  }
  if (stemJob.status === 'error') {
    return c.json({ status: 'error', error: stemJob.error })
  }

  // ── stemwait: → fire Mureka call via waitUntil() ──────────────────────────
  // On the FIRST poll (status=pending) we fire the Mureka /v1/song/stem call
  // in a background waitUntil() task.  Mureka is SYNCHRONOUS — it returns
  // zip_url directly — but may take 30-120s.  waitUntil() runs after we
  // send the response so the Worker responds in < 100ms.
  // The background task writes 'zip:<zipUrl>' to D1 when complete.
  // Subsequent polls find the zip: task_id and parse the ZIP on-demand.
  if (stemJob.task_id.startsWith('stemwait:')) {
    const stereoUrl = job.stereo_url
    if (!stereoUrl) {
      stemJob.status = 'error'
      stemJob.error = 'No audio URL found for this job'
      const updatedJob = { ...job } as any
      updatedJob.stem_jobs = stemJobs.map((s: StemJob) => s.task_id === stemJob!.task_id ? stemJob! : s)
      await setJob(c.env.DB, updatedJob)
      return c.json({ status: 'error', error: stemJob.error })
    }

    // If already processing, just report back — do NOT re-fire
    if (stemJob.status === 'processing') {
      return c.json({ status: 'processing', task_id: stemJob.task_id })
    }

    if (stemJob.status === 'pending') {
      // Transition to processing so concurrent polls don't double-fire
      stemJob.status = 'processing'
      const processingJob = { ...job } as any
      processingJob.stem_jobs = stemJobs.map((s: StemJob) => s.task_id === stemJob!.task_id ? stemJob! : s)
      await setJob(c.env.DB, processingJob)

      // Capture all values needed in closure
      const bgTaskId  = stemJob.task_id
      const bgJobId   = jobId
      const bgDb      = c.env.DB
      const bgKey     = c.env.MUREKA_API_KEY
      const bgUrl     = stereoUrl
      const bgMode    = stemJob.mode
      // If stereo_url is a self-hosted R2 proxy URL, resolve it to a public URL first
      // so Mureka can download it. Mureka needs a direct public URL.
      const bgImages  = c.env.IMAGES

      c.executionCtx.waitUntil((async () => {
        try {
          // ── Resolve audio URL for Mureka ──────────────────────────────────
          // If the URL is a self-referencing /api/extend-audio-proxy/ URL,
          // we need to get a real public URL. Options:
          //   A) Use the R2 public URL if configured
          //   B) Upload the bytes to Mureka directly (not supported — URL only)
          // For now, pass the URL directly; Mureka can fetch from stemforge.studio.
          let audioUrl = bgUrl

          // If the URL is relative or a proxy path, make it absolute
          if (audioUrl.startsWith('/')) {
            audioUrl = `https://stemforge.studio${audioUrl}`
          }

          // ── Call Mureka /v1/song/stem ─────────────────────────────────────
          // model: audio-separation-1 = 5 stems, audio-separation-3 = 2 stems
          const murekaModel = bgMode === 'split_from_mix' ? 'audio-separation-3' : 'audio-separation-1'
          console.log(`[stems/mureka/bg] Calling song/stem model=${murekaModel} url=${audioUrl.slice(0,80)} taskId=${bgTaskId}`)

          const murekaRes = await fetch(`${MUREKA_BASE}/song/stem`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${bgKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url: audioUrl, model: murekaModel })
          })

          // Re-read job to avoid stale overwrites
          const freshJob = await getJob(bgDb, bgJobId)
          if (!freshJob) return
          const freshStems = Array.isArray((freshJob as any).stem_jobs) ? (freshJob as any).stem_jobs as StemJob[] : []
          const freshStem = freshStems.find((s: StemJob) => s.task_id === bgTaskId)
          if (!freshStem) return

          if (!murekaRes.ok) {
            const errText = await murekaRes.text().catch(() => '')
            let errMsg = `Stemforge stem error ${murekaRes.status}`
            try { const j = JSON.parse(errText) as any; errMsg = j?.error?.message || j?.message || j?.error || errMsg } catch {}
            if (murekaRes.status === 429 || murekaRes.status === 503 || errMsg.toLowerCase().includes('concurrent')) {
              errMsg = 'Stem splitting is currently busy — please try again in 30–60 seconds.'
              // Log capacity error to DB for admin tracking
              if (bgDb) {
                try {
                  await bgDb.prepare(`INSERT INTO api_errors (error_type, user_id, created_at) VALUES (?, ?, ?)`)
                    .bind('mureka_busy', (freshJob as any).user_id || null, Date.now()).run()
                } catch { /* table may not exist on very first deploy — swallow */ }
              }
            }
            console.error(`[stems/mureka/bg] API error ${murekaRes.status}: ${errText.slice(0, 300)}`)
            freshStem.status = 'error'
            freshStem.error = errMsg
            const errJob = { ...freshJob } as any
            errJob.stem_jobs = freshStems.map((s: StemJob) => s.task_id === bgTaskId ? freshStem : s)
            await setJob(bgDb, errJob)
            return
          }

          const data = await murekaRes.json() as any
          const zipUrl = data.zip_url
          if (!zipUrl) {
            const errMsg = 'Stem extraction returned no audio: ' + JSON.stringify(data).slice(0, 200)
            console.error(`[stems/mureka/bg] ${errMsg}`)
            freshStem.status = 'error'
            freshStem.error = errMsg
            const errJob = { ...freshJob } as any
            errJob.stem_jobs = freshStems.map((s: StemJob) => s.task_id === bgTaskId ? freshStem : s)
            await setJob(bgDb, errJob)
            return
          }

          console.log(`[stems/mureka/bg] Got zip_url for ${bgTaskId}: ${zipUrl.slice(0,80)}`)
          // Store zip: URL — the poll handler will parse it on next client request
          freshStem.task_id = 'zip:' + zipUrl
          freshStem.status  = 'pending'  // reset so zip: branch runs on next poll
          const updJob = { ...freshJob } as any
          updJob.stem_jobs = freshStems.map((s: StemJob) => s.task_id === bgTaskId ? freshStem : s)
          await setJob(bgDb, updJob)
        } catch (bgErr: any) {
          console.error(`[stems/mureka/bg] Unhandled error: ${bgErr?.message}`)
          try {
            const freshJob = await getJob(bgDb, bgJobId)
            if (!freshJob) return
            const freshStems = Array.isArray((freshJob as any).stem_jobs) ? (freshJob as any).stem_jobs as StemJob[] : []
            const freshStem = freshStems.find((s: StemJob) => s.task_id === bgTaskId)
            if (!freshStem) return
            freshStem.status = 'error'
            freshStem.error = bgErr?.message || 'Stem extraction failed'
            const errJob = { ...freshJob } as any
            errJob.stem_jobs = freshStems.map((s: StemJob) => s.task_id === bgTaskId ? freshStem : s)
            await setJob(bgDb, errJob)
          } catch {}
        }
      })())
    }

    return c.json({ status: 'processing', task_id: stemJob.task_id })
  }

  // ── zip: → parse ZIP central directory and return stem tracks ────────────
  // task_id = "zip:<zipUrl>" set by the background Mureka call above.
  // We parse the ZIP on-demand via range requests (never download full ZIP).
  if (stemJob.task_id.startsWith('zip:')) {
    const zipUrl = stemJob.task_id.slice(4)
    try {
      const stemTracks: StemTrack[] = await parseZipStems(zipUrl)
      if (!stemTracks.length) throw new Error('No stems found in ZIP')

      // For split_from_mix: filter to vocals + instrumental only
      let finalTracks = stemTracks
      if (stemJob.mode === 'split_from_mix') {
        const vocals = finalTracks.find(s => s.name === 'vocals')
        const instr  = finalTracks.find(s => s.name === 'instrumental' || s.name === 'other')
        finalTracks = []
        if (vocals) finalTracks.push(vocals)
        if (instr)  finalTracks.push({ name: 'instrumental', url: instr.url })
        if (finalTracks.length === 1) {
          const ex = finalTracks[0]
          finalTracks.push({ name: ex.name === 'vocals' ? 'instrumental' : 'vocals', url: ex.url })
        }
      }

      stemJob.status = 'ready'
      stemJob.stems = finalTracks
      const updatedJob = { ...job } as any
      updatedJob.stem_jobs = stemJobs.map((s: StemJob) => s.task_id === stemJob!.task_id ? stemJob! : s)
      await setJob(c.env.DB, updatedJob)
      return c.json({ status: 'ready', stems: finalTracks, task_id: stemJob.task_id })
    } catch (zipErr: any) {
      stemJob.status = 'error'
      stemJob.error = zipErr.message || 'Failed to parse stem ZIP'
      const updatedJob = { ...job } as any
      updatedJob.stem_jobs = stemJobs.map((s: StemJob) => s.task_id === stemJob!.task_id ? stemJob! : s)
      await setJob(c.env.DB, updatedJob)
      return c.json({ status: 'error', error: stemJob.error })
    }
  }

  // Fallback
  return c.json({ status: 'processing', task_id: stemJob.task_id })
})

// GET /api/stem-audio/:jobId/:stem — proxy stem audio for browser playback
// NOTE: No session auth here — jobId is already a private UUID that acts as the access token.
// Requiring session auth breaks new Audio() playback because the browser sends the request
// as a no-CORS media fetch; if the worker returns 401 JSON, audio.play() rejects with NotSupportedError.
// ?regen=1 — serve the regenerated version of this stem (from regen_jobs) instead of the auto extraction
app.get('/api/stem-audio/:jobId/:stem', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Not configured' }, 500)

  const jobId = c.req.param('jobId')
  // Hono already URL-decodes params internally — calling decodeURIComponent again is a no-op for
  // plain names (vocals, lead_vocals) but we keep it for safety with any legacy encoded URLs
  const stemName = c.req.param('stem').replace(/%20/g, ' ').replace(/%5F/g, '_')
  const wantRegen = c.req.query('regen') === '1'
  // ?dl=1 — serve as a download attachment instead of inline audio
  const wantDl  = c.req.query('dl') === '1'
  const dlFmt   = c.req.query('fmt') || 'wav'  // 'mp3' | 'wav' — only affects Content-Type + filename for dl
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const stemLower = stemName.toLowerCase()
  const stemAlt   = stemLower.includes('_') ? stemLower.replace(/_/g, ' ') : stemLower.replace(/ /g, '_')
  let stemUrl: string | undefined

  if (wantRegen) {
    // ?regen=1: serve the most-recent ready regen job for this stem name
    const regenJobs = (job as any).regen_jobs as RegenJob[] | undefined
    if (regenJobs?.length) {
      // Find latest ready regen whose stem_type matches (exact or alt)
      const match = [...regenJobs].reverse().find((r: RegenJob) => {
        const n = r.stem_type?.toLowerCase()
        return r.status === 'ready' && r.url && (n === stemLower || n === stemAlt)
      })
      if (match) stemUrl = match.url
    }
    if (!stemUrl) return c.json({ error: `No regenerated stem "${stemName}" found` }, 404)
  } else {
    // Default: serve the auto-extracted stem from stem_jobs
    const stemJobs = (job as any).stem_jobs as StemJob[] | undefined
    if (!stemJobs?.length) return c.json({ error: 'No stems found' }, 404)

    // Find the stem URL across all stem jobs
    // Try exact match first, then with spaces↔underscores interchanged
    for (const sj of stemJobs) {
      const track = sj.stems.find((t: any) => {
        const n = t.name?.toLowerCase()
        return n === stemLower || n === stemAlt
      })
      if (track?.url) { stemUrl = track.url; break }
    }
    if (!stemUrl) return c.json({ error: `Stem "${stemName}" not found` }, 404)
  }

  // Proxy the audio — handle zip-entry: scheme from ZIP-parsed stems
  try {
    if (stemUrl.startsWith('zip-entry:')) {
      // Format (new): zip-entry:<zipUrl>|<localOff>|<compSize>|<fileName>|<compMethod>|<uncompSize>
      // Format (old): zip-entry:<zipUrl>|<localOff>|<compSize>|<fileName>   (no compMethod)
      const rest = stemUrl.slice('zip-entry:'.length)
      const parts = rest.split('|')
      const zipUrlStr  = parts[0]
      const localOff   = parseInt(parts[1], 10)
      const compSize   = parseInt(parts[2], 10)
      // parts[3] = fileName, parts[4] = compMethod (0=store,8=deflate), parts[5] = uncompSize
      const compMethod = parts[4] !== undefined ? parseInt(parts[4], 10) : -1  // -1 = unknown (legacy)
      const uncompSize = parts[5] !== undefined ? parseInt(parts[5], 10) : 0   // 0 = unknown (legacy)

      // Read the local file header (30 bytes minimum) to find exact data offset
      // Local header layout: sig(4) ver(2) gpflag(2) method(2) modtime(4) crc(4)
      //   compSize(4) uncompSize(4) fnLen(2) extraLen(2) = 30 bytes, then fnLen+extraLen bytes
      const hdrRes = await fetch(zipUrlStr, {
        headers: { 'Range': `bytes=${localOff}-${localOff + 29}` }
      })
      let dataStart = localOff + 30  // fallback
      let localCompMethod = compMethod
      if (hdrRes.ok || hdrRes.status === 206) {
        const hdrBuf = await hdrRes.arrayBuffer()
        const hdrView = new DataView(hdrBuf)
        if (hdrView.getUint32(0, true) === 0x04034b50) { // local file header sig
          if (localCompMethod === -1) {
            localCompMethod = hdrView.getUint16(6, true)  // read from header if not stored in URL
          }
          const localFnLen = hdrView.getUint16(26, true)
          const localExLen = hdrView.getUint16(28, true)
          dataStart = localOff + 30 + localFnLen + localExLen
        }
      }

      // Fetch the raw (possibly compressed) data bytes
      const rangeRes = await fetch(zipUrlStr, {
        headers: { 'Range': `bytes=${dataStart}-${dataStart + compSize - 1}` }
      })
      if (!rangeRes.ok && rangeRes.status !== 206) {
        return c.json({ error: 'ZIP range request not supported by CDN' }, 502)
      }

      // Decompress if deflated (method=8).
      // IMPORTANT: We must decompress into an ArrayBuffer (not stream) so we can
      // send a real Content-Length header. Cloudflare Workers strips Content-Length
      // from streaming responses, which makes audio.duration = Infinity in the browser.
      let audioBuffer: ArrayBuffer
      if (localCompMethod === 8) {
        // Fully decompress via DecompressionStream → Response → ArrayBuffer
        const ds = new DecompressionStream('deflate-raw')
        const decompStream = rangeRes.body!.pipeThrough(ds)
        audioBuffer = await new Response(decompStream).arrayBuffer()
      } else {
        // Stored (no compression) — just read as-is
        audioBuffer = await rangeRes.arrayBuffer()
      }

      const safeStemName = stemName.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40)

      // ZIP stems from Mureka are always WAV (PCM). Convert to MP3 if requested.
      let serveBuffer: ArrayBuffer = audioBuffer
      let serveFmt: 'wav' | 'mp3' | 'm4a' = 'wav'   // ZIP stems are always WAV
      if (wantDl && dlFmt === 'mp3') {
        try {
          serveBuffer = wavToMp3(audioBuffer)
          serveFmt    = 'mp3'
          console.log(`[stem-audio zip dl] ${stemName} WAV→MP3 done: ${Math.round(serveBuffer.byteLength/1024)}KB`)
        } catch (encErr: any) {
          console.warn(`[stem-audio zip dl] ${stemName} WAV→MP3 failed, serving WAV:`, encErr?.message)
          serveBuffer = audioBuffer
          serveFmt    = 'wav'
        }
      }
      const totalBytes = serveBuffer.byteLength

      // ── HTTP Range support — required for browser seeking ──
      // Without Accept-Ranges + 206 responses, browsers treat audio as non-seekable
      // and silently ignore a.currentTime assignments (always plays from 0).
      const rangeHeader = c.req.header('Range')
      if (rangeHeader && !wantDl) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (m) {
          const start = parseInt(m[1], 10)
          const end   = m[2] ? parseInt(m[2], 10) : totalBytes - 1
          const safeEnd = Math.min(end, totalBytes - 1)
          const chunk = serveBuffer.slice(start, safeEnd + 1)
          return new Response(chunk, {
            status: 206,
            headers: {
              'Content-Type': 'audio/wav',
              'Content-Range': `bytes ${start}-${safeEnd}/${totalBytes}`,
              'Content-Length': String(chunk.byteLength),
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=3600',
            }
          })
        }
      }

      const dlHeaders: Record<string, string> = {
        'Content-Type': wantDl ? audioMime(serveFmt) : 'audio/wav',
        'Content-Length': String(totalBytes),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      }
      if (wantDl) dlHeaders['Content-Disposition'] = `attachment; filename="${safeStemName}_stem.${serveFmt}"`
      return new Response(serveBuffer, { headers: dlHeaders })
    }

    // ── Direct CDN URL path (non-zip-entry stems) ──
    // Must also support Range requests so browsers can seek these stems.
    const rangeHeader2 = c.req.header('Range')
    const safeStemName2 = stemName.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40)
    const dlMime2 = dlFmt === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    const dlExt2  = dlFmt === 'mp3' ? 'mp3' : 'wav'

    // If browser is asking for a range, forward the Range header to the CDN
    const upstreamHeaders: Record<string, string> = {}
    if (rangeHeader2 && !wantDl) upstreamHeaders['Range'] = rangeHeader2

    const upstream = await fetch(stemUrl, { headers: upstreamHeaders })
    if (!upstream.ok && upstream.status !== 206) return c.json({ error: 'Audio fetch failed' }, 502)

    const upContentLength = upstream.headers.get('Content-Length')
    const upContentRange  = upstream.headers.get('Content-Range')

    // For downloads: read body, detect real format, convert if needed
    if (wantDl) {
      let dlBody  = await upstream.arrayBuffer()
      let realFmt = detectAudioFormat(dlBody)
      console.log(`[stem-audio dl] job=${jobId} stem=${stemName} source=${realFmt} wants=${dlFmt}`)

      if (dlFmt === 'mp3' && realFmt !== 'mp3') {
        // Convert WAV → MP3 or M4A → MP3 (M4A falls back to M4A)
        const converted = await toMp3(dlBody, realFmt)
        dlBody  = converted.buf
        realFmt = converted.fmt
        console.log(`[stem-audio dl] job=${jobId} stem=${stemName} →MP3 done: ${realFmt} ${Math.round(dlBody.byteLength/1024)}KB`)
      } else if (dlFmt === 'wav' && realFmt !== 'wav') {
        // MP3 → WAV or M4A → WAV
        try {
          dlBody  = realFmt === 'm4a' ? await m4aToWav(dlBody) : await mp3ToWav(dlBody)
          realFmt = 'wav'
        } catch (convErr: any) {
          console.warn(`[stem-audio dl] →WAV failed (${realFmt}), serving original:`, convErr?.message)
        }
      }

      const dlHeaders: Record<string, string> = {
        'Content-Type': audioMime(realFmt),
        'Content-Length': String(dlBody.byteLength),
        'Content-Disposition': `attachment; filename="${safeStemName2}_stem.${realFmt}"`,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
      return new Response(dlBody, { headers: dlHeaders })
    }

    // Streaming (playback) path \u2014 pass upstream through with correct Content-Type
    const streamHeaders: Record<string, string> = {
      'Content-Type': upstream.headers.get('Content-Type') || 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    }
    if (upContentLength) streamHeaders['Content-Length'] = upContentLength
    if (upContentRange)  streamHeaders['Content-Range']  = upContentRange
    return new Response(upstream.body, { status: upstream.status, headers: streamHeaders })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Proxy failed' }, 502)
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/remix-dl — proxy-download an AI Remix CDN file with a sane filename
//  Cross-origin CDN URLs ignore the HTML <a download> attribute in most browsers,
//  so the file gets the CDN's random hash name. This route fetches the CDN URL
//  server-side and re-serves it with Content-Disposition: attachment + correct filename.
//  ?url=<encodedCdnUrl>&name=<stemName>&fmt=wav|mp3
// ═══════════════════════════════════════════════════════════════
app.get('/api/remix-dl', async (c) => {
  // Auth: require a valid session (prevents abuse as an open proxy)
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const cdnUrl  = c.req.query('url')   // URL-encoded Mureka CDN URL
  const rawName = c.req.query('name') || 'remix'  // stem name, e.g. "vocals"
  const fmtReq  = (c.req.query('fmt') || 'wav').toLowerCase()  // 'wav' | 'mp3' — user's choice

  if (!cdnUrl) return c.json({ error: 'url param required' }, 400)

  // Validate the URL is a Mureka CDN URL (prevent open proxy abuse)
  let decodedUrl: string
  try { decodedUrl = decodeURIComponent(cdnUrl) } catch { return c.json({ error: 'Invalid url param' }, 400) }
  if (!decodedUrl.startsWith('https://')) return c.json({ error: 'url must be https' }, 400)

  try {
    const upstream = await fetch(decodedUrl)
    if (!upstream.ok) return c.json({ error: 'CDN fetch failed' }, 502)

    // Read body and detect REAL format from magic bytes — never trust URL or Content-Type
    let body    = await upstream.arrayBuffer()
    let realFmt = detectAudioFormat(body)
    const safeStem = rawName.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40)

    console.log(`[remix-dl] name=${rawName} source format=${realFmt} user wants=${fmtReq}`)

    if (fmtReq === 'wav' && realFmt !== 'wav') {
      // MP3 → WAV or M4A → WAV (FAAD2 decode)
      try {
        body    = realFmt === 'm4a' ? await m4aToWav(body) : await mp3ToWav(body)
        realFmt = 'wav'
        console.log(`[remix-dl] →WAV done: ${Math.round(body.byteLength/1024)}KB`)
      } catch (convErr: any) {
        console.warn(`[remix-dl] →WAV failed (${realFmt}):`, convErr?.message)
      }
    } else if (fmtReq === 'mp3' && realFmt !== 'mp3') {
      // WAV → MP3 (or M4A falls back to M4A)
      const converted = await toMp3(body, realFmt)
      body    = converted.buf
      realFmt = converted.fmt
      console.log(`[remix-dl] →MP3 done: ${realFmt} ${Math.round(body.byteLength/1024)}KB`)
    }

    const filename = `${safeStem}_ai_remix.${realFmt}`
    return new Response(body, {
      headers: {
        'Content-Type': audioMime(realFmt),
        'Content-Length': String(body.byteLength),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Download proxy failed' }, 502)
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/regen-stem
//  Generative stem regen — instead of re-separating (same artifacts),
//  uploads the beat as a reference to MusicAPI /sonic/upload, then calls
//  Producer /producer/create with reference_clip_id so Lyria 3 Pro generates
//  a clean, artifact-free instrumental inspired by the original beat.
//
//  ⚠️  Results are NOT saved to D1 — regen is session-only.
//       Closing & reopening the stem player clears the regen section.
//
//  Costs 20 pts, Pro Artist only.
//  Flow:
//   1. POST /sonic/upload { url: ... } → { task_id }
//   2. Poll /sonic/task/:taskId until state=succeeded → clip_id
//   3. POST /producer/create { task_type: "generate_music", reference_clip_id: clip_id, sound: "..." }
//   4. Returns { task_id } — async; poll with GET below
//   5. GET /api/job/regen-stem/:jobId?task_id=... → polls /sonic/task/:taskId (Producer shares polling)
//   6. When succeeded: return audio_url directly (never stored in D1)
// ═══════════════════════════════════════════════════════════════

interface RegenJob {
  task_id: string
  stem_type: string
  status: 'pending' | 'processing' | 'ready' | 'error'
  url?: string    // URL of the regenerated instrumental
  error?: string
  created_at: number
}

app.post('/api/job/regen-stem', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  // Advanced split = Pro Artist only
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'Advanced stem regeneration requires a Pro Artist plan.', locked: true, upgrade: true }, 403)
  }

  // Deduct 30 points for regen-stem
  const regenFresh = await c.env.DB.prepare(`SELECT gens_used, gens_limit FROM users WHERE id=?`).bind(user.id).first<{gens_used:number,gens_limit:number}>()
  if (!regenFresh || regenFresh.gens_used + 30 > regenFresh.gens_limit) {
    return c.json({ error: `Not enough points. Regen costs 30 points and you only have ${regenFresh ? Math.max(0, regenFresh.gens_limit - regenFresh.gens_used) : 0} remaining.`, limit_reached: true }, 403)
  }
  await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + 30 WHERE id=?`).bind(user.id).run()

  const body = await c.req.json<{ job_id: string; stem_type: string }>()
  const { job_id, stem_type } = body
  if (!job_id || !stem_type) return c.json({ error: 'job_id and stem_type required' }, 400)

  const job = await getJob(c.env.DB, job_id)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!job.stereo_url) return c.json({ error: 'Beat audio not ready' }, 400)

  const stemLabel = stem_type.toLowerCase()
  const stemLabelAlt = stemLabel.includes('_') ? stemLabel.replace(/_/g, ' ') : stemLabel.replace(/ /g, '_')

  // ── Find the already-extracted stem for this stem_type ──
  // We upload the PRE-EXTRACTED stem (not the full mix) to instrumental/generate.
  // Feeding only that instrument's audio as the reference means Mureka generates
  // a clean isolated version of just that instrument — no bleed from others.
  //
  // All stems in stem_jobs are stored as zip-entry: URLs (compressed in the separation ZIP).
  // We resolve them by reading the ZIP local header + range-fetching the compressed bytes,
  // decompressing if needed, then uploading the raw WAV bytes as a multipart file to Mureka.
  // This is the same logic used in GET /api/stem-audio — duplicated here for the regen path.
  const stemJobs = (job as any).stem_jobs as StemJob[] | undefined
  let stemSourceUrl: string = job.stereo_url   // fallback — full mix
  let stemZipEntry: string | undefined         // set when stem is a zip-entry: URL

  if (stemJobs?.length) {
    outer: for (const sj of stemJobs) {
      if (sj.status !== 'ready' || !sj.stems?.length) continue
      for (const t of sj.stems) {
        const n = (t.name || '').toLowerCase()
        if (n === stemLabel || n === stemLabelAlt) {
          if (t.url) {
            if (t.url.startsWith('zip-entry:')) {
              stemZipEntry = t.url   // will resolve to bytes below
              console.log(`[remix] Found zip-entry stem for ${stemLabel}`)
            } else {
              stemSourceUrl = t.url  // direct CDN URL — can upload by URL
              console.log(`[remix] Using direct stem URL for ${stemLabel}: ${stemSourceUrl.slice(0, 60)}...`)
            }
            break outer
          }
        }
      }
    }
  }
  if (!stemZipEntry && stemSourceUrl === job.stereo_url) {
    console.warn(`[remix] No extracted stem found for ${stemLabel} — falling back to full mix`)
  }

  // ── Step 1: Upload stem to MusicAPI Sonic upload endpoint → get clip_id ──
  let clipId: string
  try {
    // Resolve upload URL — prefer direct CDN URL; zip-entry falls back to full mix
    const uploadAudioUrl = stemZipEntry ? job.stereo_url! : stemSourceUrl

    const uploadRes = await fetch(`${MUSICAPI_SONIC}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: uploadAudioUrl })
    })
    if (!uploadRes.ok) {
      const errText = await uploadRes.text()
      let errMsg = `Stemforge upload error ${uploadRes.status}`
      try { const j = JSON.parse(errText) as any; errMsg = j?.message || j?.error || errMsg } catch {}
      console.error(`[regen] upload error ${uploadRes.status}: ${errText}`)
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: errMsg }, 500)
    }
    const uploadData = await uploadRes.json() as any
    const uploadTaskId = uploadData.task_id || uploadData.data?.task_id
    if (!uploadTaskId) {
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: 'Stemforge returned no task ID for upload' }, 500)
    }

    // Poll for clip_id
    const deadline = Date.now() + 60_000
    clipId = ''
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000))
      const pollRes = await fetch(`${MUSICAPI_SONIC}/task/${uploadTaskId}`, {
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
      })
      if (!pollRes.ok) continue
      const pollData = await pollRes.json() as any
      const clips = Array.isArray(pollData) ? pollData : (pollData.data || [])
      if (clips.length && clips[0].state === 'succeeded') {
        clipId = clips[0].id || clips[0].clip_id || ''
        break
      }
      if (clips.length && clips[0].state === 'failed') break
    }
    if (!clipId) {
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: 'Stemforge audio processing timed out or failed' }, 500)
    }
  } catch (err: any) {
    await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
    return c.json({ error: err?.message || 'File upload failed' }, 500)
  }

  // ── Step 2: POST /producer/create with reference_clip_id ──
  // Producer (Lyria 3 Pro) generates a clean instrumental version
  let taskId: string
  try {
    const genRes = await fetch(`${MUSICAPI_PRODUCER}/create`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference_clip_id: clipId,
        sound: 'instrumental, no vocals, clean stem regeneration'
      })
    })
    if (!genRes.ok) {
      const errText = await genRes.text()
      let errMsg = `Stemforge generation error ${genRes.status}`
      try { const j = JSON.parse(errText) as any; errMsg = j?.message || j?.error || errMsg } catch {}
      console.error(`[regen] producer/create error ${genRes.status}: ${errText}`)
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: errMsg }, 500)
    }
    const genData = await genRes.json() as any
    taskId = genData.task_id || genData.data?.task_id
    if (!taskId) {
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: 'Stemforge returned no task ID' }, 500)
    }
    console.log(`[regen] Producer started: task=${taskId} stem=${stemLabel} job=${job_id}`)
  } catch (err: any) {
    await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
    return c.json({ error: err?.message || 'Generate request failed' }, 500)
  }

  // Results are NOT saved to D1 — regen is session-only.
  return c.json({ ok: true, task_id: taskId, status: 'processing', stem_type: stemLabel })
})

// ── GET /api/job/regen-stem/:jobId — poll regen status ────────────────────
// Polls MusicAPI /sonic/task/:taskId directly.
// Results are NOT stored in D1 — purely pass-through to the frontend.
app.get('/api/job/regen-stem/:jobId', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const taskId = c.req.query('task_id') || ''
  const stemType = c.req.query('stem_type') || 'stem'

  // Legacy ?all=1 — no longer needed (regens not stored in D1), return empty
  const allFlag = c.req.query('all') === '1'
  if (allFlag) return c.json({ status: 'not_started' })

  if (!taskId) return c.json({ status: 'not_started' })

  // Verify the job belongs to this user (security check)
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // Poll MusicAPI /sonic/task/:taskId (Producer tasks share same polling endpoint)
  try {
    const res = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, {
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
    })
    if (!res.ok) return c.json({ status: 'processing', task_id: taskId })
    const data = await res.json() as any
    const clips = Array.isArray(data) ? data : (data.data || [])
    if (!clips.length) return c.json({ status: 'processing', task_id: taskId })
    const clip = clips[0]

    if (clip.state === 'succeeded') {
      const url: string = clip.audio_url || ''
      if (!url) return c.json({ status: 'error', error: 'No audio URL in Stemforge response' })
      console.log(`[regen poll] ready: task=${taskId} stem=${stemType} url=${url.slice(0,60)}...`)
      return c.json({ status: 'ready', task_id: taskId,
        stems: [{ name: stemType.toLowerCase(), url }] })
    }

    if (clip.state === 'failed') {
      const reason = clip.error || 'Regeneration failed'
      console.error(`[regen poll] failed: task=${taskId} reason=${reason}`)
      return c.json({ status: 'error', error: reason })
    }

    return c.json({ status: 'processing', task_id: taskId })
  } catch (err: any) {
    return c.json({ status: 'error', error: err?.message || 'Poll failed' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/remix — AI Remix the full stereo track
//  Uploads the beat's stereo_url to MusicAPI /sonic/upload,
//  calls MusicAPI Producer /producer/create with reference_clip_id.
//  Creates a NEW Job in D1 so the result appears in the library.
//  Costs 20 pts. Available to creator/pro/developer plans.
//  Frontend polls the new job via existing POST /api/poll/:id.
// ═══════════════════════════════════════════════════════════════
app.post('/api/job/remix', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  // Require Pro Artist plan (free and creator are both blocked)
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'AI Remix is a Pro Artist feature. Upgrade to unlock.', upgrade: true }, 403)
  }

  const body = await c.req.json<{ job_id?: string; audio_url?: string; title?: string }>()
  const { job_id, audio_url: directAudioUrl, title } = body

  // Support two modes: (1) remix a library job by job_id, (2) remix a directly uploaded audio URL
  let srcJob: any = {}
  if (job_id) {
    // Load source job — must belong to this user and be ready
    const srcRow = await c.env.DB.prepare(
      `SELECT data FROM jobs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(job_id, user.id).first<{ data: string }>()
    if (!srcRow) return c.json({ error: 'Source track not found' }, 404)
    srcJob = JSON.parse(srcRow.data) as any
    if (srcJob.status !== 'ready' || !srcJob.stereo_url) {
      return c.json({ error: 'Source track is not ready yet.' }, 400)
    }
  } else if (directAudioUrl) {
    // Direct upload mode — audio_url is the R2 proxy URL from /api/upload-remix-audio
    srcJob = { stereo_url: directAudioUrl, title: title || 'Uploaded Track', blueprint: null }
  } else {
    return c.json({ error: 'job_id or audio_url required' }, 400)
  }

  // Deduct 20 points — bonus_credits consumed first
  const fresh = await c.env.DB.prepare(`SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id=?`).bind(user.id).first<{gens_used:number,gens_limit:number,bonus_credits:number}>()
  const freshBonus = fresh?.bonus_credits ?? 0
  const freshMain = fresh ? (fresh.gens_limit - fresh.gens_used) : 0
  if (!fresh || freshMain + freshBonus < 20) {
    return c.json({ error: `Not enough points. Stemforge Remix costs 20 points and you only have ${Math.max(0, freshMain + freshBonus)} remaining.`, limit_reached: true }, 403)
  }
  if (freshBonus >= 20) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - 20 WHERE id=?`).bind(user.id).run()
  } else if (freshBonus > 0) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id=?`).bind(20 - freshBonus, user.id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + 20 WHERE id=?`).bind(user.id).run()
  }

  // Build style tags from the source job's blueprint for Sonic /upload-cover
  const bp = srcJob.blueprint
  const genre = bp?.genre || 'instrumental'
  const mood  = bp?.mood  || ''
  const bpm   = bp?.bpm   || ''
  // Build tags without duplicates — genre defaults to 'instrumental' so don't add it twice
  // Do NOT hardcode mood/energy words (e.g. 'energetic') — let the actual mood/blueprint drive it
  const tagParts: string[] = []
  if (genre && genre.toLowerCase() !== 'instrumental') tagParts.push(genre)
  tagParts.push('instrumental', 'no vocals')
  if (mood && !tagParts.includes(mood.toLowerCase())) tagParts.push(mood)
  if (bpm) tagParts.push(`${bpm} BPM`)
  const tags = tagParts.join(', ')

  // Use /sonic/upload-cover — the correct endpoint for AI remixing.
  // It takes a reference audio URL + style tags and generates a brand-new track
  // inspired by the original. This is a "cover/remix" not an "extension".
  // This was the original working implementation confirmed to produce results.
  let genTaskId: string
  try {
    const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
    let audioUrl = srcJob.stereo_url as string

    // Mirror external CDN URLs (Mureka etc.) into R2 so Sonic can download quickly.
    // Self-hosted proxy URLs (already on stemforge.studio) are skipped — already accessible.
    // R2 key uses extend-uploads/ prefix (same as job/extend) — proxy handles both prefixes.
    if (c.env.IMAGES && !audioUrl.includes(siteUrl)) {
      try {
        const audioFetch = await fetch(audioUrl)
        if (audioFetch.ok) {
          const buf = await audioFetch.arrayBuffer()
          const ext = audioUrl.includes('.mp3') ? 'mp3' : 'm4a'
          // Store under extend-uploads/ — the proxy at /api/extend-audio-proxy tries this prefix first
          const r2FileName = `${Date.now()}-${Math.random().toString(36).slice(2,8)}-remix.${ext}`
          await c.env.IMAGES.put(`extend-uploads/${r2FileName}`, buf, {
            httpMetadata: { contentType: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' }
          })
          audioUrl = `${siteUrl}/api/extend-audio-proxy/${encodeURIComponent(r2FileName)}`
          console.log(`[remix] mirrored to R2: extend-uploads/${r2FileName}`)
        }
      } catch (mirrorErr: any) {
        console.warn('[remix] R2 mirror failed, using original URL:', mirrorErr?.message)
      }
    }

    // POST /sonic/upload-cover — give it the audio URL + style tags, get a task_id back.
    // Response: { task_id } or { steps: { cover: { task_id } } } or { data: [{ id }] }
    console.log(`[remix] Calling /sonic/upload-cover url=${audioUrl.slice(0,80)} tags="${tags}"`)
    const coverRes = await fetch(`${MUSICAPI_SONIC}/upload-cover`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: audioUrl,
        mv: 'sonic-v5',
        tags,
        custom_mode: false,
        gpt_description_prompt: `Instrumental beat${genre && genre.toLowerCase() !== 'instrumental' ? ` in ${genre} style` : ''}, no vocals${mood ? `, ${mood} mood` : ''}${bpm ? `, ${bpm} BPM` : ''}. Keep the same energy and style.`,
        make_instrumental: true
      })
    })
    const coverText = await coverRes.text()
    console.log(`[remix] /sonic/upload-cover HTTP ${coverRes.status}: ${coverText.slice(0,600)}`)
    if (!coverRes.ok) {
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id=?`).bind(user.id).run()
      let coverErrData: any = {}
      try { coverErrData = JSON.parse(coverText) } catch {}
      const apiErrMsg = coverErrData.message || coverErrData.error || coverText.slice(0, 200)
      console.error(`[remix] MusicAPI /upload-cover error: ${apiErrMsg}`)
      // "Upload failed" from MusicAPI usually means the track was rejected (copyright/fingerprint detection)
      const userMsg = apiErrMsg.toLowerCase().includes('upload failed')
        ? 'Track could not be remixed — this track may be copyright-protected. Try uploading an original or royalty-free track.'
        : `Could not start remix: ${apiErrMsg}`
      return c.json({ error: userMsg, api_status: coverRes.status }, 500)
    }
    let coverData: any = {}
    try { coverData = JSON.parse(coverText) } catch {}
    genTaskId = coverData.task_id || coverData.steps?.cover?.task_id || coverData.data?.[0]?.id || ''
    if (!genTaskId) {
      console.error(`[remix] upload-cover returned no task_id: ${coverText.slice(0,200)}`)
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id=?`).bind(user.id).run()
      return c.json({ error: 'Remix failed to start — please try again. Please try again.' }, 500)
    }
    console.log(`[remix] upload-cover task started: ${genTaskId}`)
  } catch (err: any) {
    console.error(`[remix] unexpected error: ${err?.message}`)
    await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id=?`).bind(user.id).run()
    return c.json({ error: `Something went wrong starting your remix: ${err?.message || 'unknown error'}` }, 500)
  }

  // Create the remix job. extend_task_type='song_generate' tells advancePipeline
  // to poll via pollSongExtendStatus (Sonic task endpoint), same as song extend jobs.
  const newJobId = makeJobId()
  const cleanTitle = (title || srcJob.title || '').replace(/_/g, ' ').trim()
  const remixTitle = cleanTitle ? `${cleanTitle} Remix` : 'Stemforge Remix'
  const newJob: Job = {
    id: newJobId,
    status: 'generating',
    created_at: Date.now(),
    prompt: `Stemforge Remix of ${job_id}`,
    title: remixTitle,
    thumbnail_seed: Math.floor(Math.random() * 360),
    stereo_task_id: genTaskId
  }
  ;(newJob as any).extend_task_type = 'song_generate'  // polls via pollSongExtendStatus
  ;(newJob as any).is_remix = 1  // flags job for Remixes tab in library
  if (bp) (newJob as any).blueprint = bp
  await setJob(c.env.DB, newJob, user.id)

  console.log(`[remix] Job ${newJobId} created, sonic_task=${genTaskId}, source=${job_id}`)
  return c.json({ ok: true, job_id: newJobId, status: 'generating' })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/stem-mix/:jobId
//  Download the stereo mix (original beat audio).
//  We detect the REAL format from magic bytes and serve it with the correct
//  extension + MIME \u2014 never lie and call an MP3 a WAV.
//  Plan gating: free \u2192 403, creator \u2192 any format, pro \u2192 any format
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
app.get('/api/stem-mix/:jobId', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  if (user.plan === 'free') {
    return c.json({ error: 'Download requires a Creator or Pro Artist plan.', upgrade: true }, 403)
  }

  const jobId  = c.req.param('jobId')
  const fmtReq = (c.req.query('fmt') || 'wav').toLowerCase()  // 'wav' | 'mp3' — user's choice
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!job.stereo_url) return c.json({ error: 'Audio not ready' }, 400)

  try {
    const safeName = jobId.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60)
    const cacheKey = `mix-${jobId}`   // separate namespace from track downloads

    // ── R2 cache check ──
    if (c.env.IMAGES && (fmtReq === 'wav' || fmtReq === 'mp3')) {
      const cached = await getDlCache(c.env.IMAGES, cacheKey, fmtReq)
      if (cached) {
        return new Response(cached, {
          headers: {
            'Content-Type': audioMime(fmtReq as 'wav' | 'mp3'),
            'Content-Length': String(cached.byteLength),
            'Content-Disposition': `attachment; filename="${safeName}_mix.${fmtReq}"`,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'private, max-age=300',
            'X-Cache': 'HIT'
          }
        })
      }
    }

    // ── Cache miss: fetch + convert ──
    const upstream = await fetch(job.stereo_url)
    if (!upstream.ok) return c.json({ error: 'Audio fetch failed' }, 502)

    let buf       = await upstream.arrayBuffer()
    let realFmt   = detectAudioFormat(buf)

    console.log(`[stem-mix dl] job=${jobId} source format=${realFmt} user wants=${fmtReq} (cache MISS)`)

    // Convert to the format the user actually requested
    if (fmtReq === 'wav' && realFmt !== 'wav') {
      // MP3 → WAV or M4A → WAV (FAAD2 decode)
      try {
        buf     = realFmt === 'm4a' ? await m4aToWav(buf) : await mp3ToWav(buf)
        realFmt = 'wav'
        console.log(`[stem-mix dl] job=${jobId} →WAV done: ${Math.round(buf.byteLength/1024)}KB`)
      } catch (convErr: any) {
        console.warn(`[stem-mix dl] job=${jobId} →WAV failed (${realFmt}):`, convErr?.message)
      }
    } else if (fmtReq === 'mp3' && realFmt !== 'mp3') {
      // WAV → lamejs MP3; M4A → FAAD2 decode → lamejs MP3
      const converted = await toMp3(buf, realFmt)
      buf     = converted.buf
      realFmt = converted.fmt
      console.log(`[stem-mix dl] job=${jobId} →MP3 done: realFmt=${realFmt} ${Math.round(buf.byteLength/1024)}KB`)
    }

    // ── Store result in R2 cache (fire-and-forget) ──
    if (c.env.IMAGES && (realFmt === 'wav' || realFmt === 'mp3')) {
      putDlCache(c.env.IMAGES, cacheKey, realFmt, buf).catch(() => {})
    }

    return new Response(buf, {
      headers: {
        'Content-Type': audioMime(realFmt),
        'Content-Length': String(buf.byteLength),
        'Content-Disposition': `attachment; filename="${safeName}_mix.${realFmt}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=300',
        'X-Cache': 'MISS'
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Download failed' }, 502)
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/cover-image/:jobId
//  Generate an AI album cover image for a beat using gpt-image-1.
//  Caching strategy (generate ONCE, serve forever — $0.02 total per track):
//    1. Check D1 job record for a stored image_url → return immediately (free)
//    2. If no cached URL: call gpt-image-1, get b64_json
//    3. Upload the raw JPEG bytes to R2 under covers/<jobId>.jpg
//    4. Save the R2 public URL back into the D1 job record
//    5. Return the permanent R2 URL to the client
//  The client receives a real HTTPS URL, not a data URL — no sessionStorage needed.
//  Auth: session cookie required.
// ═══════════════════════════════════════════════════════════════
app.get('/api/cover-image/:jobId', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  let job: Job | null = null
  try {
    const row = await c.env.DB.prepare('SELECT data FROM jobs WHERE id = ?').bind(jobId).first<{data:string}>()
    if (row) job = JSON.parse(row.data) as Job
  } catch { /* fall through */ }
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // ── Step 1a: Return cached permanent URL from D1 (zero cost) ──
  // Only trust our own /api/cover-art/* URLs — reject pollinations, data:, or anything else
  const cachedUrl = (job as any).image_url as string | undefined
  if (cachedUrl && cachedUrl.includes('/api/cover-art/')) {
    return c.json({ url: cachedUrl, cached: true })
  }

  // ── Step 1b: Check R2 directly — image may exist but D1 record wasn't updated ──
  // This happens if a previous setJob write failed or the job was generated before caching was added.
  if (c.env.IMAGES) {
    // Check custom first, then AI-generated
    for (const ext of ['jpg', 'png', 'webp']) {
      const custom = await c.env.IMAGES.get(`covers/${jobId}-custom.${ext}`)
      if (custom) {
        const url = `${c.env.SITE_URL}/api/cover-art/${jobId}`
        // Heal the D1 record so future calls are instant
        try {
          const healed = { ...job, image_url: url, image_url_custom: true } as any
          await setJob(c.env.DB, healed)
        } catch { /* best-effort */ }
        return c.json({ url, cached: true })
      }
    }
    const aiObj = await c.env.IMAGES.get(`covers/${jobId}.jpg`)
    if (aiObj) {
      const url = `${c.env.SITE_URL}/api/cover-art/${jobId}`
      // Heal the D1 record
      try {
        const healed = { ...job, image_url: url } as any
        await setJob(c.env.DB, healed)
      } catch { /* best-effort */ }
      return c.json({ url, cached: true })
    }
  }

  // ── Step 2: Build a title-driven, Suno-style prompt ──
  // Philosophy (inspired by Suno's cover art approach):
  //   • The TITLE is the primary subject — interpret it literally and creatively
  //   • Genre/mood are secondary hints, not visual constraints
  //   • Every image should be rich in colour and striking — never muted or generic
  //   • Visual style (painterly, 3D, retro-vector, cinematic, etc) is chosen to best
  //     match the title's concept, not locked to genre
  //   • No repeated formulas — the AI should feel free to be inventive
  const bp    = job.blueprint as any
  const genre = (bp?.genre  || 'music').toLowerCase()
  const mood  = (bp?.mood   || '').toLowerCase()
  const rawTitle = ((job as any).title || '').trim()
  const titleForPrompt = rawTitle || genre

  // ── 2a: Derive visual concept directly from the title ──
  // Strip common filler words so the core subject shines
  const stopWords = new Set(['the','a','an','of','in','on','at','to','for','and','or','but','with','my','our','your','its','ft','feat'])
  const titleWords = titleForPrompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w: string) => w.length > 1 && !stopWords.has(w))

  // ── 2b: Pick a rendering style that best fits the concept ──
  // These are style "lenses" the AI can apply — chosen by matching title keywords.
  // If no keyword matches, we pick one randomly so variety is high across tracks.
  interface StyleRule { keywords: string[]; style: string }

  // ── Genre-first styles: hip hop / trap / R&B get specific cinematic visual language ──
  const genreNorm = genre.toLowerCase()
  let genreStyle = ''
  if (genreNorm.includes('hip') || genreNorm.includes('hop') || genreNorm.includes('rap') || genreNorm.includes('trap')) {
    // Rotate through 8 distinct hip-hop visual aesthetics so every track looks different
    const hipHopStyles = [
      'cinematic hip-hop street photography, golden-hour light hitting wet asphalt, dramatic lens flare, film grain, ultra-sharp detail',
      'luxury rap aesthetic: black matte background with gleaming 24k gold chains, diamonds and ice, macro studio photography, extreme detail',
      'dark trap visual: lone figure silhouette under purple-and-red neon in a rain-soaked alley, moody cinematic, photorealistic',
      'aerial urban rap cityscape at dusk, purple and amber sky over downtown skyline, Kendrick-Lamar-album-cover energy, cinematic',
      'abstract hip-hop 3D art: shattered gold record pieces floating in dark void, deep blacks, glowing amber fragments, hyper-real render',
      'gritty street mural style, spray-paint graffiti aesthetic, vibrant colours on brick wall, urban raw energy, hyperdetailed',
      'smoke and money trap aesthetic: dollar bills raining from dark sky, dramatic spotlight, cinematic still-life photography',
      'lo-fi hip-hop mood: cozy room at night, lamp glow, vinyl record spinning, warm amber tones, film grain, nostalgic detail',
    ]
    const h2 = jobId.split('').reduce((a: number, c: string) => (a * 37 + c.charCodeAt(0)) & 0xff, 0)
    genreStyle = hipHopStyles[h2 % hipHopStyles.length]
  } else if (genreNorm.includes('rnb') || genreNorm.includes('r&b') || genreNorm.includes('soul') || genreNorm.includes('neo')) {
    const rnbStyles = [
      'silky R&B aesthetic: soft purple and rose studio portrait lighting, film-photography warmth, intimate mood, ultra-detailed skin tones',
      'neo-soul visual: warm candlelight bokeh, vintage film stock, rich amber and burgundy palette, emotional intimacy, photorealistic',
      'luxury R&B album art: neon pink and deep plum abstract light painting, glossy surfaces, cinematic 8K render',
      'soulful moody R&B: solitary figure bathed in window light, deep blue shadows, golden highlights, painterly cinematic photography',
      'modern R&B: iridescent purple holographic background, crystalline reflections, sleek editorial fashion photography style',
    ]
    const h3 = jobId.split('').reduce((a: number, c: string) => (a * 41 + c.charCodeAt(0)) & 0xff, 0)
    genreStyle = rnbStyles[h3 % rnbStyles.length]
  } else if (genreNorm.includes('pop')) {
    const popStyles = [
      'bold pop album cover: electric neon gradient background, glossy 3D typography elements, maximalist colour, professional studio',
      'dreamy pop aesthetic: pastel sunset gradient sky, floating petals and sparkles, vivid candy colours, editorial perfection',
      'edgy pop: black and chrome high-contrast fashion photography, dramatic lighting, sharp shadows, ultra-detailed',
      'euphoric pop visual: confetti burst explosion of vivid colour, backlit stage lighting, dazzling and high-energy, photorealistic',
      'cinematic pop art: Andy-Warhol-inspired bold colour blocks, hyper-saturated, graphic and modern',
    ]
    const h4 = jobId.split('').reduce((a: number, c: string) => (a * 43 + c.charCodeAt(0)) & 0xff, 0)
    genreStyle = popStyles[h4 % popStyles.length]
  }

  const styleRules: StyleRule[] = [
    { keywords: ['night','midnight','dark','shadow','black','gothic','horror','haunted','ghost','demon','devil'],
      style: 'dramatic cinematic noir, deep blacks and electric neon highlights, chiaroscuro lighting, hyperdetailed photography' },
    { keywords: ['fire','flame','burn','inferno','blaze','heat','volcano','explosive','hot'],
      style: 'hyperrealistic fire and molten light, deep crimsons and vivid oranges, breathtaking energy, 8K photorealistic' },
    { keywords: ['ocean','sea','wave','water','rain','storm','flood','river','tide'],
      style: 'epic seascape, rich teals and deep navy, volumetric ocean waves, sweeping cinematic atmosphere, ultra-sharp' },
    { keywords: ['space','galaxy','star','cosmos','universe','nebula','planet','alien','astronaut'],
      style: 'stunning deep-space digital art, vivid nebula colours, luminous stardust, photorealistic cosmic scale, hyperdetailed' },
    { keywords: ['city','street','urban','neon','tokyo','ny','nyc','chicago','london','downtown','block','hood'],
      style: 'vibrant neon-drenched urban streetscape, reflective wet asphalt, cinematic night photography, lens flare, hyperrealistic' },
    { keywords: ['love','heart','romance','kiss','together','forever','baby','girl','boy','soul','feeling'],
      style: 'warm golden hour photography, rich amber and rose bokeh, intimate cinematic close-up, film grain, ultra-detailed' },
    { keywords: ['war','battle','fight','soldier','warrior','weapon','gun','sword','army','struggle'],
      style: 'epic battlefield concept art, dramatic overcast sky, vivid contrast, cinematic scale and raw power, photorealistic' },
    { keywords: ['jungle','forest','nature','tree','earth','green','wild','animal','lion','tiger','wolf'],
      style: 'lush hyper-real nature photography, rich emerald greens and golden light shafts, extreme macro detail' },
    { keywords: ['dream','fantasy','magic','fairy','wizard','dragon','mythical','surreal','psychedelic'],
      style: 'surrealist digital painting, impossible dreamscape, saturated otherworldly palette, incredibly detailed render' },
    { keywords: ['money','rich','gold','luxury','diamond','crown','king','queen','throne','empire','boss','drip'],
      style: 'opulent luxury aesthetic, deep jewel tones, 24k gold and diamond details, baroque grandeur, macro photography, gleaming' },
    { keywords: ['future','cyber','robot','machine','tech','digital','ai','matrix','code','electric'],
      style: 'sleek cyberpunk 3D render, neon cyan and magenta on matte black, holographic fragments, geometric precision, 8K' },
    { keywords: ['retro','vintage','old','classic','90s','80s','70s','cassette','vinyl','throwback'],
      style: 'retro-illustration with film grain texture, warm vintage colour palette, nostalgic poster art, highly detailed' },
    { keywords: ['peace','calm','meditation','zen','sky','cloud','sunrise','sunset','heaven','light','chill'],
      style: 'breathtaking sky photography, god rays and prismatic light, serene and transcendent, ultra-detailed atmosphere' },
    { keywords: ['party','dance','club','dj','rave','festival','bounce','energy','hype','lit'],
      style: 'high-energy club photography, multi-coloured strobe lights, motion blur trails, explosive colour and intensity' },
    { keywords: ['sad','broken','pain','cry','tears','lost','alone','empty','lonely','hurt','cold'],
      style: 'melancholic cinematic portrait, muted blue-grey tones with single warm amber highlight, emotional photorealism' },
    { keywords: ['smoke','haze','fog','mist','blunt','wave'],
      style: 'atmospheric smoke and haze photography, purple and indigo light diffusion, moody cinematic still, photorealistic' },
    { keywords: ['ice','cold','winter','snow','frozen','frosty','glacier'],
      style: 'hyper-real ice and crystal photography, cold electric blue and white tones, sharp frozen details, cinematic' },
    { keywords: ['blood','dead','death','kill','murder','grave','dark','hell'],
      style: 'dark cinematic horror aesthetic, deep crimson and jet black palette, chiaroscuro dramatic lighting, photorealistic' },
  ]

  let chosenStyle = genreStyle  // Start with genre style if set
  if (!chosenStyle) {
    for (const rule of styleRules) {
      if (rule.keywords.some((kw: string) => titleWords.includes(kw) || titleForPrompt.toLowerCase().includes(kw))) {
        chosenStyle = rule.style
        break
      }
    }
  }

  // If no keyword matched, use a mood/genre hint to pick a style, then fall back to
  // a large varied pool so every un-matched track looks completely different
  if (!chosenStyle) {
    const moodHints: Record<string, string> = {
      'dark':       'cinematic noir atmosphere, deep shadows, electric neon accents, ultra-detailed hyperrealistic photography',
      'aggressive': 'raw power concept art, explosive contrast, intense colour, visceral energy, hyperdetailed render',
      'uplifting':  'radiant golden light burst, vivid chromatic rays, soaring and inspirational, cinematic wide shot',
      'chill':      'lo-fi night scene, warm lamp glow through window, cozy amber tones, film grain, photorealistic intimacy',
      'romantic':   'dreamy golden bokeh portrait, rose and amber warmth, soft romantic film photography, ultra-detailed',
      'energetic':  'dynamic motion blur street photography, saturated neon colours, explosive composition, high contrast cinematic',
      'melancholic':'painterly foggy cityscape at dusk, muted teals and soft amber, moody impressionist atmosphere',
      'luxurious':  'opulent gold and marble editorial, gleaming surfaces, deep burgundy and black, luxury brand aesthetic',
    }
    for (const [key, style] of Object.entries(moodHints)) {
      if (mood.includes(key)) { chosenStyle = style; break }
    }
  }

  if (!chosenStyle) {
    // Large pool of diverse defaults — 16 options so repeat rate is very low
    const defaults = [
      'painterly surrealist digital art, impossible floating landscape, ultra-rich saturated palette, hyperdetailed',
      'epic cinematic concept art, dramatic rim lighting, jewel-toned colour palette, sweeping wide composition',
      'stunning 3D render, volumetric god rays, deep violet and gold tones, crystalline surfaces, ultra-detailed',
      'retro-futurist sci-fi illustration, bold graphic shapes, warm vintage chrome and orange, poster art style',
      'photorealistic macro world, water droplet reflections, prismatic colour diffraction, breathtaking detail',
      'abstract expressionist digital painting, bold impasto brushstrokes, electric colour fields, gallery art quality',
      'dark cinematic still-life photography, dramatic chiaroscuro, deep shadows, one vivid colour accent',
      'luxury streetwear editorial, matte black and chrome, architectural concrete backdrop, fashion photography',
      'ethereal double-exposure art, human silhouette filled with sweeping landscape, rich tonal depth',
      'vibrant graffiti mural photography, spray-can colour explosion, urban raw texture, hyperreal detail',
      'cinematic smoke photography, backlit volumetric haze, deep purples and electric blues, otherworldly atmosphere',
      'low-angle urban photography at golden hour, silhouette of figure, blazing sky, architectural grandeur',
      'hyperrealistic crystalline abstract 3D, faceted geometric forms, rainbow light refraction, black background',
      'impressionist digital painting, thick textured brushstrokes, sunset colours bleeding across canvas, gallery quality',
      'futuristic neon grid landscape, synthwave horizon, deep purple and hot pink, retrowave atmosphere',
      'cinematic rain photography, neon reflections on wet glass and pavement, moody noir, ultra-sharp focus',
    ]
    const hash = jobId.split('').reduce((a: number, c: string) => (a * 31 + c.charCodeAt(0)) & 0xffff, 0)
    chosenStyle = defaults[hash % defaults.length]
  }

  // ── 2c: Build the final prompt — title concept first, style second ──
  const imagePrompt =
    `Professional music album cover art for a ${genre} track titled "${titleForPrompt}". ` +
    `Visual concept: ${chosenStyle}. ` +
    `Extremely high quality, striking composition, rich colours, photorealistic detail, professional album artwork. ` +
    `No text, no words, no letters, no numbers anywhere in the image.`

  try {
    // ── Step 3: Generate image with gpt-image-1 ──
    const imgRes = await fetch(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: imagePrompt,
        n: 1,
        size: '1024x1024',
        quality: 'medium',
        output_format: 'jpeg'
      })
    })
    const imgData = await imgRes.json() as any
    if (!imgRes.ok || !imgData.data?.[0]?.b64_json) {
      return c.json({ error: imgData.error?.message || 'Image generation failed' }, 500)
    }
    const b64 = imgData.data[0].b64_json as string

    // ── Step 4: Store JPEG in R2 (if binding available) ──
    const r2Key = `covers/${jobId}.jpg`
    let publicUrl: string

    if (c.env.IMAGES) {
      // Decode base64 → binary and upload to R2
      const binaryStr = atob(b64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

      await c.env.IMAGES.put(r2Key, bytes.buffer, {
        httpMetadata: { contentType: 'image/jpeg' }
      })

      // ── Step 5: Build the public URL ──
      // We serve R2 objects through our own /api/cover-art/:key route (no need for public bucket)
      publicUrl = `${c.env.SITE_URL}/api/cover-art/${jobId}`
    } else {
      // R2 not available — fall back to returning data URL (old behaviour, still works)
      publicUrl = 'data:image/jpeg;base64,' + b64
    }

    // ── Step 6: Save permanent URL into D1 job record (always — even data: fallback) ──
    // This is the most important write: if it doesn't happen, the image re-generates on every refresh.
    try {
      const updatedJob = { ...job, image_url: publicUrl } as any
      await setJob(c.env.DB, updatedJob)
    } catch (saveErr: any) {
      // Log but don't fail the request — the image was generated, just not cached
      console.error('Failed to cache image_url in D1:', saveErr?.message)
    }

    return c.json({ url: publicUrl })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Image generation failed' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/broadcast-asset/*
//  Serve broadcast assets (thumbnails, images) from R2 broadcast/ prefix.
//  Auth: none — URLs are not guessable and assets are public-safe.
// ═══════════════════════════════════════════════════════════════
app.get('/api/broadcast-asset/*', async (c) => {
  if (!c.env.IMAGES) return c.json({ error: 'Storage unavailable' }, 503)
  const key = 'broadcast/' + c.req.path.replace('/api/broadcast-asset/', '')
  const obj = await c.env.IMAGES.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  const data = await obj.arrayBuffer()
  const mime = obj.httpMetadata?.contentType || 'image/jpeg'
  return new Response(data, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(data.byteLength),
    }
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/cover-art/:jobId
//  Serve the cover JPEG directly from R2 with long-lived cache headers.
//  This avoids needing a public R2 bucket — the worker proxies the bytes.
//  Auth: none required (URL is not guessable, jobId is a UUID).
// ═══════════════════════════════════════════════════════════════
app.get('/api/cover-art/:jobId', async (c) => {
  if (!c.env.IMAGES) return c.json({ error: 'Storage unavailable' }, 503)
  const jobId = c.req.param('jobId')

  // Check custom uploads first (any extension), then fall back to AI-generated jpg
  const customExts: Array<{ ext: string; mime: string }> = [
    { ext: 'jpg',  mime: 'image/jpeg' },
    { ext: 'png',  mime: 'image/png'  },
    { ext: 'webp', mime: 'image/webp' },
  ]
  for (const { ext, mime } of customExts) {
    const custom = await c.env.IMAGES.get(`covers/${jobId}-custom.${ext}`)
    if (custom) {
      const data = await custom.arrayBuffer()
      return new Response(data, {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': String(data.byteLength),
        }
      })
    }
  }

  // Fall back to AI-generated cover
  const obj = await c.env.IMAGES.get(`covers/${jobId}.jpg`)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  const data = await obj.arrayBuffer()
  return new Response(data, {
    headers: {
      'Content-Type': 'image/jpeg',
      // Cache for 1 year — image never changes for a given jobId
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(data.byteLength),
    }
  })
})

// ═══════════════════════════════════════════════════════════════
//  AUTH API ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/signup — email/password registration
app.post('/api/auth/signup', async (c) => {
  if (!authConfigured(c.env)) {
    return c.json({ error: 'Auth not configured. Add GOOGLE_CLIENT_ID, STRIPE_SECRET_KEY, SESSION_SECRET to secrets.' }, 503)
  }
  try {
    const { name, email, password, plan, referrer: bodyReferrer } = await c.req.json()
    if (!name || !email || !password) return c.json({ error: 'name, email and password required' }, 400)
    if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)

    await ensureAuthTables(c.env.DB)
    const existing = await getUserByEmail(c.env.DB, email.toLowerCase())
    if (existing) return c.json({ error: 'An account with that email already exists' }, 409)

    // ── IP-based duplicate account check ─────────────────────────────────────
    // Cloudflare sets CF-Connecting-IP on every request — use it to detect
    // users creating multiple free accounts from the same IP address.
    const registrationIp = c.req.header('CF-Connecting-IP') ||
                           c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
                           c.req.header('X-Real-IP') || null
    if (registrationIp) {
      const ipCheck = await c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE registration_ip = ? AND plan = 'free'`
      ).bind(registrationIp).first<{ cnt: number }>()
      if (ipCheck && ipCheck.cnt >= 1) {
        return c.json({
          error: 'It looks like a free account was already created from your network. ' +
                 'StemForge allows one free account per household to keep the platform fair for everyone. ' +
                 'If you believe this is a mistake, please contact us at stemforgesupport@gmail.com.',
          ip_blocked: true
        }, 409)
      }
    }

    const passwordHash = await hashPassword(password)
    const userId = generateId()
    // Capture referrer for traffic attribution
    // Priority: body.referrer (document.referrer captured client-side, real traffic source)
    //           > Referer header (usually stemforge.studio/register, not real source)
    // body.referrer is empty string for direct visits (no previous page)
    const headerReferer = c.req.header('Referer') || c.req.header('referer') || null
    const signupReferer = (bodyReferrer && bodyReferrer.trim() !== '') ? bodyReferrer.trim() : null
    const classifyReferer = (ref: string | null): string => {
      if (!ref) return 'direct'
      try {
        const u = new URL(ref)
        const h = u.hostname.replace(/^www\./, '')
        // Treat stemforge.studio as direct (user navigated within the site, no external source)
        if (/stemforge\.studio/i.test(h) || h === 'stemforge.pages.dev') return 'direct'
        if (/tiktok\.com/i.test(h))    return 'tiktok'
        if (/facebook\.com|fb\.com/i.test(h)) return 'facebook'
        if (/instagram\.com/i.test(h)) return 'instagram'
        if (/youtube\.com|youtu\.be/i.test(h)) return 'youtube'
        if (/twitter\.com|x\.com/i.test(h)) return 'twitter'
        if (/snapchat\.com/i.test(h)) return 'snapchat'
        if (/pinterest\.com/i.test(h)) return 'pinterest'
        if (/reddit\.com/i.test(h)) return 'reddit'
        if (/linkedin\.com/i.test(h)) return 'linkedin'
        if (/google\.com/i.test(h)) return 'google-organic'
        if (/bing\.com/i.test(h)) return 'bing'
        return 'referral:' + h
      } catch { return 'referral' }
    }
    const signupSrc = classifyReferer(signupReferer)
    await createUser(c.env.DB, {
      id: userId, email: email.toLowerCase(), name: name.trim(),
      password_hash: passwordHash, plan: plan || 'free',
      registration_ip: registrationIp || undefined,
      signup_source: signupSrc, signup_referrer: (signupReferer || headerReferer)?.slice(0, 500) || undefined
    })

    const token = await createSession(c.env.DB, userId)
    const siteUrl = c.env.SITE_URL || ''
    // Use waitUntil() so Cloudflare keeps the Worker alive until these finish
    // Without waitUntil, Worker shuts down after return and kills floating promises
    c.executionCtx.waitUntil(
      sendTikTokEvent({ token: (c.env as any).TIKTOK_PIXEL_TOKEN || '', token3: (c.env as any).TIKTOK_PIXEL_TOKEN_3 || '', event: 'CompleteRegistration', email: email.toLowerCase(), ip: registrationIp || '', userAgent: c.req.header('User-Agent') || '', eventId: `reg_${userId}`, url: `${siteUrl}/signup` }).catch(() => {})
    )
    c.executionCtx.waitUntil(
      sendWelcomeEmail({ db: c.env.DB, resendKey: (c.env as any).RESEND_API_KEY, mailerKey: (c.env as any).MAILERSEND_API_KEY, name, email, siteUrl: c.env.SITE_URL || 'https://stemforge.studio', userId }).catch(e => console.error('[signup] welcome email waitUntil error:', e))
    )

    return new Response(JSON.stringify({ ok: true, redirect: plan && plan !== 'free' ? '/checkout?plan=' + plan : '/dashboard' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(token, siteUrl)
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Signup failed' }, 500)
  }
})

// POST /api/auth/login — email/password login
app.post('/api/auth/login', async (c) => {
  if (!authConfigured(c.env)) {
    return c.json({ error: 'Auth not configured' }, 503)
  }
  try {
    const { email, password, next } = await c.req.json()
    if (!email || !password) return c.json({ error: 'email and password required' }, 400)

    await ensureAuthTables(c.env.DB)
    const user = await getUserByEmail(c.env.DB, email.toLowerCase())
    if (!user || !user.password_hash) return c.json({ error: 'Invalid email or password' }, 401)

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) return c.json({ error: 'Invalid email or password' }, 401)

    const token = await createSession(c.env.DB, user.id)
    const siteUrl = c.env.SITE_URL || ''
    // Use the requested next URL if it's a safe relative path, otherwise default to dashboard
    const redirectTo = (next && typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) ? next : '/dashboard'

    return new Response(JSON.stringify({ ok: true, redirect: redirectTo }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(token, siteUrl)
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Login failed' }, 500)
  }
})

// POST /api/auth/logout
app.post('/api/auth/logout', async (c) => {
  const token = getSessionCookie(c.req.raw)
  if (token && c.env.DB) {
    try { await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run() } catch {}
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() }
  })
})

// POST /api/profile/update — update name, avatar, and/or cover image
// Accepts multipart/form-data with optional fields: name, avatar (file), cover (file)
app.post('/api/profile/update', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  try {
    const formData = await c.req.formData()
    const newName        = (formData.get('name')             as string | null)?.trim() || null
    const avatarFile     = formData.get('avatar')             as File   | null
    const coverFile      = formData.get('cover')              as File   | null
    const newAvatarPos   = (formData.get('avatar_position')  as string | null)?.trim() || null
    const newCoverPos    = (formData.get('cover_position')   as string | null)?.trim() || null

    let avatarUrl: string | null = null
    let coverUrl:  string | null = null

    // ── Upload avatar to R2 ──────────────────────────────────────────────────
    if (avatarFile && avatarFile.size > 0 && c.env.IMAGES) {
      if (avatarFile.size > 5 * 1024 * 1024) return c.json({ error: 'Avatar must be under 5 MB' }, 400)
      const ext = avatarFile.type === 'image/png' ? 'png' : avatarFile.type === 'image/webp' ? 'webp' : 'jpg'
      const r2Key = `profiles/avatars/${user.id}.${ext}`
      const buf = await avatarFile.arrayBuffer()
      await c.env.IMAGES.put(r2Key, buf, { httpMetadata: { contentType: avatarFile.type } })
      avatarUrl = `${c.env.SITE_URL}/api/profile-image/${r2Key}`
    }

    // ── Upload cover to R2 ───────────────────────────────────────────────────
    if (coverFile && coverFile.size > 0 && c.env.IMAGES) {
      if (coverFile.size > 10 * 1024 * 1024) return c.json({ error: 'Cover image must be under 10 MB' }, 400)
      const ext = coverFile.type === 'image/png' ? 'png' : coverFile.type === 'image/webp' ? 'webp' : 'jpg'
      const r2Key = `profiles/covers/${user.id}.${ext}`
      const buf = await coverFile.arrayBuffer()
      await c.env.IMAGES.put(r2Key, buf, { httpMetadata: { contentType: coverFile.type } })
      coverUrl = `${c.env.SITE_URL}/api/profile-image/${r2Key}`
    }

    // ── Build and run UPDATE query ───────────────────────────────────────────
    const setParts: string[] = []
    const binds: any[] = []
    if (newName && newName.length >= 1)    { setParts.push('name = ?');            binds.push(newName.slice(0, 60)) }
    if (avatarUrl)                         { setParts.push('avatar = ?');           binds.push(avatarUrl) }
    if (coverUrl)                          { setParts.push('cover_image = ?');      binds.push(coverUrl) }
    if (newAvatarPos && avatarUrl)         { setParts.push('avatar_position = ?');  binds.push(newAvatarPos) }
    if (newCoverPos  && coverUrl)          { setParts.push('cover_position = ?');   binds.push(newCoverPos) }

    if (setParts.length === 0) return c.json({ ok: true, message: 'Nothing to update' })

    binds.push(user.id)
    await c.env.DB.prepare(`UPDATE users SET ${setParts.join(', ')} WHERE id = ?`).bind(...binds).run()

    return c.json({
      ok: true,
      name:            newName      ?? user.name,
      avatar:          avatarUrl    ?? user.avatar       ?? null,
      cover_image:     coverUrl     ?? user.cover_image  ?? null,
      avatar_position: (avatarUrl ? newAvatarPos : null) ?? (user as any).avatar_position ?? '50% 50%',
      cover_position:  (coverUrl  ? newCoverPos  : null) ?? (user as any).cover_position  ?? '50% 50%',
    })
  } catch (err: any) {
    console.error('[profile/update] error:', err?.message)
    return c.json({ error: 'Failed to update profile' }, 500)
  }
})

// GET /api/profile-image/* — serve images stored in R2 under profiles/ prefix
app.get('/api/profile-image/*', async (c) => {
  if (!c.env.IMAGES) return c.notFound()
  const r2Key = c.req.path.replace('/api/profile-image/', '')
  if (!r2Key.startsWith('profiles/')) return c.notFound()
  try {
    const obj = await c.env.IMAGES.get(r2Key)
    if (!obj) return c.notFound()
    const ct = obj.httpMetadata?.contentType ?? 'image/jpeg'
    return new Response(obj.body, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=31536000, immutable',
      }
    })
  } catch { return c.notFound() }
})

// POST /api/account/delete — permanently delete account and all data
app.post('/api/account/delete', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const { confirm_text } = await c.req.json<{ confirm_text: string }>().catch(() => ({ confirm_text: '' }))
  if (confirm_text !== 'DELETE') return c.json({ error: 'Confirmation text does not match' }, 400)

  try {
    // Cancel Stripe subscription if active
    if (user.stripe_subscription_id && stripeConfigured(c.env)) {
      try {
        await stripeRequest('DELETE', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
      } catch {}
    }
    // Delete all user data from DB
    await c.env.DB.prepare('DELETE FROM jobs WHERE user_id = ?').bind(user.id).run()
    await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run()
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run()
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() }
    })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Account deletion failed' }, 500)
  }
})

// GET /api/auth/me — return current user (used by frontend to check session)
app.get('/api/auth/me', async (c) => {
  const token = getSessionCookie(c.req.raw)
  if (!token || !c.env.DB) {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    return c.json({ user: null })
  }
  // Always fetch fresh from DB — re-read gens_used/gens_limit directly
  const user = await getSessionUser(c.env.DB, token)
  if (!user) {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    return c.json({ user: null })
  }
  // Re-fetch fresh gens from DB (session cache may be stale)
  const fresh = await c.env.DB.prepare(
    `SELECT gens_used, gens_limit, plan, account_locked, lock_reason, bonus_credits, password_hash FROM users WHERE id = ?`
  ).bind(user.id).first<{ gens_used: number; gens_limit: number; plan: string; account_locked: number; lock_reason: string | null; bonus_credits: number; password_hash: string | null }>()
  const plan = fresh?.plan ?? user.plan
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')
  return c.json({
    user: {
      id: user.id, name: user.name, email: user.email,
      avatar: user.avatar,
      plan,
      gens_used: fresh?.gens_used ?? user.gens_used,
      gens_limit: fresh?.gens_limit ?? user.gens_limit,
      bonus_credits: fresh?.bonus_credits ?? user.bonus_credits ?? 0,
      account_locked: fresh?.account_locked ?? 0,
      lock_reason: fresh?.lock_reason ?? null,
      is_admin: isAdmin(user, c.env),
      has_password: !!(fresh?.password_hash)
    }
  })
})

// GET /api/auth/google — start Google OAuth flow
app.get('/api/auth/google', (c) => {
  if (!googleConfigured(c.env)) {
    return c.html(`<p style="font-family:sans-serif;padding:2rem">
      <strong>Google OAuth not configured yet.</strong><br/><br/>
      To enable Google sign-in, add these secrets via your deployment panel:<br/>
      <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>SITE_URL</code><br/><br/>
      <a href="/signup">← Back to signup</a>
    </p>`)
  }
  // Encode optional next URL + referrer into state so callback can read them back
  // Format: randomPart|nextPath|referrer
  // We capture the Referer header HERE (before Google redirect) — this is the real traffic source
  const next = c.req.query('next') || ''
  const referrer = c.req.header('Referer') || c.req.header('referer') || ''
  const randomPart = generateToken().slice(0, 16)
  // Encode referrer as base64 to avoid | conflicts
  const refEncoded = referrer ? btoa(unescape(encodeURIComponent(referrer.slice(0, 300)))).replace(/=/g, '') : ''
  const state = randomPart + '|' + next + '|' + refEncoded
  const url = googleAuthUrl(c.env.GOOGLE_CLIENT_ID, c.env.SITE_URL, state)
  return c.redirect(url)
})

// GET /api/auth/google/callback — Google OAuth callback
app.get('/api/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  const error = c.req.query('error')
  // Extract next URL + referrer from state (format: randomPart|nextPath|referrerBase64)
  const rawState = c.req.query('state') || ''
  const stateParts = rawState.split('|')
  const nextFromState = stateParts[1] || ''
  const refFromState = stateParts[2] || ''
  // Decode referrer from base64
  let stateReferrer = ''
  if (refFromState) {
    try { stateReferrer = decodeURIComponent(escape(atob(refFromState))) } catch {}
  }
  const redirectAfterLogin = (nextFromState && nextFromState.startsWith('/') && !nextFromState.startsWith('//')) ? nextFromState : '/dashboard'

  if (error || !code) {
    return c.redirect('/signup?error=google_denied')
  }
  if (!googleConfigured(c.env)) {
    return c.redirect('/signup?error=not_configured')
  }

  try {
    const profile = await exchangeGoogleCode(
      code, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, c.env.SITE_URL
    )
    await ensureAuthTables(c.env.DB)

    let user = await getUserByEmail(c.env.DB, profile.email.toLowerCase())
    let isNewUser = false
    if (!user) {
      isNewUser = true
      const googleIp = c.req.header('CF-Connecting-IP') ||
                       c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || null
      // IP check for Google OAuth new accounts too
      if (googleIp) {
        const ipCheckG = await c.env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM users WHERE registration_ip = ? AND plan = 'free'`
        ).bind(googleIp).first<{ cnt: number }>()
        if (ipCheckG && ipCheckG.cnt >= 1) {
          return c.redirect('/signup?error=ip_blocked')
        }
      }
      const userId = generateId()
      // Use referrer from OAuth state (captured before Google redirect) — NOT the live Referer header
      // which at callback time is always accounts.google.com, not the real traffic source
      const gReferer = stateReferrer || c.req.header('Referer') || c.req.header('referer') || null
      const gSrc = gReferer ? (() => {
        try {
          const u = new URL(gReferer)
          const h = u.hostname.replace(/^www\./, '')
          if (/tiktok\.com/i.test(h))    return 'tiktok'
          if (/facebook\.com|fb\.com/i.test(h)) return 'facebook'
          if (/instagram\.com|fb\.com/i.test(h)) return 'instagram'
          if (/youtube\.com|youtu\.be/i.test(h)) return 'youtube'
          if (/twitter\.com|x\.com/i.test(h)) return 'twitter'
          if (/snapchat\.com/i.test(h)) return 'snapchat'
          if (/pinterest\.com/i.test(h)) return 'pinterest'
          if (/reddit\.com/i.test(h)) return 'reddit'
          if (/linkedin\.com/i.test(h)) return 'linkedin'
          if (/google\.com|accounts\.google\.com/i.test(h)) return 'google-organic'
          if (/bing\.com/i.test(h)) return 'bing'
          if (/stemforge\.studio/i.test(h)) return 'direct'
          return 'referral:' + h
        } catch { return 'referral' }
      })() : 'direct'
      await createUser(c.env.DB, {
        id: userId, email: profile.email.toLowerCase(),
        name: profile.name, avatar: profile.picture, google_id: profile.sub,
        registration_ip: googleIp || undefined,
        signup_source: gSrc, signup_referrer: gReferer?.slice(0, 500) || undefined
      })
      user = await getUserByEmail(c.env.DB, profile.email.toLowerCase())
    } else if (!user.google_id) {
      await c.env.DB.prepare('UPDATE users SET google_id=?, avatar=? WHERE id=?')
        .bind(profile.sub, profile.picture, user.id).run()
    }

    const token = await createSession(c.env.DB, user.id)
    // Use waitUntil() so Cloudflare keeps the Worker alive until these finish
    c.executionCtx.waitUntil(
      sendTikTokEvent({ token: (c.env as any).TIKTOK_PIXEL_TOKEN || '', token3: (c.env as any).TIKTOK_PIXEL_TOKEN_3 || '', event: 'CompleteRegistration', email: profile.email.toLowerCase(), ip: c.req.header('CF-Connecting-IP') || '', userAgent: c.req.header('User-Agent') || '', eventId: `reg_google_${user!.id}`, url: `${c.env.SITE_URL}/signup` }).catch(() => {})
    )
    if (isNewUser) c.executionCtx.waitUntil(
      sendWelcomeEmail({ db: c.env.DB, resendKey: (c.env as any).RESEND_API_KEY, mailerKey: (c.env as any).MAILERSEND_API_KEY, name: profile.name, email: profile.email.toLowerCase(), siteUrl: c.env.SITE_URL || 'https://stemforge.studio', userId: user!.id }).catch(e => console.error('[google-signup] welcome email waitUntil error:', e))
    )
    return new Response(null, {
      status: 302,
      headers: {
        'Location': redirectAfterLogin,
        'Set-Cookie': setSessionCookie(token, c.env.SITE_URL)
      }
    })
  } catch (err: any) {
    return c.redirect('/signup?error=google_failed')
  }
})

// ═══════════════════════════════════════════════════════════════
//  STRIPE PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/stripe/checkout — create Stripe Checkout session and redirect
app.post('/api/stripe/checkout', async (c) => {
  if (!stripeConfigured(c.env)) {
    return c.json({ error: 'Stripe not configured yet. Check back soon — payments are being set up.' }, 503)
  }
  try {
    const { plan } = await c.req.json()
    const priceMap: Record<string, string> = {
      creator: c.env.STRIPE_CREATOR_PRICE_ID,
      pro: c.env.STRIPE_PRO_PRICE_ID,
    }
    const priceId = priceMap[plan]
    if (!priceId) return c.json({ error: 'Invalid plan. Must be creator or pro.' }, 400)

    // Get current session user
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) return c.json({ error: 'Must be logged in to subscribe', redirect: '/login' }, 401)

    const checkoutUrl = await createStripeCheckoutSession(
      c.env.STRIPE_SECRET_KEY, priceId, user.email, user.id, c.env.SITE_URL
    )
    return c.json({ url: checkoutUrl })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Checkout creation failed' }, 500)
  }
})

// POST /api/stripe/webhook — Stripe sends subscription events here
app.post('/api/stripe/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET || c.env.STRIPE_WEBHOOK_SECRET.includes('PASTE_')) {
    return c.json({ error: 'Webhook secret not configured' }, 503)
  }
  try {
    const payload = await c.req.text()
    const sig = c.req.header('stripe-signature') || ''
    const event = await verifyStripeWebhook(payload, sig, c.env.STRIPE_WEBHOOK_SECRET)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const userId = session.metadata?.user_id
      const subId = session.subscription
      const customerId = session.customer
      const metaType = session.metadata?.type

      // Credit pack one-time purchase
      if (metaType === 'credit_pack' && userId) {
        const credits = parseInt(session.metadata?.credits || '0', 10)
        if (credits > 0) {
          await c.env.DB.prepare(`UPDATE users SET bonus_credits=bonus_credits+? WHERE id=?`).bind(credits, userId).run()
        }
      } else if (userId && subId) {
        // Subscription purchase
        const sub = await stripeRequest('GET', `/subscriptions/${subId}`, {}, c.env.STRIPE_SECRET_KEY)
        const priceId = sub.items?.data?.[0]?.price?.id
        const plan = planFromPriceId(c.env, priceId)
        await updateUserPlan(c.env.DB, userId, plan, customerId, subId)

        // ── Email admin on new subscription ──────────────────────────────
        try {
          const newUser = await c.env.DB.prepare(
            `SELECT email, name FROM users WHERE id=?`
          ).bind(userId).first<{ email: string; name: string }>()
          await sendAdminSubscriptionEmail(c.env, {
            userName: newUser?.name || 'Unknown',
            userEmail: newUser?.email || session.customer_details?.email || 'unknown',
            plan,
            event: 'New Subscription',
            timestamp: new Date().toISOString()
          })
          const planValue = plan === 'pro' ? 25.00 : plan === 'creator' ? 10.00 : 0
          if (planValue > 0) { sendTikTokEvent({ token: (c.env as any).TIKTOK_PIXEL_TOKEN || '', token3: (c.env as any).TIKTOK_PIXEL_TOKEN_3 || '', event: 'Subscribe', email: newUser?.email || session.customer_details?.email || '', eventId: `sub_${session.id}`, value: planValue, currency: 'USD', url: 'https://stemforge.studio/checkout' }).catch(() => {}) }
        } catch (mailErr) {
          console.error('[webhook] subscription email failed:', mailErr)
        }
      }
    }

    // ── Instant upgrade/downgrade on subscription change ────────────────────
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object
      const customerId = sub.customer
      const priceId = sub.items?.data?.[0]?.price?.id
      const plan = planFromPriceId(c.env, priceId)
      const subId = sub.id
      if (customerId && subId && plan !== 'free') {
        // Find user by stripe_customer_id and update plan immediately
        const dbUser = await c.env.DB.prepare(
          `SELECT id FROM users WHERE stripe_customer_id=?`
        ).bind(customerId).first<{id:string}>()
        if (dbUser) {
          await updateUserPlan(c.env.DB, dbUser.id, plan, customerId, subId)
          // Clear pending_downgrade since the plan change has now taken effect
          await c.env.DB.prepare(`UPDATE users SET pending_downgrade = NULL WHERE id = ?`).bind(dbUser.id).run().catch(() => {})
        }
      }
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object
      const customerId = invoice.customer
      if (customerId && invoice.billing_reason === 'subscription_cycle') {
        // Monthly renewal — reset with rollover
        const sub = await stripeRequest('GET', `/subscriptions/${invoice.subscription}`, {}, c.env.STRIPE_SECRET_KEY)
        const priceId = sub.items?.data?.[0]?.price?.id
        const plan = planFromPriceId(c.env, priceId)
        await resetMonthlyDownloads(c.env.DB, customerId, plan)
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      const customerId = sub.customer
      if (customerId) {
        await c.env.DB.prepare(
          `UPDATE users SET plan='free', gens_limit=50, stripe_subscription_id=NULL, pending_downgrade=NULL WHERE stripe_customer_id=?`
        ).bind(customerId).run()
      }
    }

    return c.json({ received: true })
  } catch (err: any) {
    return c.json({ error: err?.message }, 400)
  }
})

// ═══════════════════════════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', async (c) => {
  // Logged-in users: redirect to /generator so they stay on their working page on refresh.
  // Guests: serve the marketing home page.
  if (c.env.DB && c.env.SESSION_SECRET) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (user) return c.redirect('/generator')
  }
  return c.html(homePage())
})

// GET /home — marketing home page, always served without redirect (used by the sidebar Home nav)
// Logged-in users can reach the marketing page from their sidebar without being bounced to /generator.
app.get('/home', (c) => c.html(homePage()))
app.get('/pricing', async (c) => {
  return c.html(pricingPage())
})
app.get('/generator', async (c) => {
  // Require authentication — guests must sign up first
  if (c.env.DB && c.env.SESSION_SECRET) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) return c.redirect('/signup?next=/generator')
  }
  const resp = c.html(generatorPage())
  resp.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  return resp
})
app.get('/dashboard', async (c) => {
  if (c.env.DB && c.env.SESSION_SECRET) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) return c.redirect('/signup?next=/dashboard')
  }
  const resp = c.html(dashboardPage())
  resp.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  return resp
})
app.get('/project', (c) => c.html(projectPage()))
app.get('/signup', (c) => c.html(signupPage()))
app.get('/register', (c) => c.html(registerPage()))
app.get('/login', (c) => c.html(loginPage(c.req.query('next') || '')))
app.get('/checkout', async (c) => {
  // Only block if we actually have a DB — if misconfigured just show the page
  if (c.env.DB) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) {
      const plan = c.req.query('plan') || 'creator'
      return c.redirect('/login?next=' + encodeURIComponent('/checkout?plan=' + plan))
    }
  }
  return c.html(checkoutPage())
})
app.get('/terms', (c) => c.html(termsPage()))
app.get('/privacy', (c) => c.html(privacyPage()))
app.get('/feedback', (c) => c.html(feedbackPage()))

// ─── SEO: sitemap.xml ────────────────────────────────────────────────────────
app.get('/sitemap.xml', (c) => {
  const base = 'https://stemforge.studio'
  const today = new Date().toISOString().split('T')[0]

  // Public pages with their priority and change frequency
  const pages = [
    { url: '/',         changefreq: 'weekly',  priority: '1.0' },
    { url: '/pricing',  changefreq: 'monthly', priority: '0.9' },
    { url: '/generator',changefreq: 'weekly',  priority: '0.9' },
    { url: '/signup',   changefreq: 'monthly', priority: '0.8' },
    { url: '/login',    changefreq: 'monthly', priority: '0.6' },
    { url: '/feedback', changefreq: 'monthly', priority: '0.5' },
    { url: '/terms',    changefreq: 'yearly',  priority: '0.3' },
    { url: '/privacy',  changefreq: 'yearly',  priority: '0.3' },
  ]

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${base}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400', // cache 24h
    }
  })
})

// ─── SEO: robots.txt ─────────────────────────────────────────────────────────
app.get('/robots.txt', (c) => {
  const txt = `User-agent: *
Allow: /
Allow: /pricing
Allow: /generator
Allow: /signup
Allow: /login
Allow: /feedback
Allow: /terms
Allow: /privacy

# Block private/auth pages
Disallow: /dashboard
Disallow: /account
Disallow: /subscription
Disallow: /profile
Disallow: /admin
Disallow: /checkout
Disallow: /promos
Disallow: /api/
Disallow: /musicapi-monitor

Sitemap: https://stemforge.studio/sitemap.xml`

  return new Response(txt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    }
  })
})

// POST /api/analytics/pageview — called client-side on every page load
app.post('/api/analytics/pageview', async (c) => {
  if (!c.env.DB) return c.json({ ok: false })
  try {
    const body = await c.req.json<{ path?: string; referrer?: string; source?: string; medium?: string; campaign?: string }>().catch(() => ({}))
    const path = (body.path || '/').slice(0, 200)
    const referrer = (body.referrer || '').slice(0, 500)
    // Cloudflare automatically sets CF-IPCountry on every request (ISO 3166-1 alpha-2, e.g. "US", "GB")
    const country = (c.req.raw.headers.get('CF-IPCountry') || '').toUpperCase().slice(0, 2) || null
    // Detect social source from referrer if no explicit UTM source
    let source = (body.source || '').slice(0, 100)
    if (!source && referrer) {
      if (/tiktok\.com/i.test(referrer))    source = 'tiktok'
      else if (/facebook\.com|fb\.com/i.test(referrer)) source = 'facebook'
      else if (/instagram\.com/i.test(referrer)) source = 'instagram'
      else if (/youtube\.com|youtu\.be/i.test(referrer)) source = 'youtube'
      else if (/twitter\.com|x\.com/i.test(referrer)) source = 'twitter'
      else if (/snapchat\.com/i.test(referrer)) source = 'snapchat'
      else if (/pinterest\.com/i.test(referrer)) source = 'pinterest'
      else if (/reddit\.com/i.test(referrer)) source = 'reddit'
      else if (/linkedin\.com/i.test(referrer)) source = 'linkedin'
      else if (/google\.com/i.test(referrer)) source = 'google'
      else if (/bing\.com/i.test(referrer)) source = 'bing'
      else if (referrer) source = 'referral'
      else source = 'direct'
    }
    await c.env.DB.prepare(
      `INSERT INTO page_views (path, referrer, source, medium, campaign, country, created_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(path, referrer, source, body.medium||'', body.campaign||'', country, Date.now()).run()
    return c.json({ ok: true })
  } catch { return c.json({ ok: false }) }
})

// POST /api/feedback — sends feedback to your inbox via MailerSend (primary) or Resend (fallback)
// MailerSend setup:  gsk hosted secret put MAILERSEND_API_KEY mlsn.xxxx
//                   gsk hosted secret put FEEDBACK_FROM_EMAIL you@yourdomain.com   (must be verified in MailerSend)
//                   gsk hosted secret put FEEDBACK_TO_EMAIL   stemforgesupport@gmail.com
// Resend fallback:   gsk hosted secret put RESEND_API_KEY re_xxxx  (100 emails/day free tier)
app.post('/api/feedback', async (c) => {
  const { type, text, email: replyEmail } = await c.req.json<{ type?: string; text?: string; email?: string }>()
  if (!text?.trim()) return c.json({ error: 'Feedback text is required' }, 400)

  const typeLabel: Record<string, string> = {
    bug: '🐛 Bug Report', feature: '💡 Feature Request',
    general: '💬 General Feedback', pricing: '💰 Pricing Feedback'
  }
  const label = typeLabel[type || ''] || '💬 Feedback'
  const subject = `[StemForge Feedback] ${label}`
  const bodyHtml = `
    <h2 style="color:#4e9fff">StemForge User Feedback</h2>
    <p><strong>Type:</strong> ${label}</p>
    <p><strong>Message:</strong></p>
    <blockquote style="border-left:3px solid #4e9fff;padding-left:12px;color:#555">${text.replace(/\n/g,'<br>')}</blockquote>
    ${replyEmail ? `<p><strong>Reply to:</strong> <a href="mailto:${replyEmail}">${replyEmail}</a></p>` : '<p><em>No reply email provided</em></p>'}
    <hr style="margin-top:20px"/>
    <p style="font-size:12px;color:#999">Sent from StemForge feedback form</p>
  `

  // ── PRIMARY: MailerSend API ──────────────────────────────────────────────────
  // Docs: https://developers.mailersend.com/api/v1/email
  // Requires: MAILERSEND_API_KEY + FEEDBACK_FROM_EMAIL (verified sender domain in MailerSend)
  const mailerSendKey = (c.env as any).MAILERSEND_API_KEY
  const feedbackFromEmail = (c.env as any).FEEDBACK_FROM_EMAIL || 'feedback@stemforge.app'
  const feedbackToEmail   = (c.env as any).FEEDBACK_TO_EMAIL   || 'stemforgesupport@gmail.com'

  if (mailerSendKey) {
    try {
      const msPayload: Record<string, any> = {
        from:    { email: feedbackFromEmail, name: 'StemForge Feedback' },
        to:      [{ email: feedbackToEmail }],
        subject,
        html:    bodyHtml
      }
      // Add reply_to only if the user left their email
      if (replyEmail) msPayload.reply_to = { email: replyEmail }

      const res = await fetch('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${mailerSendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(msPayload)
      })
      if (res.status === 202) return c.json({ ok: true })
      const errText = await res.text()
      console.error('[feedback] MailerSend error:', res.status, errText)
    } catch (e) { console.error('[feedback] MailerSend fetch failed:', e) }
  }

  // ── FALLBACK: Resend API ─────────────────────────────────────────────────────
  const resendKey = (c.env as any).RESEND_API_KEY
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'StemForge Feedback <noreply@stemforge.studio>',
          to: [feedbackToEmail],
          reply_to: replyEmail || undefined,
          subject,
          html: bodyHtml
        })
      })
      if (res.ok) return c.json({ ok: true })
      const err = await res.json() as any
      console.error('[feedback] Resend error:', err)
    } catch (e) { console.error('[feedback] Resend fetch failed:', e) }
  }

  // ── FINAL FALLBACK: log to Cloudflare Workers console ───────────────────────
  console.log(`FEEDBACK [${label}] from=${replyEmail||'anon'}: ${text}`)
  return c.json({ ok: true, note: 'Feedback logged. Add MAILERSEND_API_KEY secret for email delivery.' })
})
app.get('/promos', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login?next=/promos')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login?next=/promos')
  return c.html(promoPage())
})

app.get('/profile', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.html(profilePage(null))
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  return c.html(profilePage(user))
})

app.get('/subscription', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) {
    return c.redirect('/login?next=/subscription')
  }
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login?next=/subscription')

  // ── Detect any pending Stripe plan changes + fetch real billing date ──
  let pendingDowngrade: string | null = user.pending_downgrade ?? null  // D1-stored — instant, no Stripe call
  let pendingUpgrade: string | null = null    // 'creator' | 'pro' | null
  let realNextBillingDate: string | null = null  // e.g. "Jul 14, 2026"
  if (user.stripe_subscription_id && stripeConfigured(c.env)) {
    try {
      const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
      // ── Extract real period_end (Stripe API ≥2025-03-31 moved it to items) ──
      const item0 = sub.items?.data?.[0]
      const periodEnd: number = item0?.current_period_end ?? sub.current_period_end
      if (periodEnd && !isNaN(Number(periodEnd))) {
        realNextBillingDate = new Date(periodEnd * 1000).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric'
        })
      }
      // cancel_at_period_end = true means downgrading to free (cancellation) — sync to D1 if not set
      if (sub.cancel_at_period_end && !pendingDowngrade) {
        pendingDowngrade = 'free'
        if (c.env.DB) await c.env.DB.prepare(`UPDATE users SET pending_downgrade = 'free' WHERE id = ?`).bind(user.id).run().catch(() => {})
      }
      // Check for subscription schedules (downgrade to creator / upgrade) — Stripe-schedule fallback
      if (!pendingDowngrade) {
        const schedules = await stripeRequest('GET', `/subscription_schedules?customer=${user.stripe_customer_id}&limit=5`, {}, c.env.STRIPE_SECRET_KEY)
        const active = schedules?.data?.find((s: any) => s.status === 'active' && s.subscription === user.stripe_subscription_id)
        if (active && active.phases?.length >= 2) {
          // The last phase shows what the plan changes TO
          const lastPhase = active.phases[active.phases.length - 1]
          const nextPriceId = lastPhase?.items?.[0]?.price
          // Map price IDs to plan names (same mapping as cancel-downgrade/cancel-upgrade endpoints)
          const PRICE_TO_PLAN: Record<string, string> = {
            [c.env.STRIPE_CREATOR_PRICE_ID || '']: 'creator',
            [c.env.STRIPE_PRO_PRICE_ID || '']: 'pro'
          }
          const nextPlan = PRICE_TO_PLAN[nextPriceId] || null
          if (nextPlan) {
            const planRank: Record<string, number> = { free: 0, creator: 1, pro: 2 }
            const currentRank = planRank[user.plan] ?? 0
            const nextRank = planRank[nextPlan] ?? 0
            if (nextRank < currentRank) pendingDowngrade = nextPlan
            else if (nextRank > currentRank) pendingUpgrade = nextPlan
          }
        }
      }
    } catch { /* Stripe check failed — fall back to D1-stored pendingDowngrade already set above */ }
  }

  // ── Fetch payment method + recent invoices for billing section ──────────
  let paymentMethod: { brand: string; last4: string; exp_month: number; exp_year: number } | null = null
  if (user.stripe_customer_id && stripeConfigured(c.env)) {
    try {
      const customer = await stripeRequest('GET', `/customers/${user.stripe_customer_id}?expand[]=invoice_settings.default_payment_method`, {}, c.env.STRIPE_SECRET_KEY)
      const pm = customer?.invoice_settings?.default_payment_method
      if (pm?.card) {
        paymentMethod = { brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year }
      }
    } catch { /* silently skip */ }
  }

  return c.html(subscriptionPage(user, c.env, pendingDowngrade, pendingUpgrade, realNextBillingDate, paymentMethod))
})

app.get('/account', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login?next=/account')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login?next=/account')
  return c.html(accountPage(user))
})

// POST /api/job/update — save title/lyrics/bpm/genre edits
app.post('/api/job/update', async (c) => {
  if (!c.env.DB) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token && c.env.SESSION_SECRET ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const { job_id, title, lyrics, bpm, genre, description } = await c.req.json<any>()
  if (!job_id) return c.json({ error: 'Missing job_id' }, 400)
  try {
    const row = await c.env.DB.prepare('SELECT data, user_id FROM jobs WHERE id = ?').bind(job_id).first<{ data: string; user_id: string | null }>()
    if (!row) return c.json({ error: 'Job not found' }, 404)
    if (row.user_id && row.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403)
    const job = JSON.parse(row.data) as Job
    // Apply edits
    if (title !== undefined) (job as any).title = title
    if (lyrics !== undefined) (job as any).user_lyrics = lyrics
    if (bpm && job.blueprint) job.blueprint.bpm = parseInt(bpm)
    if (genre && job.blueprint) job.blueprint.genre = genre
    if (description && job.blueprint) (job.blueprint as any).arrangement = description
    await c.env.DB.prepare('UPDATE jobs SET data = ? WHERE id = ?').bind(JSON.stringify(job), job_id).run()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Update failed' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/fix-genre — AI-detects real genre from prompt/blueprint
//  and saves it back to the job. Called when genre looks like a prompt.
// ═══════════════════════════════════════════════════════════════
app.post('/api/job/fix-genre', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const { job_id } = await c.req.json<any>()
  if (!job_id) return c.json({ error: 'Missing job_id' }, 400)

  try {
    const row = await c.env.DB.prepare('SELECT data, user_id FROM jobs WHERE id = ?').bind(job_id).first<{ data: string; user_id: string | null }>()
    if (!row) return c.json({ error: 'Job not found' }, 404)
    if (row.user_id && row.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403)

    const job = JSON.parse(row.data) as any
    if (!job.blueprint) return c.json({ error: 'No blueprint' }, 400)

    let bp = job.blueprint
    if (typeof bp === 'string') { try { bp = JSON.parse(bp) } catch(_) { return c.json({ error: 'Bad blueprint' }, 400) } }
    if (Array.isArray(bp)) bp = bp[0]

    // Build context for GPT genre classifier
    const promptText  = job.prompt || ''
    const mood        = bp?.mood || ''
    const bpm         = bp?.bpm || ''
    const stylePrompt = bp?.style_prompt || ''
    const instruments = Array.isArray(bp?.instruments)
      ? bp.instruments.map((i: any) => (typeof i === 'object' ? i.name : i)).join(', ')
      : ''

    const apiKey = c.env.OPENAI_API_KEY
    if (!apiKey) return c.json({ error: 'No API key' }, 500)

    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 30,
        messages: [
          {
            role: 'system',
            content: 'You are a music genre classifier. Given info about a track, return ONLY the genre as 1-3 words lowercase (e.g. "hip hop", "trap", "r&b", "pop", "drill", "lo-fi", "afrobeats", "dancehall", "reggaeton", "jazz", "cinematic", "soca"). No explanation, no punctuation, just the genre.'
          },
          {
            role: 'user',
            content: `Classify the genre of this music track:\nPrompt: "${promptText.slice(0, 300)}"\nBPM: ${bpm}\nMood: ${mood}\nStyle: "${stylePrompt.slice(0, 200)}"\nInstruments: ${instruments.slice(0, 200)}\n\nReturn only the genre (1-3 words, lowercase):`
          }
        ]
      })
    })

    if (!res.ok) return c.json({ error: 'AI classification failed' }, 502)
    const data: any = await res.json()
    const detectedGenre = (data?.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z0-9 &\-]/g, '').trim()
    if (!detectedGenre) return c.json({ error: 'No genre detected' }, 500)

    // Save back to blueprint
    if (!job.blueprint || typeof job.blueprint !== 'object') job.blueprint = bp
    job.blueprint.genre = detectedGenre
    await c.env.DB.prepare('UPDATE jobs SET data = ? WHERE id = ?').bind(JSON.stringify(job), job_id).run()

    return c.json({ ok: true, genre: detectedGenre })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Fix genre failed' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/cover — upload a custom cover image for a track.
//  Accepts multipart/form-data with fields: job_id, image (file).
//  Stores JPEG/PNG/WebP in R2 under covers/<jobId>-custom.<ext>
//  and saves the permanent URL back into the D1 job record.
//  Auth: session cookie required.
// ═══════════════════════════════════════════════════════════════
app.post('/api/job/cover', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  if (!c.env.IMAGES) return c.json({ error: 'Storage unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  let jobId: string
  let imageBytes: ArrayBuffer
  let contentType: string

  try {
    const formData = await c.req.formData()
    jobId = (formData.get('job_id') as string || '').trim()
    const file = formData.get('image') as File | null
    if (!jobId) return c.json({ error: 'Missing job_id' }, 400)
    if (!file) return c.json({ error: 'Missing image file' }, 400)

    // Validate file type
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    contentType = file.type || 'image/jpeg'
    if (!allowed.includes(contentType)) return c.json({ error: 'Only JPG, PNG or WebP allowed' }, 400)

    // Validate file size (max 5 MB)
    if (file.size > 5 * 1024 * 1024) return c.json({ error: 'Image too large — max 5 MB' }, 400)

    imageBytes = await file.arrayBuffer()
  } catch (e: any) {
    return c.json({ error: e?.message || 'Upload parse failed' }, 400)
  }

  // Verify job ownership
  let job: Job | null = null
  try {
    const row = await c.env.DB.prepare('SELECT data, user_id FROM jobs WHERE id = ?').bind(jobId).first<{ data: string; user_id: string | null }>()
    if (!row) return c.json({ error: 'Job not found' }, 404)
    if (row.user_id && row.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403)
    job = JSON.parse(row.data) as Job
  } catch { return c.json({ error: 'DB error' }, 500) }

  // Store in R2
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
  const r2Key = `covers/${jobId}-custom.${ext}`
  try {
    await c.env.IMAGES.put(r2Key, imageBytes, { httpMetadata: { contentType } })
  } catch (e: any) {
    return c.json({ error: 'Storage upload failed' }, 500)
  }

  // Build the permanent URL via our cover-art proxy route
  const publicUrl = `${c.env.SITE_URL}/api/cover-art/${jobId}?custom=${ext}`

  // Save URL to D1 job record (overwrites any AI-generated image_url)
  const updatedJob = { ...job, image_url: publicUrl, image_url_custom: true } as any
  await setJob(c.env.DB, updatedJob)

  return c.json({ ok: true, url: publicUrl })
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/job/cover/:jobId — remove the custom cover image,
//  reverting to AI-generated art on next load.
// ═══════════════════════════════════════════════════════════════
app.delete('/api/job/cover/:jobId', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  let job: Job | null = null
  try {
    const row = await c.env.DB.prepare('SELECT data, user_id FROM jobs WHERE id = ?').bind(jobId).first<{ data: string; user_id: string | null }>()
    if (!row) return c.json({ error: 'Job not found' }, 404)
    if (row.user_id && row.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403)
    job = JSON.parse(row.data) as Job
  } catch { return c.json({ error: 'DB error' }, 500) }

  // Delete from R2 (try all extensions)
  if (c.env.IMAGES) {
    for (const ext of ['jpg', 'png', 'webp']) {
      try { await c.env.IMAGES.delete(`covers/${jobId}-custom.${ext}`) } catch { /* ok */ }
    }
  }

  // Clear image_url from D1 so next load re-generates via AI
  const updatedJob = { ...job } as any
  delete updatedJob.image_url
  delete updatedJob.image_url_custom
  await setJob(c.env.DB, updatedJob)

  return c.json({ ok: true })
})

// GET /api/projects?tab=beats|oneshots|trash|extended — return logged-in user's jobs by tab
app.get('/api/projects', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ projects: [] })
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const tab = c.req.query('tab') || 'beats' // beats | oneshots | trash | extended

  try {
    await ensureTable(c.env.DB)

    // Auto-purge trash older than 60 days
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000
    await c.env.DB.prepare(
      `DELETE FROM jobs WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`
    ).bind(user.id, cutoff).run()

    let rows: { id: string; data: string; created_at: number; deleted_at: number | null; is_oneshot: number }[] = []
    if (tab === 'trash') {
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC LIMIT 100`
      ).bind(user.id).all<any>()
      rows = res.results || []
    } else if (tab === 'oneshots') {
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_oneshot = 1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 100`
      ).bind(user.id).all<any>()
      rows = res.results || []
    } else if (tab === 'remixes') {
      // Remix tracks: jobs with is_remix=1 flag OR prompt starts with "Stemforge Remix of"
      // Include generating + ready so in-progress remixes show as spinner cards.
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_oneshot = 0 AND deleted_at IS NULL
         AND (json_extract(data,'$.is_remix') = 1
              OR json_extract(data,'$.prompt') LIKE 'Stemforge Remix of%')
         AND json_extract(data,'$.status') IN ('ready','generating','error')
         ORDER BY created_at DESC LIMIT 100`
      ).bind(user.id).all<any>()
      rows = res.results || []
    } else if (tab === 'extended') {
      // Extended tracks: jobs with extend_task_type = 'song_extend', not deleted.
      // Include both 'ready' AND 'generating' so in-progress extends show as spinner cards.
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_oneshot = 0 AND deleted_at IS NULL
         AND json_extract(data,'$.extend_task_type') = 'song_extend'
         AND json_extract(data,'$.status') IN ('ready','generating','error')
         ORDER BY created_at DESC LIMIT 100`
      ).bind(user.id).all<any>()
      rows = res.results || []
    } else if (tab === 'covers') {
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_cover = 1 AND deleted_at IS NULL
         AND json_extract(data,'$.status') = 'ready'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(user.id).all<any>()
      rows = res.results || []
    } else {
      // beats tab: regular beats (not one-shots, not extended, not remixes, not covers), not deleted
      // Note: song_generate ext_type is a relic of the old two-song feature — those are valid beats
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_oneshot = 0 AND is_cover = 0 AND deleted_at IS NULL
         AND json_extract(data,'$.status') = 'ready'
         AND (json_extract(data,'$.extend_task_type') IS NULL
              OR json_extract(data,'$.extend_task_type') = 'song_generate')
         AND (json_extract(data,'$.is_remix') IS NULL OR json_extract(data,'$.is_remix') != 1)
         AND (json_extract(data,'$.prompt') NOT LIKE 'Stemforge Remix of%')
         ORDER BY created_at DESC LIMIT 100`
      ).bind(user.id).all<any>()
      rows = res.results || []
    }

    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000
    const projects = rows.map((r: any) => {
      const d = JSON.parse(r.data) as any
      return {
        id: d.id,
        prompt: d.prompt,
        title: d.title || null,
        is_oneshot: r.is_oneshot === 1,
        deleted_at: r.deleted_at || null,
        days_until_purge: r.deleted_at ? Math.max(0, Math.ceil((r.deleted_at + SIXTY_DAYS_MS - Date.now()) / 86400000)) : null,
        thumbnail_seed: d.thumbnail_seed || (d.id.split('').reduce((a: number, ch: string) => a + ch.charCodeAt(0), 0) % 360),
        image_url: (() => { const u = d.image_url; return (u && u.includes('/api/cover-art/')) ? u : null })(),
        created_at: d.created_at,
        stereo_url: d.stereo_url || d.audio_url || null,
        blueprint: (() => {
          let bp = d.blueprint
          if (!bp) return null
          // blueprint may be stored as a JSON string (double-encoded) — parse it
          if (typeof bp === 'string') { try { bp = JSON.parse(bp) } catch(_) { return null } }
          // Some older jobs store blueprint as an array [obj, null] — take first element
          if (Array.isArray(bp)) bp = bp[0]
          if (!bp || typeof bp !== 'object') return null
          return {
            bpm: bp.bpm, key: bp.key, scale: bp.scale,
            genre: bp.genre, mood: bp.mood,
            duration_seconds: bp.duration_seconds,
            arrangement: bp.arrangement || null,
            // Include instruments array so Edit Info tab can render pills for remix/extend jobs
            instruments: Array.isArray(bp.instruments) ? bp.instruments.map((ins: any) => ({
              name: typeof ins === 'object' ? ins.name : ins,
              family: typeof ins === 'object' ? ins.family : null
            })) : [],
            instruments_include: Array.isArray(bp.instruments_include) ? bp.instruments_include : []
          }
        })(),
        // Status field — required by renderExtendedCard and other card renderers
        status: d.status || 'ready',
        // Extend-specific fields
        extend_task_type: d.extend_task_type || null,  // 'song_extend' | 'song_generate' | null
        source_job_id: d.source_job_id || null,
        continue_at_ms: d.continue_at_ms || null,
        // One-shot specific fields
        sound_type: d.sound_type || null,
        audio_url: d.audio_url || null,
      }
    })
    return c.json({ projects })
  } catch (e: any) {
    return c.json({ projects: [], error: e?.message })
  }
})

// POST /api/job/delete — soft-delete a job (move to trash)
app.post('/api/job/delete', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const { job_id } = await c.req.json<{ job_id: string }>()
  if (!job_id) return c.json({ error: 'job_id required' }, 400)
  await ensureTable(c.env.DB)
  await c.env.DB.prepare(
    `UPDATE jobs SET deleted_at = ? WHERE id = ? AND user_id = ?`
  ).bind(Date.now(), job_id, user.id).run()
  return c.json({ ok: true })
})

// POST /api/job/cancel — cancel an in-progress job (stops polling, marks as error)
app.post('/api/job/cancel', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const { job_id } = await c.req.json<{ job_id: string }>()
  if (!job_id) return c.json({ error: 'job_id required' }, 400)
  await ensureTable(c.env.DB)
  const row = await c.env.DB.prepare(
    `SELECT data FROM jobs WHERE id = ? AND user_id = ?`
  ).bind(job_id, user.id).first<{ data: string }>()
  if (!row) return c.json({ error: 'Job not found' }, 404)
  const job = JSON.parse(row.data) as any
  // Only cancel if still in progress
  if (job.status === 'ready') return c.json({ ok: false, error: 'Job already completed' })
  job.status = 'error'
  job.error  = 'Cancelled by user'
  await c.env.DB.prepare(
    `UPDATE jobs SET data = ?, deleted_at = ? WHERE id = ? AND user_id = ?`
  ).bind(JSON.stringify(job), Date.now(), job_id, user.id).run()
  return c.json({ ok: true })
})

// POST /api/job/restore — restore a job from trash
app.post('/api/job/restore', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const { job_id } = await c.req.json<{ job_id: string }>()
  if (!job_id) return c.json({ error: 'job_id required' }, 400)
  await ensureTable(c.env.DB)
  await c.env.DB.prepare(
    `UPDATE jobs SET deleted_at = NULL WHERE id = ? AND user_id = ?`
  ).bind(job_id, user.id).run()
  return c.json({ ok: true })
})

// POST /api/job/purge — permanently delete a job from trash
app.post('/api/job/purge', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const { job_id } = await c.req.json<{ job_id: string }>()
  if (!job_id) return c.json({ error: 'job_id required' }, 400)
  await ensureTable(c.env.DB)
  // Only allow purging deleted items
  await c.env.DB.prepare(
    `DELETE FROM jobs WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`
  ).bind(job_id, user.id).run()
  return c.json({ ok: true })
})

// POST /api/job/extend-upload — extend using a directly uploaded audio file
// Body: { upload_audio_id: string (clip_id from Sonic OR R2 proxy URL), extend_at?: number (ms),
//         lyrics?: string, title?: string, make_instrumental?: boolean, source_duration_ms?: number }
// When upload_audio_id is a Sonic clip_id (UUID, no 'http'), uses continue_clip_id (fast path).
// When it's an R2 URL (starts with 'http'), falls back to /sonic/upload-extend.
app.post('/api/job/extend-upload', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'Song Extend requires a Pro Artist plan.', upgrade: true }, 403)
  }

  const { upload_audio_id, extend_at, lyrics, title, make_instrumental, source_duration_ms } = await c.req.json<{
    upload_audio_id: string; extend_at?: number; lyrics?: string; title?: string; make_instrumental?: boolean; source_duration_ms?: number
  }>()
  if (!upload_audio_id) return c.json({ error: 'upload_audio_id required' }, 400)

  await ensureTable(c.env.DB)

  // ── credit deduction ──────────────────────────────────────────────────
  const EXTEND_COST = 20
  const freshUser = await c.env.DB.prepare(
    `SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id = ?`
  ).bind(user.id).first<{ gens_used: number; gens_limit: number; bonus_credits: number }>()
  if (!freshUser) return c.json({ error: 'User not found' }, 401)
  const extUpBonus = freshUser.bonus_credits ?? 0
  const extUpMain = freshUser.gens_limit - freshUser.gens_used
  if (extUpMain + extUpBonus < EXTEND_COST) {
    return c.json({
      error: `Not enough points. Extend costs ${EXTEND_COST} points and you only have ${Math.max(0, extUpMain + extUpBonus)} remaining.`,
      code: 'insufficient_credits'
    }, 402)
  }
  if (extUpBonus >= EXTEND_COST) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - ? WHERE id = ?`).bind(EXTEND_COST, user.id).run()
  } else if (extUpBonus > 0) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id = ?`).bind(EXTEND_COST - extUpBonus, user.id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + ? WHERE id = ?`).bind(EXTEND_COST, user.id).run()
  }

  try {
    const isInstrumental = make_instrumental === true
    const typedLyricsUpload = lyrics && lyrics.trim()
    const hasCustomLyrics = !isInstrumental && typedLyricsUpload && typedLyricsUpload !== '[Verse]' && typedLyricsUpload !== '[Instrumental]'
    const uploadSrcDurSec = source_duration_ms ? source_duration_ms / 1000 : 0
    // extend_at overrides source_duration; if neither is set, use full track length.
    // If we still have no duration, default to 60s so Sonic doesn't extend from second 1.
    const rawExtendAtSec = extend_at ? extend_at / 1000 : uploadSrcDurSec
    // continue_at must be >= 5 to avoid AI model collapse (extending from second 1 = garbage output).
    // Use rawExtendAtSec - 2 so Sonic has context overlap; fall back to rawExtendAtSec if < 5.
    const bestContinueAt = rawExtendAtSec > 5
      ? Math.floor(rawExtendAtSec - 2)
      : Math.max(5, Math.floor(rawExtendAtSec))
    const uploadContinueAt = rawExtendAtSec > 0 ? bestContinueAt : 60  // 60s fallback if duration unknown

    let extTaskId: string

    // ── Path A: clip_id from Sonic (not a URL) — use continue_clip_id (fast, reliable) ──
    // After upload-extend-audio kicks off /sonic/upload, poll-upload-task returns clip_id.
    // The frontend stores that clip_id as extUploadAudioId and sends it here.
    const isClipId = !upload_audio_id.startsWith('http')
    if (isClipId) {
      // IMPORTANT: use extend_upload_music when clip came from /sonic/upload
      // MusicAPI docs: "When extending your own uploaded music, you MUST use extend_upload_music"
      // extend_music with an uploaded clip_id returns Failed status
      // custom_mode is REQUIRED for all extend task types
      const extBody: Record<string, any> = {
        task_type: 'extend_upload_music',
        continue_clip_id: upload_audio_id,
        mv: 'sonic-v5',
        continue_at: uploadContinueAt,
        custom_mode: false  // required field
      }
      if (isInstrumental) extBody.make_instrumental = true
      if (hasCustomLyrics) {
        extBody.custom_mode = true
        extBody.prompt = typedLyricsUpload
      }
      console.log(`[extend-upload] /sonic/create continue_clip_id=${upload_audio_id} continue_at=${uploadContinueAt} instrumental=${isInstrumental}`)
      const sonicRes = await fetch(`${MUSICAPI_SONIC}/create`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(extBody)
      })
      const sonicText = await sonicRes.text()
      console.log(`[extend-upload] /sonic/create HTTP ${sonicRes.status} raw: ${sonicText.slice(0, 400)}`)
      if (!sonicRes.ok) {
        return c.json({ error: `Stemforge extend error: HTTP ${sonicRes.status}`, raw: sonicText.slice(0, 800) }, 500)
      }
      let sonicData: any
      try { sonicData = JSON.parse(sonicText) } catch (_) { sonicData = {} }
      extTaskId = sonicData.task_id || sonicData.id || sonicData.data?.[0]?.id
      if (!extTaskId) {
        return c.json({ error: 'Stemforge returned no task ID', raw: sonicText.slice(0, 800) }, 500)
      }
    } else {
      // ── Path B: HTTP URL — the upload_audio_id is a URL (Worker proxy or other CDN) ──
      // The upload-extend-audio route stores audio in R2 and returns a Worker proxy URL
      // (stemforge.studio/api/extend-audio-proxy/:key) as the audio_url.
      //
      // Approach: try /sonic/upload with the URL to get a clip_id, then use extend_upload_music.
      // MusicAPI's URL downloader is currently broken (HTTP 400 for all URLs) — if it fails,
      // return a clear error message rather than attempting broken binary multipart (which MusicAPI
      // also rejects with HTTP 500 — binary upload is not supported by their API).
      const audioSrc = upload_audio_id
      console.log(`[extend-upload] Path B: URL=${audioSrc.slice(0, 100)}`)
      let pathBClipId: string | null = null

      // Try /sonic/upload first — fast path if their URL downloader is working
      try {
        const sonicUploadRes = await fetch(`${MUSICAPI_SONIC}/upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: audioSrc })
        })
        const sonicUploadText = await sonicUploadRes.text()
        console.log(`[extend-upload] Path B /sonic/upload HTTP ${sonicUploadRes.status} raw: ${sonicUploadText.slice(0, 300)}`)
        if (sonicUploadRes.ok) {
          let ud: any = {}
          try { ud = JSON.parse(sonicUploadText) } catch {}
          pathBClipId = ud.clip_id || null
          if (pathBClipId) console.log(`[extend-upload] Path B /sonic/upload clip_id=${pathBClipId}`)
        }
      } catch (uploadErr: any) {
        console.warn('[extend-upload] Path B /sonic/upload threw:', uploadErr?.message)
      }

      if (pathBClipId) {
        // Got clip_id from /sonic/upload — use extend_upload_music (required for uploaded clips)
        const extBody: Record<string, any> = {
          task_type: 'extend_upload_music',
          continue_clip_id: pathBClipId,
          mv: 'sonic-v5',
          continue_at: uploadContinueAt,
          custom_mode: false  // required field per MusicAPI docs
        }
        if (isInstrumental) extBody.make_instrumental = true
        if (hasCustomLyrics) {
          extBody.custom_mode = true
          extBody.prompt = typedLyricsUpload
        }
        console.log(`[extend-upload] Path B /sonic/create clip_id=${pathBClipId} continue_at=${uploadContinueAt}`)
        const scRes = await fetch(`${MUSICAPI_SONIC}/create`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(extBody)
        })
        const scText = await scRes.text()
        console.log(`[extend-upload] Path B /sonic/create HTTP ${scRes.status} raw: ${scText.slice(0, 400)}`)
        if (!scRes.ok) return c.json({ error: `Stemforge extend error: HTTP ${scRes.status}`, raw: scText.slice(0, 800) }, 500)
        let scData: any = {}
        try { scData = JSON.parse(scText) } catch {}
        extTaskId = scData.task_id || scData.id || scData.data?.[0]?.id
        if (!extTaskId) return c.json({ error: 'Stemforge returned no task ID', raw: scText.slice(0, 800) }, 500)
      } else {
        // /sonic/upload failed — MusicAPI's URL download service is currently unavailable.
        // Binary multipart is NOT supported by MusicAPI (returns HTTP 500 Internal Server Error).
        // The only working path requires a clip_id from /sonic/upload, which needs their downloader.
        // Refund credits and return a user-friendly error.
        console.error(`[extend-upload] Path B: /sonic/upload failed for url=${audioSrc.slice(0, 80)} — MusicAPI upload service unavailable`)
        try {
          await c.env.DB.prepare(
            `UPDATE users SET gens_used = MAX(0, gens_used - ?) WHERE id = ?`
          ).bind(EXTEND_COST, user.id).run()
          console.log(`[extend-upload] Refunded ${EXTEND_COST} credits to user ${user.id} (upload service unavailable)`)
        } catch (_) { /* ignore refund failure */ }
        return c.json({
          error: 'Song Extend from uploaded tracks is temporarily unavailable — Stemforge audio service is experiencing an outage. Please try again in a few minutes. Your points have been refunded.',
          code: 'upload_service_unavailable'
        }, 503)
      }
    } // end Path B

    // chain_target_ms: aim for 80 seconds total output (~1 min 20s, 5 steps max)
    const CHAIN_TARGET_MS = 80000
    const trackTitle = title || 'Uploaded Track'

    // Create a new job record to track the extend result
    const newJobId = crypto.randomUUID()
    const now = Date.now()
    const newJob = {
      id: newJobId,
      user_id: user.id,
      status: 'generating',
      prompt: `[Extended from uploaded track: ${trackTitle}]`,
      title: `${trackTitle} (Extended)`,
      blueprint: { make_instrumental: isInstrumental },
      stereo_task_id: extTaskId,
      stereo_url: null,
      created_at: now,
      extend_task_type: 'song_extend',
      make_instrumental: isInstrumental,
      // ── Chain extend metadata ────────────────────────────────────────────
      chain_target_ms: CHAIN_TARGET_MS,
      chain_step: 0,
      chain_max_steps: 5,
      chain_lyrics: (lyrics && lyrics.trim() && lyrics.trim() !== '[Verse]' && lyrics.trim() !== '[Instrumental]') ? lyrics.trim() : '',
      chain_style: null, // no blueprint for uploaded tracks
      continue_at_ms: extend_at || (source_duration_ms || 0),
      upload_audio_url: upload_audio_id
    }
    await c.env.DB.prepare(
      `INSERT INTO jobs (id, user_id, data, created_at, is_oneshot) VALUES (?, ?, ?, ?, 0)`
    ).bind(newJobId, user.id, JSON.stringify(newJob), now).run()

    return c.json({ ok: true, job_id: newJobId, task_id: extTaskId })
  } catch (e: any) {
    // Refund credits on failure
    try {
      await c.env.DB.prepare(
        `UPDATE users SET gens_used = MAX(0, gens_used - ?) WHERE id = ?`
      ).bind(EXTEND_COST, user.id).run()
    } catch (_) { /* ignore refund failure */ }
    return c.json({ error: e.message || 'Extend failed' }, 500)
  }
})

// POST /api/job/extend — extend a completed track using MusicAPI
// Body: { source_job_id: string, extend_at?: number (ms), lyrics?: string, make_instrumental?: boolean }
app.post('/api/job/extend', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'Song Extend requires a Pro Artist plan.', upgrade: true }, 403)
  }

  const { source_job_id, extend_at, lyrics, make_instrumental } = await c.req.json<{
    source_job_id: string; extend_at?: number; lyrics?: string; make_instrumental?: boolean
  }>()
  if (!source_job_id) return c.json({ error: 'source_job_id required' }, 400)

  await ensureTable(c.env.DB)

  // Load the source job and verify ownership
  const row = await c.env.DB.prepare(
    `SELECT data FROM jobs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(source_job_id, user.id).first<{ data: string }>()
  if (!row) return c.json({ error: 'Source track not found' }, 404)

  const sourceJob = JSON.parse(row.data) as any
  if (!sourceJob.stereo_url) return c.json({ error: 'Source track has no audio URL' }, 400)

  // ── credit deduction ──────────────────────────────────────────────────
  const EXTEND_COST = 20
  const freshUser = await c.env.DB.prepare(
    `SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id = ?`
  ).bind(user.id).first<{ gens_used: number; gens_limit: number; bonus_credits: number }>()
  if (!freshUser) return c.json({ error: 'User not found' }, 401)
  const extLibBonus = freshUser.bonus_credits ?? 0
  const extLibMain = freshUser.gens_limit - freshUser.gens_used
  if (extLibMain + extLibBonus < EXTEND_COST) {
    return c.json({
      error: `Not enough points. Extend costs ${EXTEND_COST} points and you only have ${Math.max(0, extLibMain + extLibBonus)} remaining.`,
      code: 'insufficient_credits'
    }, 402)
  }
  // Deduct up-front so concurrent requests can't race — bonus first
  if (extLibBonus >= EXTEND_COST) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - ? WHERE id = ?`).bind(EXTEND_COST, user.id).run()
  } else if (extLibBonus > 0) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id = ?`).bind(EXTEND_COST - extLibBonus, user.id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + ? WHERE id = ?`).bind(EXTEND_COST, user.id).run()
  }

  const isInstrumental = make_instrumental === true

  // Build style string from blueprint for sonic continuity
  const bp = sourceJob.blueprint as Blueprint | undefined
  let styleStr = ''
  if (bp?.style_prompt) {
    styleStr = bp.style_prompt
  } else if (bp) {
    const parts: string[] = []
    if (bp.genre)  parts.push(bp.genre)
    if (bp.bpm)    parts.push(`${bp.bpm} BPM`)
    if (bp.key && bp.scale) parts.push(`${bp.key} ${bp.scale}`)
    if (bp.mood)   parts.push(`${bp.mood} mood`)
    if (bp.energy) parts.push(`${bp.energy} energy`)
    styleStr = parts.join(', ')
  }

  try {
    const typedLyricsExtend = lyrics && lyrics.trim()
    const hasCustomLyricsExtend = !isInstrumental && typedLyricsExtend && typedLyricsExtend !== '[Verse]' && typedLyricsExtend !== '[Instrumental]'

    // ── Determine extend_at (continue_at for MusicAPI) ───────────────────────
    // extend_at is ms from frontend. If not provided, use near end of track.
    const srcDurationSec = (sourceJob.duration_ms ? sourceJob.duration_ms / 1000 : 0)
    const extendAtSec = extend_at ? extend_at / 1000 : srcDurationSec
    // continue_at must leave MusicAPI at least 30s of audio AFTER the split point
    // so it has enough context to analyse the track style and generate a real extension.
    // Without this cap, extending from "end of track" (e.g. 155s in 155s track) gives
    // MusicAPI only 2s of context → it outputs a 2-second stub.
    const maxSafeContinueAt = srcDurationSec > 35
      ? Math.floor(srcDurationSec - 30)          // leave 30s context window
      : Math.max(5, Math.floor(srcDurationSec * 0.7))   // short tracks: keep 30% as context
    const rawContinueAt = extendAtSec > 5 ? Math.floor(extendAtSec - 2) : Math.max(5, Math.floor(extendAtSec))
    const continueAt = extendAtSec > 0 ? Math.min(rawContinueAt, maxSafeContinueAt) : 60

    let extTaskId: string

    // ── DIAGNOSTICS NOTE (2026-08-24) ──────────────────────────────────────────
    // MusicAPI /sonic/create with continue_clip_id returns HTTP 500
    // "Submission failed, system exception." for ALL tracks (confirmed via probe).
    // /sonic/upload-extend returns HTTP 200 and works correctly.
    // Strategy: try Path A first (fast, no upload), fall through to Path B on failure.
    // ────────────────────────────────────────────────────────────────────────────

    let sourceClipId = sourceJob.clip_id as string | undefined

    // ── Auto-backfill clip_id from stereo_task_id if missing ─────────────────
    // Tracks generated before clip_id storage was added have stereo_task_id but no clip_id.
    // Fetch the clip_id from MusicAPI now so Path A can run (avoids broken URL upload path).
    if (!sourceClipId && sourceJob.stereo_task_id && c.env.MUSICAPI_KEY) {
      try {
        const bfRes = await fetch(`${MUSICAPI_SONIC}/task/${sourceJob.stereo_task_id}`, {
          headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
        })
        if (bfRes.ok) {
          const bfData = await bfRes.json() as any
          const bfClips = Array.isArray(bfData) ? bfData : (bfData.data || [])
          const bfClipId = bfClips[0]?.id || bfClips[0]?.clip_id || null
          if (bfClipId) {
            sourceClipId = bfClipId
            // Write back to DB so future extends are instant
            sourceJob.clip_id = bfClipId
            await c.env.DB.prepare(`UPDATE jobs SET data=? WHERE id=?`)
              .bind(JSON.stringify(sourceJob), source_job_id).run()
            console.log(`[job/extend] auto-backfilled clip_id=${bfClipId} for job ${source_job_id}`)
          }
        }
      } catch (bfErr: any) {
        console.warn('[job/extend] clip_id backfill failed:', bfErr?.message)
      }
    }

    let pathAFailed = false

    // ── Path A: clip_id exists → try /sonic/create with continue_clip_id ──────
    if (sourceClipId) {
      const extBody: Record<string, any> = {
        task_type: 'extend_music',
        continue_clip_id: sourceClipId,
        mv: 'sonic-v5',
        continue_at: continueAt,
        custom_mode: false
      }
      if (isInstrumental) extBody.make_instrumental = true
      if (hasCustomLyricsExtend) { extBody.custom_mode = true; extBody.prompt = typedLyricsExtend }
      if (styleStr) extBody.tags = styleStr.slice(0, 200)
      console.log(`[job/extend] Path A attempt: /sonic/create continue_clip_id=${sourceClipId} continue_at=${continueAt}`)
      try {
        const sonicRes = await fetch(`${MUSICAPI_SONIC}/create`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(extBody)
        })
        const sonicText = await sonicRes.text()
        console.log(`[job/extend] Path A /sonic/create HTTP ${sonicRes.status} raw: ${sonicText.slice(0, 400)}`)
        if (sonicRes.ok) {
          let sonicData: any
          try { sonicData = JSON.parse(sonicText) } catch (_) { sonicData = {} }
          extTaskId = sonicData.task_id || sonicData.id || sonicData.data?.[0]?.id
          if (extTaskId) {
            console.log(`[job/extend] Path A succeeded: task_id=${extTaskId}`)
          } else {
            console.warn('[job/extend] Path A: no task_id in response, falling back to Path B')
            pathAFailed = true
          }
        } else {
          console.warn(`[job/extend] Path A failed HTTP ${sonicRes.status}: ${sonicText.slice(0, 200)} — falling back to Path B`)
          pathAFailed = true
        }
      } catch (pathAErr: any) {
        console.warn('[job/extend] Path A threw:', pathAErr?.message, '— falling back to Path B')
        pathAFailed = true
      }
    } else {
      pathAFailed = true // no clip_id, go straight to Path B
    }

    // ── Path B: /sonic/upload-extend — upload audio URL + extend in one call ──
    // Used when: no clip_id, or Path A failed (MusicAPI system error on continue_clip_id)
    if (pathAFailed) {
      const R2_PUB_BASE = 'https://pub-8e434559eec949638897e09ecee99a88.r2.dev'
      const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'

      // ── URL priority ──────────────────────────────────────────────────────────
      // 1. Direct CDN URL (Google, Suno, etc.) — works with MusicAPI directly
      // 2. Proxy URL via extend-audio-proxy — MusicAPI accepts stemforge.studio domain
      // 3. R2 public URL — try /sonic/upload first to get a clip_id, then extend_music
      const rawStereoUrl = sourceJob.stereo_url || ''
      const rawStereoAlt = sourceJob.stereo_url_alt || ''
      const isWorkerProxy = (u: string) =>
        u.includes(siteUrl) || u.includes('/api/track-audio/') || u.includes('stemforge.studio')

      let audioUrlForMusicApi: string
      if (rawStereoUrl && !isWorkerProxy(rawStereoUrl)) {
        audioUrlForMusicApi = rawStereoUrl
        console.log(`[job/extend] Path B: using direct CDN stereo_url`)
      } else if (rawStereoAlt && !isWorkerProxy(rawStereoAlt)) {
        audioUrlForMusicApi = rawStereoAlt
        console.log(`[job/extend] Path B: using direct CDN stereo_url_alt`)
      } else if (sourceJob.r2_audio_key && c.env.IMAGES) {
        // Mirror R2 → extend-uploads/ and serve via proxy (Content-Length + accepted domain)
        try {
          const r2Obj = await c.env.IMAGES.get(sourceJob.r2_audio_key)
          if (r2Obj) {
            const buf = await r2Obj.arrayBuffer()
            const ext = sourceJob.r2_audio_key.endsWith('.mp3') ? 'mp3' : 'm4a'
            const proxyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-ext.${ext}`
            await c.env.IMAGES.put(`extend-uploads/${proxyKey}`, buf, {
              httpMetadata: { contentType: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' }
            })
            audioUrlForMusicApi = `${siteUrl}/api/extend-audio-proxy/${encodeURIComponent(proxyKey)}`
            console.log(`[job/extend] Path B: mirrored R2 → extend-uploads/${proxyKey}`)

            // ── Path B1: try /sonic/upload first to get a clip_id ──────────────
            // If we can get a clip_id from /sonic/upload, extend via /sonic/create
            // with continue_clip_id — avoids the broken upload-extend pipeline entirely.
            try {
              const uploadRes = await fetch(`${MUSICAPI_SONIC}/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: audioUrlForMusicApi })
              })
              const uploadText = await uploadRes.text()
              console.log(`[job/extend] Path B1 /sonic/upload HTTP ${uploadRes.status} raw: ${uploadText.slice(0, 300)}`)
              if (uploadRes.ok) {
                let uploadData: any = {}
                try { uploadData = JSON.parse(uploadText) } catch {}
                const uploadedClipId = uploadData.clip_id || uploadData.data?.[0]?.clip_id || null
                if (uploadedClipId) {
                  // Got a clip_id — extend via /sonic/create (no upload-extend needed)
                  const extBodyB1: Record<string, any> = {
                    task_type: 'extend_upload_music',
                    continue_clip_id: uploadedClipId,
                    mv: 'sonic-v5',
                    continue_at: continueAt,
                    custom_mode: false
                  }
                  if (isInstrumental) extBodyB1.make_instrumental = true
                  if (hasCustomLyricsExtend) { extBodyB1.custom_mode = true; extBodyB1.prompt = typedLyricsExtend }
                  const createRes = await fetch(`${MUSICAPI_SONIC}/create`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(extBodyB1)
                  })
                  const createText = await createRes.text()
                  console.log(`[job/extend] Path B1 /sonic/create HTTP ${createRes.status} raw: ${createText.slice(0, 300)}`)
                  if (createRes.ok) {
                    let createData: any = {}
                    try { createData = JSON.parse(createText) } catch {}
                    const b1TaskId = createData.task_id || createData.data?.[0]?.id
                    if (b1TaskId) {
                      // Success via B1 — skip upload-extend entirely
                      const newJobId = crypto.randomUUID()
                      const now = Date.now()
                      const newJob = {
                        id: newJobId, user_id: user.id, status: 'generating',
                        prompt: `[Extended from: ${sourceJob.title || source_job_id}] ${sourceJob.prompt || ''}`.trim(),
                        title: `${sourceJob.title || 'Track'} (Extended)`,
                        blueprint: { ...(sourceJob.blueprint || {}), make_instrumental: isInstrumental },
                        stereo_task_id: b1TaskId, stereo_url: null, created_at: now,
                        source_job_id, extend_task_type: 'song_extend', make_instrumental: isInstrumental,
                        chain_clip_id: uploadedClipId, chain_target_ms: 120000, chain_step: 0, chain_max_steps: 8,
                        chain_lyrics: (lyrics && lyrics.trim() && lyrics.trim() !== '[Verse]' && lyrics.trim() !== '[Instrumental]') ? lyrics.trim() : '',
                        chain_style: styleStr || null,
                        continue_at_ms: extend_at || Math.max(1, (sourceJob.duration_ms || 0))
                      }
                      await c.env.DB.prepare(
                        `INSERT INTO jobs (id, user_id, data, created_at, is_oneshot) VALUES (?, ?, ?, ?, 0)`
                      ).bind(newJobId, user.id, JSON.stringify(newJob), now).run()
                      console.log(`[job/extend] Path B1 success: job=${newJobId} task=${b1TaskId}`)
                      return c.json({ ok: true, job_id: newJobId, task_id: b1TaskId })
                    }
                  }
                }
              }
            } catch (b1Err: any) {
              console.warn('[job/extend] Path B1 /sonic/upload attempt failed:', b1Err?.message)
            }
            // B1 failed — fall through to upload-extend (Path B2)
          } else {
            audioUrlForMusicApi = rawStereoUrl || rawStereoAlt
            console.log(`[job/extend] Path B: R2 object not found, using raw URL`)
          }
        } catch (mirrorErr: any) {
          console.warn('[job/extend] Path B: R2 mirror failed:', mirrorErr?.message)
          audioUrlForMusicApi = rawStereoUrl || rawStereoAlt
        }
      } else {
        audioUrlForMusicApi = rawStereoUrl || rawStereoAlt
        console.log(`[job/extend] Path B: using raw URL (no R2 key)`)
      }

      const uploadExtBody: Record<string, any> = {
        url: audioUrlForMusicApi,
        mv: 'sonic-v5',
        continue_at: continueAt
      }
      if (styleStr) uploadExtBody.tags = styleStr.slice(0, 200)
      if (isInstrumental) {
        uploadExtBody.custom_mode = false
        uploadExtBody.make_instrumental = true
        uploadExtBody.gpt_description_prompt = styleStr
          ? `Continue this instrumental track in the same style: ${styleStr.slice(0, 150)}`
          : 'Continue this track as an instrumental in the same style'
      } else if (hasCustomLyricsExtend) {
        uploadExtBody.custom_mode = true
        uploadExtBody.prompt = typedLyricsExtend
      } else {
        uploadExtBody.custom_mode = false
        uploadExtBody.gpt_description_prompt = styleStr
          ? `Continue this track in the same style: ${styleStr.slice(0, 150)}`
          : 'Continue this track in the same style'
      }
      console.log(`[job/extend] Path B: /sonic/upload-extend url=${audioUrlForMusicApi.slice(0, 80)} instrumental=${isInstrumental} continue_at=${continueAt}`)
      const sonicRes = await fetch(`${MUSICAPI_SONIC}/upload-extend`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadExtBody)
      })
      const sonicText = await sonicRes.text()
      console.log(`[job/extend] Path B /sonic/upload-extend HTTP ${sonicRes.status} raw: ${sonicText.slice(0, 600)}`)
      if (!sonicRes.ok) {
        return c.json({ error: `Stemforge extend error: HTTP ${sonicRes.status}`, raw: sonicText.slice(0, 800) }, 500)
      }
      let sonicData: any
      try { sonicData = JSON.parse(sonicText) } catch (_) { sonicData = {} }
      extTaskId = sonicData.task_id || sonicData.steps?.extend?.task_id || sonicData.data?.[0]?.id
      if (!extTaskId) {
        return c.json({ error: 'Stemforge returned no task ID', raw: sonicText.slice(0, 800) }, 500)
      }
    }

    // chain_target_ms: aim for 120 seconds total output (~2 min, 8 steps max)
    const CHAIN_TARGET_MS = 120000

    // Step 3: Create a new job record in D1 to track the extend result
    const newJobId = crypto.randomUUID()
    const now = Date.now()
    const newJob = {
      id: newJobId,
      user_id: user.id,
      status: 'generating',
      prompt: `[Extended from: ${sourceJob.title || source_job_id}] ${sourceJob.prompt || ''}`.trim(),
      title: `${sourceJob.title || 'Track'} (Extended)`,
      blueprint: { ...(sourceJob.blueprint || {}), make_instrumental: isInstrumental },
      stereo_task_id: extTaskId,
      stereo_url: null,
      created_at: now,
      source_job_id: source_job_id,
      extend_task_type: 'song_extend',
      make_instrumental: isInstrumental,
      chain_clip_id: null, // upload-extend does not return a clip_id at submit time
      // ── Chain extend metadata ────────────────────────────────────────────
      chain_target_ms: CHAIN_TARGET_MS,
      chain_step: 0,
      chain_max_steps: 8,
      chain_lyrics: (lyrics && lyrics.trim() && lyrics.trim() !== '[Verse]' && lyrics.trim() !== '[Instrumental]') ? lyrics.trim() : '',
      chain_style: styleStr || null,
      continue_at_ms: extend_at || Math.max(1, (sourceJob.duration_ms || 0))
    }
    await c.env.DB.prepare(
      `INSERT INTO jobs (id, user_id, data, created_at, is_oneshot) VALUES (?, ?, ?, ?, 0)`
    ).bind(newJobId, user.id, JSON.stringify(newJob), now).run()

    return c.json({ ok: true, job_id: newJobId, task_id: extTaskId })
  } catch (e: any) {
    // Refund credits on failure
    try {
      await c.env.DB.prepare(
        `UPDATE users SET gens_used = MAX(0, gens_used - ?) WHERE id = ?`
      ).bind(EXTEND_COST, user.id).run()
    } catch (_) { /* ignore refund failure */ }
    return c.json({ error: e.message || 'Extend failed' }, 500)
  }
})

// POST /api/debug/sonic-extend — raw MusicAPI /sonic/upload-extend test (developer only)
// Body: any JSON — forwarded directly to MusicAPI and raw response returned
app.post('/api/debug/sonic-extend', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user || (user.plan !== 'developer' && user.plan !== 'pro')) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json()
  const res = await fetch(`${MUSICAPI_SONIC}/upload-extend`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return c.json({ status: res.status, ok: res.ok, raw: text })
})

// GET /api/debug/test-extend?admin_key=EMAIL&job_id=JOB — full live test of /api/job/extend flow
// Tests: fetch job → get clip_id → call /sonic/create (dry run, no deduction)
app.get('/api/debug/test-extend', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const adminKey = c.req.query('admin_key')
  const isAdminKey = adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL
  if (!isAdminKey) return c.json({ error: 'admin_key required' }, 401)
  const jobId = c.req.query('job_id')
  if (!jobId) return c.json({ error: 'job_id required' }, 400)

  const results: any = { job_id: jobId, steps: {} }

  // Step 1: fetch job
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'job not found', job_id: jobId }, 404)
  results.steps.job = {
    found: true,
    has_clip_id: !!(job as any).clip_id,
    clip_id: (job as any).clip_id || null,
    has_stereo_url: !!job.stereo_url,
    stereo_url_prefix: job.stereo_url?.slice(0, 80) || null,
    duration_ms: (job as any).duration_ms || null
  }

  // Step 2: test /sonic/upload with the stereo_url — returns clip_id directly (no polling)
  if (job.stereo_url) {
    const uploadRes = await fetch(`${MUSICAPI_SONIC}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.stereo_url })
    })
    const uploadText = await uploadRes.text()
    let uploadData: any = {}
    try { uploadData = JSON.parse(uploadText) } catch {}
    const sonicClipId = uploadData.clip_id || uploadData.id || null
    results.steps.sonic_upload = {
      http_status: uploadRes.status,
      ok: uploadRes.ok,
      sonic_clip_id: sonicClipId,  // This is what we use with continue_clip_id
      task_id: uploadData.task_id || null,  // Usually null — /sonic/upload is synchronous
      raw: uploadText.slice(0, 400)
    }
  }

  // Step 3: use the Sonic-native clip_id from /sonic/upload to test /sonic/create
  // NOTE: The stored job.clip_id is NOT a Sonic-native ID — always use /sonic/upload first.
  const sonicUploadClipId = results.steps.sonic_upload?.sonic_clip_id || null
  const clipIdToTest = sonicUploadClipId
  if (clipIdToTest) {
    const createRes = await fetch(`${MUSICAPI_SONIC}/create`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_type: 'extend_music', continue_clip_id: clipIdToTest, mv: 'sonic-v5', continue_at: 1 })
    })
    const createText = await createRes.text()
    let createData: any = {}
    try { createData = JSON.parse(createText) } catch {}
    results.steps.sonic_create = {
      using_clip_id: clipIdToTest,
      http_status: createRes.status,
      ok: createRes.ok,
      task_id: createData.task_id || createData.id || null,
      raw: createText.slice(0, 400)
    }
  } else {
    results.steps.sonic_create = { skipped: true, reason: 'no sonic_native_clip_id from /sonic/upload' }
  }

  return c.json(results)
})

// GET /api/debug/sonic-task/:task_id — poll a MusicAPI Sonic task (developer only)
// Also accepts ?admin_key=<ADMIN_EMAIL> for CLI testing
app.get('/api/debug/sonic-task/:task_id', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const adminKey = c.req.query('admin_key')
  const isAdminKey = adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL
  if (!isAdminKey) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user || (user.plan !== 'developer' && user.plan !== 'pro')) return c.json({ error: 'Unauthorized' }, 401)
  }
  const taskId = c.req.param('task_id')
  const res = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
  })
  const text = await res.text()
  return c.json({ status: res.status, ok: res.ok, raw: text })
})

// GET /api/debug/extend-probe?admin_key=EMAIL&job_id=JOB&continue_at=N
// Fires the EXACT same MusicAPI call that /api/job/extend would fire, no credit deduction.
// Returns full raw response so we can see the actual 500 error body.
app.get('/api/debug/extend-probe', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const adminKey = c.req.query('admin_key')
  const isAdmin = adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL
  if (!isAdmin) return c.json({ error: 'admin_key required' }, 401)

  const jobId = c.req.query('job_id')
  const continueAt = parseInt(c.req.query('continue_at') || '74', 10)
  const forcePathB = c.req.query('force_b') === '1'
  if (!jobId) return c.json({ error: 'job_id required' }, 400)

  await ensureTable(c.env.DB)
  const row = await c.env.DB.prepare(`SELECT data FROM jobs WHERE id = ?`).bind(jobId).first<{ data: string }>()
  if (!row) return c.json({ error: 'job not found' }, 404)
  const job = JSON.parse(row.data) as any

  const usePathB = forcePathB || !job.clip_id
  const result: any = {
    job_id: jobId,
    job_title: job.title || job.prompt?.slice(0, 60),
    clip_id: job.clip_id || null,
    r2_audio_key: job.r2_audio_key || null,
    stereo_url: job.stereo_url?.slice(0, 100) || null,
    duration_ms: job.duration_ms || null,
    continue_at_used: continueAt,
    path: usePathB ? 'B (upload-extend)' : 'A (continue_clip_id)',
    musicapi_response: null
  }

  if (!usePathB) {
    // Path A probe
    const body = { task_type: 'extend_music', continue_clip_id: job.clip_id, mv: 'sonic-v5', continue_at: continueAt, custom_mode: false, make_instrumental: true }
    const res = await fetch(`${MUSICAPI_SONIC}/create`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    result.musicapi_response = { endpoint: '/sonic/create', http_status: res.status, ok: res.ok, request_body: body, raw: text.slice(0, 1000) }
  } else {
    // Path B probe — always uses upload-extend
    const R2_PUB_BASE = 'https://pub-8e434559eec949638897e09ecee99a88.r2.dev'
    const audioUrl = job.r2_audio_key ? `${R2_PUB_BASE}/${job.r2_audio_key}` : (job.stereo_url || '')
    const body: any = { url: audioUrl, mv: 'sonic-v5', continue_at: continueAt, custom_mode: false, make_instrumental: true, gpt_description_prompt: 'Continue this track as an instrumental in the same style' }
    const res = await fetch(`${MUSICAPI_SONIC}/upload-extend`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    result.musicapi_response = { endpoint: '/sonic/upload-extend', http_status: res.status, ok: res.ok, audio_url_used: audioUrl.slice(0, 100), request_body: body, raw: text.slice(0, 1000) }
  }

  return c.json(result)
})

// GET /api/debug/producer-task/:task_id — poll a MusicAPI Producer task (developer only)
// Also accepts ?admin_key=<ADMIN_EMAIL> as an alternative to session auth for CLI testing
app.get('/api/debug/producer-task/:task_id', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const adminKey = c.req.query('admin_key')
  const isAdminKey = adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL
  if (!isAdminKey) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user || (user.plan !== 'developer' && user.plan !== 'pro')) return c.json({ error: 'Unauthorized' }, 401)
  }
  const taskId = c.req.param('task_id')
  const res = await fetch(`${MUSICAPI_PRODUCER}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
  })
  const text = await res.text()
  return c.json({ status: res.status, ok: res.ok, raw: text })
})


// POST /api/debug/test-sonic-create — test /sonic/create with continue_clip_id (admin only)
// Body: { clip_id: string, continue_at?: number }
app.post('/api/debug/test-sonic-create', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdminOk = (adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL)
                 || (user && (user.plan === 'developer' || (c.env.ADMIN_EMAIL && user.email === c.env.ADMIN_EMAIL)))
  if (!isAdminOk) return c.json({ error: 'Admin only' }, 401)
  const body = await c.req.json<{ clip_id?: string; admin_key?: string; continue_at?: number }>()
  const clipId = body.clip_id
  if (!clipId) return c.json({ error: 'clip_id required' }, 400)
  const continueAt = body.continue_at || 10
  const extBody = { task_type: 'extend_music', continue_clip_id: clipId, mv: 'sonic-v5', continue_at: continueAt }
  const r = await fetch(`${MUSICAPI_SONIC}/create`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(extBody)
  })
  const t = await r.text()
  let parsed: any = {}
  try { parsed = JSON.parse(t) } catch {}
  return c.json({ status: r.status, ok: r.ok, body_sent: extBody, response: parsed, raw: t.slice(0, 800) })
})

// POST /api/debug/test-cover-url — test /sonic/upload-cover with a direct audio URL (admin only)
// Body: { url: string, tags?: string, admin_key?: string }
app.post('/api/debug/test-cover-url', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const body0 = await c.req.json<{ url: string; tags?: string; admin_key?: string; custom_mode?: boolean; prompt?: string; gpt_description_prompt?: string }>()
  const adminKeyParam = body0.admin_key || c.req.query('admin_key')
  const adminKeyOk = adminKeyParam && c.env.ADMIN_EMAIL && adminKeyParam === c.env.ADMIN_EMAIL
  if (!adminKeyOk) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 401)
  }
  const { url, tags, custom_mode, prompt, gpt_description_prompt } = body0
  if (!url) return c.json({ error: 'url required' }, 400)
  const coverBody: Record<string,any> = {
    url,
    mv: 'sonic-v6',
    tags: tags || 'pop, energetic',
    custom_mode: !!custom_mode,
    make_instrumental: false
  }
  if (custom_mode && prompt) {
    coverBody.prompt = prompt
  } else {
    coverBody.gpt_description_prompt = gpt_description_prompt || 'upbeat pop cover, keep the same melody and energy'
  }
  console.log(`[debug/test-cover-url] url=${url.slice(0,100)} body=${JSON.stringify(coverBody).slice(0,300)}`)
  const r = await fetch(`${MUSICAPI_SONIC}/upload-cover`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(coverBody)
  })
  const t = await r.text()
  let parsed: any = {}
  try { parsed = JSON.parse(t) } catch {}
  console.log(`[debug/test-cover-url] HTTP ${r.status}: ${t.slice(0,500)}`)
  return c.json({ status: r.status, ok: r.ok, body_sent: coverBody, response: parsed, raw: t.slice(0,1000) })
})

// POST /api/debug/test-cover — test cover_music variants (admin_key or developer session)
// Body: { clip_id: string }
app.post('/api/debug/test-cover', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const adminKey = c.req.query('admin_key')
  const isAdminKey = adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL
  if (!isAdminKey) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user || (user.plan !== 'developer' && user.plan !== 'pro')) return c.json({ error: 'Unauthorized' }, 401)
  }
  const body = await c.req.json<{ clip_id: string }>()
  const { clip_id } = body
  if (!clip_id) return c.json({ error: 'clip_id required' }, 400)

  // Test /sonic/upload-cover with the audio_url from a known GCS clip
  // Body should include clip_id so we can look up the audio_url
  const srcRow = await c.env.DB.prepare(
    `SELECT data FROM jobs WHERE json_extract(data,'$.clip_id') = ? LIMIT 1`
  ).bind(clip_id).first<{ data: string }>()
  if (!srcRow) return c.json({ error: 'No job found with that clip_id' }, 404)
  const srcJob = JSON.parse(srcRow.data) as any
  const audioUrl = srcJob.stereo_url || ''
  if (!audioUrl) return c.json({ error: 'Source job has no stereo_url' }, 400)

  const bp = srcJob.blueprint
  const genre = bp?.genre || 'instrumental'
  const mood  = bp?.mood  || 'energetic'
  const bpm   = bp?.bpm   || 120

  const coverBody = {
    url: audioUrl,
    mv: 'sonic-v5',
    tags: `${genre}, instrumental, no vocals, ${mood}`,
    custom_mode: false,
    gpt_description_prompt: `Instrumental ${genre} beat, no vocals, ${mood} mood, ${bpm} BPM. Keep same energy and style.`,
    make_instrumental: true
  }

  const r = await fetch(`${MUSICAPI_SONIC}/upload-cover`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(coverBody)
  })
  const t = await r.text()
  let parsed: any = {}
  try { parsed = JSON.parse(t) } catch {}
  return c.json({ status: r.status, ok: r.ok, body_sent: coverBody, response: parsed, raw: t.slice(0,500) })
})

// POST /api/debug/test-upload — test producer upload with a URL (developer only)
// Body: { audio_url: string }
app.post('/api/debug/test-upload', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user || (user.plan !== 'developer' && user.plan !== 'pro')) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json<{ audio_url: string }>()
  const { audio_url } = body
  if (!audio_url) return c.json({ error: 'audio_url required' }, 400)

  // Step 1: upload
  const uploadRes = await fetch(`${MUSICAPI_PRODUCER}/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url })
  })
  const uploadText = await uploadRes.text()
  let uploadData: any = {}
  try { uploadData = JSON.parse(uploadText) } catch {}
  const taskId = uploadData.task_id || uploadData.data?.task_id || null

  if (!uploadRes.ok || !taskId) {
    return c.json({ step: 'upload', status: uploadRes.status, raw: uploadText, task_id: taskId })
  }

  // Step 2: poll up to 60 seconds (2s intervals × 30 attempts)
  let pollResult: any = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const pr = await fetch(`${MUSICAPI_PRODUCER}/task/${taskId}`, {
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
    })
    const pt = await pr.text()
    let pd: any = {}
    try { pd = JSON.parse(pt) } catch {}
    const clips = Array.isArray(pd) ? pd : (Array.isArray(pd.data) ? pd.data : [])
    if (clips.length && (clips[0].state === 'succeeded' || clips[0].state === 'failed')) {
      pollResult = { attempt: i+1, status: pr.status, raw: pt, clips }
      break
    }
    // still not_ready — continue
    if (i === 29) {
      pollResult = { attempt: i+1, status: pr.status, raw: pt, timed_out: true }
    }
  }

  return c.json({ step: 'done', upload_status: uploadRes.status, task_id: taskId, poll: pollResult })
})

// POST /api/admin/patch-job-field — merge extra fields into a job's data blob (admin/developer only)
// Body: { job_id: string, fields: Record<string, any> }
// Used to backfill missing fields (e.g. upload_audio_url) on existing jobs.
app.post('/api/admin/patch-job-field', async (c) => {
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdmin  = (user && (user.plan === 'developer' || user.email === adminKey))
  if (!isAdmin) return c.json({ error: 'Unauthorized' }, 401)

  const { job_id, fields } = await c.req.json<{ job_id: string; fields: Record<string, any> }>()
  if (!job_id || !fields || typeof fields !== 'object') return c.json({ error: 'job_id and fields required' }, 400)

  await ensureTable(c.env.DB)
  const row = await c.env.DB.prepare(
    `SELECT data FROM jobs WHERE id = ?`
  ).bind(job_id).first<{ data: string }>()
  if (!row) return c.json({ error: 'Job not found' }, 404)

  const existing = JSON.parse(row.data) as any
  const patched  = { ...existing, ...fields }
  await c.env.DB.prepare(
    `UPDATE jobs SET data = ? WHERE id = ?`
  ).bind(JSON.stringify(patched), job_id).run()

  return c.json({ ok: true, job_id, patched_keys: Object.keys(fields) })
})


// GET /api/admin/stuck-jobs — list stuck jobs:
//   • status='generating' (actively stuck / timed out)
//   • status='error' in the last 24h (failed jobs visible as broken in library)
app.get('/api/admin/stuck-jobs', async (c) => {
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdminUser = (adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL)
                   || (user && (user.plan === 'developer' || (c.env.ADMIN_EMAIL && user.email === c.env.ADMIN_EMAIL)))
  if (!isAdminUser) return c.json({ error: 'Unauthorized' }, 401)

  await ensureTable(c.env.DB)

  const nowMs = Date.now()
  const last24hMs = nowMs - 24 * 60 * 60 * 1000

  // Two queries: generating (all) + error (last 24h)
  const [generatingRows, errorRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT j.id, j.user_id, j.data, u.email FROM jobs j LEFT JOIN users u ON u.id = j.user_id
       WHERE json_extract(j.data,'$.status')='generating' ORDER BY j.created_at ASC LIMIT 200`
    ).all<{ id: string; user_id: string; data: string; email: string }>(),
    c.env.DB.prepare(
      `SELECT j.id, j.user_id, j.data, u.email FROM jobs j LEFT JOIN users u ON u.id = j.user_id
       WHERE json_extract(j.data,'$.status')='error'
         AND j.created_at >= ? ORDER BY j.created_at DESC LIMIT 100`
    ).bind(last24hMs).all<{ id: string; user_id: string; data: string; email: string }>()
  ])

  const mapRow = (row: { id: string; user_id: string; data: string; email: string }) => {
    const d = (() => { try { return JSON.parse(row.data) } catch { return {} } })() as any
    const ageMs = nowMs - (d.created_at || nowMs)
    const ageMin = Math.round(ageMs / 60000)
    return {
      id: row.id,
      user_email: row.email || row.user_id,
      title: d.title || d.prompt?.slice(0, 40) || '(no title)',
      status: d.status,
      error_msg: d.error || null,
      stereo_task_id: d.stereo_task_id || null,
      extend_task_type: d.extend_task_type || null,
      age_min: ageMin,
      // generating = stuck if >10min; error jobs are always flagged as stuck
      stuck: d.status === 'error' || ageMin >= 10,
      created_at: d.created_at ? new Date(d.created_at).toISOString() : null,
    }
  }

  const generatingJobs = (generatingRows.results || []).map(mapRow)
  const errorJobs = (errorRows.results || []).map(mapRow)
  const allJobs = [...generatingJobs, ...errorJobs]
  const stuck = allJobs.filter(j => j.stuck)

  return c.json({
    total_generating: generatingJobs.length,
    total_errored_24h: errorJobs.length,
    stuck_count: stuck.length,
    jobs: allJobs
  })
})

// GET /api/admin/rescue-stuck-jobs — find generating jobs older than 15min and try to resolve them
// Polls MusicAPI for their task status; marks ready or error accordingly.
app.get('/api/admin/rescue-stuck-jobs', async (c) => {
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdmin  = (adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL)
                || (user && (user.plan === 'developer' || (c.env.ADMIN_EMAIL && user.email === c.env.ADMIN_EMAIL)))
  if (!isAdmin) return c.json({ error: 'Unauthorized' }, 401)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)

  await ensureTable(c.env.DB)

  // Find all generating jobs with a stereo_task_id — extended or regular
  const cutoffMs = Date.now() - 15 * 60 * 1000 // 15 min ago
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, data FROM jobs WHERE json_extract(data,'$.status')='generating' AND json_extract(data,'$.stereo_task_id') IS NOT NULL`
  ).all<{ id: string; user_id: string; data: string }>()

  const results: any[] = []
  for (const row of (rows.results || [])) {
    const job = JSON.parse(row.data) as any
    const ageMs = Date.now() - (job.created_at || 0)
    if (ageMs < 15 * 60 * 1000) {
      results.push({ id: row.id, title: job.title, status: 'skip_too_new', age_min: Math.round(ageMs / 60000) })
      continue
    }
    // Poll MusicAPI task status
    try {
      const taskType = job.extend_task_type
      const useSonic = taskType === 'song_extend' || taskType === 'song_generate'
      const endpoint = useSonic ? `${MUSICAPI_SONIC}/task/${job.stereo_task_id}` : `${MUSICAPI_PRODUCER}/task/${job.stereo_task_id}`
      const pollRes = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
      })
      const pollText = await pollRes.text()
      let pollData: any = {}
      try { pollData = JSON.parse(pollText) } catch {}

      const clips = Array.isArray(pollData) ? pollData : (pollData.data || [])
      const clip = clips[0]

      if (!clip) {
        // No clip data — likely expired task; mark as error
        job.status = 'error'
        job.error = 'Stemforge task expired or not found'
        await setJob(c.env.DB, job)
        results.push({ id: row.id, title: job.title, action: 'marked_error', reason: 'no_clip_data', task_id: job.stereo_task_id })
        continue
      }

      if (clip.state === 'succeeded') {
        const url = clip.audio_url || clip.wav_url || null
        const clipId = clip.id || clip.clip_id || null
        if (url) {
          job.stereo_url = url
          if (clipId) job.clip_id = clipId
          job.status = 'ready'
          await setJob(c.env.DB, job)
          // Persist to R2
          if (c.env.IMAGES && c.env.SITE_URL) {
            persistAudioToR2(url, row.id, c.env.IMAGES, c.env.DB, c.env.SITE_URL)
              .catch((e: any) => console.warn('[rescue] R2 persist error:', e?.message))
          }
          results.push({ id: row.id, title: job.title, action: 'marked_ready', url_prefix: url.slice(0, 60), task_id: job.stereo_task_id })
        } else {
          job.status = 'error'
          job.error = 'Task succeeded but no audio_url'
          await setJob(c.env.DB, job)
          results.push({ id: row.id, title: job.title, action: 'marked_error', reason: 'succeeded_no_url', task_id: job.stereo_task_id })
        }
      } else if (clip.state === 'failed') {
        job.status = 'error'
        job.error = clip.error || 'Stemforge generation failed'
        await setJob(c.env.DB, job)
        results.push({ id: row.id, title: job.title, action: 'marked_error', reason: clip.error || 'task_failed', task_id: job.stereo_task_id })
      } else {
        // Still running or in unknown state — age it out if > 30 min
        if (ageMs > 30 * 60 * 1000) {
          job.status = 'error'
          job.error = `Timed out after ${Math.round(ageMs / 60000)} minutes (state: ${clip.state || 'unknown'})`
          await setJob(c.env.DB, job)
          results.push({ id: row.id, title: job.title, action: 'timed_out', state: clip.state, task_id: job.stereo_task_id })
        } else {
          results.push({ id: row.id, title: job.title, action: 'still_running', state: clip.state, age_min: Math.round(ageMs / 60000), task_id: job.stereo_task_id })
        }
      }
    } catch (rescueErr: any) {
      results.push({ id: row.id, title: job.title, action: 'error', error: rescueErr?.message?.slice(0, 200) })
    }
  }

  return c.json({ rescued: results.length, results })
})

// GET /api/admin/recover-cover-job?job_id=XXX — re-poll a specific cover job from MusicAPI
// Used to rescue cover jobs that got erroneously marked failed with "task not ready" message.
app.get('/api/admin/recover-cover-job', async (c) => {
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdmin  = (adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL)
                || (user && (user.plan === 'developer' || (c.env.ADMIN_EMAIL && user.email === c.env.ADMIN_EMAIL)))
  if (!isAdmin) return c.json({ error: 'Unauthorized' }, 401)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)

  const jobId = c.req.query('job_id')
  if (!jobId) return c.json({ error: 'job_id required' }, 400)

  await ensureTable(c.env.DB)
  const row = await c.env.DB.prepare(`SELECT id, user_id, data FROM jobs WHERE id = ?`).bind(jobId).first<any>()
  if (!row) return c.json({ error: 'Job not found' }, 404)

  const job = JSON.parse(row.data) as any
  const taskId = job.task_id
  if (!taskId) return c.json({ error: 'Job has no task_id', job_status: job.status }, 400)

  // Re-poll MusicAPI /sonic/task/:id
  const pollRes = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
  })
  const pollText = await pollRes.text()
  let pollData: any = {}
  try { pollData = JSON.parse(pollText) } catch {}

  const clips = pollData.data || []
  const ready = clips.find((cl: any) => cl.state === 'succeeded' && cl.audio_url)
  const failed = clips.find((cl: any) => cl.state === 'failed')

  if (ready) {
    const updated = { ...job, status: 'ready', stereo_url: ready.audio_url, is_cover: 1 }
    delete updated.error
    await c.env.DB.prepare(`UPDATE jobs SET data = ?, is_cover = 1 WHERE id = ?`).bind(JSON.stringify(updated), jobId).run()
    // Prime WAV in background so next WAV download is instant
    if (c.env.IMAGES && c.env.SITE_URL) {
      const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
      c.executionCtx.waitUntil(
        primeCoverWav(jobId, ready.audio_url, c.env.IMAGES, siteUrl)
          .catch((e: any) => console.warn(`[recover-cover] WAV prime failed for job=${jobId}:`, e?.message))
      )
    }
    return c.json({ recovered: true, action: 'marked_ready', audio_url: ready.audio_url, title: job.title, task_id: taskId })
  }

  if (failed) {
    const errMsg = failed.error_message || failed.error || failed.message || 'Generation failed'
    const updated = { ...job, status: 'error', error: errMsg }
    await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(JSON.stringify(updated), jobId).run()
    return c.json({ recovered: false, action: 'confirmed_failed', error: errMsg, task_id: taskId })
  }

  // Still generating — reset to generating state so it gets polled again
  const resetData = { ...job, status: 'generating' }
  delete resetData.error
  await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(JSON.stringify(resetData), jobId).run()
  return c.json({
    recovered: false,
    action: 'reset_to_generating',
    musicapi_status: pollData,
    task_id: taskId,
    note: 'Job reset to generating — visit Library → Covers and it will auto-poll to completion'
  })
})



// GET /api/admin/prime-cover-wav/:id — manually trigger WAV pre-bake for an existing cover job
// Use this to back-fill WAV cache for covers that became ready before the auto-prime was added.
app.get('/api/admin/prime-cover-wav/:id', async (c) => {
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  if (!c.env.IMAGES) return c.json({ error: 'R2 not configured' }, 500)
  const jobId = c.req.param('id')
  const job   = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!job.stereo_url) return c.json({ error: 'Job has no audio URL yet' }, 400)
  const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
  // Check if already primed
  const existing = await getDlCache(c.env.IMAGES, jobId, 'wav')
  if (existing) return c.json({ ok: true, cached: true, note: 'WAV already in R2 dl-cache', size: existing.byteLength })
  // Fire prime in background and return immediately
  c.executionCtx.waitUntil(
    primeCoverWav(jobId, job.stereo_url, c.env.IMAGES, siteUrl)
      .catch((e: any) => console.warn(`[admin-prime] failed job=${jobId}:`, e?.message))
  )
  return c.json({ ok: true, cached: false, note: 'WAV prime started in background — try download in ~30s', job_id: jobId })
})

// GET /api/admin/backfill-clip-ids — fetch clip_id from MusicAPI for all jobs missing it
// Polls each job's stereo_task_id against /sonic/task/:id and writes clip_id back to DB.
app.get('/api/admin/backfill-clip-ids', async (c) => {
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdmin  = (adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL)
                || (user && (user.plan === 'developer' || (c.env.ADMIN_EMAIL && user.email === c.env.ADMIN_EMAIL)))
  if (!isAdmin) return c.json({ error: 'Unauthorized' }, 401)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)

  await ensureTable(c.env.DB)
  // Find all ready jobs that have a stereo_task_id but no clip_id
  const rows = await c.env.DB.prepare(
    `SELECT id, data FROM jobs
     WHERE json_extract(data,'$.status')='ready'
       AND json_extract(data,'$.stereo_task_id') IS NOT NULL
       AND json_extract(data,'$.clip_id') IS NULL
     LIMIT 50`
  ).all<{ id: string; data: string }>()

  const results: any[] = []
  for (const row of (rows.results || [])) {
    const job = JSON.parse(row.data) as any
    try {
      const pollRes = await fetch(`${MUSICAPI_SONIC}/task/${job.stereo_task_id}`, {
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
      })
      if (!pollRes.ok) {
        results.push({ id: row.id, title: job.title, action: 'skip', reason: `poll HTTP ${pollRes.status}` })
        continue
      }
      const pollData = await pollRes.json() as any
      const clips = Array.isArray(pollData) ? pollData : (pollData.data || [])
      const clip = clips[0]
      const clipId = clip?.id || clip?.clip_id || null
      if (clipId) {
        job.clip_id = clipId
        await c.env.DB.prepare(`UPDATE jobs SET data=? WHERE id=?`)
          .bind(JSON.stringify(job), row.id).run()
        results.push({ id: row.id, title: job.title, action: 'backfilled', clip_id: clipId })
      } else {
        results.push({ id: row.id, title: job.title, action: 'skip', reason: 'no clip_id in response', raw: JSON.stringify(pollData).slice(0, 200) })
      }
    } catch (e: any) {
      results.push({ id: row.id, title: job.title, action: 'error', error: e?.message?.slice(0, 200) })
    }
  }

  return c.json({ total: rows.results?.length || 0, results })
})

// DELETE /api/admin/job/:id — hard-delete a single job from the DB (admin only)
app.delete('/api/admin/job/:id', async (c) => {
  const adminKey = c.req.query('admin_key')
  const token    = getSessionCookie(c.req.raw)
  const user     = token ? await getSessionUser(c.env.DB, token) : null
  const isAdmin  = (adminKey && c.env.ADMIN_EMAIL && adminKey === c.env.ADMIN_EMAIL)
                || (user && (user.plan === 'developer' || (c.env.ADMIN_EMAIL && user.email === c.env.ADMIN_EMAIL)))
  if (!isAdmin) return c.json({ error: 'Unauthorized' }, 401)

  const jobId = c.req.param('id')
  if (!jobId) return c.json({ error: 'job id required' }, 400)

  await ensureTable(c.env.DB)
  const existing = await c.env.DB.prepare(`SELECT id FROM jobs WHERE id=?`).bind(jobId).first()
  if (!existing) return c.json({ error: 'Job not found' }, 404)

  await c.env.DB.prepare(`DELETE FROM jobs WHERE id=?`).bind(jobId).run()
  return c.json({ ok: true, deleted: jobId })
})

// GET /api/stripe/portal — redirect to Stripe billing portal
app.get('/api/stripe/portal', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login')
  if (!stripeConfigured(c.env)) return c.redirect('/subscription')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  if (!user.stripe_customer_id) return c.redirect('/subscription')
  try {
    const session = await stripeRequest('POST', '/billing_portal/sessions', {
      customer: user.stripe_customer_id,
      return_url: `${c.env.SITE_URL}/subscription`,
    }, c.env.STRIPE_SECRET_KEY)
    return c.redirect(session.url)
  } catch (e: any) {
    return c.redirect('/subscription?error=' + encodeURIComponent(e.message || 'Portal error'))
  }
})

// POST /api/subscription/downgrade — schedule plan downgrade at next billing cycle
app.post('/api/subscription/downgrade', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan === 'free') return c.json({ error: 'Already on free plan' }, 400)
  if (!user.stripe_subscription_id) return c.json({ error: 'No active subscription' }, 400)

  const { target_plan } = await c.req.json<{ target_plan: string }>()
  // Validate downgrade path: pro→creator, pro→free, creator→free
  const validTargets: Record<string, string[]> = { pro: ['creator', 'free'], creator: ['free'] }
  if (!target_plan || !validTargets[user.plan]?.includes(target_plan)) {
    return c.json({ error: 'Invalid downgrade target' }, 400)
  }

  try {
    if (target_plan === 'free') {
      // Cancel subscription at period end — user stays on current plan until cycle ends
      await stripeRequest('POST', `/subscriptions/${user.stripe_subscription_id}`, {
        cancel_at_period_end: 'true',
      }, c.env.STRIPE_SECRET_KEY)
      // Save pending_downgrade to D1 so UI can reflect this immediately
      if (c.env.DB) {
        await c.env.DB.prepare(`UPDATE users SET pending_downgrade = 'free' WHERE id = ?`).bind(user.id).run()
      }
      return c.json({ ok: true, message: 'Your subscription will cancel at the end of the billing period. You will move to the Free plan then.' })
    } else {
      // Downgrade to creator: update subscription to creator price, prorated at cycle end
      const newPriceId = target_plan === 'creator' ? c.env.STRIPE_CREATOR_PRICE_ID : ''
      if (!newPriceId) return c.json({ error: 'Price not configured' }, 500)
      // Get current subscription to find the item ID
      const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
      const itemId = sub.items?.data?.[0]?.id
      if (!itemId) return c.json({ error: 'Could not find subscription item' }, 500)
      // Schedule the price change at period end (no proration, takes effect next cycle)
      await stripeRequest('POST', `/subscriptions/${user.stripe_subscription_id}`, {
        'items[0][id]': itemId,
        'items[0][price]': newPriceId,
        proration_behavior: 'none',
        billing_cycle_anchor: 'unchanged',
      }, c.env.STRIPE_SECRET_KEY)
      // Save pending_downgrade to D1 so UI can reflect this immediately (no Stripe schedule to detect)
      if (c.env.DB) {
        await c.env.DB.prepare(`UPDATE users SET pending_downgrade = ? WHERE id = ?`).bind(target_plan, user.id).run()
      }
      return c.json({ ok: true, message: `Your plan will change to Creator at the next billing cycle.` })
    }
  } catch (e: any) {
    return c.json({ error: e?.message || 'Downgrade failed' }, 500)
  }
})

// ─── CANCEL SUBSCRIPTION ────────────────────────────────────────────────────────
// POST /api/subscription/cancel — immediately cancels (schedules end-of-period cancellation)
// This is the full "I want to stop paying" flow — sets cancel_at_period_end = true on Stripe.
// User keeps access until the end of their current billing period, then moves to Free.
app.post('/api/subscription/cancel', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)

  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan === 'free') return c.json({ error: 'You are already on the free plan.' }, 400)
  if (!user.stripe_subscription_id) return c.json({ error: 'No active subscription found.' }, 400)

  try {
    // Check if already scheduled to cancel
    const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
    if (sub.cancel_at_period_end) {
      return c.json({ ok: false, error: 'Your subscription is already scheduled to cancel.' })
    }

    // Schedule cancellation at end of billing period
    const updated = await stripeRequest('POST', `/subscriptions/${user.stripe_subscription_id}`, {
      cancel_at_period_end: 'true',
    }, c.env.STRIPE_SECRET_KEY)

    // Calculate end date for user-friendly message
    const periodEnd = updated.current_period_end
    const endDate = periodEnd
      ? new Date(periodEnd * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'the end of your billing period'

    return c.json({
      ok: true,
      message: `Your subscription has been cancelled. You will keep full access until ${endDate}, then move to the Free plan.`
    })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Cancellation failed' }, 500)
  }
})

// ─── CANCEL DOWNGRADE ────────────────────────────────────────────────────────
// POST /api/subscription/cancel-downgrade — removes a scheduled plan change or cancellation
app.post('/api/subscription/cancel-downgrade', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)

  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (!user.stripe_subscription_id) return c.json({ error: 'No active subscription' }, 400)

  try {
    // Check current subscription state
    const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)

    if (sub.cancel_at_period_end) {
      // Was scheduled to cancel — remove cancellation
      await stripeRequest('POST', `/subscriptions/${user.stripe_subscription_id}`, {
        cancel_at_period_end: 'false'
      }, c.env.STRIPE_SECRET_KEY)
      // Clear pending_downgrade in D1
      if (c.env.DB) await c.env.DB.prepare(`UPDATE users SET pending_downgrade = NULL WHERE id = ?`).bind(user.id).run()
      return c.json({ ok: true, message: 'Subscription cancellation removed. Your plan continues as normal.' })
    }

    // Check if there's a scheduled subscription (price change at next cycle)
    const schedules = await stripeRequest('GET', `/subscription_schedules?customer=${user.stripe_customer_id}`, {}, c.env.STRIPE_SECRET_KEY)
    const activeSchedule = schedules?.data?.find((s: any) => s.status === 'active' && s.subscription === user.stripe_subscription_id)
    if (activeSchedule) {
      // Release the schedule — removes the future plan change
      await stripeRequest('POST', `/subscription_schedules/${activeSchedule.id}/release`, {}, c.env.STRIPE_SECRET_KEY)
      // Clear pending_downgrade in D1
      if (c.env.DB) await c.env.DB.prepare(`UPDATE users SET pending_downgrade = NULL WHERE id = ?`).bind(user.id).run()
      return c.json({ ok: true, message: 'Scheduled plan change cancelled. Your current plan continues.' })
    }

    // Even if Stripe has no record, clear the D1 field (defensive cleanup)
    if (c.env.DB) await c.env.DB.prepare(`UPDATE users SET pending_downgrade = NULL WHERE id = ?`).bind(user.id).run()
    return c.json({ ok: false, message: 'No pending downgrade found to cancel.' })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Cancel downgrade failed' }, 500)
  }
})

// ─── CANCEL UPGRADE ──────────────────────────────────────────────────────────
// POST /api/subscription/cancel-upgrade — cancels a scheduled upgrade (subscription schedule)
app.post('/api/subscription/cancel-upgrade', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)

  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (!user.stripe_subscription_id) return c.json({ error: 'No active subscription' }, 400)

  try {
    // Check if there's an active subscription schedule (scheduled upgrade)
    const schedules = await stripeRequest('GET', `/subscription_schedules?customer=${user.stripe_customer_id}`, {}, c.env.STRIPE_SECRET_KEY)
    const activeSchedule = schedules?.data?.find((s: any) => s.status === 'active' && s.subscription === user.stripe_subscription_id)
    if (activeSchedule) {
      // Release the schedule — removes the future upgrade, subscription stays as-is
      await stripeRequest('POST', `/subscription_schedules/${activeSchedule.id}/release`, {}, c.env.STRIPE_SECRET_KEY)
      return c.json({ ok: true, message: 'Scheduled upgrade cancelled. Your current plan continues.' })
    }

    return c.json({ ok: false, message: 'No pending upgrade found to cancel.' })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Cancel upgrade failed' }, 500)
  }
})

// ─── PENDING STATE ───────────────────────────────────────────────────────────
// GET /api/subscription/pending-state — returns { pendingDowngrade, pendingUpgrade } for home/pricing pages
// pendingDowngrade: 'free' | 'creator' | null
// pendingUpgrade:   'creator' | 'pro' | null
// Primary source: D1 users.pending_downgrade (written at downgrade time — no Stripe polling needed)
// Fallback: Stripe subscription cancel_at_period_end + subscription schedules
app.get('/api/subscription/pending-state', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ pendingDowngrade: null, pendingUpgrade: null })
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ pendingDowngrade: null, pendingUpgrade: null, plan: null })

  // ── Primary: use D1-stored pending_downgrade (fastest, no Stripe call needed) ──
  if (user.pending_downgrade) {
    return c.json({ pendingDowngrade: user.pending_downgrade, pendingUpgrade: null, plan: user.plan })
  }

  if (!user.stripe_subscription_id || !stripeConfigured(c.env)) {
    return c.json({ pendingDowngrade: null, pendingUpgrade: null, plan: user.plan })
  }

  // ── Fallback: check Stripe for cancel_at_period_end + subscription schedules ──
  try {
    let pendingDowngrade: string | null = null
    let pendingUpgrade: string | null = null
    const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
    if (sub.cancel_at_period_end) {
      pendingDowngrade = 'free'
      // Sync to D1 so future calls are fast
      await c.env.DB.prepare(`UPDATE users SET pending_downgrade = 'free' WHERE id = ?`).bind(user.id).run().catch(() => {})
    }
    if (!pendingDowngrade) {
      const schedules = await stripeRequest('GET', `/subscription_schedules?customer=${user.stripe_customer_id}&limit=5`, {}, c.env.STRIPE_SECRET_KEY)
      const active = schedules?.data?.find((s: any) => s.status === 'active' && s.subscription === user.stripe_subscription_id)
      if (active && active.phases?.length >= 2) {
        const lastPhase = active.phases[active.phases.length - 1]
        const nextPriceId = lastPhase?.items?.[0]?.price
        const PRICE_TO_PLAN: Record<string, string> = {
          [c.env.STRIPE_CREATOR_PRICE_ID || '']: 'creator',
          [c.env.STRIPE_PRO_PRICE_ID || '']: 'pro'
        }
        const nextPlan = PRICE_TO_PLAN[nextPriceId] || null
        if (nextPlan) {
          const planRank: Record<string, number> = { free: 0, creator: 1, pro: 2 }
          const currentRank = planRank[user.plan] ?? 0
          const nextRank = planRank[nextPlan] ?? 0
          if (nextRank < currentRank) pendingDowngrade = nextPlan
          else if (nextRank > currentRank) pendingUpgrade = nextPlan
        }
      }
    }
    return c.json({ pendingDowngrade, pendingUpgrade, plan: user.plan })
  } catch {
    return c.json({ pendingDowngrade: null, pendingUpgrade: null, plan: user.plan })
  }
})

// ─── UPGRADE PREVIEW ─────────────────────────────────────────────────────────
// GET /api/subscription/upgrade-preview?plan=pro|creator
// Returns the exact prorated charge the user will see BEFORE they confirm.
// Formula:
//   days_remaining  = ceil((period_end - now) / 86400)
//   days_in_period  = ceil((period_end - period_start) / 86400)
//   daily_new       = new_plan_price / days_in_period
//   daily_old       = current_plan_price / days_in_period
//   proration_charge = (daily_new - daily_old) × days_remaining  (rounded up to cents)
app.get('/api/subscription/upgrade-preview', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const target_plan = c.req.query('plan') as string
  const validUpgrades: Record<string, string[]> = { free: ['creator', 'pro'], creator: ['pro'] }
  if (!target_plan || !validUpgrades[user.plan]?.includes(target_plan)) {
    return c.json({ error: 'Invalid upgrade target' }, 400)
  }

  // Plan prices in cents
  const PRICES: Record<string, number> = { free: 0, creator: 1000, pro: 2600 }
  const currentPriceCents = PRICES[user.plan] ?? 0
  const newPriceCents = PRICES[target_plan] ?? 0

  // No existing subscription — they'll go through checkout, charged full price
  if (!user.stripe_subscription_id) {
    return c.json({
      has_subscription: false,
      target_plan,
      target_plan_label: target_plan === 'pro' ? 'Pro Artist' : 'Creator',
      new_price_cents: newPriceCents,
      new_price_label: `$${(newPriceCents / 100).toFixed(2)}`,
      proration_cents: newPriceCents,
      proration_label: `$${(newPriceCents / 100).toFixed(2)}`,
      days_remaining: null,
      days_in_period: null,
      period_end_label: null,
      note: 'First subscription — charged full monthly price'
    })
  }

  try {
    // Fetch live subscription from Stripe to get accurate period dates
    const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
    // Stripe API ≥ 2025-03-31.basil moved current_period_start/end from the
    // subscription top-level to subscription items.  Fall back gracefully so
    // the code works with both old and new API versions.
    const item0 = sub.items?.data?.[0]
    const periodStart: number = item0?.current_period_start ?? sub.current_period_start
    const periodEnd: number   = item0?.current_period_end   ?? sub.current_period_end
    const nowSec = Math.floor(Date.now() / 1000)

    // Guard against Stripe returning undefined/null period dates
    if (!periodStart || !periodEnd || isNaN(Number(periodStart)) || isNaN(Number(periodEnd))) {
      return c.json({
        has_subscription: false,
        target_plan,
        target_plan_label: target_plan === 'pro' ? 'Pro Artist' : 'Creator',
        current_plan: user.plan,
        current_plan_label: user.plan === 'creator' ? 'Creator' : 'Free',
        new_price_cents: newPriceCents,
        new_price_label: `$${(newPriceCents / 100).toFixed(2)}/mo`,
        current_price_cents: currentPriceCents,
        current_price_label: `$${(currentPriceCents / 100).toFixed(2)}/mo`,
        proration_cents: newPriceCents,
        proration_label: `$${(newPriceCents / 100).toFixed(2)}`,
        days_remaining: null,
        days_in_period: null,
        period_end_label: null,
        note: 'New billing cycle'
      })
    }

    const totalDays     = Math.ceil((periodEnd - periodStart) / 86400)
    const daysRemaining = Math.max(1, Math.ceil((periodEnd - nowSec) / 86400))
    const daysUsed      = totalDays - daysRemaining

    // Daily rates
    const dailyNew = newPriceCents / totalDays
    const dailyOld = currentPriceCents / totalDays

    // Proration = (new daily - old daily) × days remaining, rounded to nearest cent
    // This is exactly what Stripe will charge: upgrade cost minus unused portion of current plan
    const proratedCents = Math.round((dailyNew - dailyOld) * daysRemaining)

    const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    const periodStartDate = new Date(periodStart * 1000).toLocaleDateString('en-US', dateOpts)
    const periodEndDate   = new Date(periodEnd   * 1000).toLocaleDateString('en-US', dateOpts)

    // Human-readable billing cycle range e.g. "Jun 14 – Jul 14, 2025"
    const billingCycleRange = `${periodStartDate} – ${periodEndDate}`

    // Price difference label for display e.g. "$19.00 → $39.00"
    const priceDiffLabel = `$${(currentPriceCents / 100).toFixed(2)}/mo → $${(newPriceCents / 100).toFixed(2)}/mo`

    return c.json({
      has_subscription: true,
      target_plan,
      target_plan_label: target_plan === 'pro' ? 'Pro Artist' : 'Creator',
      current_plan: user.plan,
      current_plan_label: user.plan === 'creator' ? 'Creator' : 'Free',
      new_price_cents: newPriceCents,
      new_price_label: `$${(newPriceCents / 100).toFixed(2)}/mo`,
      current_price_cents: currentPriceCents,
      current_price_label: `$${(currentPriceCents / 100).toFixed(2)}/mo`,
      proration_cents: proratedCents,
      proration_label: `$${(proratedCents / 100).toFixed(2)}`,
      days_remaining: daysRemaining,
      days_used: daysUsed,
      days_in_period: totalDays,
      period_start_label: periodStartDate,
      period_end_label: periodEndDate,
      billing_cycle_range: billingCycleRange,
      price_diff_label: priceDiffLabel,
      note: `${daysRemaining} days left in your current billing cycle`
    })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Could not fetch subscription details' }, 500)
  }
})

// ─── UPGRADE WITH IMMEDIATE PRORATION ────────────────────────────────────────
// POST /api/subscription/upgrade — charge proration immediately, grant access same day
app.post('/api/subscription/upgrade', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const { target_plan } = await c.req.json<{ target_plan: string }>()
  const validUpgrades: Record<string, string[]> = { free: ['creator', 'pro'], creator: ['pro'] }
  if (!target_plan || !validUpgrades[user.plan]?.includes(target_plan)) {
    return c.json({ error: 'Invalid upgrade target' }, 400)
  }

  const newPriceId = target_plan === 'pro' ? c.env.STRIPE_PRO_PRICE_ID : c.env.STRIPE_CREATOR_PRICE_ID
  if (!newPriceId) return c.json({ error: 'Price not configured' }, 500)

  try {
    if (!user.stripe_subscription_id) {
      // No existing subscription — redirect to checkout
      return c.json({ redirect: `/checkout?plan=${target_plan}` })
    }
    // Has existing subscription — upgrade with immediate proration charge
    const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
    const itemId = sub.items?.data?.[0]?.id
    if (!itemId) return c.json({ error: 'Could not find subscription item' }, 500)
    // error_if_incomplete = Stripe throws if payment fails, so D1 only updates on confirmed payment
    const updatedSub = await stripeRequest('POST', `/subscriptions/${user.stripe_subscription_id}`, {
      'items[0][id]': itemId,
      'items[0][price]': newPriceId,
      proration_behavior: 'always_invoice',
      billing_cycle_anchor: 'unchanged',
      payment_behavior: 'error_if_incomplete',
    }, c.env.STRIPE_SECRET_KEY)
    // Only grant access if subscription is active (payment succeeded)
    if (updatedSub.status !== 'active') {
      // Payment requires action — get the latest invoice's hosted URL for redirect
      const latestInvoice = updatedSub.latest_invoice
      let invoiceUrl: string | null = null
      if (latestInvoice) {
        const invoiceId = typeof latestInvoice === 'string' ? latestInvoice : latestInvoice.id
        if (invoiceId) {
          const inv = await stripeRequest('GET', `/invoices/${invoiceId}`, {}, c.env.STRIPE_SECRET_KEY)
          invoiceUrl = inv?.hosted_invoice_url || null
        }
      }
      if (invoiceUrl) return c.json({ redirect: invoiceUrl, message: 'Payment required to complete upgrade.' })
      return c.json({ error: 'Payment incomplete. Please check your payment method in the billing portal.' }, 402)
    }
    // Payment confirmed — grant access
    const newLimit = target_plan === 'pro' ? 200 : 50
    await c.env.DB.prepare(`UPDATE users SET plan=?, gens_limit=? WHERE id=?`)
      .bind(target_plan, newLimit, user.id).run()
    return c.json({ ok: true, message: `Upgraded to ${target_plan === 'pro' ? 'Pro Artist' : 'Creator'} — access granted immediately.` })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Upgrade failed' }, 500)
  }
})

// ─── PROMO CODE ROUTES ────────────────────────────────────────────────────────

// GET /api/promo/validate/:code — check if a promo code is valid
app.get('/api/promo/validate/:code', async (c) => {
  if (!c.env.DB) return c.json({ error: 'No DB' }, 500)
  await ensureAuthTables(c.env.DB)
  const code = c.req.param('code').toUpperCase().trim()
  const row = await c.env.DB.prepare(`SELECT * FROM promo_codes WHERE code=? AND active=1`).bind(code).first<any>()
  if (!row) return c.json({ error: 'Invalid or expired promo code' }, 404)
  if (row.expires_at && row.expires_at < Date.now()) return c.json({ error: 'This promo code has expired' }, 410)
  if (row.max_uses > 0 && row.uses_count >= row.max_uses) return c.json({ error: 'This promo code has reached its usage limit' }, 410)
  return c.json({ ok: true, code: row.code, description: row.description, discount_type: row.discount_type, discount_value: row.discount_value, bonus_credits: row.bonus_credits, plan_override: row.plan_override, terms: row.terms })
})

// POST /api/promo/redeem — redeem a promo code for logged-in user
app.post('/api/promo/redeem', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  await ensureAuthTables(c.env.DB)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Must be logged in to redeem a promo code' }, 401)
  const { code } = await c.req.json<{ code: string }>()
  if (!code) return c.json({ error: 'Missing code' }, 400)
  const upperCode = code.toUpperCase().trim()
  const row = await c.env.DB.prepare(`SELECT * FROM promo_codes WHERE code=? AND active=1`).bind(upperCode).first<any>()
  if (!row) return c.json({ error: 'Invalid or expired promo code' }, 404)
  if (row.expires_at && row.expires_at < Date.now()) return c.json({ error: 'This promo code has expired' }, 410)
  if (row.max_uses > 0 && row.uses_count >= row.max_uses) return c.json({ error: 'This promo code has reached its usage limit' }, 410)
  // Check user hasn't already used this code
  const already = await c.env.DB.prepare(`SELECT id FROM promo_redemptions WHERE code=? AND user_id=?`).bind(upperCode, user.id).first()
  if (already) return c.json({ error: 'You have already used this promo code' }, 409)
  // Apply bonus credits
  if (row.bonus_credits > 0) {
    await c.env.DB.prepare(`UPDATE users SET gens_limit = gens_limit + ? WHERE id=?`).bind(row.bonus_credits, user.id).run()
  }
  // Record redemption
  await c.env.DB.prepare(`INSERT INTO promo_redemptions (id,code,user_id,redeemed_at) VALUES (?,?,?,?)`).bind('pr_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), upperCode, user.id, Date.now()).run()
  await c.env.DB.prepare(`UPDATE promo_codes SET uses_count=uses_count+1 WHERE code=?`).bind(upperCode).run()
  return c.json({ ok: true, message: `Promo code applied! ${row.bonus_credits > 0 ? `+${row.bonus_credits} bonus points added.` : ''} ${row.description}` })
})

// ─── ADMIN ROUTES — developer only ───────────────────────────────────────────

function isAdmin(user: User | null, env: Bindings): boolean {
  if (!user) return false
  // Check env secret first, then fallback hardcoded email, then developer plan
  const adminEmail = env.ADMIN_EMAIL || 'andrewsmusiclab@gmail.com'
  if (user.email === adminEmail) return true
  if (user.plan === 'developer') return true
  return false
}

// ── Site version helpers ─────────────────────────────────────────────────────
async function getSiteVersion(db: D1Database): Promise<string> {
  try {
    const row = await db.prepare(`SELECT value FROM site_version WHERE key='active_version'`).first<{value:string}>()
    return row?.value ?? 'live'
  } catch { return 'live' }
}
async function setSiteVersion(db: D1Database, version: 'live'|'preview'): Promise<void> {
  await db.prepare(`INSERT OR REPLACE INTO site_version (key, value, updated_at) VALUES ('active_version', ?, ?)`)
    .bind(version, Date.now()).run()
}
async function getVersionUpdatedAt(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare(`SELECT updated_at FROM site_version WHERE key='active_version'`).first<{updated_at:number}>()
    return row?.updated_at ?? 0
  } catch { return 0 }
}

// ── Gate helper — call on every public page route ────────────────────────────
// Returns a "coming soon" Response if site is in preview mode and user is not admin.
// Returns null if the page should be shown normally.
// checkPreviewGate — only used on the /preview route itself.
// Public routes are NEVER gated; visitors always see the live site.
// Preview mode = admin is reviewing a new deploy before "approving" it as live.
async function checkPreviewGate(c: any): Promise<Response | null> {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/') as any
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.redirect('/') as any
  return null // admin can view /preview
}

// comingSoonPage removed — visitors always see the live site, never a gate page.

// ═══════════════════════════════════════════════════════════════
//  BROADCAST EMAIL ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/templates — list saved email templates
app.get('/api/admin/templates', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const rows = await c.env.DB.prepare(`SELECT id,name,subject,blocks_json,styles_json,is_system,updated_at FROM email_templates ORDER BY is_system DESC, updated_at DESC`).all<any>()
  return c.json({ templates: rows.results || [] })
})

// POST /api/admin/templates — save new template
app.post('/api/admin/templates', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const { name, subject, blocks_json, styles_json } = await c.req.json<any>()
  if (!name?.trim()) return c.json({ error: 'Template name required' }, 400)
  const result = await c.env.DB.prepare(`INSERT INTO email_templates (name,subject,blocks_json,styles_json,is_system) VALUES (?,?,?,?,0)`)
    .bind(name.trim(), subject || '', blocks_json || '[]', styles_json || '{}')
    .run()
  return c.json({ ok: true, id: result.meta.last_row_id })
})

// PUT /api/admin/templates/:id — update existing template
app.put('/api/admin/templates/:id', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const { name, subject, blocks_json, styles_json } = await c.req.json<any>()
  await c.env.DB.prepare(`UPDATE email_templates SET name=?,subject=?,blocks_json=?,styles_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(name || '', subject || '', blocks_json || '[]', styles_json || '{}', id)
    .run()
  return c.json({ ok: true })
})

// DELETE /api/admin/templates/:id — delete template
app.delete('/api/admin/templates/:id', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare(`DELETE FROM email_templates WHERE id=? AND is_system=0`).bind(id).run()
  return c.json({ ok: true })
})

// GET /api/track/open — 1x1 tracking pixel for broadcast open tracking
app.get('/api/track/open', async (c) => {
  try {
    const sid = c.req.query('sid')
    const token = c.req.query('t')
    if (sid && token && c.env.DB) {
      const sendId = parseInt(sid)
      if (!isNaN(sendId)) {
        // Insert open (unique per send+token — duplicate ignored)
        try {
          await c.env.DB.prepare(`INSERT OR IGNORE INTO broadcast_opens (send_id, token) VALUES (?,?)`).bind(sendId, token).run()
          // Update opened_count on the send record
          await c.env.DB.prepare(`UPDATE broadcast_sends SET opened_count = (SELECT COUNT(*) FROM broadcast_opens WHERE send_id=?) WHERE id=?`).bind(sendId, sendId).run()
        } catch {}
      }
    }
  } catch {}
  // Return 1x1 transparent GIF
  const gif = new Uint8Array([71,73,70,56,57,97,1,0,1,0,0,0,0,59])
  return new Response(gif, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache', 'Pragma': 'no-cache' } })
})

// POST /api/admin/resend-welcome — resend the welcome email to any user by email (admin only)
// Accepts session cookie OR ?admin_key=<ADMIN_EMAIL> query param
app.post('/api/admin/resend-welcome', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const adminKey = c.req.query('admin_key')
  const adminEmailVal = c.env.ADMIN_EMAIL || 'andrewsmusiclab@gmail.com'
  const isKeyAuth = adminKey && adminKey === adminEmailVal
  if (!isKeyAuth) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  }
  const { email } = await c.req.json().catch(() => ({ email: '' }))
  if (!email) return c.json({ error: 'email required' }, 400)
  const target = await getUserByEmail(c.env.DB, email.toLowerCase())
  if (!target) return c.json({ error: 'User not found' }, 404)
  try {
    await sendWelcomeEmail({
      db: c.env.DB,
      resendKey: (c.env as any).RESEND_API_KEY,
      mailerKey: (c.env as any).MAILERSEND_API_KEY,
      name: target.name,
      email: target.email,
      siteUrl: c.env.SITE_URL || 'https://stemforge.studio',
      userId: target.id
    })
    return c.json({ ok: true, message: `Welcome email sent to ${target.email}` })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Send failed' }, 500)
  }
})

// GET /api/admin/broadcast/history — list all past broadcast sends
app.get('/api/admin/broadcast/history', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const rows = await c.env.DB.prepare(
    `SELECT id, name, subject, audience, sent_count, opened_count, sent_at FROM broadcast_sends ORDER BY sent_at DESC LIMIT 100`
  ).all<any>()
  return c.json({ sends: rows.results || [] })
})

// GET /api/admin/broadcast/subscribers — get subscriber list + counts
app.get('/api/admin/broadcast/subscribers', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const all = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE email_unsubscribed IS NULL OR email_unsubscribed = 0`).first<{cnt:number}>()
  const free = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE plan='free' AND (email_unsubscribed IS NULL OR email_unsubscribed = 0)`).first<{cnt:number}>()
  const paid = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE plan!='free' AND (email_unsubscribed IS NULL OR email_unsubscribed = 0)`).first<{cnt:number}>()
  return c.json({ all: all?.cnt || 0, free: free?.cnt || 0, paid: paid?.cnt || 0 })
})

// POST /api/admin/broadcast/send — send broadcast email
app.post('/api/admin/broadcast/send', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{
    subject: string
    html: string
    audience: 'all' | 'free' | 'paid'
    broadcast_name?: string
  }>()

  const { subject, html, audience } = body
  if (!subject?.trim() || !html?.trim()) return c.json({ error: 'Subject and HTML content required' }, 400)

  const resendKey = (c.env as any).RESEND_API_KEY
  const mailerKey = (c.env as any).MAILERSEND_API_KEY
  if (!resendKey && !mailerKey) return c.json({ error: 'No email API key set (RESEND_API_KEY or MAILERSEND_API_KEY)' }, 500)

  const fromEmail = 'StemForge <noreply@stemforge.studio>'
  const siteUrl = c.env.SITE_URL || 'https://stemforge.studio'

  // Helper: build personalised HTML for one recipient (sequential — no concurrent crypto)
  async function buildPersonalHtml(r: {id:string,email:string,name:string}, sendId: number, rawHtml: string): Promise<string> {
    const secret = (c.env as any).SESSION_SECRET || 'sf'
    const unsubToken = await sha256Hex(r.id + secret)
    const openToken  = await sha256Hex(`${sendId}:${r.id}:${secret}`)
    const unsubUrl   = `${siteUrl}/api/unsubscribe?id=${r.id}&t=${unsubToken}`
    const pixelUrl   = `${siteUrl}/api/track/open?sid=${sendId}&t=${openToken}`
    return rawHtml + `
<div style="margin-top:40px;padding-top:16px;border-top:1px solid #1e293b;text-align:center;font-size:11px;color:#475569;font-family:sans-serif">
  You're receiving this because you have a StemForge account.<br/>
  <a href="${unsubUrl}" style="color:#4e9fff">Unsubscribe</a>
</div>
<img src="${pixelUrl}" width="1" height="1" style="display:block;width:1px;height:1px;border:0;opacity:0" alt=""/>`
  }

  // Helper: send one email via Resend (primary) or MailerSend (fallback)
  async function sendOne(to: string, subj: string, htmlBody: string): Promise<boolean> {
    if (resendKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromEmail, to: [to], subject: subj, html: htmlBody })
      })
      return res.ok
    }
    const feedbackFrom = (c.env as any).FEEDBACK_FROM_EMAIL || 'noreply@stemforge.studio'
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mailerKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { email: feedbackFrom, name: 'StemForge' }, to: [{ email: to }], subject: subj, html: htmlBody })
    })
    return res.ok || res.status === 202
  }

  // Helper: send a batch of up to 100 via Resend Batch API (single HTTP call)
  // Falls back to MailerSend one-by-one if no Resend key
  async function sendBatch(messages: {to:string, subject:string, html:string}[]): Promise<{sent:number, errors:number}> {
    if (resendKey) {
      const payload = messages.map(m => ({ from: fromEmail, to: [m.to], subject: m.subject, html: m.html }))
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (res.ok) {
        const d = await res.json() as { data?: any[] }
        const count = d.data?.length ?? messages.length
        return { sent: count, errors: messages.length - count }
      }
      // Batch call itself failed — count all as errors
      return { sent: 0, errors: messages.length }
    }
    // MailerSend fallback: sequential one-by-one
    let sent = 0, errors = 0
    for (const m of messages) {
      const ok = await sendOne(m.to, m.subject, m.html)
      if (ok) sent++; else errors++
    }
    return { sent, errors }
  }

  // Real broadcast — create send record first to get an ID for tracking
  const broadcastName = body.broadcast_name?.trim() || subject.slice(0, 60)
  const sendRecord = await c.env.DB.prepare(
    `INSERT INTO broadcast_sends (name, subject, audience, sent_count, opened_count) VALUES (?,?,?,0,0)`
  ).bind(broadcastName, subject, audience).run()
  const sendId = sendRecord.meta.last_row_id as number

  // Fetch recipients
  let whereClause = `(email_unsubscribed IS NULL OR email_unsubscribed = 0)`
  if (audience === 'free') whereClause += ` AND plan='free'`
  if (audience === 'paid') whereClause += ` AND plan!='free'`
  const recipients = await c.env.DB.prepare(`SELECT id, email, name FROM users WHERE ${whereClause} ORDER BY created_at ASC`).all<{id:string,email:string,name:string}>()
  const rows = recipients.results || []
  if (rows.length === 0) {
    await c.env.DB.prepare(`DELETE FROM broadcast_sends WHERE id=?`).bind(sendId).run()
    return c.json({ ok: true, sent: 0 })
  }

  // Build all personalised messages sequentially (avoids parallel crypto CPU spike)
  // then send in Resend Batch API chunks of 100 (single HTTP call each)
  let sent = 0
  let errors = 0
  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    // Build HTML sequentially — no Promise.all to keep CPU usage flat
    const messages: {to:string, subject:string, html:string}[] = []
    for (const r of chunk) {
      const personalHtml = await buildPersonalHtml(r, sendId, html)
      messages.push({ to: r.email, subject, html: personalHtml })
    }
    // One HTTP call for up to 100 emails
    const result = await sendBatch(messages)
    sent += result.sent
    errors += result.errors
    // Brief pause between chunks if more remain
    if (i + CHUNK < rows.length) await new Promise(r => setTimeout(r, 500))
  }

  // Update final sent count on the record
  await c.env.DB.prepare(`UPDATE broadcast_sends SET sent_count=? WHERE id=?`).bind(sent, sendId).run()

  return c.json({ ok: true, sent, errors, total: rows.length, send_id: sendId })
})

// POST /api/admin/broadcast/send-one — send to a single user only (never touches the full list)
app.post('/api/admin/broadcast/send-one', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{
    subject: string
    html: string
    user_email: string
    broadcast_name?: string
  }>()

  const { subject, html, user_email, broadcast_name } = body
  if (!subject?.trim()) return c.json({ error: 'Subject required' }, 400)
  if (!html?.trim())    return c.json({ error: 'HTML content required' }, 400)
  if (!user_email?.trim()) return c.json({ error: 'user_email required' }, 400)

  const resendKey = (c.env as any).RESEND_API_KEY
  const mailerKey = (c.env as any).MAILERSEND_API_KEY
  if (!resendKey && !mailerKey) return c.json({ error: 'No email API key configured' }, 500)

  // Look up the specific user — fail hard if not found so we never guess
  const recipient = await c.env.DB.prepare(
    `SELECT id, email, name FROM users WHERE email=? LIMIT 1`
  ).bind(user_email.trim().toLowerCase()).first<{id:string, email:string, name:string}>()

  if (!recipient) return c.json({ error: `User not found: ${user_email}` }, 404)

  const siteUrl   = c.env.SITE_URL || 'https://stemforge.studio'
  const fromEmail = 'StemForge <noreply@stemforge.studio>'
  const sendName  = (broadcast_name?.trim() || subject.slice(0, 60)) + ' → ' + (recipient.name || recipient.email)

  // Create a send record so it shows up in Broadcast History
  const sendRecord = await c.env.DB.prepare(
    `INSERT INTO broadcast_sends (name, subject, audience, sent_count, opened_count) VALUES (?,?,?,0,0)`
  ).bind(sendName, subject, 'individual').run()
  const sendId = sendRecord.meta.last_row_id as number

  // Build personalised HTML with unsubscribe + open-tracking pixel
  const secret     = (c.env as any).SESSION_SECRET || 'sf'
  const unsubToken = await sha256Hex(recipient.id + secret)
  const openToken  = await sha256Hex(`${sendId}:${recipient.id}:${secret}`)
  const unsubUrl   = `${siteUrl}/api/unsubscribe?id=${recipient.id}&t=${unsubToken}`
  const pixelUrl   = `${siteUrl}/api/track/open?sid=${sendId}&t=${openToken}`
  const finalHtml  = html + `
<div style="margin-top:40px;padding-top:16px;border-top:1px solid #1e293b;text-align:center;font-size:11px;color:#475569;font-family:sans-serif">
  You're receiving this because you have a StemForge account.<br/>
  <a href="${unsubUrl}" style="color:#4e9fff">Unsubscribe</a>
</div>
<img src="${pixelUrl}" width="1" height="1" style="display:block;width:1px;height:1px;border:0;opacity:0" alt=""/>`

  // Send — Resend primary, MailerSend fallback
  let ok = false
  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromEmail, to: [recipient.email], subject, html: finalHtml })
    })
    ok = res.ok
  } else {
    const feedbackFrom = (c.env as any).FEEDBACK_FROM_EMAIL || 'noreply@stemforge.studio'
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mailerKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { email: feedbackFrom, name: 'StemForge' }, to: [{ email: recipient.email }], subject, html: finalHtml })
    })
    ok = res.ok || res.status === 202
  }

  if (!ok) {
    // Remove orphaned send record
    await c.env.DB.prepare(`DELETE FROM broadcast_sends WHERE id=?`).bind(sendId).run()
    return c.json({ error: 'Email delivery failed — check API key and domain verification' }, 500)
  }

  await c.env.DB.prepare(`UPDATE broadcast_sends SET sent_count=1 WHERE id=?`).bind(sendId).run()
  return c.json({ ok: true, sent: 1, to: recipient.email, name: recipient.name, send_id: sendId })
})

// GET /api/unsubscribe — one-click unsubscribe
app.get('/api/unsubscribe', async (c) => {
  const id = c.req.query('id')
  const t = c.req.query('t')
  if (!id || !t || !c.env.DB) return c.html('<p style="font-family:sans-serif;padding:2rem">Invalid unsubscribe link.</p>')
  const expected = await sha256Hex(id + ((c.env as any).SESSION_SECRET || 'sf'))
  if (t !== expected) return c.html('<p style="font-family:sans-serif;padding:2rem">Invalid unsubscribe link.</p>')
  await c.env.DB.prepare(`UPDATE users SET email_unsubscribed=1 WHERE id=?`).bind(id).run()
  return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Unsubscribed</title></head><body style="font-family:sans-serif;background:#0d0d1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center;padding:40px"><h2 style="color:#10b981">✓ Unsubscribed</h2><p style="color:#94a3b8">You've been removed from StemForge broadcast emails.</p><p style="color:#94a3b8;font-size:.85rem">You'll still receive important account emails (password reset, receipts).</p><a href="/" style="color:#4e9fff">← Back to StemForge</a></div></body></html>`)
})

// GET /admin — admin dashboard page
app.get('/admin', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.redirect('/')
  return c.html(adminPage(user!))
})

// GET /preview — admin only: view the site while in preview mode (bypasses gate)
app.get('/preview', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.redirect('/')
  return c.html(generatorPage())
})

// GET /api/admin/version-status
app.get('/api/admin/version-status', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const version = await getSiteVersion(c.env.DB)
  const updated_at = await getVersionUpdatedAt(c.env.DB)
  const staging_url = c.env.STAGING_URL || null
  const prod_url = c.env.SITE_URL || null
  return c.json({ version, updated_at, staging_url, prod_url })
})

// POST /api/admin/publish — flip live ↔ preview for ALL users
app.post('/api/admin/publish', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const { version } = await c.req.json<{ version: string }>().catch(() => ({ version: 'live' }))
  const v = version === 'preview' ? 'preview' : 'live'
  await setSiteVersion(c.env.DB, v)
  return c.json({ ok: true, version: v })
})

// GET /api/admin/analytics — aggregated page view analytics
app.get('/api/admin/analytics', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  // ensureAuthTables omitted — tables already exist in production; calling it on every request adds ~200ms latency
  const now = Date.now()
  const dayMs = 86400000
  const todayStart = now - (now % dayMs)
  const weekStart = todayStart - 6 * dayMs
  const monthStart = todayStart - 29 * dayMs

  // Run analytics queries sequentially to avoid overwhelming D1 with parallel scans
  // Each query has a catch so one failure doesn't break the whole response
  const todayRow      = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= ?`).bind(todayStart).first<any>().catch(() => ({ cnt: 0 }))
  const weekRow       = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= ?`).bind(weekStart).first<any>().catch(() => ({ cnt: 0 }))
  const monthRow      = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= ?`).bind(monthStart).first<any>().catch(() => ({ cnt: 0 }))
  const sourcesRow    = await c.env.DB.prepare(`SELECT source, COUNT(*) as cnt FROM page_views WHERE created_at >= ? GROUP BY source ORDER BY cnt DESC LIMIT 20`).bind(monthStart).all<any>().catch(() => ({ results: [] }))
  const topPagesRow   = await c.env.DB.prepare(`SELECT path, COUNT(*) as cnt FROM page_views WHERE created_at >= ? GROUP BY path ORDER BY cnt DESC LIMIT 10`).bind(monthStart).all<any>().catch(() => ({ results: [] }))
  const dailyRows     = await c.env.DB.prepare(`SELECT CAST((created_at / 86400000) AS INTEGER) as day_bucket, COUNT(*) as cnt FROM page_views WHERE created_at >= ? GROUP BY day_bucket ORDER BY day_bucket ASC LIMIT 30`).bind(monthStart).all<any>().catch(() => ({ results: [] }))
  const busyErrRow    = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM api_errors WHERE created_at >= ?`).bind(monthStart).first<any>().catch(() => ({ cnt: 0 }))
  const busyErrTodayRow = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM api_errors WHERE created_at >= ?`).bind(todayStart).first<any>().catch(() => ({ cnt: 0 }))
  const busyErrByTypeRow = await c.env.DB.prepare(`SELECT error_type, COUNT(*) as cnt FROM api_errors WHERE created_at >= ? GROUP BY error_type`).bind(monthStart).all<any>().catch(() => ({ results: [] }))
  const countriesRow  = await c.env.DB.prepare(`SELECT country, COUNT(*) as cnt FROM page_views WHERE created_at >= ? AND country IS NOT NULL AND country != '' GROUP BY country ORDER BY cnt DESC LIMIT 50`).bind(monthStart).all<any>().catch(() => ({ results: [] }))

  return c.json({
    today: (todayRow as any)?.cnt || 0,
    week: (weekRow as any)?.cnt || 0,
    month: (monthRow as any)?.cnt || 0,
    sources: (sourcesRow as any)?.results || [],
    top_pages: (topPagesRow as any)?.results || [],
    daily: (dailyRows as any)?.results || [],
    busy_errors_30d: (busyErrRow as any)?.cnt || 0,
    busy_errors_today: (busyErrTodayRow as any)?.cnt || 0,
    busy_errors_by_type: (busyErrByTypeRow as any)?.results || [],
    countries: (countriesRow as any)?.results || [],
  })
})

// GET /api/admin/revenue — MRR and profit breakdown
app.get('/api/admin/revenue', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  const [plansRow, jobsRow, creditPacksRow, recentSubsRow] = await Promise.all([
    c.env.DB.prepare(`SELECT plan, COUNT(*) as cnt FROM users GROUP BY plan`).all<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as this_month FROM jobs`).bind(Date.now() - 30*86400000).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt, SUM(amount) as total FROM credit_purchases WHERE created_at >= ?`).bind(Date.now() - 30*86400000).first<any>().catch(() => ({ cnt: 0, total: 0 })),
    c.env.DB.prepare(`SELECT email, name, plan, created_at FROM users WHERE plan IN ('pro','creator') ORDER BY created_at DESC LIMIT 20`).all<any>(),
  ])

  const planMap: Record<string, number> = {}
  for (const row of (plansRow.results || [])) {
    planMap[row.plan] = row.cnt
  }

  const proCount = planMap['pro'] || 0
  const creatorCount = planMap['creator'] || 0
  const freeCount = planMap['free'] || 0

  const mrr = (proCount * 26) + (creatorCount * 10)
  const creditPackRevenue = (creditPacksRow as any)?.total || 0

  // Estimated costs (rough)
  const jobsThisMonth = (jobsRow as any)?.this_month || 0
  const musicapiCostPerJob = 0.04 // approx
  const estimatedMusicapiCost = jobsThisMonth * musicapiCostPerJob
  const cloudflareWorkersCost = 0 // free tier for most usage
  const estimatedTotalCost = estimatedMusicapiCost + cloudflareWorkersCost
  const estimatedProfit = mrr + creditPackRevenue - estimatedTotalCost

  return c.json({
    mrr,
    pro_count: proCount,
    creator_count: creatorCount,
    free_count: freeCount,
    credit_pack_revenue: creditPackRevenue,
    estimated_musicapi_cost: parseFloat(estimatedMusicapiCost.toFixed(2)),
    estimated_total_cost: parseFloat(estimatedTotalCost.toFixed(2)),
    estimated_profit: parseFloat(estimatedProfit.toFixed(2)),
    jobs_this_month: jobsThisMonth,
    recent_subscribers: recentSubsRow.results || [],
  })
})

// GET /api/admin/ping — zero-DB health check, confirms Worker is alive and auth cookie works
// POST /api/admin/security/change-password — admin changes their own login password
app.post('/api/admin/security/change-password', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  const { current_password, new_password } = await c.req.json<{ current_password: string; new_password: string }>()
  if (!new_password) return c.json({ error: 'new_password required' }, 400)
  if (new_password.length < 6) return c.json({ error: 'New password must be at least 6 characters' }, 400)

  // Fetch latest user row (need password_hash)
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user!.id).first<any>()
  if (!row) return c.json({ error: 'User not found' }, 404)

  if (row.password_hash) {
    // Account already has a password — verify the current one
    if (!current_password) return c.json({ error: 'Current password is required' }, 400)
    const valid = await verifyPassword(current_password, row.password_hash)
    if (!valid) return c.json({ error: 'Current password is incorrect' }, 401)
  }
  // If no password_hash exists yet, this is the first password — skip verification

  // Hash and store new password
  const newHash = await hashPassword(new_password)
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user!.id).run()

  return c.json({ ok: true, message: 'Password updated successfully' })
})

// POST /api/admin/security/change-email — update admin email in user DB
// Note: this only updates the DB record — the ADMIN_EMAIL env secret still
// controls route-level admin gating and must be updated separately in CF dashboard.
app.post('/api/admin/security/change-email', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  const { new_email } = await c.req.json<{ new_email: string }>()
  if (!new_email || !new_email.includes('@')) return c.json({ error: 'Valid email required' }, 400)

  // Check not already taken by another user
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(new_email.toLowerCase(), user!.id).first<any>()
  if (existing) return c.json({ error: 'That email is already in use by another account' }, 409)

  await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(new_email.toLowerCase(), user!.id).run()
  return c.json({ ok: true, message: 'Email updated in database. Update ADMIN_EMAIL secret in Cloudflare dashboard to match.' })
})

app.get('/api/admin/ping', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB/secret', admin: false })
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  return c.json({ ok: true, admin: isAdmin(user, c.env), email: user?.email || null, plan: user?.plan || null, ts: Date.now() })
})


// GET /api/admin/fix-indexes — one-shot: create missing DB indexes for performance
app.get('/api/admin/fix-indexes', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const results: string[] = []
  const run = async (label: string, sql: string) => {
    try { await c.env.DB.prepare(sql).run(); results.push(`✅ ${label}`) }
    catch (e: any) { results.push(`⚠️ ${label}: ${e?.message || e}`) }
  }
  await run('idx_page_views_created_at', `CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views (created_at)`)
  await run('idx_jobs_user_id',          `CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id)`)
  await run('idx_jobs_created_at',       `CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at)`)
  await run('idx_sessions_user_id',      `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)`)
  await run('idx_users_plan',            `CREATE INDEX IF NOT EXISTS idx_users_plan ON users (plan)`)
  return c.json({ ok: true, results })
})

// GET /api/admin/stats — overview stats
app.get('/api/admin/stats', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  // Run as individual fast queries — avoid slow SUM(CASE WHEN) full scan
  const [totalRow, proRow, creatorRow, freeRow, jobsRow] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM users`).first<any>().catch(() => ({ total: 0 })),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE plan='pro'`).first<any>().catch(() => ({ cnt: 0 })),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE plan='creator'`).first<any>().catch(() => ({ cnt: 0 })),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE plan='free'`).first<any>().catch(() => ({ cnt: 0 })),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM jobs`).first<any>().catch(() => ({ total: 0 })),
  ])
  return c.json({
    users: {
      total: (totalRow as any)?.total || 0,
      pro_count: (proRow as any)?.cnt || 0,
      creator_count: (creatorRow as any)?.cnt || 0,
      free_count: (freeRow as any)?.cnt || 0,
    },
    jobs: { total: (jobsRow as any)?.total || 0 }
  })
})

// GET /api/admin/users — list all users (with optional search)
app.get('/api/admin/users', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const q = (c.req.query('q') || '').trim()
  let rows
  if (q) {
    const like = `%${q}%`
    rows = await c.env.DB.prepare(
      `SELECT id,email,name,plan,gens_used,gens_limit,bonus_credits,account_locked,lock_reason,stripe_subscription_id,stripe_customer_id,created_at,cycle_start,signup_source,signup_referrer,welcome_sent_at FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 200`
    ).bind(like, like).all<any>()
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id,email,name,plan,gens_used,gens_limit,bonus_credits,account_locked,lock_reason,stripe_subscription_id,stripe_customer_id,created_at,cycle_start,signup_source,signup_referrer,welcome_sent_at FROM users ORDER BY created_at DESC LIMIT 200`
    ).all<any>()
  }
  // Enrich with Stripe renewal date where available (batch — one Stripe call per user with sub)
  const users = rows.results || []
  // Return raw users without Stripe calls for speed — renewal date fetched client-side per-row if needed
  return c.json({ users })
})

// GET /api/admin/user-renewal/:userId — fetch Stripe renewal date for a single user
app.get('/api/admin/user-renewal/:userId', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const admin = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(admin, c.env)) return c.json({ error: 'Forbidden' }, 403)
  if (!stripeConfigured(c.env)) return c.json({ renewal_date: null })
  const userId = c.req.param('userId')
  const dbUser = await c.env.DB.prepare(`SELECT stripe_subscription_id FROM users WHERE id=?`).bind(userId).first<{stripe_subscription_id:string|null}>()
  if (!dbUser?.stripe_subscription_id) return c.json({ renewal_date: null })
  try {
    const sub = await stripeRequest('GET', `/subscriptions/${dbUser.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
    const item0 = sub.items?.data?.[0]
    const periodEnd: number = item0?.current_period_end ?? sub.current_period_end
    if (!periodEnd) return c.json({ renewal_date: null })
    const renewal_date = new Date(periodEnd * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return c.json({ renewal_date })
  } catch { return c.json({ renewal_date: null }) }
})

// POST /api/admin/user/update — update a user's plan or credits
app.post('/api/admin/user/update', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const { user_id, plan, gens_limit } = await c.req.json<any>()
  if (!user_id) return c.json({ error: 'Missing user_id' }, 400)
  await c.env.DB.prepare(`UPDATE users SET plan=COALESCE(?,plan), gens_limit=COALESCE(?,gens_limit) WHERE id=?`).bind(plan||null, gens_limit||null, user_id).run()
  return c.json({ ok: true })
})

// POST /api/admin/user/add-credits — ADD points on top of existing gens_limit (never replace)
app.post('/api/admin/user/add-credits', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const { user_id, amount } = await c.req.json<any>()
  if (!user_id) return c.json({ error: 'Missing user_id' }, 400)
  const amt = parseInt(amount)
  if (!amt || isNaN(amt)) return c.json({ error: 'Invalid amount' }, 400)
  // Fetch current values so we can return them — admin-added credits go to bonus_credits
  const before = await c.env.DB.prepare(`SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id=?`).bind(user_id).first<{gens_used:number,gens_limit:number,bonus_credits:number}>()
  if (!before) return c.json({ error: 'User not found' }, 404)
  const newBonus = (before.bonus_credits ?? 0) + amt
  await c.env.DB.prepare(`UPDATE users SET bonus_credits=? WHERE id=?`).bind(newBonus, user_id).run()
  return c.json({ ok: true, bonus_credits: newBonus, gens_used: before.gens_used, gens_limit: before.gens_limit, remaining: (before.gens_limit - before.gens_used) + newBonus })
})

// POST /api/admin/user/lock — lock or unlock a user account
app.post('/api/admin/user/lock', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const { user_id, locked, reason } = await c.req.json<any>()
  if (!user_id) return c.json({ error: 'Missing user_id' }, 400)
  await c.env.DB.prepare(`UPDATE users SET account_locked=?, lock_reason=? WHERE id=?`)
    .bind(locked ? 1 : 0, locked ? (reason || 'Account disabled by admin') : null, user_id).run()
  return c.json({ ok: true, locked: !!locked })
})

// DELETE /api/admin/user/:id — permanently delete a user account
app.delete('/api/admin/user/:id', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const adminUser = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(adminUser, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const userId = c.req.param('id')
  if (!userId) return c.json({ error: 'Missing user id' }, 400)
  // Delete sessions first, then the user
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(userId).run()
  const result = await c.env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(userId).run()
  return c.json({ ok: true, deleted: result.meta?.changes ?? 0 })
})

// GET /api/admin/promos — list all promo codes
app.get('/api/admin/promos', async (c) => {
  // No ensureAuthTables — tables exist in production already
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  await ensureAuthTables(c.env.DB)
  const rows = await c.env.DB.prepare(`SELECT * FROM promo_codes ORDER BY created_at DESC`).all<any>()
  return c.json({ promos: rows.results || [] })
})

// POST /api/admin/promos — create a promo code
app.post('/api/admin/promos', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  await ensureAuthTables(c.env.DB)
  const { code, description, discount_type, discount_value, max_uses, bonus_credits, plan_override, expires_at, terms, active } = await c.req.json<any>()
  if (!code) return c.json({ error: 'Missing code' }, 400)
  const upperCode = code.toUpperCase().trim()
  await c.env.DB.prepare(`INSERT INTO promo_codes (code,description,discount_type,discount_value,max_uses,uses_count,plan_override,bonus_credits,active,expires_at,terms,created_at) VALUES (?,?,?,?,?,0,?,?,?,?,?,?)`).bind(upperCode, description||'', discount_type||'percent', discount_value||0, max_uses||0, plan_override||null, bonus_credits||0, active===false?0:1, expires_at||null, terms||'', Date.now()).run()
  return c.json({ ok: true, code: upperCode })
})

// PUT /api/admin/promos/:code — update a promo code
app.put('/api/admin/promos/:code', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const code = c.req.param('code').toUpperCase()
  const body = await c.req.json<any>()
  await c.env.DB.prepare(`UPDATE promo_codes SET description=COALESCE(?,description), discount_type=COALESCE(?,discount_type), discount_value=COALESCE(?,discount_value), max_uses=COALESCE(?,max_uses), bonus_credits=COALESCE(?,bonus_credits), active=COALESCE(?,active), expires_at=COALESCE(?,expires_at), terms=COALESCE(?,terms), plan_override=COALESCE(?,plan_override) WHERE code=?`)
    .bind(body.description??null, body.discount_type??null, body.discount_value??null, body.max_uses??null, body.bonus_credits??null, body.active??null, body.expires_at??null, body.terms??null, body.plan_override??null, code).run()
  return c.json({ ok: true })
})

// DELETE /api/admin/promos/:code — deactivate a promo code
app.delete('/api/admin/promos/:code', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const code = c.req.param('code').toUpperCase()
  await c.env.DB.prepare(`UPDATE promo_codes SET active=0 WHERE code=?`).bind(code).run()
  return c.json({ ok: true })
})

// POST /api/admin/activate-developer — activate developer plan on own account
app.post('/api/admin/activate-developer', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  // Only allow if email matches ADMIN_EMAIL env var
  if (!c.env.ADMIN_EMAIL || user.email !== c.env.ADMIN_EMAIL) {
    return c.json({ error: 'Not authorized — set ADMIN_EMAIL secret to your email first' }, 403)
  }
  await c.env.DB.prepare(`UPDATE users SET plan='developer', gens_limit=999999 WHERE id=?`).bind(user.id).run()
  return c.json({ ok: true, message: 'Developer plan activated. Unlimited access granted.' })
})

// ─── ELEVENLABS CREDITS MONITOR ──────────────────────────────────────────────
// GET /api/admin/elevenlabs-credits — returns local D1-based usage tracking
// Note: ElevenLabs API key only has sound_generation scope (not user_read),
//       so /v1/user/subscription returns 401. We track usage locally instead.
// ElevenLabs free tier: 10,000 characters/month
app.get('/api/admin/elevenlabs-credits', async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token && c.env.DB ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  if (!c.env.ELEVENLABS_API_KEY) {
    return c.json({ error: 'ELEVENLABS_API_KEY not configured', character_limit: 10000, character_count: 0, remaining: 10000 }, 200)
  }

  try {
    // Ensure el_usage table exists
    await c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS el_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, chars INTEGER NOT NULL, created_at INTEGER NOT NULL)`
    ).run()

    // Get current month boundaries (UTC)
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime()
    const nextMonth  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const nextReset  = nextMonth.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

    // Sum characters used this month
    const row = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(chars), 0) as total_chars, COUNT(*) as total_calls FROM el_usage WHERE created_at >= ?`
    ).bind(monthStart).first<{ total_chars: number; total_calls: number }>()

    const used      = row?.total_chars ?? 0
    const calls     = row?.total_calls ?? 0
    const limit     = 10000  // ElevenLabs free tier monthly limit
    const remaining = Math.max(0, limit - used)

    // Also get all-time totals for context
    const allTime = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(chars), 0) as total_chars, COUNT(*) as total_calls FROM el_usage`
    ).first<{ total_chars: number; total_calls: number }>()

    return c.json({
      ok: true,
      tier: 'free',
      character_limit: limit,
      character_count: used,
      remaining,
      total_calls_month: calls,
      all_time_chars: allTime?.total_chars ?? 0,
      all_time_calls: allTime?.total_calls ?? 0,
      next_reset: nextReset,
      tracking_note: 'Usage tracked locally (API key has sound_generation scope only)'
    })
  } catch (e: any) {
    return c.json({ error: e.message || 'Unknown error', character_limit: 10000, character_count: 0, remaining: 10000 }, 200)
  }
})

// ─── MUSICAPI USAGE MONITOR ──────────────────────────────────────────────────
// GET /api/musicapi/balance — returns D1-based usage stats + MusicAPI credit balance
app.get('/api/musicapi/balance', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  try {
    // MusicAPI usage stats from D1 + credit check from MusicAPI
    const todayStart = new Date(); todayStart.setHours(0,0,0,0)
    const todayTs = todayStart.getTime()

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM generations WHERE provider='musicapi' OR provider='mureka'`
    ).first<{ cnt: number }>().catch(() => null)

    const todayRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM generations WHERE (provider='musicapi' OR provider='mureka') AND created_at >= ?`
    ).bind(todayTs).first<{ cnt: number }>().catch(() => null)

    const recentRows = await c.env.DB.prepare(
      `SELECT id, title, status, created_at FROM generations WHERE provider IN ('musicapi','mureka') ORDER BY created_at DESC LIMIT 10`
    ).all<{ id: string; title: string; status: string; created_at: number }>().catch(() => ({ results: [] }))

    // Attempt to fetch MusicAPI credit balance
    let creditBalance: number | null = null
    try {
      const creditRes = await fetch(`${MUSICAPI_SONIC}/credits`, {
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
      })
      if (creditRes.ok) {
        const cd = await creditRes.json() as any
        creditBalance = cd.credits ?? cd.balance ?? cd.remaining ?? null
      }
    } catch {}

    return c.json({
      ok: true,
      note: 'MusicAPI usage stats from D1. Credit balance fetched live from MusicAPI.',
      credit_balance: creditBalance,
      total_generations: totalRow?.cnt ?? 0,
      generations_today: todayRow?.cnt ?? 0,
      recent: recentRows?.results ?? []
    })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Stats fetch failed' }, 500)
  }
})

// GET /musicapi-monitor — MusicAPI usage monitor page (admin only)
app.get('/musicapi-monitor', async (c) => {
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.redirect('/login')
  return c.html(musicapiMonitorPage())
})

function musicapiMonitorPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Music API Monitor — StemForge Admin</title>
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-74RCBZK52L"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-74RCBZK52L');
</script>
<!-- Meta Pixel -->
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init','440081228562920');
fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=440081228562920&ev=PageView&noscript=1"/></noscript>
<!-- TikTok Pixel -->
<script>
!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};ttq.load('D9SVAV3C77UA78AD7EU0');ttq.load('DAFIT1JC77UES974NPK0');ttq.load('DANT6N3C77U88MSNTF7G');ttq.page()}(window,document,'ttq');
</script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
<link href="/static/style.css?v=${ASSET_VER}" rel="stylesheet"/>
<style>
  body{background:#0d0d1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:0;margin:0}
  .monitor-wrap{max-width:720px;margin:0 auto;padding:40px 24px}
  .monitor-card{background:#151525;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px 32px;margin-bottom:24px}
  .stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:8px}
  .stat-box{background:#0d0d1a;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:20px;text-align:center}
  .stat-number{font-size:2.4rem;font-weight:800;color:#4e9fff;line-height:1}
  .stat-label{font-size:.78rem;color:#64748b;margin-top:6px;text-transform:uppercase;letter-spacing:.04em}
  .notice-box{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;gap:14px;align-items:flex-start}
  .notice-icon{color:#f59e0b;font-size:1.1rem;margin-top:1px;flex-shrink:0}
  .notice-text{font-size:.85rem;color:#cbd5e1;line-height:1.55}
  .notice-text strong{color:#f59e0b}
  .btn-primary{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:#4e9fff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:.88rem;text-decoration:none}
  .btn-primary:hover{background:#3b82f6}
  .btn-refresh{background:rgba(78,159,255,.12);border:1px solid rgba(78,159,255,.3);color:#4e9fff;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:600}
  .btn-refresh:hover{background:rgba(78,159,255,.2)}
  h2{font-size:1.1rem;font-weight:700;margin:0 0 20px;color:#e2e8f0}
  .gen-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.83rem}
  .gen-row:last-child{border-bottom:none}
  .gen-status{padding:2px 8px;border-radius:4px;font-size:.75rem;font-weight:600}
  .gen-status--done{background:rgba(16,185,129,.15);color:#10b981}
  .gen-status--fail{background:rgba(239,68,68,.15);color:#ef4444}
  .gen-status--pend{background:rgba(245,158,11,.15);color:#f59e0b}
  .empty-state{color:#64748b;font-size:.85rem;padding:16px 0}
</style>
</head>
<body>
<div class="monitor-wrap">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
    <a href="/admin" style="color:#94a3b8;font-size:.85rem;text-decoration:none"><i class="fas fa-arrow-left"></i> Admin</a>
    <h1 style="font-size:1.4rem;font-weight:800;margin:0;flex:1">Music API Monitor</h1>
    <button class="btn-refresh" onclick="loadStats()"><i class="fas fa-sync-alt"></i> Refresh</button>
  </div>

  <!-- Credit Balance -->
  <div class="notice-box">
    <i class="fas fa-coins notice-icon"></i>
    <div class="notice-text">
      <strong>API Credit Balance: <span id="credit-balance" style="color:#4e9fff">loading…</span></strong><br/>
      Credits are fetched live from the generation API. Sonic + Producer models share the same account balance.<br/>
      <br/>
      <a href="https://musicapi.ai/dashboard" target="_blank" rel="noopener" class="btn-primary" style="margin-top:4px">
        <i class="fas fa-external-link-alt"></i> MusicAPI Dashboard
      </a>
    </div>
  </div>

  <!-- Usage Stats -->
  <div class="monitor-card">
    <h2><i class="fas fa-chart-bar" style="color:#4e9fff;margin-right:8px"></i>Generation Usage</h2>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-number" id="stat-today">—</div>
        <div class="stat-label">Generations Today</div>
      </div>
      <div class="stat-box">
        <div class="stat-number" id="stat-total">—</div>
        <div class="stat-label">Total Generations</div>
      </div>
    </div>
    <p style="font-size:.78rem;color:#475569;margin:12px 0 0">Counts all jobs sent to the music API via StemForge.</p>
  </div>

  <!-- Recent Generations -->
  <div class="monitor-card">
    <h2><i class="fas fa-history" style="color:#94a3b8;margin-right:8px"></i>Recent Jobs</h2>
    <div id="recent-list"><div class="empty-state">Loading…</div></div>
  </div>
</div>

<script>
async function loadStats() {
  try {
    const res = await fetch('/api/musicapi/balance');
    const data = await res.json();

    document.getElementById('stat-today').textContent = data.generations_today ?? '—';
    document.getElementById('stat-total').textContent = data.total_generations ?? '—';
    document.getElementById('credit-balance').textContent = data.credit_balance != null ? data.credit_balance + ' credits' : 'unavailable';

    const recent = data.recent || [];
    const listEl = document.getElementById('recent-list');
    if (!recent.length) {
      listEl.innerHTML = '<div class="empty-state">No generations recorded yet.</div>';
      return;
    }
    listEl.innerHTML = recent.map(g => {
      const ts = g.created_at ? new Date(g.created_at).toLocaleString() : '—';
      const st = (g.status || 'unknown').toLowerCase();
      const cls = st === 'completed' || st === 'done' ? 'gen-status--done'
                : st === 'failed' || st === 'error'   ? 'gen-status--fail'
                : 'gen-status--pend';
      return '<div class="gen-row">' +
        '<span style="color:#cbd5e1;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (g.title || g.id || '—') + '</span>' +
        '<div style="display:flex;align-items:center;gap:12px;flex-shrink:0">' +
          '<span style="color:#475569;font-size:.75rem">' + ts + '</span>' +
          '<span class="gen-status ' + cls + '">' + (g.status || 'unknown') + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    document.getElementById('stat-today').textContent = 'err';
    document.getElementById('stat-total').textContent = 'err';
    document.getElementById('recent-list').innerHTML = '<div class="empty-state" style="color:#ef4444">' + e.message + '</div>';
  }
}

window.onload = loadStats;
</script>
</body>
</html>`
}

// ─── CREDIT PACK ROUTES ───────────────────────────────────────────────────────

// GET /api/credit-packs — list available credit packs
app.get('/api/credit-packs', async (c) => {
  if (!c.env.DB) return c.json({ packs: defaultCreditPacks })
  return c.json({ packs: defaultCreditPacks })
})

const defaultCreditPacks = [
  { id: 'pack_150',  name: '150 Points',  credits: 150,  price_cents: 499,  label: '$4.99',  popular: false },
  { id: 'pack_600',  name: '600 Points',  credits: 600,  price_cents: 999,  label: '$9.99',  popular: true  },
  { id: 'pack_1000', name: '1000 Points', credits: 1000, price_cents: 1799, label: '$17.99', popular: false },
  { id: 'pack_1500', name: '1500 Points', credits: 1500, price_cents: 2999, label: '$29.99', popular: false },
]

// POST /api/credit-packs/purchase — create a one-time Stripe payment for a credit pack
app.post('/api/credit-packs/purchase', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!stripeConfigured(c.env)) return c.json({ error: 'Stripe not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Must be logged in' }, 401)
  const { pack_id } = await c.req.json<{ pack_id: string }>()
  const pack = defaultCreditPacks.find(p => p.id === pack_id)
  if (!pack) return c.json({ error: 'Invalid pack' }, 400)
  const siteUrl = c.env.SITE_URL || 'https://localhost:3000'
  // Create a Stripe checkout session for one-time payment
  const session = await stripeRequest('POST', '/checkout/sessions', {
    'payment_method_types[]': 'card',
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': pack.name,
    'line_items[0][price_data][product_data][description]': `${pack.credits} points for StemForge`,
    'line_items[0][price_data][unit_amount]': String(pack.price_cents),
    'line_items[0][quantity]': '1',
    'metadata[user_id]': user.id,
    'metadata[pack_id]': pack.id,
    'metadata[credits]': String(pack.credits),
    'metadata[type]': 'credit_pack',
    success_url: `${siteUrl}/subscription?credits=added`,
    cancel_url: `${siteUrl}/subscription`,
    customer_email: user.email,
  }, c.env.STRIPE_SECRET_KEY)
  return c.json({ url: session.url })
})

// ─── GENERATE LYRICS ROUTE ────────────────────────────────────────────────────

// POST /api/generate-lyrics — AI generates lyrics from a description
app.post('/api/generate-lyrics', async (c) => {
  if (!c.env.OPENAI_API_KEY) return c.json({ error: 'OpenAI not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Must be logged in to generate lyrics' }, 401)
  const { description, genre, mood } = await c.req.json<{ description: string; genre?: string; mood?: string }>()
  if (!description) return c.json({ error: 'Missing description' }, 400)

  const systemPrompt = `You are a professional songwriter across all genres. Write song lyrics based on the artist's description. Structure lyrics with [Intro], [Verse 1], [Chorus], [Verse 2], [Chorus], [Outro] sections. Make lyrics authentic, rhythmic, and genre-appropriate. Do NOT include any commentary — just the lyrics.`
  const userPrompt = `Write song lyrics for a ${genre || 'music'} track with a ${mood || 'energetic'} feel. The song is about: "${description}". Include proper sections with labels like [Verse 1], [Chorus], etc.`

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.9, max_tokens: 800 })
  })
  if (!res.ok) return c.json({ error: 'Lyrics generation failed' }, 500)
  const data = await res.json() as any
  const lyrics = data.choices?.[0]?.message?.content?.trim()
  if (!lyrics) return c.json({ error: 'No lyrics generated' }, 500)
  return c.json({ lyrics })
})

// GET /api/extend-audio-proxy/:key — serve R2-stored audio files (extend + remix uploads)
// Used by upload-extend-audio and upload-remix-audio routes to give MusicAPI a public URL.
// IMPORTANT: Must send Content-Length — Sonic's /upload endpoint rejects responses without it.
// We materialise the R2 object as ArrayBuffer so we know the exact byte count before responding.
app.get('/api/extend-audio-proxy/:key', async (c) => {
  if (!c.env.IMAGES) return c.json({ error: 'Storage unavailable' }, 503)
  const rawKey = c.req.param('key')
  // Try extend-uploads/ first (original extend flow), then remix-uploads/ (new remix flow)
  let obj = await c.env.IMAGES.get(`extend-uploads/${rawKey}`)
  if (!obj) obj = await c.env.IMAGES.get(`remix-uploads/${rawKey}`)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  const ctype = obj.httpMetadata?.contentType || 'audio/mpeg'
  // Materialise into ArrayBuffer so we can provide Content-Length (required by Sonic's uploader)
  const buf = await obj.arrayBuffer()
  const rangeHeader = c.req.header('Range')
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (match) {
      const total = buf.byteLength
      const start = parseInt(match[1])
      const end   = match[2] ? parseInt(match[2]) : total - 1
      const chunk = buf.slice(start, end + 1)
      return new Response(chunk, {
        status: 206,
        headers: {
          'Content-Type': ctype,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(chunk.byteLength),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
  }
  return new Response(buf, {
    headers: {
      'Content-Type': ctype,
      'Content-Length': String(buf.byteLength),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    }
  })
})

// stripMp3Id3 — remove leading ID3v2 tag from an MP3 ArrayBuffer.
// When two MP3 files are concatenated the second file's ID3 tag confuses
// browsers: they see two stream headers, misread the duration, and cut off
// playback at the seam.  Stripping it gives a single clean bitstream.
function stripMp3Id3(buf: ArrayBuffer): ArrayBuffer {
  const view = new Uint8Array(buf)
  if (view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) { // 'ID3'
    const tagSize =
      ((view[6] & 0x7f) << 21) |
      ((view[7] & 0x7f) << 14) |
      ((view[8] & 0x7f) << 7)  |
       (view[9] & 0x7f)
    const headerLen = 10 + tagSize
    return buf.slice(headerLen)
  }
  return buf
}


// POST /api/upload-extend-audio — upload audio for Song Extend
// Accepts: multipart { file } or JSON { audio_url }
// Flow:
//   1. Store file in R2 → get public proxy URL
//   2. POST /sonic/upload { url } → { task_id }  (kicks off Sonic processing)
//   3. Return { task_id } so frontend can poll /api/poll-upload-task/:taskId
//   4. When clip_id is ready, extend-upload uses continue_clip_id (reliable path)
app.post('/api/upload-extend-audio', async (c) => {
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
  const contentType = c.req.header('content-type') || ''

  // Helper: call /sonic/upload — returns clip_id directly (synchronous) or task_id (async).
  // /sonic/upload is mostly synchronous — clip_id comes back immediately with code:200.
  // If task_id is returned, the frontend can poll /api/poll-upload-task/:taskId.
  async function sonicUploadUrl(audioUrl: string): Promise<{ clip_id: string | null; task_id: string | null }> {
    if (!c.env.MUSICAPI_KEY) return { clip_id: null, task_id: null }
    try {
      const res = await fetch(`${MUSICAPI_SONIC}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: audioUrl })
      })
      const text = await res.text()
      console.log(`[upload-extend-audio] /sonic/upload HTTP ${res.status} raw: ${text.slice(0, 300)}`)
      if (!res.ok) return { clip_id: null, task_id: null }
      let data: any = {}
      try { data = JSON.parse(text) } catch {}
      // /sonic/upload returns clip_id directly (synchronous) OR task_id for async polling
      const clipId = data.clip_id || null
      const taskId = data.task_id || (clipId ? null : (data.id || null))
      return { clip_id: clipId, task_id: taskId }
    } catch (e: any) {
      console.warn('[upload-extend-audio] /sonic/upload error:', e?.message)
      return { clip_id: null, task_id: null }
    }
  }

  // JSON body: { audio_url } — caller provides URL directly
  if (contentType.includes('application/json')) {
    const body = await c.req.json<{ audio_url?: string; url?: string }>().catch(() => ({}))
    const directUrl = body.audio_url || body.url || null
    if (!directUrl) return c.json({ error: 'audio_url required' }, 400)
    console.log(`[upload-extend-audio] JSON url: ${directUrl.slice(0, 80)}`)
    const sonic = await sonicUploadUrl(directUrl)
    if (sonic.clip_id) return c.json({ ok: true, audio_url: directUrl, clip_id: sonic.clip_id })
    if (sonic.task_id) return c.json({ ok: true, audio_url: directUrl, task_id: sonic.task_id })
    return c.json({ ok: true, audio_url: directUrl, status: 'ready' })
  }

  // Multipart: file blob or url field
  const formData = await c.req.formData()
  const urlField = formData.get('url') as string | null
  if (urlField) {
    console.log(`[upload-extend-audio] Form url: ${urlField.slice(0, 80)}`)
    const sonic = await sonicUploadUrl(urlField)
    if (sonic.clip_id) return c.json({ ok: true, audio_url: urlField, clip_id: sonic.clip_id })
    if (sonic.task_id) return c.json({ ok: true, audio_url: urlField, task_id: sonic.task_id })
    return c.json({ ok: true, audio_url: urlField, status: 'ready' })
  }

  // File blob — store in R2 first, then call Sonic upload
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file or url provided' }, 400)
  if (!c.env.IMAGES) return c.json({ error: 'File storage not configured' }, 500)

  // Use clean timestamp+random key (NO filename/extension).
  const r2Key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const fileContentType = file.type || (file.name?.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg')
  await c.env.IMAGES.put(`extend-uploads/${r2Key}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: fileContentType }
  })
  // audioUrl = Worker proxy URL (served by our Worker with full Content-Length + CORS)
  // This is the URL we give to MusicAPI — it's publicly accessible, no auth required,
  // and serves the file with all required headers.
  // R2 public access IS enabled (pub-8e434559eec949638897e09ecee99a88.r2.dev).
  // For upload-extend (user-uploaded files), we use the Worker proxy URL because
  // freshly-uploaded files may not yet be under the beats/ R2 key structure.
  // For library extends (job/extend), we use R2 public URL directly.
  const audioUrl = `${siteUrl}/api/extend-audio-proxy/${r2Key}`
  console.log(`[upload-extend-audio] R2 stored. proxy=${audioUrl} r2Key=${r2Key}`)

  // Try sonic/upload with the Worker proxy URL (publicly accessible, Content-Length set)
  const sonic = await sonicUploadUrl(audioUrl)
  if (sonic.clip_id) {
    console.log(`[upload-extend-audio] /sonic/upload clip_id: ${sonic.clip_id}`)
    return c.json({ ok: true, audio_url: audioUrl, clip_id: sonic.clip_id })
  }
  if (sonic.task_id) {
    console.log(`[upload-extend-audio] /sonic/upload task_id: ${sonic.task_id}`)
    return c.json({ ok: true, audio_url: audioUrl, task_id: sonic.task_id })
  }

  // /sonic/upload returned 400 — MusicAPI's URL downloader is currently broken globally.
  // Confirmed: returns HTTP 400 for ALL URLs including their own documented examples.
  // This is a MusicAPI service outage, not a URL problem.
  // Fallback: try /sonic/upload-extend directly (also uses URL download — likely also broken).
  console.log(`[upload-extend-audio] /sonic/upload failed (MusicAPI URL downloader outage) — trying /sonic/upload-extend`)
  try {
    const ueBody: Record<string, any> = {
      url: audioUrl,
      mv: 'sonic-v5',
      continue_at: 60,         // placeholder — real continue_at set later by extend-upload
      custom_mode: false,
      make_instrumental: true, // safe default; user's actual make_instrumental set later
      gpt_description_prompt: 'Continue this track in the same style'
    }
    const ueRes = await fetch(`${MUSICAPI_SONIC}/upload-extend`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ueBody)
    })
    const ueText = await ueRes.text()
    console.log(`[upload-extend-audio] /sonic/upload-extend HTTP ${ueRes.status} raw: ${ueText.slice(0, 400)}`)
    if (ueRes.ok) {
      let ueData: any = {}
      try { ueData = JSON.parse(ueText) } catch {}
      // upload-extend returns a task_id — poll it to get the clip_id for the actual extend
      const ueTaskId = ueData.task_id || ueData.steps?.extend?.task_id || ueData.data?.[0]?.id
      if (ueTaskId) {
        console.log(`[upload-extend-audio] /sonic/upload-extend task_id=${ueTaskId}`)
        return c.json({ ok: true, audio_url: audioUrl, task_id: ueTaskId })
      }
      // If upload-extend returned a clip_id directly (rare), use it
      const ueClipId = ueData.clip_id || ueData.data?.[0]?.clip_id
      if (ueClipId) {
        console.log(`[upload-extend-audio] /sonic/upload-extend clip_id=${ueClipId}`)
        return c.json({ ok: true, audio_url: audioUrl, clip_id: ueClipId })
      }
    }
    console.warn(`[upload-extend-audio] /sonic/upload-extend also failed: ${ueText.slice(0, 200)}`)
  } catch (ueErr: any) {
    console.warn('[upload-extend-audio] /sonic/upload-extend threw:', ueErr?.message)
  }

  // Both /sonic/upload and /sonic/upload-extend failed.
  // MusicAPI's URL-based upload pipeline is broken (returns HTTP 400 for ALL URLs globally).
  // Store the audio_url and let extend-upload handle it via the Worker proxy URL.
  // The Worker proxy (extend-audio-proxy) serves with Content-Length + CORS, no auth required.
  console.warn('[upload-extend-audio] All upload methods failed — storing proxy URL for direct extend')
  return c.json({ ok: true, audio_url: audioUrl, status: 'ready' })
})

// POST /api/upload-remix-audio — upload audio for AI Remix (parallel to upload-extend-audio)
// Accepts: multipart { file } — stores in R2 under remix-uploads/ prefix
// Returns: { ok: true, audio_url: "<proxy_url>", status: "ready" }
// The audio_url is then passed to /api/job/remix as the directAudioUrl.
app.post('/api/upload-remix-audio', async (c) => {
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
  const contentType = c.req.header('content-type') || ''

  // JSON body: { audio_url } — caller providing URL directly
  if (contentType.includes('application/json')) {
    const body = await c.req.json<{ audio_url?: string; url?: string }>().catch(() => ({}))
    const directUrl = body.audio_url || body.url || null
    if (!directUrl) return c.json({ error: 'audio_url required' }, 400)
    console.log(`[upload-remix-audio] Using direct URL: ${directUrl.slice(0, 80)}`)
    return c.json({ ok: true, audio_url: directUrl, status: 'ready' })
  }

  // Multipart: file blob
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (!c.env.IMAGES) return c.json({ error: 'File storage not configured' }, 500)

  const safeFilename = (file.name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_')
  const r2Key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFilename}`
  await c.env.IMAGES.put(`remix-uploads/${r2Key}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'audio/mpeg' }
  })
  // Serve via the same extend-audio-proxy since it just reads from R2 by key
  const audioUrl = `${siteUrl}/api/extend-audio-proxy/${encodeURIComponent(r2Key)}`
  console.log(`[upload-remix-audio] Stored in R2, proxy URL: ${audioUrl}`)
  return c.json({ ok: true, audio_url: audioUrl, status: 'ready' })
})

// GET /api/poll-upload-task/:taskId — poll MusicAPI Sonic for uploaded clip's clip_id
// After POST /api/upload-extend-audio returns task_id, client polls here until clip_id is ready
app.get('/api/poll-upload-task/:taskId', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  const taskId = c.req.param('taskId')
  const res = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
  })

  if (!res.ok) {
    const txt = await res.text()
    if (txt.includes('not_ready') || res.status === 404) {
      return c.json({ status: 'pending' })
    }
    return c.json({ error: `Poll error ${res.status}` }, 500)
  }

  const data = await res.json() as any
  // Sonic task response: { data: [{ id, state, ... }] } or direct array
  const clips = Array.isArray(data) ? data : (data.data || [])
  if (!clips.length) return c.json({ status: 'pending' })

  const clip = clips[0]
  if (clip.state === 'failed') return c.json({ status: 'failed', error: clip.error_message || 'Upload processing failed' }, 500)
  if (clip.state !== 'succeeded' && clip.state !== 'complete' && clip.state !== 'done') {
    return c.json({ status: 'pending' })
  }
  // clip_id is what extend-upload route expects as upload_audio_id
  const clipId = clip.clip_id || clip.id || ''
  return c.json({ status: 'ready', clip_id: clipId, audio_url: clip.audio_url || null })
})

// POST /api/generate-oneshot — one-shot sound design via MusicAPI Producer (Lyria 3 Pro)
app.post('/api/generate-oneshot', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'One Shot Creator requires the Pro Artist plan.', upgrade: true }, 403)
  }

  const { sound_type, description, pitch, texture } = await c.req.json<{
    sound_type: string; description?: string; pitch?: string; texture?: string
  }>()
  if (!sound_type) return c.json({ error: 'sound_type is required' }, 400)

  // Build a tight one-shot prompt
  const parts: string[] = [sound_type]
  if (description) parts.push(description)
  if (pitch) parts.push(`pitch ${pitch}`)
  if (texture) parts.push(texture)
  parts.push('single isolated hit, percussive sound design, dry, punchy, studio sample, short duration, no melody, no loop')

  const oneshotPrompt = parts.join(', ')

  // Use Producer (Lyria 3 Pro) with short duration for one-shot sounds
  const res = await fetch(`${MUSICAPI_PRODUCER}/create`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sound: oneshotPrompt,
      duration: 3  // shortest available
    })
  })

  if (!res.ok) {
    const err = await res.json() as any
    return c.json({ error: err?.message || err?.error || `Stemforge error ${res.status}` }, 500)
  }

  const data = await res.json() as any
  const taskId = data.task_id || data.data?.task_id
  return c.json({ ok: true, task_id: taskId, sound_type, prompt: oneshotPrompt })
})

// POST /api/poll-oneshot/:task_id — poll MusicAPI for one-shot status
app.post('/api/poll-oneshot/:task_id', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  const taskId = c.req.param('task_id')
  const { sound_type } = await c.req.json<{ sound_type?: string }>().catch(() => ({ sound_type: undefined }))

  // Poll MusicAPI Sonic task endpoint (Producer tasks use same polling path)
  const res = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
  })
  if (!res.ok) return c.json({ status: 'error' }, 500)

  const data = await res.json() as any
  const clips = Array.isArray(data) ? data : (data.data || [])
  if (clips.length && clips[0].state === 'succeeded' && clips[0].audio_url) {
    const audioUrl = clips[0].audio_url as string
    // Save one-shot to library (jobs table with is_oneshot=1)
    if (c.env.DB) {
      try {
        await ensureTable(c.env.DB)
        const oneshotId = 'os_' + taskId
        const oneshotJob = {
          id: oneshotId, status: 'ready', created_at: Date.now(),
          sound_type: sound_type || 'one-shot', audio_url: audioUrl,
          title: sound_type || 'One Shot', prompt: sound_type || 'one-shot',
          thumbnail_seed: Math.floor(Math.random() * 360)
        }
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO jobs (id, data, created_at, user_id, is_oneshot)
           VALUES (?, ?, ?, ?, 1)`
        ).bind(oneshotId, JSON.stringify(oneshotJob), oneshotJob.created_at, user.id).run()
      } catch { /* ignore save errors */ }
    }
    return c.json({ status: 'ready', audio_url: audioUrl })
  }
  if (clips.length && clips[0].state === 'failed') return c.json({ status: 'error', error: clips[0].error || 'Generation failed' })
  return c.json({ status: 'pending' })
})

// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs SFX ONE SHOT CREATOR
// POST /api/generate-oneshot-sfx — Pro Artist only, 5 pts, returns audio as base64
// ElevenLabs AI generates completely original audio from the text prompt.
// Duration is omitted — ElevenLabs auto-determines the natural length.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/generate-oneshot-sfx', async (c) => {
  try {
  if (!c.env.ELEVENLABS_API_KEY) return c.json({ error: 'ElevenLabs not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  // Pro Artist only
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'One Shot Creator requires the Pro Artist plan.', upgrade: true }, 403)
  }

  // Parse request body FIRST before any DB ops
  let prompt = '', duration_seconds: number | undefined
  try {
    const body = await c.req.json<{ prompt: string; duration_seconds?: number }>()
    prompt = body.prompt || ''
    duration_seconds = body.duration_seconds
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
  if (!prompt.trim()) return c.json({ error: 'prompt is required' }, 400)

  // Deduct 10 pts before generation (refunded on hard API error) — bonus first
  const SFX_COST = 15
  if (c.env.DB) {
    // Use try/catch in case bonus_credits column doesn't exist on older schema
    let fresh: { gens_used: number; gens_limit: number; bonus_credits: number } | null = null
    try {
      fresh = await c.env.DB.prepare('SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id=?').bind(user.id).first<{gens_used:number,gens_limit:number,bonus_credits:number}>()
    } catch {
      // Fallback: schema without bonus_credits
      try {
        const f2 = await c.env.DB.prepare('SELECT gens_used, gens_limit FROM users WHERE id=?').bind(user.id).first<{gens_used:number,gens_limit:number}>()
        if (f2) fresh = { ...f2, bonus_credits: 0 }
      } catch { /* ignore */ }
    }
    const sfxBonus = fresh?.bonus_credits ?? 0
    const sfxMain = fresh ? (fresh.gens_limit - fresh.gens_used) : 0
    if (!fresh || sfxMain + sfxBonus < SFX_COST) {
      return c.json({ error: `Not enough points. One Shot Creator costs ${SFX_COST} points and you only have ${Math.max(0, sfxMain + sfxBonus)} remaining.`, limit_reached: true }, 403)
    }
    try {
      if (sfxBonus >= SFX_COST) {
        await c.env.DB.prepare('UPDATE users SET bonus_credits = bonus_credits - ? WHERE id=?').bind(SFX_COST, user.id).run()
      } else if (sfxBonus > 0) {
        await c.env.DB.prepare('UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id=?').bind(SFX_COST - sfxBonus, user.id).run()
      } else {
        await c.env.DB.prepare('UPDATE users SET gens_used = gens_used + ? WHERE id=?').bind(SFX_COST, user.id).run()
      }
    } catch { /* ignore deduction error — don't block the user */ }
  }

  // Build ElevenLabs request body — clamp duration to 0.5–8s range
  const elBody: Record<string, unknown> = { text: prompt.trim(), prompt_influence: 0.3 }
  if (duration_seconds && duration_seconds > 0) {
    elBody.duration_seconds = Math.max(0.5, Math.min(8, Math.round(duration_seconds * 2) / 2))
  }

  // Call ElevenLabs — duration auto-determined when not supplied
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'xi-api-key': c.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(elBody)
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown error')
    // Refund pts on hard API failure
    if (c.env.DB) {
      await c.env.DB.prepare('UPDATE users SET gens_used = MAX(0, gens_used - ?) WHERE id=?').bind(SFX_COST, user.id).run()
    }
    return c.json({ error: `ElevenLabs error ${res.status}: ${errText}` }, 502)
  }

  // ElevenLabs returns raw audio bytes (MP3)
  const audioBytes = await res.arrayBuffer()

  // Convert to base64 — chunked to avoid call-stack overflow on large audio buffers
  const bytes = new Uint8Array(audioBytes)
  let binary = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const base64Audio = btoa(binary)

  // Build a safe display title from the prompt
  const displayTitle = prompt.trim().slice(0, 60)
  const sfxId = 'sfx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)

  // Try storing in R2 for library playback later (optional — graceful fail)
  if (c.env.IMAGES) {
    try {
      await c.env.IMAGES.put(`oneshots/${sfxId}.mp3`, audioBytes, { httpMetadata: { contentType: 'audio/mpeg' } })
    } catch { /* R2 not bound or failed — skip */ }
  }

  // Track ElevenLabs character usage in D1 (API key lacks user_read scope for balance endpoint)
  if (c.env.DB) {
    try {
      await c.env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS el_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, chars INTEGER NOT NULL, created_at INTEGER NOT NULL)`
      ).run()
      await c.env.DB.prepare(
        `INSERT INTO el_usage (user_id, chars, created_at) VALUES (?, ?, ?)`
      ).bind(user.id, prompt.trim().length, Date.now()).run()
    } catch { /* ignore tracking errors */ }
  }

  // Save to jobs table with is_oneshot=1 so it appears in the One Shots library tab
  if (c.env.DB) {
    try {
      await ensureTable(c.env.DB)
      // audio_url: prefer R2 path if available, fall back to base64 data URI stored in DB
      const audioUrl = c.env.IMAGES ? `/api/oneshot-audio/${sfxId}` : `data:audio/mpeg;base64,${base64Audio}`
      const jobData = {
        id: sfxId, status: 'ready', created_at: Date.now(),
        sound_type: displayTitle, audio_url: audioUrl,
        title: displayTitle, prompt: prompt.trim(),
        thumbnail_seed: Math.floor(Math.random() * 360),
        is_sfx: true
      }
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO jobs (id, data, created_at, user_id, is_oneshot) VALUES (?, ?, ?, ?, 1)`
      ).bind(sfxId, JSON.stringify(jobData), jobData.created_at, user.id).run()
    } catch { /* ignore save errors */ }
  }

  // Return base64 audio so browser plays it immediately (no second round-trip needed)
  return c.json({
    ok: true,
    sfx_id: sfxId,
    audio_b64: base64Audio,
    title: displayTitle
  })
  } catch (err: any) {
    console.error('[generate-oneshot-sfx] Unhandled error:', err?.message || err)
    return c.json({ error: 'One Shot generation failed. Please try again.' }, 500)
  }
})

// GET /api/oneshot-audio/:id — serve one-shot audio from R2 (for library playback)
app.get('/api/oneshot-audio/:id', async (c) => {
  const id = c.req.param('id')
  if (!c.env.IMAGES) {
    // R2 not bound — look up the base64 data URI stored in the job record
    if (c.env.DB) {
      const row = await c.env.DB.prepare(`SELECT data FROM jobs WHERE id=?`).bind(id).first<{data:string}>()
      if (row) {
        const job = JSON.parse(row.data) as any
        if (job.audio_url?.startsWith('data:audio/mpeg;base64,')) {
          const b64 = job.audio_url.split(',')[1]
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
          return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } })
        }
      }
    }
    return c.json({ error: 'Audio not available' }, 404)
  }
  const obj = await c.env.IMAGES.get(`oneshots/${id}.mp3`)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  const safeFilename = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=31536000',
      'Content-Disposition': `inline; filename="${safeFilename}.mp3"`
    }
  })
})

// GET /api/track-audio/:id — permanent audio playback endpoint.
//
// Fallback chain (in order):
//   1. R2 key stored in job.r2_audio_key → serve directly from R2 (instant, permanent)
//   2. job.stereo_url is already our own proxy URL → redirect internally
//   3. job.stereo_url is a live CDN URL → proxy it + save to R2 for next time
//   4. CDN URL is expired + job has clip_id → re-fetch fresh URL from MusicAPI + save to R2
//   5. Everything fails → 502 with clear error
//
// No auth required — audio element can't send cookies in crossorigin mode.
app.get('/api/track-audio/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not configured' }, 500)
  const jobId = c.req.param('id')
  const siteUrl = c.env.SITE_URL || 'https://stemforge.studio'

  const row = await c.env.DB.prepare('SELECT data FROM jobs WHERE id = ?').bind(jobId).first<{ data: string }>()
  if (!row) return c.json({ error: 'Track not found' }, 404)
  const job = JSON.parse(row.data) as any

  const commonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Cache-Control': 'public, max-age=86400',
  }

  // ── One-shots: serve directly from R2 (no redirect loop, instant playback) ─
  if ((job as any).is_sfx || jobId.startsWith('sfx_') || jobId.startsWith('os_')) {
    if (c.env.IMAGES) {
      const obj = await c.env.IMAGES.get(`oneshots/${jobId}.mp3`)
      if (obj) {
        return new Response(obj.body, {
          headers: { ...commonHeaders, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' }
        })
      }
    }
    // Fallback: stored audio_url (CDN link or data URI)
    const oUrl: string = (job as any).audio_url || ''
    if (oUrl && !oUrl.startsWith('/api/') && !oUrl.startsWith('data:')) {
      try {
        const r = await fetch(oUrl, { headers: { 'User-Agent': 'StemForge/1.0' } })
        if (r.ok) return new Response(r.body, { headers: { ...commonHeaders, 'Content-Type': 'audio/mpeg' } })
      } catch {}
    }
    return c.json({ error: 'One shot audio not available' }, 404)
  }

  // ── Step 1: Serve from R2 if already persisted ────────────────────────────
  if (c.env.IMAGES && job.r2_audio_key) {
    const obj = await c.env.IMAGES.get(job.r2_audio_key)
    if (obj) {
      const ctype = obj.httpMetadata?.contentType || 'audio/wav'
      const rangeHeader = c.req.header('Range')
      if (rangeHeader) {
        // Support range requests for seek-ability
        const size = obj.size
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (match) {
          const start = parseInt(match[1])
          const end   = match[2] ? parseInt(match[2]) : size - 1
          const body  = await obj.arrayBuffer()
          const chunk = body.slice(start, end + 1)
          return new Response(chunk, {
            status: 206,
            headers: {
              ...commonHeaders,
              'Content-Type': ctype,
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Content-Length': String(chunk.byteLength),
              'Accept-Ranges': 'bytes',
            }
          })
        }
      }
      return new Response(obj.body, {
        headers: { ...commonHeaders, 'Content-Type': ctype, 'Accept-Ranges': 'bytes' }
      })
    }
    // R2 key exists in job but file not found — fall through to re-fetch
    console.warn(`[track-audio] R2 key ${job.r2_audio_key} not found for job=${jobId}, falling through`)
  }

  const audioUrl: string = job.stereo_url || job.audio_url || ''
  if (!audioUrl) return c.json({ error: 'No audio available for this track' }, 404)

  // ── Step 2: Already our own internal proxy URL → redirect ─────────────────
  if (audioUrl.startsWith('/api/')) return c.redirect(audioUrl)
  // Already pointing at this same endpoint (loop guard)
  if (audioUrl.includes('/api/track-audio/')) {
    return c.json({ error: 'Audio URL loop detected — track may need to be regenerated' }, 502)
  }

  // ── Step 3: Try the CDN URL — if alive, stream + save to R2 ──────────────
  const tryStreamCdn = async (url: string): Promise<Response | null> => {
    try {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'StemForge/1.0' },
        cf: { cacheTtl: 0 } as any
      })
      if (!upstream.ok) return null

      const ctype = upstream.headers.get('Content-Type') || 'audio/wav'
      const buf   = await upstream.arrayBuffer()
      if (!buf || buf.byteLength < 1000) return null

      // Save to R2 in the background (don't await — serve immediately)
      if (c.env.IMAGES) {
        c.executionCtx?.waitUntil?.(
          persistAudioToR2(url, jobId, c.env.IMAGES, c.env.DB, siteUrl)
            .catch((e: any) => console.warn('[track-audio R2 save]', e?.message))
        )
      }

      return new Response(buf, {
        headers: { ...commonHeaders, 'Content-Type': ctype, 'Accept-Ranges': 'bytes' }
      })
    } catch {
      return null
    }
  }

  const cdnResponse = await tryStreamCdn(audioUrl)
  if (cdnResponse) return cdnResponse

  // ── Step 4: CDN expired — try MusicAPI clip_id re-fetch ──────────────────
  const clipId: string = (job as any).clip_id || ''
  if (clipId && c.env.MUSICAPI_KEY) {
    console.log(`[track-audio] CDN expired for job=${jobId}, re-fetching via clip_id=${clipId}`)
    try {
      // Poll the clip status to get a fresh audio_url
      const pollRes = await fetch(`${MUSICAPI_BASE}/sonic/task/${clipId}`, {
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
      })
      if (pollRes.ok) {
        const pollData: any = await pollRes.json()
        const clips = Array.isArray(pollData) ? pollData : (pollData.data || [pollData])
        const clip  = clips.find((cl: any) => (cl.id || cl.clip_id) === clipId || clips[0])
        const freshUrl: string = clip?.audio_url || clip?.wav_url || ''

        if (freshUrl) {
          console.log(`[track-audio] Got fresh URL for job=${jobId} via clip_id`)
          const refreshed = await tryStreamCdn(freshUrl)
          if (refreshed) return refreshed
        }
      }
    } catch (clipErr: any) {
      console.warn(`[track-audio] clip_id re-fetch failed for job=${jobId}:`, clipErr?.message)
    }
  }

  // ── Step 5: Nothing worked ────────────────────────────────────────────────
  console.error(`[track-audio] All fallbacks exhausted for job=${jobId}`)
  return c.json({
    error: 'Audio unavailable — this track could not be refreshed. Please regenerate this track.',
    jobId
  }, 502)
})

// GET /api/download-wav/:id — download stereo audio as a REAL PCM WAV file
// Single path: R2 dl-cache HIT (free, instant) → CloudConvert (URL-only, zero Worker memory).
// CloudConvert fetches the MP3, converts server-side, returns a WAV download URL.
// After first conversion the WAV is saved to R2 via waitUntil — repeat downloads are free HITs.

// ── CloudConvert sync helper ─────────────────────────────────────────────────
// Sends a public audio URL to CloudConvert's sync endpoint.
// The entire job (import→convert→export) completes before the response returns.
// Returns a temporary WAV download URL on success, or null on failure.
async function convertToWavViaCloudConvert(
  sourceUrl: string,
  apiKey: string
): Promise<string | null> {
  try {
    const body = {
      tasks: {
        'import-audio': {
          operation: 'import/url',
          url: sourceUrl,
          filename: 'input.mp3'
        },
        'convert-to-wav': {
          operation: 'convert',
          input: 'import-audio',
          output_format: 'wav',
          audio_codec: 'pcm_s16le',
          audio_frequency: 44100
        },
        'export-wav': {
          operation: 'export/url',
          input: 'convert-to-wav',
          inline: false
        }
      }
    }
    const res = await fetch('https://sync.api.cloudconvert.com/v2/jobs', {
      method: 'POST',
      signal: AbortSignal.timeout(55000),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.warn(`[cloudconvert] HTTP ${res.status}: ${errText.slice(0, 200)}`)
      return null
    }
    const data: any = await res.json()
    const tasks: any[] = data?.data?.tasks || []
    const exportTask = tasks.find((tk: any) => tk.operation === 'export/url' && tk.status === 'finished')
    const files: any[] = exportTask?.result?.files || []
    const wavUrl: string = files[0]?.url || ''
    if (!wavUrl) {
      console.warn('[cloudconvert] no WAV URL in response, export status=', exportTask?.status, exportTask?.message)
      return null
    }
    return wavUrl
  } catch (e: any) {
    console.warn('[cloudconvert] error:', e?.message)
    return null
  }
}


app.get('/api/download-wav/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  if (user.plan === 'free') {
    return c.json({ error: 'Downloading tracks requires a Creator or Pro Artist plan. Your tracks are saved — upgrade anytime to download.', locked: true, upgrade: true }, 403)
  }
  const jobId = c.req.param('id')
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Track not found' }, 404)

  // ── One-shots: MP3 as-is, no conversion needed ──────────────────────────
  if ((job as any).is_sfx || jobId.startsWith('sfx_') || jobId.startsWith('os_')) {
    if (c.env.IMAGES) {
      const obj = await c.env.IMAGES.get(`oneshots/${jobId}.mp3`)
      if (obj) {
        const safeT = ((job as any).title || (job as any).sound_type || 'oneshot')
          .replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').toLowerCase() || 'oneshot'
        const raw = await obj.arrayBuffer()
        return new Response(raw, { headers: {
          'Content-Type': 'audio/mpeg', 'Content-Length': String(raw.byteLength),
          'Content-Disposition': `attachment; filename="${safeT}.mp3"`, 'Cache-Control': 'no-store'
        }})
      }
    }
    return c.json({ error: 'One shot audio not found. Please regenerate it.' }, 404)
  }

  if (!job.stereo_url) return c.json({ error: 'Track not found' }, 404)
  const safeTitle = ((job as any).title || job.blueprint?.genre || 'beat')
    .replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').toLowerCase() || 'stemforge_beat'

  // ── Step 1: R2 WAV dl-cache HIT — free, instant ─────────────────────────
  if (c.env.IMAGES) {
    const cached = await getDlCache(c.env.IMAGES, jobId, 'wav')
    if (cached) {
      return new Response(cached, { headers: {
        'Content-Type': 'audio/wav', 'Content-Length': String(cached.byteLength),
        'Content-Disposition': `attachment; filename="${safeTitle}.wav"`,
        'Cache-Control': 'no-store', 'X-Cache': 'HIT'
      }})
    }
  }

  // ── Step 2: CloudConvert — the only conversion path ─────────────────────
  // Send the public /api/track-audio/:id URL (works for everything in R2 and CDN).
  // CloudConvert fetches the MP3 server-side, converts to WAV, returns a download URL.
  // We stream straight to the client — zero bytes loaded into Worker memory.
  if (!c.env.CLOUDCONVERT_KEY) {
    return c.json({ error: 'WAV conversion is not configured. Please contact support.' }, 503)
  }
  if (!c.env.SITE_URL) {
    return c.json({ error: 'SITE_URL not configured.' }, 503)
  }

  // Use the worker's own request origin so CloudConvert can always reach it.
  // SITE_URL may point to a custom domain that isn't wired to this worker yet;
  // the request host is guaranteed to be this worker.
  const workerOrigin = new URL(c.req.url).origin
  const srcUrl = `${workerOrigin}/api/track-audio/${jobId}`
  console.log(`[download-wav] job=${jobId} → CloudConvert src=${srcUrl}`)

  const wavUrl = await convertToWavViaCloudConvert(srcUrl, c.env.CLOUDCONVERT_KEY)
  if (!wavUrl) {
    console.warn(`[download-wav] job=${jobId} CloudConvert returned no URL`)
    return c.json({ error: 'WAV conversion failed. Please try again.' }, 502)
  }

  // Stream the WAV to the client directly from CloudConvert's CDN URL.
  // CloudConvert export URLs are valid for 24h.
  // In background (waitUntil), fetch the same URL again and save to R2 dl-cache
  // so repeat downloads are free instant HITs — no CloudConvert credit needed.
  try {
    const wavRes = await fetch(wavUrl, {
      headers: { 'User-Agent': 'StemForge/1.0' }
    })
    if (!wavRes.ok) {
      console.warn(`[download-wav] job=${jobId} WAV fetch HTTP ${wavRes.status}`)
      return c.json({ error: 'WAV download failed. Please try again.' }, 502)
    }

    const cl = wavRes.headers.get('content-length')
    console.log(`[download-wav] job=${jobId} streaming WAV cl=${cl}`)

    // Background: fetch wavUrl again and save to R2 dl-cache (waitUntil keeps Worker alive)
    if (c.env.IMAGES) {
      c.executionCtx.waitUntil((async () => {
        try {
          const r2Res = await fetch(wavUrl, { headers: { 'User-Agent': 'StemForge/1.0' } })
          if (r2Res.ok) {
            const buf = await r2Res.arrayBuffer()
            await putDlCache(c.env.IMAGES!, jobId, 'wav', buf)
            console.log(`[download-wav] job=${jobId} saved ${buf.byteLength}B to R2 dl-cache`)
          }
        } catch (e: any) { console.warn(`[download-wav] R2 cache save failed: ${e?.message}`) }
      })())
    }

    return new Response(wavRes.body, { headers: {
      'Content-Type': 'audio/wav',
      ...(cl ? { 'Content-Length': cl } : {}),
      'Content-Disposition': `attachment; filename="${safeTitle}.wav"`,
      'Cache-Control': 'no-store', 'X-Cache': 'CC-WAV'
    }})
  } catch (e: any) {
    console.warn(`[download-wav] job=${jobId} stream error: ${e?.message}`)
    return c.json({ error: 'WAV streaming failed. Please try again.' }, 502)
  }
})

// GET /api/download-mp3/:id — download stereo audio as a TRUE MP3 file
// WAV source → lamejs; MP3 source → as-is; M4A → FAAD2 decode → lamejs encode
// R2 download cache: converts once, stores result in R2, serves from cache on every repeat download.
app.get('/api/download-mp3/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  if (user.plan === 'free') {
    return c.json({ error: 'Downloading tracks requires a Creator or Pro Artist plan.', locked: true, upgrade: true }, 403)
  }
  const jobId = c.req.param('id')
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Track not found' }, 404)

  // ── One-shots: serve directly from R2 (ElevenLabs MP3, no transcoding needed) ──
  if ((job as any).is_sfx || jobId.startsWith('sfx_') || jobId.startsWith('os_')) {
    const r2Key = `oneshots/${jobId}.mp3`
    if (c.env.IMAGES) {
      const obj = await c.env.IMAGES.get(r2Key)
      if (obj) {
        const safeT = ((job as any).title || (job as any).sound_type || 'oneshot')
          .replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').toLowerCase() || 'oneshot'
        return new Response(obj.body, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Disposition': `attachment; filename="${safeT}.mp3"`,
            'Cache-Control': 'no-store'
          }
        })
      }
    }
    return c.json({ error: 'One shot audio not found. Please regenerate it.' }, 404)
  }

  if (!job.stereo_url) return c.json({ error: 'Track not found' }, 404)
  const safeTitle = ((job as any).title || job.blueprint?.genre || 'beat')
    .replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').toLowerCase() || 'stemforge_beat'

  // ── R2 cache check: serve MP3 directly if already converted ──
  if (c.env.IMAGES) {
    const cached = await getDlCache(c.env.IMAGES, jobId, 'mp3')
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(cached.byteLength),
          'Content-Disposition': `attachment; filename="${safeTitle}.mp3"`,
          'Cache-Control': 'no-store',
          'X-Cache': 'HIT'
        }
      })
    }
  }

  // ── Cache miss: fetch source, transcode, cache result ──
  const upstream = await fetch(job.stereo_url)
  if (!upstream.ok) return c.json({ error: 'Could not fetch audio' }, 502)
  const rawBuf = await upstream.arrayBuffer()
  const srcFmt = detectAudioFormat(rawBuf)
  console.log(`[download-mp3] job=${jobId} source format=${srcFmt} (cache MISS — transcoding)`)
  const { buf: outBuf, fmt: outFmt } = await toMp3(rawBuf, srcFmt)

  // ── Store in R2 cache (fire-and-forget, only if we produced a true MP3) ──
  if (c.env.IMAGES && outFmt === 'mp3') {
    putDlCache(c.env.IMAGES, jobId, 'mp3', outBuf).catch(() => {})
  }

  return new Response(outBuf, {
    headers: {
      'Content-Type': audioMime(outFmt),
      'Content-Length': String(outBuf.byteLength),
      'Content-Disposition': `attachment; filename="${safeTitle}.${outFmt}"`,
      'Cache-Control': 'no-store',
      'X-Cache': 'MISS'
    }
  })
})

// GET /api/download-wav-url — proxy any audio URL as a download (one shots, covers)
// ?url=<encoded>&name=<filename>&fmt=wav|mp3 (default: wav)
// WAV/MP3 source → convert as needed; M4A → served as-is with correct MIME.
app.get('/api/download-wav-url', async (c) => {
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  const url  = c.req.query('url')
  const name = c.req.query('name') || 'oneshot'
  const fmtReq = (c.req.query('fmt') || 'wav').toLowerCase()  // 'wav' | 'mp3'
  if (!url) return c.json({ error: 'Missing url param' }, 400)
  const safeUrl  = decodeURIComponent(url)
  const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '_')
  const upstream = await fetch(safeUrl)
  if (!upstream.ok) return c.json({ error: 'Could not fetch audio' }, 502)
  const rawBuf = await upstream.arrayBuffer()
  const srcFmt = detectAudioFormat(rawBuf)
  console.log(`[download-wav-url] name=${safeName} source=${srcFmt} wants=${fmtReq}`)
  let outBuf: ArrayBuffer
  let outFmt: 'wav' | 'mp3' | 'm4a'
  if (fmtReq === 'mp3') {
    const result = await toMp3(rawBuf, srcFmt)
    outBuf = result.buf
    outFmt = result.fmt
  } else {
    // WAV requested
    if (srcFmt === 'mp3') {
      try {
        outBuf = await mp3ToWav(rawBuf)
        outFmt = 'wav'
      } catch {
        outBuf = rawBuf
        outFmt = 'mp3'
      }
    } else if (srcFmt === 'wav') {
      outBuf = rawBuf
      outFmt = 'wav'
    } else {
      // M4A → decode AAC → WAV (FAAD2 WASM pipeline)
      try {
        outBuf = await m4aToWav(rawBuf)
        outFmt = 'wav'
      } catch {
        outBuf = rawBuf
        outFmt = 'm4a'
      }
    }
  }
  return new Response(outBuf, {
    headers: {
      'Content-Type': audioMime(outFmt),
      'Content-Length': String(outBuf.byteLength),
      'Content-Disposition': `attachment; filename="${safeName}.${outFmt}"`,
      'Cache-Control': 'no-store'
    }
  })
})

// ─── COVER SONG FEATURE ────────────────────────────────────────────────────────
const COVER_UPLOADS_PREFIX = 'cover-uploads'
const R2_PUBLIC_BASE = 'https://pub-8e434559eec949638897e09ecee99a88.r2.dev'

// POST /api/upload-cover-audio — upload source audio for cover song
app.post('/api/upload-cover-audio', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer') return c.json({ error: 'Cover Song is a Pro Artist feature.', upgrade_url: '/pricing', locked: true }, 402)

  const form = await c.req.formData()
  const file = form.get('file') as File | null
  if (!file) return c.json({ error: 'No file uploaded' }, 400)
  if (file.size > 20 * 1024 * 1024) {
    const isWav = (file.type || '').toLowerCase().includes('wav') ||
                  (file.name || '').toLowerCase().endsWith('.wav')
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
    const msg = isWav
      ? `WAV file is too large (${sizeMB} MB — max 20 MB). WAV is uncompressed; convert to MP3 at 128–256 kbps and upload again.`
      : `File too large (${sizeMB} MB — max 20 MB). Try exporting as MP3 at 128 kbps to reduce file size.`
    return c.json({ error: msg }, 400)
  }

  const ext = (file.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '')
  const uuid = crypto.randomUUID()
  const key = `${COVER_UPLOADS_PREFIX}/${uuid}.${ext}`

  const arrayBuf = await file.arrayBuffer()
  await c.env.IMAGES.put(key, arrayBuf, { httpMetadata: { contentType: file.type || 'audio/mpeg' } })

  // Use the R2 public bucket URL directly so MusicAPI can fetch it without routing
  // back through our own Worker (Cloudflare Workers cannot fetch their own zone URLs)
  const audioUrl = `${R2_PUBLIC_BASE}/${key}`
  // Keep the proxy URL for the mini-player (it respects auth, but audio player doesn't need it)
  const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
  const proxyUrl = `${siteUrl}/api/cover-audio-proxy/${encodeURIComponent(uuid + '.' + ext)}`
  return c.json({ ok: true, audio_url: audioUrl, proxy_url: proxyUrl, filename: file.name })
})

// GET /api/cover-audio-proxy/:filename — serve cover upload from R2
app.get('/api/cover-audio-proxy/:filename', async (c) => {
  const filename = c.req.param('filename')
  const key = `${COVER_UPLOADS_PREFIX}/${filename}`
  const obj = await c.env.IMAGES.get(key)
  if (!obj) return c.notFound()
  const ct = obj.httpMetadata?.contentType || 'audio/mpeg'
  return new Response(obj.body, { headers: { 'Content-Type': ct, 'Cache-Control': 'private, max-age=3600' } })
})

// GET /api/debug/poll-cover-task — directly poll a MusicAPI sonic task (admin only, for testing)
app.get('/api/debug/poll-cover-task', async (c) => {
  const adminKey = c.req.query('admin_key')
  if (!adminKey || !c.env.ADMIN_EMAIL || adminKey !== c.env.ADMIN_EMAIL) return c.json({ error: 'admin only' }, 401)
  const taskId = c.req.query('task_id')
  if (!taskId) return c.json({ error: 'task_id required' }, 400)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'no key' }, 500)
  const r = await fetch(`${MUSICAPI_SONIC}/task/${taskId}`, { headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` } })
  const raw = await r.text()
  return c.json({ status: r.status, raw, parsed: JSON.parse(raw) })
})

// GET /api/cover-auto-desc — generate a Suno-style description from filename/title (called immediately after upload)
// Returns the description as plain text so the frontend can pre-fill the style textarea for the user to edit.
app.get('/api/cover-auto-desc', async (c) => {
  const title = c.req.query('title') || 'Cover Song'
  if (!c.env.OPENAI_API_KEY) return c.json({ description: '' })
  const desc = await generateCoverDescription(title, '', c.env.OPENAI_API_KEY)
  return c.json({ description: desc })
})

// ── Auto-generate a Suno-style cover description from title + optional style hint ──────────────────
// Called when the user leaves the style field blank in the Cover panel.
// Uses gpt-4o-mini to produce a detailed music description (genre, instruments, tempo, energy, mood)
// just like Suno does automatically when you give it an audio file.
async function generateCoverDescription(title: string, styleHint: string, openaiKey: string): Promise<string> {
  const userMsg = styleHint && styleHint.trim()
    ? `Song title: "${title}"\nStyle hint from user: "${styleHint.trim()}"`
    : `Song title: "${title}"`

  try {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a music style analyst. Given a song title (and optional style hints), write a single detailed description of what the song sounds like — covering genre, sub-genre, instruments, tempo, energy level, mood, vocal style, and production characteristics. Be specific and musical, like a Suno-style prompt. Write 1–3 sentences, max 300 characters. Do NOT include artist names, song titles, or copyrighted references. Output ONLY the description text, nothing else.`
          },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.7,
        max_tokens: 120
      })
    })
    if (!res.ok) throw new Error(`OpenAI ${res.status}`)
    const data = await res.json() as any
    const text: string = data.choices?.[0]?.message?.content?.trim() || ''
    if (text.length > 10) return text.slice(0, 400)
  } catch (e: any) {
    console.warn('[cover-desc] GPT failed, using fallback:', e?.message)
  }
  // Fallback if GPT fails — still better than empty
  return styleHint?.trim() || 'Energetic pop cover with rich instrumentation, melodic vocals, and modern production'
}

// POST /api/job/cover-song — create a cover song job via MusicAPI Sonic (20 credits, Pro Artist only)
// Uses ctx.waitUntil() to return job_id immediately (<1s) then calls MusicAPI in the background.
// This avoids Cloudflare's 30-second wall-clock request timeout (MusicAPI /upload-cover takes 30-45s).
app.post('/api/job/cover-song', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer') return c.json({ error: 'Cover Song is a Pro Artist feature.', upgrade_url: '/pricing', locked: true }, 402)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Stemforge AI service not configured' }, 500)

  const { audio_url, title, style_prompt, make_instrumental, lyrics } = await c.req.json()
  if (!audio_url) return c.json({ error: 'audio_url is required' }, 400)

  const COVER_COST = 25
  // Use the standard gens_used/gens_limit/bonus_credits system
  const freshUser = await c.env.DB.prepare(
    `SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id = ?`
  ).bind(user.id).first<{ gens_used: number; gens_limit: number; bonus_credits: number }>()
  if (!freshUser) return c.json({ error: 'User not found' }, 404)
  const coverAvailable = (freshUser.gens_limit - freshUser.gens_used) + (freshUser.bonus_credits || 0)
  if (coverAvailable < COVER_COST) return c.json({ error: `Not enough credits (need ${COVER_COST}, have ${coverAvailable})` }, 402)

  // Deduct from bonus_credits first, then gens_used
  const coverBonus = Math.min(freshUser.bonus_credits || 0, COVER_COST)
  const coverMain = COVER_COST - coverBonus
  if (coverBonus > 0 && coverMain > 0) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - ?, gens_used = gens_used + ? WHERE id = ?`).bind(coverBonus, coverMain, user.id).run()
  } else if (coverBonus > 0) {
    await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits - ? WHERE id = ?`).bind(coverBonus, user.id).run()
  } else {
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + ? WHERE id = ?`).bind(COVER_COST, user.id).run()
  }

  // Build cover request — field names must match MusicAPI docs exactly
  const hasLyrics = !!(lyrics && lyrics.trim())
  const isCustomMode = hasLyrics  // custom_mode=true when caller provides lyrics
  const coverBody: Record<string, any> = {
    url:               audio_url,
    mv:                'sonic-v6',           // always use latest model
    make_instrumental: !!make_instrumental,
    custom_mode:       isCustomMode,
    title:             title || 'Cover Song',
    tags:              style_prompt || '',    // style tags (not a description)
  }
  if (isCustomMode) {
    coverBody.prompt = lyrics!.trim()        // custom mode: lyrics go in 'prompt'
  } else {
    // MusicAPI requires gpt_description_prompt when custom_mode=false — always send it.
    // If the user left the style field blank, auto-generate a detailed Suno-style description
    // from the song title using GPT-4o-mini (same as Suno's automatic style detection).
    const desc = await generateCoverDescription(
      title || 'Cover Song',
      style_prompt || '',
      c.env.OPENAI_API_KEY
    )
    coverBody.gpt_description_prompt = desc
    console.log(`[cover-song] auto-desc: "${desc.slice(0, 100)}"`)
  }

  // ── Create job record immediately with status 'pending' ─────────────────────
  // We store cover_body + credit split on the job so the poll route can submit to MusicAPI.
  // The poll route gets its own fresh 30s wall-clock budget — no Cloudflare timeout.
  const jobId = crypto.randomUUID()
  const now = Date.now()
  const initialJobData = JSON.stringify({
    id: jobId,
    status: 'pending',
    title: title || 'Cover Song',
    created_at: now,
    user_id: user.id,
    is_cover: 1,
    // Stored so poll route can submit to MusicAPI and refund credits if needed
    cover_body:  JSON.stringify(coverBody),
    cover_bonus: coverBonus,
    cover_main:  coverMain,
    cover_cost:  COVER_COST,
  })
  await ensureTable(c.env.DB)
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, data, created_at, user_id, is_cover) VALUES (?, ?, ?, ?, 1)`
  ).bind(jobId, initialJobData, now, user.id).run()

  console.log(`[cover-song] job ${jobId} created (pending) — poll route will call MusicAPI`)

  // ── Return immediately — client gets job_id in < 1 second ───────────────────
  // The first GET /api/poll-cover/:id call will actually submit to MusicAPI.
  // This avoids Cloudflare's 30s wall-clock limit entirely.
  return c.json({ ok: true, job_id: jobId })
})

// GET /api/poll-cover/:id — poll cover song job status
// Strategy: job is created as 'pending' by POST /api/job/cover-song (returns immediately).
// On the FIRST poll we see 'pending' → we call MusicAPI /upload-cover here, synchronously.
// This poll request gets its own fresh 30s wall-clock budget — no timeout issues.
// Subsequent polls see 'generating' and just check the MusicAPI task status.
app.get('/api/poll-cover/:id', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('id')
  const row = await c.env.DB.prepare(`SELECT data FROM jobs WHERE id = ? AND user_id = ?`).bind(jobId, user.id).first<any>()
  if (!row) return c.json({ error: 'Job not found' }, 404)

  const job = JSON.parse(row.data) as any
  if (job.status === 'ready') return c.json({ status: 'ready', audio_url: job.stereo_url, title: job.title })

  // ── AUTO-RESCUE: if job is ERROR but error message is a transient "not ready" message,
  // reset it to 'pending' so the next poll retries — this fixes jobs permanently stuck as
  // ERROR because they hit the transient signal before the isTransient guard was deployed.
  if (job.status === 'error') {
    const savedErr: string = (job.error || '').toLowerCase()
    const isSavedTransient = savedErr.includes('not ready') ||
                             savedErr.includes('please wait') ||
                             savedErr.includes('try again later') ||
                             savedErr.includes('in progress') ||
                             savedErr.includes('task.*queued')
    if (isSavedTransient) {
      // Reset to pending so this poll re-submits to MusicAPI
      const resetData = JSON.stringify({ ...job, status: 'pending', error: undefined })
      await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(resetData, jobId).run()
      // Fall through to the 'pending' handler below
    } else {
      return c.json({ status: 'error', error: job.error })
    }
  }

  // ── AUTO-RESCUE: if job is stuck 'submitting' for too long (Worker timed out before
  // MusicAPI responded), reset to 'pending' so the next poll retries the upload-cover call.
  if (job.status === 'submitting') {
    const submittedAt = job.submitting_at ? new Date(job.submitting_at).getTime() : 0
    const age = Date.now() - submittedAt
    if (!submittedAt || age > 60_000) {
      // Stuck submitting > 60s — reset to pending so we retry
      const resetData = JSON.stringify({ ...job, status: 'pending', submitting_at: undefined })
      await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(resetData, jobId).run()
      // Fall through to 'pending' handler
    } else {
      return c.json({ status: 'generating' }) // Still in-flight, keep waiting
    }
  }

  // ── PENDING: first poll — call MusicAPI /upload-cover NOW from this request ──────────────
  // The POST route returned immediately without calling MusicAPI (to avoid the 30s timeout).
  // Now the poll route has its own fresh 30s wall-clock budget to make the slow MusicAPI call.
  // We mark the job 'submitting' first so concurrent polls don't double-submit.
  if (job.status === 'pending') {
    if (!c.env.MUSICAPI_KEY) {
      const errData = JSON.stringify({ ...job, status: 'error', error: 'Service not configured' })
      await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(errData, jobId).run()
      return c.json({ status: 'error', error: 'Service not configured' })
    }

    // Mark as 'submitting' to prevent double-submission if client polls again quickly
    // Record the timestamp so stuck-submitting auto-rescue knows how long it's been waiting
    const submittingData = JSON.stringify({ ...job, status: 'submitting', submitting_at: new Date().toISOString() })
    await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(submittingData, jobId).run()

    console.log(`[poll-cover] job=${jobId} status=pending → calling MusicAPI /upload-cover now`)
    try {
      const sonicRes = await fetch(`${MUSICAPI_SONIC}/upload-cover`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: job.cover_body  // stored as JSON string on the job
      })
      const sonicRawText = await sonicRes.text()
      console.log(`[poll-cover] job=${jobId}: /upload-cover HTTP ${sonicRes.status}: ${sonicRawText.slice(0, 400)}`)
      let sonicData: any
      try { sonicData = JSON.parse(sonicRawText) } catch { sonicData = {} }

      const coverTaskId = sonicData.task_id || sonicData.steps?.cover?.task_id || ''
      if (sonicRes.ok && coverTaskId) {
        const updatedData = JSON.stringify({ ...job, status: 'generating', task_id: coverTaskId })
        await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(updatedData, jobId).run()
        console.log(`[poll-cover] job=${jobId}: → generating, task_id=${coverTaskId}`)
        return c.json({ status: 'generating' })
      } else {
        const rawErrMsg = sonicData.message || sonicData.error || sonicData.detail || `Cover API error (HTTP ${sonicRes.status})`
        const rawLower = rawErrMsg.toLowerCase()

        // ── TRANSIENT: MusicAPI says "task not ready / please wait" during upload-cover.
        // This means MusicAPI is still busy — NOT a real failure. Reset to 'pending' so the
        // next poll retries the upload-cover call rather than permanently marking as error.
        const isSubmitTransient = rawLower.includes('not ready') ||
                                  rawLower.includes('please wait') ||
                                  rawLower.includes('try again') ||
                                  rawLower.includes('in progress') ||
                                  rawLower.includes('queued')
        if (isSubmitTransient) {
          console.log(`[poll-cover] job=${jobId}: upload-cover got transient "${rawErrMsg}" — resetting to pending for retry`)
          const resetData = JSON.stringify({ ...job, status: 'pending', submitting_at: undefined })
          await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(resetData, jobId).run()
          return c.json({ status: 'generating' }) // Tell client to keep polling
        }

        // Detect commercially-published track rejection (MusicAPI fingerprint/catalog check)
        const userErrMsg = (
          rawLower.includes('upload failed') ||
          rawLower.includes('catalog') ||
          rawLower.includes('published') ||
          rawLower.includes('copyright') ||
          rawLower.includes('fingerprint') ||
          rawLower.includes('commercial') ||
          rawLower.includes('licensed')
        )
          ? 'This track appears to be a commercially published song — StemForge cannot create a cover of a published track due to copyright restrictions. Please upload an original or royalty-free track.'
          : `Cover generation error: ${rawErrMsg}`
        const errData = JSON.stringify({ ...job, status: 'error', error: userErrMsg })
        await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(errData, jobId).run()
        // Refund credits
        const cb = job.cover_bonus || 0, cm = job.cover_main || 0, cc = job.cover_cost || 20
        if (cb > 0 && cm > 0) await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits + ?, gens_used = gens_used - ? WHERE id = ?`).bind(cb, cm, user.id).run()
        else if (cb > 0) await c.env.DB.prepare(`UPDATE users SET bonus_credits = bonus_credits + ? WHERE id = ?`).bind(cb, user.id).run()
        else await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used - ? WHERE id = ?`).bind(cc, user.id).run()
        return c.json({ status: 'error', error: userErrMsg })
      }
    } catch (e: any) {
      // Network/timeout error reaching MusicAPI — reset to 'pending' so next poll retries.
      // Do NOT permanently mark as error for transient network failures.
      console.error(`[poll-cover] job=${jobId}: /upload-cover threw — resetting to pending for retry:`, e?.message)
      const resetData = JSON.stringify({ ...job, status: 'pending', submitting_at: undefined })
      await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(resetData, jobId).run()
      return c.json({ status: 'generating' }) // Tell client to keep polling
    }
  }

  // 'submitting' = MusicAPI call is in flight from a concurrent poll — tell client to keep polling
  if (job.status === 'submitting') return c.json({ status: 'generating' })

  // ── GENERATING: job has a task_id — poll MusicAPI for completion ──────────────
  if (!c.env.MUSICAPI_KEY || !job.task_id) return c.json({ status: 'generating' })
  const pollRes = await fetch(`${MUSICAPI_SONIC}/task/${job.task_id}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
  })
  const pollData = await pollRes.json() as any
  const clips = pollData.data || []
  const ready = clips.find((cl: any) => cl.state === 'succeeded' && cl.audio_url)

  if (ready) {
    const updated = { ...job, status: 'ready', stereo_url: ready.audio_url, is_cover: 1 }
    await c.env.DB.prepare(`UPDATE jobs SET data = ?, is_cover = 1 WHERE id = ?`).bind(JSON.stringify(updated), jobId).run()
    // ── Persist cover audio to R2 (fire-and-forget) ─────────────────────────
    // MusicAPI audio URLs expire after ~24h. persistAudioToR2 downloads the audio,
    // stores it in R2, and updates stereo_url in D1 to our permanent /api/track-audio/:id
    // proxy — so WAV download always works even days later.
    if (c.env.IMAGES && c.env.SITE_URL) {
      const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
      const r2 = c.env.IMAGES
      // Fire-and-forget: persist MP3 to R2 first, then prime WAV in background
      c.executionCtx.waitUntil(
        persistAudioToR2(ready.audio_url, jobId, r2, c.env.DB, siteUrl)
          .then(() => primeCoverWav(jobId, ready.audio_url, r2, siteUrl))
          .catch((e: any) => console.warn(`[poll-cover] R2 persist/prime failed for job=${jobId}:`, e?.message))
      )
    }
    return c.json({ status: 'ready', audio_url: ready.audio_url, title: job.title })
  }
  const failed = clips.find((cl: any) => cl.state === 'failed')
  if (failed) {
    const apiErrMsg: string = failed.error_message || failed.error || failed.message || 'Generation failed'
    const updated = { ...job, status: 'error', error: apiErrMsg }
    await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(JSON.stringify(updated), jobId).run()
    return c.json({ status: 'error', error: apiErrMsg })
  }
  // MusicAPI returns { message: "task not ready, please wait few seconds." } as a NORMAL
  // in-progress signal when the task is still queued — NOT a real error. These transient
  // messages must never be treated as failures or the job gets permanently stuck as ERROR.
  //
  // Only mark as error when:
  //   a) pollData.error is present AND it is NOT a transient "not ready / wait" message
  //   b) The HTTP response itself failed (non-2xx)
  const topErrRaw: string = pollData.error || ''
  const topErrLower = topErrRaw.toLowerCase()
  const isTransient = topErrLower.includes('not ready') ||
                      topErrLower.includes('please wait') ||
                      topErrLower.includes('try again') ||
                      topErrLower.includes('in progress') ||
                      topErrLower.includes('task.*queued')
  if (topErrRaw && !isTransient) {
    const updated = { ...job, status: 'error', error: topErrRaw }
    await c.env.DB.prepare(`UPDATE jobs SET data = ? WHERE id = ?`).bind(JSON.stringify(updated), jobId).run()
    return c.json({ status: 'error', error: topErrRaw })
  }

  return c.json({ status: 'generating' })
})

// ─── HTML helpers ─────────────────────────────────────────────────────────────
// Cache-buster: changes every deploy so browsers always fetch fresh CSS/JS
const ASSET_VER = '20261003-58'

function shell(title: string, body: string, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — StemForge</title>
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-74RCBZK52L"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-74RCBZK52L');
</script>
<!-- Meta Pixel -->
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init','440081228562920');
fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=440081228562920&ev=PageView&noscript=1"/></noscript>
<!-- TikTok Pixel -->
<script>
!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};ttq.load('D9SVAV3C77UA78AD7EU0');ttq.load('DAFIT1JC77UES974NPK0');ttq.load('DANT6N3C77U88MSNTF7G');ttq.page()}(window,document,'ttq');
</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<link rel="stylesheet" href="/static/style.css?v=${ASSET_VER}"/>
${extraHead}
</head>
<body>
${globalSidebar()}
<div class="gs-page-wrap">
${body}
</div>
<!-- Account Locked Overlay — shown globally when account_locked=1 -->
<div id="account-locked-overlay" style="
  display:none;position:fixed;inset:0;z-index:999999;
  background:rgba(0,0,0,.92);backdrop-filter:blur(12px);
  align-items:center;justify-content:center;padding:24px;
  font-family:Inter,system-ui,sans-serif;
">
  <div style="
    background:#0d1117;border:1px solid rgba(239,68,68,.35);
    border-radius:18px;max-width:520px;width:100%;
    box-shadow:0 40px 100px rgba(0,0,0,.95),0 0 0 1px rgba(239,68,68,.1);
    overflow:hidden;
  ">
    <!-- Red header bar -->
    <div style="background:linear-gradient(135deg,#7f1d1d,#450a0a);padding:24px 28px 20px;border-bottom:1px solid rgba(239,68,68,.2)">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="width:44px;height:44px;border-radius:12px;background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.4);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-ban" style="color:#ef4444;font-size:1.1rem"></i>
        </div>
        <div>
          <div style="font-size:1.1rem;font-weight:800;color:#fff;letter-spacing:.2px">Account Access Restricted</div>
          <div style="font-size:.75rem;color:rgba(255,255,255,.5);margin-top:2px">StemForge Account Policy Violation</div>
        </div>
      </div>
    </div>
    <!-- Body -->
    <div style="padding:24px 28px">
      <p style="margin:0 0 14px;font-size:.92rem;color:#e2e8f0;line-height:1.65">
        Your account has been <strong style="color:#ef4444">disabled</strong> due to a violation of StemForge's
        <strong>One Account Per Person / Household</strong> policy.
      </p>
      <div style="background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:14px 16px;margin-bottom:18px">
        <div style="font-size:.78rem;font-weight:700;color:#ef4444;letter-spacing:.4px;margin-bottom:6px">⚠ REASON</div>
        <p id="lock-reason-text" style="margin:0;font-size:.84rem;color:#94a3b8;line-height:1.6">
          Multiple accounts were detected from the same network. Only one free account is permitted per household.
        </p>
      </div>
      <p style="margin:0 0 20px;font-size:.82rem;color:#64748b;line-height:1.6">
        You can still view your account details but <strong style="color:#cbd5e1">all beat generation, stem splitting, and premium features are disabled</strong>.
        If you believe this is a mistake, please contact our support team.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a href="mailto:support@stemforge.studio?subject=Account%20Access%20Restricted&body=My%20email%20is%3A%20" style="
          display:inline-flex;align-items:center;gap:7px;
          padding:10px 18px;border-radius:9px;
          background:rgba(78,159,255,.12);border:1px solid rgba(78,159,255,.3);
          color:#4e9fff;font-size:.85rem;font-weight:600;text-decoration:none;
          transition:background .15s;
        ">
          <i class="fas fa-envelope"></i> Contact Support
        </a>
        <a href="/logout" style="
          display:inline-flex;align-items:center;gap:7px;
          padding:10px 18px;border-radius:9px;
          background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
          color:#94a3b8;font-size:.85rem;font-weight:600;text-decoration:none;
        ">
          <i class="fas fa-sign-out-alt"></i> Log Out
        </a>
      </div>
    </div>
  </div>
</div>

<script src="/static/app.v2.55.js?v=${ASSET_VER}"></script>
<script src="/static/stems.v4.js"></script>
<script>
// Analytics beacon — fires on every page load, non-blocking
(function(){
  try {
    const params = new URLSearchParams(location.search);
    navigator.sendBeacon('/api/analytics/pageview', JSON.stringify({
      path: location.pathname,
      referrer: document.referrer,
      source: params.get('utm_source') || '',
      medium: params.get('utm_medium') || '',
      campaign: params.get('utm_campaign') || ''
    }));
  } catch(e){}
})();
</script>
</body>
</html>`
}

// ─── GLOBAL LEFT SIDEBAR — shown on every page ─────────────────────────────
function globalSidebar() {
  return `<aside class="gs-sidebar" id="gs-sidebar">
  <!-- Logo -->
  <a href="/" class="gs-sidebar__logo">
    <img src="/static/stemforge-logo.png" alt="StemForge" style="height:36px;width:36px;object-fit:contain;flex-shrink:0"/><span class="gs-sidebar__logo-text">Stem<span class="accent">Forge</span></span>
  </a>

  <!-- Navigation (desktop: vertical column; mobile: horizontal row) -->

  <!-- Sign in button — shown when logged out -->
  <a href="/login" class="gs-sidebar__signin-btn" id="gs-signin-btn">
    <i class="fas fa-sign-in-alt"></i>
    <span>Sign in</span>
  </a>

  <!-- User identity block — click to open dropdown menu -->
  <div class="gs-sidebar__user-wrap" id="gs-user-block" style="display:none">
    <button class="gs-sidebar__user" id="gs-user-btn" aria-haspopup="true" aria-expanded="false">
      <div class="gs-sidebar__avatar" id="gs-avatar">?</div>
      <div class="gs-sidebar__user-info">
        <span class="gs-sidebar__username" id="gs-username">Loading...</span>
        <span class="gs-sidebar__plan plan-badge" id="gs-plan-badge">Free</span>
      </div>
      <i class="fas fa-chevron-down gs-sidebar__user-caret" id="gs-user-caret"></i>
    </button>

    <!-- Dropdown panel — shown when user block is clicked -->
    <div class="gs-user-dropdown" id="gs-user-dropdown" aria-hidden="true">
      <a href="/profile" class="gs-user-dropdown__item">
        <i class="fas fa-user"></i> Profile
      </a>
      <a href="/subscription" class="gs-user-dropdown__item">
        <i class="fas fa-credit-card"></i> Subscription
      </a>
      <a href="/account" class="gs-user-dropdown__item">
        <i class="fas fa-cog"></i> Account Settings
      </a>
      <div class="gs-user-dropdown__divider"></div>
      <button class="gs-user-dropdown__item gs-user-dropdown__item--btn" id="gs-theme-btn">
        <i class="fas fa-moon" id="gs-theme-icon"></i>
        <span id="gs-theme-label">Dark mode</span>
        <span class="gs-theme-pill" id="gs-theme-pill"></span>
      </button>
      <div class="gs-user-dropdown__divider"></div>
      <button class="gs-user-dropdown__item gs-user-dropdown__item--btn gs-user-dropdown__item--danger" id="gs-signout-btn">
        <i class="fas fa-sign-out-alt"></i> Sign out
      </button>
    </div>
  </div>

  <!-- Navigation -->
  <nav class="gs-sidebar__nav">
    <a href="/home" class="gs-sidebar__nav-item gs-auth-nav" data-page="home" style="display:none">
      <i class="fas fa-home"></i>
      <span>Home</span>
    </a>
    <a href="/generator" class="gs-sidebar__nav-item gs-auth-nav" data-page="generator" style="display:none">
      <i class="fas fa-music"></i>
      <span>Create</span>
    </a>
    <a href="/dashboard" class="gs-sidebar__nav-item gs-auth-nav" data-page="dashboard" style="display:none">
      <i class="fas fa-th-large"></i>
      <span>Library</span>
    </a>
    <a href="/feedback" class="gs-sidebar__nav-item gs-auth-nav" data-page="feedback" style="display:none">
      <i class="fas fa-comment-alt"></i>
      <span class="nav-label-full">Give Us Feedback</span><span class="nav-label-short">Feedback</span>
    </a>
    <!-- Get More Credits — inside nav, below Feedback, logged-in only -->
    <a href="/subscription" id="sidebar-get-credits-btn" class="gs-sidebar__nav-item" style="
      display:none;
      background:linear-gradient(135deg,rgba(78,159,255,.12),rgba(139,92,246,.10));
      border:1px solid rgba(78,159,255,.25);
      color:#4e9fff;font-weight:700;
      transition:background .15s,border-color .15s;
      text-decoration:none;
    " onmouseover="this.style.borderColor='rgba(78,159,255,.5)';this.style.background='linear-gradient(135deg,rgba(78,159,255,.18),rgba(139,92,246,.15))'" onmouseout="this.style.borderColor='rgba(78,159,255,.25)';this.style.background='linear-gradient(135deg,rgba(78,159,255,.12),rgba(139,92,246,.10))'">
      <i class="fas fa-plus-circle" style="width:18px;text-align:center;flex-shrink:0;color:#4e9fff"></i>
      <span class="nav-label-full">Get More Credits</span>
      <span class="nav-label-short" style="display:none">Credits</span>
    </a>

  </nav>

  <!-- Spacer -->
  <div class="gs-sidebar__spacer"></div>

  <!-- What's New button — styled as a glowing button above credits -->
  <button id="sidebar-whats-new-btn" onclick="window._sfOpenWhatsNew && window._sfOpenWhatsNew()" style="
    display:none;
    width:calc(100% - 24px);margin:0 12px 8px;
    background:linear-gradient(135deg,rgba(245,158,11,.15),rgba(239,68,68,.10));
    border:1px solid rgba(245,158,11,.35);
    border-radius:10px;cursor:pointer;
    padding:10px 14px;
    text-align:left;
    align-items:center;gap:10px;
    transition:all .18s;
    box-shadow:0 0 12px rgba(245,158,11,.08);
  " onmouseover="this.style.background='linear-gradient(135deg,rgba(245,158,11,.22),rgba(239,68,68,.15))';this.style.borderColor='rgba(245,158,11,.6)';this.style.boxShadow='0 0 18px rgba(245,158,11,.18)'" onmouseout="this.style.background='linear-gradient(135deg,rgba(245,158,11,.15),rgba(239,68,68,.10))';this.style.borderColor='rgba(245,158,11,.35)';this.style.boxShadow='0 0 12px rgba(245,158,11,.08)'">
    <i class="fas fa-star" style="color:#f59e0b;width:18px;text-align:center;flex-shrink:0;font-size:.9rem"></i>
    <span class="nav-label-full" style="flex:1;font-size:.84rem;font-weight:700;color:#fcd34d">What's New</span>
    <span class="nav-label-short" style="flex:1;display:none;font-size:.84rem;font-weight:700;color:#fcd34d">New</span>
    <span id="whats-new-badge" style="
      background:#ef4444;color:#fff;
      font-size:.55rem;font-weight:800;letter-spacing:.5px;
      border-radius:999px;padding:2px 6px;
      display:none;flex-shrink:0;
      animation:pulse 1.8s infinite;
    ">NEW</span>
  </button>

  <!-- What's New Modal (rendered here, shown via JS) -->
  <div id="whats-new-overlay" style="
    position:fixed;inset:0;z-index:99999;
    background:rgba(0,0,0,.75);backdrop-filter:blur(8px);
    display:none;align-items:center;justify-content:center;padding:16px;
  " onclick="if(event.target===this)window._sfCloseWhatsNew()">
    <div style="
      background:#0d1117;border:1px solid #1e2a3a;
      border-radius:14px;max-width:560px;width:100%;
      max-height:88vh;overflow-y:auto;
      box-shadow:0 32px 80px rgba(0,0,0,.9);
      font-family:Inter,system-ui,sans-serif;
    ">
      <!-- Header -->
      <div style="
        background:linear-gradient(135deg,#111827,#0d1117);
        border-bottom:1px solid #1e2a3a;
        padding:20px 24px 16px;
        display:flex;align-items:center;gap:12px;
        border-radius:14px 14px 0 0;
      ">
        <div style="
          width:38px;height:38px;border-radius:10px;
          background:linear-gradient(135deg,#f59e0b,#d97706);
          display:flex;align-items:center;justify-content:center;flex-shrink:0;
        "><i class="fas fa-star" style="color:#fff;font-size:.9rem"></i></div>
        <div style="flex:1">
          <div style="font-size:1.05rem;font-weight:800;color:#fff;letter-spacing:.3px">What's New in StemForge</div>
          <div style="font-size:.72rem;color:#6b7280;margin-top:1px">Updates, improvements & new features</div>
        </div>
        <button onclick="window._sfCloseWhatsNew()" style="
          background:none;border:1px solid #1e2a3a;color:#6b7280;
          width:30px;height:30px;border-radius:50%;cursor:pointer;
          font-size:1rem;display:flex;align-items:center;justify-content:center;
        ">×</button>
      </div>
      <!-- Welcome banner -->
      <div style="
        margin:20px 24px 0;
        background:linear-gradient(135deg,rgba(79,195,247,.08),rgba(245,158,11,.06));
        border:1px solid rgba(79,195,247,.18);border-radius:10px;
        padding:16px 18px;
      ">
        <div style="font-size:.78rem;font-weight:700;color:#4fc3f7;letter-spacing:.5px;margin-bottom:6px;">👋 WELCOME TO WHAT'S NEW TAB</div>
        <p style="margin:0;font-size:.82rem;color:#cbd5e1;line-height:1.6">
          This tab is your go-to place for everything happening on StemForge. Whenever we ship a new feature,
          tweak something, or fix a bug — you'll find it here with a clear description of what changed and why.
          Check back anytime to stay up to date!
        </p>
      </div>
      <!-- Update entries -->
      <div id="whats-new-entries" style="padding:16px 24px 24px;display:flex;flex-direction:column;gap:14px">
        <!-- Entries injected by _sfWhatsNewEntries array -->
      </div>
    </div>
  </div>

  <!-- Service Outage Notice Modal -->
  <div id="outage-notice-overlay" style="
    display:none;position:fixed;inset:0;z-index:999998;
    background:rgba(0,0,0,.85);backdrop-filter:blur(10px);
    align-items:center;justify-content:center;padding:24px;
    font-family:Inter,system-ui,sans-serif;
  " onclick="if(event.target===this)window._sfCloseOutageNotice && window._sfCloseOutageNotice()">
    <div style="
      background:#0d1117;border:1px solid rgba(245,158,11,.35);
      border-radius:18px;max-width:520px;width:100%;
      box-shadow:0 40px 100px rgba(0,0,0,.9),0 0 0 1px rgba(245,158,11,.1);
      overflow:hidden;position:relative;
    ">
      <button onclick="window._sfCloseOutageNotice && window._sfCloseOutageNotice()" style="
        position:absolute;top:16px;right:16px;background:none;border:1px solid rgba(255,255,255,.15);
        color:#9ca3af;width:30px;height:30px;border-radius:50%;cursor:pointer;
        font-size:1rem;display:flex;align-items:center;justify-content:center;z-index:2;
      ">×</button>
      <!-- Amber header bar -->
      <div style="background:linear-gradient(135deg,#78350f,#451a03);padding:24px 28px 20px;border-bottom:1px solid rgba(245,158,11,.2)">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:44px;height:44px;border-radius:12px;background:rgba(245,158,11,.2);border:1px solid rgba(245,158,11,.4);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-triangle-exclamation" style="color:#f59e0b;font-size:1.1rem"></i>
          </div>
          <div>
            <div style="font-size:1.1rem;font-weight:800;color:#fff;letter-spacing:.2px">Temporary Service Issue</div>
            <div style="font-size:.75rem;color:rgba(255,255,255,.5);margin-top:2px">StemForge System Notice</div>
          </div>
        </div>
      </div>
      <!-- Body -->
      <div style="padding:24px 28px">
        <p style="margin:0 0 14px;font-size:.92rem;color:#e2e8f0;line-height:1.65">
          We're currently experiencing a <strong style="color:#f59e0b">server side issue on our end</strong>.
        </p>
        <div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:14px 16px;margin-bottom:18px">
          <div style="font-size:.78rem;font-weight:700;color:#f59e0b;letter-spacing:.4px;margin-bottom:6px">⚠ AFFECTED FEATURES</div>
          <p style="margin:0;font-size:.84rem;color:#94a3b8;line-height:1.6">
            <strong style="color:#cbd5e1">Song Extend</strong>, and <strong style="color:#cbd5e1">creating a song or instrumentals</strong> might temporarily not work.
          </p>
        </div>
        <p style="margin:0;font-size:.82rem;color:#64748b;line-height:1.6">
          Our team is working to resolve this issue as quickly as possible. Thank you for your patience.
        </p>
      </div>
    </div>
  </div>

  <!-- Generation credits (shown when logged in) -->
  <div class="gs-sidebar__credits" id="gs-credits-block" style="display:none">
    <!-- Main subscription points row -->
    <div class="gs-credits__label" id="gs-credits-label">Points Remaining</div>
    <div class="gs-credits__val" id="gs-gens-val">0 <small>/ 3</small></div>
    <div class="gs-credits__bar"><div id="gs-gens-bar" style="width:0%"></div></div>
    <!-- Bonus points row (only visible when bonus_credits > 0) -->
    <div id="gs-bonus-row" style="display:none">
      <div class="gs-credits__divider"></div>
      <div class="gs-credits__label gs-credits__bonus-label">
        <i class="fas fa-bolt" style="color:#f59e0b;margin-right:4px;font-size:.65rem"></i>Bonus Points
      </div>
      <div class="gs-credits__bonus-val" id="gs-bonus-val">0 <small>bonus</small></div>
    </div>
  </div>

  <!-- Bottom links -->
  <div class="gs-sidebar__footer">
    <a href="/terms" class="gs-sidebar__footer-link">Terms of Service</a>
    <a href="/privacy" class="gs-sidebar__footer-link">Privacy Policy</a>
  </div>

  <!-- Mobile hamburger toggle -->
  <button class="gs-sidebar__mobile-toggle" id="gs-mobile-toggle" aria-label="Menu">
    <i class="fas fa-bars"></i>
  </button>
</aside>

<!-- ── Song Edit Modal — rendered globally so it works on every page ── -->
<div class="song-edit-modal" id="song-edit-modal" style="display:none">
  <div class="song-edit-modal__backdrop" onclick="closeSongEditModal()"></div>
  <div class="song-edit-modal__panel">
    <div class="song-edit-modal__header">
      <h3><i class="fas fa-edit"></i> Edit Song</h3>
      <button class="song-edit-modal__close" onclick="closeSongEditModal()"><i class="fas fa-times"></i></button>
    </div>
    <div class="song-edit-modal__body">
      <input type="hidden" id="edit-job-id"/>

      <!-- ── Cover Art ─────────────────────────────────────────── -->
      <div class="form-group">
        <label>Cover Art</label>
        <div class="edit-cover-row">
          <!-- Thumbnail preview -->
          <div class="edit-cover-thumb" id="edit-cover-thumb">
            <i class="fas fa-music edit-cover-thumb__icon"></i>
          </div>
          <!-- Upload controls -->
          <div class="edit-cover-controls">
            <label class="btn btn--outline btn--sm edit-cover-upload-btn" for="edit-cover-file">
              <i class="fas fa-upload"></i> Upload image
            </label>
            <input type="file" id="edit-cover-file" accept="image/jpeg,image/png,image/webp" style="display:none"/>
            <p class="edit-cover-hint">JPG, PNG or WebP · max 5 MB</p>
            <button class="edit-cover-remove" id="edit-cover-remove" style="display:none" onclick="removeCoverImage()">
              <i class="fas fa-trash-alt"></i> Remove custom image
            </button>
            <span class="edit-cover-status" id="edit-cover-status"></span>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label>Song Title</label>
        <input type="text" id="edit-title" placeholder="Song title" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;width:100%;box-sizing:border-box;color:var(--text);font-family:inherit;font-size:.9rem"/>
      </div>
      <div class="form-group">
        <label>Lyrics / Notes</label>
        <textarea id="edit-lyrics" class="suno-textarea" rows="4" placeholder="Lyrics or notes about this track..."></textarea>
      </div>
      <div class="form-group" style="display:flex;gap:12px">
        <div style="flex:1">
          <label>BPM</label>
          <input type="number" id="edit-bpm" min="60" max="200" placeholder="90" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;width:100%;box-sizing:border-box;color:var(--text);font-family:inherit;font-size:.9rem"/>
        </div>
        <div style="flex:2">
          <label>Genre / Style</label>
          <input type="text" id="edit-genre" placeholder="e.g. afrobeats, jazz, house..." style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;width:100%;box-sizing:border-box;color:var(--text);font-family:inherit;font-size:.9rem"/>
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="edit-description" class="suno-textarea" rows="2" placeholder="Notes about this beat..."></textarea>
      </div>

      <!-- ── Instruments ──────────────────────────────────────────── -->
      <div class="form-group" id="edit-instruments-group" style="display:none">
        <label><i class="fas fa-layer-group" style="color:var(--primary);margin-right:5px"></i>Instruments</label>
        <div class="blueprint-pills" id="edit-blueprint-pills" style="flex-wrap:wrap;gap:6px;margin-top:4px"></div>
      </div>

      <div class="song-edit-modal__info" id="edit-info-block" style="display:none">
        <div class="song-edit-modal__info-row"><span>Key</span><strong id="edit-info-key">—</strong></div>
        <div class="song-edit-modal__info-row"><span>Scale</span><strong id="edit-info-scale">—</strong></div>
        <div class="song-edit-modal__info-row"><span>Mood</span><strong id="edit-info-mood">—</strong></div>
        <div class="song-edit-modal__info-row"><span>Duration</span><strong id="edit-info-duration">—</strong></div>
      </div>

    </div>
    <div class="song-edit-modal__footer">
      <button class="btn btn--outline" onclick="closeSongEditModal()">Cancel</button>
      <button class="btn btn--primary" id="edit-save-btn" onclick="saveSongEdit()"><i class="fas fa-save"></i> Save changes</button>
    </div>
  </div>
</div>`
}

function nav() {
  // Top bar — only shown on marketing/public pages that need it
  return `<header class="sf-nav" id="sf-nav">
  <div class="sf-nav__inner">
    <nav class="sf-nav__links">
      <a href="/#features">Features</a>
      <a href="/pricing">Pricing</a>
      <a href="/#features">Features</a>
    </nav>
    <div class="sf-nav__actions">
      <a href="/login" class="btn btn--ghost btn--sm nav-guest-only">Log in</a>
      <a href="/signup" class="btn btn--primary btn--sm nav-guest-only">Start free</a>
      <div class="nav-user-menu" id="nav-user-menu" style="display:none">
        <button class="nav-avatar-btn" id="nav-avatar-btn">
          <span class="nav-avatar" id="nav-avatar-text">?</span>
          <span class="nav-username" id="nav-username-text"></span>
          <i class="fas fa-chevron-down" style="font-size:10px;opacity:.6"></i>
        </button>
        <div class="nav-dropdown" id="nav-dropdown">
          <a href="/profile" class="nav-dropdown__item"><i class="fas fa-user"></i> Profile</a>
          <a href="/subscription" class="nav-dropdown__item"><i class="fas fa-credit-card"></i> Subscription</a>
          <a href="/account" class="nav-dropdown__item"><i class="fas fa-cog"></i> Account</a>
          <div class="nav-dropdown__divider"></div>
          <button class="nav-dropdown__item" id="theme-toggle-btn">
            <i class="fas fa-moon" id="theme-icon"></i>
            <span id="theme-label">Dark mode</span>
          </button>
          <button class="nav-dropdown__item nav-dropdown__item--danger" id="nav-signout-btn">
            <i class="fas fa-sign-out-alt"></i> Sign out
          </button>
        </div>
      </div>
    </div>
  </div>
</header>`
}

function footer() {
  return `<footer class="sf-footer">
  <div class="sf-footer__inner">
    <div class="sf-footer__brand">
      <a href="/" class="sf-nav__logo">
        <img src="/static/stemforge-logo.png" alt="StemForge" style="height:30px;width:30px;object-fit:contain;flex-shrink:0"/><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <p>StemForge beat generation — professional quality, no studio needed.</p>
    </div>
    <div class="sf-footer__cols">
      <div>
        <h4>Product</h4>
        <a href="/generator">Generator</a>
        <a href="/pricing">Pricing</a>
        <a href="/#features">Features</a>
      </div>
      <div>
        <h4>Account</h4>
        <a href="/signup">Sign up</a>
        <a href="/login">Log in</a>
        <a href="/dashboard">Dashboard</a>
      </div>
      <div>
        <h4>Legal</h4>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </div>
    </div>
  </div>
  <div class="sf-footer__bottom">
    <p>© 2026 StemForge. All rights reserved.</p>
    <p>Built for artists who need every track clean.</p>
  </div>
</footer>`
}

// ─── HOME PAGE ────────────────────────────────────────────────────────────────
function homePage() {
  return shell('Generate Beats. Keep Every Track', `
<main>
<section class="hero hero--fullvp" id="hero-section">
  <div class="hero__bg">
    <div class="hero__orb hero__orb--1"></div>
    <div class="hero__orb hero__orb--2"></div>
    <div class="hero__grid"></div>
    <!-- Background video fixed to viewport -->
    <video id="hero-bg-video" autoplay muted loop playsinline
      style="position:fixed;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.15;mix-blend-mode:screen;pointer-events:none;z-index:0">
      <source src="/static/hero-wave.mp4" type="video/mp4">
    </video>
  </div>

  <!-- Two-column hero layout: left=copy, right=plan cards -->
  <div class="hero__fullvp-inner container">

    <!-- Left: headline + CTA -->
    <div class="hero__copy-col">
      <div class="hero__badge"><i class="fas fa-bolt"></i> AI-powered multitrack generation</div>
      <h1 class="hero__title">Forge the beat.<br/><span class="gradient-text">Make it yours.</span></h1>
      <p class="hero__sub">StemForge generates professional tracks in your favorite genre using AI. Download the full stereo mix and take your beats straight to the DAW.</p>
      <div class="hero__ctas">
        <a href="/generator" class="btn btn--primary btn--lg"><i class="fas fa-play"></i> Try the generator</a>
      </div>
      <a href="/pricing" class="hero__pricing-link">See full pricing details <i class="fas fa-arrow-right"></i></a>
    </div>

    <!-- Right: plan cards -->
    <div class="hero__plans-col">
      <div class="plans-grid plans-grid--hero">
        <div class="plan-card" id="home-free-plan-card">
          <div id="home-free-card-status-top"></div>
          <div class="plan-card__tier">Free</div>
          <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
          <p class="plan-card__desc">Try the engine. No card needed.</p>
          <ul class="plan-card__features">
            <li><i class="fas fa-check"></i> 60 points monthly</li>
            <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
            <li class="muted"><i class="fas fa-times"></i> Downloads</li>
            <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          </ul>
          <a href="/signup" class="btn btn--outline btn--full" id="home-free-plan-btn" data-plan="free">Get started free</a>
          <!-- Downgrade to Free button — shown for Creator/Pro when not already downgrading -->
          <button class="btn btn--outline btn--sm home-plan-btn" data-plan="free" id="home-btn-downgrade-to-free" style="display:none;margin-top:6px;border-color:rgba(255,100,100,.4);color:#ff7070;width:100%">
            <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Free
          </button>
          <div id="home-free-plan-status" style="margin:8px 0 0">
            <div class="home-downgrade-note sub-downgrade-pending-banner" id="home-free-downgrade-note" style="display:none">
              <i class="fas fa-clock"></i> <span id="home-free-downgrade-msg">Downgrading to Free at end of billing cycle</span>
            </div>
            <button class="btn btn--outline btn--sm" id="home-btn-cancel-downgrade-free" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="homeCancelDowngrade('free')">
              <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
            </button>
          </div>
        </div>
        <div class="plan-card plan-card--featured" id="home-creator-plan-card">
          <div id="home-creator-card-status-top"></div>
          <div class="plan-card__badge">Most popular</div>
          <div class="plan-card__tier">Creator</div>
          <div class="plan-card__price"><span class="plan-card__amount">$10</span><span>/month</span></div>
          <p class="plan-card__desc">For artists, writers, and content creators.</p>
          <ul class="plan-card__features">
            <li><i class="fas fa-check"></i> 900 points monthly</li>
            <li><i class="fas fa-check"></i> Auto Split (up to 5 stems)</li>
            <li><i class="fas fa-check"></i> WAV download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator (SFX)</li>
          </ul>
          <button class="btn btn--primary btn--full home-plan-btn" data-plan="creator">Start Creator</button>
          <div id="home-creator-plan-status" style="margin:8px 0 0">
            <div class="home-downgrade-note sub-downgrade-pending-banner" id="home-creator-downgrade-note" style="display:none">
              <i class="fas fa-clock"></i> <span id="home-creator-downgrade-msg">Downgrading to Creator at end of billing cycle</span>
            </div>
            <button class="btn btn--outline btn--sm" id="home-btn-cancel-downgrade-creator" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="homeCancelDowngrade('creator')">
              <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
            </button>
          </div>
        </div>
        <div class="plan-card" id="home-pro-plan-card">
          <div id="home-pro-card-status-top"></div>
          <div class="plan-card__tier">Pro Artist</div>
          <div class="plan-card__price"><span class="plan-card__amount">$26</span><span>/month</span></div>
          <p class="plan-card__desc">For serious artists who need every track.</p>
          <ul class="plan-card__features">
            <li><i class="fas fa-check"></i> 2,000 points monthly</li>
            <li><i class="fas fa-check"></i> Vocals &amp; Instrumental split</li>
            <li><i class="fas fa-check"></i> Song Extend + stem download</li>
            <li><i class="fas fa-check"></i> WAV download + commercial use</li>
            <li><i class="fas fa-check"></i> Reference track upload</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator (SFX)</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-guitar" style="color:#a855f7;font-size:.75rem"></i> AI Cover Song</li>
            <li><i class="fas fa-check"></i> Priority queue</li>
          </ul>
          <button class="btn btn--outline btn--full home-plan-btn" data-plan="pro">Start Pro Artist</button>
          <div id="home-pro-plan-status" style="margin:8px 0 0">
            <div class="home-downgrade-note sub-downgrade-pending-banner" id="home-pro-downgrade-note" style="display:none">
              <i class="fas fa-clock"></i> <span id="home-pro-downgrade-msg">Downgrading to Pro Artist at end of billing cycle</span>
            </div>
            <button class="btn btn--outline btn--sm" id="home-btn-cancel-downgrade-pro" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="homeCancelDowngrade('pro')">
              <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
            </button>
          </div>
        </div>
        <div class="plan-card plan-card--developer" id="developer-plan-card" style="display:none">
          <div class="plan-card__tier" style="color:#a78bfa">Developer</div>
          <div class="plan-card__price"><span class="plan-card__amount">🔒</span></div>
          <p class="plan-card__desc">For the site owner. Unlimited access, no limits.</p>
          <ul class="plan-card__features">
            <li><i class="fas fa-check"></i> Unlimited generations</li>
            <li><i class="fas fa-check"></i> All features unlocked</li>
            <li><i class="fas fa-check"></i> Admin panel access</li>
          </ul>
          <button class="btn btn--outline btn--full" onclick="activateDeveloperPlan()" id="dev-activate-btn">Activate Developer Plan</button>
        </div>
      </div>
    </div>

  </div><!-- /.hero__fullvp-inner -->
</section>

<!-- Home page downgrade confirmation modal -->
<div id="home-downgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center">
    <i class="fas fa-arrow-down" style="font-size:2rem;color:#ff6464;margin-bottom:16px"></i>
    <h3 style="margin-bottom:8px">Confirm Downgrade</h3>
    <p id="home-downgrade-msg" style="color:var(--muted);margin-bottom:24px;line-height:1.5"></p>
    <div style="display:flex;gap:12px;justify-content:center">
      <button class="btn btn--outline btn--sm" onclick="document.getElementById('home-downgrade-modal').style.display='none'">Cancel</button>
      <button class="btn btn--sm" id="home-downgrade-confirm" style="background:#ff4444;border:none;color:white">Confirm Downgrade</button>
    </div>
  </div>
</div>

<!-- Home page upgrade confirmation modal -->
<div id="home-upgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px)">
  <div style="background:var(--surface);border:1px solid rgba(108,58,255,.35);border-radius:24px;padding:0;max-width:460px;width:100%;overflow:hidden;box-shadow:0 24px 80px rgba(108,58,255,.2)">
    <div style="background:linear-gradient(135deg,rgba(108,58,255,.18),rgba(168,85,247,.12));border-bottom:1px solid rgba(108,58,255,.2);padding:22px 26px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:11px">
          <div style="width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-bolt" style="color:white;font-size:.85rem"></i>
          </div>
          <div>
            <h3 style="margin:0;font-size:1.1rem;font-weight:700" id="hum-title">Upgrade Plan</h3>
            <p style="margin:0;font-size:.78rem;color:var(--muted)">Instant access — charged now</p>
          </div>
        </div>
        <button onclick="closeHomeUpgradeModal()" style="background:none;border:none;color:var(--muted);font-size:1rem;cursor:pointer;padding:4px"><i class="fas fa-times"></i></button>
      </div>
    </div>
    <div id="hum-loading" style="padding:44px;text-align:center">
      <div style="width:34px;height:34px;border:3px solid var(--border);border-top-color:#a855f7;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 14px"></div>
      <p style="color:var(--muted);margin:0;font-size:.88rem">Calculating your proration…</p>
    </div>
    <div id="hum-content" style="display:none;padding:22px 26px">
      <!-- Plan pill -->
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px">
        <div style="padding:5px 13px;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:20px;font-size:.83rem;font-weight:600" id="hum-from-label">Free</div>
        <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-right" style="color:white;font-size:.65rem"></i>
        </div>
        <div style="padding:5px 13px;background:linear-gradient(135deg,rgba(108,58,255,.15),rgba(168,85,247,.1));border:1px solid rgba(168,85,247,.4);border-radius:20px;font-size:.83rem;font-weight:700;color:#c084fc" id="hum-to-label">Pro Artist</div>
      </div>
      <!-- Breakdown -->
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:14px">
        <div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;font-weight:600" id="hum-plan-name">Plan</span>
          <span id="hum-new-price" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div id="hum-discount-row" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <div>
            <span style="font-size:.85rem;color:#10b981;font-weight:600"><i class="fas fa-tag" style="margin-right:4px"></i>Unused credit discount</span>
            <div style="font-size:.72rem;color:var(--muted);margin-top:1px" id="hum-discount-note"></div>
          </div>
          <span id="hum-discount-val" style="font-size:.85rem;font-weight:600;color:#10b981">—</span>
        </div>
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,rgba(108,58,255,.12),rgba(168,85,247,.08))">
          <div>
            <span style="font-size:.95rem;font-weight:800">Charged today</span>
            <div style="font-size:.72rem;color:var(--muted);margin-top:1px">Access granted immediately</div>
          </div>
          <span id="hum-charge" style="font-size:1.2rem;font-weight:900;color:#c084fc">—</span>
        </div>
      </div>
      <p id="hum-note" style="font-size:.78rem;color:var(--muted);text-align:center;margin:0 0 18px;line-height:1.5"></p>
      <div style="display:flex;gap:9px">
        <button class="btn btn--outline btn--sm" style="flex:1" onclick="closeHomeUpgradeModal()"><i class="fas fa-times"></i> Cancel</button>
        <button class="btn btn--primary btn--sm" style="flex:2;background:linear-gradient(135deg,#6c3aff,#a855f7);border:none" id="hum-confirm-btn" onclick="confirmHomeUpgrade()"><i class="fas fa-bolt"></i> <span id="hum-confirm-label">Confirm &amp; Pay</span></button>
      </div>
    </div>
    <div id="hum-error" style="display:none;padding:32px 26px;text-align:center">
      <i class="fas fa-exclamation-triangle" style="font-size:1.8rem;color:#ef4444;margin-bottom:12px;display:block"></i>
      <p id="hum-error-msg" style="color:var(--muted);margin:0 0 18px;font-size:.88rem;line-height:1.5"></p>
      <button class="btn btn--outline btn--sm" onclick="closeHomeUpgradeModal()">Close</button>
    </div>
  </div>
</div>

<script>
// ── Themed plan-change toast (replaces browser alert) ─────────────────────
window.showSfPlanToast = function(type, plan, msg) {
  var existing = document.getElementById('sf-plan-toast');
  if (existing) existing.remove();

  var planLabel = { creator: 'Creator', pro: 'Pro Artist', free: 'Free', developer: 'Developer' }[plan] || plan || '';

  var icon, text, bg, border, shadow;
  if (type === 'upgrade') {
    icon   = '<i class="fas fa-arrow-up" style="color:#a855f7"></i>';
    text   = planLabel ? ('You\u2019re upgrading to ' + planLabel + ' — changes take effect at your next billing cycle.') : 'Upgrade scheduled — changes take effect at next billing cycle.';
    bg     = 'linear-gradient(135deg,rgba(108,58,255,.18),rgba(168,85,247,.14))';
    border = 'rgba(168,85,247,.4)';
    shadow = 'rgba(108,58,255,.35)';
  } else if (type === 'downgrade') {
    icon   = '<i class="fas fa-info-circle" style="color:#60a5fa"></i>';
    text   = planLabel ? ('Scheduled to move to ' + planLabel + ' at end of your billing cycle. You keep all current features until then.') : 'Downgrade scheduled — takes effect at end of billing cycle.';
    bg     = 'linear-gradient(135deg,rgba(78,159,255,.14),rgba(96,165,250,.10))';
    border = 'rgba(78,159,255,.35)';
    shadow = 'rgba(78,159,255,.25)';
  } else {
    icon   = '<i class="fas fa-exclamation-triangle" style="color:#f87171"></i>';
    text   = msg || 'Something went wrong. Please try again.';
    bg     = 'linear-gradient(135deg,rgba(239,68,68,.14),rgba(248,113,113,.10))';
    border = 'rgba(239,68,68,.35)';
    shadow = 'rgba(239,68,68,.25)';
  }

  var toast = document.createElement('div');
  toast.id = 'sf-plan-toast';
  toast.style.cssText = [
    'position:fixed', 'bottom:28px', 'right:28px', 'z-index:9999999',
    'max-width:380px', 'width:calc(100vw - 56px)',
    'background:' + bg,
    'border:1px solid ' + border,
    'border-radius:14px',
    'padding:16px 20px',
    'display:flex', 'align-items:flex-start', 'gap:12px',
    'box-shadow:0 8px 32px ' + shadow,
    'backdrop-filter:blur(10px)',
    'font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif',
    'animation:sfToastIn .25s ease'
  ].join(';');
  toast.innerHTML =
    '<style>@keyframes sfToastIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}</style>' +
    '<div style="font-size:1.1rem;flex-shrink:0;margin-top:1px">' + icon + '</div>' +
    '<div style="flex:1;min-width:0">' +
      '<div style="font-size:.88rem;font-weight:600;color:#f1f5f9;line-height:1.45;margin-bottom:2px">' + text + '</div>' +
    '</div>' +
    '<button onclick="this.closest(\"#sf-plan-toast\").remove()" style="background:none;border:none;color:rgba(255,255,255,.4);font-size:1rem;cursor:pointer;padding:0;margin-top:-2px;flex-shrink:0" onmouseover="this.style.color=\"#fff\"" onmouseout="this.style.color=\"rgba(255,255,255,.4)\"">&times;</button>';
  document.body.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, type === 'error' ? 6000 : 5000);
};

(function(){
  let _humPlan = null;

  // ── Sync home plan cards with actual Stripe pending state ──────────────────
  function homeApplyPendingState(state) {
    const pd   = state.pendingDowngrade; // 'creator' | 'free' | null
    const pu   = state.pendingUpgrade;   // 'pro' | 'creator' | null
    const plan = state.plan || null;

    // ── Helper: set card-level status banner ─────────────────────────────────
    function setHomeCardStatus(cardId, topSlotId, statusType) {
      const card = document.getElementById(cardId);
      const slot = document.getElementById(topSlotId);
      if (!slot) return;
      // Remove old status classes
      if (card) {
        card.classList.remove('plan-card--is-current', 'plan-card--is-downgrading');
      }
      if (statusType === 'current') {
        slot.innerHTML = '<div class="plan-card-status-banner plan-card-status-banner--current"><i class="fas fa-check-circle"></i> Your Current Plan</div>';
        if (card) card.classList.add('plan-card--is-current');
      } else if (statusType === 'downgrading') {
        slot.innerHTML = '<div class="plan-card-status-banner plan-card-status-banner--downgrading"><i class="fas fa-arrow-down"></i> Downgrading to this plan</div>';
        if (card) card.classList.add('plan-card--is-downgrading');
      } else {
        slot.innerHTML = '';
      }
    }

    // Determine which cards get which status
    // Current plan card = plan (unless pending downgrade already in effect)
    // Downgrade target card = pd (if pd set)
    setHomeCardStatus('home-free-plan-card',    'home-free-card-status-top',    plan === 'free'    ? 'current' : pd === 'free'    ? 'downgrading' : null);
    setHomeCardStatus('home-creator-plan-card', 'home-creator-card-status-top', plan === 'creator' ? 'current' : pd === 'creator' ? 'downgrading' : null);
    setHomeCardStatus('home-pro-plan-card',     'home-pro-card-status-top',     plan === 'pro'     ? 'current' : null);

    // ── Free card: show banner+cancel when pending downgrade is 'free' ──
    const frNote  = document.getElementById('home-free-downgrade-note');
    const frMsg   = document.getElementById('home-free-downgrade-msg');
    const frCancel= document.getElementById('home-btn-cancel-downgrade-free');
    const freePlanBtn = document.getElementById('home-free-plan-btn');
    const frDgBtn = document.getElementById('home-btn-downgrade-to-free');
    if (pd === 'free' && frNote) {
      if (frMsg) frMsg.textContent = 'Downgrading to Free at end of billing cycle';
      frNote.style.display = 'flex';
      if (frCancel) frCancel.style.display = 'inline-flex';
      if (frDgBtn)  frDgBtn.style.display = 'none';
      if (freePlanBtn) freePlanBtn.style.display = 'none';
    } else if (frNote) {
      frNote.style.display = 'none';
      if (frCancel) frCancel.style.display = 'none';
      // Show "Downgrade to Free" button for paid users who aren't downgrading
      if (frDgBtn) frDgBtn.style.display = (plan === 'creator' || plan === 'pro') ? 'inline-flex' : 'none';
    }

    // ── Creator card: show banner+cancel when pending downgrade is 'creator' (from Pro) ──
    const crNote  = document.getElementById('home-creator-downgrade-note');
    const crMsg   = document.getElementById('home-creator-downgrade-msg');
    const crCancel= document.getElementById('home-btn-cancel-downgrade-creator');
    if (pd === 'creator' && crNote) {
      if (crMsg) crMsg.textContent = 'Downgrading to Creator at end of billing cycle';
      crNote.style.display = 'flex';
      if (crCancel) crCancel.style.display = 'inline-flex';
    } else if (crNote) {
      crNote.style.display = 'none';
      if (crCancel) crCancel.style.display = 'none';
    }

    // ── Pro card: show banner+cancel when pro user is downgrading to anything ──
    const prNote  = document.getElementById('home-pro-downgrade-note');
    const prMsg   = document.getElementById('home-pro-downgrade-msg');
    const prCancel= document.getElementById('home-btn-cancel-downgrade-pro');
    if (pd && plan === 'pro' && prNote) {
      if (prMsg) prMsg.textContent = 'Downgrading to ' + (pd === 'creator' ? 'Creator' : 'Free') + ' at end of billing cycle';
      prNote.style.display = 'flex';
      if (prCancel) prCancel.style.display = 'inline-flex';
    } else if (prNote) {
      prNote.style.display = 'none';
      if (prCancel) prCancel.style.display = 'none';
    }
  }

  // NOTE: pending state fetch is now done inside the auth/me async block below (Promise.all)
  // so homeApplyPendingState is called there with real data.

  // Convert plan card buttons for logged-OUT users only (logged-in is handled below)
  let _homeDgPlan = null;
  document.querySelectorAll('.home-plan-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const plan = btn.dataset.plan;
      if (!plan) return;
      try {
        const me = await fetch('/api/auth/me').then(r => r.json());
        const user = me.user;
        if (!user) { window.location.href = '/checkout?plan=' + plan; return; }
        const rank = { free:0, creator:1, pro:2, developer:3 };
        const userRank = rank[user.plan] || 0;
        const planRank = rank[plan] || 0;
        if (userRank === planRank) { window.location.href = '/subscription'; return; }
        if (userRank > planRank) {
          // Downgrade path
          _homeDgPlan = plan;
          const msg = document.getElementById('home-downgrade-msg');
          if (plan === 'free') {
            msg.textContent = 'Your subscription will be cancelled. You will move to the Free plan after your billing cycle ends.';
          } else if (plan === 'creator') {
            msg.textContent = 'You will be downgraded to Creator ($10/mo, 900 points/mo) at the end of your current billing cycle. You keep all features until then.';
          }
          document.getElementById('home-downgrade-modal').style.display = 'flex';
          return;
        }
        // Upgrade path — show proration modal
        openHomeUpgradeModal(plan);
      } catch(e) {
        window.location.href = '/checkout?plan=' + plan;
      }
    });
  });

  // Home page downgrade confirm button
  const homeDgConfirm = document.getElementById('home-downgrade-confirm');
  if (homeDgConfirm) {
    homeDgConfirm.addEventListener('click', async () => {
      if (!_homeDgPlan) return;
      homeDgConfirm.disabled = true; homeDgConfirm.textContent = 'Processing…';
      try {
        const res = await fetch('/api/subscription/downgrade', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ target_plan: _homeDgPlan })
        });
        const data = await res.json();
        document.getElementById('home-downgrade-modal').style.display = 'none';
        if (data.ok) {
          sessionStorage.setItem('sf_pending_downgrade', _homeDgPlan);
          showSfPlanToast('downgrade', _homeDgPlan);
          window.location.reload();
        } else { showSfPlanToast('error', null, data.error || 'Downgrade failed'); }
      } catch(e) { showSfPlanToast('error', null, 'Network error. Please try again.'); }
      finally { homeDgConfirm.disabled = false; homeDgConfirm.textContent = 'Confirm Downgrade'; }
    });
  }
  document.getElementById('home-downgrade-modal').addEventListener('click', function(e) {
    if (e.target === this) this.style.display = 'none';
  });

  // Cancel downgrade from home page card
  window.homeCancelDowngrade = async function(targetPlan) {
    try {
      const res = await fetch('/api/subscription/cancel-downgrade', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
      });
      const data = await res.json();
      if (data.ok) {
        showSfPlanToast('upgrade', null, 'Downgrade cancelled — your current plan continues.');
        // Re-fetch pending state and update UI
        fetch('/api/subscription/pending-state').then(r => r.json()).then(homeApplyPendingState).catch(function(){});
      } else {
        showSfPlanToast('error', null, data.error || 'Could not cancel downgrade.');
      }
    } catch(e) { showSfPlanToast('error', null, 'Network error. Please try again.'); }
  };

  window.openHomeUpgradeModal = function(plan) {
    _humPlan = plan;
    const modal = document.getElementById('home-upgrade-modal');
    modal.style.display = 'flex';
    document.getElementById('hum-loading').style.display  = 'block';
    document.getElementById('hum-content').style.display  = 'none';
    document.getElementById('hum-error').style.display    = 'none';
    fetch('/api/subscription/upgrade-preview?plan=' + encodeURIComponent(plan))
      .then(r => r.json())
      .then(data => {
        if (data.error) { showHumError(data.error); return; }
        const targetLabel       = data.target_plan_label || plan;
        const newPriceCents     = data.new_price_cents     || 0;
        const currentPriceCents = data.current_price_cents || 0;
        const proratedCents     = data.proration_cents     || newPriceCents;
        const discountCents     = Math.max(0, newPriceCents - proratedCents);
        const humHasRealSub = data.has_subscription &&
          data.days_remaining != null && !isNaN(data.days_remaining) &&
          data.days_in_period != null && !isNaN(data.days_in_period);
        const chargeLabel = '$' + (proratedCents / 100).toFixed(2);
        // Plan pills
        document.getElementById('hum-from-label').textContent = data.current_plan_label || 'Free';
        document.getElementById('hum-to-label').textContent   = targetLabel;
        document.getElementById('hum-title').textContent      = 'Upgrade to ' + targetLabel;
        // New price row
        document.getElementById('hum-plan-name').textContent = targetLabel;
        document.getElementById('hum-new-price').textContent = '$' + (newPriceCents / 100).toFixed(2);
        // Discount row
        const discountRow = document.getElementById('hum-discount-row');
        if (humHasRealSub && discountCents > 0 && currentPriceCents > 0) {
          discountRow.style.display = 'flex';
          document.getElementById('hum-discount-val').textContent  = '−$' + (discountCents / 100).toFixed(2);
          document.getElementById('hum-discount-note').textContent = data.days_remaining + ' days left on ' + (data.current_plan_label || 'current plan');
        } else {
          discountRow.style.display = 'none';
        }
        // Charge today
        document.getElementById('hum-charge').textContent = chargeLabel;
        // Renewal note
        if (humHasRealSub && data.period_end_label) {
          document.getElementById('hum-note').textContent = 'Then ' + (data.new_price_label||'') + ' starting ' + data.period_end_label + '. Cancel anytime.';
        } else {
          document.getElementById('hum-note').textContent = 'Billed monthly at ' + (data.new_price_label||'') + '. Cancel anytime.';
        }
        document.getElementById('hum-confirm-label').textContent = 'Confirm & Pay ' + chargeLabel;
        document.getElementById('hum-loading').style.display = 'none';
        document.getElementById('hum-content').style.display = 'block';
      })
      .catch(() => showHumError('Network error. Please try again.'));
  };

  function showHumError(msg) {
    document.getElementById('hum-loading').style.display = 'none';
    document.getElementById('hum-content').style.display = 'none';
    document.getElementById('hum-error-msg').textContent = msg;
    document.getElementById('hum-error').style.display   = 'block';
  }

  window.closeHomeUpgradeModal = function() {
    document.getElementById('home-upgrade-modal').style.display = 'none';
    _humPlan = null;
  };

  window.confirmHomeUpgrade = async function() {
    if (!_humPlan) return;
    const btn = document.getElementById('hum-confirm-btn');
    btn.disabled = true;
    document.getElementById('hum-confirm-label').textContent = 'Processing…';
    try {
      const res = await fetch('/api/subscription/upgrade', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ target_plan: _humPlan })
      });
      const data = await res.json();
      closeHomeUpgradeModal();
      if (data.redirect) { window.location.href = data.redirect; return; }
      if (data.ok) {
        sessionStorage.setItem('sf_pending_upgrade', _humPlan);
        showSfPlanToast('upgrade', _humPlan);
        setTimeout(function(){ window.location.href = '/dashboard'; }, 2200);
      } else { showSfPlanToast('error', null, data.error || 'Upgrade failed'); }
    } catch(e) { closeHomeUpgradeModal(); showSfPlanToast('error', null, 'Network error. Please try again.'); }
  };

  document.getElementById('home-upgrade-modal').addEventListener('click', function(e) {
    if (e.target === this) closeHomeUpgradeModal();
  });

  // ── On page load: update plan card buttons to match user's current plan ──────
  // Mirrors subscription page logic exactly:
  // Free user   → Creator card: "Upgrade to Creator" | Pro card: "Upgrade to Pro Artist"
  // Creator user → Free card: "Downgrade to Free"   | Pro card:  "Upgrade to Pro Artist"
  // Pro user    → Free card: "Downgrade to Free"    | Creator card: "Downgrade to Creator"
  // Any pending state → ALL other plan buttons locked (show "Pending — cancel first")
  (async function() {
    try {
      const [meRes, pendingRes] = await Promise.all([
        fetch('/api/auth/me').then(r => r.json()),
        fetch('/api/subscription/pending-state').then(r => r.json()).catch(() => ({}))
      ]);
      const user = meRes && meRes.user;
      if (!user) return;

      const rank = { free:0, creator:1, pro:2, developer:3 };
      const userRank = rank[user.plan] ?? 0;
      const pd = (pendingRes && pendingRes.pendingDowngrade) || null; // e.g. 'free' | 'creator'
      const pu = (pendingRes && pendingRes.pendingUpgrade)   || null; // e.g. 'pro' | 'creator'
      const hasPending = !!(pd || pu); // any pending state → lock all other buttons

      // Apply banner/cancel buttons from pending state
      homeApplyPendingState(pendingRes || {});

      // Helper: lock a button (shows "Pending — cancel first")
      function lockBtn(btn) {
        btn.innerHTML = '<i class="fas fa-lock" style="font-size:.75rem;margin-right:4px"></i>Cancel pending first';
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        btn.classList.remove('btn--primary');
        btn.classList.add('btn--outline');
        btn.style.borderColor = 'rgba(255,255,255,.15)';
        btn.style.color = 'var(--muted)';
      }

      // ── FREE tier button (it's an <a> tag, not a .home-plan-btn) ──
      const freePlanBtn = document.getElementById('home-free-plan-btn');
      if (freePlanBtn) {
        freePlanBtn.removeAttribute('href');
        if (userRank === 0) {
          freePlanBtn.textContent = 'Current plan';
          freePlanBtn.style.opacity = '0.6';
          freePlanBtn.style.pointerEvents = 'none';
        } else if (pd === 'free') {
          // Already pending downgrade to free — banner+cancel shown by homeApplyPendingState; hide button
          freePlanBtn.style.display = 'none';
        } else if (hasPending) {
          // Some other pending change → lock
          lockBtn(freePlanBtn);
        } else {
          freePlanBtn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>Downgrade to Free';
          freePlanBtn.style.borderColor = 'rgba(255,100,100,.5)';
          freePlanBtn.style.color = '#ff7070';
          freePlanBtn.style.cursor = 'pointer';
          freePlanBtn.addEventListener('click', (e) => {
            e.preventDefault();
            _homeDgPlan = 'free';
            const msg = document.getElementById('home-downgrade-msg');
            if (msg) msg.textContent = 'Your subscription will be cancelled. You will move to the Free plan after your billing cycle ends.';
            document.getElementById('home-downgrade-modal').style.display = 'flex';
          });
        }
      }

      // ── CREATOR & PRO buttons (.home-plan-btn) ──
      document.querySelectorAll('.home-plan-btn').forEach(btn => {
        const plan = btn.dataset.plan;
        if (!plan) return;
        const planRank = rank[plan] ?? 0;

        if (userRank === planRank) {
          // Current plan
          btn.innerHTML = 'Current plan';
          btn.disabled = true;
          btn.style.opacity = '0.6';
          btn.style.cursor = 'default';
          btn.classList.remove('btn--primary');
          btn.classList.add('btn--outline');
        } else if (pd === plan || pu === plan) {
          // This card IS the pending target — banner+cancel shown by homeApplyPendingState
          // Hide the button itself (banner takes its place)
          btn.style.display = 'none';
        } else if (hasPending) {
          // Some other pending change — lock this button
          lockBtn(btn);
        } else if (userRank > planRank) {
          // Downgrade path — no pending state
          const label = plan === 'creator' ? 'Downgrade to Creator' : 'Downgrade to Free';
          btn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>' + label;
          btn.classList.remove('btn--primary');
          btn.classList.add('btn--outline');
          btn.style.borderColor = 'rgba(255,100,100,.5)';
          btn.style.color = '#ff7070';
          const newBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(newBtn, btn);
          newBtn.addEventListener('click', () => {
            _homeDgPlan = plan;
            const msg = document.getElementById('home-downgrade-msg');
            if (plan === 'free') {
              if (msg) msg.textContent = 'Your subscription will be cancelled. You will move to the Free plan after your billing cycle ends.';
            } else if (plan === 'creator') {
              if (msg) msg.textContent = 'You will be downgraded to Creator ($10/mo, 900 points/mo) at the end of your current billing cycle. You keep all features until then.';
            }
            document.getElementById('home-downgrade-modal').style.display = 'flex';
          });
        } else {
          // Upgrade path — no pending state
          const label = plan === 'creator' ? 'Upgrade to Creator' : 'Upgrade to Pro Artist';
          btn.innerHTML = '<i class="fas fa-arrow-up" style="font-size:.8rem;margin-right:4px"></i>' + label;
          const newBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(newBtn, btn);
          newBtn.addEventListener('click', () => openHomeUpgradeModal(plan));
        }
      });

      // Show developer card if applicable
      if (user.plan === 'developer') {
        const devCard = document.getElementById('developer-plan-card');
        if (devCard) devCard.style.display = '';
      }
    } catch(e) { /* not logged in — leave buttons as default */ }
  })();
})();
</script>
</main>`)
}


// ─── GENERATOR PAGE (real pipeline UI) ───────────────────────────────────────
function generatorPage() {
  return shell('Generator', `
<div class="gs-content gs-content--gen">
<!-- Suno-style generator layout: left panel = controls, right panel = result -->
<div class="suno-gen-page">

  <!-- ── LEFT COLUMN: Input Controls ─────────────────────────── -->
  <div class="suno-left" id="suno-left">

    <!-- ── 3 Side-by-side tabs above lyrics ─────────────────── -->
    <div class="creator-tabs-row" id="creator-tabs-row">
      <button class="creator-tab-btn" id="ctab-remix" onclick="openRemixGated()"
        data-tooltip="Upload an MP3 or WAV and AI Remix it into a fresh new track.">
        <i class="fas fa-wand-magic-sparkles"></i> Remix
      </button>
      <button class="creator-tab-btn" id="ctab-extend" onclick="openCreatorPopup('extend')"
        data-tooltip="Continue any track from your library or upload a file to extend it seamlessly.">
        <i class="fas fa-expand-arrows-alt"></i> Song Extend
      </button>
      <button class="creator-tab-btn" id="ctab-oneshot" onclick="openOneShotGated()"
        data-tooltip="Generate isolated one-shot sounds — kicks, snares, 808s, hi-hats &amp; more.">
        <i class="fas fa-bolt"></i> One Shot Creator
      </button>
      <button class="creator-tab-btn" id="ctab-cover" onclick="openCoverPanel()"
        data-tooltip="Turn any song into an AI cover — upload audio and choose a new style.">
        <i class="fas fa-microphone-alt"></i> Cover Song
      </button>
    </div>

    <!-- ── Cover Song inline panel ─────────────────────────────── -->
    <div id="cover-inline-panel" style="display:none;margin-top:16px">
      <div class="suno-card" style="border:1px solid rgba(139,92,246,.35);background:rgba(139,92,246,.06)">
        <div class="suno-card__header" style="padding-bottom:10px">
          <i class="fas fa-microphone-alt" style="color:#a855f7;font-size:1rem"></i>
          <span class="suno-card__title" style="color:#c084fc">Cover Song</span>
          <button onclick="closeCoverPanel()" style="margin-left:auto;background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem"><i class="fas fa-times"></i></button>
        </div>
        <div class="suno-card__body" style="display:flex;flex-direction:column;gap:14px">

          <!-- Upload zone -->
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <label style="font-size:.8rem;font-weight:600;color:var(--muted);margin:0"><i class="fas fa-upload" style="margin-right:4px"></i>Source Audio (MP3 / WAV, max 20 MB)</label>
              <button id="cover-clear-btn" onclick="clearCoverUpload()" title="Remove uploaded file"
                style="display:none;background:none;border:none;color:var(--muted);cursor:pointer;font-size:.8rem;padding:2px 6px;border-radius:6px;transition:color .15s,background .15s"
                onmouseover="this.style.color='#f87171';this.style.background='rgba(239,68,68,.1)'"
                onmouseout="this.style.color='var(--muted)';this.style.background='none'">
                <i class="fas fa-times"></i> Remove
              </button>
            </div>
            <div id="cover-drop-zone"
              onclick="document.getElementById('cover-file-input').click()"
              ondragover="event.preventDefault();this.classList.add('cover-drop-zone--over')"
              ondragleave="this.classList.remove('cover-drop-zone--over')"
              ondrop="event.preventDefault();this.classList.remove('cover-drop-zone--over');handleCoverFileSelect(event.dataTransfer.files[0], null)"
              style="border:2px dashed rgba(139,92,246,.4);border-radius:10px;padding:22px 16px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s">
              <i id="cover-drop-icon" class="fas fa-cloud-upload-alt" style="font-size:1.6rem;color:#a855f7;display:block;margin-bottom:8px"></i>
              <span id="cover-drop-label" style="font-size:.85rem;color:var(--muted)">Drag &amp; drop or click to choose a file</span>
              <span id="cover-upload-filename" style="display:none;font-size:.82rem;color:#a855f7;font-weight:600;margin-top:4px"></span>
            </div>
            <input type="file" id="cover-file-input" accept="audio/*" style="display:none" onchange="handleCoverFileSelect(this.files[0], this)"/>
            <div id="cover-upload-error" style="display:none;margin-top:8px;padding:10px 12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);border-radius:8px;font-size:.82rem;line-height:1.45;color:#f87171"></div>
          </div>

          <!-- Instrumental toggle — sits ABOVE lyrics so toggling it hides/shows them intuitively -->
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:8px">
            <i class="fas fa-drum" style="color:var(--primary);font-size:.95rem;flex-shrink:0"></i>
            <span style="font-size:.85rem;font-weight:600;flex:1">Make Instrumental</span>
            <label class="suno-switch">
              <input type="checkbox" id="cover-instrumental-toggle" onchange="coverInstrumentalToggled(this.checked)"/>
              <span class="suno-switch__track"><span class="suno-switch__thumb"></span></span>
            </label>
          </div>

          <!-- Lyrics (hidden when instrumental) -->
          <div id="cover-lyrics-section" style="background:rgba(255,255,255,.03);border:1px solid rgba(139,92,246,.2);border-radius:10px;padding:14px 16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <i class="fas fa-align-left" style="color:#a855f7;font-size:.9rem"></i>
              <span style="font-size:.82rem;font-weight:700;color:#e2e8f0;letter-spacing:.02em">CUSTOM LYRICS</span>
              <span style="font-size:.75rem;color:var(--muted);font-weight:400;margin-left:2px">— optional, leave blank for AI</span>
            </div>
            <textarea id="cover-lyrics" class="suno-textarea" rows="5"
              placeholder="[Verse]&#10;Your custom lyrics here…&#10;&#10;[Chorus]&#10;Or leave blank for AI-generated lyrics"></textarea>
          </div>

          <!-- Style prompt -->
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <i class="fas fa-paint-brush" style="color:#94a3b8;font-size:.9rem"></i>
              <span style="font-size:.82rem;font-weight:700;color:#e2e8f0;letter-spacing:.02em">COVER STYLE</span>
              <span style="font-size:.75rem;color:var(--muted);font-weight:400;margin-left:2px">— optional</span>
            </div>
            <textarea id="cover-style-prompt" class="suno-textarea" rows="3"
              placeholder="e.g. dark trap version with 808s and heavy reverb, or leave blank to let AI decide…"></textarea>
            <div id="cover-style-ai-badge" style="display:none;margin-top:6px;font-size:.72rem;color:#a855f7;display:none;align-items:center;gap:5px">
              <i class="fas fa-magic" style="font-size:.68rem"></i>
              <span>AI detected — edit freely before creating</span>
            </div>
          </div>

          <!-- Song Title -->
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <i class="fas fa-tag" style="color:#94a3b8;font-size:.9rem"></i>
              <span style="font-size:.82rem;font-weight:700;color:#e2e8f0;letter-spacing:.02em">SONG TITLE</span>
              <span style="font-size:.75rem;color:var(--muted);font-weight:400;margin-left:2px">— optional</span>
            </div>
            <input type="text" id="cover-title" class="suno-field-input" placeholder="Auto-filled from filename — or type your own…"
              style="width:100%;box-sizing:border-box"/>
          </div>

          <!-- Audio mini-player (shown after upload) -->
          <div id="cover-mini-player" style="display:none;background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.25);border-radius:10px;padding:12px 14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <!-- Restart -->
              <button onclick="coverPlayerRestart()" title="Restart from beginning"
                style="width:30px;height:30px;border-radius:50%;background:none;border:1px solid rgba(139,92,246,.35);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:rgba(168,85,247,.7);font-size:.75rem;transition:all .15s"
                onmouseenter="this.style.color='#a855f7';this.style.borderColor='rgba(168,85,247,.7)';this.style.background='rgba(168,85,247,.1)'"
                onmouseleave="this.style.color='rgba(168,85,247,.7)';this.style.borderColor='rgba(139,92,246,.35)';this.style.background='none'">
                <i class="fas fa-step-backward"></i>
              </button>
              <!-- Play/Pause -->
              <button id="cover-play-btn" onclick="coverPlayerToggle()"
                style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#a855f7);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .15s,opacity .2s">
                <i id="cover-play-icon" class="fas fa-play" style="color:#fff;font-size:.82rem;margin-left:2px"></i>
              </button>
              <div style="flex:1;min-width:0">
                <div id="cover-player-filename" style="font-size:.78rem;font-weight:600;color:#c084fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px"></div>
                <!-- Scrubber -->
                <div style="display:flex;align-items:center;gap:8px">
                  <span id="cover-player-cur" style="font-size:.72rem;color:var(--muted);width:32px;flex-shrink:0;text-align:right">0:00</span>
                  <div id="cover-scrubber-track"
                    onclick="coverScrubClick(event)"
                    onmousedown="coverScrubStart(event)"
                    ontouchstart="coverScrubTouchStart(event)"
                    style="flex:1;height:5px;background:rgba(139,92,246,.25);border-radius:3px;cursor:pointer;position:relative">
                    <div id="cover-scrubber-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:3px;pointer-events:none;transition:width .1s linear"></div>
                    <div id="cover-scrubber-thumb"
                      style="position:absolute;top:50%;right:calc(100% - 0%);transform:translate(50%,-50%);width:13px;height:13px;border-radius:50%;background:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.3);cursor:grab;pointer-events:none;transition:right .1s linear"></div>
                  </div>
                  <span id="cover-player-dur" style="font-size:.72rem;color:var(--muted);width:32px;flex-shrink:0">0:00</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Status -->
          <div id="cover-status" style="display:none;font-size:.82rem;color:var(--muted);display:flex;align-items:center;gap:6px"></div>

          <!-- Create button -->
          <button id="cover-create-btn" onclick="startCoverSong()"
            style="width:100%;padding:13px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .2s">
            <i class="fas fa-microphone-alt"></i> Create Cover
          </button>
        </div>
      </div>
    </div>

    <!-- ── Cover processing overlay ────────────────────────────── -->
    <style>
      @keyframes cover-bar-auto {
        0%   { width: 5% }
        8%   { width: 20% }
        20%  { width: 38% }
        45%  { width: 58% }
        70%  { width: 74% }
        90%  { width: 84% }
        100% { width: 88% }
      }
      @keyframes cover-icon-pulse {
        0%,100% { transform: scale(1); opacity:1 }
        50%      { transform: scale(1.12); opacity:.8 }
      }
      @keyframes cover-shimmer {
        0%   { background-position: -200% center }
        100% { background-position: 200% center }
      }
      #cover-progress-bar.auto-animate {
        animation: cover-bar-auto 180s cubic-bezier(.15,.5,.4,1) forwards;
      }
      #cover-progress-bar.instant {
        animation: none !important;
        transition: width .5s ease !important;
      }
    </style>
    <div id="cover-processing-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;align-items:center;justify-content:center;flex-direction:column;gap:20px;text-align:center;padding:24px;backdrop-filter:blur(4px)">
      <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;animation:cover-icon-pulse 2s ease-in-out infinite;box-shadow:0 0 32px rgba(168,85,247,.4)">
        <i class="fas fa-microphone-alt" style="font-size:1.8rem;color:#fff"></i>
      </div>
      <div>
        <h3 style="margin:0 0 8px;font-size:1.25rem;font-weight:700;color:#fff">Creating your cover…</h3>
        <p id="cover-overlay-msg" style="margin:0;font-size:.88rem;color:rgba(255,255,255,.6);min-height:1.2em;transition:opacity .3s">Uploading source audio…</p>
      </div>
      <div style="width:300px">
        <div style="width:100%;height:8px;background:rgba(255,255,255,.12);border-radius:4px;overflow:hidden;position:relative">
          <div id="cover-progress-bar" style="height:100%;width:5%;background:linear-gradient(90deg,#7c3aed,#a855f7,#ec4899);background-size:200% 100%;border-radius:4px;transition:width .6s ease;animation:cover-shimmer 2s linear infinite,cover-bar-auto 180s cubic-bezier(.15,.5,.4,1) forwards"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px">
          <span id="cover-stage-label" style="font-size:.72rem;color:rgba(255,255,255,.35)">Uploading</span>
          <span id="cover-pct-label" style="font-size:.72rem;color:rgba(255,255,255,.35)">0%</span>
        </div>
      </div>
      <p style="font-size:.78rem;color:rgba(255,255,255,.35);margin:0">Cover generation usually takes 1–3 minutes</p>
      <button onclick="dismissCoverOverlay()" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.6);padding:9px 22px;border-radius:9px;cursor:pointer;font-size:.82rem;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,.14)'" onmouseout="this.style.background='rgba(255,255,255,.08)'">
        <i class="fas fa-times"></i> Dismiss (runs in background)
      </button>
    </div>


    <!-- ── Generator main sections (hidden while Cover Song panel is open) ── -->
    <div id="generator-main-sections">

    <!-- SECTION 1: Prompt — sits above Lyrics/Instrumental -->
    <div class="suno-card" id="card-prompt">
      <div class="suno-card__header">
        <button class="suno-card__collapse" id="prompt-collapse-btn" aria-label="Toggle">
          <i class="fas fa-chevron-down" id="prompt-collapse-icon"></i>
        </button>
        <span class="suno-card__title">Prompt</span>
      </div>
      <div class="suno-card__body" id="prompt-body">
        <textarea class="suno-textarea" id="gen-prompt" rows="4"
          placeholder="Describe your beat... e.g. dark surf noir trap, moody Rhodes, open hi-hats, deep 808 bass, cinematic and emotional"></textarea>
        <div class="suno-textarea-actions">
          <button class="suno-icon-btn" title="Magic Wand" id="prompt-magic-btn" data-tooltip="Auto-suggest a prompt based on your style"><i class="fas fa-magic"></i></button>
          <button class="suno-icon-btn" title="Expand" data-tooltip="Expand or collapse the text area" onclick="document.getElementById('gen-prompt').rows=document.getElementById('gen-prompt').rows===4?10:4"><i class="fas fa-expand-arrows-alt"></i></button>
        </div>
      </div>
    </div>

    <!-- SECTION 2: Lyrics / Instrumental -->
    <div class="suno-card" id="card-lyrics">
      <div class="suno-card__header">
        <button class="suno-card__collapse" id="lyrics-collapse-btn" aria-label="Toggle">
          <i class="fas fa-chevron-down" id="lyrics-collapse-icon"></i>
        </button>
        <span class="suno-card__title">Lyrics</span>
        <div class="suno-tab-group" id="lyrics-tabs">
          <button class="suno-tab active" data-tab="write" data-tooltip="Write your own lyrics — use [Verse], [Chorus] tags">Write</button>
          <button class="suno-tab" data-tab="instrumental" data-tooltip="No vocals — generate a pure instrumental beat">Instrumental</button>
        </div>
      </div>
      <div class="suno-card__body" id="lyrics-body">
        <!-- Write tab -->
        <div class="suno-tab-panel active" id="tab-write">
          <textarea class="suno-textarea" id="gen-lyrics" rows="5"
            placeholder="[Verse]&#10;Write your lyrics here...&#10;&#10;Section tags like [Chorus] help structure your track.&#10;Duration is auto-calculated from your lyrics."></textarea>
          <div class="suno-textarea-actions">
            <button class="suno-icon-btn" title="Magic Wand" id="lyrics-magic-btn" data-tooltip="Auto-suggest lyric ideas based on your style"><i class="fas fa-magic"></i></button>
            <button class="suno-icon-btn" title="Generate Lyrics with StemForge" id="gen-lyrics-btn" data-tooltip="Let StemForge write full lyrics for you based on your style settings" style="display:flex;align-items:center;gap:5px;padding:6px 10px;font-size:.78rem;font-weight:600;border-radius:8px;background:linear-gradient(135deg,rgba(78,159,255,.18),rgba(139,92,246,.18));border:1px solid rgba(78,159,255,.35);color:var(--primary);white-space:nowrap"><i class="fas fa-wand-magic-sparkles"></i> Generate Lyrics</button>
            <button class="suno-icon-btn" title="Expand" data-tooltip="Expand or collapse the text area" onclick="document.getElementById('gen-lyrics').rows=document.getElementById('gen-lyrics').rows===5?12:5"><i class="fas fa-expand-arrows-alt"></i></button>
          </div>
          <!-- Live duration estimate from lyrics -->
          <div id="lyrics-duration-hint" style="display:none;margin-top:6px;font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:5px">
            <i class="fas fa-clock" style="color:var(--primary)"></i>
            <span id="lyrics-duration-text">Estimated duration: —</span>
          </div>
          <!-- Generate Lyrics panel — shown when gen-lyrics-btn is clicked -->
          <div id="gen-lyrics-panel" style="display:none;margin-top:12px;padding:14px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:10px">
            <p style="font-size:.8rem;color:var(--muted);margin:0 0 8px">Describe what the song is about and StemForge will write the lyrics:</p>
            <textarea id="gen-lyrics-desc" class="suno-textarea" rows="3" placeholder="e.g. A song about grinding late nights in the studio, chasing dreams, staying loyal to the team..."></textarea>
            <button id="gen-lyrics-submit" onclick="generateLyricsAI()" style="margin-top:10px;width:100%;padding:10px;background:linear-gradient(135deg,var(--primary),#8b5cf6);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:.88rem"><i class="fas fa-sparkles"></i> Generate Lyrics</button>
            <div id="gen-lyrics-status" style="display:none;margin-top:8px;font-size:.8rem;color:var(--muted)"></div>
          </div>
        </div>
        <!-- Instrumental tab (toggle) -->
        <div class="suno-tab-panel" id="tab-instrumental">
          <div class="suno-instrumental-toggle">
            <div class="suno-instrumental-toggle__info">
              <i class="fas fa-drum" style="font-size:24px;color:var(--primary)"></i>
              <div>
                <strong>Instrumental mode</strong>
                <p>Generate a beat with no vocals — pure instrumentals only.</p>
              </div>
            </div>
            <label class="suno-switch">
              <input type="checkbox" id="gen-instrumental"/>
              <span class="suno-switch__track"><span class="suno-switch__thumb"></span></span>
            </label>
          </div>
          <p class="suno-instrumental-note" id="instrumental-note" style="display:none">
            <i class="fas fa-check-circle" style="color:var(--accent-2)"></i>
            Instrumental mode is <strong>ON</strong> — no vocal space will be generated.
          </p>
        </div>
      </div>
    </div>

    <!-- SECTION 1.5: Vocal Gender Toggle — below Lyrics, above Reference Track -->
    <div class="suno-card suno-card--slim" id="card-vocals" data-tooltip="Choose vocal gender feel, or turn off for instrumental">
      <div style="display:flex;align-items:center;gap:10px;padding:2px 0">
        <i class="fas fa-microphone" style="color:var(--primary);font-size:.95rem;flex-shrink:0"></i>
        <span style="font-size:.85rem;font-weight:600;color:var(--text);flex-shrink:0">Vocals</span>
        <div class="vocal-toggle-group" id="vocal-toggle-group">
          <button class="vocal-toggle-btn" data-vocal="male" id="vt-male" onclick="setVocalToggle('male')" data-tooltip="Male vocal feel">
            <i class="fas fa-mars"></i> Male
          </button>
          <button class="vocal-toggle-btn vocal-toggle-btn--off vocal-toggle-btn--active" data-vocal="off" id="vt-off" onclick="setVocalToggle('off')" data-tooltip="Off — no vocal specification">
            <i class="fas fa-ban"></i> Off
          </button>
          <button class="vocal-toggle-btn" data-vocal="female" id="vt-female" onclick="setVocalToggle('female')" data-tooltip="Female vocal feel">
            <i class="fas fa-venus"></i> Female
          </button>
        </div>
      </div>
    </div>


    <!-- SECTION 4: Styles -->
    <div class="suno-card" id="card-styles">
      <div class="suno-card__header">
        <button class="suno-card__collapse" id="styles-collapse-btn" aria-label="Toggle">
          <i class="fas fa-chevron-down" id="styles-collapse-icon"></i>
        </button>
        <span class="suno-card__title">Styles</span>
      </div>
      <div class="suno-card__body" id="styles-body">
        <input type="text" class="suno-style-input" id="gen-style"
          placeholder="e.g. dark trap, melodic, 808s, moody, cinematic..."
          maxlength="200"/>
        <div class="suno-style-chips-row">
          <button class="suno-icon-btn suno-icon-btn--blue" id="style-magic-btn" title="Auto-suggest style"><i class="fas fa-magic"></i></button>
          <button class="suno-chips-arrow" id="chips-arrow-left" aria-label="Scroll left" disabled><i class="fas fa-chevron-left"></i></button>
          <div class="suno-style-chips" id="style-chips-scroll">
            <button class="suno-chip" data-style="hip hop">Hip Hop</button>
            <button class="suno-chip" data-style="trap">Trap</button>
            <button class="suno-chip" data-style="drill">Drill</button>
            <button class="suno-chip" data-style="R&B">R&B</button>
            <button class="suno-chip" data-style="soca">Soca</button>
            <button class="suno-chip" data-style="lo-fi">Lo-Fi</button>
            <button class="suno-chip" data-style="boom bap">Boom Bap</button>
            <button class="suno-chip" data-style="afrobeats">Afrobeats</button>
            <button class="suno-chip" data-style="dancehall">Dancehall</button>
            <button class="suno-chip" data-style="cinematic">Cinematic</button>
            <button class="suno-chip" data-style="reggaeton">Reggaeton</button>
            <button class="suno-chip" data-style="house">House</button>
            <button class="suno-chip" data-style="gospel">Gospel</button>
            <button class="suno-chip" data-style="jazz">Jazz</button>
            <button class="suno-chip" data-style="soul">Soul</button>
          </div>
          <button class="suno-chips-arrow" id="chips-arrow-right" aria-label="Scroll right"><i class="fas fa-chevron-right"></i></button>
        </div>
      </div>
    </div>

    </div><!-- /generator-main-sections -->

    <!-- SECTION 6: Song Title (hidden — covered by Cover tab's own field; kept in DOM for JS compatibility) -->
    <input type="text" id="gen-title" style="display:none" aria-hidden="true" tabindex="-1"/>

    <!-- CREATE BUTTON — inline below, with tooltip -->
    <div class="suno-create-inline" id="generator-create-row">
      <button class="suno-create-btn" id="gen-full-btn"
        data-tooltip="Generate your beat using StemForge">
        <i class="fas fa-music"></i> Create
      </button>

    </div>

  </div><!-- /suno-left -->

  <!-- ── RIGHT COLUMN: Result / Pipeline ─────────────────────── -->
  <div class="suno-right">

    <!-- Pipeline status - dual project-card style beat cards -->
    <div class="pipeline-status suno-pipeline" id="pipeline-status" style="display:none">

      <!-- Single centered beat card (project-card structure) -->
      <div class="pipeline-gen-row">

        <!-- Beat card (single, centered) -->
        <div class="project-card pipeline-gen-card" id="pipeline-card-1">
          <!-- Art / Video section (top half) -->
          <div class="project-card__art pipeline-gen-card__art">
            <video class="pipeline-gen-video" src="/static/forge-beat1.mp4" autoplay muted loop playsinline></video>
            <!-- Spinner overlay (shown during generation, display:flex by default) -->
            <div class="pipeline-gen-card__spinner-overlay" id="pipeline-card-1-overlay" style="display:flex">
              <div class="pipeline-spinner"></div>
            </div>
            <!-- Play button overlay (hidden until ready) -->
            <div class="project-card__play pipeline-gen-card__play" id="pipeline-card-1-play" style="display:none" onclick="pipelineCardPlay(1)">
              <i class="fas fa-play"></i>
            </div>
          </div>
          <!-- Body section (bottom half) -->
          <div class="project-card__body pipeline-gen-card__body">
            <h4 id="pipeline-card-1-title">Your Beat</h4>
            <p id="pipeline-card-1-msg" class="pipeline-spinner-msg">Generating…</p>
            <!-- Scrubber (hidden until ready) -->
            <div class="pipeline-scrubber" id="pipeline-scrubber-1" style="display:none">
              <input type="range" class="pipeline-scrubber__range" id="pipeline-scrubber-1-range" min="0" max="100" step="0.1" value="0">
              <div class="pipeline-scrubber__times">
                <span id="pipeline-scrubber-1-cur">0:00</span>
                <span id="pipeline-scrubber-1-dur">0:00</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Hidden dummy card 2 (JS still refs it safely, display:none) -->
        <div id="pipeline-card-2" style="display:none">
          <div id="pipeline-card-2-overlay" style="display:none"></div>
          <div id="pipeline-card-2-play" style="display:none"></div>
          <p id="pipeline-card-2-msg"></p>
          <h4 id="pipeline-card-2-title"></h4>
          <div id="pipeline-scrubber-2" style="display:none">
            <input type="range" id="pipeline-scrubber-2-range"><span id="pipeline-scrubber-2-cur"></span><span id="pipeline-scrubber-2-dur"></span>
          </div>
        </div>
        <audio id="pipeline-audio-2" style="display:none"></audio>

      </div><!-- /pipeline-gen-row -->

      <!-- Hidden audio player for card playback -->
      <audio id="pipeline-audio-1" style="display:none"></audio>

      <!-- Status line -->
      <p class="pipeline-gen-status-sub" id="pipeline-status-sub">Stemforge is forging your beats…</p>

      <!-- Cancel button (shown while generating) -->
      <button id="gen-cancel-btn" onclick="cancelGeneration()" class="pipeline-gen-cancel-btn">
        <i class="fas fa-times" style="margin-right:5px"></i>Cancel
      </button>

      <!-- Close/dismiss button — always visible so user can cancel at any time -->
      <button id="pipeline-close-btn" onclick="closePipelinePlayer()" title="Cancel / close player" style="position:absolute;top:10px;right:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:50%;width:30px;height:30px;cursor:pointer;color:rgba(255,255,255,.6);font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:10" onmouseover="this.style.background='rgba(255,255,255,.18)';this.style.color='#fff'" onmouseout="this.style.background='rgba(255,255,255,.08)';this.style.color='rgba(255,255,255,.6)'">
        <i class="fas fa-times"></i>
      </button>

      <!-- hidden step trackers for JS logic only (not shown to user) -->
      <div style="display:none" id="step-blueprint"><div id="ind-blueprint"></div></div>
      <div style="display:none" id="step-generating"><div id="ind-generating"></div></div>
      <div style="display:none" id="step-extracting"><div id="ind-extracting"></div></div>
      <div class="pipeline-blueprint" id="pipeline-blueprint" style="display:none">
        <div class="blueprint-pills" id="blueprint-pills"></div>
      </div>
    </div>

    <!-- Result area -->
    <div class="gen-result" id="gen-result" style="display:none">
      <!-- Beat thumbnail (Suno-style top banner) -->
      <div class="gen-result__thumb" id="gen-result-thumb" style="display:none">
        <i class="fas fa-wave-square gen-result__thumb-icon"></i>
        <div class="gen-result__thumb-label" id="gen-result-thumb-label"></div>
      </div>
      <div class="gen-result__header">
        <div>
          <h3 id="gen-result-title">Beat Ready</h3>
          <p id="gen-result-sub">Loading track info...</p>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="gen-result__status">
            <span class="status-dot status-dot--ready"></span> Ready
          </div>
          <button class="song-dots-btn" id="gen-result-dots" title="Options" onclick="openSongEditModal(null)" style="display:none">
            <i class="fas fa-ellipsis-h"></i>
          </button>
        </div>
      </div>
      <!-- Stereo player -->
      <div class="stereo-player" id="stereo-player" style="display:none">
        <div class="stereo-player__label"><i class="fas fa-music"></i> Full stereo mix</div>
        <audio id="stereo-audio" controls controlsList="nodownload" oncontextmenu="return false;" style="width:100%;margin-top:8px;"></audio>
      </div>
      <!-- Track list (hidden for free tier, shown for Creator/Pro) -->
      <div class="track-list" id="track-list" style="display:none"></div>
      <!-- Action buttons row -->
      <div class="export-panel" style="padding-top:0">
        <div class="export-options" id="export-options-row"></div>
        
      </div>
    </div>

    <!-- Empty state -->
    <div class="gen-empty" id="gen-empty">
      <div class="gen-empty__icon"><i class="fas fa-wave-square"></i></div>
      <h3>Your beat will appear here.</h3>
      <p>Fill in lyrics or a prompt, set your style,<br/>then hit <strong>Create</strong> below.</p>
    </div>

    <!-- Error state -->
    <div class="gen-error" id="gen-error" style="display:none">
      <div class="gen-empty__icon" style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i></div>
      <h3>Generation failed</h3>
      <p id="gen-error-msg">Something went wrong. Please try again.</p>
      <button class="btn btn--outline" id="gen-retry-btn" style="margin-top:16px">
        <i class="fas fa-redo"></i> Try again
      </button>
    </div>

  </div><!-- /suno-right -->

</div><!-- /suno-gen-page -->

<!-- ── Creator Tab Popups ──────────────────────────────────── -->

<!-- ── Remix Upload Modal ────────────────────────────────────────────── -->
<div id="remix-upload-overlay" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)window.closeRemixUploadModal()">
  <div style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;max-width:480px;width:100%;padding:28px 28px 24px;box-shadow:0 32px 80px rgba(0,0,0,.9);font-family:Inter,system-ui,sans-serif">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
      <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="fas fa-wand-magic-sparkles" style="color:#fff;font-size:.9rem"></i>
      </div>
      <div style="flex:1">
        <div style="font-size:1.05rem;font-weight:800;color:#fff">AI Remix</div>
        <div style="font-size:.75rem;color:#6b7280">Upload a track and reimagine it with AI</div>
      </div>
      <button onclick="window.closeRemixUploadModal()" style="background:none;border:1px solid #1e2a3a;color:#6b7280;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center">×</button>
    </div>

    <!-- Drop zone -->
    <div id="remix-drop-zone" style="border:2px dashed rgba(139,92,246,.4);border-radius:12px;padding:28px 20px;text-align:center;cursor:pointer;transition:all .2s;background:rgba(139,92,246,.04)"
      onclick="document.getElementById('remix-file-input').click()"
      ondragover="event.preventDefault();this.style.borderColor='rgba(139,92,246,.8)';this.style.background='rgba(139,92,246,.1)'"
      ondragleave="this.style.borderColor='rgba(139,92,246,.4)';this.style.background='rgba(139,92,246,.04)'"
      ondrop="event.preventDefault();this.style.borderColor='rgba(139,92,246,.4)';this.style.background='rgba(139,92,246,.04)';window.handleRemixFileDrop(event)">
      <div id="remix-drop-idle">
        <i class="fas fa-cloud-upload-alt" style="font-size:2rem;color:#7c3aed;margin-bottom:10px"></i>
        <div style="font-size:.9rem;font-weight:600;color:#e2e8f0">Drop your track here</div>
        <div style="font-size:.78rem;color:#6b7280;margin-top:4px">MP3 or WAV</div>
        <button style="margin-top:14px;background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.4);color:#a78bfa;padding:8px 20px;border-radius:8px;cursor:pointer;font-size:.82rem;font-weight:600">Browse files</button>
      </div>
      <div id="remix-drop-loading" style="display:none">
        <i class="fas fa-spinner fa-spin" style="font-size:1.5rem;color:#7c3aed;margin-bottom:8px"></i>
        <div style="font-size:.88rem;color:#a78bfa" id="remix-upload-status">Uploading…</div>
      </div>
      <div id="remix-drop-done" style="display:none">
        <i class="fas fa-check-circle" style="font-size:1.5rem;color:#10b981;margin-bottom:8px"></i>
        <div style="font-size:.88rem;font-weight:700;color:#e2e8f0" id="remix-file-name">track.mp3</div>
        <div style="font-size:.75rem;color:#6b7280;margin-top:3px">Ready to remix</div>
      </div>
    </div>
    <input type="file" id="remix-file-input" accept=".mp3,.wav,audio/mpeg,audio/wav" style="display:none" onchange="window.handleRemixFileSelect(this)"/>

    <div id="remix-upload-error" style="display:none;color:#ef4444;font-size:.82rem;margin-top:10px;padding:8px 12px;background:rgba(239,68,68,.08);border-radius:8px;border:1px solid rgba(239,68,68,.2)"></div>

    <div style="margin-top:18px;display:flex;gap:10px">
      <button onclick="window.closeRemixUploadModal()" style="flex:1;padding:11px;background:none;border:1px solid #1e2a3a;border-radius:10px;color:#6b7280;cursor:pointer;font-size:.88rem;font-weight:600">Cancel</button>
      <button id="remix-go-btn" onclick="window.startRemixFromUpload()" disabled style="flex:2;padding:11px;background:linear-gradient(135deg,#7c3aed,#a855f7);border:none;border-radius:10px;color:#fff;cursor:pointer;font-size:.88rem;font-weight:700;opacity:.4;transition:opacity .2s">
        <i class="fas fa-wand-magic-sparkles"></i> Remix It
      </button>
    </div>
  </div>
</div>

<!-- Song Extend Popup -->
<div id="creator-popup-extend" class="creator-popup" style="display:none">
  <div class="creator-popup__header" id="creator-popup-extend-header">
    <span class="creator-popup__title"><i class="fas fa-expand-arrows-alt"></i> Song Extend</span>
    <button class="creator-popup__close" onclick="closeCreatorPopup('extend')"><i class="fas fa-times"></i></button>
  </div>
  <div class="creator-popup__body">

    <!-- Source tabs: Upload / Library -->
    <div id="ext-source-tabs" style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:14px">
      <button id="ext-tab-upload" onclick="extSwitchTab('upload')" style="flex:1;background:none;border:none;border-bottom:2px solid var(--primary);color:var(--primary);font-weight:700;padding:9px 0;font-size:.82rem;cursor:pointer;transition:all .2s">
        <i class="fas fa-cloud-upload-alt" style="margin-right:5px"></i>Upload
      </button>
      <button id="ext-tab-library" onclick="extSwitchTab('library')" style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);font-weight:600;padding:9px 0;font-size:.82rem;cursor:pointer;transition:all .2s">
        <i class="fas fa-music" style="margin-right:5px"></i>Library
      </button>

    </div>

    <!-- Step 1a: Upload tab -->
    <div id="ext-step-pick" style="display:block">
      <label class="suno-option-label" style="margin-bottom:10px">Upload a track to extend</label>
      <div class="ref-upload-zone" id="ext-upload-zone" onclick="document.getElementById('ext-audio-file').click()" style="cursor:pointer">
        <input type="file" id="ext-audio-file" accept="audio/mpeg,audio/mp3,audio/wav,audio/wave,.mp3,.wav" style="display:none" onchange="extHandleFileSelect(this)"/>
        <div id="ext-upload-idle" style="display:flex;flex-direction:column;align-items:center">
          <i class="fas fa-cloud-upload-alt" style="font-size:1.5rem;color:var(--primary);margin-bottom:6px"></i>
          <p style="margin:0;font-weight:600;font-size:.88rem">Upload Audio to Extend</p>
          <p style="margin:3px 0 0;color:var(--muted);font-size:.76rem">MP3 or WAV — output delivered as WAV</p>
        </div>
        <div id="ext-upload-loading" style="display:none;flex-direction:column;align-items:center">
          <i class="fas fa-spinner fa-spin" style="font-size:1.3rem;color:var(--primary);margin-bottom:6px"></i>
          <p style="margin:0;font-size:.85rem;color:var(--muted)">Uploading…</p>
        </div>
        <div id="ext-upload-done" style="display:none;flex-direction:column;align-items:center">
          <i class="fas fa-check-circle" style="font-size:1.3rem;color:#10b981;margin-bottom:5px"></i>
          <p style="margin:0;font-weight:600;font-size:.85rem" id="ext-upload-name">track.wav</p>
          <p style="margin:3px 0 0;color:var(--muted);font-size:.75rem">Ready — scrub below to set extend point</p>
        </div>
      </div>
      <div id="ext-upload-error" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;font-size:.8rem;color:#f87171;text-align:center"></div>
      <button id="ext-upload-next-btn" onclick="extGoToOptions()" class="btn btn--primary" style="width:100%;margin-top:12px;padding:10px;font-size:.88rem;font-weight:700;display:none">
        <i class="fas fa-arrow-right"></i> Next: Pick Extend Point
      </button>
    </div>

    <!-- Step 1b: Library tab — pick from saved beats -->
    <div id="ext-step-library" style="display:none">
      <label class="suno-option-label" style="margin-bottom:10px">Pick a beat from your library</label>
      <div id="ext-lib-loading" style="text-align:center;padding:20px;color:var(--muted);font-size:.85rem">
        <i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Loading your beats…
      </div>
      <div id="ext-lib-list" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto"></div>
      <div id="ext-lib-empty" style="display:none;text-align:center;padding:24px;color:var(--muted);font-size:.85rem">
        <i class="fas fa-music" style="font-size:2rem;opacity:.3;display:block;margin-bottom:10px"></i>
        No beats in your library yet. Generate a beat first or use the Upload tab.
      </div>
    </div>

    <!-- Step 2: Scrubber + lyrics + submit -->
    <div id="ext-step-options" style="display:none;margin-top:2px">

      <!-- Track name + change button -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <i class="fas fa-music" style="color:var(--primary);font-size:.9rem;flex-shrink:0"></i>
          <span id="ext-sel-title" style="font-size:.85rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>
        </div>
        <button onclick="extResetUpload()" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 8px;border-radius:6px;font-size:.78rem;flex-shrink:0;white-space:nowrap"><i class="fas fa-times"></i> Change</button>
      </div>

      <!-- Extend-at label + live timestamp badge -->
      <label class="suno-option-label" style="margin-bottom:4px">
        Extend from <span style="font-weight:400;color:var(--muted);font-size:.8rem">(drag to set start of new section)</span>
        <span id="ext-time-badge" style="margin-left:8px;background:rgba(78,159,255,.15);border:1px solid rgba(78,159,255,.35);border-radius:6px;padding:2px 8px;font-size:.78rem;font-weight:700;color:var(--primary);letter-spacing:.02em">End of track</span>
      </label>
      <p style="margin:0 0 8px;font-size:.75rem;color:var(--muted)"><i class="fas fa-info-circle" style="margin-right:4px"></i>Leave at end to append new audio after your track. Drag left to regenerate a section from that point.</p>

      <!-- Hidden audio element for scrubbing -->
      <audio id="ext-preview-audio" preload="metadata" style="display:none"></audio>

      <!-- Waveform-style scrubber track -->
      <div id="ext-scrubber-wrap" style="position:relative;margin-bottom:6px;border-radius:8px;overflow:hidden;background:rgba(255,255,255,.04);border:1px solid var(--border);cursor:pointer" onclick="extScrubClick(event,this)">
        <!-- Progress fill -->
        <div id="ext-scrubber-fill" style="position:absolute;left:0;top:0;height:100%;background:rgba(78,159,255,.25);pointer-events:none;transition:width .05s linear;width:0%"></div>
        <!-- Canvas waveform -->
        <canvas id="ext-waveform-canvas" height="54" style="width:100%;display:block;position:relative;z-index:1"></canvas>
        <!-- Playhead line -->
        <div id="ext-playhead" style="position:absolute;top:0;width:2px;height:100%;background:var(--primary);pointer-events:none;left:0%;z-index:2;border-radius:1px"></div>
        <!-- Time tooltip -->
        <div id="ext-scrub-tooltip" style="position:absolute;top:4px;background:rgba(0,0,0,.75);color:#fff;font-size:.7rem;padding:2px 6px;border-radius:4px;pointer-events:none;display:none;z-index:3;transform:translateX(-50%)">0:00</div>
      </div>

      <!-- Play/pause + duration display -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <button id="ext-play-btn" onclick="extTogglePlay()" style="background:rgba(78,159,255,.15);border:1px solid rgba(78,159,255,.3);border-radius:8px;padding:5px 14px;color:var(--primary);cursor:pointer;font-size:.82rem;display:flex;align-items:center;gap:6px">
          <i class="fas fa-play" id="ext-play-icon"></i> <span id="ext-play-label">Play</span>
        </button>
        <span style="font-size:.78rem;color:var(--muted)">Drag scrubber to set the extend start point</span>
        <span id="ext-duration-label" style="margin-left:auto;font-size:.78rem;color:var(--muted);white-space:nowrap">—</span>
      </div>

      <!-- Instrumental / Vocal toggle -->
      <div style="margin-bottom:12px">
        <label class="suno-option-label" style="margin-bottom:6px">Extension type</label>
        <div style="display:flex;gap:8px">
          <button id="ext-mode-instr-btn" onclick="setExtMode('instrumental')"
            class="beat-count-btn beat-count-btn--active"
            style="flex:1;padding:8px 0;border-radius:10px;font-size:.82rem;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px">
            <i class="fas fa-guitar"></i> Instrumental
          </button>
          <button id="ext-mode-vocal-btn" onclick="setExtMode('vocal')"
            class="beat-count-btn"
            style="flex:1;padding:8px 0;border-radius:10px;font-size:.82rem;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px">
            <i class="fas fa-microphone"></i> Vocal
          </button>
        </div>
      </div>

      <!-- Lyrics (shown only in vocal mode) -->
      <div id="ext-lyrics-section" style="display:none">
        <label class="suno-option-label" style="margin-bottom:6px">Continuation lyrics <span style="color:var(--muted);font-weight:400">(optional)</span></label>
        <textarea id="ext-lyrics" class="suno-textarea" rows="3" placeholder="[Verse]&#10;Your next verse or hook here…&#10;Leave blank to auto-generate" style="margin-bottom:12px"></textarea>
      </div>

      <button id="ext-submit-btn" onclick="submitSongExtendUpload()" class="btn btn--primary" style="width:100%;padding:11px;font-size:.9rem;font-weight:700">
        <i class="fas fa-expand-arrows-alt"></i> Extend Track
      </button>
      <div id="ext-submit-status" style="display:none;margin-top:10px;position:relative;border-radius:10px;overflow:hidden;background:#0d0d1a;padding:12px 14px;text-align:center">
        <video class="forge-video-bg" autoplay loop muted playsinline preload="auto" src="/static/forge-bg.mp4" style="opacity:.7"></video>
        <div style="position:absolute;inset:0;background:rgba(5,5,20,.5);border-radius:inherit"></div>
        <span id="ext-submit-status-text" style="position:relative;z-index:2;font-size:.88rem;color:#fff;font-weight:700;text-shadow:0 1px 6px rgba(0,0,0,.8)"></span>
      </div>
    </div>


  </div>
</div>

<!-- One Shot Creator Popup (Pro Artist only) -->
<div id="creator-popup-oneshot" class="creator-popup" style="display:none">
  <div class="creator-popup__header" id="creator-popup-oneshot-header">
    <span class="creator-popup__title"><i class="fas fa-bolt" style="color:#f59e0b"></i> One Shot Creator <span style="font-size:.7rem;opacity:.6;font-weight:400;margin-left:4px">Pro Artist</span></span>
    <button class="creator-popup__close" onclick="closeCreatorPopup('oneshot')"><i class="fas fa-times"></i></button>
  </div>
  <div class="creator-popup__body">

    <p style="color:var(--muted);font-size:.82rem;margin:0 0 14px;line-height:1.5">
      <i class="fas fa-info-circle" style="color:var(--primary);margin-right:5px"></i>
      Describe any sound — StemForge generates it from scratch. Adjust duration to your liking.
      <br/><span style="font-size:.75rem;color:#a78bfa"><i class="fas fa-bolt" style="font-size:.7rem"></i> All your One Shots are saved to your library’s <strong>One Shots</strong> tab.</span>
    </p>

    <!-- Prompt textarea -->
    <div style="margin-bottom:14px">
      <label class="suno-option-label" style="font-size:.8rem;margin-bottom:6px">Describe your sound</label>
      <textarea id="oneshot-sfx-desc" rows="4"
        placeholder="e.g. deep punchy 808 bass hit with sub rumble and distorted tail, trap style&#10;&#10;or: tight snare crack with reverb tail, crisp and bright&#10;&#10;or: vinyl scratch effect, short and sharp"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.88rem;resize:vertical;line-height:1.55"></textarea>
      <p style="color:var(--muted);font-size:.74rem;margin:5px 0 0">The more detail you give, the better the result.</p>
    </div>

    <!-- Duration slider: 0.5s – 8s in 0.5s steps -->
    <div style="margin-bottom:16px">
      <label class="suno-option-label" style="font-size:.8rem;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
        <span>Duration</span>
        <span id="oneshot-dur-label" style="color:var(--primary);font-weight:700;font-size:.85rem">3.0s</span>
      </label>
      <input type="range" id="oneshot-sfx-duration" min="1" max="16" step="1" value="6"
        oninput="(function(v){document.getElementById('oneshot-dur-label').textContent=(v*0.5).toFixed(1)+'s'})(this.value)"
        style="width:100%;accent-color:var(--primary);cursor:pointer;height:4px"/>
      <div style="display:flex;justify-content:space-between;margin-top:4px">
        <span style="font-size:.7rem;color:var(--muted)">0.5s</span>
        <span style="font-size:.7rem;color:var(--muted)">8s</span>
      </div>
    </div>

    <!-- Generate button -->
    <button id="oneshot-sfx-gen-btn" onclick="generateOneshotSfx()" class="btn btn--primary" style="width:100%;padding:11px;font-size:.9rem;font-weight:700">
      <i class="fas fa-bolt"></i> Generate One Shot
    </button>

    <!-- Status -->
    <div id="oneshot-sfx-status" style="display:none;margin-top:12px;text-align:center;padding:12px;background:var(--surface-2,rgba(255,255,255,.04));border-radius:8px">
      <i class="fas fa-spinner fa-spin" style="color:var(--primary);margin-right:6px"></i>
      <span id="oneshot-sfx-status-msg" style="font-size:.85rem;color:var(--muted)">StemForge is crafting your sound…</span>
    </div>

    <!-- Result -->
    <div id="oneshot-sfx-result" style="display:none;margin-top:14px;padding:14px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <i class="fas fa-check-circle" style="color:#10b981;font-size:1.1rem"></i>
        <span id="oneshot-sfx-result-title" style="font-weight:700;font-size:.9rem">One Shot Ready</span>
      </div>
      <audio id="oneshot-sfx-audio" controls style="width:100%;border-radius:8px;margin-bottom:10px"></audio>
      <div style="display:flex;gap:8px">
        <a id="oneshot-sfx-dl-mp3" href="#" class="btn btn--outline btn--sm" style="flex:1;text-align:center" download>
          <i class="fas fa-download"></i> Download WAV
        </a>
      </div>
    </div>

  </div>
</div>

</div><!-- /gs-content--gen -->

`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

// ─── PRICING PAGE ────────────────────────────────────────────────────────────
function pricingPage() {
  return shell('Pricing', `
<main class="inner-page gs-content">
<section class="inner-hero">
  <div class="container">
    <div class="section-tag">Pricing</div>
    <h1>Simple, honest pricing.</h1>
    <p>Start free. Upgrade when you need more depth.</p>
  </div>
</section>
<section class="pricing-full">
  <div class="container">
    <div class="plans-grid plans-grid--full">
      <div class="plan-card" id="pricing-free-plan-card">
        <div id="pricing-free-card-status-top"></div>
        <div class="plan-card__tier">Free</div>
        <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
        <p class="plan-card__desc">Try the engine. No card needed.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 60 points monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full StemForge beat generation</li>
          <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
          <li><i class="fas fa-check"></i> 60 points monthly — free forever</li>
          <li class="muted"><i class="fas fa-times"></i> Downloads</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use rights</li>
          <li class="muted"><i class="fas fa-times"></i> Extend song</li>
          <li class="muted"><i class="fas fa-times"></i> Stem splitting</li>
          <li class="muted"><i class="fas fa-times"></i> Top-up points packs</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full" id="pricing-free-btn">Start free</a>
        <div id="pricing-free-plan-status" style="margin:8px 0 0">
          <div class="pricing-downgrade-note sub-downgrade-pending-banner" id="pricing-free-downgrade" style="display:none">
            <i class="fas fa-clock"></i> <span id="pricing-free-downgrade-msg">Downgrading to Free at end of billing cycle</span>
          </div>
          <button class="btn btn--outline btn--sm" id="pricing-btn-cancel-downgrade-free" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="pricingCancelDowngrade('free')">
            <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
          </button>
        </div>
      </div>
      <div class="plan-card plan-card--featured" id="pricing-creator-plan-card">
        <div id="pricing-creator-card-status-top"></div>
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$10</span><span>/month</span></div>
        <p class="plan-card__desc">For artists, writers, and content creators.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 900 points monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full StemForge beat generation</li>
          <li><i class="fas fa-check"></i> Auto Split — up to 5 stems (30 pts)</li>
          <li><i class="fas fa-check"></i> WAV download — commercial use</li>
          <li><i class="fas fa-check"></i> Top-up point packs available</li>
          <li class="muted"><i class="fas fa-times"></i> Vocals &amp; Instrumental split</li>
          <li class="muted"><i class="fas fa-times"></i> Extend song</li>
          <li class="muted"><i class="fas fa-times"></i> Priority queue</li>
        </ul>
        <button class="btn btn--primary btn--full pricing-plan-btn" data-plan="creator" id="pricing-creator-btn">Start Creator — $10/mo</button>
        <div id="pricing-creator-plan-status" style="margin:8px 0 0">
          <div class="pricing-downgrade-note sub-downgrade-pending-banner" id="pricing-creator-downgrade" style="display:none">
            <i class="fas fa-clock"></i> <span id="pricing-creator-downgrade-msg">Downgrading to Creator at end of billing cycle</span>
          </div>
          <button class="btn btn--outline btn--sm" id="pricing-btn-cancel-downgrade-creator" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="pricingCancelDowngrade('creator')">
            <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
          </button>
        </div>
      </div>
      <div class="plan-card" id="pricing-pro-plan-card">
        <div id="pricing-pro-card-status-top"></div>
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$26</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track clean.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 2,000 points monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Everything in Creator</li>
          <li><i class="fas fa-check"></i> Vocals &amp; Instrumental split</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-expand-arrows-alt" style="font-size:.75rem;opacity:.8"></i> Song Extend</li>
          <li><i class="fas fa-check"></i> Stem download (all modes)</li>
          <li><i class="fas fa-check"></i> Reference track upload</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-wand-magic-sparkles" style="color:#a855f7;font-size:.75rem"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span> — reinvent any beat</li>
          <li><i class="fas fa-check"></i> WAV download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> Priority queue — faster generations</li>
          <li><i class="fas fa-check"></i> Top-up point packs available</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator — StemForge SFX</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-guitar" style="color:#a855f7;font-size:.75rem"></i> AI Cover Song</li>
        </ul>
        <button class="btn btn--outline btn--full pricing-plan-btn" data-plan="pro" id="pricing-pro-btn">Start Pro Artist — $26/mo</button>
        <div id="pricing-pro-plan-status" style="margin:8px 0 0">
          <div class="pricing-downgrade-note sub-downgrade-pending-banner" id="pricing-pro-downgrade" style="display:none">
            <i class="fas fa-clock"></i> <span id="pricing-pro-downgrade-msg">Downgrading to Pro Artist at end of billing cycle</span>
          </div>
          <button class="btn btn--outline btn--sm" id="pricing-btn-cancel-downgrade-pro" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="pricingCancelDowngrade('pro')">
            <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
          </button>
        </div>
      </div>

    </div>

    <div class="credit-table-wrap">
      <div class="section-header">
        <div class="section-tag">What's included</div>
        <h2>Simple, generation-based pricing.</h2>
      </div>
      <div class="credit-table">
        <div class="credit-table__row credit-table__row--header"><span>What you get</span><span>Points cost</span><span>Plan</span></div>
        <div class="credit-table__row"><span><i class="fas fa-music"></i> 1 StemForge beat</span><span class="credit-val">25 pts</span><span class="tier-badge tier-badge--free">All plans</span></div>
        <div class="credit-table__row"><span><i class="fas fa-cut"></i> Auto Split (up to 5 stems)</span><span class="credit-val">30 pts</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-microphone"></i> Vocals &amp; Instrumental</span><span class="credit-val">70 pts</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-expand-arrows-alt"></i> Extend song</span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span></span><span class="credit-val">25 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-upload"></i> Reference track</span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-download"></i> WAV download</span><span class="credit-val">Included</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-bolt" style="color:#f59e0b"></i> One Shot Creator (SFX)</span><span class="credit-val">15 pts</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-guitar" style="color:#a855f7"></i> AI Cover Song</span><span class="credit-val">25 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
      </div>
    </div>

    <div class="faq-wrap">
      <div class="section-header"><div class="section-tag">FAQ</div><h2>Common questions.</h2></div>
      <div class="faq">
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What counts as one generation? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">One generation = one full StemForge beat. StemForge builds the blueprint, generates the instrumental, and delivers your stereo mix — ready to download.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What happens if I run out of points? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">You can purchase point top-up packs from the Subscription page starting from $4.99. Packs are valid for your current billing cycle and stack on top of your plan. Free plan users must upgrade to download tracks.</div></div>
        
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I use the beats commercially? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes — Creator and Pro Artist exports include full commercial use rights. Free plan exports are for personal/demo use only.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Do unused generations roll over? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Unused generations do not roll over. Your count resets on your billing date each month.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I cancel anytime? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes — cancel anytime with no fees. Go to <strong>Account Settings → Subscription</strong> and click <strong>"Cancel Subscription"</strong>. You keep full access to your current plan until the end of your billing period, then your account automatically moves to the Free plan. You can also manage your plan from the <a href="/subscription" style="color:var(--primary)">Subscription page</a>.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>How do I cancel my subscription? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">To cancel: go to <a href="/account" style="color:var(--primary)"><strong>Account Settings</strong></a>, find the <strong>Subscription</strong> section, and click <strong>"Cancel Subscription"</strong>. You'll see a confirmation before anything changes. Your plan stays active until your billing period ends — no charges after that. You can also downgrade to a lower paid plan (Creator or Free) from the <a href="/subscription" style="color:var(--primary)">Subscription page</a> instead of cancelling completely.</div></div>
      </div>
    </div>
  </div>
</section>
</main>

<!-- Pricing page upgrade modal -->
<div id="pricing-upgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px)">
  <div style="background:var(--surface);border:1px solid rgba(108,58,255,.35);border-radius:24px;padding:0;max-width:460px;width:100%;overflow:hidden;box-shadow:0 24px 80px rgba(108,58,255,.2)">
    <div style="background:linear-gradient(135deg,rgba(108,58,255,.18),rgba(168,85,247,.12));border-bottom:1px solid rgba(108,58,255,.2);padding:22px 26px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:11px">
          <div style="width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-bolt" style="color:white;font-size:.85rem"></i>
          </div>
          <div>
            <h3 style="margin:0;font-size:1.1rem;font-weight:700" id="pum-title">Upgrade Plan</h3>
            <p style="margin:0;font-size:.78rem;color:var(--muted)">Instant access — charged now</p>
          </div>
        </div>
        <button onclick="closePricingUpgradeModal()" style="background:none;border:none;color:var(--muted);font-size:1rem;cursor:pointer;padding:4px"><i class="fas fa-times"></i></button>
      </div>
    </div>
    <div id="pum-loading" style="padding:44px;text-align:center">
      <div style="width:34px;height:34px;border:3px solid var(--border);border-top-color:#a855f7;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 14px"></div>
      <p style="color:var(--muted);margin:0;font-size:.88rem">Calculating your proration…</p>
    </div>
    <div id="pum-content" style="display:none;padding:22px 26px">
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px">
        <div style="padding:5px 13px;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:20px;font-size:.83rem;font-weight:600" id="pum-from-label">Free</div>
        <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-right" style="color:white;font-size:.65rem"></i>
        </div>
        <div style="padding:5px 13px;background:linear-gradient(135deg,rgba(108,58,255,.15),rgba(168,85,247,.1));border:1px solid rgba(168,85,247,.4);border-radius:20px;font-size:.83rem;font-weight:700;color:#c084fc" id="pum-to-label">Pro Artist</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:14px">
        <div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;font-weight:600" id="pum-plan-name">Plan</span>
          <span id="pum-new-price" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div id="pum-discount-row" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <div>
            <span style="font-size:.85rem;color:#10b981;font-weight:600"><i class="fas fa-tag" style="margin-right:4px"></i>Unused credit discount</span>
            <div style="font-size:.72rem;color:var(--muted);margin-top:1px" id="pum-discount-note"></div>
          </div>
          <span id="pum-discount-val" style="font-size:.85rem;font-weight:600;color:#10b981">—</span>
        </div>
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,rgba(108,58,255,.12),rgba(168,85,247,.08))">
          <div>
            <span style="font-size:.95rem;font-weight:800">Charged today</span>
            <div style="font-size:.72rem;color:var(--muted);margin-top:1px">Access granted immediately</div>
          </div>
          <span id="pum-charge" style="font-size:1.2rem;font-weight:900;color:#c084fc">—</span>
        </div>
      </div>
      <p id="pum-note" style="font-size:.78rem;color:var(--muted);text-align:center;margin:0 0 18px;line-height:1.5"></p>
      <div style="display:flex;gap:9px">
        <button class="btn btn--outline btn--sm" style="flex:1" onclick="closePricingUpgradeModal()"><i class="fas fa-times"></i> Cancel</button>
        <button class="btn btn--primary btn--sm" style="flex:2;background:linear-gradient(135deg,#6c3aff,#a855f7);border:none" id="pum-confirm-btn" onclick="confirmPricingUpgrade()"><i class="fas fa-bolt"></i> <span id="pum-confirm-label">Confirm &amp; Pay</span></button>
      </div>
    </div>
    <div id="pum-error" style="display:none;padding:32px 26px;text-align:center">
      <i class="fas fa-exclamation-triangle" style="font-size:1.8rem;color:#ef4444;margin-bottom:12px;display:block"></i>
      <p id="pum-error-msg" style="color:var(--muted);margin:0 0 18px;font-size:.88rem;line-height:1.5"></p>
      <button class="btn btn--outline btn--sm" onclick="closePricingUpgradeModal()">Close</button>
    </div>
  </div>
</div>

<!-- Pricing page downgrade modal -->
<div id="pricing-downgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;align-items:center;justify-content:center;padding:16px">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center">
    <i class="fas fa-arrow-down" style="font-size:2rem;color:#ff6464;margin-bottom:16px"></i>
    <h3 style="margin-bottom:8px">Confirm Downgrade</h3>
    <p id="pricing-downgrade-msg" style="color:var(--muted);margin-bottom:8px;line-height:1.5"></p>
    <p style="font-size:.82rem;color:var(--muted);margin-bottom:24px;padding:10px 14px;background:rgba(255,100,100,.08);border:1px solid rgba(255,100,100,.2);border-radius:8px"><i class="fas fa-info-circle" style="color:#ff8080;margin-right:4px"></i>Downgrade takes effect at the end of your current billing cycle. You keep all features until then.</p>
    <div style="display:flex;gap:12px;justify-content:center">
      <button class="btn btn--outline btn--sm" onclick="document.getElementById('pricing-downgrade-modal').style.display='none'">Cancel</button>
      <button class="btn btn--sm" id="pricing-downgrade-confirm" style="background:#ff4444;border:none;color:white">Confirm Downgrade</button>
    </div>
  </div>
</div>

<script>
(function(){
  const rank = { free:0, creator:1, pro:2, developer:3 };
  let _pumPlan = null;
  let _pdgPlan = null;

  // ── Apply Stripe pending state to pricing cards ─────────────────────────────
  function pricingApplyPendingState(pendingState, userPlan) {
    const pd   = (pendingState && pendingState.pendingDowngrade) || null;
    const plan = userPlan || (pendingState && pendingState.plan) || null;

    // ── Helper: set card-level status banner ─────────────────────────────────
    function setPricingCardStatus(cardId, topSlotId, statusType) {
      const card = document.getElementById(cardId);
      const slot = document.getElementById(topSlotId);
      if (!slot) return;
      if (card) card.classList.remove('plan-card--is-current', 'plan-card--is-downgrading');
      if (statusType === 'current') {
        slot.innerHTML = '<div class="plan-card-status-banner plan-card-status-banner--current"><i class="fas fa-check-circle"></i> Your Current Plan</div>';
        if (card) card.classList.add('plan-card--is-current');
      } else if (statusType === 'downgrading') {
        slot.innerHTML = '<div class="plan-card-status-banner plan-card-status-banner--downgrading"><i class="fas fa-arrow-down"></i> Downgrading to this plan</div>';
        if (card) card.classList.add('plan-card--is-downgrading');
      } else {
        slot.innerHTML = '';
      }
    }

    setPricingCardStatus('pricing-free-plan-card',    'pricing-free-card-status-top',    plan === 'free'    ? 'current' : pd === 'free'    ? 'downgrading' : null);
    setPricingCardStatus('pricing-creator-plan-card', 'pricing-creator-card-status-top', plan === 'creator' ? 'current' : pd === 'creator' ? 'downgrading' : null);
    setPricingCardStatus('pricing-pro-plan-card',     'pricing-pro-card-status-top',     plan === 'pro'     ? 'current' : null);

    // ── Free card: show banner+cancel, hide button when pending downgrade = 'free' ──
    const fdEl       = document.getElementById('pricing-free-downgrade');
    const fdMsg      = document.getElementById('pricing-free-downgrade-msg');
    const fdCancel   = document.getElementById('pricing-btn-cancel-downgrade-free');
    const freeBtn    = document.getElementById('pricing-free-btn');
    if (pd === 'free') {
      if (fdMsg) fdMsg.textContent = 'Downgrading to Free at end of billing cycle';
      if (fdEl) fdEl.style.display = 'flex';
      if (fdCancel) fdCancel.style.display = 'inline-flex';
      if (freeBtn) freeBtn.style.display = 'none';
    } else {
      if (fdEl) fdEl.style.display = 'none';
      if (fdCancel) fdCancel.style.display = 'none';
    }

    // ── Creator card: show banner+cancel when pending downgrade = 'creator' (from Pro) ──
    const cdEl  = document.getElementById('pricing-creator-downgrade');
    const cdMsg = document.getElementById('pricing-creator-downgrade-msg');
    const cdCancelBtn = document.getElementById('pricing-btn-cancel-downgrade-creator');
    if (pd === 'creator') {
      if (cdMsg) cdMsg.textContent = 'Downgrading to Creator at end of billing cycle';
      if (cdEl) cdEl.style.display = 'flex';
      if (cdCancelBtn) cdCancelBtn.style.display = 'inline-flex';
    } else {
      if (cdEl) cdEl.style.display = 'none';
      if (cdCancelBtn) cdCancelBtn.style.display = 'none';
    }

    // ── Pro card: show banner+cancel when pro user is downgrading to anything ──
    const pdEl  = document.getElementById('pricing-pro-downgrade');
    const pdMsg = document.getElementById('pricing-pro-downgrade-msg');
    const pdCancelBtn = document.getElementById('pricing-btn-cancel-downgrade-pro');
    if (pd && plan === 'pro') {
      if (pdMsg) pdMsg.textContent = 'Downgrading to ' + (pd === 'creator' ? 'Creator' : 'Free') + ' at end of billing cycle';
      if (pdEl) pdEl.style.display = 'flex';
      if (pdCancelBtn) pdCancelBtn.style.display = 'inline-flex';
    } else {
      if (pdEl) pdEl.style.display = 'none';
      if (pdCancelBtn) pdCancelBtn.style.display = 'none';
    }
  }

  // Cancel downgrade from pricing page card
  window.pricingCancelDowngrade = async function(targetPlan) {
    try {
      const res = await fetch('/api/subscription/cancel-downgrade', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
      });
      const data = await res.json();
      if (data.ok) {
        showSfPlanToast('upgrade', null, 'Downgrade cancelled — your current plan continues.');
        fetch('/api/subscription/pending-state').then(r => r.json()).then(function(state) {
          pricingApplyPendingState(state, null);
        }).catch(function(){});
      } else {
        showSfPlanToast('error', null, data.error || 'Could not cancel downgrade.');
      }
    } catch(e) { showSfPlanToast('error', null, 'Network error. Please try again.'); }
  };

  // Detect current user plan, pending state, and adjust all buttons with locking
  let _pricingUserPlan = null;
  Promise.all([
    fetch('/api/auth/me').then(r => r.json()),
    fetch('/api/subscription/pending-state').then(r => r.json()).catch(() => ({}))
  ]).then(([me, pendingRes]) => {
    const user = me.user;
    if (!user) {
      // Not logged in — wire up buttons for checkout
      document.querySelectorAll('.pricing-plan-btn').forEach(btn => {
        if (!btn.onclick) btn.onclick = () => { window.location.href = '/checkout?plan=' + btn.dataset.plan; };
      });
      return;
    }
    _pricingUserPlan = user.plan;
    const userRank = rank[user.plan] || 0;
    const pd = (pendingRes && pendingRes.pendingDowngrade) || null;
    const pu = (pendingRes && pendingRes.pendingUpgrade)   || null;
    const hasPending = !!(pd || pu);

    // Apply banner/cancel buttons
    pricingApplyPendingState(pendingRes || {}, user.plan);

    // Helper: lock a button
    function lockBtn(btn) {
      btn.innerHTML = '<i class="fas fa-lock" style="font-size:.75rem;margin-right:4px"></i>Cancel pending first';
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
      btn.className = 'btn btn--outline btn--full';
      btn.style.borderColor = 'rgba(255,255,255,.15)';
      btn.style.color = 'var(--muted)';
    }

    const creatorBtn = document.getElementById('pricing-creator-btn');
    const proBtn     = document.getElementById('pricing-pro-btn');
    const freeBtn    = document.getElementById('pricing-free-btn');

    // ── Free button ──
    if (freeBtn) {
      freeBtn.removeAttribute('href');
      if (userRank === 0) {
        freeBtn.textContent = 'Current Plan';
        freeBtn.style.opacity = '.6';
        freeBtn.style.pointerEvents = 'none';
      } else if (pd === 'free') {
        freeBtn.style.display = 'none'; // banner takes its place
      } else if (hasPending) {
        lockBtn(freeBtn);
      } else {
        freeBtn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>Downgrade to Free';
        freeBtn.style.borderColor = 'rgba(255,100,100,.5)';
        freeBtn.style.color = '#ff7070';
        freeBtn.style.cursor = 'pointer';
        freeBtn.onclick = (e) => { e.preventDefault(); openPricingDowngradeModal('free', 'Free ($0/mo — cancel subscription)'); };
      }
    }

    // ── Creator button ──
    if (creatorBtn) {
      const creatorRank = rank['creator'];
      if (userRank === creatorRank) {
        creatorBtn.textContent = 'Current Plan';
        creatorBtn.disabled = true;
        creatorBtn.style.opacity = '.5';
      } else if (pd === 'creator' || pu === 'creator') {
        creatorBtn.style.display = 'none'; // banner takes its place
      } else if (hasPending) {
        lockBtn(creatorBtn);
      } else if (userRank > creatorRank) {
        creatorBtn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>Downgrade to Creator';
        creatorBtn.className = 'btn btn--outline btn--full';
        creatorBtn.style.borderColor = 'rgba(255,100,100,.4)';
        creatorBtn.style.color = '#ff6464';
        creatorBtn.onclick = () => openPricingDowngradeModal('creator', 'Creator ($10/mo)');
      } else {
        creatorBtn.onclick = () => openPricingUpgradeModal('creator');
      }
    }

    // ── Pro button ──
    if (proBtn) {
      const proRank = rank['pro'];
      if (userRank === proRank) {
        proBtn.textContent = 'Current Plan';
        proBtn.disabled = true;
        proBtn.style.opacity = '.5';
      } else if (pd === 'pro' || pu === 'pro') {
        proBtn.style.display = 'none'; // banner takes its place
      } else if (hasPending) {
        lockBtn(proBtn);
      } else if (userRank > proRank) {
        proBtn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>Downgrade to Pro Artist';
        proBtn.className = 'btn btn--outline btn--full';
        proBtn.style.borderColor = 'rgba(255,100,100,.4)';
        proBtn.style.color = '#ff6464';
        proBtn.onclick = () => openPricingDowngradeModal('pro', 'Pro Artist ($26/mo)');
      } else {
        proBtn.onclick = () => openPricingUpgradeModal('pro');
      }
    }
  }).catch(() => {
    // Auth failed — wire up buttons for non-logged-in (go straight to checkout)
    document.querySelectorAll('.pricing-plan-btn').forEach(btn => {
      if (!btn.onclick) btn.onclick = () => { window.location.href = '/checkout?plan=' + btn.dataset.plan; };
    });
  });

  // ── Upgrade modal (Suno-style) ──────────────────────────────────────────────
  function openPricingUpgradeModal(plan) {
    _pumPlan = plan;
    const modal = document.getElementById('pricing-upgrade-modal');
    modal.style.display = 'flex';
    document.getElementById('pum-loading').style.display = 'block';
    document.getElementById('pum-content').style.display = 'none';
    document.getElementById('pum-error').style.display   = 'none';
    fetch('/api/subscription/upgrade-preview?plan=' + encodeURIComponent(plan))
      .then(r => r.json())
      .then(data => {
        if (data.error) { showPumError(data.error); return; }
        const targetLabel       = data.target_plan_label || plan;
        const newPriceCents     = data.new_price_cents     || 0;
        const currentPriceCents = data.current_price_cents || 0;
        const proratedCents     = data.proration_cents     || newPriceCents;
        const discountCents     = Math.max(0, newPriceCents - proratedCents);
        const hasRealSub = data.has_subscription &&
          data.days_remaining != null && !isNaN(data.days_remaining) &&
          data.days_in_period != null && !isNaN(data.days_in_period);
        const chargeLabel = '$' + (proratedCents / 100).toFixed(2);
        // Pill labels
        document.getElementById('pum-from-label').textContent = data.current_plan_label || 'Free';
        document.getElementById('pum-to-label').textContent   = targetLabel;
        document.getElementById('pum-title').textContent      = 'Upgrade to ' + targetLabel;
        // Price row
        document.getElementById('pum-plan-name').textContent  = targetLabel;
        document.getElementById('pum-new-price').textContent  = '$' + (newPriceCents / 100).toFixed(2);
        // Discount row
        const discountRow = document.getElementById('pum-discount-row');
        if (hasRealSub && discountCents > 0 && currentPriceCents > 0) {
          discountRow.style.display = 'flex';
          document.getElementById('pum-discount-val').textContent  = '−$' + (discountCents / 100).toFixed(2);
          document.getElementById('pum-discount-note').textContent = data.days_remaining + ' days left on ' + (data.current_plan_label || 'current plan');
        } else {
          discountRow.style.display = 'none';
        }
        // Charge today
        document.getElementById('pum-charge').textContent = chargeLabel;
        // Renewal note
        const noteEl = document.getElementById('pum-note');
        if (hasRealSub && data.period_end_label) {
          noteEl.textContent = 'Then ' + (data.new_price_label||'') + ' starting ' + data.period_end_label + '. Cancel anytime.';
        } else {
          noteEl.textContent = 'Billed monthly at ' + (data.new_price_label||'') + '. Cancel anytime.';
        }
        document.getElementById('pum-confirm-label').textContent = 'Confirm & Pay ' + chargeLabel;
        document.getElementById('pum-loading').style.display = 'none';
        document.getElementById('pum-content').style.display = 'block';
      })
      .catch(() => showPumError('Network error. Please try again.'));
  }

  function showPumError(msg) {
    document.getElementById('pum-loading').style.display = 'none';
    document.getElementById('pum-content').style.display = 'none';
    document.getElementById('pum-error-msg').textContent = msg;
    document.getElementById('pum-error').style.display   = 'block';
  }

  window.closePricingUpgradeModal = function() {
    document.getElementById('pricing-upgrade-modal').style.display = 'none';
    _pumPlan = null;
  };

  window.confirmPricingUpgrade = async function() {
    if (!_pumPlan) return;
    const btn = document.getElementById('pum-confirm-btn');
    btn.disabled = true;
    document.getElementById('pum-confirm-label').textContent = 'Processing…';
    try {
      const res = await fetch('/api/subscription/upgrade', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ target_plan: _pumPlan })
      });
      const data = await res.json();
      closePricingUpgradeModal();
      if (data.redirect) { window.location.href = data.redirect; return; }
      if (data.ok) { showSfPlanToast('upgrade', _pumPlan); setTimeout(function(){ window.location.href = '/dashboard'; }, 2200); }
      else { showSfPlanToast('error', null, data.error || 'Upgrade failed'); }
    } catch(e) { closePricingUpgradeModal(); showSfPlanToast('error', null, 'Network error. Please try again.'); }
  };

  document.getElementById('pricing-upgrade-modal').addEventListener('click', function(e) { if (e.target === this) closePricingUpgradeModal(); });

  // ── Downgrade modal ─────────────────────────────────────────────────────────
  function openPricingDowngradeModal(plan, label) {
    _pdgPlan = plan;
    const msg = plan === 'free'
      ? 'Your subscription will be cancelled. You will move to the Free plan after your billing cycle ends.'
      : plan === 'creator'
        ? 'You will be downgraded to the Creator plan ($10/mo, 900 points/mo) at the end of your current billing cycle.'
        : 'You will be switched to Pro Artist ($26/mo, 2,000 points/mo) at end of your billing cycle.';
    document.getElementById('pricing-downgrade-msg').textContent = msg;
    document.getElementById('pricing-downgrade-modal').style.display = 'flex';
  }

  window.confirmPricingDowngrade = async function() {
    if (!_pdgPlan) return;
    const btn = document.getElementById('pricing-downgrade-confirm');
    btn.disabled = true; btn.textContent = 'Processing…';
    try {
      const res = await fetch('/api/subscription/downgrade', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ target_plan: _pdgPlan })
      });
      const data = await res.json();
      document.getElementById('pricing-downgrade-modal').style.display = 'none';
      if (data.ok) { showSfPlanToast('downgrade', _pdgPlan); window.location.reload(); }
      else { showSfPlanToast('error', null, data.error || 'Downgrade failed'); }
    } catch(e) { showSfPlanToast('error', null, 'Network error. Please try again.'); }
    finally { btn.disabled = false; btn.textContent = 'Confirm Downgrade'; }
  };

  document.getElementById('pricing-downgrade-confirm').addEventListener('click', confirmPricingDowngrade);
  document.getElementById('pricing-downgrade-modal').addEventListener('click', function(e) { if (e.target === this) this.style.display='none'; });

  // FAQ accordion
  document.querySelectorAll('[data-faq-button]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('[data-faq]');
      item.classList.toggle('open');
    });
  });
})();
</script>
`)
}

// ─── REMAINING PAGES (Dashboard, Project, Auth) ───────────────────────────────
function dashboardPage() {
  return shell('Dashboard', `
<main class="inner-page gs-content">
  <div class="dash-header">
    <h2>Library</h2>
    <a href="/generator" class="btn btn--primary"><i class="fas fa-plus"></i> New beat</a>
  </div>

  <!-- Library tabs -->
  <div class="lib-tabs" id="lib-tabs">
    <button class="lib-tab lib-tab--beats lib-tab--active" data-tab="beats" onclick="switchLibTab('beats')">
      <i class="fas fa-music"></i> Beats / Songs
    </button>
    <button class="lib-tab lib-tab--remixes" data-tab="remixes" onclick="switchLibTab('remixes')">
      <i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc">Remixes</span>
    </button>
    <button class="lib-tab lib-tab--extended" data-tab="extended" onclick="switchLibTab('extended')">
      <i class="fas fa-expand-arrows-alt" style="color:#22d3ee"></i> <span style="color:#22d3ee">Extended</span>
    </button>
    <button class="lib-tab lib-tab--oneshots" data-tab="oneshots" id="lib-tab-oneshots" onclick="switchLibTab('oneshots')">
      <i class="fas fa-bolt" style="color:#f59e0b"></i> <span style="color:#f59e0b">One Shots</span>
    </button>
    <button class="lib-tab lib-tab--covers" data-tab="covers" onclick="switchLibTab('covers')">
      <i class="fas fa-microphone-alt" style="color:#f472b6"></i> <span style="color:#f472b6">Covers</span>
    </button>
    <button class="lib-tab lib-tab--trash" data-tab="trash" onclick="switchLibTab('trash')">
      <i class="fas fa-trash-alt"></i> Trash
    </button>
  </div>

  <!-- Search bar (shared, updates with active tab) -->
  <div class="lib-search-wrap" id="lib-search-wrap">
    <i class="fas fa-search lib-search-icon"></i>
    <input type="text" id="lib-search" class="lib-search-input" placeholder="Search beats…" oninput="filterLibrary(this.value)"/>
    <button class="lib-search-clear" id="lib-search-clear" onclick="document.getElementById('lib-search').value='';filterLibrary('')" style="display:none">
      <i class="fas fa-times"></i>
    </button>
  </div>

  <!-- Grid per tab -->
  <div id="lib-panel-beats">
    <div class="project-grid" id="project-grid-beats">
      <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
    </div>
  </div>
  <div id="lib-panel-remixes" style="display:none">
    <div style="padding:10px 0 4px;font-size:.82rem;color:var(--muted);display:flex;align-items:center;gap:6px">
      <i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc">Tracks you've remixed using AI Remix.</span>
    </div>
    <div class="project-grid" id="project-grid-remixes">
      <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
    </div>
  </div>
  <div id="lib-panel-extended" style="display:none">
    <div style="padding:10px 0 4px;font-size:.82rem;color:var(--muted);display:flex;align-items:center;gap:6px">
      <i class="fas fa-expand-arrows-alt" style="color:var(--primary)"></i> Tracks you've extended using the Song Extend feature.
    </div>
    <div class="project-grid" id="project-grid-extended">
      <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
    </div>
  </div>
  <div id="lib-panel-oneshots" style="display:none">
    <div class="project-grid" id="project-grid-oneshots">
      <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
    </div>
  </div>
  <div id="lib-panel-covers" style="display:none">
    <div style="padding:10px 0 4px;font-size:.82rem;color:var(--muted);display:flex;align-items:center;gap:6px">
      <i class="fas fa-microphone-alt" style="color:#a855f7"></i>
      <span style="color:#c084fc">AI Cover Songs you've created using the Cover Song feature.</span>
    </div>
    <div class="project-grid" id="project-grid-covers">
      <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
    </div>
  </div>
  <div id="lib-panel-trash" style="display:none">
    <div style="padding:12px 0 4px;font-size:.82rem;color:var(--muted);display:flex;align-items:center;gap:6px">
      <i class="fas fa-info-circle"></i> Items are permanently deleted after 60 days in Trash.
    </div>
    <div class="project-grid" id="project-grid-trash">
      <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
    </div>
  </div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

function projectPage() {
  return shell('Project Export', `
<main class="inner-page gs-content">
<div style="display:none" class="app-sidebar app-sidebar--dash">
  <nav class="dash-nav"><a href="/dashboard" class="dash-nav__item"><i class="fas fa-arrow-left"></i> Back</a></nav>
  <div class="project-meta-card"><div class="project-meta-card__art project-card__art--1"></div><h4>Surf Noir Trap</h4><p>90 BPM · D Minor · 2:14</p><div class="project-meta-card__plan plan-badge plan-badge--creator">Creator plan</div></div>
  <div class="dash-credits-card" style="margin-top:16px"><div class="dash-credits-card__label">Generations used</div><div class="dash-credits-card__val">32 <small>/ 50 points</small></div><a href="/pricing" class="btn btn--primary btn--sm btn--full" style="margin-top:8px">Upgrade plan</a></div>
</div>
<div class="app-main">
  <div class="dash-header"><h2>Surf Noir Trap <span class="dash-header__sub">Export</span></h2></div>
  <div class="export-tier-grid">
    <div class="export-tier-card export-tier-card--available"><div class="export-tier-card__icon"><i class="fas fa-file-audio"></i></div><div class="export-tier-card__body"><h4>Stereo mix</h4><p>Full stereo bounce.</p><span class="credit-tag">Free</span></div><button class="btn btn--primary btn--sm"><i class="fas fa-download"></i> Download</button></div>
    
  </div>
</div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

function signupPage() {
  return shell('Create your account', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo"><img src="/static/stemforge-logo.png" alt="StemForge" style="height:30px;width:30px;object-fit:contain;flex-shrink:0"/><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <h1>Start generating.<br/>Keep every track.</h1>
      <ul class="auth-benefits">
        <li><i class="fas fa-check-circle"></i> 3 free generations, no card needed</li>
        <li><i class="fas fa-check-circle"></i> Real StemForge beat generation</li>
        <li><i class="fas fa-check-circle"></i> Commercial use rights</li>
        <li><i class="fas fa-check-circle"></i> Cancel anytime</li>
      </ul>
    </div>
    <div class="auth-split__right">
      <div class="auth-card">
        <h2>Create your account</h2>
        <p class="auth-card__sub">Already have one? <a href="/login">Log in</a></p>
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div class="oauth-btns">
          <a href="/api/auth/google" class="oauth-btn oauth-btn--google" onclick="(function(){fetch('/api/track/signup-click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_type:'google',page:'signup',referrer:document.referrer||''})}).catch(function(){});})();"><i class="fab fa-google"></i> Continue with Google</a>
        </div>
        <div class="auth-divider"><span>or</span></div>
        <a href="/register" class="btn btn--outline btn--full btn--lg" style="margin-top:8px" onclick="(function(){fetch('/api/track/signup-click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_type:'email',page:'signup',referrer:document.referrer||''})}).catch(function(){});})();">
          <i class="fas fa-envelope"></i> Sign up with email
        </a>
        <p class="auth-card__sub" style="margin-top:20px;font-size:13px">By continuing you agree to our <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy Policy</a>.</p>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

function registerPage() {
  return shell('Create account', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo"><img src="/static/stemforge-logo.png" alt="StemForge" style="height:30px;width:30px;object-fit:contain;flex-shrink:0"/><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <h1>Start generating.<br/>Keep every track.</h1>
      <ul class="auth-benefits">
        <li><i class="fas fa-check-circle"></i> 3 free generations, no card needed</li>
        <li><i class="fas fa-check-circle"></i> Real StemForge beat generation</li>
        <li><i class="fas fa-check-circle"></i> Commercial use rights</li>
        <li><i class="fas fa-check-circle"></i> Cancel anytime</li>
      </ul>
    </div>
    <div class="auth-split__right">
      <div class="auth-card">
        <h2>Create your account</h2>
        <p class="auth-card__sub">Already have one? <a href="/login">Log in</a> · <a href="/signup">Other options</a></p>
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <form class="auth-form" id="signup-form" novalidate>
          <div class="form-group">
            <label for="su-name">Full name</label>
            <input id="su-name" type="text" name="name" placeholder="Your name" autocomplete="name" required/>
          </div>
          <div class="form-group">
            <label for="su-email">Email</label>
            <input id="su-email" type="email" name="email" placeholder="you@example.com" autocomplete="email" required/>
          </div>
          <div class="form-group">
            <label for="pw-input">Password</label>
            <div class="input-icon-wrap">
              <input id="pw-input" type="password" name="password" placeholder="At least 8 characters" autocomplete="new-password" required minlength="8"/>
              <button type="button" class="input-icon-btn" id="pw-toggle"><i class="fas fa-eye" id="pw-eye"></i></button>
            </div>
            <div class="pw-strength" id="pw-strength"></div>
          </div>
          <div class="form-group">
            <label>Plan</label>
            <div class="plan-radio-group">
              <label class="plan-radio"><input type="radio" name="plan" value="free" checked/><span>Free — $0</span></label>
              <label class="plan-radio"><input type="radio" name="plan" value="creator"/><span>Creator — $10/mo</span></label>
              <label class="plan-radio"><input type="radio" name="plan" value="pro"/><span>Pro Artist — $26/mo</span></label>
            </div>
          </div>
          <div class="form-group form-group--check">
            <label class="checkbox-label"><input type="checkbox" id="su-terms" required/> I agree to the <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a></label>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="signup-btn">
            Create account <i class="fas fa-arrow-right"></i>
          </button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

function loginPage(next = '') {
  const googleHref = next ? `/api/auth/google?next=${encodeURIComponent(next)}` : '/api/auth/google'
  const nextField = next ? `<input type="hidden" name="next" value="${next.replace(/"/g,'&quot;')}"/>` : ''
  return shell('Log in', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo"><img src="/static/stemforge-logo.png" alt="StemForge" style="height:30px;width:30px;object-fit:contain;flex-shrink:0"/><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <h1>Welcome back.<br/>Your tracks are waiting.</h1>
      <ul class="auth-benefits">
        <li><i class="fas fa-check-circle"></i> Access all your projects</li>
        <li><i class="fas fa-check-circle"></i> Download your exports</li>
        <li><i class="fas fa-check-circle"></i> Continue generating</li>
      </ul>
    </div>
    <div class="auth-split__right">
      <div class="auth-card">
        <h2>Log in</h2>
        <p class="auth-card__sub">Don't have an account? <a href="/signup">Sign up free</a></p>
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div class="oauth-btns">
          <a href="${googleHref}" class="oauth-btn oauth-btn--google" onclick="(function(){fetch('/api/track/signup-click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_type:'google',page:'login',referrer:document.referrer||''})}).catch(function(){});})();"><i class="fab fa-google"></i> Continue with Google</a>
        <form class="auth-form" id="login-form" novalidate>
        ${nextField}
          <div class="form-group">
            <label for="li-email">Email</label>
            <input id="li-email" type="email" name="email" placeholder="you@example.com" autocomplete="email" required/>
          </div>
          <div class="form-group">
            <label for="pw-input">Password</label>
            <div class="input-icon-wrap">
              <input id="pw-input" type="password" name="password" placeholder="Your password" autocomplete="current-password" required/>
              <button type="button" class="input-icon-btn" id="pw-toggle"><i class="fas fa-eye" id="pw-eye"></i></button>
            </div>
            <div class="form-group__hint"><a href="#">Forgot password?</a></div>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="login-btn">
            Log in <i class="fas fa-arrow-right"></i>
          </button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

function checkoutPage() {
  // Plan details for display — frontend JS reads ?plan= from URL
  return shell('Checkout', `
<main class="auth-page">
  <div class="checkout-wrap">
    <div class="checkout-left">
      <a href="/" class="sf-nav__logo auth-logo" style="margin-bottom:32px;display:inline-flex">
        <img src="/static/stemforge-logo.png" alt="StemForge" style="height:30px;width:30px;object-fit:contain;flex-shrink:0"/><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <div class="checkout-plan-summary" id="co-plan-summary">
        <div class="checkout-plan-summary__header">
          <div><h3 id="co-plan-name">Creator Plan</h3><p>Billed monthly · Cancel anytime</p></div>
          <div class="checkout-plan-summary__price"><span id="co-plan-price">$10</span><span>/mo</span></div>
        </div>
        <ul class="checkout-plan-summary__features" id="co-plan-features">
          <li><i class="fas fa-check"></i> 900 points monthly</li>
          <li><i class="fas fa-check"></i> Auto Split — up to 5 stems</li>
          <li><i class="fas fa-check"></i> WAV download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator (SFX)</li>
        </ul>
        <div class="checkout-plan-summary__total"><span>Total today</span><strong id="co-plan-total">$10.00</strong></div>
      </div>
      <div class="checkout-trust">
        <span><i class="fas fa-lock"></i> Secure checkout</span>
        <span><i class="fas fa-shield-alt"></i> SSL encrypted</span>
        <span><i class="fas fa-undo"></i> Cancel anytime</span>
        <span><i class="fab fa-stripe"></i> Powered by Stripe</span>
      </div>
    </div>
    <div class="checkout-right">
      <div class="auth-card">
        <h2>Subscribe to StemForge</h2>
        <p class="auth-card__sub">You'll be taken to Stripe's secure checkout.</p>
        <div id="co-error" class="auth-error" style="display:none"></div>
        <div class="checkout-stripe-info">
          <div class="stripe-badge"><i class="fab fa-stripe-s"></i><span>Payment processed by Stripe — your card info never touches our servers.</span></div>
        </div>
        <button class="btn btn--primary btn--full btn--lg" id="checkout-submit" style="margin-top:24px">
          <i class="fas fa-lock"></i> <span id="co-btn-text">Continue to payment — $10/mo</span>
        </button>
        <p class="auth-card__sub" style="margin-top:16px;font-size:13px">
          Not ready to pay? <a href="/signup">Try free</a>
        </p>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

// ─── PROFILE PAGE ────────────────────────────────────────────────────────────
function profilePage(user: User | null) {
  if (!user) {
    return shell('Profile', `<main class="inner-page gs-content"><div class="container" style="text-align:center;padding:80px 20px">
      <h2>Sign in to view your profile</h2>
      <a href="/login" class="btn btn--primary" style="margin-top:20px">Log in</a>
    </div></main>`)
  }
  const initials = user.name.split(' ').map((n:string)=>n[0]).join('').toUpperCase().slice(0,2)
  const planLabel = user.plan === 'pro' ? 'Pro Artist' : user.plan === 'creator' ? 'Creator' : 'Free'
  const planClass = user.plan === 'pro' ? 'plan-badge--pro' : user.plan === 'creator' ? 'plan-badge--creator' : ''
  const memberSince = new Date(user.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long'})
  const coverPos   = (user as any).cover_position  || '50% 50%'
  const avatarPos   = (user as any).avatar_position || '50% 50%'
  const coverStyle  = user.cover_image
    ? `background-image:url('${user.cover_image}');background-size:cover;background-position:${coverPos};`
    : ''

  return shell('Profile', `
<main class="inner-page gs-content profile-page">
  <div class="container">
    <div class="profile-wrap">

      <!-- ── Cover / Banner ── -->
      <div class="profile-cover" id="profileCover" style="${coverStyle}">
        <button class="profile-cover-edit-btn" onclick="triggerCoverPick()" title="Change cover photo">
          <i class="fas fa-camera"></i> Change cover
        </button>
        <input type="file" id="coverFileInput" accept="image/*" style="display:none" onchange="previewCover(this)">
      </div>

      <div class="profile-body">
        <!-- ── Avatar ── -->
        <div class="profile-avatar-wrap">
          ${user.avatar
            ? `<img src="${user.avatar}" class="profile-avatar" id="profileAvatarImg" alt="${user.name}" style="object-position:${avatarPos}"/>`
            : `<div class="profile-avatar profile-avatar--initials" id="profileAvatarImg">${initials}</div>`
          }
        </div>

        <div class="profile-info">
          <div class="profile-info__top">
            <div>
              <h1 class="profile-name" id="profileNameDisplay">${user.name}</h1>
              <p class="profile-handle">@${user.email.split('@')[0]}</p>
            </div>
            <div class="profile-actions">
              <span class="plan-badge ${planClass}">${planLabel}</span>
              <button class="btn btn--outline btn--sm" onclick="openProfileModal()">
                <i class="fas fa-pencil-alt"></i> Edit
              </button>
            </div>
          </div>

          <!-- ── Stats — Member since only ── -->
          <div class="profile-stats">
            <div class="profile-stat">
              <span class="profile-stat__val">${memberSince}</span>
              <span class="profile-stat__label">Member since</span>
            </div>
          </div>
        </div>

        <div class="profile-section">
          <h3>Quick links</h3>
          <div class="profile-links">
            <a href="/dashboard" class="profile-link-card"><i class="fas fa-th-large"></i><span>Library</span></a>
            <a href="/generator" class="profile-link-card"><i class="fas fa-play-circle"></i><span>New Beat</span></a>
            <a href="/subscription" class="profile-link-card"><i class="fas fa-credit-card"></i><span>Subscription</span></a>
            <a href="/account" class="profile-link-card"><i class="fas fa-cog"></i><span>Settings</span></a>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>

<!-- ══════════════════════════════════════════════════════════
     PROFILE EDIT MODAL
══════════════════════════════════════════════════════════ -->
<div id="profileEditModal" class="pedit-overlay" style="display:none" onclick="closeProfileModal(event)">
  <div class="pedit-modal" role="dialog" aria-modal="true" aria-label="Edit profile">

    <div class="pedit-header">
      <h2 class="pedit-title">Edit Profile</h2>
      <button class="pedit-close" onclick="closeProfileModalDirect()" aria-label="Close">&times;</button>
    </div>

    <!-- Cover image preview inside modal -->
    <div class="pedit-cover-row">
      <label class="pedit-label">Cover Photo</label>
      <div class="pedit-cover-preview" id="modalCoverPreview" style="${coverStyle}">
        <button type="button" class="pedit-cover-pick-btn" onclick="triggerCoverPick()">
          <i class="fas fa-camera"></i>
          <span>${user.cover_image ? 'Change photo' : 'Add cover photo'}</span>
        </button>
      </div>
    </div>

    <!-- Avatar preview inside modal -->
    <div class="pedit-avatar-row">
      <label class="pedit-label">Profile Picture</label>
      <div class="pedit-avatar-preview-wrap">
        <div class="pedit-avatar-preview" id="modalAvatarPreview">
          ${user.avatar
            ? `<img src="${user.avatar}" id="modalAvatarImg" alt="avatar"/>`
            : `<div class="pedit-avatar-initials" id="modalAvatarImg">${initials}</div>`
          }
        </div>
        <button type="button" class="btn btn--outline btn--sm" onclick="triggerAvatarPick()">
          <i class="fas fa-upload"></i> Upload photo
        </button>
      </div>
      <input type="file" id="avatarFileInput" accept="image/*" style="display:none" onchange="previewAvatar(this)">
    </div>

    <!-- Name field -->
    <div class="pedit-field-row">
      <label class="pedit-label" for="peditNameInput">Display Name</label>
      <input class="pedit-input" id="peditNameInput" type="text"
             value="${user.name.replace(/"/g, '&quot;')}" maxlength="60" placeholder="Your name">
    </div>

    <div id="peditError" class="pedit-error" style="display:none"></div>

    <div class="pedit-actions">
      <button class="btn btn--ghost" onclick="closeProfileModalDirect()">Cancel</button>
      <button class="btn btn--primary" id="peditSaveBtn" onclick="saveProfile()">
        <i class="fas fa-check"></i> Save changes
      </button>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     DRAG-TO-REPOSITION OVERLAY  (shared for cover + avatar)
══════════════════════════════════════════════════════════ -->
<div id="dragReposOverlay" style="display:none">
  <div class="drepos-backdrop"></div>
  <div class="drepos-panel">

    <div class="drepos-header">
      <span class="drepos-title" id="dreposTitle">Position photo</span>
      <div class="drepos-hints">
        <span class="drepos-hint-drag"><i class="fas fa-arrows-alt"></i> Drag to reposition</span>
        <span class="drepos-centre-pill" id="dreposCentrePill" style="display:none">
          <i class="fas fa-crosshairs"></i> Centred
        </span>
      </div>
    </div>

    <!--
      Stage layout:
        • .drepos-stage-wrap  — the full scrollable canvas (bigger than the crop window)
        • #dreposStage        — same size as stage-wrap, holds the image + overlays
        • #dreposImg          — the actual photo, translated by drag
        • .drepos-vignette    — four dim panels outside the crop frame (top/bottom/left/right)
        • #dreposFrame        — the bright crop window border
        • .drepos-crosshair-h / -v — centre snap lines, visible only when snapped
    -->
    <div class="drepos-stage-wrap" id="dreposStageWrap">
      <div class="drepos-stage" id="dreposStage">
        <img id="dreposImg" src="" alt="" draggable="false">

        <!-- Vignette panels dim the out-of-crop area -->
        <div class="drepos-vig drepos-vig--top"    id="dreposVigTop"></div>
        <div class="drepos-vig drepos-vig--bottom" id="dreposVigBottom"></div>
        <div class="drepos-vig drepos-vig--left"   id="dreposVigLeft"></div>
        <div class="drepos-vig drepos-vig--right"  id="dreposVigRight"></div>

        <!-- Crop-window border -->
        <div class="drepos-frame" id="dreposFrame">
          <!-- Rule-of-thirds grid lines inside crop window -->
          <div class="drepos-thirds"></div>
        </div>

        <!-- Centre-snap crosshair lines (shown briefly when centred) -->
        <div class="drepos-snap-h" id="dreposSnapH"></div>
        <div class="drepos-snap-v" id="dreposSnapV"></div>
      </div>
    </div>

    <div class="drepos-actions">
      <button class="btn btn--ghost" onclick="cancelRepos()">Cancel</button>
      <button class="btn btn--primary" onclick="confirmRepos()"><i class="fas fa-check"></i> Use this position</button>
    </div>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════════════════════════
//  PROFILE EDIT — state
// ═══════════════════════════════════════════════════════════════════════════
let _pendingAvatarFile = null
let _pendingCoverFile  = null
let _avatarPosition    = '${user.avatar_position || '50% 50%'}'
let _coverPosition     = '${user.cover_position  || '50% 50%'}'

// ── Drag-repositioner state ──────────────────────────────────────────────
let _dreposTarget  = null   // 'cover' | 'avatar'
let _dreposFile    = null
let _dreposObjUrl  = null
let _dragging      = false
let _dragStartX    = 0, _dragStartY = 0
let _imgOffX       = 0, _imgOffY    = 0
let _imgW = 0, _imgH = 0, _stageW = 0, _stageH = 0
let _frameX = 0, _frameY = 0, _frameW = 0, _frameH = 0  // crop window inside stage
let _centreSnapTimer = null

// ═══════════════════════════════════════════════════════════════════════════
//  MODAL open / close
// ═══════════════════════════════════════════════════════════════════════════
function openProfileModal() {
  document.getElementById('profileEditModal').style.display = 'flex'
  document.body.style.overflow = 'hidden'
}
function closeProfileModal(e) {
  if (e.target === document.getElementById('profileEditModal')) closeProfileModalDirect()
}
function closeProfileModalDirect() {
  document.getElementById('profileEditModal').style.display = 'none'
  document.body.style.overflow = ''
}

// ═══════════════════════════════════════════════════════════════════════════
//  FILE PICK triggers
// ═══════════════════════════════════════════════════════════════════════════
function triggerAvatarPick() { document.getElementById('avatarFileInput').click() }
function triggerCoverPick()  { document.getElementById('coverFileInput').click()  }

function previewAvatar(input) {
  const file = input.files[0]; if (!file) return
  openReposOverlay('avatar', file)
  input.value = ''   // reset so same file can be re-picked
}
function previewCover(input) {
  const file = input.files[0]; if (!file) return
  openReposOverlay('cover', file)
  input.value = ''
}

// ═══════════════════════════════════════════════════════════════════════════
//  DRAG-TO-REPOSITION  overlay
// ═══════════════════════════════════════════════════════════════════════════
function openReposOverlay(target, file) {
  _dreposTarget = target
  _dreposFile   = file
  if (_dreposObjUrl) URL.revokeObjectURL(_dreposObjUrl)
  _dreposObjUrl = URL.createObjectURL(file)

  const overlay = document.getElementById('dragReposOverlay')
  const title   = document.getElementById('dreposTitle')
  title.textContent = target === 'cover' ? 'Position cover photo' : 'Position profile picture'

  // ── Show overlay FIRST so the browser lays it out and offsetWidth is real ──
  overlay.style.display = 'flex'
  document.body.style.overflow = 'hidden'

  // Use rAF × 2 to guarantee the browser has painted and dimensions are available
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      _initReposStage(target)
    })
  })

  // Attach drag listeners immediately (safe — they just set _dragging)
  const s = document.getElementById('dreposStage')
  s.addEventListener('mousedown',  onDragStart)
  s.addEventListener('touchstart', onDragStart, { passive: false })
  window.addEventListener('mousemove',  onDragMove)
  window.addEventListener('touchmove',  onDragMove, { passive: false })
  window.addEventListener('mouseup',   onDragEnd)
  window.addEventListener('touchend',  onDragEnd)
}

// ── Called after overlay is visible so offsetWidth/Height are real ────────────
function _initReposStage(target) {
  const img   = document.getElementById('dreposImg')
  const frame = document.getElementById('dreposFrame')
  const stage = document.getElementById('dreposStage')

  _stageW = stage.offsetWidth
  _stageH = stage.offsetHeight

  // Guard: if stage still has no size, retry once more after 50ms
  if (_stageW === 0 || _stageH === 0) {
    setTimeout(function() { _initReposStage(target) }, 50)
    return
  }

  // ── Set crop-frame dimensions ──────────────────────────────────────────────
  if (target === 'cover') {
    // Match real banner aspect ratio (~5:1 wide)
    const fW = Math.round(_stageW * 0.84)
    const fH = Math.round(fW * 0.21)
    const fX = Math.round((_stageW - fW) / 2)
    const fY = Math.round((_stageH - fH) / 2)
    _frameX = fX; _frameY = fY; _frameW = fW; _frameH = fH
    frame.style.borderRadius = '4px'
    frame.style.width  = fW + 'px'
    frame.style.height = fH + 'px'
    frame.style.left   = fX + 'px'
    frame.style.top    = fY + 'px'
  } else {
    // Circle crop for avatar
    const sz = Math.round(Math.min(_stageW, _stageH) * 0.58)
    const fX = Math.round((_stageW - sz) / 2)
    const fY = Math.round((_stageH - sz) / 2)
    _frameX = fX; _frameY = fY; _frameW = sz; _frameH = sz
    frame.style.borderRadius = '50%'
    frame.style.width  = sz + 'px'
    frame.style.height = sz + 'px'
    frame.style.left   = fX + 'px'
    frame.style.top    = fY + 'px'
  }

  updateVignette()

  // Position snap crosshair lines at frame centre
  const snapH = document.getElementById('dreposSnapH')
  const snapV = document.getElementById('dreposSnapV')
  if (snapH) snapH.style.top  = (_frameY + _frameH / 2) + 'px'
  if (snapV) snapV.style.left = (_frameX + _frameW / 2) + 'px'

  // ── Load the image — onload fires after layout is ready ───────────────────
  img.onload = function() {
    const natW = img.naturalWidth
    const natH = img.naturalHeight

    // Scale so image fills the crop frame + 40% extra room to drag
    const scale = Math.max(_frameW / natW, _frameH / natH) * 1.4
    _imgW = Math.round(natW * scale)
    _imgH = Math.round(natH * scale)
    img.style.width  = _imgW + 'px'
    img.style.height = _imgH + 'px'
    img.style.opacity = '1'

    // Centre over frame
    _imgOffX = _frameX + Math.round((_frameW - _imgW) / 2)
    _imgOffY = _frameY + Math.round((_frameH - _imgH) / 2)
    clampAndApplyOffset(true)
  }
  img.style.opacity = '0'   // hide until sized correctly
  img.src = _dreposObjUrl
}

function cancelRepos() {
  closeReposOverlay()
}

function confirmRepos() {
  // Convert pixel drag offset → CSS background-position / object-position %
  // The "range" is how far the image can travel while still covering the frame.
  // minOff = frame_start + frame_size - img_size  (image pushed as far right/down as possible)
  // maxOff = frame_start                          (image pushed as far left/up as possible)
  const minOffX = _frameX + _frameW - _imgW
  const maxOffX = _frameX
  const minOffY = _frameY + _frameH - _imgH
  const maxOffY = _frameY
  const rangeX  = minOffX - maxOffX   // negative (or 0 if image == frame width)
  const rangeY  = minOffY - maxOffY
  const pctX = rangeX === 0 ? 50 : Math.round((_imgOffX - maxOffX) / rangeX * 100)
  const pctY = rangeY === 0 ? 50 : Math.round((_imgOffY - maxOffY) / rangeY * 100)
  const posStr = pctX + '% ' + pctY + '%'

  if (_dreposTarget === 'cover') {
    _pendingCoverFile = _dreposFile
    _coverPosition    = posStr
    // Apply live preview on page cover
    const cover = document.getElementById('profileCover')
    cover.style.backgroundImage    = 'url(' + _dreposObjUrl + ')'
    cover.style.backgroundSize     = 'cover'
    cover.style.backgroundPosition = posStr
    // Apply in modal preview too
    const modalPrev = document.getElementById('modalCoverPreview')
    if (modalPrev) {
      modalPrev.style.backgroundImage    = 'url(' + _dreposObjUrl + ')'
      modalPrev.style.backgroundSize     = 'cover'
      modalPrev.style.backgroundPosition = posStr
      const btn = modalPrev.querySelector('.pedit-cover-pick-btn span')
      if (btn) btn.textContent = 'Change photo'
    }
  } else {
    _pendingAvatarFile = _dreposFile
    _avatarPosition    = posStr
    // Apply live preview in modal avatar
    const wrap = document.getElementById('modalAvatarPreview')
    if (wrap) wrap.innerHTML = '<img src="' + _dreposObjUrl + '" id="modalAvatarImg" alt="avatar" style="object-position:' + posStr + '">'
    // Apply live preview on page avatar
    const pageAvatar = document.getElementById('profileAvatarImg')
    if (pageAvatar && pageAvatar.tagName === 'IMG') {
      pageAvatar.src = _dreposObjUrl
      pageAvatar.style.objectPosition = posStr
    }
  }

  closeReposOverlay()
}

function closeReposOverlay() {
  removeDragListeners()
  document.getElementById('dragReposOverlay').style.display = 'none'
  document.body.style.overflow = 'hidden'  // keep modal scroll locked
}

function removeDragListeners() {
  const s = document.getElementById('dreposStage')
  s.removeEventListener('mousedown',  onDragStart)
  s.removeEventListener('touchstart', onDragStart)
  window.removeEventListener('mousemove',  onDragMove)
  window.removeEventListener('touchmove',  onDragMove)
  window.removeEventListener('mouseup',   onDragEnd)
  window.removeEventListener('touchend',  onDragEnd)
}

// ── Drag handlers ──────────────────────────────────────────────────────────
function getEventXY(e) {
  if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY }
  return { x: e.clientX, y: e.clientY }
}
function onDragStart(e) {
  e.preventDefault()
  _dragging = true
  const { x, y } = getEventXY(e)
  _dragStartX = x - _imgOffX
  _dragStartY = y - _imgOffY
}
function onDragMove(e) {
  if (!_dragging) return
  e.preventDefault()
  const { x, y } = getEventXY(e)
  _imgOffX = x - _dragStartX
  _imgOffY = y - _dragStartY
  clampAndApplyOffset()
}
function onDragEnd() { _dragging = false }

function clampAndApplyOffset(skipSnap) {
  // Clamp so image always fully covers the crop frame (not just the stage)
  const minX = _frameX + _frameW - _imgW   // image right edge ≥ frame right edge
  const maxX = _frameX                      // image left  edge ≤ frame left  edge
  const minY = _frameY + _frameH - _imgH
  const maxY = _frameY
  _imgOffX = Math.min(maxX, Math.max(minX, _imgOffX))
  _imgOffY = Math.min(maxY, Math.max(minY, _imgOffY))
  const img = document.getElementById('dreposImg')
  img.style.transform = 'translate(' + _imgOffX + 'px,' + _imgOffY + 'px)'
  if (!skipSnap) checkCentreSnap()
}

// ── Centre-snap indicator ─────────────────────────────────────────────────
function checkCentreSnap() {
  // Image is centred over the FRAME when:
  //   imgOffX = frameX + (frameW - imgW)/2  (horiz centre)
  //   imgOffY = frameY + (frameH - imgH)/2  (vert  centre)
  const centreX = _frameX + (_frameW - _imgW) / 2
  const centreY = _frameY + (_frameH - _imgH) / 2
  const THRESH  = 6   // pixels — snap zone
  const snapX   = Math.abs(_imgOffX - centreX) < THRESH
  const snapY   = Math.abs(_imgOffY - centreY) < THRESH
  const snapped = snapX && snapY

  // If within threshold, snap exactly to centre
  if (snapped) {
    _imgOffX = Math.round(centreX)
    _imgOffY = Math.round(centreY)
    document.getElementById('dreposImg').style.transform =
      'translate(' + _imgOffX + 'px,' + _imgOffY + 'px)'
  }

  // Show/hide crosshair lines and pill
  const snapH   = document.getElementById('dreposSnapH')
  const snapV   = document.getElementById('dreposSnapV')
  const pill    = document.getElementById('dreposCentrePill')
  if (snapped) {
    snapH.classList.add('drepos-snap--visible')
    snapV.classList.add('drepos-snap--visible')
    pill.style.display = 'inline-flex'
    // Auto-hide after 1.4 s
    clearTimeout(_centreSnapTimer)
    _centreSnapTimer = setTimeout(function() {
      snapH.classList.remove('drepos-snap--visible')
      snapV.classList.remove('drepos-snap--visible')
    }, 1400)
  } else {
    clearTimeout(_centreSnapTimer)
    snapH.classList.remove('drepos-snap--visible')
    snapV.classList.remove('drepos-snap--visible')
    pill.style.display = 'none'
  }
}

// ── Vignette panels ───────────────────────────────────────────────────────
function updateVignette() {
  // Four rects that cover the area OUTSIDE the crop frame
  const top    = document.getElementById('dreposVigTop')
  const bottom = document.getElementById('dreposVigBottom')
  const left   = document.getElementById('dreposVigLeft')
  const right  = document.getElementById('dreposVigRight')
  if (!top) return
  // Top
  top.style.top    = '0'; top.style.left = '0'; top.style.right = '0'
  top.style.height = _frameY + 'px'
  // Bottom
  bottom.style.bottom = '0'; bottom.style.left = '0'; bottom.style.right = '0'
  bottom.style.height = (_stageH - _frameY - _frameH) + 'px'
  // Left (between top and bottom panels)
  left.style.top    = _frameY + 'px'
  left.style.left   = '0'
  left.style.width  = _frameX + 'px'
  left.style.height = _frameH + 'px'
  // Right
  right.style.top    = _frameY + 'px'
  right.style.right  = '0'
  right.style.width  = (_stageW - _frameX - _frameW) + 'px'
  right.style.height = _frameH + 'px'
}

// ═══════════════════════════════════════════════════════════════════════════
//  SAVE PROFILE
// ═══════════════════════════════════════════════════════════════════════════
async function saveProfile() {
  const btn   = document.getElementById('peditSaveBtn')
  const errEl = document.getElementById('peditError')
  const name  = document.getElementById('peditNameInput').value.trim()
  errEl.style.display = 'none'

  if (!name) { showPeditError('Name cannot be empty'); return }

  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'

  try {
    const fd = new FormData()
    fd.append('name', name)
    if (_pendingAvatarFile) { fd.append('avatar', _pendingAvatarFile); fd.append('avatar_position', _avatarPosition) }
    if (_pendingCoverFile)  { fd.append('cover',  _pendingCoverFile);  fd.append('cover_position',  _coverPosition)  }

    const res  = await fetch('/api/profile/update', { method: 'POST', body: fd })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Update failed')

    // ── Apply to page live ────────────────────────────────────────────────
    document.getElementById('profileNameDisplay').textContent = data.name

    if (data.avatar) {
      const avatarWrap = document.getElementById('profileAvatarImg')
      if (avatarWrap) {
        const newImg = document.createElement('img')
        newImg.src = data.avatar + '?t=' + Date.now()
        newImg.className = 'profile-avatar'
        newImg.id = 'profileAvatarImg'
        newImg.alt = data.name
        newImg.style.objectPosition = data.avatar_position || '50% 50%'
        avatarWrap.parentNode.replaceChild(newImg, avatarWrap)
      }
    }
    if (data.cover_image) {
      const cover = document.getElementById('profileCover')
      cover.style.backgroundImage    = 'url(' + data.cover_image + '?t=' + Date.now() + ')'
      cover.style.backgroundPosition = data.cover_position || '50% 50%'
    }

    closeProfileModalDirect()
    _pendingAvatarFile = null
    _pendingCoverFile  = null
  } catch (err) {
    showPeditError(err.message || 'Something went wrong. Please try again.')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-check"></i> Save changes'
  }
}

function showPeditError(msg) {
  const el = document.getElementById('peditError')
  el.textContent = msg
  el.style.display = 'block'
}
</script>`)
}

// ─── SUBSCRIPTION PAGE ────────────────────────────────────────────────────────
function subscriptionPage(user: User, env: Bindings, pendingDowngrade: string | null = null, pendingUpgrade: string | null = null, realNextBillingDate: string | null = null, paymentMethod: { brand: string; last4: string; exp_month: number; exp_year: number } | null = null) {
  const planLabel = user.plan === 'pro' ? 'Pro Artist' : user.plan === 'creator' ? 'Creator' : 'Free'
  const planClass = user.plan === 'pro' ? 'plan-badge--pro' : user.plan === 'creator' ? 'plan-badge--creator' : ''
  const pct = user.gens_limit > 0 ? Math.min(100, Math.round((user.gens_used / user.gens_limit) * 100)) : 0
  const billingPeriod = user.plan === 'free' ? 'N/A' : 'Monthly'
  // Use real Stripe period_end if available, otherwise show N/A (not a hardcoded +30 days guess)
  const nextBilling = realNextBillingDate ?? (user.stripe_subscription_id ? 'Loading…' : 'N/A')
  const stripeOk = stripeConfigured(env)
  // Downgrade options based on current plan
  const canDowngrade = user.plan !== 'free' && stripeOk && !!user.stripe_subscription_id
  const downgradeOptions = user.plan === 'pro'
    ? [{ value: 'creator', label: 'Creator — $10/mo' }, { value: 'free', label: 'Free — $0/mo (cancel)' }]
    : user.plan === 'creator'
    ? [{ value: 'free', label: 'Free — $0/mo (cancel)' }]
    : []
  // Pending change labels
  const pendingDowngradeLabel = pendingDowngrade === 'creator' ? 'Creator' : pendingDowngrade === 'free' ? 'Free' : null
  const pendingUpgradeLabel   = pendingUpgrade   === 'pro'     ? 'Pro Artist' : pendingUpgrade === 'creator' ? 'Creator' : null
  const hasPendingChange = !!(pendingDowngradeLabel || pendingUpgradeLabel)
  const pendingChangeLabel = pendingDowngradeLabel ?? pendingUpgradeLabel
  const pendingChangeDir   = pendingDowngradeLabel ? 'downgrade' : 'upgrade'

  return shell('Subscription', `
<main class="inner-page gs-content sub-page">
  <div class="container">
    <div class="sub-header">
      <h1>Subscription</h1>
      <p>Manage your plan, billing, and usage.</p>
    </div>

    ${hasPendingChange ? `
    <div style="display:flex;align-items:flex-start;gap:14px;padding:16px 20px;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.3);border-radius:12px;margin-bottom:20px">
      <div style="width:36px;height:36px;background:rgba(245,158,11,.15);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">
        <i class="fas fa-clock" style="color:#f59e0b;font-size:.9rem"></i>
      </div>
      <div>
        <div style="font-weight:600;font-size:.95rem;color:#fbbf24;margin-bottom:3px">
          Plan change scheduled
        </div>
        <div style="color:rgba(255,255,255,.75);font-size:.85rem;line-height:1.5">
          You are currently on <strong style="color:#fff">${planLabel}</strong> and will ${pendingChangeDir === 'downgrade' ? 'move down' : 'upgrade'} to
          <strong style="color:#fff">${pendingChangeLabel}</strong> at the end of your current billing period
          ${nextBilling !== 'N/A' && nextBilling !== 'Loading…' ? `(${nextBilling})` : ''}.
          You keep full <strong style="color:#fff">${planLabel}</strong> access until then.
        </div>
      </div>
    </div>` : ''}

    <div class="sub-stats-bar">
      <div class="sub-stat">
        <span class="sub-stat__label">Current Plan</span>
        <span class="sub-stat__val">
          <span class="plan-badge ${planClass}">${planLabel}</span>
          ${hasPendingChange ? `<span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-size:.72rem;color:#f59e0b;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.25);border-radius:20px;padding:2px 8px;vertical-align:middle"><i class="fas fa-arrow-${pendingChangeDir === 'downgrade' ? 'down' : 'up'}" style="font-size:.65rem"></i> changing to ${pendingChangeLabel}</span>` : ''}
        </span>
      </div>
      <div class="sub-stat">
        <span class="sub-stat__label">Billing Period</span>
        <span class="sub-stat__val">${billingPeriod}</span>
      </div>
      <div class="sub-stat">
        <span class="sub-stat__label">${hasPendingChange ? 'Change Takes Effect' : 'Next Billing Date'}</span>
        <span class="sub-stat__val">${nextBilling}</span>
      </div>
    </div>
    <div class="sub-usage-card">
      <div class="sub-usage-header">
        <h3>Points Usage</h3>
        <span class="sub-usage-count" id="sub-usage-count">${user.gens_used} / ${user.gens_limit} pts used</span>
      </div>
      <div class="sub-usage-bar"><div class="sub-usage-bar__fill" id="sub-usage-bar-fill" style="width:${pct}%"></div></div>
      <p class="sub-usage-note" id="sub-usage-note">${pct}% of your monthly generations used · Resets on billing date</p>
    </div>

    <!-- ── Buy More Credits / Credit Packs ───────────────────── -->
    <div class="sub-credits-section" id="sub-credits-section">
      <div class="pack-section-header">
        <div>
          <h3 style="margin:0 0 4px;font-size:1.15rem;font-weight:700;display:flex;align-items:center;gap:8px">
            <span style="width:32px;height:32px;background:linear-gradient(135deg,var(--primary),#8b5cf6);border-radius:8px;display:flex;align-items:center;justify-content:center">
              <i class="fas fa-bolt" style="color:#fff;font-size:.85rem"></i>
            </span>
            Top Up Points
          </h3>
          <p style="color:var(--muted);font-size:.85rem;margin:0">One-time packs — valid for current billing cycle, stack on top of your plan</p>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(78,159,255,.08);border:1px solid rgba(78,159,255,.2);border-radius:8px;font-size:.78rem;color:var(--primary)">
          <i class="fas fa-lock-open"></i> No subscription required
        </div>
      </div>
      <div class="credit-packs-grid" id="credit-packs-grid">
        <div class="credit-pack-card" data-pack="pack_150">
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">150</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$4.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_150">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card credit-pack-card--popular" data-pack="pack_600">
          <div class="credit-pack__badge"><i class="fas fa-star"></i> Best Value</div>
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">600</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$9.99</span>
            <button class="credit-pack-btn credit-pack-btn--primary" data-pack="pack_600">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card" data-pack="pack_1000">
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">1000</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$17.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_1000">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card" data-pack="pack_1500">
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">1500</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$29.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_1500">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
      </div>
      <p style="text-align:center;font-size:.78rem;color:var(--muted);margin-top:10px">
        <i class="fas fa-shield-alt" style="color:var(--accent-2);margin-right:4px"></i>Secure checkout powered by Stripe
      </p>
    </div>

    <div class="sub-plans-section">
      <h3>Available Plans</h3>
      <div class="sub-plans-grid">

        <!-- ── FREE CARD ────────────────────────────────────────────── -->
        <div class="sub-plan-card ${user.plan === 'free' ? 'sub-plan-card--current' : pendingDowngrade === 'free' ? 'plan-card--is-downgrading' : ''}" id="sub-plan-free">
          ${user.plan === 'free' ? '<div class="plan-card-status-banner plan-card-status-banner--current"><i class="fas fa-check-circle"></i> Your Current Plan</div>' : pendingDowngrade === 'free' ? '<div class="plan-card-status-banner plan-card-status-banner--downgrading"><i class="fas fa-arrow-down"></i> Downgrading to this plan</div>' : ''}
          <div class="sub-plan-card__top">
            <div><h4>Free</h4><p>Try the engine</p></div>
            <div class="sub-plan-card__price">$0<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 60 points monthly</li>
            <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
          </ul>
          ${user.plan === 'free'
            ? '<span class="sub-current-badge">Current plan</span>'
            : (user.plan === 'creator' || user.plan === 'pro' || user.plan === 'developer')
              ? `<div class="sub-action-wrap" id="sub-free-action-wrap">
                  <div class="sub-downgrade-pending-banner" id="sub-free-downgrade-banner" style="display:${pendingDowngrade === 'free' ? 'flex' : 'none'}">
                    <i class="fas fa-clock"></i> <span>Downgrading to Free at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="free" id="sub-btn-downgrade-to-free" style="border-color:rgba(255,100,100,.4);color:#ff7070;${pendingDowngrade === 'free' ? 'display:none' : ''}">
                      <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Free
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-free" style="display:${pendingDowngrade === 'free' ? 'inline-flex' : 'none'};border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('free')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
                    </button>
                  </div>
                </div>`
              : ''
          }
        </div>

        <!-- ── CREATOR CARD ──────────────────────────────────────────── -->
        <div class="sub-plan-card ${user.plan === 'creator' ? 'sub-plan-card--current' : pendingDowngrade === 'creator' ? 'plan-card--is-downgrading' : ''}" id="sub-plan-creator">
          ${user.plan === 'creator' ? '<div class="plan-card-status-banner plan-card-status-banner--current"><i class="fas fa-check-circle"></i> Your Current Plan</div>' : pendingDowngrade === 'creator' ? '<div class="plan-card-status-banner plan-card-status-banner--downgrading"><i class="fas fa-arrow-down"></i> Downgrading to this plan</div>' : ''}
          <div class="sub-plan-card__top">
            <div><h4>Creator</h4><p>For Artists &amp; creators</p></div>
            <div class="sub-plan-card__price">$10<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 900 points monthly</li>
            <li><i class="fas fa-check"></i> Auto Split — up to 5 stems</li>
            <li><i class="fas fa-check"></i> WAV download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator (SFX)</li>
          </ul>
          ${user.plan === 'creator'
            ? `<div class="sub-action-wrap" id="sub-creator-action-wrap">
                <span class="sub-current-badge">Current plan</span>
                <div class="sub-downgrade-pending-banner" id="sub-creator-downgrade-banner" style="display:${pendingDowngrade === 'free' ? 'flex' : 'none'};margin-top:8px">
                  <i class="fas fa-clock"></i> <span id="sub-creator-banner-msg">Downgrading to Free at end of billing cycle</span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                  <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="free" id="sub-btn-downgrade-to-free-from-creator" style="border-color:rgba(255,100,100,.4);color:#ff7070;${pendingDowngrade === 'free' ? 'display:none' : ''}">
                    <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Free
                  </button>
                  <button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-creator" style="display:${pendingDowngrade === 'free' ? 'inline-flex' : 'none'};border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('free')">
                    <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
                  </button>
                </div>
              </div>`
            : user.plan === 'pro' || user.plan === 'developer'
              ? `<div class="sub-action-wrap" id="sub-creator-action-wrap">
                  <div class="sub-downgrade-pending-banner" id="sub-creator-downgrade-banner" style="display:${pendingDowngrade === 'creator' ? 'flex' : 'none'}">
                    <i class="fas fa-clock"></i> <span id="sub-creator-banner-msg">Downgrading to Creator at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="creator" id="sub-btn-downgrade-to-creator" style="border-color:rgba(255,100,100,.4);color:#ff7070;${pendingDowngrade === 'creator' ? 'display:none' : ''}">
                      <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Creator
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-creator" style="display:${pendingDowngrade === 'creator' ? 'inline-flex' : 'none'};border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('creator')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
                    </button>
                  </div>
                </div>`
              : `<div class="sub-action-wrap" id="sub-creator-action-wrap">
                  <div class="sub-upgrade-pending-banner" id="sub-creator-upgrade-banner" style="display:${pendingUpgrade === 'creator' ? 'flex' : 'none'}">
                    <i class="fas fa-clock"></i> <span>Upgrading to Creator at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--primary btn--sm sub-upgrade-btn" data-target="creator" id="sub-btn-upgrade-to-creator" style="${pendingUpgrade === 'creator' ? 'display:none' : ''}">
                      <i class="fas fa-arrow-up" style="font-size:.75rem;margin-right:4px"></i>Upgrade to Creator
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-upgrade-creator" style="display:${pendingUpgrade === 'creator' ? 'inline-flex' : 'none'};border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelUpgrade('creator')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Upgrade
                    </button>
                  </div>
                </div>`
          }
        </div>

        <!-- ── PRO ARTIST CARD ───────────────────────────────────────── -->
        <div class="sub-plan-card ${user.plan === 'pro' ? 'sub-plan-card--current' : ''}" id="sub-plan-pro">
          ${user.plan === 'pro' ? '<div class="plan-card-status-banner plan-card-status-banner--current"><i class="fas fa-check-circle"></i> Your Current Plan</div>' : ''}
          <div class="sub-plan-card__top">
            <div><h4>Pro Artist</h4><p>Maximum output</p></div>
            <div class="sub-plan-card__price">$26<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 2,000 points monthly</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-expand-arrows-alt" style="font-size:.75rem;opacity:.8"></i> Song Extend</li>
            <li><i class="fas fa-check"></i> Vocals &amp; Instrumental split</li>
            <li><i class="fas fa-check"></i> Stem download (all modes)</li>
            <li><i class="fas fa-check"></i> Reference track upload</li>
            <li><i class="fas fa-check"></i> WAV download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
            <li><i class="fas fa-check"></i> Priority queue</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-wand-magic-sparkles" style="color:#a855f7;font-size:.8rem"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span></li>
            <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator (SFX)</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-guitar" style="color:#a855f7;font-size:.75rem"></i> AI Cover Song</li>
          </ul>
          ${user.plan === 'pro'
            ? `<div class="sub-action-wrap" id="sub-pro-action-wrap">
                <span class="sub-current-badge">Current plan</span>
                <div class="sub-downgrade-pending-banner" id="sub-pro-downgrade-banner" style="display:${pendingDowngrade ? 'flex' : 'none'};margin-top:8px">
                  <i class="fas fa-clock"></i> <span>Downgrading to ${pendingDowngrade === 'creator' ? 'Creator' : 'Free'} at end of billing cycle</span>
                </div>
                ${pendingDowngrade ? `<button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-pro" style="display:inline-flex;margin-top:8px;border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('${pendingDowngrade}')"><i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade</button>` : ''}
              </div>`
            : user.plan === 'developer'
              ? `<span class="sub-current-badge" style="opacity:.5">Dev override</span>`
              : `<div class="sub-action-wrap" id="sub-pro-action-wrap">
                  <div class="sub-upgrade-pending-banner" id="sub-pro-upgrade-banner" style="display:${pendingUpgrade === 'pro' ? 'flex' : 'none'}">
                    <i class="fas fa-clock"></i> <span>Upgrading to Pro Artist at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--primary btn--sm sub-upgrade-btn" data-target="pro" id="sub-btn-upgrade-to-pro" style="${pendingUpgrade === 'pro' ? 'display:none' : ''}">
                      <i class="fas fa-arrow-up" style="font-size:.75rem;margin-right:4px"></i>Upgrade to Pro Artist
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-upgrade-pro" style="display:${pendingUpgrade === 'pro' ? 'inline-flex' : 'none'};border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelUpgrade('pro')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Upgrade
                    </button>
                  </div>
                </div>`
          }
        </div>
        ${user.plan === 'developer' ? `
        <div class="sub-plan-card sub-plan-card--current" style="border-color:#a78bfa33">
          <div class="sub-plan-card__top">
            <div><h4 style="color:#a78bfa">Developer</h4><p>Unlimited access</p></div>
            <div class="sub-plan-card__price" style="color:#a78bfa">∞</div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> Unlimited generations</li>
            <li><i class="fas fa-check"></i> All features unlocked</li>
            <li><i class="fas fa-check"></i> Admin panel access</li>
          </ul>
          <span class="sub-current-badge">Active</span>
        </div>` : ''}
      </div>
    </div>

    <!-- ── Payment Method ────────────────────────────────────── -->
    ${user.stripe_customer_id ? `
    <div style="margin-top:32px;padding:24px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:32px;height:32px;background:linear-gradient(135deg,#1e1e3a,#2d2a6e);border:1px solid rgba(108,58,255,.3);border-radius:8px;display:flex;align-items:center;justify-content:center">
            <i class="fas fa-credit-card" style="color:#a78bfa;font-size:.8rem"></i>
          </div>
          <span style="font-weight:600;font-size:.95rem">Payment Method</span>
        </div>
        <a href="/api/stripe/portal" style="font-size:.78rem;color:#a78bfa;text-decoration:none;opacity:.8">
          <i class="fas fa-external-link-alt" style="font-size:.7rem;margin-right:3px"></i>Manage
        </a>
      </div>
      ${paymentMethod ? `
      <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px">
        <div style="width:42px;height:28px;background:#1a1a2e;border:1px solid rgba(255,255,255,.15);border-radius:5px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:.65rem;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.5px">
          ${paymentMethod.brand === 'visa' ? '<span style="color:#1a73e8;font-size:.7rem;font-weight:900">VISA</span>' : paymentMethod.brand === 'mastercard' ? '<span style="font-size:.6rem;color:#eb001b;font-weight:900">MC</span>' : paymentMethod.brand === 'amex' ? '<span style="color:#2e77bc;font-size:.6rem;font-weight:900">AMEX</span>' : paymentMethod.brand.toUpperCase().slice(0,4)}
        </div>
        <div>
          <div style="font-weight:600;font-size:.9rem;letter-spacing:.5px">•••• •••• •••• ${paymentMethod.last4}</div>
          <div style="color:var(--muted);font-size:.75rem;margin-top:2px">Expires ${String(paymentMethod.exp_month).padStart(2,'0')} / ${String(paymentMethod.exp_year).slice(-2)}</div>
        </div>
        <div style="margin-left:auto">
          <span style="font-size:.7rem;background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.25);border-radius:20px;padding:2px 9px">Default</span>
        </div>
      </div>
      <p style="margin:10px 0 0;font-size:.75rem;color:var(--muted)"><a href="/api/stripe/portal" style="color:#a78bfa;text-decoration:none">+ Add or change card →</a></p>
      ` : `
      <div style="text-align:center;padding:20px 0;color:var(--muted);font-size:.85rem">
        <i class="fas fa-credit-card" style="font-size:1.4rem;margin-bottom:8px;opacity:.3;display:block"></i>
        No payment method on file
      </div>
      <a href="/api/stripe/portal" style="display:block;text-align:center;font-size:.8rem;color:#a78bfa;text-decoration:none;margin-top:8px">+ Add a payment method →</a>
      `}
    </div>
    ` : ''}

    <!-- ── Points Cost Reference Table ──────────────────────── -->
    <div style="margin-top:40px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="width:34px;height:34px;background:linear-gradient(135deg,#6c3aff,#a855f7);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-table" style="color:#fff;font-size:.85rem"></i>
        </div>
        <div>
          <h3 style="margin:0;font-size:1.1rem;font-weight:700">What You Get</h3>
          <p style="margin:0;font-size:.8rem;color:var(--muted)">Points cost per action — applies to all plans</p>
        </div>
      </div>
      <div class="credit-table-wrap" style="overflow-x:auto">
        <div class="credit-table">
          <div class="credit-table__row credit-table__row--header"><span>Action</span><span>Points Cost</span><span>Available On</span></div>
          <div class="credit-table__row"><span><i class="fas fa-music"></i> Generate 1 StemForge beat</span><span class="credit-val">25 pts</span><span class="tier-badge tier-badge--free">All plans</span></div>
          <div class="credit-table__row"><span><i class="fas fa-cut"></i> Auto Split (up to 5 stems)</span><span class="credit-val">30 pts</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
          <div class="credit-table__row"><span><i class="fas fa-microphone"></i> Vocals &amp; Instrumental</span><span class="credit-val">70 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
          <div class="credit-table__row"><span><i class="fas fa-expand-arrows-alt"></i> Extend song</span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>

          <div class="credit-table__row"><span><i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span></span><span class="credit-val">25 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
          <div class="credit-table__row"><span><i class="fas fa-upload"></i> Reference track upload</span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
          <div class="credit-table__row"><span><i class="fas fa-bolt" style="color:#f59e0b"></i> One Shot Creator (SFX)</span><span class="credit-val">15 pts</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
          <div class="credit-table__row"><span><i class="fas fa-microphone-alt" style="color:#a855f7"></i> AI Cover Song</span><span class="credit-val">25 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
          <div class="credit-table__row"><span><i class="fas fa-download"></i> WAV download</span><span class="credit-val" style="color:#10b981">Included</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
        </div>
      </div>
      <p style="margin:10px 0 0;font-size:.75rem;color:var(--muted);text-align:center">
        <i class="fas fa-info-circle" style="margin-right:4px"></i>
        Points reset on your billing date. <a href="/pricing" style="color:var(--primary)">See plan details →</a>
      </p>
    </div>

  </div>
</main>
<!-- Downgrade confirm modal -->
<div id="sub-downgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center">
    <i class="fas fa-arrow-down" style="font-size:2rem;color:#ff6464;margin-bottom:16px"></i>
    <h3 style="margin-bottom:8px">Confirm Downgrade</h3>
    <p id="sub-downgrade-msg" style="color:var(--muted);margin-bottom:24px;line-height:1.5"></p>
    <div style="display:flex;gap:12px;justify-content:center">
      <button class="btn btn--outline btn--sm" onclick="document.getElementById('sub-downgrade-modal').style.display='none'">Cancel</button>
      <button class="btn btn--sm" id="sub-downgrade-confirm" style="background:#ff4444;border:none;color:white">Confirm Downgrade</button>
    </div>
  </div>
</div>

<!-- Upgrade confirm modal -->
<div id="sub-upgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px)">
  <div style="background:var(--surface);border:1px solid rgba(108,58,255,.35);border-radius:24px;padding:0;max-width:460px;width:100%;overflow:hidden;box-shadow:0 24px 80px rgba(108,58,255,.2)">

    <!-- Modal header -->
    <div style="background:linear-gradient(135deg,rgba(108,58,255,.18),rgba(168,85,247,.12));border-bottom:1px solid rgba(108,58,255,.2);padding:24px 28px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-bolt" style="color:white;font-size:.9rem"></i>
          </div>
          <div>
            <h3 style="margin:0;font-size:1.15rem;font-weight:700" id="upgrade-modal-title">Upgrade Plan</h3>
            <p style="margin:0;font-size:.8rem;color:var(--muted)" id="upgrade-modal-subtitle">Instant access — charged now</p>
          </div>
        </div>
        <button onclick="closeUpgradeModal()" style="background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer;padding:4px"><i class="fas fa-times"></i></button>
      </div>
    </div>

    <!-- Loading state -->
    <div id="upgrade-modal-loading" style="padding:48px;text-align:center">
      <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:#a855f7;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px"></div>
      <p style="color:var(--muted);margin:0;font-size:.9rem">Calculating your proration…</p>
    </div>

    <!-- Content state -->
    <div id="upgrade-modal-content" style="display:none;padding:24px 28px">

      <!-- Plan transition pill -->
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:24px">
        <div style="padding:6px 14px;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:20px;font-size:.85rem;font-weight:600" id="upgrade-from-label">Creator</div>
        <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-right" style="color:white;font-size:.7rem"></i>
        </div>
        <div style="padding:6px 14px;background:linear-gradient(135deg,rgba(108,58,255,.15),rgba(168,85,247,.1));border:1px solid rgba(168,85,247,.4);border-radius:20px;font-size:.85rem;font-weight:700;color:#c084fc" id="upgrade-to-label">Pro Artist</div>
      </div>

      <!-- Suno-style price breakdown -->
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:16px">

        <!-- New plan full price -->
        <div style="padding:13px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <div>
            <span style="font-size:.88rem;font-weight:600" id="umod-plan-name">Pro Artist</span>
            <span style="font-size:.78rem;color:var(--muted);margin-left:6px" id="umod-cycle-note">monthly</span>
          </div>
          <span id="umod-new-price" style="font-size:.88rem;font-weight:600">$26.00</span>
        </div>

        <!-- Unused credits discount row (only shown when upgrading mid-cycle) -->
        <div id="umod-discount-row" style="padding:13px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <div>
            <span style="font-size:.88rem;color:#10b981;font-weight:600"><i class="fas fa-tag" style="margin-right:5px"></i>Unused credit discount</span>
            <div style="font-size:.75rem;color:var(--muted);margin-top:1px" id="umod-discount-note">Value of remaining days on current plan</div>
          </div>
          <span id="umod-discount-val" style="font-size:.88rem;font-weight:600;color:#10b981">−$0.00</span>
        </div>

        <!-- Charge today — highlighted -->
        <div style="padding:15px 18px;display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,rgba(108,58,255,.12),rgba(168,85,247,.08))">
          <div>
            <span style="font-size:1rem;font-weight:800">Charged today</span>
            <div style="font-size:.75rem;color:var(--muted);margin-top:1px" id="umod-today-note">Access granted immediately</div>
          </div>
          <span id="umod-charge-today" style="font-size:1.25rem;font-weight:900;color:#c084fc">$26.00</span>
        </div>
      </div>

      <!-- Billing cycle info -->
      <div id="umod-renewal-row" style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;margin-bottom:20px;font-size:.8rem;color:var(--muted)">
        <i class="fas fa-calendar-alt" style="color:#6c3aff;flex-shrink:0"></i>
        <span id="umod-renewal-note">Then billed monthly at the new plan rate.</span>
      </div>

      <!-- Credits section anchor note -->
      <div id="umod-credits-section" style="display:none;padding:10px 14px;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.2);border-radius:10px;margin-bottom:20px;font-size:.8rem;color:var(--muted)">
        <i class="fas fa-bolt" style="color:#10b981;margin-right:5px"></i>
        <span id="umod-credits-note">Your generation points will be upgraded to the new plan's limit immediately.</span>
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:10px">
        <button class="btn btn--outline btn--sm" style="flex:1" onclick="closeUpgradeModal()">
          <i class="fas fa-times"></i> Cancel
        </button>
        <button class="btn btn--primary btn--sm" style="flex:2;background:linear-gradient(135deg,#6c3aff,#a855f7);border:none;font-size:.95rem" id="upgrade-confirm-btn" onclick="confirmUpgrade()">
          <i class="fas fa-bolt"></i> <span id="upgrade-confirm-label">Confirm &amp; Pay</span>
        </button>
      </div>
    </div>

    <!-- Error state -->
    <div id="upgrade-modal-error" style="display:none;padding:36px 28px;text-align:center">
      <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:#ef4444;margin-bottom:14px;display:block"></i>
      <p id="upgrade-error-msg" style="color:var(--muted);margin:0 0 20px;font-size:.9rem;line-height:1.5">Unable to calculate proration.</p>
      <button class="btn btn--outline btn--sm" onclick="closeUpgradeModal()">Close</button>
    </div>

  </div>
</div>
<script>
(function(){
  // ── Upgrade flow: preview → Suno-style confirm modal → pay ──────────────
  let _upgradePendingPlan = null;
  let _upgradePreviewData = null;

  function openUpgradeModal(targetPlan) {
    _upgradePendingPlan = targetPlan;
    _upgradePreviewData = null;
    const modal      = document.getElementById('sub-upgrade-modal');
    const loadingEl  = document.getElementById('upgrade-modal-loading');
    const contentEl  = document.getElementById('upgrade-modal-content');
    const errorEl    = document.getElementById('upgrade-modal-error');
    modal.style.display = 'flex';
    loadingEl.style.display = 'block';
    contentEl.style.display = 'none';
    errorEl.style.display   = 'none';

    fetch('/api/subscription/upgrade-preview?plan=' + encodeURIComponent(targetPlan))
      .then(r => r.json())
      .then(data => {
        if (data.error) { showUpgradeError(data.error); return; }
        _upgradePreviewData = data;

        const targetLabel = data.target_plan_label || targetPlan;
        const newPriceCents     = data.new_price_cents     || 0;
        const currentPriceCents = data.current_price_cents || 0;
        const proratedCents     = data.proration_cents     || newPriceCents;

        // Discount = new_price - proration (unused credit value from old plan)
        const discountCents = Math.max(0, newPriceCents - proratedCents);

        const hasRealSub = data.has_subscription &&
          data.days_remaining != null && !isNaN(data.days_remaining) &&
          data.days_in_period != null && !isNaN(data.days_in_period);

        // ── Plan transition pill ──
        document.getElementById('upgrade-from-label').textContent = data.current_plan_label || 'Current';
        document.getElementById('upgrade-to-label').textContent   = targetLabel;
        document.getElementById('upgrade-modal-title').textContent = 'Upgrade to ' + targetLabel;

        // ── New plan price row ──
        document.getElementById('umod-plan-name').textContent  = targetLabel;
        document.getElementById('umod-new-price').textContent  = '$' + (newPriceCents / 100).toFixed(2);
        document.getElementById('umod-cycle-note').textContent = data.period_end_label
          ? 'renews ' + data.period_end_label
          : 'monthly';

        // ── Discount row (only for mid-cycle upgrades with a real existing sub) ──
        const discountRow = document.getElementById('umod-discount-row');
        if (hasRealSub && discountCents > 0 && currentPriceCents > 0) {
          discountRow.style.display = 'flex';
          document.getElementById('umod-discount-val').textContent  = '−$' + (discountCents / 100).toFixed(2);
          document.getElementById('umod-discount-note').textContent =
            data.days_remaining + ' days left on ' + (data.current_plan_label || 'current plan');
        } else {
          discountRow.style.display = 'none';
        }

        // ── Charge today ──
        const chargeLabel = '$' + (proratedCents / 100).toFixed(2);
        document.getElementById('umod-charge-today').textContent = chargeLabel;
        document.getElementById('umod-today-note').textContent   = hasRealSub && discountCents > 0
          ? targetLabel + ' — ' + data.new_price_label + ' minus unused credit'
          : 'Instant access · ' + targetLabel + ' features unlocked now';

        // ── Renewal note ──
        const renewalNote = document.getElementById('umod-renewal-note');
        if (hasRealSub && data.period_end_label) {
          renewalNote.textContent = 'Then ' + (data.new_price_label || '') + '/mo starting ' + data.period_end_label + '.';
        } else {
          renewalNote.textContent = 'Billed monthly. Cancel anytime from this page.';
        }

        // ── Credits upgrade note ──
        const credSection = document.getElementById('umod-credits-section');
        credSection.style.display = 'block';
        document.getElementById('umod-credits-note').textContent =
          'Your points allowance upgrades immediately to ' + (targetPlan === 'pro' ? '2,000 pts/mo' : '900 pts/mo') + '.';

        // ── Confirm button ──
        document.getElementById('upgrade-confirm-label').textContent = 'Confirm & Pay ' + chargeLabel;

        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';
      })
      .catch(() => showUpgradeError('Network error. Please try again.'));
  }

  function showUpgradeError(msg) {
    document.getElementById('upgrade-modal-loading').style.display = 'none';
    document.getElementById('upgrade-modal-content').style.display = 'none';
    document.getElementById('upgrade-error-msg').textContent = msg;
    document.getElementById('upgrade-modal-error').style.display = 'block';
  }

  window.closeUpgradeModal = function() {
    document.getElementById('sub-upgrade-modal').style.display = 'none';
    _upgradePendingPlan = null;
    _upgradePreviewData = null;
  };

  window.confirmUpgrade = async function() {
    if (!_upgradePendingPlan) return;
    const confirmBtn = document.getElementById('upgrade-confirm-btn');
    confirmBtn.disabled = true;
    document.getElementById('upgrade-confirm-label').textContent = 'Processing…';
    try {
      const res = await fetch('/api/subscription/upgrade', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ target_plan: _upgradePendingPlan })
      });
      const data = await res.json();
      closeUpgradeModal();
      if (data.redirect) { window.location.href = data.redirect; return; }
      if (data.ok) {
        sessionStorage.setItem('sf_pending_upgrade', _upgradePendingPlan);
        alert(data.message || 'Upgrade successful! Access granted immediately.');
        window.location.reload();
      } else {
        alert('Error: ' + (data.error || 'Upgrade failed'));
      }
    } catch(e) {
      closeUpgradeModal();
      alert('Network error. Please try again.');
    }
  };

  // Close modal on backdrop click
  document.getElementById('sub-upgrade-modal').addEventListener('click', function(e) {
    if (e.target === this) closeUpgradeModal();
  });

  document.querySelectorAll('.sub-upgrade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (!target) return;
      openUpgradeModal(target);
    });
  });

  // Credit pack purchase buttons
  document.querySelectorAll('.credit-pack-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const packId = btn.dataset.pack;
      if (!packId) return;
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const res = await fetch('/api/credit-packs/purchase', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ pack_id: packId })
        });
        const data = await res.json();
        if (data.url) { window.location.href = data.url; }
        else { alert('Error: ' + (data.error || 'Could not start purchase')); btn.disabled = false; btn.textContent = 'Buy'; }
      } catch(e) { alert('Network error. Please try again.'); btn.disabled = false; btn.textContent = 'Buy'; }
    });
  });

  // Downgrade buttons
  let pendingTarget = null;
  document.querySelectorAll('.sub-downgrade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingTarget = btn.dataset.target;
      const modal = document.getElementById('sub-downgrade-modal');
      const msg = document.getElementById('sub-downgrade-msg');
      if (pendingTarget === 'free') {
        msg.textContent = 'Your subscription will be cancelled at the end of your billing cycle. You will move to the Free plan (50 points monthly) after that.';
      } else if (pendingTarget === 'creator') {
        msg.textContent = 'You will be downgraded to the Creator plan ($10/mo, 900 points/mo) at the end of your current billing cycle.';
      }
      modal.style.display = 'flex';
    });
  });
  const confirmBtn = document.getElementById('sub-downgrade-confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!pendingTarget) return;
      confirmBtn.disabled = true; confirmBtn.textContent = 'Processing…';
      try {
        const res = await fetch('/api/subscription/downgrade', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ target_plan: pendingTarget })
        });
        const data = await res.json();
        document.getElementById('sub-downgrade-modal').style.display = 'none';
        if (data.ok) { alert(data.message || 'Downgrade scheduled. Changes take effect at end of billing period.'); window.location.reload(); }
        else { alert('Error: ' + (data.error || 'Downgrade failed')); }
      } catch(e) { alert('Network error. Please try again.'); }
      finally { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Downgrade'; }
    });
  }

  // Show credits added success
  if (new URLSearchParams(window.location.search).get('credits') === 'added') {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:var(--primary);color:white;padding:12px 20px;border-radius:8px;margin-bottom:20px;font-weight:600';
    banner.innerHTML = '<i class="fas fa-check-circle"></i> Credits added to your account!';
    document.querySelector('.sub-header')?.after(banner);
  }

  // ── Global pending-state locking ───────────────────────────────────────────
  // If ANY pending downgrade/upgrade exists, ALL other plan buttons must be
  // disabled so the user must cancel the current pending change first.
  // The server already shows/hides the correct banner+cancel for the pending target.
  // This client-side block locks all OTHER (non-target) upgrade/downgrade buttons.
  (async function() {
    try {
      const pendingRes = await fetch('/api/subscription/pending-state').then(r => r.json()).catch(() => ({}));
      const pd = (pendingRes && pendingRes.pendingDowngrade) || null;
      const pu = (pendingRes && pendingRes.pendingUpgrade)   || null;
      const hasPending = !!(pd || pu);
      if (!hasPending) return; // nothing to lock

      function lockSubBtn(btn) {
        // Don't lock the cancel buttons or already-hidden buttons
        if (btn.id && (btn.id.includes('cancel') || btn.id.includes('Cancel'))) return;
        if (btn.style.display === 'none') return;
        btn.innerHTML = '<i class="fas fa-lock" style="font-size:.75rem;margin-right:5px;opacity:.7"></i>Cancel pending first';
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
        btn.style.pointerEvents = 'none';
        btn.style.borderColor = 'rgba(255,255,255,.12)';
        btn.style.color = 'var(--muted)';
        btn.classList.remove('btn--primary', 'btn--danger');
        btn.classList.add('btn--outline');
      }

      // Lock all upgrade buttons whose target is NOT the pending upgrade target
      document.querySelectorAll('.sub-upgrade-btn').forEach(btn => {
        const target = btn.dataset.target;
        if (target === pu) return; // this IS the pending target — already hidden by server
        lockSubBtn(btn);
      });

      // Lock all downgrade buttons whose target is NOT the pending downgrade target
      document.querySelectorAll('.sub-downgrade-btn').forEach(btn => {
        const target = btn.dataset.target;
        if (target === pd) return; // this IS the pending target — already hidden by server
        lockSubBtn(btn);
      });
    } catch(e) { /* silent — non-critical */ }
  })();
})();
</script>`)
}

// ─── ACCOUNT PAGE ─────────────────────────────────────────────────────────────
// ─── PROMO CODE PAGE ──────────────────────────────────────────────────────────
function promoPage() {
  return shell('Promo Codes', `
<main class="inner-page gs-content">
  <div class="container" style="max-width:560px">
    <div class="sub-header">
      <h1><i class="fas fa-tag" style="color:var(--primary)"></i> Promo Codes</h1>
      <p>Have a promo code? Enter it below to apply bonus points or discounts to your account.</p>
    </div>
    <div class="promo-card" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;margin-bottom:24px">
      <div id="promo-success" style="display:none;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:10px;padding:16px;margin-bottom:20px;color:#10b981;font-weight:600"></div>
      <div id="promo-error" style="display:none;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:16px;margin-bottom:20px;color:#ef4444"></div>
      <label style="font-weight:600;display:block;margin-bottom:8px">Promo Code</label>
      <div style="display:flex;gap:10px">
        <input type="text" id="promo-input" placeholder="e.g. WELCOME20" style="flex:1;padding:12px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:1rem;letter-spacing:.08em;text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"/>
        <button class="btn btn--primary" id="promo-apply-btn" onclick="applyPromoCode()">
          <i class="fas fa-check"></i> Apply
        </button>
      </div>
      <p id="promo-terms" style="color:var(--muted);font-size:.85rem;margin-top:12px;display:none"></p>
    </div>
    <div style="text-align:center">
      <a href="/subscription" class="btn btn--outline btn--sm"><i class="fas fa-arrow-left"></i> Back to Subscription</a>
    </div>
  </div>
</main>
<script>
async function applyPromoCode() {
  const input = document.getElementById('promo-input');
  const btn = document.getElementById('promo-apply-btn');
  const successEl = document.getElementById('promo-success');
  const errorEl = document.getElementById('promo-error');
  const termsEl = document.getElementById('promo-terms');
  const code = input.value.trim().toUpperCase();
  if (!code) { errorEl.textContent='Please enter a promo code.'; errorEl.style.display='block'; return; }
  btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Applying…';
  successEl.style.display='none'; errorEl.style.display='none';
  try {
    const res = await fetch('/api/promo/redeem', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({code}) });
    const data = await res.json();
    if (data.ok) {
      successEl.innerHTML = '<i class="fas fa-check-circle"></i> ' + (data.message||'Promo code applied!');
      successEl.style.display='block';
      input.value=''; termsEl.style.display='none';
    } else {
      errorEl.textContent = data.error || 'Could not apply promo code.';
      errorEl.style.display='block';
    }
  } catch(e) { errorEl.textContent='Network error. Please try again.'; errorEl.style.display='block'; }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-check"></i> Apply'; }
}
// Preview promo code terms on input
document.getElementById('promo-input').addEventListener('input', async function() {
  const code = this.value.trim().toUpperCase();
  const termsEl = document.getElementById('promo-terms');
  if (code.length < 3) { termsEl.style.display='none'; return; }
  try {
    const res = await fetch('/api/promo/validate/' + encodeURIComponent(code));
    const data = await res.json();
    if (data.ok && data.terms) { termsEl.textContent = data.terms; termsEl.style.display='block'; }
    else { termsEl.style.display='none'; }
  } catch {}
});
</script>`)
}

// ─── ADMIN PAGE ───────────────────────────────────────────────────────────────
function adminPage(user: User) {
  return shell('Admin Panel', `
<main class="inner-page gs-content">
  <div class="container">
    <div class="sub-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div>
        <h1 style="display:flex;align-items:center;gap:10px"><i class="fas fa-shield-alt" style="color:#a78bfa"></i> Admin Panel</h1>
        <p style="color:var(--muted)">Logged in as ${user.email}</p>
      </div>
      <a href="/dashboard" class="btn btn--outline btn--sm"><i class="fas fa-arrow-left"></i> Back to Dashboard</a>
    </div>

    <!-- Diagnostic strip — always visible, shows live API test results -->
    <div id="admin-diag" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin-bottom:20px;font-size:.8rem;font-family:monospace;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <span style="color:#94a3b8;margin-right:4px">API checks:</span>
      <span id="diag-ping"  style="padding:3px 10px;border-radius:999px;background:#1e293b;color:#94a3b8">ping…</span>
      <span id="diag-stats" style="padding:3px 10px;border-radius:999px;background:#1e293b;color:#94a3b8">stats…</span>
      <span id="diag-analytics" style="padding:3px 10px;border-radius:999px;background:#1e293b;color:#94a3b8">analytics…</span>
      <span id="diag-revenue" style="padding:3px 10px;border-radius:999px;background:#1e293b;color:#94a3b8">revenue…</span>
      <span id="diag-users" style="padding:3px 10px;border-radius:999px;background:#1e293b;color:#94a3b8">users…</span>
      <button onclick="runDiag()" style="margin-left:auto;padding:3px 12px;border-radius:6px;background:#1e40af;border:none;color:#fff;font-size:.78rem;cursor:pointer">Re-run</button>
    </div>

    <!-- Stats bar -->
    <div class="sub-stats-bar" id="admin-stats-bar" style="margin-bottom:16px">
      <div class="sub-stat"><span class="sub-stat__label">Total Users</span><span class="sub-stat__val" id="stat-users">…</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Pro Users</span><span class="sub-stat__val" id="stat-pro">…</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Creator Users</span><span class="sub-stat__val" id="stat-creator">…</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Total Jobs</span><span class="sub-stat__val" id="stat-jobs">…</span></div>
      <div class="sub-stat"><span class="sub-stat__label">MRR</span><span class="sub-stat__val" id="stat-mrr">—</span></div>
    </div>

    <!-- Stats error banner — shown on any failure -->
    <div id="admin-stats-err" style="display:none;background:#450a0a;border:2px solid #ef4444;border-radius:8px;padding:12px 18px;margin-bottom:16px;font-size:.85rem;color:#fca5a5;font-family:monospace"></div>

    <!-- Tabs -->
    <div style="display:flex;gap:4px;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:0;flex-wrap:wrap">
      <button class="admin-tab admin-tab--active" data-tab="analytics" onclick="adminTab('analytics')"><i class="fas fa-chart-bar"></i> Analytics</button>
      <button class="admin-tab" data-tab="revenue" onclick="adminTab('revenue')"><i class="fas fa-dollar-sign"></i> Revenue</button>
      <button class="admin-tab" data-tab="users" onclick="adminTab('users')"><i class="fas fa-users"></i> Users</button>
      <button class="admin-tab" data-tab="signups" onclick="adminTab('signups')"><i class="fab fa-google"></i> Signups</button>
      <button class="admin-tab" data-tab="stuckjobs" onclick="adminTab('stuckjobs')" id="stuck-jobs-tab-btn"><i class="fas fa-exclamation-triangle" style="color:#f59e0b"></i> Stuck Jobs</button>
      <button class="admin-tab" data-tab="broadcasts" onclick="adminTab('broadcasts');loadBroadcastStats()"><i class="fas fa-envelope" style="color:#a78bfa"></i> Broadcasts</button>
      <button class="admin-tab" data-tab="security" onclick="adminTab('security')"><i class="fas fa-lock" style="color:#f59e0b"></i> Security</button>
    </div>

    <!-- ANALYTICS TAB -->
    <div id="admin-tab-analytics">
      <div class="sub-stats-bar" style="margin-bottom:28px">
        <div class="sub-stat"><span class="sub-stat__label">Views Today</span><span class="sub-stat__val" id="an-today">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Views This Week</span><span class="sub-stat__val" id="an-week">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Views This Month</span><span class="sub-stat__val" id="an-month">—</span></div>
        <div class="sub-stat" title="Stemforge AI service capacity errors in last 30 days">
          <span class="sub-stat__label"><i class="fas fa-exclamation-triangle" style="color:#f59e0b;margin-right:4px;font-size:.7rem"></i>Server Busy (30d)</span>
          <span class="sub-stat__val" id="an-busy-30d">—</span>
          <span id="an-busy-today" style="display:block;font-size:.7rem;color:var(--muted);margin-top:2px">today: —</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-chart-bar" style="color:var(--primary);margin-right:8px"></i>Daily Page Views (30d)</h3>
          <div id="daily-chart" style="width:100%;min-height:160px;position:relative">
            <p style="color:var(--muted);font-size:.85rem;text-align:center;padding-top:60px"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-share-alt" style="color:#10b981;margin-right:8px"></i>Traffic Sources (30d)</h3>
          <div id="sources-chart"><p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p></div>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:20px">
        <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-globe" style="color:#34d399;margin-right:8px"></i>Top Countries (30d)</h3>
        <div id="countries-chart"><p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p></div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:20px">
        <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-hashtag" style="color:#f59e0b;margin-right:8px"></i>Social Media Breakdown</h3>
        <div id="social-breakdown" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px">
          <p style="color:var(--muted);font-size:.85rem;grid-column:1/-1"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
        <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-file-alt" style="color:#a78bfa;margin-right:8px"></i>Top Pages (30d)</h3>
        <div id="top-pages"><p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p></div>
      </div>
    </div>

    <!-- REVENUE TAB -->
    <div id="admin-tab-revenue" style="display:none">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:28px">
        <div style="background:linear-gradient(135deg,rgba(167,139,250,.15),rgba(99,102,241,.1));border:1px solid rgba(167,139,250,.3);border-radius:14px;padding:22px">
          <div style="font-size:.82rem;color:var(--muted);margin-bottom:4px">Monthly Recurring Revenue</div>
          <div id="rv-mrr" style="font-size:2rem;font-weight:800;color:#a78bfa">—</div>
          <div style="font-size:.78rem;color:var(--muted);margin-top:4px">Active subscriptions</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <div style="font-size:.82rem;color:var(--muted);margin-bottom:4px">Pro Subscribers</div>
          <div id="rv-pro" style="font-size:1.8rem;font-weight:800;color:#10b981">—</div>
          <div style="font-size:.78rem;color:var(--muted);margin-top:4px">× $26/mo</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <div style="font-size:.82rem;color:var(--muted);margin-bottom:4px">Creator Subscribers</div>
          <div id="rv-creator" style="font-size:1.8rem;font-weight:800;color:#3b82f6">—</div>
          <div style="font-size:.78rem;color:var(--muted);margin-top:4px">× $10/mo</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <div style="font-size:.82rem;color:var(--muted);margin-bottom:4px">Free Users</div>
          <div id="rv-free" style="font-size:1.8rem;font-weight:800;color:var(--muted)">—</div>
          <div style="font-size:.78rem;color:var(--muted);margin-top:4px">no revenue</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <h3 style="margin-bottom:18px;font-size:.98rem"><i class="fas fa-calculator" style="color:#10b981;margin-right:8px"></i>Estimated Monthly P&amp;L</h3>
          <table style="width:100%;font-size:.9rem;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:var(--muted);border-bottom:1px solid var(--border10)">Subscription revenue (MRR)</td><td id="rv-pl-mrr" style="text-align:right;font-weight:700;border-bottom:1px solid var(--border10)">—</td></tr>
            <tr><td style="padding:8px 0;color:var(--muted);border-bottom:1px solid var(--border10)">Credit pack revenue</td><td id="rv-pl-credits" style="text-align:right;font-weight:700;border-bottom:1px solid var(--border10)">—</td></tr>
            <tr><td style="padding:8px 0;color:var(--muted);border-bottom:1px solid var(--border10)"><span style="color:#ef4444">−</span> MusicAPI costs (~$0.04/job)</td><td id="rv-pl-musicapi" style="text-align:right;font-weight:700;color:#ef4444;border-bottom:1px solid var(--border10)">—</td></tr>
            <tr><td style="padding:8px 0;color:var(--muted);border-bottom:1px solid var(--border10)"><span style="color:#ef4444">−</span> Cloudflare Workers</td><td style="text-align:right;font-weight:700;color:#10b981;border-bottom:1px solid var(--border10)">$0 (free tier)</td></tr>
            <tr style="background:rgba(16,185,129,.06)"><td style="padding:10px 0 8px;font-weight:700"><i class="fas fa-chart-line" style="color:#10b981"></i> Estimated net profit</td><td id="rv-pl-profit" style="text-align:right;font-weight:800;font-size:1.1rem">—</td></tr>
          </table>
          <div style="font-size:.75rem;color:var(--muted);margin-top:12px;line-height:1.4">* MusicAPI cost ~$0.04/generation. Stripe fees not included.</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <h3 style="margin-bottom:18px;font-size:.98rem"><i class="fas fa-chart-pie" style="color:#f59e0b;margin-right:8px"></i>Revenue Split</h3>
          <div id="rv-pie" style="display:flex;flex-direction:column;gap:10px">
            <p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
          </div>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
        <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-user-check" style="color:#a78bfa;margin-right:8px"></i>Recent Paid Subscribers</h3>
        <div id="rv-subs" style="overflow-x:auto"><p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p></div>
      </div>
    </div>

    <!-- USERS TAB -->
    <div id="admin-tab-users" style="display:none">
      <div id="admin-users-list" style="overflow-x:auto">
        <p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Loading users…</p>
      </div>
    </div>

    <!-- STUCK JOBS TAB -->
    <div id="admin-tab-stuckjobs" style="display:none">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap">
        <button onclick="loadStuckJobs()" class="btn btn--primary btn--sm"><i class="fas fa-sync-alt"></i> Refresh</button>
        <button onclick="rescueStuckJobs()" class="btn btn--sm" style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);color:#f59e0b"><i class="fas fa-wrench"></i> Rescue All Stuck</button>
        <span id="stuck-jobs-summary" style="font-size:.82rem;color:var(--muted)"></span>
      </div>
      <div id="stuck-jobs-list" style="overflow-x:auto">
        <p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Click Refresh to load…</p>
      </div>
    </div>

    <!-- SIGNUPS TAB -->
    <div id="admin-tab-signups" style="display:none">
      <div class="sub-stats-bar" style="margin-bottom:28px">
        <div class="sub-stat"><span class="sub-stat__label">Google Clicks Today</span><span class="sub-stat__val" id="sc-today">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Google Clicks (7d)</span><span class="sub-stat__val" id="sc-week">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Google Clicks (30d)</span><span class="sub-stat__val" id="sc-google30">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Email Clicks (30d)</span><span class="sub-stat__val" id="sc-email30">—</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fab fa-google" style="color:#4285F4;margin-right:8px"></i>Daily Click Trend (30d)</h3>
          <div id="sc-daily-chart" style="width:100%;min-height:160px;position:relative">
            <p style="color:var(--muted);font-size:.85rem;text-align:center;padding-top:60px"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
          <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-chart-pie" style="color:#a78bfa;margin-right:8px"></i>Click Breakdown</h3>
          <div id="sc-breakdown"><p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p></div>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px">
        <h3 style="margin-bottom:16px;font-size:.98rem"><i class="fas fa-history" style="color:#f59e0b;margin-right:8px"></i>Recent Click Events (last 50)</h3>
        <div id="sc-recent" style="overflow-x:auto"><p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p></div>
      </div>
    </div>

  </div>

    <!-- BROADCASTS TAB -->
    <div id="admin-tab-broadcasts" style="display:none">
      <!-- Subscriber counts -->
      <div class="sub-stats-bar" style="margin-bottom:24px">
        <div class="sub-stat"><span class="sub-stat__label">All Email Subscribers</span><span class="sub-stat__val" id="bc-count-all">…</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Free Plan</span><span class="sub-stat__val" id="bc-count-free">…</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Paid Plan</span><span class="sub-stat__val" id="bc-count-paid">…</span></div>
      </div>

      <!-- Saved Templates Panel -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h3 style="margin:0;font-size:.95rem"><i class="fas fa-folder-open" style="color:#f59e0b;margin-right:8px"></i>Saved Templates</h3>
          <div style="display:flex;gap:8px">
            <button onclick="bcOpenNew()" class="btn btn--outline btn--sm" style="border-color:#10b981;color:#10b981"><i class="fas fa-plus"></i> New Template</button>
            <button onclick="bcLoadTemplates()" class="btn btn--outline btn--sm"><i class="fas fa-sync-alt"></i> Refresh</button>
          </div>
        </div>
        <div id="bc-templates-list" style="display:flex;flex-wrap:wrap;gap:10px">
          <p style="color:var(--muted);font-size:.85rem;margin:0"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
        </div>
      </div>

      <!-- Builder + Preview (hidden until user clicks Edit or New Template) -->
      <div id="bc-builder-wrap" style="display:none">
      <div style="display:grid;grid-template-columns:1fr 380px;gap:24px;align-items:start">

        <!-- LEFT: Template Builder -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
            <h3 style="margin:0;font-size:1rem"><i class="fas fa-paint-brush" style="color:#a78bfa;margin-right:8px"></i>Email Template Builder</h3>
            <div style="display:flex;gap:8px">
              <button onclick="bcSaveTemplate()" class="btn btn--outline btn--sm" style="border-color:#f59e0b;color:#f59e0b"><i class="fas fa-save"></i> Save Template</button>
              <button onclick="bcCloseBuilder()" style="background:none;border:1px solid #475569;color:#94a3b8;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:.88rem" title="Close builder"><i class="fas fa-times"></i></button>
            </div>
          </div>
          <!-- Template Name -->
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:.82rem;color:var(--muted);margin-bottom:6px;font-weight:600">Template Name</label>
            <input id="bc-template-name" type="text" placeholder="e.g. Welcome Email, Monthly Update…" style="width:100%;padding:9px 14px;background:#0f172a;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.88rem;box-sizing:border-box"/>
          </div>
          <!-- Subject -->
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:.82rem;color:var(--muted);margin-bottom:6px;font-weight:600">Subject Line</label>
            <input id="bc-subject" type="text" placeholder="e.g. New beat dropped on StemForge 🔥" style="width:100%;padding:10px 14px;background:#0f172a;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;box-sizing:border-box"/>
          </div>

          <!-- Global Style Controls -->
          <div style="background:#0f172a;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:16px">
            <div style="font-size:.78rem;color:var(--muted);font-weight:600;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Email Style</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div>
                <label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:4px">Background</label>
                <input type="color" id="bc-bg-color" value="#0d0d1a" oninput="bcUpdatePreview()" style="width:100%;height:32px;border-radius:6px;border:1px solid var(--border);background:none;cursor:pointer"/>
              </div>
              <div>
                <label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:4px">Text Color</label>
                <input type="color" id="bc-text-color" value="#e2e8f0" oninput="bcUpdatePreview()" style="width:100%;height:32px;border-radius:6px;border:1px solid var(--border);background:none;cursor:pointer"/>
              </div>
              <div>
                <label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:4px">Accent Color</label>
                <input type="color" id="bc-accent-color" value="#4e9fff" oninput="bcUpdatePreview()" style="width:100%;height:32px;border-radius:6px;border:1px solid var(--border);background:none;cursor:pointer"/>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
              <div>
                <label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:4px">Font Family</label>
                <select id="bc-font" onchange="bcUpdatePreview()" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.82rem">
                  <option value="Inter,system-ui,sans-serif">Inter (Modern)</option>
                  <option value="Georgia,serif">Georgia (Classic)</option>
                  <option value="'Courier New',monospace">Courier (Mono)</option>
                  <option value="Arial,sans-serif">Arial (Clean)</option>
                  <option value="'Times New Roman',serif">Times New Roman</option>
                </select>
              </div>
              <div>
                <label style="font-size:.75rem;color:var(--muted);display:block;margin-bottom:4px">Email Width</label>
                <select id="bc-width" onchange="bcUpdatePreview()" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.82rem">
                  <option value="600px">600px (Standard)</option>
                  <option value="500px">500px (Compact)</option>
                  <option value="700px">700px (Wide)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Block Toolbar -->
          <div style="font-size:.78rem;color:var(--muted);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Add Content Block</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
            <button onclick="bcAddBlock('header')" class="btn btn--outline btn--sm"><i class="fas fa-heading"></i> Header</button>
            <button onclick="bcAddBlock('text')" class="btn btn--outline btn--sm"><i class="fas fa-paragraph"></i> Text</button>
            <button onclick="bcAddBlock('image')" class="btn btn--outline btn--sm"><i class="fas fa-image"></i> Image</button>
            <button onclick="bcAddBlock('button')" class="btn btn--outline btn--sm"><i class="fas fa-mouse-pointer"></i> Button</button>
            <button onclick="bcAddBlock('youtube')" class="btn btn--outline btn--sm"><i class="fab fa-youtube" style="color:#ef4444"></i> YouTube</button>
            <button onclick="bcAddBlock('divider')" class="btn btn--outline btn--sm"><i class="fas fa-minus"></i> Divider</button>
            <button onclick="bcAddBlock('spacer')" class="btn btn--outline btn--sm"><i class="fas fa-arrows-alt-v"></i> Spacer</button>
          </div>

          <!-- Blocks Container -->
          <div id="bc-blocks" style="min-height:120px;border:2px dashed var(--border);border-radius:10px;padding:12px;margin-bottom:16px">
            <p id="bc-blocks-empty" style="color:var(--muted);font-size:.85rem;text-align:center;padding:24px 0"><i class="fas fa-plus-circle" style="margin-right:6px"></i>Click a block above to start building</p>
          </div>

          <!-- Audience + Send -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-size:.82rem;color:var(--muted);display:block;margin-bottom:6px;font-weight:600">Send To</label>
              <select id="bc-audience" style="width:100%;padding:10px 12px;background:#0f172a;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.88rem">
                <option value="none" selected disabled style="color:#ef4444">— Do Not Send (select audience first) —</option>
                <option value="all">All Users</option>
                <option value="free">Free Plan Only</option>
                <option value="paid">Paid Plan Only</option>
              </select>
            </div>
          </div>
          <div style="display:flex;gap:10px">
            <button onclick="bcSendBroadcast()" class="btn btn--primary" style="flex:1"><i class="fas fa-broadcast-tower"></i> Send to List</button>
          </div>
          <div id="bc-status" style="margin-top:12px;font-size:.85rem;display:none"></div>

          <!-- ── Send to Individual User ─────────────────────────────── -->
          <div style="margin-top:18px;border:1px solid var(--border);border-radius:10px;overflow:hidden">
            <!-- Collapsible header -->
            <button onclick="bcToggleIndividual()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#0f172a;border:none;cursor:pointer;text-align:left">
              <span style="display:flex;align-items:center;gap:10px">
                <i class="fas fa-user" style="color:#a78bfa;font-size:.9rem"></i>
                <span style="font-size:.88rem;font-weight:600;color:var(--text)">Send to Individual User</span>
                <span style="font-size:.75rem;color:var(--muted)">— search by name or email</span>
              </span>
              <i id="bc-individual-chevron" class="fas fa-chevron-down" style="color:var(--muted);font-size:.8rem;transition:transform .2s"></i>
            </button>

            <!-- Collapsible body -->
            <div id="bc-individual-body" style="display:none;padding:14px 16px;background:#080f1c;border-top:1px solid var(--border)">

              <!-- Search input -->
              <div style="position:relative;margin-bottom:10px">
                <i class="fas fa-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.82rem"></i>
                <input type="text" placeholder="Search by name or email…" oninput="bcSearchUsers(this.value)"
                  style="width:100%;padding:9px 12px 9px 32px;background:#0f172a;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.85rem;box-sizing:border-box"/>
              </div>

              <!-- User list -->
              <div id="bc-user-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;background:#0a1628">
                <div style="padding:20px;text-align:center;color:var(--muted);font-size:.85rem">Open to load users</div>
              </div>

              <!-- Selected user badge -->
              <div id="bc-selected-user" style="display:none;margin-top:12px;padding:10px 14px;background:rgba(78,159,255,.08);border:1px solid rgba(78,159,255,.25);border-radius:8px">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <div>
                    <div style="font-size:.85rem;font-weight:600;color:#e2e8f0" id="bc-selected-name"></div>
                    <div style="font-size:.78rem;color:#64748b" id="bc-selected-email"></div>
                  </div>
                  <button onclick="bcClearSelectedUser()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.85rem;padding:4px 8px"><i class="fas fa-times"></i> Clear</button>
                </div>
              </div>

              <!-- Status + Send button -->
              <div id="bc-individual-status" style="display:none;margin-top:10px;font-size:.83rem"></div>
              <button onclick="bcSendToUser()" style="margin-top:12px;width:100%;padding:10px;background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.4);border-radius:8px;color:#c084fc;font-size:.88rem;font-weight:600;cursor:pointer">
                <i class="fas fa-paper-plane" style="margin-right:6px"></i>Send to Selected User
              </button>
            </div>
          </div>
          <!-- ── /Send to Individual ──────────────────────────────────── -->

        </div>

        <!-- RIGHT: Live Preview -->
        <div style="position:sticky;top:20px">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px">
            <h3 style="margin:0 0 14px;font-size:.95rem"><i class="fas fa-eye" style="color:#10b981;margin-right:8px"></i>Live Preview</h3>
            <div style="background:#1e293b;border-radius:8px;padding:4px;overflow:hidden">
              <!-- Email client chrome mockup -->
              <div style="background:#0f172a;border-radius:6px;padding:10px 14px;margin-bottom:4px;font-size:.75rem;color:#64748b">
                <div><strong style="color:#94a3b8">From:</strong> StemForge &lt;noreply@stemforge.studio&gt;</div>
                <div id="bc-preview-subject-line" style="margin-top:3px"><strong style="color:#94a3b8">Subject:</strong> <span style="color:#e2e8f0"></span></div>
              </div>
              <div id="bc-preview-frame" style="background:#fff;border-radius:6px;overflow:auto;max-height:600px;min-height:200px">
                <p style="text-align:center;padding:40px 20px;color:#94a3b8;font-size:.85rem;font-family:sans-serif">Preview will appear here as you build</p>
              </div>
            </div>
          </div>
        </div>

      </div>
      </div><!-- /bc-builder-wrap -->

      <!-- Broadcast History -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;margin-top:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0;font-size:.95rem"><i class="fas fa-history" style="color:#4e9fff;margin-right:8px"></i>Broadcast History</h3>
          <button onclick="bcLoadHistory()" class="btn btn--outline btn--sm"><i class="fas fa-sync-alt"></i> Refresh</button>
        </div>
        <div id="bc-history-table">
          <p style="color:var(--muted);font-size:.85rem;margin:0"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
        </div>
      </div>
    </div>

    <!-- ── SECURITY TAB ─────────────────────────────────────────────────────── -->
    <div id="admin-tab-security" style="display:none">
      <div style="max-width:540px;display:flex;flex-direction:column;gap:20px">

        <!-- Change admin email/username -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px">
          <h3 style="margin:0 0 6px;font-size:.97rem;display:flex;align-items:center;gap:8px">
            <i class="fas fa-user-shield" style="color:#a78bfa"></i> Admin Identity
          </h3>
          <p style="color:var(--muted);font-size:.82rem;margin:0 0 18px;line-height:1.5">
            The email address used to identify the admin account. Changing this updates the <code style="background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px">ADMIN_EMAIL</code> check — you must also be logged in with this email to access admin routes.
          </p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div>
              <label style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">Current admin email</label>
              <div style="font-size:.9rem;font-weight:600;color:#a78bfa;padding:8px 12px;background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.2);border-radius:8px" id="sec-current-email">Loading…</div>
            </div>
            <div>
              <label style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">New admin email</label>
              <input type="email" id="sec-new-email" placeholder="new@email.com"
                style="width:100%;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;box-sizing:border-box"/>
            </div>
          </div>
          <div id="sec-email-msg" style="display:none;margin-top:10px;font-size:.82rem;padding:8px 12px;border-radius:8px"></div>
          <button onclick="secChangeEmail()" style="margin-top:14px;padding:9px 20px;background:rgba(167,139,250,.15);border:1px solid rgba(167,139,250,.4);border-radius:8px;color:#c084fc;font-size:.88rem;font-weight:600;cursor:pointer">
            <i class="fas fa-save" style="margin-right:6px"></i>Update Admin Email
          </button>
        </div>

        <!-- Change password -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px">
          <h3 style="margin:0 0 6px;font-size:.97rem;display:flex;align-items:center;gap:8px">
            <i class="fas fa-key" style="color:#f59e0b"></i> Admin Password
          </h3>
          <p style="color:var(--muted);font-size:.82rem;margin:0 0 18px;line-height:1.5">
            Change the password for your admin account (<strong id="sec-pw-email-label">andrewsmusiclab@gmail.com</strong>). This updates the password stored in the user database.
          </p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div id="sec-cur-pw-row" style="display:none">
              <label style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">Current password</label>
              <div style="position:relative">
                <input type="password" id="sec-cur-pw" placeholder="Current password"
                  style="width:100%;padding:9px 40px 9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;box-sizing:border-box"/>
                <button type="button" onclick="secTogglePw('sec-cur-pw','sec-eye-cur')" tabindex="-1"
                  style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 4px;font-size:.9rem">
                  <i id="sec-eye-cur" class="fas fa-eye"></i>
                </button>
              </div>
            </div>
            <div>
              <label style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">New password</label>
              <div style="position:relative">
                <input type="password" id="sec-new-pw" placeholder="New password (min 6 chars)"
                  style="width:100%;padding:9px 40px 9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;box-sizing:border-box"/>
                <button type="button" onclick="secTogglePw('sec-new-pw','sec-eye-new')" tabindex="-1"
                  style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 4px;font-size:.9rem">
                  <i id="sec-eye-new" class="fas fa-eye"></i>
                </button>
              </div>
            </div>
            <div>
              <label style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">Confirm new password</label>
              <div style="position:relative">
                <input type="password" id="sec-confirm-pw" placeholder="Repeat new password"
                  style="width:100%;padding:9px 40px 9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;box-sizing:border-box"/>
                <button type="button" onclick="secTogglePw('sec-confirm-pw','sec-eye-confirm')" tabindex="-1"
                  style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 4px;font-size:.9rem">
                  <i id="sec-eye-confirm" class="fas fa-eye"></i>
                </button>
              </div>
            </div>
          </div>
          <div id="sec-pw-msg" style="display:none;margin-top:10px;font-size:.82rem;padding:8px 12px;border-radius:8px"></div>
          <button onclick="secChangePassword()" style="margin-top:14px;padding:9px 20px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);border-radius:8px;color:#fcd34d;font-size:.88rem;font-weight:600;cursor:pointer">
            <i class="fas fa-key" style="margin-right:6px"></i><span id="sec-pw-action-label">Set Password</span>
          </button>
        </div>

        <!-- Info box -->
        <div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:12px;padding:16px 18px;font-size:.82rem;color:#94a3b8;line-height:1.6">
          <p style="margin:0 0 6px;font-weight:600;color:#60a5fa"><i class="fas fa-info-circle" style="margin-right:5px"></i>How admin access works</p>
          <ul style="margin:0;padding:0 0 0 16px">
            <li>Admin is identified by the <code style="background:rgba(255,255,255,.07);padding:1px 4px;border-radius:3px">ADMIN_EMAIL</code> environment secret</li>
            <li>Logging in with that email automatically grants admin access — no special plan needed</li>
            <li>The password is stored securely in the user database (PBKDF2 + SHA-256)</li>
            <li>Admin routes are server-side protected — changing email here also requires updating the <code style="background:rgba(255,255,255,.07);padding:1px 4px;border-radius:3px">ADMIN_EMAIL</code> secret via Cloudflare dashboard</li>
          </ul>
        </div>

      </div>

      <script>
      // Track whether this account already has a password set
      var _secHasPassword = false;

      // Load current admin email + password state when tab opens
      async function secLoadInfo() {
        try {
          const r = await fetch('/api/auth/me', { credentials: 'include' });
          const d = await r.json();
          const el = document.getElementById('sec-current-email');
          const lbl = document.getElementById('sec-pw-email-label');
          if (el)  el.textContent  = (d.user && d.user.email) || '—';
          if (lbl) lbl.textContent = (d.user && d.user.email) || '—';
          // Show/hide current-password row based on whether account has a password
          _secHasPassword = !!(d.user && d.user.has_password);
          var curRow = document.getElementById('sec-cur-pw-row');
          if (curRow) curRow.style.display = _secHasPassword ? 'block' : 'none';
          // Update label to clarify first-time setup
          var lbl2 = document.getElementById('sec-pw-action-label');
          if (lbl2) lbl2.textContent = _secHasPassword ? 'Change Password' : 'Set Password';
        } catch {}
      }
      secLoadInfo();

      function secTogglePw(inputId, iconId) {
        var inp = document.getElementById(inputId);
        var ico = document.getElementById(iconId);
        if (!inp) return;
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        if (ico) { ico.className = show ? 'fas fa-eye-slash' : 'fas fa-eye'; }
      }

      function secMsg(elId, msg, ok) {
        var el = document.getElementById(elId);
        if (!el) return;
        el.textContent = msg;
        el.style.display = 'block';
        el.style.background = ok ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)';
        el.style.border     = ok ? '1px solid rgba(16,185,129,.3)' : '1px solid rgba(239,68,68,.3)';
        el.style.color      = ok ? '#6ee7b7' : '#fca5a5';
      }

      async function secChangePassword() {
        var cur     = _secHasPassword ? document.getElementById('sec-cur-pw').value.trim() : '';
        var nw      = document.getElementById('sec-new-pw').value;
        var confirm = document.getElementById('sec-confirm-pw').value;
        if (_secHasPassword && !cur) { secMsg('sec-pw-msg','Current password is required.',false); return; }
        if (!nw || !confirm)         { secMsg('sec-pw-msg','Please fill in the new password fields.',false); return; }
        if (nw.length < 6)           { secMsg('sec-pw-msg','New password must be at least 6 characters.',false); return; }
        if (nw !== confirm)          { secMsg('sec-pw-msg','New passwords do not match.',false); return; }
        try {
          var res = await fetch('/api/admin/security/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ current_password: cur, new_password: nw })
          });
          var d = await res.json();
          if (d.ok) {
            secMsg('sec-pw-msg', _secHasPassword ? '✅ Password updated successfully.' : '✅ Password set successfully! You can now log in with this password.', true);
            document.getElementById('sec-cur-pw').value = '';
            document.getElementById('sec-new-pw').value = '';
            document.getElementById('sec-confirm-pw').value = '';
            // Now account has a password — show current-password field for future changes
            _secHasPassword = true;
            var curRow = document.getElementById('sec-cur-pw-row');
            if (curRow) curRow.style.display = 'block';
            var lbl2 = document.getElementById('sec-pw-action-label');
            if (lbl2) lbl2.textContent = 'Change Password';
          } else {
            secMsg('sec-pw-msg', d.error || 'Password change failed.', false);
          }
        } catch(e) {
          secMsg('sec-pw-msg', 'Network error — please try again.', false);
        }
      }

      async function secChangeEmail() {
        var newEmail = document.getElementById('sec-new-email').value.trim().toLowerCase();
        if (!newEmail || !newEmail.includes('@')) { secMsg('sec-email-msg','Enter a valid email address.',false); return; }
        try {
          var res = await fetch('/api/admin/security/change-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ new_email: newEmail })
          });
          var d = await res.json();
          if (d.ok) {
            secMsg('sec-email-msg', '✅ Admin email updated in DB. Remember to also update ADMIN_EMAIL secret in Cloudflare dashboard.', true);
            document.getElementById('sec-new-email').value = '';
            secLoadInfo();
          } else {
            secMsg('sec-email-msg', d.error || 'Failed to update email.', false);
          }
        } catch(e) {
          secMsg('sec-email-msg', 'Network error — please try again.', false);
        }
      }
      </script>
    </div>
    <!-- ── /SECURITY TAB ────────────────────────────────────────────────────── -->

  </div>
</main>
<style>
.admin-tab{padding:10px 16px;background:none;border:none;border-bottom:3px solid transparent;color:var(--muted);cursor:pointer;font-size:.88rem;font-weight:600;transition:all .2s;white-space:nowrap}
.admin-tab--active{color:var(--primary);border-bottom-color:var(--primary)}
.admin-table{width:100%;border-collapse:collapse;font-size:.88rem}
.admin-table th{text-align:left;padding:10px 12px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600}
.admin-table td{padding:10px 12px;border-bottom:1px solid var(--border10)}
.admin-table tr:hover td{background:var(--surface)}
.rv-bar-wrap{display:flex;align-items:center;gap:10px;font-size:.85rem}
.rv-bar-track{flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden}
.rv-bar-fill{height:100%;border-radius:4px;transition:width .5s}
</style>
<script src="/static/admin.v2.js?v=${ASSET_VER}"></script>

<!-- Admin user modal -->
<div id="umod-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;align-items:center;justify-content:center">
  <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:28px 32px;width:100%;max-width:420px;position:relative">
    <button onclick="umodClose()" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>
    <h3 id="umod-title" style="font-size:1.1rem;font-weight:700;margin-bottom:20px"></h3>
    <input type="hidden" id="umod-user-id"/>
    <div id="umod-plan-section">
      <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:6px">New plan</label>
      <input id="umod-plan" type="text" placeholder="free / creator / pro / developer" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.95rem;box-sizing:border-box"/>
    </div>
    <div id="umod-credits-section">
      <label style="font-size:.85rem;color:var(--muted);display:block;margin-bottom:6px">Points to add</label>
      <input id="umod-amount" type="number" min="1" placeholder="e.g. 500" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.95rem;box-sizing:border-box"/>
      <p style="font-size:.78rem;color:var(--muted);margin-top:6px">This amount is <strong>added on top</strong> of the user's current limit.</p>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px;align-items:center">
      <button class="btn btn--primary" onclick="umodSave()"><i class="fas fa-check"></i> Save</button>
      <button class="btn btn--outline" onclick="umodClose()">Cancel</button>
      <span id="umod-status" style="font-size:.82rem;flex:1;text-align:right"></span>
    </div>
  </div>
</div>`)
}

function accountPage(user: User) {
  const hasGoogle = !!(user as any).google_id
  const initials = user.name.split(' ').map((n:string)=>n[0]).join('').toUpperCase().slice(0,2)
  return shell('Account Settings', `
<main class="inner-page gs-content account-page">
  <div class="container">
    <h1>Account Settings</h1>
    <div class="account-grid">
      <div class="account-card">
        <h3>Profile</h3>
        <div class="account-avatar-row">
          ${user.avatar
            ? `<img src="${user.avatar}" class="account-avatar" alt="${user.name}"/>`
            : `<div class="account-avatar account-avatar--initials">${initials}</div>`
          }
          <div>
            <strong>${user.name}</strong>
            <p style="margin:2px 0 0;font-size:13px;color:var(--muted)">${user.email}</p>
          </div>
        </div>
        <div class="account-field">
          <label>Email</label>
          <div class="account-field__val">${user.email}</div>
        </div>
        <div class="account-field">
          <label>Member since</label>
          <div class="account-field__val">${new Date(user.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
        </div>
      </div>
      <div class="account-card account-card--danger-zone">
        <h3><i class="fas fa-user-slash" style="color:var(--danger);margin-right:8px"></i>Delete Account</h3>
        <p style="color:var(--muted);font-size:.88rem;margin:0 0 16px;line-height:1.5">Permanently delete your account and all associated data including beats, library, and billing info. This action <strong>cannot be undone</strong>.</p>
        <button class="btn btn--sm" id="delete-account-btn"
          style="background:transparent;border:1px solid var(--danger);color:var(--danger);font-weight:600"
          onclick="showDeleteAccountModal()">
          <i class="fas fa-trash-alt"></i> Delete My Account
        </button>
      </div>

      <!-- Delete Account Modal -->
      <div id="delete-account-modal" style="display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px">
        <div style="background:var(--surface);border:1px solid rgba(255,60,60,.3);border-radius:18px;padding:32px 28px;max-width:420px;width:100%;text-align:center;position:relative">
          <div style="width:56px;height:56px;border-radius:50%;background:rgba(239,68,68,.15);border:2px solid var(--danger);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:1.4rem;color:var(--danger)">
            <i class="fas fa-exclamation-triangle"></i>
          </div>
          <h3 style="font-size:1.15rem;margin-bottom:8px;color:var(--danger)">Delete Account Permanently?</h3>
          <p style="color:var(--muted);font-size:.88rem;margin-bottom:20px;line-height:1.5">This will permanently delete your account, all your beats, and cancel any active subscription. Type <strong>DELETE</strong> to confirm.</p>
          <input type="text" id="delete-confirm-input" placeholder="Type DELETE to confirm"
            style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem;margin-bottom:14px;box-sizing:border-box;text-align:center;letter-spacing:.05em"/>
          <div id="delete-account-error" style="color:var(--danger);font-size:.82rem;margin-bottom:12px;display:none"></div>
          <div style="display:flex;gap:10px;justify-content:center">
            <button class="btn btn--outline btn--sm" onclick="closeDeleteAccountModal()" style="flex:1">Cancel</button>
            <button class="btn btn--sm" id="delete-account-confirm-btn" style="flex:1;background:var(--danger);border:none;color:#fff;font-weight:700" onclick="confirmDeleteAccount()">
              <i class="fas fa-trash-alt"></i> Delete Forever
            </button>
          </div>
        </div>
      </div>
      <div class="account-card">
        <h3>Subscription</h3>
        <div class="account-field">
          <label>Current plan</label>
          <div class="account-field__val">
            <span class="plan-badge ${user.plan === 'pro' ? 'plan-badge--pro' : user.plan === 'creator' ? 'plan-badge--creator' : ''}">
              ${user.plan === 'pro' ? 'Pro Artist' : user.plan === 'creator' ? 'Creator' : 'Free'}
            </span>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
          <a href="/subscription" class="btn btn--outline btn--sm">Manage subscription</a>
          ${user.plan !== 'free' && user.plan !== 'developer' ? `
          <button class="btn btn--sm" id="account-cancel-sub-btn"
            style="background:transparent;border:1px solid rgba(255,100,100,.5);color:#ff7070;font-weight:600"
            onclick="showCancelSubscriptionModal()">
            <i class="fas fa-times-circle" style="margin-right:5px"></i>Cancel Subscription
          </button>` : ''}
        </div>
        ${user.plan !== 'free' && user.plan !== 'developer' ? `
        <p style="font-size:.78rem;color:var(--muted);margin-top:10px;line-height:1.5">
          <i class="fas fa-info-circle" style="margin-right:3px;opacity:.6"></i>
          Cancelling keeps your plan active until the end of your billing period, then moves you to Free.
        </p>` : ''}
      </div>

      <!-- Cancel Subscription Modal -->
      <div id="cancel-sub-modal" style="display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px">
        <div style="background:var(--surface);border:1px solid rgba(255,100,100,.25);border-radius:18px;padding:32px 28px;max-width:440px;width:100%;text-align:center;position:relative">
          <div style="width:52px;height:52px;border-radius:50%;background:rgba(255,100,100,.12);border:2px solid rgba(255,100,100,.4);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:1.3rem;color:#ff7070">
            <i class="fas fa-times-circle"></i>
          </div>
          <h3 style="font-size:1.1rem;margin-bottom:8px">Cancel Your Subscription?</h3>
          <p style="color:var(--muted);font-size:.88rem;margin-bottom:12px;line-height:1.6">
            You will keep full access to your current plan features until the end of your billing period.
            After that, your account moves to the <strong>Free plan</strong> (5 points/month).
          </p>
          <div style="background:rgba(255,100,100,.07);border:1px solid rgba(255,100,100,.18);border-radius:10px;padding:12px 16px;margin-bottom:20px;text-align:left">
            <p style="margin:0 0 6px;font-size:.82rem;color:#ff9090;font-weight:600"><i class="fas fa-exclamation-triangle" style="margin-right:5px"></i>What you'll lose on Free:</p>
            <ul style="margin:0;padding:0 0 0 18px;color:var(--muted);font-size:.81rem;line-height:1.8">
              <li>Unlimited generations → 5 points/month</li>
              <li>Download access (must upgrade to download)</li>
              <li>Commercial use rights</li>
              <li>Song Extend, Stem tools & one-shots</li>
            </ul>
          </div>
          <div id="cancel-sub-error" style="display:none;color:#ff7070;font-size:.83rem;margin-bottom:12px;padding:8px 12px;background:rgba(255,100,100,.08);border-radius:8px"></div>
          <div style="display:flex;gap:10px;justify-content:center">
            <button class="btn btn--outline btn--sm" style="flex:1" onclick="closeCancelSubscriptionModal()">Keep My Plan</button>
            <button class="btn btn--sm" id="cancel-sub-confirm-btn"
              style="flex:1;background:rgba(255,60,60,.15);border:1px solid rgba(255,100,100,.5);color:#ff7070;font-weight:700"
              onclick="confirmCancelSubscription()">
              <i class="fas fa-times-circle"></i> Yes, Cancel
            </button>
          </div>
        </div>
      </div>

      <script>
      function showCancelSubscriptionModal() {
        var err = document.getElementById('cancel-sub-error');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
        var btn = document.getElementById('cancel-sub-confirm-btn');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-times-circle"></i> Yes, Cancel'; }
        document.getElementById('cancel-sub-modal').style.display = 'flex';
      }
      function closeCancelSubscriptionModal() {
        document.getElementById('cancel-sub-modal').style.display = 'none';
      }
      async function confirmCancelSubscription() {
        var btn = document.getElementById('cancel-sub-confirm-btn');
        var err = document.getElementById('cancel-sub-error');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling…';
        err.style.display = 'none';
        try {
          var res = await fetch('/api/subscription/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          var data = await res.json();
          closeCancelSubscriptionModal();
          if (data.ok) {
            alert(data.message || 'Subscription cancelled. You keep access until the end of your billing period.');
            window.location.reload();
          } else {
            err.textContent = data.error || 'Could not cancel subscription.';
            err.style.display = 'block';
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-times-circle"></i> Yes, Cancel';
          }
        } catch(e) {
          err.textContent = 'Network error. Please try again.';
          err.style.display = 'block';
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-times-circle"></i> Yes, Cancel';
        }
      }
      // Close on backdrop click
      document.getElementById('cancel-sub-modal').addEventListener('click', function(e) {
        if (e.target === this) closeCancelSubscriptionModal();
      });
      </script>
      <div class="account-card">
        <h3>Security</h3>
        <div class="account-field">
          <label>Password</label>
          <div class="account-field__val">••••••••</div>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-top:8px">Password changes via email reset coming soon.</p>
        <div class="account-danger">
          <h4>Danger zone</h4>
          <button class="btn btn--outline btn--sm" style="border-color:var(--danger);color:var(--danger)" id="signout-all-btn">
            <i class="fas fa-sign-out-alt"></i> Sign out everywhere
          </button>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:8px">To permanently delete your account, use the <strong>Delete Account</strong> section above.</p>
      </div>

      <!-- Admin panel link — only rendered/shown to admin users via JS -->
      <div class="account-card" id="account-admin-card" style="display:none;border-color:rgba(167,139,250,.25);background:linear-gradient(135deg,rgba(167,139,250,.06),rgba(139,92,246,.04))">
        <h3 style="display:flex;align-items:center;gap:10px">
          <i class="fas fa-shield-alt" style="color:#a78bfa;font-size:1rem"></i>
          Admin Panel
        </h3>
        <p style="font-size:.85rem;color:var(--muted);margin:0 0 14px;line-height:1.5">
          Access the StemForge admin dashboard — users, analytics, broadcasts, and revenue.
        </p>
        <a href="/admin" class="btn btn--sm" style="background:linear-gradient(135deg,#7c3aed,#a78bfa);border:none;color:#fff;font-weight:700;display:inline-flex;align-items:center;gap:8px;text-decoration:none">
          <i class="fas fa-shield-alt"></i> Open Admin Panel
        </a>
      </div>
    </div>
  </div>
</main>
<script>
// Show admin card only for admin users
(async function() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    if (d.user && d.user.is_admin) {
      const card = document.getElementById('account-admin-card');
      if (card) card.style.display = 'block';
    }
  } catch {}
})();
</script>`)
}

// ─── LEGAL PAGES HELPER ──────────────────────────────────────────────────────
function legalShell(title: string, lastUpdated: string, content: string) {
  return shell(title, `
<main class="inner-page gs-content">
  <div class="legal-wrap">
    <div class="legal-header">
      <div class="legal-header__tag">Legal</div>
      <h1>${title}</h1>
      <p class="legal-header__meta">Last updated: ${lastUpdated} · Effective immediately upon posting</p>
    </div>
    <div class="legal-body">
      ${content}
    </div>
    <div class="legal-footer">
      <p>Questions? Email us at <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a></p>
      <div class="legal-footer__links">
        <a href="/terms">Terms of Service</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/">Home</a>
      </div>
    </div>
  </div>
</main>`)
}

// ─── TERMS OF SERVICE ─────────────────────────────────────────────────────────
function termsPage() {
  return legalShell('Terms of Service', 'June 7, 2025', `
<section>
  <h2>1. Acceptance of Terms</h2>
  <p>Welcome to <strong>StemForge</strong> ("StemForge," "we," "our," or "us"). By accessing or using our website at <a href="https://stemforge.studio">stemforge.studio</a>, our beat generation platform, or any related services (collectively, the "Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, do not use our Service.</p>
  <p>We reserve the right to modify these Terms at any time. We will provide notice of significant changes by updating the "Last Updated" date above or sending an email to registered users. Your continued use of the Service after such changes constitutes your acceptance of the revised Terms.</p>
</section>

<section>
  <h2>2. The Service</h2>
  <p>StemForge is a music beat generation platform that allows users to create original instrumental beats and audio tracks. The Service includes:</p>
  <ul>
    <li>StemForge beat generation using text prompts, style descriptors, and musical parameters</li>
    <li>Stereo mix downloads (WAV — lossless)</li>
    <li>Stemforge Remix — reinvent any existing beat in your library (Pro Artist &amp; higher)</li>
    <li>Project storage, dashboard, and playback functionality</li>
    <li>Account management including profile, subscription, and billing tools</li>
  </ul>
  <p>We use third-party providers to power our generation pipeline. Output quality and availability depend on these services and may vary.</p>
</section>

<section>
  <h2>3. Eligibility & Accounts</h2>
  <p>You must be at least <strong>13 years old</strong> (or the minimum age required in your country) to use the Service. By creating an account, you represent that you meet this requirement.</p>
  <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You agree to:</p>
  <ul>
    <li>Provide accurate, current, and complete information during registration</li>
    <li>Promptly update your account information if it changes</li>
    <li>Notify us immediately of any unauthorized access to your account</li>
    <li>Not share your account with others or allow others to access your account</li>
  </ul>
  <p>We reserve the right to suspend or terminate accounts that violate these Terms, at our sole discretion.</p>

  <h3>3.1 One Account Per Person / Household</h3>
  <p><strong>Each user is permitted one (1) free account.</strong> Creating multiple free accounts to circumvent point limits, trial restrictions, or any other platform limits is a violation of these Terms and grounds for immediate account suspension.</p>
  <p>To enforce this policy, we record the IP address used at the time of account registration. If our systems detect that a free account has already been created from the same network or IP address, the new registration will be declined with an appropriate notice. If you believe this restriction has been applied in error (e.g., you share a network with a family member or roommate who already has an account), please contact us at <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a> and we will review your case manually.</p>
  <p>This restriction applies to free accounts only. There is no limit on the number of paid accounts that may be created from the same household.</p>
  <p>We may use additional signals — including device fingerprinting, behavioral patterns, and account metadata — to identify and remove accounts that circumvent this policy through the use of VPNs, proxy services, or other technical means.</p>
</section>

<section>
  <h2>4. Subscriptions, Credits & Billing</h2>
  <h3>4.1 Free Plan</h3>
  <p>Free accounts receive 50 points per month at no charge (enough for 2 beats). Free generations include the full stereo mix. No credit card is required to start.</p>

  <h3>4.2 Paid Plans</h3>
  <p>We offer the following paid subscription tiers, billed monthly:</p>
  <ul>
    <li><strong>Creator Plan ($10/month):</strong> 900 points monthly, Auto Split (30 pts), Vocals &amp; Instrumental (70 pts), WAV download, One Shot Creator (15 pts), commercial use rights</li>
    <li><strong>Pro Artist Plan ($26/month):</strong> 2,000 points monthly, all split modes, WAV download, commercial use rights, priority queue, Stemforge Remix, Extend song</li>
  </ul>

  <h3>4.3 Billing & Renewal</h3>
  <p>Paid plans are billed monthly via Stripe. Subscriptions automatically renew unless cancelled before the next billing date. You authorize us to charge your payment method on file for recurring subscription fees and any overage charges.</p>

  <h3>4.4 Refunds</h3>
  <p>All sales are final. We do not offer refunds for monthly subscription charges or individual generation points consumed. If you believe a charge was made in error, contact us within 14 days at <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a> and we will review your case.</p>

  <h3>4.5 Cancellation</h3>
  <p>You may cancel your subscription at any time through the Subscription page in your account or via the Stripe billing portal. Cancellation takes effect at the end of your current billing period. You retain access to your plan until then.</p>

  <h3>4.6 Generation Credits</h3>
  <p>Monthly generation points reset on your billing date and do not roll over to the following month. Unused generations are forfeited at period end.</p>
</section>

<section>
  <h2>5. Intellectual Property & Ownership</h2>
  <h3>5.1 Your Content</h3>
  <p>When you provide prompts, lyrics, style descriptors, or other input to generate beats ("Input"), you retain ownership of your Input. You grant StemForge a non-exclusive, worldwide, royalty-free license to use your Input solely for the purpose of providing the Service to you.</p>

  <h3>5.2 Generated Output</h3>
  <p>Subject to your plan and payment of applicable fees:</p>
  <ul>
    <li><strong>Free Plan:</strong> Beats generated are for personal, non-commercial use only. You may not sell, license, or commercialize beats generated under the Free plan.</li>
    <li><strong>Creator & Pro Artist Plans:</strong> You receive a non-exclusive license to use generated beats for commercial purposes, including in music releases, content monetization, sync licensing, and other commercial applications.</li>
  </ul>
  <p>StemForge does not claim ownership of your generated beats. However, because AI generation is non-deterministic, we cannot guarantee uniqueness — similar outputs may be produced for other users.</p>

  <h3>5.3 StemForge Platform</h3>
  <p>All platform code, design, branding, logos, trademarks, and underlying technology are the exclusive property of StemForge. You may not copy, reverse-engineer, or create derivative works of the platform.</p>
</section>

<section>
  <h2>6. Acceptable Use</h2>
  <p>You agree not to use the Service to:</p>
  <ul>
    <li>Generate content that infringes the intellectual property rights of any third party</li>
    <li>Create content that is illegal, defamatory, harassing, threatening, or abusive</li>
    <li>Reproduce, scrape, or systematically extract data from the platform</li>
    <li>Circumvent, disable, or interfere with security or access controls</li>
    <li>Use automated tools (bots, scrapers, crawlers) to access the Service without our written consent</li>
    <li>Resell, sublicense, or commercially exploit the platform itself without our written authorization</li>
    <li>Generate content designed to deceive, manipulate, or defraud others</li>
    <li>Violate any applicable local, national, or international law or regulation</li>
  </ul>
  <p>Violation of these rules may result in immediate account termination without refund.</p>
</section>

<section>
  <h2>6a. Audio Upload &amp; Remix Policy</h2>
  <p>The AI Remix feature allows you to upload original audio recordings for style transformation. By uploading audio to StemForge, you represent and warrant that:</p>
  <ul>
    <li>You are the original creator of the uploaded recording, or you hold all necessary rights and licenses to use it for this purpose</li>
    <li>The uploaded audio does not contain any material protected by third-party copyright, including commercially released recordings, sampled content, or any audio in which you do not hold full ownership or a valid license</li>
    <li>Your use of the Remix feature complies with all applicable intellectual property laws and does not infringe upon the rights of any artist, record label, publisher, or rights holder</li>
  </ul>
  <p>StemForge employs automated content recognition systems to identify audio that may be subject to third-party copyright claims. Uploads that trigger these protections will be declined by the platform. StemForge reserves the right to refuse remix processing for any audio submission that cannot be verified as rights-cleared, without obligation to disclose the specific basis for that determination.</p>
  <p>Repeated submission of infringing material may result in suspension or permanent termination of your account.</p>
</section>

<section>
  <h2 id="section-6b">6b. AI Cover Song Upload Policy</h2>
  <p>The AI Cover Song feature allows you to upload an audio recording so that StemForge can generate a new AI-voiced rendition of it. A <strong>published song</strong> is any recording that has been commercially released to the public — this includes tracks available on streaming platforms such as Spotify, Apple Music, YouTube Music, Tidal, or Amazon Music, as well as any recording distributed through a record label, music distributor, or rights holder, regardless of how widely known it is.</p>
  <p>By uploading audio to the Cover Song feature, you represent and warrant that:</p>
  <ul>
    <li>The uploaded recording is an <strong>original work</strong> that you created, or you hold all necessary rights and licenses to use it for AI voice transformation</li>
    <li>The uploaded audio is <strong>not a commercially published or distributed recording</strong> — including songs by signed or independent artists that appear on any streaming service, digital storefront, or public music catalog</li>
    <li>The audio does not contain samples, interpolations, or elements protected by third-party copyright in which you do not hold full ownership or a valid licence</li>
    <li>Your use of the Cover Song feature complies with all applicable intellectual property laws and does not infringe upon the rights of any artist, record label, publisher, or rights holder</li>
  </ul>
  <p>StemForge employs automated audio fingerprinting and content recognition systems to identify recordings that match commercially published tracks. Any upload that triggers these protections will be automatically declined and the associated credits will be refunded. StemForge reserves the right to refuse Cover Song processing for any audio submission that cannot be verified as rights-cleared, without obligation to disclose the specific basis for that determination.</p>
  <p>Repeated submission of commercially published or infringing material may result in the suspension or permanent termination of your account without refund.</p>
</section>

<section>
  <h2>7. StemForge-Generated Content Disclaimer</h2>
  <p>StemForge uses its generation engine (powered by third-party audio models) to produce audio content. While we strive to produce high-quality, original output, we make no guarantees regarding:</p>
  <ul>
    <li>The uniqueness or originality of generated beats</li>
    <li>The absence of similarity to existing copyrighted works</li>
    <li>The suitability of generated content for any particular commercial or artistic purpose</li>
  </ul>
  <p>You are solely responsible for reviewing generated content before use and for ensuring your use complies with applicable copyright law. StemForge is not liable for any third-party claims arising from your use of StemForge-generated content.</p>
</section>

<section>
  <h2>8. Disclaimer of Warranties</h2>
  <p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS.</p>
</section>

<section>
  <h2>9. Limitation of Liability</h2>
  <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, STEMFORGE AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOST PROFITS, LOSS OF DATA, OR BUSINESS INTERRUPTION, ARISING FROM YOUR USE OF OR INABILITY TO USE THE SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.</p>
  <p>Our total liability to you for any claims arising from these Terms or the Service shall not exceed the amount you paid to StemForge in the 12 months preceding the claim.</p>
</section>

<section>
  <h2>10. Indemnification</h2>
  <p>You agree to indemnify, defend, and hold harmless StemForge and its affiliates, officers, agents, and employees from any claims, liabilities, damages, losses, and expenses (including reasonable legal fees) arising from: (a) your use of the Service; (b) your violation of these Terms; (c) your violation of any third-party rights; or (d) content you submit or generate through the Service.</p>
</section>

<section>
  <h2>11. Termination</h2>
  <p>We may suspend or terminate your account and access to the Service at any time, with or without notice, for any reason, including your violation of these Terms. Upon termination, your right to use the Service ceases immediately. Provisions that by their nature should survive termination (including intellectual property, disclaimers, and limitation of liability) will survive.</p>
</section>

<section>
  <h2>12. Governing Law</h2>
  <p>These Terms are governed by and construed in accordance with the laws of the United States, without regard to conflict of law principles. Any disputes arising from these Terms shall be resolved through binding arbitration in accordance with the American Arbitration Association rules, except that either party may seek injunctive relief in a court of competent jurisdiction.</p>
</section>

<section>
  <h2>13. Contact</h2>
  <p>If you have any questions about these Terms, please contact us:</p>
  <ul>
    <li>Email: <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a></li>
    <li>Website: <a href="https://stemforge.studio">stemforge.studio</a></li>
  </ul>
</section>
`)
}

// ─── PRIVACY POLICY ───────────────────────────────────────────────────────────
function privacyPage() {
  return legalShell('Privacy Policy', 'June 7, 2025', `
<section>
  <h2>1. Introduction</h2>
  <p>StemForge ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your personal information when you use our website and beat generation platform ("Service"). Please read this policy carefully. By using the Service, you consent to the practices described here.</p>
</section>

<section>
  <h2>2. Information We Collect</h2>
  <h3>2.1 Information You Provide</h3>
  <ul>
    <li><strong>Account information:</strong> When you register, we collect your name, email address, and password (stored as a hashed value — we never store plaintext passwords).</li>
    <li><strong>Google OAuth:</strong> If you sign in with Google, we receive your Google profile name, email address, and profile photo URL from Google's API.</li>
    <li><strong>Payment information:</strong> We process payments via Stripe. We do not store full credit card numbers on our servers — Stripe handles all payment data under their own PCI-compliant systems.</li>
    <li><strong>Generation inputs:</strong> Prompts, lyrics, style descriptors, BPM values, and other inputs you provide to generate beats.</li>
    <li><strong>Communications:</strong> If you contact us by email or through the platform, we retain your messages to respond and improve the Service.</li>
  </ul>

  <h3>2.2 Information Collected Automatically</h3>
  <ul>
    <li><strong>Session data:</strong> We use HttpOnly session cookies to maintain your authenticated session. Session tokens are stored securely in our Cloudflare D1 database.</li>
    <li><strong>Usage data:</strong> We collect information about how you interact with the Service, including pages visited, features used, and generation history.</li>
    <li><strong>Device & browser data:</strong> IP address, browser type, operating system, and referring URLs, collected via standard server logs.</li>
  </ul>

  <h3>2.3 Information from Third Parties</h3>
  <ul>
    <li><strong>Google:</strong> If you authenticate via Google OAuth, we receive the profile information described above, subject to your Google account privacy settings.</li>
    <li><strong>Stripe:</strong> We receive transaction status, customer ID, and subscription information from Stripe to manage your billing.</li>
  </ul>
</section>

<section>
  <h2>3. How We Use Your Information</h2>
  <p>We use your information to:</p>
  <ul>
    <li>Create and manage your account and authenticate your identity</li>
    <li>Provide and improve the beat generation Service</li>
    <li>Process payments, manage subscriptions, and track generation usage</li>
    <li>Personalize your experience (profile photo, name, plan status)</li>
    <li>Send transactional emails (account creation, payment receipts, subscription changes)</li>
    <li>Detect and prevent fraud, abuse, and violations of our Terms of Service</li>
    <li>Comply with legal obligations and enforce our agreements</li>
    <li>Analyze usage patterns to improve platform performance and features</li>
  </ul>
  <p>We do <strong>not</strong> sell your personal information to third parties. We do not use your prompts or generated beats to train AI models without your explicit consent.</p>
</section>

<section>
  <h2>4. Cookies & Tracking</h2>
  <h3>4.1 Session Cookies</h3>
  <p>We use a single HttpOnly, Secure, SameSite session cookie (<code>sf_session</code>) to keep you logged in for up to 30 days. This cookie does not track you across other websites.</p>

  <h3>4.2 Local Storage</h3>
  <p>We use browser localStorage to save your theme preference (dark/light mode) locally on your device. No personal data is stored in localStorage.</p>

  <h3>4.3 Third-Party Services</h3>
  <p>Our Service integrates with third-party providers that may set their own cookies or tracking mechanisms:</p>
  <ul>
    <li><strong>Stripe:</strong> For payment processing. <a href="https://stripe.com/privacy" target="_blank">Stripe Privacy Policy</a></li>
    <li><strong>Google OAuth:</strong> For optional sign-in. <a href="https://policies.google.com/privacy" target="_blank">Google Privacy Policy</a></li>
    <li><strong>Cloudflare:</strong> For hosting and edge delivery. <a href="https://www.cloudflare.com/privacypolicy/" target="_blank">Cloudflare Privacy Policy</a></li>
  </ul>
</section>

<section>
  <h2>5. How We Share Your Information</h2>
  <p>We do not sell or rent your personal information. We share data only in these limited circumstances:</p>
  <ul>
    <li><strong>Service providers:</strong> We share necessary data with Stripe (payments), Cloudflare (hosting), and our AI generation providers to operate the Service. These providers process data on our behalf under data processing agreements.</li>
    <li><strong>Legal requirements:</strong> We may disclose your information if required by law, court order, or governmental authority, or to protect the rights, safety, or property of StemForge or others.</li>
    <li><strong>Business transfers:</strong> If StemForge is acquired or merges with another entity, your information may be transferred as part of that transaction. We will notify you via email or a prominent notice before your data is subject to a different privacy policy.</li>
  </ul>
</section>

<section>
  <h2>6. Data Retention</h2>
  <p>We retain your account information and generation history for as long as your account is active or as needed to provide the Service. If you delete your account, we will delete or anonymize your personal data within 30 days, except where retention is required by law or for legitimate business purposes (e.g., financial records required for tax compliance).</p>
  <p>Session tokens expire after 30 days of inactivity. Generation job data is retained to power your dashboard and project history.</p>
</section>

<section>
  <h2>7. Data Security</h2>
  <p>We take reasonable technical and organizational measures to protect your personal information:</p>
  <ul>
    <li>Passwords are hashed using PBKDF2 with SHA-256 and a unique salt per user — we cannot recover your plaintext password</li>
    <li>Session cookies are HttpOnly and Secure — they cannot be accessed by JavaScript and are only sent over HTTPS</li>
    <li>All data is stored on Cloudflare's infrastructure with enterprise-grade security</li>
    <li>Payment processing is fully handled by Stripe — we never touch raw card data</li>
    <li>API keys and secrets are stored as environment variables, never in source code</li>
  </ul>
  <p>No system is 100% secure. In the event of a data breach affecting your rights, we will notify you as required by applicable law.</p>
</section>

<section>
  <h2>8. Your Rights & Choices</h2>
  <p>Depending on your location, you may have the following rights regarding your personal data:</p>
  <ul>
    <li><strong>Access:</strong> Request a copy of the personal data we hold about you</li>
    <li><strong>Correction:</strong> Request correction of inaccurate or incomplete data</li>
    <li><strong>Deletion:</strong> Request deletion of your account and associated personal data ("right to be forgotten")</li>
    <li><strong>Portability:</strong> Request your data in a portable format</li>
    <li><strong>Objection:</strong> Object to certain types of processing (e.g., marketing)</li>
    <li><strong>Restriction:</strong> Request restriction of processing in certain circumstances</li>
  </ul>
  <p>To exercise any of these rights, email us at <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a>. We will respond within 30 days. We may need to verify your identity before processing your request.</p>
  <p><strong>California residents (CCPA):</strong> You have the right to know what personal information we collect, to delete it, and to opt out of its sale. We do not sell personal information.</p>
  <p><strong>EEA/UK residents (GDPR):</strong> Our legal basis for processing your data includes contract performance (providing the Service), legitimate interests (fraud prevention, improving the Service), and legal compliance. You may also lodge a complaint with your local data protection authority.</p>
</section>

<section>
  <h2>9. Children's Privacy</h2>
  <p>The Service is not directed to children under 13 years of age. We do not knowingly collect personal information from children under 13. If we discover we have collected data from a child under 13, we will delete it promptly. If you believe we have collected such data, please contact us at <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a>.</p>
</section>

<section>
  <h2>10. International Data Transfers</h2>
  <p>StemForge operates primarily through Cloudflare's global edge network. Your data may be processed in data centers located in the United States and other countries. By using the Service, you consent to the transfer of your information to countries that may have different data protection laws than your country of residence. We take steps to ensure appropriate safeguards are in place for any such transfers.</p>
</section>

<section>
  <h2>11. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. When we do, we will update the "Last Updated" date at the top of this page and, for material changes, notify registered users by email. Your continued use of the Service after any changes constitutes acceptance of the revised policy.</p>
</section>

<section>
  <h2>12. Contact Us</h2>
  <p>If you have questions, concerns, or requests about this Privacy Policy or how we handle your data, please contact us:</p>
  <ul>
    <li>Email: <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a></li>
    <li>General: <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a></li>
    <li>Website: <a href="https://stemforge.studio">stemforge.studio</a></li>
  </ul>
</section>
`)
}

// ─── FEEDBACK PAGE ───────────────────────────────────────────────────────────
// Email delivery: EmailJS (client-side) → sends directly to stemforgesupport@gmail.com
// Setup required (one-time, free):
//   1. Sign up at https://www.emailjs.com (free: 200 emails/month)
//   2. Add service: Connect Gmail account → copy Service ID
//   3. Create template with variables: {{feedback_type}}, {{message}}, {{reply_email}}
//      Set "To email" in template to stemforgesupport@gmail.com
//   4. Copy Public Key from Account → API Keys
//   5. Replace the three EMAILJS_* placeholders below and redeploy
const EMAILJS_PUBLIC_KEY    = 'Q6GPcwT6SGAmZj3nr'
const EMAILJS_SERVICE_ID    = 'service_jl0z9ec'
const EMAILJS_TEMPLATE_ID   = 'template_yqyzgyx'

function feedbackPage() {
  const ejsReady = !EMAILJS_PUBLIC_KEY.startsWith('EMAILJS_')
  return shell('Give Us Feedback', `
<!-- EmailJS CDN — sends email directly from browser to Gmail, no backend needed -->
<script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"><\/script>
<script>
  // Initialise EmailJS with the public key
  (function() {
    if (typeof emailjs !== 'undefined') {
      emailjs.init({ publicKey: '${EMAILJS_PUBLIC_KEY}' });
    }
  })();
<\/script>

<main class="inner-page gs-content">
<section class="inner-hero">
  <div class="container">
    <div class="section-tag">Feedback</div>
    <h1>Give Us Your Feedback</h1>
    <p>Your feedback helps us make StemForge better for every artist.</p>
  </div>
</section>
<section style="padding:60px 0">
  <div class="container" style="max-width:600px">
    <div class="account-card" style="padding:32px">
      <div style="text-align:center;margin-bottom:28px">
        <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:1.5rem;color:#fff">
          <i class="fas fa-comment-alt"></i>
        </div>
        <h2 style="font-size:1.3rem;margin:0 0 6px">Share Your Thoughts</h2>
        <p style="color:var(--muted);font-size:.9rem;margin:0">Tell us what's working, what's broken, or what you'd love to see next.</p>
      </div>

      ${!ejsReady ? `
      <!-- Setup banner — only visible until EmailJS keys are configured -->
      <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:.84rem;color:var(--text)">
        <strong style="color:#f59e0b"><i class="fas fa-wrench"></i> Setup needed:</strong>
        Feedback is currently sent via the server fallback. To deliver directly to Gmail, follow the EmailJS setup steps in <code>src/index.tsx</code> and replace the three <code>EMAILJS_*</code> placeholders.
      </div>` : ''}

      <div id="feedback-sent" style="display:none;text-align:center;padding:24px">
        <i class="fas fa-check-circle" style="font-size:2.5rem;color:#10b981;margin-bottom:12px;display:block"></i>
        <h3 style="margin:0 0 6px">Thank you!</h3>
        <p style="color:var(--muted)">Your feedback has been sent directly to our inbox. We'll review it shortly.</p>
      </div>

      <div id="feedback-form">
        <div class="form-group" style="margin-bottom:16px">
          <label style="font-size:.88rem;font-weight:600;display:block;margin-bottom:6px;color:var(--text)">Type of feedback</label>
          <select id="feedback-type" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem">
            <option value="🐛 Bug Report">🐛 Bug Report</option>
            <option value="💡 Feature Request" selected>💡 Feature Request</option>
            <option value="💬 General Feedback">💬 General Feedback</option>
            <option value="💰 Pricing Feedback">💰 Pricing Feedback</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label style="font-size:.88rem;font-weight:600;display:block;margin-bottom:6px;color:var(--text)">Your feedback <span style="color:var(--danger)">*</span></label>
          <textarea id="feedback-text" rows="5"
            placeholder="Describe your experience, what you'd like improved, or report an issue..."
            style="width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem;resize:vertical;box-sizing:border-box;font-family:inherit"></textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label style="font-size:.88rem;font-weight:600;display:block;margin-bottom:6px;color:var(--text)">Your email (optional)</label>
          <input type="email" id="feedback-email" placeholder="We'll reply here if you want a response"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem;box-sizing:border-box"/>
        </div>
        <div id="feedback-error" style="display:none;color:var(--danger);font-size:.82rem;margin-bottom:12px;padding:10px 12px;background:rgba(239,68,68,.08);border-radius:8px;border:1px solid rgba(239,68,68,.2)"></div>
        <button class="btn btn--primary btn--full" id="feedback-submit-btn" onclick="submitFeedback()">
          <i class="fas fa-paper-plane"></i> Send Feedback
        </button>
        <p style="text-align:center;color:var(--muted);font-size:.75rem;margin-top:12px">
          <i class="fas fa-envelope"></i> Sent directly to stemforgesupport@gmail.com
        </p>
      </div>
    </div>
  </div>
</section>
</main>

<script>
var _ejsReady = ${ejsReady};
var _ejsServiceId  = '${EMAILJS_SERVICE_ID}';
var _ejsTemplateId = '${EMAILJS_TEMPLATE_ID}';

async function submitFeedback() {
  var text   = document.getElementById('feedback-text').value.trim();
  var errEl  = document.getElementById('feedback-error');
  var btn    = document.getElementById('feedback-submit-btn');

  if (!text) {
    errEl.textContent = 'Please enter your feedback before submitting.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';

  var type       = document.getElementById('feedback-type').value;
  var replyEmail = document.getElementById('feedback-email').value.trim();

  // ── Path A: EmailJS (direct to Gmail, no backend) ──────────────────────────
  if (_ejsReady && typeof emailjs !== 'undefined') {
    try {
      await emailjs.send(_ejsServiceId, _ejsTemplateId, {
        feedback_type: type,
        message:       text,
        reply_email:   replyEmail || 'Not provided',
        // 'to_email' maps to stemforgesupport@gmail.com set in your EmailJS template
      });
      document.getElementById('feedback-form').style.display = 'none';
      document.getElementById('feedback-sent').style.display = 'block';
      return;
    } catch(ejsErr) {
      console.warn('EmailJS failed, falling back to server:', ejsErr);
      // fall through to server fallback below
    }
  }

  // ── Path B: Server fallback (/api/feedback — logs or uses MailerSend/Resend) ─
  try {
    var res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, text, email: replyEmail || undefined })
    });
    if (!res.ok) throw new Error('Server error');
    document.getElementById('feedback-form').style.display = 'none';
    document.getElementById('feedback-sent').style.display = 'block';
  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Feedback';
    errEl.textContent = 'Failed to send feedback. Please try again.';
    errEl.style.display = 'block';
  }
}
<\/script>
`)
}

// ── ADMIN DIAGNOSTIC: test MusicAPI stem task poll raw response ──────────────
// GET /api/admin/stem-diag?task_id=<musicapi_uuid>&secret=sf_diag_2026
// Returns the raw JSON from MusicAPI /sonic/task/:id so we can see real field names
app.get('/api/admin/stem-diag', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'MUSICAPI_KEY not set' }, 500)
  // Allow either admin session OR a hardcoded diagnostic secret
  const secret = c.req.query('secret')
  if (secret !== 'sf_diag_2026') {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  }

  // Balance-only mode: ?balance=1 skips task poll and just returns MusicAPI account balance
  if (c.req.query('balance') === '1') {
    const balRes = await fetch(`${MUSICAPI_BASE}/user/me`, {
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
    }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message }))
    const balRes2 = await fetch(`https://api.musicapi.ai/api/v1/credits`, {
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
    }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message }))
    const balRes3 = await fetch(`https://api.musicapi.ai/api/v1/sonic/credits`, {
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` }
    }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message }))
    return c.json({ user_me: balRes, credits_v1: balRes2, sonic_credits: balRes3 })
  }

  const taskId = c.req.query('task_id')
  if (!taskId) return c.json({ error: 'task_id param required. Use ?balance=1 to check MusicAPI balance only.' }, 400)

  // Try both poll endpoints
  const sonicUrl = `${MUSICAPI_SONIC}/task/${taskId}`
  const stemUrl  = `${MUSICAPI_SONIC}/stems/task/${taskId}`

  const [sonicRes, stemRes] = await Promise.all([
    fetch(sonicUrl, { headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` } }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message })),
    fetch(stemUrl,  { headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` } }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message })),
  ])

  // Also try submitting a fresh basic stems job on a known clip_id if provided
  const clipId = c.req.query('clip_id')
  let submitResult: any = null
  if (clipId) {
    const subRes = await fetch(`${MUSICAPI_SONIC}/stems/basic`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip_id: clipId })
    }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message }))
    submitResult = subRes
  }

  return c.json({
    task_id: taskId,
    sonic_task_poll: { url: sonicUrl, ...sonicRes },
    stems_task_poll:  { url: stemUrl,  ...stemRes },
    submit_basic: submitResult
  })
})

// ═══════════════════════════════════════════════════════════════
//  SIGNUP CLICK TRACKING
// ═══════════════════════════════════════════════════════════════

// POST /api/track/signup-click — records a button click on login/signup page
// Called client-side before redirect; fire-and-forget, no auth required
app.post('/api/track/signup-click', async (c) => {
  if (!c.env.DB) return c.json({ ok: false }, 200)
  try {
    const body = await c.req.json().catch(() => ({}))
    const eventType = (body.event_type === 'email') ? 'email' : 'google'
    const page      = (body.page === 'signup') ? 'signup' : 'login'
    const referrer  = (typeof body.referrer === 'string' ? body.referrer : '').slice(0, 500) || null
    const country   = c.req.header('CF-IPCountry') || null
    await c.env.DB.prepare(
      `INSERT INTO signup_clicks (event_type, page, referrer, country, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(eventType, page, referrer, country, Date.now()).run()
    return c.json({ ok: true })
  } catch { return c.json({ ok: false }, 200) }
})

// GET /api/admin/signup-clicks — admin view of signup click data
app.get('/api/admin/signup-clicks', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)

  const now = Date.now()
  const DAY  = 86400000
  const todayCutoff  = now - DAY
  const weekCutoff   = now - 7 * DAY
  const monthCutoff  = now - 30 * DAY

  const [totalRow, todayRow, weekRow, googleRow, emailRow, daily, recent] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM signup_clicks WHERE created_at >= ?`).bind(monthCutoff).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM signup_clicks WHERE created_at >= ?`).bind(todayCutoff).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM signup_clicks WHERE created_at >= ?`).bind(weekCutoff).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM signup_clicks WHERE event_type='google' AND created_at >= ?`).bind(monthCutoff).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM signup_clicks WHERE event_type='email' AND created_at >= ?`).bind(monthCutoff).first<any>(),
    // Daily breakdown last 30 days
    c.env.DB.prepare(`
      SELECT date(created_at/1000,'unixepoch') as day, event_type, COUNT(*) as cnt
      FROM signup_clicks WHERE created_at >= ?
      GROUP BY day, event_type ORDER BY day ASC
    `).bind(monthCutoff).all<any>(),
    // Most recent 50 clicks
    c.env.DB.prepare(`
      SELECT id, event_type, page, referrer, country, created_at
      FROM signup_clicks ORDER BY created_at DESC LIMIT 50
    `).all<any>(),
  ])

  return c.json({
    stats: {
      total_30d:  (totalRow as any)?.cnt  || 0,
      today:      (todayRow as any)?.cnt  || 0,
      this_week:  (weekRow as any)?.cnt   || 0,
      google_30d: (googleRow as any)?.cnt || 0,
      email_30d:  (emailRow as any)?.cnt  || 0,
    },
    daily:  daily.results  || [],
    recent: recent.results || [],
  })
})

// ═══════════════════════════════════════════════════════════════
//  SCHEDULED CRON — Free plan monthly reset
//  Cloudflare Pages does not support cron triggers directly.
//  Resets run two ways:
//  1. Opportunistically on each Worker cold start (inside initDb)
//  2. Via GET /api/cron/free-reset?secret=CRON_SECRET — called daily
//     by an external cron service (e.g. cron-job.org, free tier)
// ═══════════════════════════════════════════════════════════════

// GET /api/cron/free-reset — external cron trigger (secured by CRON_SECRET env var)
app.get('/api/cron/free-reset', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not available' }, 500)
  // Auth: require matching secret in query param or Authorization header
  const cronSecret = (c.env as any).CRON_SECRET
  const provided = c.req.query('secret') || c.req.header('Authorization')?.replace('Bearer ', '')
  if (!cronSecret || provided !== cronSecret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  try {
    const result = await runFreeUserReset(c.env.DB)
    return c.json({ ok: true, reset: result.reset, errors: result.errors, ts: new Date().toISOString() })
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message }, 500)
  }
})
// ═══════════════════════════════════════════════════════════════

// GET /api/cron/recover-stuck-jobs — called every 2 min by external cron (cron-job.org)
// Finds any generating job older than 5 min with a stereo_task_id, polls MusicAPI,
// writes result back. Fixes the "user closed tab mid-generation" data loss problem.
app.get('/api/cron/recover-stuck-jobs', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not available' }, 500)
  const cronSecret = (c.env as any).CRON_SECRET
  const provided = c.req.query('secret') || c.req.header('Authorization')?.replace('Bearer ', '')
  if (!cronSecret || provided !== cronSecret) return c.json({ error: 'Unauthorized' }, 401)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)

  await ensureTable(c.env.DB)

  // Find all generating jobs with a task ID regardless of age — cron will skip ones <5 min
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, data FROM jobs
     WHERE json_extract(data,'$.status') = 'generating'
       AND json_extract(data,'$.stereo_task_id') IS NOT NULL`
  ).all<{ id: string; user_id: string; data: string }>()

  const results: any[] = []
  const FIVE_MIN = 5 * 60 * 1000
  const FIFTEEN_MIN = 15 * 60 * 1000

  for (const row of (rows.results || [])) {
    const job = JSON.parse(row.data) as any
    const ageMs = Date.now() - (job.created_at || 0)

    // Skip jobs younger than 5 min — still generating normally
    if (ageMs < FIVE_MIN) {
      results.push({ id: row.id, title: job.title, action: 'skip_too_new', age_min: Math.round(ageMs / 60000) })
      continue
    }

    try {
      const taskType = job.extend_task_type
      const useSonic = taskType === 'song_extend' || taskType === 'song_generate'
      const endpoint = useSonic
        ? `${MUSICAPI_SONIC}/task/${job.stereo_task_id}`
        : `${MUSICAPI_PRODUCER}/task/${job.stereo_task_id}`

      const pollRes = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}` } })
      const pollText = await pollRes.text()
      let pollData: any = {}
      try { pollData = JSON.parse(pollText) } catch {}

      const clips = Array.isArray(pollData) ? pollData : (pollData.data || [])
      const clip = clips[0]

      // MusicAPI failed shape: { type: 'failed', error: '...', already_refunded: true }
      if (pollData.type === 'failed') {
        job.status = 'error'
        job.error = `Generation failed on music server — 20 points refunded.`
        await setJob(c.env.DB, job)
        // Refund 20 points to the user
        if (row.user_id) {
          await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id = ?`)
            .bind(row.user_id).run()
        }
        results.push({ id: row.id, title: job.title, action: 'marked_error_refunded', reason: pollData.error })
        continue
      }

      if (!clip) {
        // No clip data at all — if old enough, time it out
        if (ageMs > FIFTEEN_MIN) {
          job.status = 'error'
          job.error = 'Stemforge generation timed out after 15 minutes'
          await setJob(c.env.DB, job)
          if (row.user_id) {
            await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id = ?`)
              .bind(row.user_id).run()
          }
          results.push({ id: row.id, title: job.title, action: 'timed_out_refunded' })
        } else {
          results.push({ id: row.id, title: job.title, action: 'still_pending', age_min: Math.round(ageMs / 60000) })
        }
        continue
      }

      if (clip.state === 'succeeded') {
        const url = clip.audio_url || clip.wav_url || null
        const clipId = clip.clip_id || clip.id || null
        if (url) {
          job.stereo_url = url
          if (clipId) job.clip_id = clipId
          job.status = 'ready'
          delete job.error
          await setJob(c.env.DB, job)
          // Persist to R2 immediately so it never expires
          if (c.env.IMAGES && c.env.SITE_URL) {
            persistAudioToR2(url, row.id, c.env.IMAGES, c.env.DB, c.env.SITE_URL)
              .catch((e: any) => console.warn('[cron-recover] R2 persist error:', e?.message))
          }
          results.push({ id: row.id, title: job.title, action: 'rescued', url_prefix: url.slice(0, 60) })
        } else {
          job.status = 'error'
          job.error = 'Task succeeded but no audio_url returned'
          await setJob(c.env.DB, job)
          results.push({ id: row.id, title: job.title, action: 'marked_error', reason: 'succeeded_no_url' })
        }
      } else if (clip.state === 'failed') {
        job.status = 'error'
        job.error = 'Generation failed on music server — 20 points refunded.'
        await setJob(c.env.DB, job)
        if (row.user_id) {
          await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id = ?`)
            .bind(row.user_id).run()
        }
        results.push({ id: row.id, title: job.title, action: 'marked_error_refunded', reason: clip.error })
      } else {
        // Still running — time out if old enough
        if (ageMs > FIFTEEN_MIN) {
          job.status = 'error'
          job.error = 'Stemforge generation timed out after 15 minutes'
          await setJob(c.env.DB, job)
          if (row.user_id) {
            await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 20) WHERE id = ?`)
              .bind(row.user_id).run()
          }
          results.push({ id: row.id, title: job.title, action: 'timed_out_refunded', state: clip.state })
        } else {
          results.push({ id: row.id, title: job.title, action: 'still_running', state: clip.state, age_min: Math.round(ageMs / 60000) })
        }
      }
    } catch (err: any) {
      results.push({ id: row.id, title: job.title, action: 'poll_error', error: err?.message?.slice(0, 200) })
    }
  }

  const rescued  = results.filter(r => r.action === 'rescued').length
  const refunded = results.filter(r => r.action?.includes('refunded')).length
  console.log(`[cron-recover] checked=${results.length} rescued=${rescued} refunded=${refunded}`)
  return c.json({ ok: true, checked: results.length, rescued, refunded, results, ts: new Date().toISOString() })
})

// GET /api/cron/persist-r2 — called every 5 min by external cron (cron-job.org / GitHub Actions)
// Finds ready jobs (ALL types: beats, remix, cover, one-shots, any future tab) whose audio URL
// is still on an expiring external CDN and persists it to R2 permanently.
// Covers both stereo_url (beats/remix/cover) and audio_url (one-shots).
// Auto-marks permanently dead CDN URLs (403/404) as CDN_DEAD so they never block the queue again.
app.get('/api/cron/persist-r2', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not available' }, 500)
  const cronSecret = (c.env as any).CRON_SECRET
  const provided = c.req.query('secret') || c.req.header('Authorization')?.replace('Bearer ', '')
  if (!cronSecret || provided !== cronSecret) return c.json({ error: 'Unauthorized' }, 401)
  if (!c.env.IMAGES) return c.json({ error: 'R2 not available' }, 500)
  if (!c.env.SITE_URL) return c.json({ error: 'SITE_URL not configured' }, 500)

  await ensureTable(c.env.DB)

  // Find ALL ready jobs (beats, remix, cover, one-shots) with external CDN audio URLs not yet in R2.
  // Uses COALESCE to check both stereo_url (beats/remix/cover) and audio_url (one-shots).
  // r2_audio_key IS NULL excludes already-persisted tracks AND CDN_DEAD entries.
  const rows = await c.env.DB.prepare(`
    SELECT id, data, is_oneshot FROM jobs
    WHERE deleted_at IS NULL
      AND json_extract(data,'$.status') = 'ready'
      AND json_extract(data,'$.r2_audio_key') IS NULL
      AND (
        (json_extract(data,'$.stereo_url') IS NOT NULL AND json_extract(data,'$.stereo_url') NOT LIKE '%/api/track-audio/%')
        OR
        (json_extract(data,'$.audio_url') IS NOT NULL AND json_extract(data,'$.audio_url') NOT LIKE '%/api/track-audio/%')
      )
    ORDER BY created_at ASC
    LIMIT 5
  `).all<{ id: string; data: string; is_oneshot: number }>()

  const results: any[] = []
  for (const row of (rows.results || [])) {
    const job = JSON.parse(row.data) as any
    // Pick the right URL field depending on track type
    const url = row.is_oneshot ? (job.audio_url || job.stereo_url) : (job.stereo_url || job.audio_url)
    if (!url) { results.push({ id: row.id, action: 'skip_no_url' }); continue }

    // Pre-flight HEAD check: detect permanently dead CDN URLs (403/404) before attempting
    // full download. If dead, mark CDN_DEAD immediately so it never blocks the queue again.
    try {
      const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'StemForge/1.0' } })
      if (head.status === 403 || head.status === 404 || head.status === 410) {
        // Permanently gone — mark CDN_DEAD so cron skips it forever
        const deadJob = { ...job, r2_audio_key: 'CDN_DEAD', cdn_dead_reason: `http_${head.status}`, cdn_dead_at: new Date().toISOString() }
        await c.env.DB.prepare('UPDATE jobs SET data = ? WHERE id = ?').bind(JSON.stringify(deadJob), row.id).run()
        console.warn(`[cron-persist-r2] CDN_DEAD job=${row.id} title="${job.title}" status=${head.status}`)
        results.push({ id: row.id, title: job.title, action: 'cdn_dead', http_status: head.status, src_url: url.slice(0, 80) })
        continue
      }
    } catch (_headErr) {
      // HEAD failed (network error) — fall through to full attempt which will also fail and retry next run
    }

    try {
      const newUrl = await persistAudioToR2(url, row.id, c.env.IMAGES, c.env.DB, c.env.SITE_URL)
      if (newUrl) {
        results.push({ id: row.id, title: job.title, action: 'persisted', new_url: newUrl })
      } else {
        results.push({ id: row.id, title: job.title, action: 'persist_failed', src_url: url.slice(0, 80) })
      }
    } catch (err: any) {
      results.push({ id: row.id, title: job.title, action: 'error', error: err?.message?.slice(0, 200) })
    }
  }

  const persisted  = results.filter(r => r.action === 'persisted').length
  const cdn_dead   = results.filter(r => r.action === 'cdn_dead').length
  const failed     = results.filter(r => r.action === 'persist_failed' || r.action === 'error').length
  console.log(`[cron-persist-r2] checked=${results.length} persisted=${persisted} cdn_dead=${cdn_dead} failed=${failed}`)
  return c.json({ ok: true, checked: results.length, persisted, cdn_dead, failed, results, ts: new Date().toISOString() })
})

// ═══════════════════════════════════════════════════════════════

async function runFreeUserReset(db: D1Database): Promise<{ reset: number; errors: string[] }> {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
  const now = Date.now()
  const cutoff = now - THIRTY_DAYS_MS
  const errors: string[] = []

  // Find all free users whose cycle_start is 30+ days ago
  // (cycle_start IS NULL guard catches any users missed by the backfill)
  const due = await db.prepare(
    `SELECT id, email, cycle_start FROM users
     WHERE plan = 'free'
       AND account_locked = 0
       AND (cycle_start IS NULL OR cycle_start <= ?)`
  ).bind(cutoff).all<{ id: string; email: string; cycle_start: number | null }>()

  const users = due.results || []
  if (users.length === 0) return { reset: 0, errors }

  // Reset each user: zero out gens_used, advance cycle_start by exactly 30 days
  // (not "now") so users keep their anniversary date and don't drift
  let resetCount = 0
  for (const u of users) {
    try {
      // Advance cycle_start by 30 days from its current value (preserves anniversary)
      // If null/very old, just set to now
      const prevCycle = u.cycle_start || now
      const newCycle = prevCycle + THIRTY_DAYS_MS
      await db.prepare(
        `UPDATE users SET gens_used = 0, cycle_start = ? WHERE id = ? AND plan = 'free'`
      ).bind(newCycle, u.id).run()
      resetCount++
    } catch (err: any) {
      errors.push(`${u.email}: ${err?.message || 'unknown error'}`)
    }
  }

  return { reset: resetCount, errors }
}

export default app
