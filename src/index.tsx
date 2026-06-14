import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  OPENAI_API_KEY: string
  MUREKA_API_KEY: string
  DB: D1Database             // Cloudflare D1 for persistent job storage
  IMAGES: R2Bucket           // Cloudflare R2 for permanent cover art storage
  // Auth + Payments (set via gsk hosted deploy or wrangler secret put)
  GOOGLE_CLIENT_ID: string          // Google OAuth App client ID
  GOOGLE_CLIENT_SECRET: string      // Google OAuth App client secret
  STRIPE_SECRET_KEY: string         // Stripe secret key (sk_live_... or sk_test_...)
  STRIPE_WEBHOOK_SECRET: string     // Stripe webhook signing secret
  STRIPE_CREATOR_PRICE_ID: string   // Stripe Price ID for Creator $19/mo
  STRIPE_PRO_PRICE_ID: string       // Stripe Price ID for Pro Artist $39/mo
  SESSION_SECRET: string            // 32+ char random string for session HMAC
  SITE_URL: string                  // e.g. https://473bb3a0-5a11-4e55-b6ea-c81157be4dc1.vip.gensparksite.com
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
  // Add user_id column if it doesn't exist (migration-safe)
  try {
    await db.prepare(`ALTER TABLE jobs ADD COLUMN user_id TEXT`).run()
  } catch { /* column already exists */ }
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
//  AUTH — Users, Sessions, Google OAuth, Email/Password
//  Uses D1 for persistence. Falls back gracefully if secrets
//  are not yet configured (returns 503 with setup message).
// ═══════════════════════════════════════════════════════════════

interface User {
  id: string
  email: string
  name: string
  avatar?: string
  plan: 'free' | 'creator' | 'pro'
  gens_used: number
  gens_limit: number
  stripe_customer_id?: string
  stripe_subscription_id?: string
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
      gens_limit INTEGER NOT NULL DEFAULT 3,
      password_hash TEXT,
      google_id TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ])
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
      plan: row.plan, gens_used: row.gens_used, gens_limit: row.gens_limit,
      stripe_customer_id: row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
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

// ── User DB helpers ───────────────────────────────────────────
async function getUserByEmail(db: D1Database, email: string): Promise<any | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<any>()
}

async function createUser(db: D1Database, data: {
  id: string, email: string, name: string, avatar?: string,
  password_hash?: string, google_id?: string, plan?: string
}): Promise<void> {
  await ensureAuthTables(db)
  const planLimits: Record<string, number> = { free:3, creator:50, pro:150 }
  const plan = data.plan || 'free'
  await db.prepare(
    `INSERT INTO users (id, email, name, avatar, plan, gens_used, gens_limit, password_hash, google_id, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(data.id, data.email, data.name, data.avatar || null, plan,
    planLimits[plan] || 3, data.password_hash || null, data.google_id || null, Date.now()).run()
}

async function updateUserPlan(db: D1Database, userId: string, plan: string,
  stripeCustomerId: string, stripeSubId: string): Promise<void> {
  const planLimits: Record<string, number> = { free:3, creator:50, pro:150 }
  // Apply rollover: unused downloads carry over, capped at 500
  const currentUser = await db.prepare('SELECT gens_used, gens_limit FROM users WHERE id=?').bind(userId).first<{gens_used:number,gens_limit:number}>()
  const newLimit = planLimits[plan] || 3
  let rolledLimit = newLimit
  if (currentUser) {
    const unused = Math.max(0, currentUser.gens_limit - currentUser.gens_used)
    rolledLimit = Math.min(500, newLimit + unused)
  }
  await db.prepare(
    `UPDATE users SET plan=?, gens_limit=?, gens_used=0, stripe_customer_id=?, stripe_subscription_id=? WHERE id=?`
  ).bind(plan, rolledLimit, stripeCustomerId, stripeSubId, userId).run()
}

// ── Monthly reset with rollover (called on invoice.paid Stripe event) ─────
async function resetMonthlyDownloads(db: D1Database, customerId: string, plan: string): Promise<void> {
  const planLimits: Record<string, number> = { free:3, creator:50, pro:150 }
  const newMonthBase = planLimits[plan] || 3
  const currentUser = await db.prepare('SELECT gens_used, gens_limit FROM users WHERE stripe_customer_id=?').bind(customerId).first<{gens_used:number,gens_limit:number}>()
  if (!currentUser) return
  const unused = Math.max(0, currentUser.gens_limit - currentUser.gens_used)
  const rolledLimit = Math.min(500, newMonthBase + unused)
  await db.prepare(
    `UPDATE users SET gens_used=0, gens_limit=? WHERE stripe_customer_id=?`
  ).bind(rolledLimit, customerId).run()
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
  if (priceId === env.STRIPE_CREATOR_PRICE_ID) return 'creator'
  if (priceId === env.STRIPE_PRO_PRICE_ID) return 'pro'
  return 'free'
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
  title?: string          // User-provided or AI-generated title
  user_lyrics?: string    // User lyrics/notes
  thumbnail_seed?: number // Deterministic color seed for thumbnail gradient
  image_url?: string      // Pollinations.ai generated cover art URL
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

// Keys to rotate through for variety — seeded by current minute so same session gets same key but changes over time
const ALL_KEYS = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']
function pickRandomKey(): string {
  return ALL_KEYS[Math.floor(Math.random() * ALL_KEYS.length)]
}

async function generateBlueprint(prompt: string, apiKey: string, titleHint?: string): Promise<Blueprint & { suggested_title?: string }> {
  const suggestedKey = pickRandomKey()

  // Extract genre/style from the front of the prompt if present (it's always prepended first)
  const genreMatch = prompt.match(/^([^.]+?)[\.\,]/)
  const detectedGenre = genreMatch ? genreMatch[1].trim() : ''

  const systemPrompt = `You are a professional music producer AI that creates beat blueprints.
You STRICTLY follow the user's genre, mood, and style — you NEVER substitute or drift.

ABSOLUTE RULES — violating any rule is a failure:
1. GENRE LOCK: The genre field MUST exactly match whatever genre/style the user wrote. If user says "hip hop" → genre = "hip hop". If user says "pop" → genre = "pop". If user says "drill" → genre = "drill". NEVER change it to jazz, R&B, soul, or anything else unless that is what the user wrote.
2. SOUND AUTHENTICITY: The entire blueprint — BPM, instruments, mood, mureka_prompt — MUST sound like the stated genre. Hip hop = punchy 808s + trap hi-hats + sampled chops. Pop = bright synths + 4-on-floor kick + catchy lead. Drill = sliding 808s + rolling hi-hats + dark piano. R&B = silky pads + soft kit + groove. Do NOT add jazz piano, brushed snares, or laid-back swing unless the user asked for that.
3. BPM ACCURACY: Hip hop = 85–100 BPM. Trap = 130–145 BPM. Drill = 140–145 BPM. Pop = 100–128 BPM. R&B = 65–95 BPM. Lo-fi = 70–90 BPM. Afrobeats = 100–115 BPM. Always use the correct BPM range for the genre.
4. KEY VARIETY: Use the suggested_key provided. Never default to C minor every time.
5. TITLE: If user left title blank, create a 2–4 word creative track name that fits the genre.
6. mureka_prompt: MUST open with the exact genre name, then describe sound in detail (energy, instruments, feel). Max 200 chars.
Output valid JSON only — no markdown, no explanation.`

  const userPrompt = `Generate a beat blueprint for: "${prompt}"
${titleHint ? `Track title provided by user: "${titleHint}"` : 'No title given — create a creative genre-fitting title in suggested_title.'}
Suggested key: ${suggestedKey}

GENRE DETECTED FROM INPUT: "${detectedGenre || 'use whatever genre the user specified in the prompt above'}"
→ The entire blueprint MUST sound like this genre. Do not drift.

Genre-to-sound mapping examples (follow these exactly for the detected genre):
- "hip hop" → BPM 85–100, 808 bass, punchy kick, snappy snare, trap hi-hats, sampled chops or Rhodes, aggressive/confident mood
- "trap" → BPM 130–145, sliding 808s, rapid triplet hi-hats, heavy kick, dark melody, energy=high
- "drill" → BPM 140–145, sliding 808 glide, rolling hi-hats, dark minor piano, cold/menacing mood
- "pop" → BPM 100–128, bright lead synth, 4-on-the-floor kick, punchy snare, catchy melodic hook, energy=high
- "R&B" → BPM 65–95, silky pad, soft snare, soulful chords, intimate/smooth mood
- "lo-fi" → BPM 70–90, mellow piano, dusty vinyl crackle, boom-bap kit, nostalgic/chill mood
- "afrobeats" → BPM 100–115, talking drum pattern, afrobeats percussion, melodic guitar, energetic
- "reggaeton" → BPM 95–105, dembow rhythm, heavy bass, brass stabs, perreo energy
- "jazz" → BPM 90–140, swing feel, walking bass, ride cymbal, chord voicings
- "cinematic" → BPM 60–100, orchestral strings, dramatic brass, epic pads, swelling dynamics

Return ONLY this JSON:
{
  "bpm": <correct BPM for the genre>,
  "key": <${suggestedKey} unless user specified otherwise>,
  "scale": <choose based on genre mood — hip hop/trap/drill = minor, pop = major, R&B = minor/major pentatonic>,
  "genre": <EXACT genre string from user input — do not change>,
  "mood": <specific mood word matching the genre e.g. "aggressive", "smooth", "dark", "uplifting">,
  "energy": <"low" | "medium" | "high">,
  "duration_seconds": <90 | 120 | 150 | 180>,
  "sections": ["intro", "verse", "hook", "verse", "hook", "outro"],
  "arrangement": <one sentence describing how this genre sounds — be specific to the genre>,
  "suggested_title": <2–4 word track name that fits the genre, e.g. "Drip Season", "Gold Rush Pop", "Night Shift Trap">,
  "mureka_prompt": <MUST start with exact genre name, then describe sound: instruments, energy, feel. Example: "hip hop beat, punchy 808 bass, trap hi-hats, sampled Rhodes chops, aggressive energy, dark mood" — max 200 chars>,
  "instruments": [
    {
      "name": <genre-appropriate instrument name>,
      "family": <"drums" | "bass" | "keys" | "guitar" | "strings" | "brass" | "woodwind" | "synth" | "fx">,
      "role": <"rhythmic" | "harmonic" | "melodic" | "textural" | "transitional">,
      "mureka_track_type": <"vocals" | "accompaniment" | "bass" | "drums">
    }
  ]
}

Instrument rules:
- 6–10 instruments, always include kick + snare/hi-hats + bass at minimum
- All instruments MUST be genre-appropriate (no jazz brushes in hip hop, no 808s in jazz, no grand piano in drill unless specified)
- mureka_track_type: kick/snare/hats → "drums", 808/bass → "bass", keys/guitar/pad/strings → "accompaniment", fx/vox → "vocals"`

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
//  V2 (audio-separation-2): up to 12 stems + MIDI — both Creator & Pro
//  Creator: 2 credits, Pro: 10 credits (Pro gets priority queue + MIDI)
//  Returns { zip_url, midi_zip_url? } synchronously — no polling needed!
// ═══════════════════════════════════════════════════════════════

async function extractStems(songUrl: string, apiKey: string, model: 'audio-separation-1' | 'audio-separation-2' = 'audio-separation-1'): Promise<{ zip_url: string; midi_zip_url?: string }> {
  const res = await fetch(`${MUREKA_BASE}/song/stem`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: songUrl, model })
  })

  if (!res.ok) {
    const err = await res.json() as any
    throw new Error(`Stem extraction error: ${err?.error?.message || res.status}`)
  }

  const data = await res.json() as any
  if (!data.zip_url) throw new Error('Stem extraction returned no zip_url')
  return { zip_url: data.zip_url as string, midi_zip_url: data.midi_zip_url || undefined }
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
  { stem: 'drums',   name: 'Drums',         family: 'drums',  color: '#ef4444' },
  { stem: 'bass',    name: 'Bass',           family: 'bass',   color: '#3b82f6' },
  { stem: 'vocals',  name: 'Vocals',         family: 'vocals', color: '#ec4899' },
  { stem: 'other',   name: 'Other (Melody)', family: 'synth',  color: '#8b5cf6' },
  // Note: 'instrumental' stem removed — we surface this as a toggle (vocals/instrumental mix)
  // on the stems page rather than as a stem track.
]

// Build a Pollinations.ai cover art URL from the job's blueprint/title.
// Uses Flux model — deterministic from seed so same job always returns same image.
function buildCoverImageUrl(job: Job): string {
  const bp = job.blueprint
  const genre = bp?.genre || 'music'
  const mood  = (bp as any)?.mood  || 'atmospheric'
  const title = (job as any).title  || genre
  const energy = (bp as any)?.energy || 'medium'
  // Craft a detailed album-cover art prompt for best visual results
  const prompt = `${genre} music album cover, ${mood} atmosphere, ${energy} energy, cinematic composition, professional studio photography, moody dark background, dramatic lighting, artistic, 4K high quality, ${title}`
  const seed   = job.thumbnail_seed ?? 42
  // Use nologo=true&enhance=true for better quality
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&seed=${seed}&nologo=true&enhance=true&model=flux`
}

// Step 1+2: called once from POST /api/generate (fast — GPT + Mureka kick-off only)
async function startPipeline(jobId: string, env: Bindings) {
  const db = env.DB
  let job = await getJob(db, jobId)
  if (!job) return

  try {
    // Step 1 — GPT blueprint (~2-3 s)
    job.status = 'blueprint'
    await setJob(db, { ...job })

    const userTitle = (job as any).title as string | undefined
    const blueprint = await generateBlueprint(job.prompt, env.OPENAI_API_KEY, userTitle)

    // Auto-name the track if user left title blank
    if (!userTitle && (blueprint as any).suggested_title) {
      (job as any).title = (blueprint as any).suggested_title
    }

    // Generate deterministic thumbnail seed from job id
    job.thumbnail_seed = job.thumbnail_seed || (job.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360)

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

// Step 2b+3: called on each POST /api/poll/:id from the frontend.
// Stems are NEVER auto-generated on beat creation (all plans).
// Users request stems on-demand via POST /api/job/stems — paid separately.
async function advancePipeline(jobId: string, env: Bindings, skipStems = true): Promise<Job | null> {
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

    // Mureka instrumental is done — save stereo URL
    job.stereo_url = stereoUrl

    // Do NOT pre-populate image_url here with a pollinations URL.
    // Cover art is generated on-demand by /api/cover-image/:jobId (gpt-image-1 → R2 → D1).
    // Storing a pollinations URL here would cause it to be re-generated on every refresh
    // because the cover-image route rejects non-/api/cover-art/ URLs.

    // All plans: stereo only on generation. Stems requested on-demand via /api/job/stems.
    job.zip_url = null
    job.tracks = []
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
  const { prompt, genre, bpm, vocal_space, energy, duration, instruments_include, instruments_exclude, title } = await c.req.json()

  if (!prompt && !genre) {
    return c.json({ error: 'prompt is required' }, 400)
  }

  // ── Auth + generation limit check ────────────────────────────
  let userId: string | undefined
  if (c.env.DB && c.env.SESSION_SECRET) {
    try {
      const token = getSessionCookie(c.req.raw)
      if (token) {
        const u = await getSessionUser(c.env.DB, token)
        if (u) {
          // Enforce per-plan generation limit
          if (u.gens_used >= u.gens_limit) {
            return c.json({
              error: `Download limit reached. You have used all ${u.gens_limit} download${u.gens_limit === 1 ? '' : 's'} for this month. Upgrade your plan to continue.`,
              limit_reached: true
            }, 403)
          }
          userId = u.id
          // Increment usage counter immediately so concurrent requests can't race past the limit
          await c.env.DB.prepare(
            `UPDATE users SET gens_used = gens_used + 1 WHERE id = ?`
          ).bind(u.id).run()
        }
      }
    } catch { /* session lookup failed — allow generation to proceed */ }
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
    tracks: [],
    title: title || undefined,
    thumbnail_seed: Math.floor(Math.random() * 360)
  }
  await setJob(c.env.DB, job, userId)

  // Start pipeline in background: Step 1 (GPT blueprint) + Step 2 kick-off (Mureka submit)
  // Both are fast (~3-5 s total). The long Mureka wait is handled client-side via /api/poll/:id
  c.executionCtx.waitUntil(startPipeline(jobId, c.env))

  return c.json({ job_id: jobId, status: 'pending' })
})

// POST /api/poll/:id — called by frontend every ~5s while status=generating
// Does one Mureka status check; sets job to ready with stereo only (stems on-demand).
// Returns the same shape as GET /api/job/:id.
app.post('/api/poll/:id', async (c) => {
  const id = c.req.param('id')
  const job = await advancePipeline(id, c.env) // always skipStems=true
  if (!job) return c.json({ error: 'Job not found' }, 404)

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

  // ── Step 2: Build genre/mood-aware prompt ──
  const bp = job.blueprint as any
  const genre  = (bp?.genre  || 'music').toLowerCase()
  const mood   = (bp?.mood   || 'uplifting').toLowerCase()
  const energy = (bp?.energy || 'medium').toLowerCase()
  const title  = ((job as any).title || genre).toLowerCase()

  const darkKeywords   = ['dark','cold','menacing','aggressive','hard','gritty','sinister','evil','haunted','ominous','drill','noir','horror','gothic','trap','sad','melancholy','depressed']
  const brightKeywords = ['happy','uplifting','joyful','warm','sunny','vibrant','energetic','summer','beach','festival','party','dance','groovy','funky','positive','love','romantic','smooth','chill','peaceful']
  const genreDark  = ['drill','dark trap','hard trap','horror','gothic'].some(g => genre.includes(g))
  const moodDark   = darkKeywords.some(w => mood.includes(w) || title.includes(w))
  const moodBright = brightKeywords.some(w => mood.includes(w) || title.includes(w))
  const isDark = genreDark || (moodDark && !moodBright)

  const genreVisuals: Record<string,string> = {
    'pop':        'colorful confetti burst, bright pastel palette, glossy sheen, pop-art energy, vivid neon highlights',
    'r&b':        'warm golden hour light, silhouetted figure, rich amber and burgundy tones, soul and sensuality',
    'afrobeats':  'vivid orange and gold African sunset, bold tribal patterns, vibrant earth tones, joyful motion blur',
    'reggaeton':  'neon city night, Latin street art, hot pink and electric blue, urban energy, pulse and rhythm',
    'house':      'electric dance floor, strobing colored lights, abstract geometric shapes, euphoric rave energy',
    'gospel':     'radiant golden light rays, soaring heavenly clouds, warm divine glow, inspiring and uplifting',
    'soul':       'warm vintage bokeh, rich mahogany tones, candlelit intimacy, analog warmth',
    'jazz':       'smoky blue jazz club, vintage brass instruments silhouette, soft amber spotlights, sophisticated',
    'lo-fi':      'cozy late-night room, analog grain, warm lamp glow, rainy window, nostalgic and intimate',
    'boom bap':   'gritty urban street art, bold graffiti colors, raw concrete texture, street energy',
    'cinematic':  'epic widescreen landscape, dramatic sky, sweeping orchestral atmosphere, breathtaking scale',
    'trap':       'purple and cyan neon haze, urban rooftop at night, moody and electric, street luxury',
    'drill':      'cold grey concrete, dark blue tones, stark shadows, hard urban grit, stark and intense',
    'hip hop':    'dynamic bold colors, spray paint splatter, confident urban portrait, cultural richness',
    'reggae':     'lush tropical greens, warm sun rays through palm trees, peaceful island vibes',
  }

  let visualStyle = ''
  for (const [key, style] of Object.entries(genreVisuals)) {
    if (genre.includes(key)) { visualStyle = style; break }
  }

  let aestheticLine: string
  if (isDark) {
    aestheticLine = visualStyle
      ? `${visualStyle}. Deep shadows, dramatic contrast, moody atmosphere.`
      : `Dark moody atmosphere, dramatic shadows, cinematic lighting, deep rich tones, intense energy.`
  } else {
    aestheticLine = visualStyle
      ? `${visualStyle}. Bright, vivid, high contrast, visually striking.`
      : `Vibrant bold colors, bright dynamic lighting, energetic and visually striking, rich saturated palette.`
  }

  const energyLine = energy === 'high'
    ? 'High energy, explosive, dynamic composition.'
    : energy === 'low'
    ? 'Calm, intimate, soft and refined composition.'
    : 'Balanced composition, visually engaging.'

  const imagePrompt = `Professional album cover art for a ${genre} track titled "${(job as any).title || genre}". ` +
    `${aestheticLine} ${energyLine} ` +
    `No text, no words, no letters, no numbers. Abstract music visual, professional artwork, highly detailed, 4K quality.`

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
        quality: 'low',
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
//  GET /api/stem-audio/:jobId/:stem
//  Serves a single stem WAV extracted from the Mureka ZIP.
//  Uses HTTP Range requests to fetch only the needed file bytes
//  from the 100MB+ ZIP — the client never downloads the full ZIP.
//  Auth: session cookie required (same as stems page).
// ═══════════════════════════════════════════════════════════════
app.get('/api/stem-audio/:jobId/:stem', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId   = c.req.param('jobId')
  const stemKey = c.req.param('stem').toLowerCase()
  const job     = await getJob(c.env.DB, jobId)
  if (!job || !job.zip_url) return c.json({ error: 'Job or ZIP not found' }, 404)

  const zipUrl = job.zip_url

  try {
    // ── Step 1: Read the last 65KB of the ZIP to find the End-of-Central-Directory ──
    const headRes = await fetch(zipUrl, { method: 'HEAD' })
    if (!headRes.ok) throw new Error('ZIP HEAD failed: ' + headRes.status)
    const totalSize = parseInt(headRes.headers.get('content-length') || '0', 10)
    if (!totalSize) throw new Error('ZIP size unknown')

    // Fetch last 65KB (enough for central directory + EOCD record)
    const tailSize = Math.min(65536, totalSize)
    const tailStart = totalSize - tailSize
    const tailRes = await fetch(zipUrl, {
      headers: { 'Range': `bytes=${tailStart}-${totalSize - 1}` }
    })
    if (!tailRes.ok && tailRes.status !== 206) throw new Error('ZIP tail fetch failed: ' + tailRes.status)
    const tailBuf = await tailRes.arrayBuffer()
    const tailView = new DataView(tailBuf)

    // ── Step 2: Find EOCD signature (0x06054b50) ──
    let eocdOffset = -1
    for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
      if (tailView.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break }
    }
    if (eocdOffset < 0) throw new Error('EOCD not found in ZIP tail')

    const cdOffsetInFile = tailView.getUint32(eocdOffset + 16, true)
    const cdSize         = tailView.getUint32(eocdOffset + 12, true)

    // ── Step 3: Fetch the central directory ──
    let cdBuf: ArrayBuffer
    if (cdOffsetInFile >= tailStart) {
      // Central directory is already in our tail buffer
      const cdStart = cdOffsetInFile - tailStart
      cdBuf = tailBuf.slice(cdStart, cdStart + cdSize)
    } else {
      const cdRes = await fetch(zipUrl, {
        headers: { 'Range': `bytes=${cdOffsetInFile}-${cdOffsetInFile + cdSize - 1}` }
      })
      cdBuf = await cdRes.arrayBuffer()
    }

    // ── Step 4: Parse central directory to find the requested stem ──
    const cdView = new DataView(cdBuf)
    let pos = 0
    let foundLocalOffset = -1
    let foundCompressed  = -1
    let foundUncompressed = -1
    let foundCompMethod  = -1
    let foundFilename    = ''

    const stemKeywords: Record<string, string[]> = {
      drums:    ['drum'],
      bass:     ['bass'],
      vocals:   ['vocal'],
      other:    ['other', 'melody', 'synth'],
      piano:    ['piano'],
      guitar:   ['guitar'],
      strings:  ['string'],
      synth:    ['synth'],
      brass:    ['brass'],
      woodwind: ['woodwind', 'wind'],
      fx:       ['fx'],
    }
    const keywords = stemKeywords[stemKey] || [stemKey]

    const audioEntries: Array<{filename: string, localOffset: number, compressed: number, uncompressed: number, compMethod: number}> = []

    while (pos < cdBuf.byteLength - 4) {
      if (cdView.getUint32(pos, true) !== 0x02014b50) break
      const compMethod  = cdView.getUint16(pos + 10, true)
      const compressed  = cdView.getUint32(pos + 20, true)
      const uncompressed = cdView.getUint32(pos + 24, true)
      const fnLen       = cdView.getUint16(pos + 28, true)
      const extLen      = cdView.getUint16(pos + 30, true)
      const cmtLen      = cdView.getUint16(pos + 32, true)
      const localOffset = cdView.getUint32(pos + 42, true)
      const fnBytes     = new Uint8Array(cdBuf, pos + 46, fnLen)
      const fn          = new TextDecoder().decode(fnBytes)
      const fnLower     = fn.toLowerCase()

      if (fnLower.endsWith('.wav') || fnLower.endsWith('.mp3')) {
        audioEntries.push({ filename: fn, localOffset, compressed, uncompressed, compMethod })
        // Check if this file matches our stem keyword
        if (keywords.some(kw => fnLower.includes(kw))) {
          foundLocalOffset  = localOffset
          foundCompressed   = compressed
          foundUncompressed = uncompressed
          foundCompMethod   = compMethod
          foundFilename     = fn
        }
      }

      pos += 46 + fnLen + extLen + cmtLen
    }

    // If no keyword match, fall back by stem index position
    if (foundLocalOffset < 0 && audioEntries.length > 0) {
      const stemOrder = ['drums','bass','vocals','other','piano','guitar','strings','synth','brass','woodwind','fx']
      const idx = stemOrder.indexOf(stemKey)
      const entry = audioEntries[idx >= 0 && idx < audioEntries.length ? idx : 0]
      foundLocalOffset  = entry.localOffset
      foundCompressed   = entry.compressed
      foundUncompressed = entry.uncompressed
      foundCompMethod   = entry.compMethod
      foundFilename     = entry.filename
    }

    if (foundLocalOffset < 0) return c.json({ error: 'Stem not found in ZIP' }, 404)

    // ── Step 5: Read the local file header to get actual data offset ──
    const lhRes = await fetch(zipUrl, {
      headers: { 'Range': `bytes=${foundLocalOffset}-${foundLocalOffset + 29}` }
    })
    const lhBuf  = await lhRes.arrayBuffer()
    const lhView = new DataView(lhBuf)
    const lhFnLen  = lhView.getUint16(26, true)
    const lhExtLen = lhView.getUint16(28, true)
    const dataOffset = foundLocalOffset + 30 + lhFnLen + lhExtLen

    // ── Step 6: Fetch just the compressed data bytes ──
    const dataRes = await fetch(zipUrl, {
      headers: { 'Range': `bytes=${dataOffset}-${dataOffset + foundCompressed - 1}` }
    })
    const compData = await dataRes.arrayBuffer()

    // ── Step 7: Decompress if needed (method 8 = deflate, 0 = stored) ──
    let audioData: ArrayBuffer
    if (foundCompMethod === 0) {
      // Stored (no compression) — use as-is
      audioData = compData
    } else if (foundCompMethod === 8) {
      // Deflate — decompress using DecompressionStream
      const ds = new DecompressionStream('deflate-raw')
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()
      writer.write(new Uint8Array(compData))
      writer.close()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total = chunks.reduce((s, c) => s + c.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
      audioData = out.buffer
    } else {
      throw new Error(`Unsupported ZIP compression method: ${foundCompMethod}`)
    }

    const ext = foundFilename.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
    return new Response(audioData, {
      headers: {
        'Content-Type': ext,
        'Content-Length': String(audioData.byteLength),
        'Content-Disposition': `inline; filename="${foundFilename}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Stem extract failed' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/stems — on-demand stem extraction
//  Creator: V1 (5 stems, 2 credits) — Pro: V2 (up to 12 stems + MIDI, 10 credits)
//  Free plan: not allowed
// ═══════════════════════════════════════════════════════════════

// Blueprint-aware stem label helpers — give each stem its real instrument name
function getBassLabel(instruments: string[]): string {
  if (instruments.some(n => n.includes('808'))) return '808 Bass'
  if (instruments.some(n => n.includes('sub'))) return 'Sub Bass'
  if (instruments.some(n => n.includes('electric bass'))) return 'Electric Bass'
  return 'Bass'
}
function getOtherLabel(instruments: string[]): string {
  if (instruments.some(n => n.includes('rhodes'))) return 'Rhodes / Melody'
  if (instruments.some(n => n.includes('flute'))) return 'Flute / Melody'
  if (instruments.some(n => n.includes('lead'))) return 'Lead Melody'
  if (instruments.some(n => n.includes('melody'))) return 'Melody'
  return 'Other (Melody)'
}
function getPianoLabel(instruments: string[]): string {
  if (instruments.some(n => n.includes('rhodes'))) return 'Rhodes'
  if (instruments.some(n => n.includes('electric piano'))) return 'Electric Piano'
  if (instruments.some(n => n.includes('keys'))) return 'Keys'
  return 'Piano'
}
function getGuitarLabel(instruments: string[]): string {
  if (instruments.some(n => n.includes('acoustic'))) return 'Acoustic Guitar'
  if (instruments.some(n => n.includes('electric'))) return 'Electric Guitar'
  return 'Guitar'
}
function getSynthLabel(instruments: string[]): string {
  if (instruments.some(n => n.includes('pad'))) return 'Synth Pad'
  if (instruments.some(n => n.includes('lead'))) return 'Synth Lead'
  if (instruments.some(n => n.includes('arp'))) return 'Synth Arp'
  return 'Synth'
}

app.post('/api/job/stems', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)

  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Must be logged in', redirect: '/login' }, 401)

  if (user.plan === 'free') {
    return c.json({ error: 'Stem extraction requires a Creator or Pro Artist plan.', upgrade: true }, 403)
  }

  const { job_id } = await c.req.json()
  if (!job_id) return c.json({ error: 'job_id required' }, 400)

  // Fetch job AND its owner user_id from the DB row (user_id is NOT in JSON blob)
  let job: Job | null = null
  let jobOwnerId: string | null = null
  try {
    const row = await c.env.DB.prepare('SELECT data, user_id FROM jobs WHERE id = ?').bind(job_id).first<{data:string,user_id:string|null}>()
    if (row) { job = JSON.parse(row.data) as Job; jobOwnerId = row.user_id }
  } catch { /* fall through */ }
  if (!job) return c.json({ error: 'Job not found' }, 404)
  // Allow if owner matches — but also allow if jobOwnerId is null (legacy unowned jobs)
  if (jobOwnerId && jobOwnerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (job.status !== 'ready') return c.json({ error: 'Beat is not ready yet' }, 400)
  if (!job.stereo_url) return c.json({ error: 'No stereo audio available' }, 400)

  // Already has stems — return existing zip
  if (job.zip_url) {
    return c.json({ ok: true, zip_url: job.zip_url, tracks: job.tracks, already_extracted: true })
  }

  // Credit cost: Creator=2 (V1, 5 stems) — Pro=10 (V2, up to 12 stems + MIDI)
  const creditCost = user.plan === 'pro' ? 10 : 2
  if (user.gens_used + creditCost > user.gens_limit) {
    return c.json({
      error: `Not enough downloads. This costs ${creditCost} credits and you only have ${user.gens_limit - user.gens_used} remaining.`,
      limit_reached: true
    }, 403)
  }

  // Deduct credits immediately to prevent double-spend
  await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + ? WHERE id = ?`)
    .bind(creditCost, user.id).run()

  try {
    // Creator: V1 (5 fixed stems, ~$0.06) — Pro: V2 (up to 12 stems + MIDI, ~$0.70)
    const isPro = user.plan === 'pro'
    const model = isPro ? 'audio-separation-2' : 'audio-separation-1'
    const { zip_url, midi_zip_url } = await extractStems(job.stereo_url, c.env.MUREKA_API_KEY, model)

    // Blueprint instruments — use to smartly label stems from the beat's own instrument list
    const bp = job.blueprint as any
    const bpInstruments: string[] = bp?.instruments?.map((i: any) => (i.name || '').toLowerCase()) || []

    // Drums always labeled 'Drums' — Mureka returns one mixed drum track regardless of sub-components
    function getDrumLabel(): string { return 'Drums' }

    // V1 (Creator): 5 fixed stems — smartly labeled from blueprint
    const v1CandidateList = [
      { stem: 'drums',  name: getDrumLabel(),              family: 'drums',  color: '#ef4444' },
      { stem: 'bass',   name: getBassLabel(bpInstruments), family: 'bass',   color: '#3b82f6' },
      { stem: 'vocals', name: 'Vocals',                    family: 'vocals', color: '#ec4899' },
      { stem: 'other',  name: getOtherLabel(bpInstruments), family: 'synth', color: '#8b5cf6' },
    ]
    // V2 (Pro): up to 12 stems — smartly labeled from blueprint
    const v2CandidateList = [
      { stem: 'drums',    name: getDrumLabel(),              family: 'drums',   color: '#ef4444' },
      { stem: 'bass',     name: getBassLabel(bpInstruments), family: 'bass',    color: '#3b82f6' },
      { stem: 'vocals',   name: 'Vocals',                    family: 'vocals',  color: '#ec4899' },
      { stem: 'other',    name: getOtherLabel(bpInstruments), family: 'synth',  color: '#8b5cf6' },
      { stem: 'piano',    name: getPianoLabel(bpInstruments), family: 'keys',   color: '#f59e0b' },
      { stem: 'guitar',   name: getGuitarLabel(bpInstruments), family: 'guitar', color: '#84cc16' },
      { stem: 'strings',  name: 'Strings',                   family: 'strings', color: '#06b6d4' },
      { stem: 'synth',    name: getSynthLabel(bpInstruments), family: 'synth',  color: '#a78bfa' },
      { stem: 'brass',    name: 'Brass',                     family: 'brass',   color: '#fb923c' },
      { stem: 'woodwind', name: 'Woodwind',                  family: 'wind',    color: '#34d399' },
      { stem: 'fx',       name: 'FX / Effects',              family: 'fx',      color: '#f87171' },
    ]
    const candidateList = isPro ? v2CandidateList : v1CandidateList

    // Probe the ZIP to discover which stems are actually present
    // (skips undetected instruments — no silent/empty stems)
    let detectedStems: typeof candidateList = candidateList
    try {
      const zipResp = await fetch(zip_url)
      const zipBuf  = await zipResp.arrayBuffer()
      // Simple ZIP central directory scan: collect all filenames
      const view = new DataView(zipBuf)
      const zipFiles: string[] = []
      // End of central directory signature: 0x06054b50
      for (let i = zipBuf.byteLength - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
          const cdOffset = view.getUint32(i + 16, true)
          const cdSize   = view.getUint32(i + 12, true)
          let pos = cdOffset
          while (pos < cdOffset + cdSize) {
            if (view.getUint32(pos, true) !== 0x02014b50) break
            const fnLen  = view.getUint16(pos + 28, true)
            const extLen = view.getUint16(pos + 30, true)
            const cmtLen = view.getUint16(pos + 32, true)
            const fnBytes = new Uint8Array(zipBuf, pos + 46, fnLen)
            const fn = new TextDecoder().decode(fnBytes).toLowerCase()
            zipFiles.push(fn)
            pos += 46 + fnLen + extLen + cmtLen
          }
          break
        }
      }
      if (zipFiles.length > 0) {
        // Keep only stems whose filename appears in the ZIP
        detectedStems = candidateList.filter(s =>
          zipFiles.some(f => f.includes(s.stem.toLowerCase()) && (f.endsWith('.wav') || f.endsWith('.mp3')))
        )
        // Fallback: if filter left nothing, keep all candidates
        if (detectedStems.length === 0) detectedStems = candidateList
      }
    } catch { /* zip probe failed — use full candidate list */ }

    const tracks = detectedStems.map(s => ({
      name: s.name,
      stem: s.stem,
      family: s.family,
      status: 'ready' as const,
      zip_url,
      color: s.color
    }))

    // Save stems back to job — include instrumental_url separately for toggle
    const updatedJob = { ...job, zip_url, tracks } as any
    if (midi_zip_url) updatedJob.midi_zip_url = midi_zip_url
    await setJob(c.env.DB, updatedJob)

    return c.json({
      ok: true,
      zip_url,
      midi_zip_url: midi_zip_url || null,
      tracks,
      credits_used: creditCost,
      plan: user.plan
    })

  } catch (err: any) {
    // Refund credits on failure
    await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used - ? WHERE id = ?`)
      .bind(creditCost, user.id).run()
    return c.json({ error: err?.message || 'Stem extraction failed' }, 500)
  }
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
    const { name, email, password, plan } = await c.req.json()
    if (!name || !email || !password) return c.json({ error: 'name, email and password required' }, 400)
    if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)

    await ensureAuthTables(c.env.DB)
    const existing = await getUserByEmail(c.env.DB, email.toLowerCase())
    if (existing) return c.json({ error: 'An account with that email already exists' }, 409)

    const passwordHash = await hashPassword(password)
    const userId = generateId()
    await createUser(c.env.DB, {
      id: userId, email: email.toLowerCase(), name: name.trim(),
      password_hash: passwordHash, plan: plan || 'free'
    })

    const token = await createSession(c.env.DB, userId)
    const siteUrl = c.env.SITE_URL || ''

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

// GET /api/auth/me — return current user (used by frontend to check session)
app.get('/api/auth/me', async (c) => {
  const token = getSessionCookie(c.req.raw)
  if (!token || !c.env.DB) return c.json({ user: null })
  const user = await getSessionUser(c.env.DB, token)
  if (!user) return c.json({ user: null })
  return c.json({
    user: {
      id: user.id, name: user.name, email: user.email,
      avatar: user.avatar, plan: user.plan,
      gens_used: user.gens_used, gens_limit: user.gens_limit
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
  // Encode optional next URL into state so callback can redirect there
  const next = c.req.query('next') || ''
  const randomPart = generateToken().slice(0, 16)
  const state = next ? randomPart + '|' + next : randomPart
  const url = googleAuthUrl(c.env.GOOGLE_CLIENT_ID, c.env.SITE_URL, state)
  return c.redirect(url)
})

// GET /api/auth/google/callback — Google OAuth callback
app.get('/api/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  const error = c.req.query('error')
  // Extract next URL from state if present (format: randomPart|/next/path)
  const rawState = c.req.query('state') || ''
  const pipeIdx = rawState.indexOf('|')
  const nextFromState = pipeIdx !== -1 ? rawState.slice(pipeIdx + 1) : ''
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
    if (!user) {
      const userId = generateId()
      await createUser(c.env.DB, {
        id: userId, email: profile.email.toLowerCase(),
        name: profile.name, avatar: profile.picture, google_id: profile.sub
      })
      user = await getUserByEmail(c.env.DB, profile.email.toLowerCase())
    } else if (!user.google_id) {
      await c.env.DB.prepare('UPDATE users SET google_id=?, avatar=? WHERE id=?')
        .bind(profile.sub, profile.picture, user.id).run()
    }

    const token = await createSession(c.env.DB, user.id)
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

      if (userId && subId) {
        // Get subscription details to find price ID
        const sub = await stripeRequest('GET', `/subscriptions/${subId}`, {}, c.env.STRIPE_SECRET_KEY)
        const priceId = sub.items?.data?.[0]?.price?.id
        const plan = planFromPriceId(c.env, priceId)
        await updateUserPlan(c.env.DB, userId, plan, customerId, subId)
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
          `UPDATE users SET plan='free', gens_limit=3, stripe_subscription_id=NULL WHERE stripe_customer_id=?`
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

app.get('/', (c) => c.html(homePage()))
app.get('/pricing', (c) => c.html(pricingPage()))
app.get('/generator', async (c) => {
  // Require authentication — guests must sign up first
  if (c.env.DB && c.env.SESSION_SECRET) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) return c.redirect('/signup?next=/generator')
  }
  return c.html(generatorPage())
})
app.get('/dashboard', async (c) => {
  if (c.env.DB && c.env.SESSION_SECRET) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) return c.redirect('/signup?next=/dashboard')
  }
  return c.html(dashboardPage())
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

// ── Stems player page ─────────────────────────────────────────
app.get('/stems/:id', async (c) => {
  const id = c.req.param('id')
  // Auth check
  if (c.env.DB && c.env.SESSION_SECRET) {
    const token = getSessionCookie(c.req.raw)
    const user = token ? await getSessionUser(c.env.DB, token) : null
    if (!user) return c.redirect('/login?next=/stems/' + id)
  }
  return c.html(stemsPage(id))
})

app.get('/profile', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.html(profilePage(null))
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  return c.html(profilePage(user))
})

app.get('/subscription', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) {
    return c.redirect('/login')
  }
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  return c.html(subscriptionPage(user, c.env))
})

app.get('/account', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
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

// GET /api/projects — return logged-in user's completed jobs
app.get('/api/projects', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ projects: [] })
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  try {
    await ensureTable(c.env.DB)
    const rows = await c.env.DB.prepare(
      `SELECT id, data, created_at FROM jobs WHERE user_id = ? AND json_extract(data,'$.status') = 'ready' ORDER BY created_at DESC LIMIT 50`
    ).bind(user.id).all<{ id: string; data: string; created_at: number }>()
    const projects = (rows.results || []).map(r => {
      const d = JSON.parse(r.data) as Job
      return {
        id: d.id,
        prompt: d.prompt,
        title: (d as any).title || null,
        thumbnail_seed: d.thumbnail_seed || (d.id.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0) % 360),
        // Only return a cached permanent URL — never return pollinations/data: URLs.
        // The client calls /api/cover-image/:id which generates once, saves to R2+D1.
        image_url: (() => { const u = (d as any).image_url; return (u && u.includes('/api/cover-art/')) ? u : null })(),
        created_at: d.created_at,
        stereo_url: d.stereo_url || null,
        zip_url: d.zip_url || null,
        blueprint: d.blueprint ? {
          bpm: d.blueprint.bpm,
          key: d.blueprint.key,
          scale: d.blueprint.scale,
          genre: d.blueprint.genre,
          mood: d.blueprint.mood,
          duration_seconds: d.blueprint.duration_seconds,
          arrangement: (d.blueprint as any).arrangement || null
        } : null
      }
    })
    return c.json({ projects })
  } catch (e: any) {
    return c.json({ projects: [], error: e?.message })
  }
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
      return c.json({ ok: true, message: `Your plan will change to Creator at the next billing cycle.` })
    }
  } catch (e: any) {
    return c.json({ error: e?.message || 'Downgrade failed' }, 500)
  }
})

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
${globalSidebar()}
<div class="gs-page-wrap">
${body}
</div>
<script src="/static/app.js"></script>
</body>
</html>`
}

// ─── GLOBAL LEFT SIDEBAR — shown on every page ─────────────────────────────
function globalSidebar() {
  return `<aside class="gs-sidebar" id="gs-sidebar">
  <!-- Logo -->
  <a href="/" class="gs-sidebar__logo">
    <span class="gs-sidebar__logo-icon"><i class="fas fa-wave-square"></i></span>
    <span class="gs-sidebar__logo-text">Stem<span class="accent">Forge</span></span>
  </a>

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
    <a href="/" class="gs-sidebar__nav-item" data-page="home">
      <i class="fas fa-home"></i>
      <span>Home</span>
    </a>
    <a href="/generator" class="gs-sidebar__nav-item" data-page="generator">
      <i class="fas fa-music"></i>
      <span>Create</span>
    </a>
    <a href="/dashboard" class="gs-sidebar__nav-item" data-page="dashboard">
      <i class="fas fa-th-large"></i>
      <span>Library</span>
    </a>
  </nav>

  <!-- Spacer -->
  <div class="gs-sidebar__spacer"></div>

  <!-- Generation credits (shown when logged in) -->
  <div class="gs-sidebar__credits" id="gs-credits-block" style="display:none">
    <div class="gs-credits__label" id="gs-credits-label">Downloads</div>
    <div class="gs-credits__val" id="gs-gens-val">0 <small>/ 3</small></div>
    <div class="gs-credits__bar"><div id="gs-gens-bar" style="width:0%"></div></div>
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
          <input type="text" id="edit-genre" placeholder="e.g. hip hop, trap..." style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;width:100%;box-sizing:border-box;color:var(--text);font-family:inherit;font-size:.9rem"/>
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="edit-description" class="suno-textarea" rows="2" placeholder="Notes about this beat..."></textarea>
      </div>
      <div class="song-edit-modal__info" id="edit-info-block" style="display:none">
        <div class="song-edit-modal__info-row"><span>Key</span><strong id="edit-info-key">—</strong></div>
        <div class="song-edit-modal__info-row"><span>Scale</span><strong id="edit-info-scale">—</strong></div>
        <div class="song-edit-modal__info-row"><span>Mood</span><strong id="edit-info-mood">—</strong></div>
        <div class="song-edit-modal__info-row"><span>Duration</span><strong id="edit-info-duration">—</strong></div>
      </div>

      <!-- Get Stems section — shown for creator/pro plans only -->
      <div id="edit-stems-section" style="display:none;margin-top:12px;padding:14px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:700;font-size:.92rem"><i class="fas fa-layer-group" style="color:var(--primary);margin-right:6px"></i>Get Stems</div>
            <div id="edit-stems-desc" style="font-size:.78rem;color:var(--muted);margin-top:2px"></div>
          </div>
          <button class="btn btn--primary btn--sm" id="edit-get-stems-btn" onclick="requestStems()">
            <i class="fas fa-layer-group"></i> Extract
          </button>
        </div>
        <div id="edit-stems-status" style="display:none;font-size:.82rem;margin-top:10px;padding:8px 12px;border-radius:8px"></div>
        <div id="edit-stems-result" style="display:none;margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <a id="edit-stems-zip-link" href="#" download style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:var(--primary);color:#fff;border-radius:8px;font-size:.85rem;font-weight:600;text-decoration:none">
            <i class="fas fa-file-archive"></i> Download ZIP
          </a>
          <a id="edit-stems-midi-link" href="#" download style="display:none;align-items:center;gap:6px;padding:8px 14px;background:var(--surface-3,#2a2a3a);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:.85rem;font-weight:600;text-decoration:none">
            <i class="fas fa-music"></i> MIDI ZIP
          </a>
        </div>
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
      <span><i class="fas fa-layer-group"></i> Multitrack Engine</span>
      <span><i class="fas fa-bolt"></i> Edge Deployed</span>
      <span><i class="fas fa-shield-alt"></i> Commercial Use</span>
      <span><i class="fas fa-music"></i> Studio-Quality Output</span>
      <span><i class="fas fa-infinity"></i> Always Improving</span>
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
        <p>AI builds a shared blueprint first — BPM, key, structure, arrangement — so all tracks lock together perfectly.</p>
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
          <li><i class="fas fa-check"></i> Stereo preview & playback</li>
          <li class="muted"><i class="fas fa-times"></i> Downloads</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full">Get started free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$19</span><span>/month</span></div>
        <p class="plan-card__desc">For Artists, writers, and content creators.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 50 generations/month</li>
          <li><i class="fas fa-check"></i> Full stereo beats</li>
          <li><i class="fas fa-check"></i> Stem ZIP export</li>
          <li><i class="fas fa-check"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
        </ul>
        <a href="/checkout?plan=creator" class="btn btn--primary btn--full">Start Creator</a>
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
        <a href="/checkout?plan=pro" class="btn btn--outline btn--full">Start Pro Artist</a>
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
      <a href="/generator" class="btn btn--primary btn--lg">Try the generator free <i class="fas fa-arrow-right"></i></a>
    </div>
  </div>
</section>
</main>`)
}

// ─── STEMS PLAYER PAGE ───────────────────────────────────────────────────────
function stemsPage(jobId: string) {
  return shell('Stems Player', `
<div class="gs-content stems-page" id="stems-page" data-job-id="${jobId}">

  <!-- Back nav -->
  <div class="stems-topbar">
    <button onclick="history.back()" class="stems-back-btn"><i class="fas fa-arrow-left"></i> Back</button>
    <div class="stems-topbar__title" id="stems-track-title">Loading stems...</div>
    <div class="stems-topbar__actions">
      <button class="btn btn--outline btn--sm" id="stems-download-zip-btn" style="display:none">
        <i class="fas fa-file-archive"></i> Download ZIP
      </button>
    </div>
  </div>

  <!-- Cover + info -->
  <div class="stems-hero" id="stems-hero">
    <div class="stems-hero__art" id="stems-hero-art"></div>
    <div class="stems-hero__info">
      <div class="stems-hero__title" id="stems-hero-title">—</div>
      <div class="stems-hero__meta" id="stems-hero-meta">—</div>
      <div class="stems-hero__badge" id="stems-plan-badge"></div>
    </div>
  </div>

  <!-- Loading / error states -->
  <div id="stems-loading" style="text-align:center;padding:60px 20px;color:var(--muted)">
    <i class="fas fa-spinner fa-spin" style="font-size:2rem;margin-bottom:16px;display:block"></i>
    <p>Loading stems...</p>
  </div>
  <div id="stems-no-stems" style="display:none;text-align:center;padding:60px 20px">
    <i class="fas fa-layer-group" style="font-size:3rem;color:var(--primary);margin-bottom:16px;display:block;opacity:.5"></i>
    <h3 style="margin-bottom:10px">Stems not yet extracted</h3>
    <p style="color:var(--muted);margin-bottom:8px" id="stems-no-stems-desc">Extract individual stems from your beat — preview and download each track separately.</p>
    <p id="stems-cost-label" style="color:var(--muted);font-size:.88rem;margin-bottom:24px"></p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn--primary" id="stems-extract-btn" onclick="stemsExtract()">
        <i class="fas fa-layer-group"></i> <span id="stems-extract-btn-label">Extract Stems</span>
      </button>
      <button class="btn btn--outline" onclick="history.back()">
        <i class="fas fa-times"></i> Cancel
      </button>
    </div>
    <div id="stems-extract-status" style="margin-top:16px;font-size:.88rem;display:none"></div>
  </div>
  <div id="stems-error" style="display:none;text-align:center;padding:60px 20px">
    <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:var(--danger);margin-bottom:16px;display:block"></i>
    <p id="stems-error-msg">Could not load stems.</p>
    <button class="btn btn--outline" style="margin-top:16px" onclick="stemsInit()">Retry</button>
  </div>

  <!-- Vocals / Instrumental toggle strip (shown with player) -->
  <div id="stems-vi-toggle" style="display:none" class="stems-vi-strip">
    <button class="stems-vi-btn stems-vi-btn--active" id="vi-vocals-btn" onclick="setVIMode('vocals')">
      <i class="fas fa-microphone"></i> Vocals
    </button>
    <button class="stems-vi-btn" id="vi-instrumental-btn" onclick="setVIMode('instrumental')">
      <i class="fas fa-drum"></i> Instrumental
    </button>
  </div>

  <!-- Master transport -->
  <div id="stems-transport" style="display:none" class="stems-transport">
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <button class="stems-play-all-btn" id="stems-play-all" onclick="stemsTogglePlayAll()">
        <i class="fas fa-play" id="stems-play-icon"></i>
      </button>
      <div style="flex:1;min-width:160px">
        <input type="range" id="stems-seek" min="0" max="100" value="0" step="0.1"
          style="width:100%;accent-color:var(--primary);cursor:pointer"/>
      </div>
      <div style="font-size:.82rem;color:var(--muted);font-variant-numeric:tabular-nums;min-width:80px;text-align:right">
        <span id="stems-time-cur">0:00</span> / <span id="stems-time-dur">0:00</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <i class="fas fa-volume-up" style="font-size:.8rem;color:var(--muted)"></i>
        <input type="range" id="stems-master-vol" min="0" max="100" value="80"
          style="width:80px;accent-color:var(--primary);cursor:pointer"/>
      </div>
    </div>
  </div>

  <!-- Stem tracks -->
  <div id="stems-list" style="display:none" class="stems-list"></div>

  <!-- Extract flow for free users nudge -->
  <div id="stems-upgrade-nudge" style="display:none;text-align:center;padding:24px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:14px;margin-top:20px">
    <p style="margin-bottom:12px"><i class="fas fa-lock" style="color:var(--primary)"></i> <strong>Stems require a Creator or Pro plan</strong></p>
    <a href="/pricing" class="btn btn--primary btn--sm">View Plans</a>
  </div>


</div>

<script>
// ═══════════════════════════════════════════════════════════════
//  STEMS PLAYER — Web Audio API, real waveform, VI toggle
// ═══════════════════════════════════════════════════════════════

const STEMS_JOB_ID = '${jobId}';

// ── State ─────────────────────────────────────────────────────
let stemsJob       = null;
let stemAudios     = {};   // { stem: HTMLAudioElement }
let stemMuted      = {};   // { stem: bool }
let stemSolo       = {};   // { stem: bool }
let stemGains      = {};   // { stem: float }
let hasSoloActive  = false;
let isPlaying      = false;
let masterVolume   = 0.8;
let stemZipCache   = null; // ArrayBuffer
let audioCtx       = null;
let stemAnalysers  = {};   // { stem: AnalyserNode }
let stemSources    = {};   // { stem: MediaElementSourceNode }
let waveRAF        = {};   // { stem: rAF id }
let viMode         = 'vocals'; // 'vocals' | 'instrumental'
let _planForConfirm = 'creator';

// ── JSZip loader ─────────────────────────────────────────────
function loadJSZip() {
  return new Promise(resolve => {
    if (window.JSZip) { resolve(window.JSZip); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    document.head.appendChild(s);
  });
}

// ── AudioContext ──────────────────────────────────────────────
function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed')
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ── Time formatter ────────────────────────────────────────────
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
}

// ── UI state switcher ─────────────────────────────────────────
function showState(state) {
  document.getElementById('stems-loading').style.display   = state==='loading'  ? 'block' : 'none';
  document.getElementById('stems-no-stems').style.display  = state==='no-stems' ? 'block' : 'none';
  document.getElementById('stems-error').style.display     = state==='error'    ? 'block' : 'none';
  document.getElementById('stems-transport').style.display = state==='player'   ? 'flex'  : 'none';
  document.getElementById('stems-list').style.display      = state==='player'   ? 'block' : 'none';
  document.getElementById('stems-upgrade-nudge').style.display = state==='upgrade' ? 'block' : 'none';
  const viStrip = document.getElementById('stems-vi-toggle');
  if (viStrip) viStrip.style.display = state==='player' ? 'flex' : 'none';
}

// ── Vocals / Instrumental toggle ──────────────────────────────
function setVIMode(mode) {
  viMode = mode;
  document.getElementById('vi-vocals-btn').classList.toggle('stems-vi-btn--active', mode==='vocals');
  document.getElementById('vi-instrumental-btn').classList.toggle('stems-vi-btn--active', mode==='instrumental');
  applyVolumes();
}

// ── Init ──────────────────────────────────────────────────────
async function stemsInit() {
  showState('loading');
  try {
    const res = await fetch('/api/job/' + STEMS_JOB_ID);
    const job = await res.json();
    if (!res.ok || job.error) throw new Error(job.error || 'Job not found');
    stemsJob = job;
    populateHero(job);

    // Check sessionStorage cache first — if stems were already extracted this session,
    // skip the credit prompt entirely and go straight to the player
    const cacheKey = 'stems_extracted_' + STEMS_JOB_ID;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached && !job.zip_url) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.zip_url && parsed.tracks && parsed.tracks.length > 0) {
          stemsJob.zip_url = parsed.zip_url;
          stemsJob.tracks  = parsed.tracks;
          if (parsed.midi_zip_url) stemsJob.midi_zip_url = parsed.midi_zip_url;
          job.zip_url = parsed.zip_url;
          job.tracks  = parsed.tracks;
        }
      } catch(e) { sessionStorage.removeItem(cacheKey); }
    }

    if (!job.zip_url) {
      const meRes  = await fetch('/api/auth/me');
      const meData = await meRes.json();
      const user   = meData.user;
      if (!user || user.plan === 'free') { showState('upgrade'); return; }
      _planForConfirm = user.plan || 'creator';
      showState('no-stems');
      const isPro = user.plan === 'pro';
      const costLabel = document.getElementById('stems-cost-label');
      const btnLabel  = document.getElementById('stems-extract-btn-label');
      const descLabel = document.getElementById('stems-no-stems-desc');
      if (descLabel) descLabel.textContent = isPro
        ? 'Extract up to 12 individual stems — Drums, Bass, Melody, Synth, Guitar, Strings, and more — plus MIDI export.'
        : 'Extract 5 individual stems — Drums, Bass, Melody, Vocals, and Other — from your beat to preview and download each track separately.';
      if (costLabel) costLabel.textContent = isPro
        ? 'Costs 10 download credits — extracts up to 12 stems + MIDI'
        : 'Costs 2 download credits — extracts 5 stems (Drums, Bass, Melody, Vocals, Other)';
      if (btnLabel) btnLabel.textContent = isPro
        ? 'Extract Stems — 10 Credits'
        : 'Extract Stems — 2 Credits';
      return;
    }

    // Save to sessionStorage so back-navigation skips the prompt
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({
        zip_url: job.zip_url,
        tracks:  job.tracks  || [],
        midi_zip_url: job.midi_zip_url || null
      }));
    } catch(e) { /* storage full — ignore */ }

    await buildStemsPlayer(job);
  } catch(e) {
    document.getElementById('stems-error-msg').textContent = e.message || 'Could not load stems.';
    showState('error');
  }
}

// ── Hero banner ───────────────────────────────────────────────
function populateHero(job) {
  const title = job.title || (job.blueprint ? job.blueprint.genre + ' — ' + job.blueprint.key : 'Beat');
  const meta  = job.blueprint ? (job.blueprint.bpm + ' BPM · ' + job.blueprint.key + ' ' + job.blueprint.scale + ' · ' + job.blueprint.genre) : '';
  document.getElementById('stems-track-title').textContent = title;
  document.getElementById('stems-hero-title').textContent  = title;
  document.getElementById('stems-hero-meta').textContent   = meta;

  const artEl = document.getElementById('stems-hero-art');
  const hue = job.thumbnail_seed || 180;
  const h2  = (hue + 55) % 360, h3 = (hue + 120) % 360;
  const grad = 'linear-gradient(135deg,hsl('+hue+',65%,28%) 0%,hsl('+h2+',75%,20%) 55%,hsl('+h3+',60%,15%) 100%)';
  artEl.style.cssText = 'background:'+grad+';background-size:cover;background-position:center;';

  // Generate Canvas album art for hero (no external service needed)
  try {
    const genre = (job.blueprint && job.blueprint.genre) || 'music';
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0,0,400,400);
    g.addColorStop(0,'hsl('+hue+',60%,18%)');
    g.addColorStop(0.5,'hsl('+((hue+40)%360)+',70%,12%)');
    g.addColorStop(1,'hsl('+((hue+80)%360)+',55%,8%)');
    ctx.fillStyle=g; ctx.fillRect(0,0,400,400);
    const r1=ctx.createRadialGradient(320,80,10,320,80,180);
    r1.addColorStop(0,'hsla('+((hue+120)%360)+',80%,60%,0.3)');
    r1.addColorStop(1,'transparent');
    ctx.fillStyle=r1; ctx.fillRect(0,0,400,400);
    const r2=ctx.createRadialGradient(80,320,5,80,320,150);
    r2.addColorStop(0,'hsla('+((hue+240)%360)+',70%,55%,0.2)');
    r2.addColorStop(1,'transparent');
    ctx.fillStyle=r2; ctx.fillRect(0,0,400,400);
    ctx.font='bold 16px system-ui,sans-serif';
    ctx.fillStyle='hsla('+hue+',60%,85%,0.65)';
    ctx.textAlign='center';
    ctx.fillText(genre.toUpperCase(),200,44);
    const barCount=24; const barW=8; const gap=5;
    const totalW=barCount*(barW+gap)-gap;
    const startX=(400-totalW)/2;
    for(let b=0;b<barCount;b++){
      const seed=(hue*13+b*97)%360;
      const bh=28+(Math.sin(seed*0.13)*0.5+0.5)*70;
      const x=startX+b*(barW+gap); const y=190-bh/2;
      const bg=ctx.createLinearGradient(0,y,0,y+bh);
      bg.addColorStop(0,'hsla('+((hue+40)%360)+',80%,75%,0.85)');
      bg.addColorStop(1,'hsla('+hue+',60%,50%,0.3)');
      ctx.fillStyle=bg;
      ctx.beginPath();
      if(ctx.roundRect) ctx.roundRect(x,y,barW,bh,2); else ctx.rect(x,y,barW,bh);
      ctx.fill();
    }
    const words=title.split(' ');
    const l1=words.slice(0,Math.ceil(words.length/2)).join(' ');
    const l2=words.slice(Math.ceil(words.length/2)).join(' ');
    ctx.font='bold 24px system-ui,sans-serif';
    ctx.fillStyle='#fff';
    ctx.shadowColor='rgba(0,0,0,0.9)'; ctx.shadowBlur=8;
    if(l2){ctx.fillText(l1.slice(0,22),200,300);ctx.fillText(l2.slice(0,22),200,330);}
    else{ctx.fillText(l1.slice(0,24),200,316);}
    ctx.shadowBlur=0;
    const dataUrl=canvas.toDataURL('image/png');
    artEl.style.backgroundImage="url('"+dataUrl+"')";
    artEl.style.backgroundSize='cover';
  } catch(e){/* fallback to gradient */}

  // Load real DALL-E image async on top of the canvas placeholder
  if (job.id) {
    fetch('/api/cover-image/' + job.id)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data){
        if (!data || !data.url) return;
        const img = new Image();
        img.onload = function(){
          artEl.style.backgroundImage = "url('"+data.url+"')";
          artEl.style.backgroundSize = 'cover';
          artEl.style.backgroundPosition = 'center';
        };
        img.src = data.url;
      })
      .catch(function(){ /* keep canvas art */ });
  }

  if (job.zip_url) {
    const zipBtn = document.getElementById('stems-download-zip-btn');
    if (zipBtn) {
      zipBtn.style.display = '';
      const safe = title.replace(/[^a-zA-Z0-9 _-]/g,'').replace(/ +/g,'_').toLowerCase() || 'stems';
      zipBtn.onclick = () => { const a=document.createElement('a'); a.href=job.zip_url; a.download=safe+'_stems.zip'; document.body.appendChild(a); a.click(); a.remove(); };
    }
  }
}

// ── Build player ──────────────────────────────────────────────
async function buildStemsPlayer(job) {
  showState('loading');
  const zipUrl = job.zip_url;

  // If tracks array is empty (old jobs), fall back to default 4-stem config
  const defaultTracks = [
    { stem: 'drums',  name: 'Drums',         family: 'drums',  color: '#ef4444', status: 'ready' },
    { stem: 'bass',   name: 'Bass',           family: 'bass',   color: '#3b82f6', status: 'ready' },
    { stem: 'vocals', name: 'Vocals',         family: 'vocals', color: '#ec4899', status: 'ready' },
    { stem: 'other',  name: 'Other (Melody)', family: 'synth',  color: '#8b5cf6', status: 'ready' },
  ];
  const tracks = (job.tracks && job.tracks.length > 0)
    ? job.tracks.filter((t) => t.stem !== 'instrumental')
    : defaultTracks;

  // Build stem rows immediately — player shows without waiting for audio
  const listEl = document.getElementById('stems-list');
  listEl.innerHTML = '';
  tracks.forEach(t => {
    listEl.appendChild(buildStemRow(t));
    stemMuted[t.stem] = false;
    stemSolo[t.stem]  = false;
    stemGains[t.stem] = 1.0;
    // Show a loading indicator on each waveform canvas while audio loads
    drawLoadingWaveform(t.stem, t.color);
  });

  // Show player UI immediately — don't wait for ZIP/audio
  showState('player');
  setVIMode('vocals');

  // Load audio in background (non-blocking) — uses /api/stem-audio per stem, never downloads full ZIP
  loadStemsAudio(STEMS_JOB_ID, tracks).catch(e => {
    console.error('[StemForge] background audio load failed:', e);
  });

  // Seek bar
  const seekEl = document.getElementById('stems-seek');
  if (seekEl) {
    seekEl.addEventListener('mousedown', () => seekEl._dragging = true);
    seekEl.addEventListener('touchstart', () => seekEl._dragging = true);
    seekEl.addEventListener('change', () => {
      seekEl._dragging = false;
      Object.values(stemAudios).forEach(a => { if (a.duration) a.currentTime = (seekEl.value/100)*a.duration; });
    });
  }

  // Master volume
  const volEl = document.getElementById('stems-master-vol');
  if (volEl) volEl.addEventListener('input', () => { masterVolume = volEl.value/100; applyVolumes(); });
}

// ── Load stems audio in background — one stem at a time via /api/stem-audio ─
// Never downloads the full ZIP (124MB+). Each stem is ~5-10MB fetched individually.
async function loadStemsAudio(jobId, tracks) {
  console.log('[StemForge] loadStemsAudio start, jobId:', jobId, 'tracks:', tracks.length);

  // Init AudioContext early (page load counts as user interaction in some browsers)
  let ctx = null;
  try { ctx = getAudioCtx(); } catch(ae) { console.warn('[StemForge] AudioContext init failed:', ae); }

  let primaryStem = null;

  for (const t of tracks) {
    try {
      const stemUrl = '/api/stem-audio/' + jobId + '/' + t.stem;
      console.log('[StemForge] Fetching stem:', t.stem, stemUrl);

      const resp = await fetch(stemUrl);
      if (!resp.ok) {
        console.warn('[StemForge] stem fetch failed:', t.stem, resp.status, await resp.text().catch(()=>''));
        drawRandomWaveform(t.stem, t.color);
        continue;
      }

      const arrayBuf = await resp.arrayBuffer();
      console.log('[StemForge] Got stem:', t.stem, arrayBuf.byteLength, 'bytes');

      const blob  = new Blob([arrayBuf], { type: resp.headers.get('Content-Type') || 'audio/wav' });
      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume  = masterVolume;
      audio.preload = 'auto';
      stemAudios[t.stem] = audio;

      // First loaded stem drives the seek bar + time display
      if (!primaryStem) {
        primaryStem = t.stem;
        audio.addEventListener('timeupdate', () => {
          if (!audio.duration) return;
          const pct = (audio.currentTime / audio.duration) * 100;
          const seekEl = document.getElementById('stems-seek');
          if (seekEl && !seekEl._dragging) seekEl.value = pct;
          document.getElementById('stems-time-cur').textContent = fmtTime(audio.currentTime);
          document.getElementById('stems-time-dur').textContent = fmtTime(audio.duration);
        });
        audio.addEventListener('ended', () => {
          isPlaying = false;
          document.getElementById('stems-play-icon').className = 'fas fa-play';
          document.querySelectorAll('.stem-row__play i').forEach(i => i.className = 'fas fa-play');
        });
      }

      // Wire AudioContext analyser for real waveform
      if (ctx) {
        try {
          const src      = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.8;
          src.connect(analyser);
          analyser.connect(ctx.destination);
          stemAnalysers[t.stem] = analyser;
          stemSources[t.stem]   = src;
        } catch(ae) { console.warn('[StemForge] analyser fail', t.stem, ae); }

        // Draw real waveform from decoded audio data
        try {
          const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
          drawStaticWaveform(t.stem, decoded, t.color);
        } catch(de) { drawRandomWaveform(t.stem, t.color); }
      } else {
        drawRandomWaveform(t.stem, t.color);
      }

    } catch(err) {
      console.warn('[StemForge] error loading stem', t.stem, err);
      drawRandomWaveform(t.stem, t.color);
    }
  }

  const loadedCount = Object.keys(stemAudios).length;
  console.log('[StemForge] Audio load complete:', loadedCount, '/', tracks.length, 'stems loaded');
  if (loadedCount === 0) {
    document.querySelectorAll('.stem-row__play').forEach(b => b.style.opacity='0.3');
  }
}

// ── Loading waveform placeholder ──────────────────────────────
function drawLoadingWaveform(stem, color) {
  const canvas = document.getElementById('wave-' + stem);
  if (!canvas) return;
  const W = canvas.width || 300, H = canvas.height || 48;
  const ctx2 = canvas.getContext('2d');
  if (!ctx2) return;
  ctx2.clearRect(0, 0, W, H);
  // Draw subtle bars to indicate loading
  const bars = 40;
  const bw = Math.max(1, W/bars - 1);
  ctx2.fillStyle = color + '33';
  for (let i = 0; i < bars; i++) {
    const h = H * 0.15 + (H * 0.25 * Math.sin(i * 0.5));
    const x = i * (W / bars);
    ctx2.fillRect(x, (H - h) / 2, bw, h);
  }
}

// ── Track color map ───────────────────────────────────────────
function trackColor(stem) {
  return ({drums:'#ef4444',bass:'#3b82f6',vocals:'#ec4899',other:'#8b5cf6',
    piano:'#f59e0b',guitar:'#10b981',strings:'#06b6d4',synth:'#8b5cf6',
    brass:'#f97316',woodwind:'#84cc16',fx:'#a78bfa'})[stem] || '#6366f1';
}

// ── Static waveform from decoded AudioBuffer ──────────────────
function drawStaticWaveform(stem, buf, color) {
  const waveEl = document.getElementById('stem-wave-' + stem);
  if (!waveEl) return;
  waveEl.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width  = waveEl.offsetWidth || 300;
  canvas.height = 32;
  canvas.style.cssText = 'width:100%;height:32px;display:block;';
  waveEl.appendChild(canvas);

  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / canvas.width));
  const peaks = [];
  for (let i = 0; i < canvas.width; i++) {
    let mx = 0;
    for (let j = 0; j < step; j++) { const v = Math.abs(data[i*step+j]||0); if(v>mx) mx=v; }
    peaks.push(mx);
  }
  canvas._peaks   = peaks;
  canvas._color   = color;
  canvas._stemKey = stem;
  renderWaveCanvas(canvas, 0);
  if (stemAnalysers[stem]) startWaveAnimation(stem, canvas);
}

// ── Render wave canvas ────────────────────────────────────────
function renderWaveCanvas(canvas, progress) {
  const peaks = canvas._peaks;
  if (!peaks) return;
  const ctx2 = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const color = canvas._color || '#6366f1', mid = H/2;
  const played = Math.floor(W * (progress||0));
  ctx2.clearRect(0,0,W,H);
  for (let x = 0; x < W; x++) {
    const peak = peaks[x]||0, barH = Math.max(2, peak*H*0.9);
    ctx2.fillStyle = x < played ? color : color+'44';
    ctx2.fillRect(x, mid - barH/2, 1, barH);
  }
}

// ── Random fallback waveform ──────────────────────────────────
function drawRandomWaveform(stem, color) {
  const waveEl = document.getElementById('stem-wave-' + stem);
  if (!waveEl) return;
  waveEl.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = waveEl.offsetWidth || 300; canvas.height = 32;
  canvas.style.cssText = 'width:100%;height:32px;display:block;';
  canvas._peaks   = Array.from({length:canvas.width}, () => Math.random()*0.6+0.1);
  canvas._color   = color;
  canvas._stemKey = stem;
  waveEl.appendChild(canvas);
  renderWaveCanvas(canvas, 0);
  if (stemAnalysers[stem]) startWaveAnimation(stem, canvas);
}

// ── Live waveform animation ───────────────────────────────────
function startWaveAnimation(stem, canvas) {
  if (waveRAF[stem]) cancelAnimationFrame(waveRAF[stem]);
  const analyser = stemAnalysers[stem], audio = stemAudios[stem];
  if (!analyser || !audio) return;
  const dataArr = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    waveRAF[stem] = requestAnimationFrame(tick);
    const prog = audio.duration ? audio.currentTime / audio.duration : 0;
    if (audio.paused && !isPlaying) { renderWaveCanvas(canvas, prog); return; }

    analyser.getByteTimeDomainData(dataArr);
    const ctx2 = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    const color = canvas._color || '#6366f1', mid = H/2;
    const played = Math.floor(W * prog);

    ctx2.clearRect(0,0,W,H);
    if (canvas._peaks) {
      for (let x=0; x<W; x++) {
        const pk = canvas._peaks[x]||0, bh = Math.max(1, pk*H*0.9);
        ctx2.fillStyle = x < played ? color+'cc' : color+'33';
        ctx2.fillRect(x, mid-bh/2, 1, bh);
      }
    }
    // Live waveform overlay on played region
    if (played > 4) {
      ctx2.beginPath();
      ctx2.strokeStyle = color;
      ctx2.lineWidth = 1.5;
      const sw = played / dataArr.length;
      for (let i=0; i<dataArr.length; i++) {
        const y = (dataArr[i]/128.0) * mid;
        const px = Math.floor(i * sw);
        i===0 ? ctx2.moveTo(px,y) : ctx2.lineTo(px,y);
      }
      ctx2.stroke();
    }
    // Playhead
    if (played > 0) { ctx2.fillStyle='rgba(255,255,255,0.9)'; ctx2.fillRect(played-1,0,2,H); }
  }
  tick();
}

// ── Build stem row ────────────────────────────────────────────
function buildStemRow(track) {
  const el = document.createElement('div');
  el.className = 'stem-row'; el.dataset.stem = track.stem;
  const iconMap = {drums:'fa-drum',bass:'fa-guitar',vocals:'fa-microphone',other:'fa-wave-square',
    mix:'fa-compact-disc',piano:'fa-piano',guitar:'fa-guitar',strings:'fa-violin',
    synth:'fa-wave-square',brass:'fa-trumpet',woodwind:'fa-music',fx:'fa-magic'};
  const icon = iconMap[track.family] || iconMap[track.stem] || 'fa-music';
  el.innerHTML = \`
    <div class="stem-row__left">
      <div class="stem-row__icon" style="background:\${track.color}"><i class="fas \${icon}"></i></div>
      <div class="stem-row__info">
        <div class="stem-row__name" id="stem-name-\${track.stem}">\${track.name}</div>
        <div class="stem-row__filename">\${track.stem}.wav</div>
      </div>
    </div>
    <div class="stem-row__wave" id="stem-wave-\${track.stem}"></div>
    <div class="stem-row__controls">
      <button class="stem-ctrl-btn stem-row__play" id="stem-play-\${track.stem}" onclick="stemPlayPause('\${track.stem}')" title="Play/Pause"><i class="fas fa-play"></i></button>
      <button class="stem-ctrl-btn stem-row__mute" id="stem-mute-\${track.stem}" onclick="stemToggleMute('\${track.stem}')" title="Mute"><i class="fas fa-volume-mute"></i></button>
      <button class="stem-ctrl-btn stem-row__solo" id="stem-solo-\${track.stem}" onclick="stemToggleSolo('\${track.stem}')" title="Solo"><span style="font-size:.7rem;font-weight:700">S</span></button>
      <button class="stem-ctrl-btn" onclick="stemRename('\${track.stem}')" title="Rename"><i class="fas fa-pen" style="font-size:.7rem"></i></button>
      <button class="stem-ctrl-btn stem-row__dl" onclick="stemDownload('\${track.stem}','\${track.name}')" title="Download"><i class="fas fa-download"></i></button>
    </div>\`;
  return el;
}

// ── Play All ──────────────────────────────────────────────────
function stemsTogglePlayAll() {
  getAudioCtx();
  if (isPlaying) {
    Object.values(stemAudios).forEach(a => a.pause());
    isPlaying = false;
    document.getElementById('stems-play-icon').className = 'fas fa-play';
    document.querySelectorAll('.stem-row__play i').forEach(i => i.className = 'fas fa-play');
  } else {
    const audios = Object.values(stemAudios);
    if (!audios.length) return;
    const ref = audios[0];
    audios.forEach(a => { a.currentTime = ref.currentTime; a.play().catch(()=>{}); });
    isPlaying = true;
    document.getElementById('stems-play-icon').className = 'fas fa-pause';
    document.querySelectorAll('.stem-row__play i').forEach(i => i.className = 'fas fa-pause');
  }
}

// ── Individual play/pause ─────────────────────────────────────
function stemPlayPause(stem) {
  const audio = stemAudios[stem]; if (!audio) return;
  getAudioCtx();
  const icon = document.getElementById('stem-play-'+stem)?.querySelector('i');
  if (audio.paused) { audio.play().catch(()=>{}); if(icon) icon.className='fas fa-pause'; }
  else { audio.pause(); if(icon) icon.className='fas fa-play'; }
}

// ── Mute ──────────────────────────────────────────────────────
function stemToggleMute(stem) {
  stemMuted[stem] = !stemMuted[stem];
  document.getElementById('stem-mute-'+stem)?.classList.toggle('active', stemMuted[stem]);
  applyVolumes();
}

// ── Solo ──────────────────────────────────────────────────────
function stemToggleSolo(stem) {
  stemSolo[stem] = !stemSolo[stem];
  hasSoloActive  = Object.values(stemSolo).some(v => v);
  document.querySelectorAll('.stem-row__solo').forEach(b => {
    const s = b.closest('.stem-row')?.dataset.stem;
    if (s) b.classList.toggle('active', !!stemSolo[s]);
  });
  applyVolumes();
}

// ── Apply volumes ─────────────────────────────────────────────
function applyVolumes() {
  Object.entries(stemAudios).forEach(([stem, audio]) => {
    const muted  = stemMuted[stem];
    const soloed = hasSoloActive && !stemSolo[stem];
    const viMuted = viMode === 'instrumental' && stem === 'vocals';
    audio.volume = (muted || soloed || viMuted) ? 0 : masterVolume * stemGains[stem];
  });
}

// ── Download individual stem ──────────────────────────────────
async function stemDownload(stem, name) {
  const job = stemsJob;
  if (!job?.zip_url) return;
  const safe = (job.title||stem).replace(/[^a-zA-Z0-9 _-]/g,'').replace(/ +/g,'_').toLowerCase() || 'beat';
  const audio = stemAudios[stem];
  if (audio?.src?.startsWith('blob:')) {
    const a = document.createElement('a'); a.href=audio.src; a.download=safe+'_'+stem+'.wav';
    document.body.appendChild(a); a.click(); a.remove(); return;
  }
  try {
    const btn = document.querySelector('.stem-row[data-stem="'+stem+'"] .stem-row__dl');
    if (btn) { btn.innerHTML='<i class="fas fa-spinner fa-spin" style="font-size:.7rem"></i>'; btn.disabled=true; }
    const JSZipLib = await loadJSZip();
    let zipData = stemZipCache;
    if (!zipData) { zipData = await (await fetch(job.zip_url)).arrayBuffer(); stemZipCache = zipData; }
    const zip = await JSZipLib.loadAsync(zipData);
    const sl = stem.toLowerCase();
    const cands = [sl+'.wav', sl+'.mp3', stem+'.wav', stem+'.mp3'];
    let blob = null;
    for (const c of cands) { const e=zip.file(c); if(e){blob=await e.async('blob');break;} }
    if (!blob) {
      const files=[]; zip.forEach(p=>files.push(p));
      for (const p of files) {
        if ((p.toLowerCase().endsWith('.wav')||p.toLowerCase().endsWith('.mp3')) && p.toLowerCase().includes(sl)) {
          blob = await zip.file(p).async('blob'); break;
        }
      }
    }
    if (blob) { const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download=safe+'_'+stem+'.wav'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),5000); }
    if (btn) { btn.innerHTML='<i class="fas fa-download"></i>'; btn.disabled=false; }
  } catch(e) { alert('Could not extract stem. Try downloading the full ZIP.'); }
}

// ── Rename stem ───────────────────────────────────────────────
function stemRename(stem) {
  const nameEl = document.getElementById('stem-name-'+stem); if(!nameEl) return;
  const cur = nameEl.textContent;
  const inp = document.createElement('input');
  inp.type='text'; inp.value=cur;
  inp.style.cssText='background:var(--surface);border:1px solid var(--primary);border-radius:6px;padding:2px 8px;color:var(--text);font-size:.9rem;font-weight:600;width:100%;max-width:140px;font-family:inherit';
  nameEl.replaceWith(inp); inp.focus(); inp.select();
  function save() {
    const span=document.createElement('div'); span.className='stem-row__name'; span.id='stem-name-'+stem;
    span.textContent=inp.value.trim()||cur; inp.replaceWith(span);
  }
  inp.addEventListener('blur', save);
  inp.addEventListener('keydown', e => { if(e.key==='Enter'){e.preventDefault();save();} if(e.key==='Escape'){inp.value=cur;save();} });
}

// ── Extract stems ─────────────────────────────────────────────
async function stemsExtract() {
  const btn    = document.getElementById('stems-extract-btn');
  const status = document.getElementById('stems-extract-status');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extracting...';
  if (status) { status.style.display='block'; status.textContent='⏳ Extracting stems — this takes ~15 seconds...'; status.style.color='var(--muted)'; }
  try {
    const res  = await fetch('/api/job/stems', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ job_id: STEMS_JOB_ID })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (status) { status.textContent='❌ '+(data.error||'Extraction failed.'); status.style.color='var(--danger)'; }
      btn.disabled=false; btn.innerHTML='<i class="fas fa-layer-group"></i> Retry';
      return;
    }
    if (status) { status.textContent='✅ Done! Building player...'; status.style.color='var(--accent-2)'; }
    stemsJob.zip_url = data.zip_url;
    stemsJob.tracks  = data.tracks || stemsJob.tracks;
    if (data.midi_zip_url) stemsJob.midi_zip_url = data.midi_zip_url;
    // Cache in sessionStorage so back-navigation skips the credit prompt
    try {
      sessionStorage.setItem('stems_extracted_' + STEMS_JOB_ID, JSON.stringify({
        zip_url: data.zip_url,
        tracks:  data.tracks || [],
        midi_zip_url: data.midi_zip_url || null
      }));
    } catch(e) { /* storage full — ignore */ }
    populateHero(stemsJob);
    await buildStemsPlayer(stemsJob);
  } catch(e) {
    if (status) { status.textContent='❌ Network error.'; status.style.color='var(--danger)'; }
    if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-layer-group"></i> Retry'; }
  }
}

stemsInit();
</script>
`, `<style>
.stems-page { padding: 0; max-width: none; }

.stems-topbar {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 28px; border-bottom: 1px solid var(--border);
  background: var(--surface); position: sticky; top: 0; z-index: 10;
}
.stems-back-btn {
  background: none; border: none; color: var(--muted); cursor: pointer;
  font-size: .9rem; display: flex; align-items: center; gap: 7px;
  padding: 6px 10px; border-radius: 8px; transition: color .2s, background .2s;
}
.stems-back-btn:hover { background: var(--border); color: var(--text); }
.stems-topbar__title { flex: 1; font-size: 1rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stems-topbar__actions { flex-shrink: 0; }

.stems-hero {
  display: flex; align-items: center; gap: 24px;
  padding: 24px 28px; border-bottom: 1px solid var(--border);
  background: rgba(15,15,30,0.35);
}
.stems-hero__art {
  width: 96px; height: 96px; border-radius: 12px; flex-shrink: 0;
  background: #1a1a2e; background-size: cover; background-position: center; overflow: hidden;
}
.stems-hero__title { font-size: 1.2rem; font-weight: 700; margin-bottom: 4px; }
.stems-hero__meta  { font-size: .82rem; color: var(--muted); margin-bottom: 8px; }
.stems-hero__badge { display: inline-block; font-size: .72rem; font-weight: 700;
  padding: 2px 8px; border-radius: 99px; background: rgba(99,102,241,.15); color: #a78bfa; }

/* Vocals / Instrumental toggle strip */
.stems-vi-strip {
  display: flex; align-items: center; justify-content: center; gap: 0;
  padding: 14px 28px; border-bottom: 1px solid var(--border);
  background: rgba(15,15,30,0.35);
}
.stems-vi-btn {
  padding: 8px 24px; border: 1px solid var(--border); background: none;
  color: var(--muted); font-size: .9rem; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 8px; transition: all .18s;
}
.stems-vi-btn:first-child { border-radius: 8px 0 0 8px; border-right: none; }
.stems-vi-btn:last-child  { border-radius: 0 8px 8px 0; border-left: 1px solid var(--border); }
.stems-vi-btn--active {
  background: var(--primary); border-color: var(--primary); color: #fff;
}
.stems-vi-btn:not(.stems-vi-btn--active):hover { border-color: var(--primary); color: var(--primary); }

.stems-transport {
  padding: 16px 28px; border-bottom: 1px solid var(--border);
  background: rgba(15,15,30,0.35);
  flex-direction: column; gap: 10px;
}
.stems-play-all-btn {
  width: 46px; height: 46px; border-radius: 50%;
  background: var(--primary); border: none; cursor: pointer;
  color: #fff; font-size: 1.1rem; flex-shrink: 0; display: flex;
  align-items: center; justify-content: center; transition: transform .1s, background .2s;
}
.stems-play-all-btn:hover { background: var(--primary-dark, #3b89ff); transform: scale(1.05); }

.stems-list { padding: 0 0 40px; background: rgba(10,10,20,0.35); }

.stem-row {
  display: grid; grid-template-columns: 240px 1fr 200px;
  align-items: center; gap: 16px; padding: 14px 28px;
  border-bottom: 1px solid var(--border); transition: background .15s;
}
.stem-row:hover { background: rgba(255,255,255,.03); }
.stem-row:last-child { border-bottom: none; }
.stem-row__left  { display: flex; align-items: center; gap: 12px; }
.stem-row__icon  { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: .85rem; color: #fff; flex-shrink: 0; }
.stem-row__name { font-size: .92rem; font-weight: 600; }
.stem-row__filename { font-size: .74rem; color: var(--muted); }
.stem-row__wave { height: 32px; overflow: hidden; }
.stem-row__controls { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.stem-ctrl-btn {
  width: 32px; height: 32px; border-radius: 8px;
  background: none; border: 1px solid var(--border);
  color: var(--muted); cursor: pointer; font-size: .78rem;
  display: flex; align-items: center; justify-content: center;
  transition: all .15s;
}
.stem-ctrl-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.stem-ctrl-btn.active { background: rgba(99,102,241,.2); border-color: #6366f1; color: #a78bfa; }
.stem-row__mute.active { background: rgba(239,68,68,.15); border-color: #ef4444; color: #f87171; }
/* Solo button — YELLOW when active */
.stem-row__solo.active { background: rgba(251,191,36,.18); border-color: #fbbf24; color: #fbbf24; }
.stem-row__dl { background: rgba(16,185,129,.1); border-color: rgba(16,185,129,.3); color: #34d399; }
.stem-row__dl:hover { background: rgba(16,185,129,.2); border-color: #34d399; color: #10b981; }

/* Confirm modal */
.stems-confirm-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999;
  display: flex; align-items: center; justify-content: center;
}
.stems-confirm-box {
  background: var(--surface, #1a1a2e); border: 1px solid var(--border);
  border-radius: 18px; padding: 36px 32px; max-width: 400px; width: 90%;
  text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.6);
}
.stems-confirm-icon { font-size: 2.2rem; color: var(--primary, #6366f1); margin-bottom: 14px; }
.stems-confirm-box h3 { margin: 0 0 4px; font-size: 1.15rem; }
.stems-confirm-btns { display: flex; gap: 12px; justify-content: center; margin-top: 22px; }

@media (max-width: 700px) {
  .stem-row { grid-template-columns: 1fr 130px; }
  .stem-row__wave { display: none; }
  .stems-hero { flex-direction: column; align-items: flex-start; gap: 16px; }
  .stems-vi-strip { padding: 12px 16px; }
}
</style>`)
}


// ─── GENERATOR PAGE (real pipeline UI) ───────────────────────────────────────
function generatorPage() {
  return shell('Generator', `
<div class="gs-content gs-content--gen">
<!-- Suno-style generator layout: left panel = controls, right panel = result -->
<div class="suno-gen-page">

  <!-- ── LEFT COLUMN: Input Controls ─────────────────────────── -->
  <div class="suno-left" id="suno-left">

    <!-- SECTION 1: Lyrics / Prompt / Instrumental -->
    <div class="suno-card" id="card-lyrics">
      <div class="suno-card__header">
        <button class="suno-card__collapse" id="lyrics-collapse-btn" aria-label="Toggle">
          <i class="fas fa-chevron-down" id="lyrics-collapse-icon"></i>
        </button>
        <span class="suno-card__title">Lyrics</span>
        <div class="suno-tab-group" id="lyrics-tabs">
          <button class="suno-tab active" data-tab="write">Write</button>
          <button class="suno-tab" data-tab="prompt">Prompt</button>
          <button class="suno-tab" data-tab="instrumental">Instrumental</button>
        </div>
      </div>
      <div class="suno-card__body" id="lyrics-body">
        <!-- Write tab -->
        <div class="suno-tab-panel active" id="tab-write">
          <textarea class="suno-textarea" id="gen-lyrics" rows="5"
            placeholder="[Verse]&#10;Write your lyrics here, or describe what you want...&#10;&#10;Section tags like [Chorus] help structure your track."></textarea>
          <div class="suno-textarea-actions">
            <button class="suno-icon-btn" title="Magic Wand" id="lyrics-magic-btn"><i class="fas fa-magic"></i></button>
            <button class="suno-icon-btn" title="Expand" onclick="document.getElementById('gen-lyrics').rows=document.getElementById('gen-lyrics').rows===5?12:5"><i class="fas fa-expand-arrows-alt"></i></button>
          </div>
        </div>
        <!-- Prompt tab -->
        <div class="suno-tab-panel" id="tab-prompt">
          <textarea class="suno-textarea" id="gen-prompt" rows="5"
            placeholder="Describe your beat... e.g. dark surf noir trap, moody Rhodes, open hi-hats, deep 808 bass, cinematic and emotional"></textarea>
          <div class="suno-textarea-actions">
            <button class="suno-icon-btn" title="Magic Wand" id="prompt-magic-btn"><i class="fas fa-magic"></i></button>
            <button class="suno-icon-btn" title="Expand" onclick="document.getElementById('gen-prompt').rows=document.getElementById('gen-prompt').rows===5?12:5"><i class="fas fa-expand-arrows-alt"></i></button>
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

    <!-- SECTION 2: Styles -->
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
            <button class="suno-chip" data-style="trap">Trap</button>
            <button class="suno-chip" data-style="drill">Drill</button>
            <button class="suno-chip" data-style="R&B">R&B</button>
            <button class="suno-chip" data-style="lo-fi">Lo-Fi</button>
            <button class="suno-chip" data-style="boom bap">Boom Bap</button>
            <button class="suno-chip" data-style="afrobeats">Afrobeats</button>
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

    <!-- SECTION 3: More Options (collapsible) -->
    <div class="suno-card suno-card--collapsed" id="card-more">
      <div class="suno-card__header" id="more-options-toggle" style="cursor:pointer">
        <button class="suno-card__collapse suno-card__collapse--right" aria-label="Toggle">
          <i class="fas fa-chevron-right" id="more-collapse-icon"></i>
        </button>
        <span class="suno-card__title">More Options</span>
      </div>
      <div class="suno-card__body" id="more-body" style="display:none">
        <!-- Instruments (prompt-based, optional) -->
        <div class="suno-option-row">
          <label class="suno-option-label">Include instruments <span class="suno-optional-tag">Optional</span></label>
          <textarea class="suno-textarea suno-textarea--sm" id="gen-instruments"
            rows="2"
            placeholder="e.g. Rhodes piano, flute, violin, guitar... describe any instruments you want included"></textarea>
        </div>
      </div>
    </div>

    <!-- SECTION 4: Song Title -->
    <div class="suno-card suno-card--slim">
      <div class="suno-field-row">
        <i class="fas fa-music suno-field-icon"></i>
        <input type="text" class="suno-field-input" id="gen-title" placeholder="Song title (optional)"/>
      </div>
    </div>

    <!-- CREATE BUTTON — inline below song title, like Suno -->
    <div class="suno-create-inline">
      <button class="suno-create-btn" id="gen-full-btn">
        <i class="fas fa-music"></i> Create
      </button>

    </div>

  </div><!-- /suno-left -->

  <!-- ── RIGHT COLUMN: Result / Pipeline ─────────────────────── -->
  <div class="suno-right">

    <!-- Pipeline status - simple spinner, no step details shown -->
    <div class="pipeline-status suno-pipeline" id="pipeline-status" style="display:none">
      <div class="pipeline-spinner-wrap">
        <div class="pipeline-spinner"></div>
        <p class="pipeline-spinner-msg" id="pipeline-spinner-msg">Crafting your beat...</p>
      </div>
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
        <audio id="stereo-audio" controls style="width:100%;margin-top:8px;"></audio>
        <a id="stereo-download" class="btn btn--outline btn--sm" style="margin-top:10px" download>
          <i class="fas fa-download"></i> Download
        </a>
      </div>
      <!-- Track list (hidden for free tier, shown for Creator/Pro) -->
      <div class="track-list" id="track-list" style="display:none"></div>
      <!-- Export panel -->
      <div class="export-panel">
        <h4>Export options</h4>
        <div class="export-options">
          <button class="export-btn" id="exp-stereo"><i class="fas fa-file-audio"></i><span>Stereo mix</span><small>Free</small></button>
          <button class="export-btn export-btn--get-stems" id="exp-stems"><i class="fas fa-layer-group"></i><span>Get Stems</span><small>Creator+</small></button>
          <button class="export-btn export-btn--get-stems" id="exp-tracks"><i class="fas fa-music"></i><span>Get Stems</span><small>Creator+</small></button>
        </div>
        <a href="/pricing" class="upgrade-nudge"><i class="fas fa-arrow-up"></i> Upgrade to Creator or Pro Artist to unlock stems</a>
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
      <div class="plan-card">
        <div class="plan-card__tier">Free</div>
        <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
        <p class="plan-card__desc">Try the engine. No card needed.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 3 generations/month</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full AI beat generation</li>
          <li><i class="fas fa-check"></i> Stereo preview & playback</li>
          <li class="muted"><i class="fas fa-times"></i> Downloads</li>
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
        <p class="plan-card__desc">For Artists, writers, and content creators.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 50 generations/month</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full AI beat generation</li>
          <li><i class="fas fa-check"></i> Stereo download</li>
          <li><i class="fas fa-check"></i> Stem ZIP export (5 stems, labeled)</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> +$0.49 per extra generation</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
        </ul>
        <a href="/checkout?plan=creator" class="btn btn--primary btn--full">Start Creator — $19/mo</a>
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
        <a href="/checkout?plan=pro" class="btn btn--outline btn--full">Start Pro Artist — $39/mo</a>
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
        <div class="credit-table__row"><span><i class="fas fa-layer-group"></i> Stem ZIP — Creator (5 stems)</span><span class="credit-val">2 credits</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-layer-group"></i> Stem ZIP — Pro (up to 12 stems + MIDI)</span><span class="credit-val">10 credits</span><span class="tier-badge tier-badge--pro">Pro</span></div>
        <div class="credit-table__row"><span><i class="fas fa-list"></i> Individual track download</span><span class="credit-val">Free</span><span class="tier-badge tier-badge--pro">Pro Artist+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-redo"></i> Regenerate one track</span><span class="credit-val">1 gen</span><span class="tier-badge tier-badge--pro">Pro Artist+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-exchange-alt"></i> Replace instrument</span><span class="credit-val">1 gen</span><span class="tier-badge tier-badge--pro">Pro Artist+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-plus-circle"></i> Extra generation (Creator / Pro)</span><span class="credit-val">$0.49</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
      </div>
    </div>

    <div class="faq-wrap">
      <div class="section-header"><div class="section-tag">FAQ</div><h2>Common questions.</h2></div>
      <div class="faq">
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What counts as one generation? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">One generation = one full AI beat: the AI builds the blueprint, renders the instrumental, and optionally extracts stems. Creator plans get 5 labeled stems (Drums, Bass, Melody, Vocals, Other) for 2 credits. Pro Artist plans get up to 12 individually labeled stems (Drums, Bass, Melody, Synth, Guitar, Strings, and more) plus MIDI for 10 credits.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What happens if I run out of generations? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Creator and Pro Artist plans support overage at $0.49 per extra generation. Free plan users must upgrade to continue after 3 generations.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What is in the stem ZIP vs individual track download? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">The stem ZIP (free on all plans) contains 5 audio files: Drums, Bass, Vocals, Other/Melody, and Instrumental mix. Individual track download (Pro Artist+) lets you access each stem file separately by name.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I use the beats commercially? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes — Creator and Pro Artist exports include full commercial use rights. Free plan exports are for personal/demo use only.</div></div>
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
<main class="inner-page gs-content">
  <div class="dash-header"><h2>Library</h2><a href="/generator" class="btn btn--primary"><i class="fas fa-plus"></i> New beat</a></div>
  <div class="project-grid" id="project-grid">
    <div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading projects...</div>
  </div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

function projectPage() {
  return shell('Project Export', `
<main class="inner-page gs-content">
<div style="display:none" class="app-sidebar app-sidebar--dash">
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
        <li><i class="fas fa-check-circle"></i> 3 free generations, no card needed</li>
        <li><i class="fas fa-check-circle"></i> Real AI beat generation</li>
        <li><i class="fas fa-check-circle"></i> Individual track export on Pro Artist</li>
        <li><i class="fas fa-check-circle"></i> Cancel anytime</li>
      </ul>
    </div>
    <div class="auth-split__right">
      <div class="auth-card">
        <h2>Create your account</h2>
        <p class="auth-card__sub">Already have one? <a href="/login">Log in</a></p>
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div class="oauth-btns">
          <a href="/api/auth/google" class="oauth-btn oauth-btn--google"><i class="fab fa-google"></i> Continue with Google</a>
        </div>
        <div class="auth-divider"><span>or</span></div>
        <a href="/register" class="btn btn--outline btn--full btn--lg" style="margin-top:8px">
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
      <a href="/" class="sf-nav__logo auth-logo"><span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
      <h1>Start generating.<br/>Keep every track.</h1>
      <ul class="auth-benefits">
        <li><i class="fas fa-check-circle"></i> 3 free generations, no card needed</li>
        <li><i class="fas fa-check-circle"></i> Real AI beat generation</li>
        <li><i class="fas fa-check-circle"></i> Individual track export on Pro Artist</li>
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
              <label class="plan-radio"><input type="radio" name="plan" value="creator"/><span>Creator — $19/mo</span></label>
              <label class="plan-radio"><input type="radio" name="plan" value="pro"/><span>Pro Artist — $39/mo</span></label>
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
      <a href="/" class="sf-nav__logo auth-logo"><span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span></a>
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
          <a href="${googleHref}" class="oauth-btn oauth-btn--google"><i class="fab fa-google"></i> Continue with Google</a>
        </div>
        <div class="auth-divider"><span>or log in with email</span></div>
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
        <span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span>
        <span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <div class="checkout-plan-summary" id="co-plan-summary">
        <div class="checkout-plan-summary__header">
          <div><h3 id="co-plan-name">Creator Plan</h3><p>Billed monthly · Cancel anytime</p></div>
          <div class="checkout-plan-summary__price"><span id="co-plan-price">$19</span><span>/mo</span></div>
        </div>
        <ul class="checkout-plan-summary__features" id="co-plan-features">
          <li><i class="fas fa-check"></i> 50 generations/month</li>
          <li><i class="fas fa-check"></i> Stereo + 5-stem ZIP download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
        </ul>
        <div class="checkout-plan-summary__total"><span>Total today</span><strong id="co-plan-total">$19.00</strong></div>
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
          <i class="fas fa-lock"></i> <span id="co-btn-text">Continue to payment — $19/mo</span>
        </button>
        <p class="auth-card__sub" style="margin-top:16px;font-size:13px">
          Not ready to pay? <a href="/signup">Try free (3 generations)</a>
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
  return shell('Profile', `
<main class="inner-page gs-content profile-page">
  <div class="container">
    <div class="profile-wrap">
      <div class="profile-cover"></div>
      <div class="profile-body">
        <div class="profile-avatar-wrap">
          ${user.avatar
            ? `<img src="${user.avatar}" class="profile-avatar" alt="${user.name}"/>`
            : `<div class="profile-avatar profile-avatar--initials">${initials}</div>`
          }
        </div>
        <div class="profile-info">
          <div class="profile-info__top">
            <div>
              <h1 class="profile-name">${user.name}</h1>
              <p class="profile-handle">@${user.email.split('@')[0]}</p>
            </div>
            <div class="profile-actions">
              <span class="plan-badge ${planClass}">${planLabel}</span>
              <a href="/account" class="btn btn--outline btn--sm"><i class="fas fa-pencil-alt"></i> Edit</a>
            </div>
          </div>
          <div class="profile-stats">
            <div class="profile-stat">
              <span class="profile-stat__val">${user.gens_used}</span>
              <span class="profile-stat__label">Beats generated</span>
            </div>
            <div class="profile-stat">
              <span class="profile-stat__val">${Math.max(0, user.gens_limit - user.gens_used)}</span>
              <span class="profile-stat__label">Remaining</span>
            </div>
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
</main>`)
}

// ─── SUBSCRIPTION PAGE ────────────────────────────────────────────────────────
function subscriptionPage(user: User, env: Bindings) {
  const planLabel = user.plan === 'pro' ? 'Pro Artist' : user.plan === 'creator' ? 'Creator' : 'Free'
  const planClass = user.plan === 'pro' ? 'plan-badge--pro' : user.plan === 'creator' ? 'plan-badge--creator' : ''
  const pct = user.gens_limit > 0 ? Math.min(100, Math.round((user.gens_used / user.gens_limit) * 100)) : 0
  const billingPeriod = user.plan === 'free' ? 'N/A' : 'Monthly'
  const nextBilling = user.stripe_subscription_id
    ? new Date(Date.now() + 30*24*3600*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
    : 'N/A'
  const stripeOk = stripeConfigured(env)
  // Downgrade options based on current plan
  const canDowngrade = user.plan !== 'free' && stripeOk && !!user.stripe_subscription_id
  const downgradeOptions = user.plan === 'pro'
    ? [{ value: 'creator', label: 'Creator — $19/mo' }, { value: 'free', label: 'Free — $0/mo (cancel)' }]
    : user.plan === 'creator'
    ? [{ value: 'free', label: 'Free — $0/mo (cancel)' }]
    : []

  return shell('Subscription', `
<main class="inner-page gs-content sub-page">
  <div class="container">
    <div class="sub-header">
      <h1>Subscription</h1>
      <p>Manage your plan, billing, and usage.</p>
    </div>
    <div class="sub-stats-bar">
      <div class="sub-stat">
        <span class="sub-stat__label">Current Plan</span>
        <span class="sub-stat__val"><span class="plan-badge ${planClass}">${planLabel}</span></span>
      </div>
      <div class="sub-stat">
        <span class="sub-stat__label">Billing Period</span>
        <span class="sub-stat__val">${billingPeriod}</span>
      </div>
      <div class="sub-stat">
        <span class="sub-stat__label">Next Billing Date</span>
        <span class="sub-stat__val">${nextBilling}</span>
      </div>
      <div class="sub-stat">
        <span class="sub-stat__label">Downloads Remaining</span>
        <span class="sub-stat__val">${Math.max(0, user.gens_limit - user.gens_used)} / ${user.gens_limit}</span>
      </div>
      ${user.plan !== 'free' && stripeOk ? `
      <div class="sub-stat sub-stat--manage">
        <button class="btn btn--outline btn--sm" id="sub-manage-btn">Manage <i class="fas fa-chevron-down"></i></button>
        <div class="sub-manage-dropdown" id="sub-manage-dropdown" style="display:none">
          <a href="/api/stripe/portal" class="sub-manage-item"><i class="fas fa-credit-card"></i> Update payment method</a>
          <a href="/api/stripe/portal" class="sub-manage-item sub-manage-item--danger"><i class="fas fa-times-circle"></i> Cancel subscription</a>
        </div>
      </div>` : ''}
    </div>
    <div class="sub-usage-card">
      <div class="sub-usage-header">
        <h3>Download Usage</h3>
        <span class="sub-usage-count">${user.gens_used} / ${user.gens_limit} used</span>
      </div>
      <div class="sub-usage-bar"><div class="sub-usage-bar__fill" style="width:${pct}%"></div></div>
      <p class="sub-usage-note">${pct}% of your monthly generations used · Resets on billing date</p>
      ${user.plan !== 'free' && stripeOk ? `<a href="/api/stripe/portal" class="btn btn--outline btn--sm" style="margin-top:16px"><i class="fas fa-plus"></i> Buy more credits</a>` : ''}
    </div>
    <div class="sub-plans-section">
      <h3>Available Plans</h3>
      <div class="sub-plans-grid">
        <div class="sub-plan-card ${user.plan === 'free' ? 'sub-plan-card--current' : ''}">
          <div class="sub-plan-card__top">
            <div><h4>Free</h4><p>Try the engine</p></div>
            <div class="sub-plan-card__price">$0<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 3 generations/month</li>
            <li><i class="fas fa-check"></i> Stereo mix</li>
          </ul>
          ${user.plan === 'free' ? '<span class="sub-current-badge">Current plan</span>' : ''}
        </div>
        <div class="sub-plan-card ${user.plan === 'creator' ? 'sub-plan-card--current' : ''}">
          <div class="sub-plan-card__top">
            <div><h4>Creator</h4><p>For Artists &amp; creators</p></div>
            <div class="sub-plan-card__price">$19<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 50 generations/month</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
            <li><i class="fas fa-check"></i> +$0.49/extra gen</li>
          </ul>
          ${user.plan === 'creator'
            ? '<span class="sub-current-badge">Current plan</span>'
            : user.plan === 'pro'
              ? `<button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="creator">Downgrade to Creator</button>`
              : `<a href="/checkout?plan=creator" class="btn btn--primary btn--sm">Upgrade — $19/mo</a>`
          }
        </div>
        <div class="sub-plan-card ${user.plan === 'pro' ? 'sub-plan-card--current' : ''}">
          <div class="sub-plan-card__top">
            <div><h4>Pro Artist</h4><p>Every track, clean</p></div>
            <div class="sub-plan-card__price">$39<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 150 generations/month</li>
            <li><i class="fas fa-check"></i> Individual track download</li>
            <li><i class="fas fa-check"></i> Priority queue</li>
          </ul>
          ${user.plan === 'pro'
            ? '<span class="sub-current-badge">Current plan</span>'
            : `<a href="/checkout?plan=pro" class="btn btn--outline btn--sm">Upgrade — $39/mo</a>`
          }
        </div>
      </div>
      ${canDowngrade ? `
      <div class="sub-downgrade-section">
        <h4>Downgrade Plan</h4>
        <p>Changes take effect at the end of your current billing cycle. You keep all features until then.</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px">
          ${downgradeOptions.map(opt => `
          <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="${opt.value}" style="border-color:rgba(255,100,100,.4);color:#ff6464;">
            <i class="fas fa-arrow-down"></i> ${opt.label}
          </button>`).join('')}
        </div>
      </div>` : ''}
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
<script>
(function(){
  // Manage dropdown toggle
  const manageBtn = document.getElementById('sub-manage-btn');
  const manageDrop = document.getElementById('sub-manage-dropdown');
  if (manageBtn && manageDrop) {
    manageBtn.addEventListener('click', () => {
      manageDrop.style.display = manageDrop.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', e => {
      if (!manageBtn.contains(e.target) && !manageDrop.contains(e.target)) manageDrop.style.display = 'none';
    });
  }
  // Downgrade buttons
  let pendingTarget = null;
  document.querySelectorAll('.sub-downgrade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingTarget = btn.dataset.target;
      const modal = document.getElementById('sub-downgrade-modal');
      const msg = document.getElementById('sub-downgrade-msg');
      if (pendingTarget === 'free') {
        msg.textContent = 'Your subscription will be cancelled at the end of your billing cycle. You will move to the Free plan (3 gen/month) after that.';
      } else if (pendingTarget === 'creator') {
        msg.textContent = 'You will be downgraded to the Creator plan ($19/mo, 50 gen/month) at the end of your current billing cycle.';
      }
      modal.style.display = 'flex';
    });
  });
  const confirmBtn = document.getElementById('sub-downgrade-confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!pendingTarget) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Processing…';
      try {
        const res = await fetch('/api/subscription/downgrade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_plan: pendingTarget })
        });
        const data = await res.json();
        document.getElementById('sub-downgrade-modal').style.display = 'none';
        if (data.ok) {
          alert(data.message || 'Downgrade scheduled. Changes take effect at end of billing period.');
          window.location.reload();
        } else {
          alert('Error: ' + (data.error || 'Downgrade failed'));
        }
      } catch(e) {
        alert('Network error. Please try again.');
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm Downgrade';
      }
    });
  }
})();
</script>`)
}

// ─── ACCOUNT PAGE ─────────────────────────────────────────────────────────────
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
      <div class="account-card">
        <h3>Connected accounts</h3>
        <div class="account-connected">
          <div class="account-connected__item ${hasGoogle ? 'account-connected__item--active' : ''}">
            <i class="fab fa-google" style="font-size:20px;color:#4285f4"></i>
            <div>
              <strong>Google</strong>
              <p>${hasGoogle ? user.email : 'Not connected'}</p>
            </div>
            ${hasGoogle
              ? '<span class="connected-badge"><i class="fas fa-check"></i> Connected</span>'
              : `<a href="/api/auth/google" class="btn btn--outline btn--sm">Connect</a>`
            }
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
        <a href="/subscription" class="btn btn--outline btn--sm" style="margin-top:12px">Manage subscription</a>
      </div>
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
      </div>
    </div>
  </div>
</main>`)
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
      <p>Questions? Email us at <a href="mailto:support@stemforge.com">support@stemforge.com</a></p>
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
  <p>Welcome to <strong>StemForge</strong> ("StemForge," "we," "our," or "us"). By accessing or using our website at <a href="https://stemforge.com">stemforge.com</a>, our beat generation platform, or any related services (collectively, the "Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, do not use our Service.</p>
  <p>We reserve the right to modify these Terms at any time. We will provide notice of significant changes by updating the "Last Updated" date above or sending an email to registered users. Your continued use of the Service after such changes constitutes your acceptance of the revised Terms.</p>
</section>

<section>
  <h2>2. The Service</h2>
  <p>StemForge is an AI-powered music beat generation platform that allows users to create original instrumental beats and audio tracks using artificial intelligence. The Service includes:</p>
  <ul>
    <li>AI-powered beat generation using text prompts, style descriptors, and musical parameters</li>
    <li>Stereo mix downloads and multi-stem ZIP exports (Drums, Bass, Vocals, Melody, Instrumental)</li>
    <li>Individual stem/track downloads (Pro Artist plan)</li>
    <li>Project storage, dashboard, and playback functionality</li>
    <li>Account management including profile, subscription, and billing tools</li>
  </ul>
  <p>We use third-party AI providers to power our generation pipeline. Output quality and availability depend on these services and may vary.</p>
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
</section>

<section>
  <h2>4. Subscriptions, Credits & Billing</h2>
  <h3>4.1 Free Plan</h3>
  <p>Free accounts receive 3 beat generations per month at no charge. Free generations include stereo mix and 5-stem ZIP downloads. No credit card is required to start.</p>

  <h3>4.2 Paid Plans</h3>
  <p>We offer the following paid subscription tiers, billed monthly:</p>
  <ul>
    <li><strong>Creator Plan ($19/month):</strong> 50 generations/month, stereo mix + stem ZIP, commercial use rights, +$0.49 per extra generation</li>
    <li><strong>Pro Artist Plan ($39/month):</strong> 150 generations/month, everything in Creator, individual track downloads, priority queue, +$0.49 per extra generation</li>
  </ul>

  <h3>4.3 Billing & Renewal</h3>
  <p>Paid plans are billed monthly via Stripe. Subscriptions automatically renew unless cancelled before the next billing date. You authorize us to charge your payment method on file for recurring subscription fees and any overage charges.</p>

  <h3>4.4 Refunds</h3>
  <p>All sales are final. We do not offer refunds for monthly subscription charges or individual generation credits consumed. If you believe a charge was made in error, contact us within 14 days at <a href="mailto:support@stemforge.com">support@stemforge.com</a> and we will review your case.</p>

  <h3>4.5 Cancellation</h3>
  <p>You may cancel your subscription at any time through the Subscription page in your account or via the Stripe billing portal. Cancellation takes effect at the end of your current billing period. You retain access to your plan until then.</p>

  <h3>4.6 Generation Credits</h3>
  <p>Monthly generation credits reset on your billing date and do not roll over to the following month. Unused generations are forfeited at period end.</p>
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
  <h2>7. AI-Generated Content Disclaimer</h2>
  <p>StemForge uses AI to generate audio content. While we strive to produce high-quality, original output, we make no guarantees regarding:</p>
  <ul>
    <li>The uniqueness or originality of generated beats</li>
    <li>The absence of similarity to existing copyrighted works</li>
    <li>The suitability of generated content for any particular commercial or artistic purpose</li>
  </ul>
  <p>You are solely responsible for reviewing generated content before use and for ensuring your use complies with applicable copyright law. StemForge is not liable for any third-party claims arising from your use of AI-generated content.</p>
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
    <li>Email: <a href="mailto:support@stemforge.com">support@stemforge.com</a></li>
    <li>Website: <a href="https://stemforge.com">stemforge.com</a></li>
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
  <p>To exercise any of these rights, email us at <a href="mailto:support@stemforge.com">support@stemforge.com</a>. We will respond within 30 days. We may need to verify your identity before processing your request.</p>
  <p><strong>California residents (CCPA):</strong> You have the right to know what personal information we collect, to delete it, and to opt out of its sale. We do not sell personal information.</p>
  <p><strong>EEA/UK residents (GDPR):</strong> Our legal basis for processing your data includes contract performance (providing the Service), legitimate interests (fraud prevention, improving the Service), and legal compliance. You may also lodge a complaint with your local data protection authority.</p>
</section>

<section>
  <h2>9. Children's Privacy</h2>
  <p>The Service is not directed to children under 13 years of age. We do not knowingly collect personal information from children under 13. If we discover we have collected data from a child under 13, we will delete it promptly. If you believe we have collected such data, please contact us at <a href="mailto:support@stemforge.com">support@stemforge.com</a>.</p>
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
    <li>Email: <a href="mailto:support@stemforge.com">support@stemforge.com</a></li>
    <li>General: <a href="mailto:support@stemforge.com">support@stemforge.com</a></li>
    <li>Website: <a href="https://stemforge.com">stemforge.com</a></li>
  </ul>
</section>
`)
}

export default app
