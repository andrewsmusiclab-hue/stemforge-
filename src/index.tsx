import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  OPENAI_API_KEY: string
  MUREKA_API_KEY: string
  DB: D1Database             // Cloudflare D1 for persistent job storage
}

const app = new Hono<{ Bindings: Bindings }>()

// ── Middleware ─────────────────────────────────────────────────
app.use('/api/*', cors())

// ── Static assets ──────────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './' }))

// ═══════════════════════════════════════════════════════════════
//  PIPELINE CONSTANTS
// ═══════════════════════════════════════════════════════════════

const MUREKA_BASE = 'https://api.mureka.ai/v1'
const OPENAI_BASE = 'https://api.openai.com/v1'
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

async function setJob(db: D1Database | undefined, job: Job): Promise<void> {
  if (db) {
    await ensureTable(db)
    await db.prepare(
      `INSERT INTO jobs (id, data, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`
    ).bind(job.id, JSON.stringify(job), job.created_at).run()
  } else {
    memJobs.set(job.id, job)
  }
}

// Mureka /v1/song/stem returns these stem names inside the ZIP
const MUREKA_STEMS = ['drums', 'bass', 'vocals', 'other', 'instrumental'] as const
type MurekaStem = typeof MUREKA_STEMS[number]

interface Job {
  id: string
  status: 'pending' | 'blueprint' | 'generating' | 'extracting' | 'ready' | 'error'
  created_at: number
  blueprint?: Blueprint
  stereo_url?: string
  stereo_task_id?: string
  zip_url?: string        // Mureka stem ZIP download URL
  tracks: Track[]         // Mapped stems for display
  error?: string
  prompt: string
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
  mureka_prompt: string
  sections: string[]
}

interface Instrument {
  name: string
  family: string
  role: string
  mureka_track_type: string
}

interface Track {
  name: string          // Display name e.g. "Drums", "Bass", "Vocals", "Other", "Instrumental"
  stem: MurekaStem      // Actual stem filename key
  family: string
  status: 'pending' | 'ready' | 'error'
  zip_url?: string      // The ZIP containing all stems (same for all tracks)
  color: string
}

const TRACK_COLORS: Record<string, string> = {
  kick: '#ef4444', snare: '#f97316', 'hi-hats': '#eab308',
  hats: '#eab308', bass: '#3b82f6', rhodes: '#8b5cf6',
  keys: '#8b5cf6', piano: '#8b5cf6', guitar: '#06b6d4',
  pad: '#10b981', synth: '#10b981', fx: '#ec4899',
  strings: '#a78bfa', trumpet: '#f59e0b', flute: '#34d399',
  violin: '#e879f9', default: '#4e9fff'
}

function trackColor(name: string): string {
  const key = name.toLowerCase()
  for (const [k, v] of Object.entries(TRACK_COLORS)) {
    if (key.includes(k)) return v
  }
  return TRACK_COLORS.default
}

function makeJobId(): string {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

// ═══════════════════════════════════════════════════════════════
//  STEP 1 — OPENAI BLUEPRINT GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateBlueprint(prompt: string, apiKey: string): Promise<Blueprint> {
  const systemPrompt = `You are a professional music producer and composer. 
Given a user's beat description, you output a detailed composition blueprint as JSON.
Be specific and practical. The blueprint will be used to generate individual instrument tracks via AI.
Always output valid JSON only, no markdown, no explanation.`

  const userPrompt = `Create a composition blueprint for this beat: "${prompt}"

Return ONLY this JSON structure:
{
  "bpm": <number 60-180>,
  "key": <"C" | "D" | "E" | "F" | "G" | "A" | "B" with optional "b" or "#">,
  "scale": <"minor" | "major" | "minor pentatonic" | "major pentatonic">,
  "genre": <specific genre string>,
  "mood": <mood string>,
  "energy": <"low" | "medium" | "high">,
  "duration_seconds": <90 | 120 | 150 | 180>,
  "sections": ["intro", "verse", "hook", "verse", "hook", "outro"],
  "arrangement": <one sentence describing the arrangement density and feel>,
  "mureka_prompt": <a detailed Mureka-optimized prompt string for the full instrumental, max 200 chars>,
  "instruments": [
    {
      "name": <instrument display name, e.g. "Kick", "Snare", "Hi-hats", "Bass", "Rhodes", "Guitar", "Pad", "FX">,
      "family": <"drums" | "bass" | "keys" | "guitar" | "strings" | "brass" | "woodwind" | "synth" | "fx">,
      "role": <"rhythmic" | "harmonic" | "melodic" | "textural" | "transitional">,
      "mureka_track_type": <"vocals" | "accompaniment" | "bass" | "drums">
    }
  ]
}

Rules:
- instruments array must have 6-10 items
- every beat must have kick, snare, hi-hats, bass as minimum
- add melodic/harmonic instruments based on genre and prompt
- mureka_track_type must be one of: vocals, accompaniment, bass, drums
- map kick/snare/hats → "drums", bass → "bass", keys/guitar/pad/strings/brass/woodwind → "accompaniment", fx/vocals → "vocals"
- mureka_prompt should describe the full instrumental feel in detail for best AI generation results`

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
      temperature: 0.7,
      max_tokens: 1000,
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
//  STEP 2 — MUREKA INSTRUMENTAL GENERATION
// ═══════════════════════════════════════════════════════════════

async function startInstrumentalGeneration(blueprint: Blueprint, apiKey: string): Promise<string> {
  const res = await fetch(`${MUREKA_BASE}/instrumental/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: blueprint.mureka_prompt,
      model: 'auto'
    })
  })

  if (!res.ok) {
    const err = await res.json() as any
    throw new Error(`Mureka instrumental error: ${err?.error?.message || res.status}`)
  }

  const data = await res.json() as any
  return data.id as string
}

async function pollInstrumentalStatus(taskId: string, apiKey: string): Promise<string | null> {
  const res = await fetch(`${MUREKA_BASE}/instrumental/query/${taskId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  })

  if (!res.ok) return null

  const data = await res.json() as any
  if (data.status === 'succeeded' && data.choices?.[0]?.url) {
    return data.choices[0].url as string
  }
  if (data.status === 'failed') throw new Error('Mureka generation failed')
  return null // still processing
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3 — MUREKA STEM SEPARATION via /v1/song/stem
//  Returns a zip_url synchronously — no polling needed!
//  ZIP contains: vocals.wav, bass.wav, drums.wav, other.wav,
//                instrumental.wav, song.wav, song.mp3
// ═══════════════════════════════════════════════════════════════

async function extractStems(songUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${MUREKA_BASE}/song/stem`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: songUrl })
  })

  if (!res.ok) {
    const err = await res.json() as any
    throw new Error(`Stem extraction error: ${err?.error?.message || res.status}`)
  }

  const data = await res.json() as any
  if (!data.zip_url) throw new Error('Stem extraction returned no zip_url')
  return data.zip_url as string
}

// ═══════════════════════════════════════════════════════════════
//  PIPELINE — CLIENT-DRIVEN MODEL
//
//  CF Workers cannot sleep for minutes inside waitUntil.
//  Instead, each POST /api/generate does Step 1 (blueprint + kick
//  off Mureka). Then the frontend calls POST /api/poll/:id every
//  ~5 s — each call does ONE Mureka status check and, when ready,
//  runs Step 3 (stem extraction) synchronously (~5 s).
//  No sleep loops. No long-running tasks.
// ═══════════════════════════════════════════════════════════════

const STEM_CONFIG: Array<{ stem: MurekaStem; name: string; family: string; color: string }> = [
  { stem: 'drums',        name: 'Drums',         family: 'drums',  color: '#ef4444' },
  { stem: 'bass',         name: 'Bass',           family: 'bass',   color: '#3b82f6' },
  { stem: 'vocals',       name: 'Vocals',         family: 'vocals', color: '#ec4899' },
  { stem: 'other',        name: 'Other (Melody)', family: 'synth',  color: '#8b5cf6' },
  { stem: 'instrumental', name: 'Instrumental',   family: 'mix',    color: '#10b981' },
]

// Step 1+2: called once from POST /api/generate (fast — GPT + Mureka kick-off only)
async function startPipeline(jobId: string, env: Bindings) {
  const db = env.DB
  let job = await getJob(db, jobId)
  if (!job) return

  try {
    // Step 1 — GPT blueprint (~2-3 s)
    job.status = 'blueprint'
    await setJob(db, { ...job })

    const blueprint = await generateBlueprint(job.prompt, env.OPENAI_API_KEY)
    job.blueprint = blueprint
    job.tracks = []

    // Step 2 — kick off Mureka instrumental (instant — just submits the job)
    job.status = 'generating'
    await setJob(db, { ...job })

    const stereoTaskId = await startInstrumentalGeneration(blueprint, env.MUREKA_API_KEY)
    job.stereo_task_id = stereoTaskId
    await setJob(db, { ...job })

  } catch (err: any) {
    job.status = 'error'
    job.error = err?.message || 'Pipeline start error'
    await setJob(db, { ...job })
  }
}

// Step 2b+3: called on each POST /api/poll/:id from the frontend
// Does ONE Mureka status check. If done, runs stem extraction and marks ready.
async function advancePipeline(jobId: string, env: Bindings): Promise<Job | null> {
  const db = env.DB
  let job = await getJob(db, jobId)
  if (!job) return null

  // Only advance jobs that are waiting on Mureka
  if (job.status !== 'generating' || !job.stereo_task_id) return job

  try {
    const stereoUrl = await pollInstrumentalStatus(job.stereo_task_id, env.MUREKA_API_KEY)

    if (!stereoUrl) {
      // Not ready yet — check timeout (10 min max)
      const ageMs = Date.now() - job.created_at
      if (ageMs > 10 * 60 * 1000) {
        job.status = 'error'
        job.error = 'Mureka generation timed out after 10 minutes'
        await setJob(db, { ...job })
      }
      return job
    }

    // Mureka is done — run stem extraction (~5-10 s, synchronous)
    job.stereo_url = stereoUrl
    job.status = 'extracting'
    await setJob(db, { ...job })

    const zipUrl = await extractStems(stereoUrl, env.MUREKA_API_KEY)
    job.zip_url = zipUrl
    job.tracks = STEM_CONFIG.map(s => ({
      name: s.name,
      stem: s.stem,
      family: s.family,
      status: 'ready' as const,
      zip_url: zipUrl,
      color: s.color
    }))
    job.status = 'ready'
    await setJob(db, { ...job })

  } catch (err: any) {
    job.status = 'error'
    job.error = err?.message || 'Pipeline advance error'
    await setJob(db, { ...job })
  }

  return job
}

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/generate — start a new generation job
app.post('/api/generate', async (c) => {
  const { prompt, genre, bpm, vocal_space, energy, duration, instruments_include, instruments_exclude } = await c.req.json()

  if (!prompt && !genre) {
    return c.json({ error: 'prompt is required' }, 400)
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

  const fullPrompt = parts.join(', ')
  const jobId = makeJobId()

  const job: Job = {
    id: jobId,
    status: 'pending',
    created_at: Date.now(),
    prompt: fullPrompt,
    tracks: []
  }
  await setJob(c.env.DB, job)

  // Start pipeline in background: Step 1 (GPT blueprint) + Step 2 kick-off (Mureka submit)
  // Both are fast (~3-5 s total). The long Mureka wait is handled client-side via /api/poll/:id
  c.executionCtx.waitUntil(startPipeline(jobId, c.env))

  return c.json({ job_id: jobId, status: 'pending' })
})

// POST /api/poll/:id — called by frontend every ~5s while status=generating
// Does one Mureka status check; if done, runs stem extraction and marks ready.
// Returns the same shape as GET /api/job/:id.
app.post('/api/poll/:id', async (c) => {
  const id = c.req.param('id')
  const job = await advancePipeline(id, c.env)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  return c.json({
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    prompt: job.prompt,
    blueprint: job.blueprint ? {
      bpm: job.blueprint.bpm,
      key: job.blueprint.key,
      scale: job.blueprint.scale,
      genre: job.blueprint.genre,
      mood: job.blueprint.mood,
      duration_seconds: job.blueprint.duration_seconds,
      arrangement: job.blueprint.arrangement,
      instrument_count: job.blueprint.instruments?.length || 0,
      mureka_prompt: job.blueprint.mureka_prompt
    } : null,
    stereo_url: job.stereo_url || null,
    zip_url: job.zip_url || null,
    tracks: job.tracks.map(t => ({
      name: t.name,
      stem: t.stem,
      family: t.family,
      status: t.status,
      zip_url: t.zip_url || null,
      color: t.color
    })),
    error: job.error || null
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
    blueprint: job.blueprint ? {
      bpm: job.blueprint.bpm,
      key: job.blueprint.key,
      scale: job.blueprint.scale,
      genre: job.blueprint.genre,
      mood: job.blueprint.mood,
      duration_seconds: job.blueprint.duration_seconds,
      arrangement: job.blueprint.arrangement,
      instrument_count: job.blueprint.instruments?.length || 0,
      mureka_prompt: job.blueprint.mureka_prompt
    } : null,
    stereo_url: job.stereo_url || null,
    zip_url: job.zip_url || null,
    tracks: job.tracks.map(t => ({
      name: t.name,
      stem: t.stem,
      family: t.family,
      status: t.status,
      zip_url: t.zip_url || null,
      color: t.color
    })),
    error: job.error || null
  })
})

// GET /api/health
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'StemForge' }))

// ═══════════════════════════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', (c) => c.html(homePage()))
app.get('/pricing', (c) => c.html(pricingPage()))
app.get('/generator', (c) => c.html(generatorPage()))
app.get('/dashboard', (c) => c.html(dashboardPage()))
app.get('/project', (c) => c.html(projectPage()))
app.get('/signup', (c) => c.html(signupPage()))
app.get('/login', (c) => c.html(loginPage()))
app.get('/checkout', (c) => c.html(checkoutPage()))

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function shell(title: string, body: string, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — StemForge</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<link rel="stylesheet" href="/static/style.css"/>
${extraHead}
</head>
<body>
${nav()}
${body}
${footer()}
<script src="/static/app.js"></script>
</body>
</html>`
}

function nav() {
  return `<header class="sf-nav" id="sf-nav">
  <div class="sf-nav__inner">
    <a href="/" class="sf-nav__logo">
      <span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span>
      <span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
    </a>
    <nav class="sf-nav__links">
      <a href="/#features">Features</a>
      <a href="/pricing">Pricing</a>
      <a href="/#how">How it works</a>
    </nav>
    <div class="sf-nav__actions">
      <a href="/login" class="btn btn--ghost btn--sm">Log in</a>
      <a href="/signup" class="btn btn--primary btn--sm">Start free</a>
    </div>
    <button class="sf-nav__hamburger" id="hamburger" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
  </div>
  <div class="sf-nav__mobile" id="mobile-menu">
    <a href="/#features">Features</a>
    <a href="/pricing">Pricing</a>
    <a href="/#how">How it works</a>
    <a href="/login">Log in</a>
    <a href="/signup" class="btn btn--primary">Start free</a>
  </div>
</header>`
}

function footer() {
  return `<footer class="sf-footer">
  <div class="sf-footer__inner">
    <div class="sf-footer__brand">
      <a href="/" class="sf-nav__logo">
        <span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span>
        <span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <p>AI beat generation with true individual track export.</p>
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
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
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
<section class="hero">
  <div class="hero__bg">
    <div class="hero__orb hero__orb--1"></div>
    <div class="hero__orb hero__orb--2"></div>
    <div class="hero__grid"></div>
  </div>
  <div class="container hero__content">
    <div class="hero__badge"><i class="fas fa-bolt"></i> AI-powered multitrack generation</div>
    <h1 class="hero__title">Generate the beat.<br/><span class="gradient-text">Keep every track.</span></h1>
    <p class="hero__sub">StemForge generates rap, trap, and R&B beats as individual instrument tracks from the start — no splitting a finished master. Download the stereo mix or pull every instrument separately.</p>
    <div class="hero__ctas">
      <a href="/generator" class="btn btn--primary btn--lg"><i class="fas fa-play"></i> Try the generator</a>
      <a href="/pricing" class="btn btn--outline btn--lg"><i class="fas fa-tags"></i> See pricing</a>
    </div>
    <div class="hero__proof">
      <span><i class="fas fa-check-circle"></i> No credit card required</span>
      <span><i class="fas fa-check-circle"></i> 150 free credits</span>
      <span><i class="fas fa-check-circle"></i> Real AI generation</span>
    </div>
  </div>
  <div class="hero__wave-wrap">
    <div class="waveform-demo">
      <div class="wv-track"><span class="wv-label">Kick</span><div class="wv-bars" data-track="kick"></div></div>
      <div class="wv-track"><span class="wv-label">Snare</span><div class="wv-bars" data-track="snare"></div></div>
      <div class="wv-track"><span class="wv-label">Hi-hats</span><div class="wv-bars" data-track="hats"></div></div>
      <div class="wv-track"><span class="wv-label">Bass</span><div class="wv-bars" data-track="bass"></div></div>
      <div class="wv-track"><span class="wv-label">Rhodes</span><div class="wv-bars" data-track="rhodes"></div></div>
      <div class="wv-track"><span class="wv-label">Guitar</span><div class="wv-bars" data-track="guitar"></div></div>
      <div class="wv-track"><span class="wv-label">Pad</span><div class="wv-bars" data-track="pad"></div></div>
      <div class="wv-track"><span class="wv-label">FX</span><div class="wv-bars" data-track="fx"></div></div>
    </div>
  </div>
</section>

<section class="logos-bar">
  <div class="container">
    <p class="logos-bar__label">Powered by industry-leading AI</p>
    <div class="logos-bar__items">
      <span><i class="fas fa-brain"></i> OpenAI GPT-4o</span>
      <span><i class="fas fa-music"></i> Mureka AI</span>
      <span><i class="fas fa-layer-group"></i> Multitrack Engine</span>
      <span><i class="fas fa-bolt"></i> Edge Deployed</span>
      <span><i class="fas fa-shield-alt"></i> Commercial Use</span>
    </div>
  </div>
</section>

<section class="features" id="features">
  <div class="container">
    <div class="section-header">
      <div class="section-tag">Features</div>
      <h2>Everything you need.<br/>Nothing you don't.</h2>
      <p>Built for artists who want more than a loop.</p>
    </div>
    <div class="features__grid">
      <div class="feature-card feature-card--hero">
        <div class="feature-card__icon"><i class="fas fa-layer-group"></i></div>
        <h3>True individual track export</h3>
        <p>Every instrument on its own file. Kick alone. Snare alone. Rhodes alone. No two sounds share the same stem — ever.</p>
        <div class="feature-card__tracks">
          <span class="track-pill track-pill--kick">Kick.wav</span>
          <span class="track-pill track-pill--snare">Snare.wav</span>
          <span class="track-pill track-pill--hats">Hi-hats.wav</span>
          <span class="track-pill track-pill--bass">Bass.wav</span>
          <span class="track-pill track-pill--keys">Rhodes.wav</span>
          <span class="track-pill track-pill--guitar">Guitar.wav</span>
          <span class="track-pill track-pill--pad">Pad.wav</span>
          <span class="track-pill track-pill--fx">FX.wav</span>
        </div>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-microchip"></i></div>
        <h3>Composition-first generation</h3>
        <p>GPT-4o builds a shared blueprint first — BPM, key, structure, arrangement — so all tracks lock together perfectly.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-sliders"></i></div>
        <h3>Regenerate one track at a time</h3>
        <p>Don't like the bass line? Regenerate just the bass. Everything else stays locked in place.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-compact-disc"></i></div>
        <h3>Master + premaster exports</h3>
        <p>Get a polished mastered stereo mix or the clean premaster for your own engineer.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-tags"></i></div>
        <h3>Smart instrument labeling</h3>
        <p>A flute is labeled "Flute." A guitar is labeled "Guitar." No guessing what's in the FX bus.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-shield-alt"></i></div>
        <h3>Commercial use included</h3>
        <p>All paid plan exports come with full commercial use rights. Sell your beats, release your music.</p>
      </div>
    </div>
  </div>
</section>

<section class="how" id="how">
  <div class="container">
    <div class="section-header">
      <div class="section-tag">How it works</div>
      <h2>From prompt to stems<br/>in under a minute.</h2>
    </div>
    <div class="how__steps">
      <div class="how__step">
        <div class="how__step-num">01</div>
        <div class="how__step-body">
          <h3>Describe your beat</h3>
          <p>Type your prompt. Genre, mood, BPM, instruments. StemForge reads intent.</p>
          <div class="how__step-example">"95 BPM dark surf noir trap beat, open vocal space, Rhodes and guitar texture"</div>
        </div>
      </div>
      <div class="how__step">
        <div class="how__step-num">02</div>
        <div class="how__step-body">
          <h3>GPT-4o builds the blueprint</h3>
          <p>AI creates a shared composition plan — BPM, key, structure, instrument list, arrangement map — before a single note is generated.</p>
        </div>
      </div>
      <div class="how__step">
        <div class="how__step-num">03</div>
        <div class="how__step-body">
          <h3>Mureka renders the audio</h3>
          <p>The full instrumental generates first. Then individual tracks are extracted — each instrument clean on its own file.</p>
        </div>
      </div>
      <div class="how__step">
        <div class="how__step-num">04</div>
        <div class="how__step-body">
          <h3>Download what you need</h3>
          <p>Stereo mix, premaster, grouped stems, or individual tracks. Your plan determines what you can export.</p>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="pricing-preview">
  <div class="container">
    <div class="section-header">
      <div class="section-tag">Pricing</div>
      <h2>Simple, honest pricing.</h2>
      <p>Start free. Upgrade when you need more depth.</p>
    </div>
    <div class="plans-grid">
      <div class="plan-card">
        <div class="plan-card__tier">Free</div>
        <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
        <p class="plan-card__desc">Try the engine. No card needed.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 3 generations/month</li>
          <li><i class="fas fa-check"></i> Stereo preview</li>
          <li><i class="fas fa-check"></i> Stem ZIP download</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full">Get started free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$19</span><span>/month</span></div>
        <p class="plan-card__desc">For rappers, writers, and content creators.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 50 generations/month</li>
          <li><i class="fas fa-check"></i> Full stereo beats</li>
          <li><i class="fas fa-check"></i> Stem ZIP export</li>
          <li><i class="fas fa-check"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
        </ul>
        <a href="/signup?plan=creator" class="btn btn--primary btn--full">Start Creator</a>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$39</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 150 generations/month</li>
          <li><i class="fas fa-check"></i> Everything in Creator</li>
          <li><i class="fas fa-check"></i> Individual tracks</li>
          <li><i class="fas fa-check"></i> Regenerate one track</li>
          <li><i class="fas fa-check"></i> Priority queue</li>
        </ul>
        <a href="/signup?plan=pro" class="btn btn--outline btn--full">Start Pro Artist</a>
      </div>
    </div>
    <div class="pricing-preview__cta">
      <a href="/pricing" class="btn btn--ghost">See full pricing details <i class="fas fa-arrow-right"></i></a>
    </div>
  </div>
</section>

<section class="final-cta">
  <div class="container">
    <div class="final-cta__box">
      <div class="final-cta__orb"></div>
      <h2>Your next beat.<br/>Every track. Ready to download.</h2>
      <p>Start with 150 free credits. No card required.</p>
      <a href="/generator" class="btn btn--primary btn--lg">Try the generator free <i class="fas fa-arrow-right"></i></a>
    </div>
  </div>
</section>
</main>`)
}

// ─── GENERATOR PAGE (real pipeline UI) ───────────────────────────────────────
function generatorPage() {
  return shell('Generator', `
<main class="inner-page app-shell">
<div class="app-sidebar">
  <div class="app-sidebar__section">
    <h4>Genre & mood</h4>
    <select class="sf-select" id="gen-genre">
      <option>Modern Trap</option>
      <option>Dark Drill</option>
      <option>Melodic R&B</option>
      <option>Surf Noir</option>
      <option>Cinematic Hip-Hop</option>
      <option>Afrobeats</option>
      <option>Lo-Fi Hip-Hop</option>
      <option>Boom Bap</option>
    </select>
  </div>
  <div class="app-sidebar__section">
    <h4>BPM</h4>
    <div class="sf-range-wrap">
      <input type="range" id="gen-bpm" min="60" max="180" value="90" class="sf-range"/>
      <span id="gen-bpm-val">90 BPM</span>
    </div>
  </div>
  <div class="app-sidebar__section">
    <h4>Vocal space</h4>
    <div class="toggle-group" id="gen-vocal">
      <button class="toggle-btn active" data-val="high">High</button>
      <button class="toggle-btn" data-val="medium">Medium</button>
      <button class="toggle-btn" data-val="low">Low</button>
    </div>
  </div>
  <div class="app-sidebar__section">
    <h4>Energy level</h4>
    <div class="toggle-group" id="gen-energy">
      <button class="toggle-btn" data-val="low">Low</button>
      <button class="toggle-btn active" data-val="medium">Medium</button>
      <button class="toggle-btn" data-val="high">High</button>
    </div>
  </div>
  <div class="app-sidebar__section">
    <h4>Instruments (include)</h4>
    <div class="tag-group">
      <span class="inst-tag active" data-instr="Rhodes">Rhodes</span>
      <span class="inst-tag active" data-instr="Bass">Bass</span>
      <span class="inst-tag" data-instr="Flute">Flute</span>
      <span class="inst-tag" data-instr="Guitar">Guitar</span>
      <span class="inst-tag" data-instr="Violin">Violin</span>
      <span class="inst-tag" data-instr="Trumpet">Trumpet</span>
      <span class="inst-tag" data-instr="Piano">Piano</span>
      <span class="inst-tag" data-instr="Synth">Synth</span>
    </div>
  </div>
  <div class="app-sidebar__section">
    <h4>Exclude</h4>
    <div class="tag-group">
      <span class="inst-tag inst-tag--exclude active" data-instr="Retro">Retro</span>
      <span class="inst-tag inst-tag--exclude" data-instr="8-bit">8-bit</span>
      <span class="inst-tag inst-tag--exclude" data-instr="Acoustic">Acoustic</span>
    </div>
  </div>
  <div class="credit-pill"><i class="fas fa-music"></i> 3 generations remaining</div>
</div>

<div class="app-main">
  <div class="app-main__top">
    <div class="prompt-box">
      <label class="prompt-box__label">Beat description</label>
      <textarea class="prompt-box__input" id="gen-prompt"
        placeholder="Describe your beat... e.g. dark surf noir trap beat, open vocal space, minimal percussion, moody Rhodes"></textarea>
      <div class="prompt-box__meta">
        <span class="prompt-box__cost"><i class="fas fa-music"></i> 1 generation — stereo mix + 5-stem ZIP</span>
      </div>
    </div>
    <div class="gen-actions">
      <button class="btn btn--primary btn--lg" id="gen-full-btn">
        <i class="fas fa-play"></i> Generate Beat — 1 generation
      </button>
    </div>
  </div>

  <!-- Pipeline status -->
  <div class="pipeline-status" id="pipeline-status" style="display:none">
    <div class="pipeline-steps">
      <div class="pipeline-step" id="step-blueprint">
        <div class="pipeline-step__icon"><i class="fas fa-brain"></i></div>
        <div class="pipeline-step__body">
          <strong>Building blueprint</strong>
          <span>GPT-4o analyzing your prompt...</span>
        </div>
        <div class="pipeline-step__indicator" id="ind-blueprint"></div>
      </div>
      <div class="pipeline-step" id="step-generating">
        <div class="pipeline-step__icon"><i class="fas fa-music"></i></div>
        <div class="pipeline-step__body">
          <strong>Generating instrumental</strong>
          <span>Mureka AI composing your beat...</span>
        </div>
        <div class="pipeline-step__indicator" id="ind-generating"></div>
      </div>
      <div class="pipeline-step" id="step-extracting">
        <div class="pipeline-step__icon"><i class="fas fa-layer-group"></i></div>
        <div class="pipeline-step__body">
          <strong>Extracting individual tracks</strong>
          <span>Separating each instrument...</span>
        </div>
        <div class="pipeline-step__indicator" id="ind-extracting"></div>
      </div>
    </div>
    <div class="pipeline-blueprint" id="pipeline-blueprint" style="display:none">
      <div class="blueprint-pills" id="blueprint-pills"></div>
    </div>
  </div>

  <!-- Result area -->
  <div class="gen-result" id="gen-result" style="display:none">
    <div class="gen-result__header">
      <div>
        <h3 id="gen-result-title">Beat Ready</h3>
        <p id="gen-result-sub">Loading track info...</p>
      </div>
      <div class="gen-result__status">
        <span class="status-dot status-dot--ready"></span> Ready
      </div>
    </div>

    <!-- Stereo player -->
    <div class="stereo-player" id="stereo-player" style="display:none">
      <div class="stereo-player__label"><i class="fas fa-music"></i> Full stereo mix</div>
      <audio id="stereo-audio" controls style="width:100%;margin-top:8px;"></audio>
      <a id="stereo-download" class="btn btn--outline btn--sm" style="margin-top:10px" download>
        <i class="fas fa-download"></i> Download stereo mix
      </a>
    </div>

    <!-- Track list -->
    <div class="track-list" id="track-list"></div>

    <!-- Export panel -->
    <div class="export-panel">
      <h4>Export options</h4>
      <div class="export-options">
        <button class="export-btn" id="exp-stereo"><i class="fas fa-file-audio"></i><span>Stereo mix</span><small>Free</small></button>
        <button class="export-btn" id="exp-stems"><i class="fas fa-layer-group"></i><span>Stem ZIP</span><small>Free</small></button>
        <button class="export-btn export-btn--locked" id="exp-tracks"><i class="fas fa-list"></i><span>Individual tracks</span><small>Pro Artist</small></button>
      </div>
      <a href="/pricing" class="upgrade-nudge"><i class="fas fa-arrow-up"></i> Upgrade to Pro Artist to unlock individual track downloads</a>
    </div>
  </div>

  <!-- Empty state -->
  <div class="gen-empty" id="gen-empty">
    <div class="gen-empty__icon"><i class="fas fa-wave-square"></i></div>
    <h3>Your beat will appear here.</h3>
    <p>Set your options on the left, describe your beat above, and hit generate.<br/>
    Real AI generation powered by GPT-4o + Mureka.</p>
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
</div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

// ─── PRICING PAGE ────────────────────────────────────────────────────────────
function pricingPage() {
  return shell('Pricing', `
<main class="inner-page">
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
      <div class="plan-card">
        <div class="plan-card__tier">Free</div>
        <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
        <p class="plan-card__desc">Try the engine. No card needed.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 3 generations/month</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full AI beat generation</li>
          <li><i class="fas fa-check"></i> Stereo preview & download</li>
          <li><i class="fas fa-check"></i> Stem ZIP (5 stems)</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
          <li class="muted"><i class="fas fa-times"></i> Overage add-ons</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full">Start free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$19</span><span>/month</span></div>
        <p class="plan-card__desc">For rappers, writers, and content creators.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 50 generations/month</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full AI beat generation</li>
          <li><i class="fas fa-check"></i> Stereo download</li>
          <li><i class="fas fa-check"></i> Stem ZIP export (5 stems)</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> +$0.49 per extra generation</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
        </ul>
        <a href="/signup?plan=creator" class="btn btn--primary btn--full">Start Creator — $19/mo</a>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$39</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track clean.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 150 generations/month</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Everything in Creator</li>
          <li><i class="fas fa-check"></i> Individual track download</li>
          <li><i class="fas fa-check"></i> Regenerate one track</li>
          <li><i class="fas fa-check"></i> Replace instrument</li>
          <li><i class="fas fa-check"></i> Priority queue</li>
          <li><i class="fas fa-check"></i> +$0.49 per extra generation</li>
        </ul>
        <a href="/signup?plan=pro" class="btn btn--outline btn--full">Start Pro Artist — $39/mo</a>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Studio</div>
        <div class="plan-card__price"><span class="plan-card__amount">$79</span><span>/month</span></div>
        <p class="plan-card__desc">For labels, studios, and power producers.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 400 generations/month</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Everything in Pro Artist</li>
          <li><i class="fas fa-check"></i> Team seat (up to 3 users)</li>
          <li><i class="fas fa-check"></i> Highest priority queue</li>
          <li><i class="fas fa-check"></i> Bulk export</li>
          <li><i class="fas fa-check"></i> API access (coming soon)</li>
          <li><i class="fas fa-check"></i> +$0.39 per extra generation</li>
        </ul>
        <a href="/signup?plan=studio" class="btn btn--outline btn--full">Start Studio — $79/mo</a>
      </div>
    </div>

    <div class="credit-table-wrap">
      <div class="section-header">
        <div class="section-tag">What's included</div>
        <h2>Simple, generation-based pricing.</h2>
      </div>
      <div class="credit-table">
        <div class="credit-table__row credit-table__row--header"><span>What you get</span><span>Cost</span><span>Plan</span></div>
        <div class="credit-table__row"><span><i class="fas fa-music"></i> Full AI beat (stereo + 5-stem ZIP)</span><span class="credit-val">1 gen</span><span class="tier-badge tier-badge--free">All plans</span></div>
        <div class="credit-table__row"><span><i class="fas fa-download"></i> Stereo mix download</span><span class="credit-val">Free</span><span class="tier-badge tier-badge--free">All plans</span></div>
        <div class="credit-table__row"><span><i class="fas fa-layer-group"></i> Stem ZIP (5 stems)</span><span class="credit-val">Free</span><span class="tier-badge tier-badge--free">All plans</span></div>
        <div class="credit-table__row"><span><i class="fas fa-list"></i> Individual track download</span><span class="credit-val">Free</span><span class="tier-badge tier-badge--pro">Pro Artist+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-redo"></i> Regenerate one track</span><span class="credit-val">1 gen</span><span class="tier-badge tier-badge--pro">Pro Artist+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-exchange-alt"></i> Replace instrument</span><span class="credit-val">1 gen</span><span class="tier-badge tier-badge--pro">Pro Artist+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-plus-circle"></i> Extra generation (Creator / Pro)</span><span class="credit-val">$0.49</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-plus-circle"></i> Extra generation (Studio)</span><span class="credit-val">$0.39</span><span class="tier-badge tier-badge--pro">Studio</span></div>
      </div>
    </div>

    <div class="faq-wrap">
      <div class="section-header"><div class="section-tag">FAQ</div><h2>Common questions.</h2></div>
      <div class="faq">
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What counts as one generation? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">One generation = one full AI beat: GPT-4o builds the blueprint, Mureka renders the instrumental, and stems are extracted — all included. You get the stereo mix + a 5-stem ZIP from that single generation.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What happens if I run out of generations? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Creator and Pro Artist plans support overage at $0.49 per extra generation. Studio plans get $0.39/gen. Free plan users must upgrade to continue after 3 generations.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What is in the stem ZIP vs individual track download? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">The stem ZIP (free on all plans) contains 5 audio files: Drums, Bass, Vocals, Other/Melody, and Instrumental mix. Individual track download (Pro Artist+) lets you access each stem file separately by name.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I use the beats commercially? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes — Creator, Pro Artist, and Studio exports include full commercial use rights. Free plan exports are for personal/demo use only.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Do unused generations roll over? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Unused generations do not roll over. Your count resets on your billing date each month.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I cancel anytime? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes. Cancel anytime from account settings. No cancellation fees. You keep access until the end of your billing period.</div></div>
      </div>
    </div>
  </div>
</section>
</main>`)
}

// ─── REMAINING PAGES (Dashboard, Project, Auth) ───────────────────────────────
function dashboardPage() {
  return shell('Dashboard', `
<main class="inner-page app-shell">
<div class="app-sidebar app-sidebar--dash">
  <div class="dash-user"><div class="dash-user__avatar">KD</div><div><strong>Kay D.</strong><span class="dash-user__plan plan-badge plan-badge--creator">Creator</span></div></div>
  <nav class="dash-nav">
    <a href="/dashboard" class="dash-nav__item active"><i class="fas fa-th-large"></i> Projects</a>
    <a href="/generator" class="dash-nav__item"><i class="fas fa-play-circle"></i> New beat</a>
    <a href="#" class="dash-nav__item"><i class="fas fa-chart-bar"></i> Usage</a>
    <a href="#" class="dash-nav__item"><i class="fas fa-cog"></i> Settings</a>
  </nav>
  <div class="dash-credits-card">
    <div class="dash-credits-card__label">Generations used</div>
    <div class="dash-credits-card__val">32 <small>/ 50 gen</small></div>
    <div class="dash-credits-card__bar"><div style="width:64%"></div></div>
    <a href="/pricing" class="btn btn--primary btn--sm btn--full" style="margin-top:12px">Upgrade to Pro Artist</a>
  </div>
</div>
<div class="app-main">
  <div class="dash-header"><h2>My Projects</h2><a href="/generator" class="btn btn--primary"><i class="fas fa-plus"></i> New beat</a></div>
  <div class="project-grid">
    <a href="/project" class="project-card"><div class="project-card__art project-card__art--1"><div class="project-card__play"><i class="fas fa-play"></i></div></div><div class="project-card__body"><h4>Surf Noir Trap</h4><p>90 BPM · 8 tracks · 2:14</p><div class="project-card__tags"><span class="export-badge export-badge--stereo">Stereo</span></div></div></a>
    <a href="/project" class="project-card"><div class="project-card__art project-card__art--2"><div class="project-card__play"><i class="fas fa-play"></i></div></div><div class="project-card__body"><h4>Dark Drill Night</h4><p>140 BPM · 10 tracks · 3:01</p><div class="project-card__tags"><span class="export-badge export-badge--stereo">Stereo</span></div></div></a>
    <div class="project-card project-card--new"><a href="/generator" class="project-card__new-inner"><i class="fas fa-plus-circle"></i><span>New beat</span></a></div>
  </div>
</div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

function projectPage() {
  return shell('Project Export', `
<main class="inner-page app-shell">
<div class="app-sidebar app-sidebar--dash">
  <nav class="dash-nav"><a href="/dashboard" class="dash-nav__item"><i class="fas fa-arrow-left"></i> Back</a></nav>
  <div class="project-meta-card"><div class="project-meta-card__art project-card__art--1"></div><h4>Surf Noir Trap</h4><p>90 BPM · D Minor · 2:14</p><div class="project-meta-card__plan plan-badge plan-badge--creator">Creator plan</div></div>
  <div class="dash-credits-card" style="margin-top:16px"><div class="dash-credits-card__label">Generations used</div><div class="dash-credits-card__val">32 <small>/ 50 gen</small></div><a href="/pricing" class="btn btn--primary btn--sm btn--full" style="margin-top:8px">Upgrade plan</a></div>
</div>
<div class="app-main">
  <div class="dash-header"><h2>Surf Noir Trap <span class="dash-header__sub">Export</span></h2></div>
  <div class="export-tier-grid">
    <div class="export-tier-card export-tier-card--available"><div class="export-tier-card__icon"><i class="fas fa-file-audio"></i></div><div class="export-tier-card__body"><h4>Stereo mix</h4><p>Full stereo bounce.</p><span class="credit-tag">Free</span></div><button class="btn btn--primary btn--sm"><i class="fas fa-download"></i> Download</button></div>
    <div class="export-tier-card export-tier-card--available"><div class="export-tier-card__icon"><i class="fas fa-layer-group"></i></div><div class="export-tier-card__body"><h4>Stem ZIP</h4><p>5 files: Drums / Bass / Vocals / Melody / Instrumental.</p><span class="credit-tag">Free</span></div><button class="btn btn--primary btn--sm"><i class="fas fa-download"></i> Download</button></div>
    <div class="export-tier-card export-tier-card--locked"><div class="export-tier-card__icon"><i class="fas fa-list"></i></div><div class="export-tier-card__body"><h4>Individual tracks <span class="lock-badge"><i class="fas fa-lock"></i> Pro Artist</span></h4><p>Download each stem file separately.</p><span class="credit-tag">Pro Artist+</span></div><a href="/pricing" class="btn btn--outline btn--sm">Upgrade</a></div>
  </div>
</div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

function signupPage() {
  return shell('Create your account', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo"><span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <h1>Start generating.<br/>Keep every track.</h1>
      <ul class="auth-benefits">
        <li><i class="fas fa-check-circle"></i> 150 free credits, no card needed</li>
        <li><i class="fas fa-check-circle"></i> Real AI beat generation</li>
        <li><i class="fas fa-check-circle"></i> Individual track export on Pro</li>
        <li><i class="fas fa-check-circle"></i> Cancel anytime</li>
      </ul>
    </div>
    <div class="auth-split__right">
      <div class="auth-card">
        <h2>Create your account</h2>
        <p class="auth-card__sub">Already have one? <a href="/login">Log in</a></p>
        <div class="oauth-btns">
          <button class="oauth-btn"><i class="fab fa-google"></i> Continue with Google</button>
          <button class="oauth-btn"><i class="fab fa-apple"></i> Continue with Apple</button>
        </div>
        <div class="auth-divider"><span>or sign up with email</span></div>
        <form class="auth-form" id="signup-form">
          <div class="form-group"><label>Full name</label><input type="text" placeholder="Your name"/></div>
          <div class="form-group"><label>Email</label><input type="email" placeholder="you@example.com"/></div>
          <div class="form-group"><label>Password</label><div class="input-icon-wrap"><input type="password" id="pw-input" placeholder="At least 8 characters"/><button type="button" class="input-icon-btn" id="pw-toggle"><i class="fas fa-eye" id="pw-eye"></i></button></div><div class="pw-strength" id="pw-strength"></div></div>
          <div class="form-group"><label>Plan</label><div class="plan-radio-group"><label class="plan-radio"><input type="radio" name="plan" value="free" checked/><span>Free — $0</span></label><label class="plan-radio"><input type="radio" name="plan" value="creator"/><span>Creator — $19/mo</span></label><label class="plan-radio"><input type="radio" name="plan" value="pro"/><span>Pro Artist — $39/mo</span></label><label class="plan-radio"><input type="radio" name="plan" value="studio"/><span>Studio — $79/mo</span></label></div></div>
          <div class="form-group form-group--check"><label class="checkbox-label"><input type="checkbox" required/> I agree to the <a href="#">Terms</a> and <a href="#">Privacy Policy</a></label></div>
          <button type="submit" class="btn btn--primary btn--full btn--lg">Create account <i class="fas fa-arrow-right"></i></button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

function loginPage() {
  return shell('Log in', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo"><span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <h1>Welcome back.<br/>Your tracks are waiting.</h1>
      <ul class="auth-benefits"><li><i class="fas fa-check-circle"></i> Access all your projects</li><li><i class="fas fa-check-circle"></i> Download your exports</li><li><i class="fas fa-check-circle"></i> Continue generating</li></ul>
    </div>
    <div class="auth-split__right">
      <div class="auth-card">
        <h2>Log in</h2>
        <p class="auth-card__sub">Don't have an account? <a href="/signup">Sign up free</a></p>
        <div class="oauth-btns"><button class="oauth-btn"><i class="fab fa-google"></i> Continue with Google</button><button class="oauth-btn"><i class="fab fa-apple"></i> Continue with Apple</button></div>
        <div class="auth-divider"><span>or log in with email</span></div>
        <form class="auth-form" id="login-form">
          <div class="form-group"><label>Email</label><input type="email" placeholder="you@example.com"/></div>
          <div class="form-group"><label>Password</label><div class="input-icon-wrap"><input type="password" id="pw-input" placeholder="Your password"/><button type="button" class="input-icon-btn" id="pw-toggle"><i class="fas fa-eye" id="pw-eye"></i></button></div><div class="form-group__hint"><a href="#">Forgot password?</a></div></div>
          <button type="submit" class="btn btn--primary btn--full btn--lg">Log in <i class="fas fa-arrow-right"></i></button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

function checkoutPage() {
  return shell('Checkout', `
<main class="auth-page">
  <div class="checkout-wrap">
    <div class="checkout-left">
      <a href="/" class="sf-nav__logo auth-logo" style="margin-bottom:32px;display:inline-flex"><span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <div class="checkout-plan-summary">
        <div class="checkout-plan-summary__header"><div><h3>Creator Plan</h3><p>Billed monthly · Cancel anytime</p></div><div class="checkout-plan-summary__price">$19<span>/mo</span></div></div>
        <ul class="checkout-plan-summary__features"><li><i class="fas fa-check"></i> 50 generations/month</li><li><i class="fas fa-check"></i> Stereo + 5-stem ZIP download</li><li><i class="fas fa-check"></i> Commercial use rights</li></ul>
        <div class="checkout-plan-summary__total"><span>Total today</span><strong>$19.00</strong></div>
      </div>
      <div class="checkout-trust"><span><i class="fas fa-lock"></i> Secure</span><span><i class="fas fa-shield-alt"></i> SSL</span><span><i class="fas fa-undo"></i> Cancel anytime</span></div>
    </div>
    <div class="checkout-right">
      <div class="auth-card">
        <h2>Payment details</h2>
        <form class="auth-form" id="checkout-form">
          <div class="form-group"><label>Email</label><input type="email" placeholder="you@example.com"/></div>
          <div class="form-group"><label>Card number</label><input type="text" placeholder="1234 5678 9012 3456" id="card-num" maxlength="19"/></div>
          <div class="form-row-2"><div class="form-group"><label>Expiry</label><input type="text" placeholder="MM / YY" id="card-exp" maxlength="7"/></div><div class="form-group"><label>CVC</label><input type="text" placeholder="123" id="card-cvc" maxlength="4"/></div></div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="checkout-submit"><i class="fas fa-lock"></i> Start Creator — $19/month</button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

export default app
