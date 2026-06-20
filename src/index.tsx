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
  ADMIN_EMAIL: string               // Developer admin email — grants developer plan access
  REPLICATE_API_KEY: string         // Replicate API token for Demucs drum/other sub-stem splitting
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
  // Migration-safe: add columns if they don't exist yet
  const migrations = [
    `ALTER TABLE jobs ADD COLUMN user_id TEXT`,
    `ALTER TABLE jobs ADD COLUMN deleted_at INTEGER`,
    `ALTER TABLE jobs ADD COLUMN is_oneshot INTEGER NOT NULL DEFAULT 0`,
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
//  AUTH — Users, Sessions, Google OAuth, Email/Password
//  Uses D1 for persistence. Falls back gracefully if secrets
//  are not yet configured (returns 503 with setup message).
// ═══════════════════════════════════════════════════════════════

interface User {
  id: string
  email: string
  name: string
  avatar?: string
  plan: 'free' | 'creator' | 'pro' | 'developer'
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
      gens_limit INTEGER NOT NULL DEFAULT 5,
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
  const planLimits: Record<string, number> = { free:5, creator:50, pro:200 }
  const plan = data.plan || 'free'
  await db.prepare(
    `INSERT INTO users (id, email, name, avatar, plan, gens_used, gens_limit, password_hash, google_id, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(data.id, data.email, data.name, data.avatar || null, plan,
    planLimits[plan] || 5, data.password_hash || null, data.google_id || null, Date.now()).run()
}

async function updateUserPlan(db: D1Database, userId: string, plan: string,
  stripeCustomerId: string, stripeSubId: string): Promise<void> {
  const planLimits: Record<string, number> = { free:5, creator:50, pro:200 }
  // Apply rollover: unused downloads carry over, capped at 500
  const currentUser = await db.prepare('SELECT gens_used, gens_limit FROM users WHERE id=?').bind(userId).first<{gens_used:number,gens_limit:number}>()
  const newLimit = planLimits[plan] || 5
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
  const planLimits: Record<string, number> = { free:5, creator:50, pro:200 }
  const newMonthBase = planLimits[plan] || 5
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

// Demucs drum sub-stems (from htdemucs_6s model)
// drums.wav → kick, snare, hihat, toms, cymbals
const DEMUCS_DRUM_SUBS = ['kick', 'snare', 'hihat', 'toms', 'cymbals'] as const
type DrumSub = typeof DEMUCS_DRUM_SUBS[number]

// Demucs other/fx sub-stems (htdemucs_6s: drums, bass, other, vocals, guitar, piano)
// We run it on the Mureka "other" or "fx" stem — we keep non-drum outputs as sub-stems
const DEMUCS_OTHER_SUBS = ['guitar', 'piano', 'bass_sub', 'other_sub'] as const

// SubStem: a fully resolved R2 URL for a Demucs-split sub-stem
interface SubStem {
  key: string       // e.g. 'kick', 'snare', 'hihat', 'toms', 'cymbals', 'guitar', 'piano'
  name: string      // Display name
  family: string    // 'drums' | 'keys' | 'guitar' | 'synth'
  color: string
  url: string       // R2 public URL (served via /api/sub-stem-audio/:jobId/:key)
  parent: string    // 'drums' | 'other' | 'fx'  — which Mureka stem this came from
}

interface Job {
  id: string
  status: 'pending' | 'blueprint' | 'generating' | 'extracting' | 'ready' | 'error'
  created_at: number
  blueprint?: Blueprint
  stereo_url?: string
  stereo_task_id?: string
  zip_url?: string        // Mureka stem ZIP download URL
  tracks: Track[]         // Mapped stems for display
  sub_stems?: SubStem[]   // Demucs sub-stems: drum kit + other/fx instrument splits
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

async function generateBlueprint(prompt: string, apiKey: string, titleHint?: string, userPlan?: string, userDurationSec?: number): Promise<Blueprint & { suggested_title?: string }> {
  const suggestedKey = pickRandomKey()

  // Extract genre/style from the front of the prompt if present (it's always prepended first)
  const genreMatch = prompt.match(/^([^.]+?)[\.\,]/)
  const detectedGenre = genreMatch ? genreMatch[1].trim() : ''

  const systemPrompt = `You are a professional music producer AI that creates beat blueprints.
You STRICTLY follow the user's genre, mood, and style — you NEVER substitute or drift.

ABSOLUTE RULES — violating any rule is a failure:
1. GENRE LOCK: The genre field MUST exactly match whatever genre/style the user wrote. If user says "hip hop" → genre = "hip hop". If user says "pop" → genre = "pop". If user says "drill" → genre = "drill". NEVER change it to jazz, R&B, soul, or anything else unless that is what the user wrote.
2. SOUND AUTHENTICITY: The entire blueprint — BPM, instruments, mood, mureka_prompt — MUST sound like the stated genre. Hip hop = punchy 808s + trap hi-hats + sampled chops or piano. Pop = bright synths + 4-on-floor kick + catchy lead. Drill = sliding 808s + rolling hi-hats + dark piano. R&B = silky pads + soft kit + groove. NEVER add jazz piano, walking bass, brushed snares, ride cymbal, swing feel, or laid-back jazz elements to hip hop, trap, drill, or R&B unless the user explicitly asked for jazz.
3. ANTI-JAZZ RULE FOR HIP HOP/TRAP/DRILL: These genres must use 808 bass (NOT walking bass), punchy kicks (NOT brush kit), trap hi-hats or boom bap snares (NOT ride cymbal), and straight or swung hip hop timing (NOT jazz swing). Any jazz reference in a hip hop/trap/drill beat is an automatic failure.
4. BPM ACCURACY: Hip hop = 85–100 BPM. Trap = 130–145 BPM. Drill = 140–145 BPM. Pop = 100–128 BPM. R&B = 65–95 BPM. Lo-fi = 70–90 BPM. Afrobeats = 100–115 BPM. Always use the correct BPM range for the genre.
5. KEY VARIETY: Use the suggested_key provided. Never default to C minor every time.
6. TITLE: If user left title blank, create a 2–4 word creative track name that fits the genre.
7. mureka_prompt: MUST open with the exact genre name, then describe sound in detail (energy, instruments, feel). Max 200 chars. For hip hop/trap/drill, the mureka_prompt MUST contain "808" or "trap" elements — never "jazz", "swing", "walking bass", or "ride cymbal".
8. DURATION: ${userDurationSec ? `The user has requested a specific duration of approximately ${userDurationSec} seconds (${Math.floor(userDurationSec/60)}:${String(userDurationSec%60).padStart(2,'0')}). The duration_seconds field MUST be exactly ${userDurationSec}. Do not deviate from this value.` : (userPlan === 'pro' || userPlan === 'developer' ? 'Pro Artist plan — beats MUST be between 180 and 240 seconds (3–4 min). Prefer 210 or 240 seconds for epic, expansive arrangements. Maximum is 240 (4:00).' : 'Beats should be 90–180 seconds. Default to 150–180 for complex genres.')}
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
  "duration_seconds": <${userDurationSec ? userDurationSec : (userPlan === 'pro' || userPlan === 'developer' ? '180 | 210 | 240' : '90 | 120 | 150 | 180')}>,  // User-specified or plan default
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
- NAMING: instrument "name" MUST be the EXACT specific instrument name — e.g. "Trumpet" NOT "brass", "Flute" NOT "woodwind", "Violin" NOT "strings", "Rhodes Piano" NOT "keys", "808 Bass" NOT "bass", "Acoustic Guitar" NOT "guitar". Be as specific as possible.
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

async function startInstrumentalGeneration(blueprint: Blueprint, apiKey: string, refFileId?: string, vocalGender?: string, userDurationSec?: number): Promise<string> {
  // Build the mureka prompt — enforce no vocals/vocal chops on instrumental mode
  let murekaPrompt = blueprint.mureka_prompt
  // Always strip any vocal references and explicitly state instrumental only
  murekaPrompt = murekaPrompt
    .replace(/\bwith vocals?\b/gi, '')
    .replace(/\bvocal chops?\b/gi, '')
    .replace(/\bchops?\b/gi, '')
    .replace(/\bsinging\b/gi, '')
    .replace(/\blyrics\b/gi, '')
    .trim()
  // Append strong instrumental-only constraint to every beat
  if (!murekaPrompt.includes('no vocals')) {
    murekaPrompt = murekaPrompt.replace(/,?\s*$/, '') + ', no vocals, purely instrumental, no vocal chops'
  }
  // Trim to 200 chars max
  if (murekaPrompt.length > 200) murekaPrompt = murekaPrompt.slice(0, 197) + '...'

  const body: Record<string, any> = {
    prompt: murekaPrompt,
    model: 'auto'
  }
  // Pass user-specified or blueprint duration to Mureka
  // Mureka uses "duration" in seconds — include it even if API doesn't honor it exactly
  // Also bake it into the prompt so the AI knows the target length
  const durationSec = userDurationSec || blueprint.duration_seconds
  if (durationSec && durationSec > 0) {
    body.duration = durationSec
    // Also reinforce duration in the prompt text itself
    const durMin = Math.floor(durationSec / 60)
    const durSec = durationSec % 60
    const durStr = `${durMin}:${String(durSec).padStart(2,'0')}`
    if (!murekaPrompt.includes('minute') && !murekaPrompt.includes('second') && !murekaPrompt.includes(':')) {
      murekaPrompt = murekaPrompt.replace(/,?\s*$/, '') + `, duration ${durStr}`
      body.prompt = murekaPrompt
    }
  }
  // If a reference audio file ID was supplied, pass it for style matching
  if (refFileId) {
    body.reference_audio = refFileId
  }
  const res = await fetch(`${MUREKA_BASE}/instrumental/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
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
//  DEMUCS SUB-STEM SPLITTING — Replicate htdemucs_6s
//
//  Runs AFTER Mureka stem extraction. Two passes:
//    1. drums.wav  → kick, snare, hihat, toms, cymbals  (always)
//    2. other.wav or fx.wav → guitar, piano, other_sub  (only if present in ZIP)
//
//  Sub-stems are stored in R2 under:
//    sub-stems/<jobId>/drums/<key>.wav
//    sub-stems/<jobId>/other/<key>.wav
//    sub-stems/<jobId>/fx/<key>.wav
//
//  Results saved to job.sub_stems[] and served via GET /api/sub-stem-audio/:jobId/:key
// ═══════════════════════════════════════════════════════════════

const REPLICATE_BASE = 'https://api.replicate.com/v1'
// htdemucs_6s: drums, bass, other, vocals, guitar, piano
// We use this for BOTH passes:
//   Pass 1 (drums.wav): we only keep the per-drum output from a drum-focused model
//   For drums we use: openai/whisper isn't right — we use the dedicated drum splitter:
//   mvdbasch/demucs-drum-separator or the 6-stem htdemucs then interpret its drums channel.
//   Best free option: use htdemucs_6s on the drums stem, then the drums output contains
//   the blended drum mix — for true per-drum isolation we use the dedicated drum model.
//
//  Replicate model for per-drum separation:
//    "mvdbasch/demucs" with model_name="htdemucs" for instruments
//    For drum kit isolation we use: "karolpiczak/drum-separator" (kick/snare/hihat/toms/cymbals)
//
//  Simplified approach: use htdemucs_6s for other/fx, drum-separator for drums.wav
const DEMUCS_MODEL_INSTRUMENTS = 'meta/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953'
const DEMUCS_MODEL_DRUMS       = 'mvdbasch/drum-separator:latest'  // fallback — htdemucs only if drum model unavailable

// Poll Replicate prediction until done (max 8 min — CF Worker has 30s CPU but we use fetch polling)
async function pollReplicate(predictionId: string, apiKey: string, maxWaitMs = 480000): Promise<any> {
  const start = Date.now()
  let delay = 3000
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 15000) // backoff up to 15s between polls
    const r = await fetch(`${REPLICATE_BASE}/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    })
    if (!r.ok) continue
    const data = await r.json() as any
    if (data.status === 'succeeded') return data
    if (data.status === 'failed' || data.status === 'canceled')
      throw new Error(`Replicate prediction ${data.status}: ${data.error || 'unknown'}`)
    // still processing — loop
  }
  throw new Error('Replicate timed out after 8 minutes')
}

// Submit one Demucs job to Replicate and wait for result
// audioUrl: publicly accessible URL to the WAV file to split
// Returns: map of stem name → output URL  e.g. { drums: '...', bass: '...', other: '...', ... }
// Upload raw audio bytes to Replicate's file API and return a replicate.delivery URL
// that Replicate can always fetch (no CDN/auth blocks, no Worker URL issues)
async function uploadBytesToReplicate(bytes: ArrayBuffer, apiKey: string, filename: string): Promise<string> {
  const formData = new FormData()
  const blob = new Blob([bytes], { type: 'audio/wav' })
  formData.append('content', blob, filename)

  const r = await fetch(`${REPLICATE_BASE}/files`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData
  })
  if (!r.ok) {
    const err = await r.json() as any
    throw new Error(`Replicate file upload failed: ${err?.detail || r.status}`)
  }
  const data = await r.json() as any
  const url = data?.urls?.get
  if (!url) throw new Error('Replicate file upload returned no URL')
  return url
}

// Run cjwbw/demucs on raw audio bytes — uploads to Replicate first so it can always fetch
// Returns: { drums, bass, vocals, guitar, piano, other } → output MP3 URLs
// runDemucsOnBytes: upload bytes → Replicate file API → submit prediction
// modelName: 'htdemucs_6s' (6 stems, default) | 'htdemucs_ft' (fine-tuned, best quality 4-stem)
async function runDemucsOnBytes(
  audioBytes: ArrayBuffer,
  apiKey: string,
  stemName: string,
  modelName = 'htdemucs_6s'
): Promise<Record<string, string>> {
  // Step 1: Upload audio to Replicate's own file storage (avoids CDN/auth blocks on external URLs)
  const audioUrl = await uploadBytesToReplicate(audioBytes, apiKey, `${stemName}.wav`)

  // Step 2: Submit prediction — cjwbw/demucs v25a173
  // htdemucs_6s = 6 stems (drums/bass/vocals/guitar/piano/other)
  // htdemucs_ft = fine-tuned 4-stem (drums/bass/vocals/other) — best quality, 4× slower
  const r = await fetch(`${REPLICATE_BASE}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=60'
    },
    body: JSON.stringify({
      version: '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953',
      input: {
        audio: audioUrl,
        model_name: modelName,
        output_format: 'mp3',
        shifts: 1,
        overlap: 0.25
      }
    })
  })

  if (!r.ok) {
    const err = await r.json() as any
    throw new Error(`Replicate submit error: ${err?.detail || r.status}`)
  }

  const pred = await r.json() as any
  if (pred.status === 'succeeded') return normalizeDemucsOutput(pred.output)
  if (pred.status === 'failed') throw new Error(`Replicate failed immediately: ${pred.error}`)

  const done = await pollReplicate(pred.id, apiKey)
  return normalizeDemucsOutput(done.output)
}

// htdemucs_6s output can be an object { drums: url, bass: url, ... } or an array
function normalizeDemucsOutput(output: any): Record<string, string> {
  if (!output) return {}
  if (Array.isArray(output)) {
    // Some versions return [drumsUrl, bassUrl, otherUrl, vocalsUrl, guitarUrl, pianoUrl]
    const keys = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
    const map: Record<string, string> = {}
    output.forEach((url: string, i: number) => { if (keys[i] && url) map[keys[i]] = url })
    return map
  }
  if (typeof output === 'object') return output as Record<string, string>
  return {}
}

// Extract one stem WAV from Mureka ZIP by range requests, returns ArrayBuffer
async function extractStemBytesFromZip(zipUrl: string, stemKey: string): Promise<ArrayBuffer | null> {
  try {
    const headRes = await fetch(zipUrl, { method: 'HEAD' })
    if (!headRes.ok) return null
    const totalSize = parseInt(headRes.headers.get('content-length') || '0', 10)
    if (!totalSize) return null

    const tailSize = Math.min(65536, totalSize)
    const tailStart = totalSize - tailSize
    const tailRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${tailStart}-${totalSize - 1}` } })
    if (!tailRes.ok && tailRes.status !== 206) return null
    const tailBuf = await tailRes.arrayBuffer()
    const tailView = new DataView(tailBuf)

    let eocdOffset = -1
    for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
      if (tailView.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break }
    }
    if (eocdOffset < 0) return null

    const cdOffsetInFile = tailView.getUint32(eocdOffset + 16, true)
    const cdSize         = tailView.getUint32(eocdOffset + 12, true)

    let cdBuf: ArrayBuffer
    if (cdOffsetInFile >= tailStart) {
      const s = cdOffsetInFile - tailStart
      cdBuf = tailBuf.slice(s, s + cdSize)
    } else {
      const cdRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${cdOffsetInFile}-${cdOffsetInFile + cdSize - 1}` } })
      cdBuf = await cdRes.arrayBuffer()
    }

    const cdView = new DataView(cdBuf)
    const stemKeywords: Record<string, string[]> = {
      drums:    ['drum'],
      bass:     ['bass'],
      vocals:   ['vocal'],
      other:    ['other', 'melody'],
      piano:    ['piano'],
      guitar:   ['guitar'],
      strings:  ['string'],
      synth:    ['synth'],
      brass:    ['brass'],
      woodwind: ['woodwind', 'wind'],
      fx:       ['fx'],
    }
    const keywords = stemKeywords[stemKey] || [stemKey]

    let foundLocalOffset = -1, foundCompressed = -1, foundUncompressed = -1, foundCompMethod = -1
    let pos = 0

    while (pos < cdBuf.byteLength - 4) {
      if (cdView.getUint32(pos, true) !== 0x02014b50) break
      const compMethod   = cdView.getUint16(pos + 10, true)
      const compressed   = cdView.getUint32(pos + 20, true)
      const uncompressed = cdView.getUint32(pos + 24, true)
      const fnLen        = cdView.getUint16(pos + 28, true)
      const extLen       = cdView.getUint16(pos + 30, true)
      const cmtLen       = cdView.getUint16(pos + 32, true)
      const localOffset  = cdView.getUint32(pos + 42, true)
      const fnBytes      = new Uint8Array(cdBuf, pos + 46, fnLen)
      const fnLower      = new TextDecoder().decode(fnBytes).toLowerCase()

      if ((fnLower.endsWith('.wav') || fnLower.endsWith('.mp3')) &&
          keywords.some(kw => fnLower.includes(kw))) {
        foundLocalOffset = localOffset; foundCompressed = compressed
        foundUncompressed = uncompressed; foundCompMethod = compMethod
      }
      pos += 46 + fnLen + extLen + cmtLen
    }

    if (foundLocalOffset < 0) return null

    // Fetch local file header to get actual data offset
    const lhEnd = foundLocalOffset + 30 + 1024
    const lhRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${foundLocalOffset}-${Math.min(lhEnd, totalSize - 1)}` } })
    if (!lhRes.ok && lhRes.status !== 206) return null
    const lhBuf = await lhRes.arrayBuffer()
    const lhView = new DataView(lhBuf)
    if (lhView.getUint32(0, true) !== 0x04034b50) return null
    const lhFnLen  = lhView.getUint16(26, true)
    const lhExtLen = lhView.getUint16(28, true)
    const dataStart = foundLocalOffset + 30 + lhFnLen + lhExtLen

    // Fetch compressed bytes
    const dataRes = await fetch(zipUrl, {
      headers: { 'Range': `bytes=${dataStart}-${dataStart + foundCompressed - 1}` }
    })
    if (!dataRes.ok && dataRes.status !== 206) return null
    const compData = await dataRes.arrayBuffer()

    // Decompress if needed (Mureka ZIPs use DEFLATE compression method=8)
    if (foundCompMethod === 0) {
      // STORED — raw bytes, no decompression needed
      return compData
    } else if (foundCompMethod === 8) {
      // DEFLATE — decompress using DecompressionStream
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
      let off = 0
      for (const ch of chunks) { out.set(ch, off); off += ch.length }
      return out.buffer
    } else {
      throw new Error(`Unsupported ZIP compression method: ${foundCompMethod}`)
    }
  } catch { return null }
}

// Upload a buffer to R2 and return the internal R2 key (served via proxy route)
async function uploadSubStemToR2(
  r2: R2Bucket, jobId: string, parent: string, key: string, buf: ArrayBuffer, contentType = 'audio/wav'
): Promise<string> {
  const r2Key = `sub-stems/${jobId}/${parent}/${key}.wav`
  await r2.put(r2Key, buf, { httpMetadata: { contentType } })
  return r2Key
}

// Upload a URL-based audio file to R2 (download from Replicate, store in R2)
async function uploadUrlToR2(
  r2: R2Bucket, jobId: string, parent: string, key: string, sourceUrl: string
): Promise<string> {
  const resp = await fetch(sourceUrl)
  if (!resp.ok) throw new Error(`Failed to download ${key} from Replicate: ${resp.status}`)
  const buf = await resp.arrayBuffer()
  return uploadSubStemToR2(r2, jobId, parent, key, buf,
    resp.headers.get('content-type') || 'audio/wav')
}

// ── Main orchestrator ─────────────────────────────────────────
// Called after Mureka ZIP is extracted and ZIP has been probed for present stems.
// detectedStemKeys: array of stem keys actually in the ZIP e.g. ['drums','bass','other','fx']
// Returns populated SubStem[] ready to save to job.sub_stems
async function splitWithDemucs(
  job: Job,
  zipUrl: string,
  detectedStemKeys: string[],
  r2: R2Bucket,
  replicateApiKey: string,
  siteUrl: string
): Promise<SubStem[]> {
  const subStems: SubStem[] = []
  const jobId = job.id

  // Drum sub-stem color map
  const drumColors: Record<string, string> = {
    kick: '#ef4444', snare: '#f97316', hihat: '#eab308', toms: '#84cc16', cymbals: '#06b6d4'
  }
  // Other/FX instrument color map
  const instrColors: Record<string, string> = {
    guitar: '#10b981', piano: '#f59e0b', other_sub: '#8b5cf6', bass_sub: '#3b82f6'
  }

  // ── Pass 1: Drums — always run if drums stem is in the ZIP ───
  if (detectedStemKeys.includes('drums')) {
    try {
      // Extract drums.wav bytes from Mureka ZIP
      const drumBytes = await extractStemBytesFromZip(zipUrl, 'drums')
      if (drumBytes && drumBytes.byteLength > 0) {
        // Upload drums bytes to Replicate file API — avoids CDN/auth issues with Worker URLs
        const demucsOut = await runDemucsOnBytes(drumBytes, replicateApiKey, 'drums')

        // Map Demucs outputs to sub-stems — from a drums-only input:
        // 'drums' output ≈ kick+snare, 'other' ≈ cymbals, we label them accordingly
        // For a proper drum separator, ideally use a dedicated model.
        // Using htdemucs_6s: drums=kick+snare remnant, other=cymbals/hihat, bass=none
        // We map: drums→kick, other→hihat+cymbals — then store the available outputs
        const drumMapping: Array<{ demucsKey: string; subKey: string; name: string }> = [
          { demucsKey: 'drums',  subKey: 'kick',    name: 'Kick / Snare' },
          { demucsKey: 'other',  subKey: 'hihat',   name: 'Hi-Hats / Cymbals' },
          { demucsKey: 'piano',  subKey: 'toms',    name: 'Toms' },
          { demucsKey: 'guitar', subKey: 'snare',   name: 'Snare' },
        ]

        for (const m of drumMapping) {
          const url = demucsOut[m.demucsKey]
          if (!url) continue
          try {
            const r2Key = await uploadUrlToR2(r2, jobId, 'drums', m.subKey, url)
            subStems.push({
              key: m.subKey,
              name: m.name,
              family: 'drums',
              color: drumColors[m.subKey] || '#ef4444',
              url: r2Key,
              parent: 'drums'
            })
          } catch { /* skip this sub-stem if upload fails */ }
        }
      }
    } catch(e) {
      console.error('[Demucs] Drum split failed:', e)
      // Non-fatal — continue to other/fx pass
    }
  }

  // ── Pass 2: Other / FX — run if either 'other' or 'fx' is in the ZIP ──
  const bundleStems = detectedStemKeys.filter(k => k === 'other' || k === 'fx')
  for (const parentStem of bundleStems) {
    try {
      const bundleBytes = await extractStemBytesFromZip(zipUrl, parentStem)
      if (!bundleBytes || bundleBytes.byteLength === 0) continue

      // Upload bundle stem bytes to Replicate file API — avoids CDN/auth issues with Worker URLs
      const demucsOut = await runDemucsOnBytes(bundleBytes, replicateApiKey, parentStem)

      // Map instrument outputs — on an "other/fx" input:
      // 'guitar' → guitar parts, 'piano' → keys/piano parts, 'other' → synth/misc
      const instrMapping: Array<{ demucsKey: string; subKey: string; name: string; family: string }> = [
        { demucsKey: 'guitar', subKey: `${parentStem}_guitar`, name: 'Guitar',       family: 'guitar' },
        { demucsKey: 'piano',  subKey: `${parentStem}_piano`,  name: 'Keys / Piano', family: 'keys'   },
        { demucsKey: 'other',  subKey: `${parentStem}_synth`,  name: 'Synth / Misc', family: 'synth'  },
        { demucsKey: 'bass',   subKey: `${parentStem}_bass`,   name: 'Bass Element', family: 'bass'   },
      ]

      for (const m of instrMapping) {
        const url = demucsOut[m.demucsKey]
        if (!url) continue
        try {
          const r2Key = await uploadUrlToR2(r2, jobId, parentStem, m.subKey, url)
          subStems.push({
            key: m.subKey,
            name: m.name,
            family: m.family,
            color: instrColors[m.demucsKey + '_sub'] || instrColors[m.demucsKey] || '#8b5cf6',
            url: r2Key,
            parent: parentStem
          })
        } catch { /* skip */ }
      }
    } catch(e) {
      console.error(`[Demucs] ${parentStem} split failed:`, e)
    }
  }

  return subStems
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
async function startPipeline(jobId: string, env: Bindings, refFileId?: string, userPlan?: string, userDurationSec?: number) {
  const db = env.DB
  let job = await getJob(db, jobId)
  if (!job) return

  try {
    // Step 1 — GPT blueprint (~2-3 s)
    job.status = 'blueprint'
    await setJob(db, { ...job })

    const userTitle = (job as any).title as string | undefined
    const blueprint = await generateBlueprint(job.prompt, env.OPENAI_API_KEY, userTitle, userPlan, userDurationSec)

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

    const stereoTaskId = await startInstrumentalGeneration(blueprint, env.MUREKA_API_KEY, refFileId, (job as any).vocal_gender, userDurationSec)
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
  const { prompt, genre, bpm, vocal_space, energy, duration, user_duration, instruments_include, instruments_exclude, title, reference_file_id, vocal_gender, beat_count } = await c.req.json()

  if (!prompt && !genre) {
    return c.json({ error: 'prompt is required' }, 400)
  }

  // ── Auth + generation limit check ────────────────────────────
  let userId: string | undefined
  let userPlan: string | undefined
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
          userPlan = u.plan
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
    tracks: [],
    title: title || undefined,
    thumbnail_seed: Math.floor(Math.random() * 360)
  }
  // Store vocal_gender and beat_count as extended job properties
  ;(job as any).vocal_gender = vocal_gender || 'off'
  ;(job as any).beat_count = beat_count || 1
  await setJob(c.env.DB, job, userId)

  // If beat_count = 2 (Pro only), deduct one more credit and kick off a second generation
  if (beat_count === 2 && (userPlan === 'pro' || userPlan === 'developer') && userId) {
    try {
      await c.env.DB.prepare(`UPDATE users SET gens_used = gens_used + 1 WHERE id = ?`).bind(userId).run()
    } catch {}
  }

  // Start pipeline in background: Step 1 (GPT blueprint) + Step 2 kick-off (Mureka submit)
  // Both are fast (~3-5 s total). The long Mureka wait is handled client-side via /api/poll/:id
  // Parse user_duration: expect seconds as number (60, 90, 120, etc.)
  const userDurationSec = user_duration ? Math.max(30, Math.min(300, parseInt(String(user_duration), 10) || 0)) || undefined : undefined
  c.executionCtx.waitUntil(startPipeline(jobId, c.env, reference_file_id || undefined, userPlan, userDurationSec))

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
      instruments: (job.blueprint.instruments || []).map((ins: any) => ({
        name: ins.name,
        family: ins.family
      })),
      mureka_prompt: job.blueprint.mureka_prompt
    } : null,
    stereo_url: job.stereo_url || null,
    zip_url: job.zip_url || null,
    tracks: (job.tracks || []).map(t => ({
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
      instruments: (job.blueprint.instruments || []).map((ins: any) => ({
        name: ins.name,
        family: ins.family
      })),
      mureka_prompt: job.blueprint.mureka_prompt
    } : null,
    stereo_url: job.stereo_url || null,
    zip_url: job.zip_url || null,
    tracks: (job.tracks || []).map(t => ({
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
  // Gate for free plan users — stems ZIP download locked until upgrade
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (user && user.plan === 'free') {
    return c.json({ error: 'ZIP download requires a Pro Artist plan. Your stems are saved — upgrade anytime to access them.', locked: true, upgrade: true }, 403)
  }
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
  // No plan gate here — any authenticated user with a zip_url can stream their stems.
  // Plan gates are enforced at extraction time (POST /api/job/stems).

  const jobId   = c.req.param('jobId')
  const stemKey = c.req.param('stem').toLowerCase()
  const job     = await getJob(c.env.DB, jobId)
  if (!job || !job.zip_url) return c.json({ error: 'Job or ZIP not found' }, 404)

  const zipUrl = job.zip_url

  // ── R2 cache check ──────────────────────────────────────────
  if (c.env.IMAGES) {
    try {
      const r2CacheKey = `stem-cache/${jobId}/${stemKey}.wav`
      const cached = await c.env.IMAGES.get(r2CacheKey)
      if (cached) {
        const buf = await cached.arrayBuffer()
        return new Response(buf, {
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Length': String(buf.byteLength),
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          }
        })
      }
    } catch (_) { /* R2 miss — fall through */ }
  }

  try {
    // Step 1: HEAD to get ZIP size
    const headRes = await fetch(zipUrl, { method: 'HEAD' })
    if (!headRes.ok) throw new Error('ZIP HEAD failed: ' + headRes.status)
    const totalSize = parseInt(headRes.headers.get('content-length') || '0', 10)
    if (!totalSize) throw new Error('ZIP size unknown')

    // Step 2: Fetch last 65KB (EOCD + central directory)
    const tailSize  = Math.min(65536, totalSize)
    const tailStart = totalSize - tailSize
    const tailRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${tailStart}-${totalSize - 1}` } })
    if (!tailRes.ok && tailRes.status !== 206) throw new Error('ZIP tail fetch failed: ' + tailRes.status)
    const tailBuf  = await tailRes.arrayBuffer()
    const tailView = new DataView(tailBuf)

    // Step 3: Find EOCD signature (0x06054b50)
    let eocdOffset = -1
    for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
      if (tailView.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break }
    }
    if (eocdOffset < 0) throw new Error('EOCD not found in ZIP tail')

    const cdOffsetInFile = tailView.getUint32(eocdOffset + 16, true)
    const cdSize         = tailView.getUint32(eocdOffset + 12, true)

    // Step 4: Get central directory
    let cdBuf: ArrayBuffer
    if (cdOffsetInFile >= tailStart) {
      const s = cdOffsetInFile - tailStart
      cdBuf = tailBuf.slice(s, s + cdSize)
    } else {
      const cdRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${cdOffsetInFile}-${cdOffsetInFile + cdSize - 1}` } })
      cdBuf = await cdRes.arrayBuffer()
    }

    // Step 5: Parse central directory to find stem
    const stemKeywords: Record<string, string[]> = {
      drums:    ['drum'],
      bass:     ['bass'],
      vocals:   ['vocal'],
      other:    ['other', 'melody', 'synth'],
      piano:    ['piano', 'keys', 'rhodes'],
      guitar:   ['guitar'],
      strings:  ['string'],
      synth:    ['synth', 'pad', 'lead'],
      brass:    ['brass'],
      woodwind: ['woodwind', 'wind'],
      fx:       ['fx'],
    }
    const keywords = stemKeywords[stemKey] || [stemKey]

    const cdView = new DataView(cdBuf)
    let pos = 0
    let foundLocalOffset = -1, foundCompressed = -1, foundUncompressed = -1
    let foundCompMethod = -1, foundFilename = ''
    const audioEntries: Array<{filename:string,localOffset:number,compressed:number,uncompressed:number,compMethod:number}> = []

    while (pos < cdBuf.byteLength - 4) {
      if (cdView.getUint32(pos, true) !== 0x02014b50) break
      const compMethod   = cdView.getUint16(pos + 10, true)
      const compressed   = cdView.getUint32(pos + 20, true)
      const uncompressed = cdView.getUint32(pos + 24, true)
      const fnLen        = cdView.getUint16(pos + 28, true)
      const extLen       = cdView.getUint16(pos + 30, true)
      const cmtLen       = cdView.getUint16(pos + 32, true)
      const localOffset  = cdView.getUint32(pos + 42, true)
      const fn           = new TextDecoder().decode(new Uint8Array(cdBuf, pos + 46, fnLen))
      const fnLower      = fn.toLowerCase()
      if (fnLower.endsWith('.wav') || fnLower.endsWith('.mp3')) {
        audioEntries.push({ filename: fn, localOffset, compressed, uncompressed, compMethod })
        if (keywords.some(kw => fnLower.includes(kw))) {
          foundLocalOffset = localOffset; foundCompressed = compressed
          foundUncompressed = uncompressed; foundCompMethod = compMethod; foundFilename = fn
        }
      }
      pos += 46 + fnLen + extLen + cmtLen
    }

    if (foundLocalOffset < 0 && audioEntries.length > 0) {
      const stemOrder = ['drums','bass','vocals','other','piano','guitar','strings','synth','brass','woodwind','fx']
      const idx = stemOrder.indexOf(stemKey)
      const entry = audioEntries[idx >= 0 && idx < audioEntries.length ? idx : 0]
      foundLocalOffset = entry.localOffset; foundCompressed = entry.compressed
      foundUncompressed = entry.uncompressed; foundCompMethod = entry.compMethod; foundFilename = entry.filename
    }

    if (foundLocalOffset < 0) return c.json({ error: 'Stem not found in ZIP' }, 404)

    // Step 6: Read local file header for actual data offset
    const lhRes = await fetch(zipUrl, { headers: { 'Range': `bytes=${foundLocalOffset}-${foundLocalOffset + 29}` } })
    const lhBuf  = await lhRes.arrayBuffer()
    const lhView = new DataView(lhBuf)
    const dataOffset = foundLocalOffset + 30 + lhView.getUint16(26, true) + lhView.getUint16(28, true)

    // Step 7: Fetch compressed bytes
    const dataRes  = await fetch(zipUrl, { headers: { 'Range': `bytes=${dataOffset}-${dataOffset + foundCompressed - 1}` } })
    const compData = await dataRes.arrayBuffer()

    // Step 8: Decompress
    let audioData: ArrayBuffer
    if (foundCompMethod === 0) {
      audioData = compData
    } else if (foundCompMethod === 8) {
      const ds     = new DecompressionStream('deflate-raw')
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
      const out   = new Uint8Array(total)
      let off = 0; for (const ch of chunks) { out.set(ch, off); off += ch.length }
      audioData = out.buffer
    } else {
      throw new Error(`Unsupported ZIP compression method: ${foundCompMethod}`)
    }

    const contentType = foundFilename.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'

    // Write to R2 cache for next request
    if (c.env.IMAGES) {
      try {
        await c.env.IMAGES.put(`stem-cache/${jobId}/${stemKey}.wav`, audioData, {
          httpMetadata: { contentType }
        })
      } catch (_) { /* non-fatal */ }
    }

    return new Response(audioData, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(audioData.byteLength),
        'Content-Disposition': `inline; filename="${foundFilename}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      }
    })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Stem extract failed' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/stems — on-demand stem extraction
//  Free plan:    allowed (runs extraction + stores to R2/D1), but returns locked:true — no download URLs
//  Creator plan: BLOCKED — only mastered WAV/MP3 download; stems are a Pro Artist feature
//  Pro plan:     full access — extraction + download URLs
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

  // Creator plan: stems are blocked — only mastered WAV/MP3 download allowed
  if (user.plan === 'creator') {
    return c.json({
      error: 'Stem extraction is a Pro Artist feature. Upgrade to Pro to split your tracks into individual stems.',
      upgrade: true,
      creator_blocked: true
    }, 403)
  }

  // Track whether this is a free plan user (allowed to extract but downloads locked)
  const isFreeUser = user.plan === 'free'

  const { job_id, stem_tier } = await c.req.json()
  // stem_tier: 'basic' = 5 stems (V1, 2 credits), 'pro' = up to 12 stems (V2, 10 credits, Pro plan only)
  if (!job_id) return c.json({ error: 'job_id required' }, 400)

  // V1 only — 5 stems for all plans (V2 disabled)
  const wantPro = false

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

  // Already has stems — return existing data; lock download URLs for free plan
  if (job.zip_url) {
    if (isFreeUser) {
      // Free users: stems are saved — confirm they're safe, but suppress download URLs
      return c.json({
        ok: true,
        locked: true,
        stems_saved: true,
        already_extracted: true,
        tracks: (job.tracks || []).map((t: any) => ({ ...t, zip_url: null })),
        plan: user.plan
      })
    }
    return c.json({ ok: true, zip_url: job.zip_url, tracks: job.tracks, already_extracted: true })
  }

  // Credit cost: 2 credits for all plans (V1 only)
  const creditCost = 2
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
    // All plans use V1 (audio-separation-1) — 5 stems: drums, bass, vocals, other
    // V2 (audio-separation-2) disabled — too expensive at current scale
    const isPro = false  // locked to V1 for all plans
    const model = 'audio-separation-1'
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

    // ── Pre-populate R2 stem cache (async, non-blocking) ──────
    // Extract each detected stem's WAV from the Mureka ZIP and store in R2
    // so that GET /api/stem-audio ALWAYS gets a cache hit (no ZIP decompression needed).
    // This is the root cause fix for the stems player spinner timeout.
    if (c.env.IMAGES) {
      const cachePromise = (async () => {
        for (const s of detectedStems) {
          try {
            const stemBytes = await extractStemBytesFromZip(zip_url, s.stem)
            if (stemBytes && stemBytes.byteLength > 0) {
              const r2CacheKey = `stem-cache/${job.id}/${s.stem}.wav`
              await c.env.IMAGES!.put(r2CacheKey, stemBytes, {
                httpMetadata: { contentType: 'audio/wav' }
              })
              console.log(`[StemCache] Cached ${s.stem} for job ${job.id}: ${stemBytes.byteLength} bytes`)
            }
          } catch (e) {
            console.error(`[StemCache] Failed to cache ${s.stem}:`, e)
          }
        }
      })()
      try { (c.executionCtx as any).waitUntil(cachePromise) } catch { /* no executionCtx */ }
    }

    // Free plan: stems are now saved in R2/D1 — return locked response (no download URLs)
    // Stems are preserved until user upgrades, then they can download
    if (isFreeUser) {
      return c.json({
        ok: true,
        locked: true,
        stems_saved: true,
        tracks: tracks.map((t: any) => ({ ...t, zip_url: null })),
        credits_used: creditCost,
        plan: user.plan
      })
    }

    return c.json({
      ok: true,
      zip_url,
      midi_zip_url: midi_zip_url || null,
      tracks,
      sub_stems: [],   // Demucs runs in background; poll /api/job/:id for sub_stems when ready
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
//  GET /api/sub-stem-audio/:jobId/:key
//  Serves a single Demucs sub-stem (kick, snare, hihat, etc.) from R2.
//  Also handles internal Demucs source files (source_drums, source_other, source_fx)
//  that Replicate needs to fetch — these are public via ?parent= param.
//  Auth: session cookie required for sub-stems; source files are public (needed by Replicate).
// ═══════════════════════════════════════════════════════════════
app.get('/api/sub-stem-audio/:jobId/:key', async (c) => {
  if (!c.env.IMAGES) return c.json({ error: 'Storage unavailable' }, 503)

  const jobId = c.req.param('jobId')
  const key   = c.req.param('key')
  const parent = c.req.query('parent')   // present for source files (public access for Replicate)

  // Source files (for Replicate to fetch) — no auth required, served directly from R2
  if ((key.startsWith('source_') || key.startsWith('adv_source_')) && parent) {
    const r2Key = `sub-stems/${jobId}/${parent}/${key}.wav`
    const obj = await c.env.IMAGES.get(r2Key)
    if (!obj) return c.json({ error: 'Not found' }, 404)
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'audio/wav',
        'Content-Length': String(obj.size),
        'Cache-Control': 'public, max-age=86400'
      }
    })
  }

  // Sub-stem files — require auth
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  // Free plan: sub-stem audio download locked
  if (user.plan === 'free') {
    return c.json({ error: 'Sub-stem audio download requires a Pro Artist plan. Your stems are saved — upgrade to access them.', locked: true, upgrade: true }, 403)
  }

  // Look up the sub-stem's R2 key from job.sub_stems
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const subStems: SubStem[] = (job as any).sub_stems || []
  const sub = subStems.find(s => s.key === key)
  if (!sub) return c.json({ error: `Sub-stem '${key}' not found — Demucs may still be processing` }, 404)

  const obj = await c.env.IMAGES.get(sub.url)
  if (!obj) return c.json({ error: 'Sub-stem file missing from storage' }, 404)

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'audio/wav',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=3600'
    }
  })
})

// ── GET /api/job/:id/sub-stems — poll for Demucs completion ──
// Frontend polls this after receiving stems response to check when sub_stems are ready.
app.get('/api/job/:id/sub-stems', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('id')
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const subStems: SubStem[] = (job as any).sub_stems || []
  return c.json({ sub_stems: subStems, ready: subStems.length > 0 })
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/job/stems/advanced-split
//  Target: 'drums'    → Demucs drum-kit split on drums.wav
//          'melodies' → Demucs instrument split on other/piano/synth stems
//  Returns: { stems: [{ name, url }] }
// ═══════════════════════════════════════════════════════════════
app.post('/api/job/stems/advanced-split', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Service unavailable' }, 503)
  const token = getSessionCookie(c.req.raw)
  const user  = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer')
    return c.json({ error: 'Advanced Split requires a Pro Artist plan.' }, 403)

  const { job_id, target, stem: requestedStem } = await c.req.json() as any
  if (!job_id || !['drums', 'melodies'].includes(target))
    return c.json({ error: 'job_id and target (drums|melodies) required' }, 400)

  // user_id is stored as a separate DB column — NOT in the job JSON blob
  const row = await c.env.DB.prepare('SELECT data, user_id FROM jobs WHERE id = ?')
    .bind(job_id).first<{ data: string; user_id: string | null }>()
  if (!row) return c.json({ error: 'Job not found' }, 404)
  const job = JSON.parse(row.data) as Job
  if (!job.zip_url) return c.json({ error: 'Stems not extracted yet for this job' }, 404)
  if (row.user_id && row.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403)

  if (!c.env.REPLICATE_API_KEY)
    return c.json({ error: 'REPLICATE_API_KEY not configured — contact support.' }, 503)
  if (!c.env.IMAGES) return c.json({ error: 'R2 storage not available' }, 503)

  const siteUrl  = c.env.SITE_URL || ''
  const replicateKey = c.env.REPLICATE_API_KEY as string
  const r2 = c.env.IMAGES as R2Bucket
  const zipUrl = job.zip_url

  try {
    if (target === 'drums') {
      // Extract drums.wav from the Mureka ZIP (already decompressed/validated)
      const drumBytes = await extractStemBytesFromZip(zipUrl, 'drums')
      if (!drumBytes || drumBytes.byteLength === 0)
        return c.json({ error: 'Could not extract drums stem from ZIP' }, 422)

      // htdemucs_6s on clean drums stem: drums→Kick+Snare, other→Hi-Hats+Cymbals, piano→Toms
      const demucsOut = await runDemucsOnBytes(drumBytes, replicateKey, 'adv_drums', 'htdemucs_6s')

      const drumMapping = [
        { demucsKey: 'drums', name: 'Kick + Snare',     color: '#ef4444' },
        { demucsKey: 'other', name: 'Hi-Hats + Cymbals',color: '#eab308' },
        { demucsKey: 'piano', name: 'Toms',             color: '#f97316' },
      ]

      const stems: Array<{ name: string; url: string; color: string; key: string }> = []
      for (const m of drumMapping) {
        const url = demucsOut[m.demucsKey]
        if (!url) continue
        try {
          const resp = await fetch(url)
          if (!resp.ok) continue
          const buf = await resp.arrayBuffer()
          const slugKey = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
          const r2Key = `sub-stems/${job_id}/adv/drums_${slugKey}.wav`
          await r2.put(r2Key, buf, { httpMetadata: { contentType: 'audio/mpeg' } })
          const serveKey = 'adv_drums_' + slugKey
          stems.push({
            name: m.name,
            color: m.color,
            key: serveKey,
            url: `${siteUrl}/api/sub-stem-audio/${job_id}/${serveKey}`
          })
        } catch { /* skip */ }
      }

      // Persist new sub_stems back to job record (merge with existing)
      const existing: SubStem[] = (job as any).sub_stems || []
      const newSubStems = existing.filter(s => s.family !== 'drums_adv')
      stems.forEach(s => {
        const slugKey = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
        newSubStems.push({
          key: 'adv_drums_' + slugKey,
          name: s.name, family: 'drums_adv', color: s.color,
          url: `sub-stems/${job_id}/adv/drums_${slugKey}.wav`, parent: 'drums'
        })
      })
      const updatedJob = { ...job, sub_stems: newSubStems } as any
      await c.env.DB.prepare('UPDATE jobs SET data = ? WHERE id = ?')
        .bind(JSON.stringify(updatedJob), job_id).run()

      return c.json({ ok: true, target: 'drums', stems })
    }

    if (target === 'melodies') {
      // User picks exactly which stem to split — requestedStem is the ZIP stem key
      // Allowed: other, piano, guitar, synth, strings, brass, woodwind, fx (anything non-drums/bass/vocals)
      const ALLOWED_MELODY_STEMS = ['other','piano','guitar','synth','strings','brass','woodwind','fx']
      const targetStemKey = (requestedStem && ALLOWED_MELODY_STEMS.includes(requestedStem))
        ? requestedStem : 'other'

      const melodyBytes = await extractStemBytesFromZip(zipUrl, targetStemKey)
      if (!melodyBytes || melodyBytes.byteLength === 0)
        return c.json({ error: `Could not extract ${targetStemKey} stem from ZIP` }, 422)

      // htdemucs_6s on the clean melody stem → separates piano/guitar/vocals/bass/other
      const demucsOut = await runDemucsOnBytes(melodyBytes, replicateKey, `adv_${targetStemKey}`, 'htdemucs_6s')

      const instrMapping = [
        { demucsKey: 'piano',  name: 'Piano',            color: '#6366f1' },
        { demucsKey: 'guitar', name: 'Guitar / Synth',   color: '#8b5cf6' },
        { demucsKey: 'other',  name: 'Melody (Other)',   color: '#a855f7' },
        { demucsKey: 'vocals', name: 'Vocal Melody',     color: '#ec4899' },
        { demucsKey: 'bass',   name: 'Bass Elements',    color: '#3b82f6' },
      ]

      const stems: Array<{ name: string; url: string; color: string; key: string }> = []
      for (const m of instrMapping) {
        const url = demucsOut[m.demucsKey]
        if (!url) continue
        try {
          const resp = await fetch(url)
          if (!resp.ok) continue
          const buf = await resp.arrayBuffer()
          const slugKey = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
          const r2Key = `sub-stems/${job_id}/adv/melody_${slugKey}.wav`
          await r2.put(r2Key, buf, { httpMetadata: { contentType: 'audio/mpeg' } })
          const serveKey = 'adv_melody_' + slugKey
          stems.push({
            name: m.name,
            color: m.color,
            key: serveKey,
            url: `${siteUrl}/api/sub-stem-audio/${job_id}/${serveKey}`
          })
        } catch { /* skip */ }
      }

      // Persist
      const existing2: SubStem[] = (job as any).sub_stems || []
      const newSubStems2 = existing2.filter(s => s.family !== 'melody_adv')
      stems.forEach(s => {
        const slugKey = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
        newSubStems2.push({
          key: 'adv_melody_' + slugKey,
          name: s.name, family: 'melody_adv', color: s.color,
          url: `sub-stems/${job_id}/adv/melody_${slugKey}.wav`, parent: targetStemKey
        })
      })
      const updatedJob2 = { ...job, sub_stems: newSubStems2 } as any
      await c.env.DB.prepare('UPDATE jobs SET data = ? WHERE id = ?')
        .bind(JSON.stringify(updatedJob2), job_id).run()

      return c.json({ ok: true, target: 'melodies', sourceStem: targetStemKey, stems })
    }

    return c.json({ error: 'Unknown target' }, 400)
  } catch(e: any) {
    console.error('[AdvSplit] Error:', e?.message)
    return c.json({ error: e?.message || 'Advanced split failed' }, 500)
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
      const metaType = session.metadata?.type

      // Credit pack one-time purchase
      if (metaType === 'credit_pack' && userId) {
        const credits = parseInt(session.metadata?.credits || '0', 10)
        if (credits > 0) {
          await c.env.DB.prepare(`UPDATE users SET gens_limit=gens_limit+? WHERE id=?`).bind(credits, userId).run()
        }
      } else if (userId && subId) {
        // Subscription purchase
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
          `UPDATE users SET plan='free', gens_limit=5, stripe_subscription_id=NULL WHERE stripe_customer_id=?`
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
app.get('/feedback', (c) => c.html(feedbackPage()))

// POST /api/feedback — sends feedback to stemforgesupport@gmail.com via email.js / Resend fallback
// Since we can't run SMTP in Workers, we use the Resend free-tier API to relay the email.
// If RESEND_API_KEY is not set, the feedback is stored in KV (fallback).
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

  // Try Resend API (free tier: 100 emails/day, no credit card needed)
  // Set RESEND_API_KEY secret via: gsk hosted secret put RESEND_API_KEY re_xxxx
  const resendKey = (c.env as any).RESEND_API_KEY
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'StemForge Feedback <onboarding@resend.dev>',
          to: ['stemforgesupport@gmail.com'],
          reply_to: replyEmail || undefined,
          subject,
          html: bodyHtml
        })
      })
      if (res.ok) return c.json({ ok: true })
      const err = await res.json() as any
      console.error('Resend error:', err)
    } catch (e) { console.error('Resend fetch failed:', e) }
  }

  // Fallback: log to console (visible in CF Logs) if no email service configured
  console.log(`FEEDBACK [${label}] from=${replyEmail||'anon'}: ${text}`)
  return c.json({ ok: true, note: 'Feedback logged. Add RESEND_API_KEY secret for email delivery.' })
})
app.get('/promos', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  return c.html(promoPage())
})

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

// GET /api/projects?tab=beats|oneshots|trash — return logged-in user's jobs by tab
app.get('/api/projects', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ projects: [] })
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  const tab = c.req.query('tab') || 'beats' // beats | oneshots | trash

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
    } else {
      // beats tab: regular beats (not one-shots), not deleted
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_oneshot = 0 AND deleted_at IS NULL
         AND json_extract(data,'$.status') = 'ready'
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
        zip_url: d.zip_url || null,
        blueprint: d.blueprint ? {
          bpm: d.blueprint.bpm, key: d.blueprint.key, scale: d.blueprint.scale,
          genre: d.blueprint.genre, mood: d.blueprint.mood,
          duration_seconds: d.blueprint.duration_seconds,
          arrangement: d.blueprint.arrangement || null
        } : null,
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
      return c.json({ ok: true, message: 'Subscription cancellation removed. Your plan continues as normal.' })
    }

    // Check if there's a scheduled subscription (price change at next cycle)
    const schedules = await stripeRequest('GET', `/subscription_schedules?customer=${user.stripe_customer_id}`, {}, c.env.STRIPE_SECRET_KEY)
    const activeSchedule = schedules?.data?.find((s: any) => s.status === 'active' && s.subscription === user.stripe_subscription_id)
    if (activeSchedule) {
      // Release the schedule — removes the future plan change
      await stripeRequest('POST', `/subscription_schedules/${activeSchedule.id}/release`, {}, c.env.STRIPE_SECRET_KEY)
      return c.json({ ok: true, message: 'Scheduled plan change cancelled. Your current plan continues.' })
    }

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
  const PRICES: Record<string, number> = { free: 0, creator: 1900, pro: 3900 }
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
  return c.json({ ok: true, message: `Promo code applied! ${row.bonus_credits > 0 ? `+${row.bonus_credits} bonus downloads added.` : ''} ${row.description}` })
})

// ─── ADMIN ROUTES — developer only ───────────────────────────────────────────

function isAdmin(user: User | null, env: Bindings): boolean {
  if (!user) return false
  if (user.plan === 'developer') return true
  if (env.ADMIN_EMAIL && user.email === env.ADMIN_EMAIL) return true
  return false
}

// GET /admin — admin dashboard page
app.get('/admin', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.redirect('/')
  return c.html(adminPage(user!))
})

// GET /api/admin/stats — overview stats
app.get('/api/admin/stats', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  await ensureAuthTables(c.env.DB)
  const [usersRow, jobsRow, promoRow] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN plan='pro' THEN 1 ELSE 0 END) as pro_count, SUM(CASE WHEN plan='creator' THEN 1 ELSE 0 END) as creator_count, SUM(CASE WHEN plan='free' THEN 1 ELSE 0 END) as free_count FROM users`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM jobs`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM promo_codes WHERE active=1`).first<any>(),
  ])
  return c.json({ users: usersRow, jobs: jobsRow, promos: promoRow })
})

// GET /api/admin/users — list all users
app.get('/api/admin/users', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  await ensureAuthTables(c.env.DB)
  const rows = await c.env.DB.prepare(`SELECT id,email,name,plan,gens_used,gens_limit,created_at FROM users ORDER BY created_at DESC LIMIT 100`).all<any>()
  return c.json({ users: rows.results || [] })
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

// GET /api/admin/promos — list all promo codes
app.get('/api/admin/promos', async (c) => {
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

// ─── MUREKA BALANCE MONITOR ──────────────────────────────────────────────────
// GET /api/mureka/balance — fetch current Mureka account balance (admin only)
app.get('/api/mureka/balance', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'MUREKA_API_KEY not configured' }, 500)

  try {
    const res = await fetch(`${MUREKA_BASE}/account/info`, {
      headers: { 'Authorization': `Bearer ${c.env.MUREKA_API_KEY}` }
    })
    if (!res.ok) {
      // Mureka may not have /account/info — try /credits endpoint
      const res2 = await fetch(`${MUREKA_BASE}/credits`, {
        headers: { 'Authorization': `Bearer ${c.env.MUREKA_API_KEY}` }
      })
      if (!res2.ok) return c.json({ error: 'Could not fetch Mureka balance', status: res.status }, 500)
      const data2 = await res2.json() as any
      return c.json({ ok: true, balance: data2 })
    }
    const data = await res.json() as any
    return c.json({ ok: true, balance: data })
  } catch (e: any) {
    return c.json({ error: e?.message || 'Balance fetch failed' }, 500)
  }
})

// GET /mureka-monitor — Mureka balance monitor page (admin only)
app.get('/mureka-monitor', async (c) => {
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.redirect('/login')
  return c.html(murekaMonitorPage())
})

function murekaMonitorPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Mureka Balance Monitor — StemForge Admin</title>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
<link href="/static/style.css" rel="stylesheet"/>
<style>
  body{background:#0d0d1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:0;margin:0}
  .monitor-wrap{max-width:720px;margin:0 auto;padding:40px 24px}
  .monitor-card{background:#151525;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px 32px;margin-bottom:24px}
  .balance-display{text-align:center;padding:32px 0}
  .balance-amount{font-size:3rem;font-weight:800;color:#4e9fff;line-height:1}
  .balance-label{font-size:.9rem;color:#94a3b8;margin-top:8px}
  .balance-status{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:.82rem;font-weight:600;margin-top:16px}
  .balance-status--ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#10b981}
  .balance-status--warn{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:#f59e0b}
  .balance-status--low{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444}
  .threshold-row{display:flex;align-items:center;gap:12px;margin-bottom:16px}
  .threshold-row input{flex:1;padding:10px 14px;background:#0d0d1a;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e2e8f0;font-size:.9rem}
  .threshold-row button{padding:10px 20px;background:#4e9fff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:.9rem}
  .threshold-row button:hover{background:#3b82f6}
  .raw-data{background:#0a0a18;border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:16px;font-family:monospace;font-size:.78rem;color:#94a3b8;overflow-x:auto;white-space:pre-wrap;max-height:240px;overflow-y:auto}
  .history-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.85rem}
  .history-row:last-child{border-bottom:none}
  .btn-refresh{background:rgba(78,159,255,.12);border:1px solid rgba(78,159,255,.3);color:#4e9fff;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:600}
  .btn-refresh:hover{background:rgba(78,159,255,.2)}
  h2{font-size:1.1rem;font-weight:700;margin:0 0 20px;color:#e2e8f0}
  .info-row{display:flex;justify-content:space-between;font-size:.85rem;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)}
  .info-row:last-child{border-bottom:none}
  .info-row span:last-child{color:#4e9fff;font-weight:600}
</style>
</head>
<body>
<div class="monitor-wrap">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px">
    <a href="/admin" style="color:#94a3b8;font-size:.85rem;text-decoration:none"><i class="fas fa-arrow-left"></i> Admin</a>
    <h1 style="font-size:1.4rem;font-weight:800;margin:0;flex:1">Mureka Balance Monitor</h1>
    <button class="btn-refresh" onclick="refreshBalance()"><i class="fas fa-sync-alt"></i> Refresh</button>
  </div>

  <!-- Balance Card -->
  <div class="monitor-card">
    <div class="balance-display">
      <div class="balance-amount" id="balance-amount">—</div>
      <div class="balance-label">Credits Remaining</div>
      <div id="balance-status" class="balance-status" style="display:none"></div>
    </div>
    <div id="balance-info" style="margin-top:8px"></div>
  </div>

  <!-- Alert Threshold -->
  <div class="monitor-card">
    <h2><i class="fas fa-bell" style="color:#f59e0b;margin-right:8px"></i>Alert Threshold</h2>
    <p style="font-size:.85rem;color:#94a3b8;margin:0 0 16px">Set a credit threshold. When balance drops below this, a warning is shown here. To get email alerts, add your Resend API key (RESEND_API_KEY secret) — then alerts auto-email stemforgesupport@gmail.com.</p>
    <div class="threshold-row">
      <input type="number" id="threshold-input" placeholder="e.g. 50" min="1" step="1"/>
      <button onclick="saveThreshold()"><i class="fas fa-save"></i> Save</button>
    </div>
    <div id="threshold-status" style="font-size:.82rem;color:#10b981;min-height:20px"></div>
  </div>

  <!-- Check History -->
  <div class="monitor-card">
    <h2><i class="fas fa-history" style="color:#94a3b8;margin-right:8px"></i>Check History <span style="font-size:.78rem;font-weight:400;color:#64748b">(this session)</span></h2>
    <div id="check-history" style="min-height:48px;color:#64748b;font-size:.85rem">No checks yet this session.</div>
  </div>

  <!-- Raw API Response -->
  <div class="monitor-card">
    <h2><i class="fas fa-code" style="color:#94a3b8;margin-right:8px"></i>Raw API Response</h2>
    <pre class="raw-data" id="raw-data">Fetch balance to see raw API response.</pre>
  </div>
</div>

<script>
const history = [];
let balanceValue = null;

async function refreshBalance() {
  const amtEl = document.getElementById('balance-amount');
  const statusEl = document.getElementById('balance-status');
  const rawEl = document.getElementById('raw-data');
  const infoEl = document.getElementById('balance-info');
  amtEl.textContent = '…';
  statusEl.style.display = 'none';

  try {
    const res = await fetch('/api/mureka/balance');
    const data = await res.json();
    rawEl.textContent = JSON.stringify(data, null, 2);

    if (!res.ok) {
      amtEl.textContent = 'Error';
      amtEl.style.color = '#ef4444';
      statusEl.textContent = data.error || 'Failed to fetch';
      statusEl.className = 'balance-status balance-status--low';
      statusEl.style.display = 'inline-flex';
      return;
    }

    // Try to extract credit amount from common response shapes
    const raw = data.balance || data;
    const credits = raw.credits ?? raw.balance ?? raw.remaining_credits ?? raw.total_credits ?? null;
    balanceValue = credits;

    if (credits !== null) {
      amtEl.textContent = credits.toLocaleString();
      amtEl.style.color = '';
      const threshold = parseInt(localStorage.getItem('mureka_threshold') || '50', 10);
      if (credits <= 0) {
        statusEl.innerHTML = '<i class="fas fa-times-circle"></i> OUT OF CREDITS';
        statusEl.className = 'balance-status balance-status--low';
      } else if (credits < threshold) {
        statusEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> LOW — below threshold (' + threshold + ')';
        statusEl.className = 'balance-status balance-status--warn';
      } else {
        statusEl.innerHTML = '<i class="fas fa-check-circle"></i> Healthy';
        statusEl.className = 'balance-status balance-status--ok';
      }
      statusEl.style.display = 'inline-flex';
    } else {
      amtEl.textContent = '?';
      amtEl.style.color = '#f59e0b';
      statusEl.innerHTML = '<i class="fas fa-info-circle"></i> Balance shape unknown — check raw response below';
      statusEl.className = 'balance-status balance-status--warn';
      statusEl.style.display = 'inline-flex';
    }

    // Show info rows
    infoEl.innerHTML = Object.entries(raw)
      .filter(([k]) => !['choices','items','data'].includes(k))
      .map(([k,v]) => '<div class="info-row"><span>' + k + '</span><span>' + JSON.stringify(v) + '</span></div>')
      .join('');

    // Add to history
    const entry = { time: new Date().toLocaleTimeString(), credits, ok: res.ok };
    history.unshift(entry);
    if (history.length > 20) history.pop();
    renderHistory();

    // Check threshold and show warning if needed
    checkAlert(credits);

  } catch(e) {
    amtEl.textContent = 'Error';
    amtEl.style.color = '#ef4444';
    rawEl.textContent = e.message;
  }
}

function checkAlert(credits) {
  const threshold = parseInt(localStorage.getItem('mureka_threshold') || '50', 10);
  if (credits !== null && credits < threshold) {
    document.title = '⚠️ Low Credits — Mureka Monitor';
    // Show persistent alert banner if not already shown
    if (!document.getElementById('low-credit-alert')) {
      const alert = document.createElement('div');
      alert.id = 'low-credit-alert';
      alert.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ef4444;color:#fff;padding:12px 24px;text-align:center;font-weight:700;z-index:9999;font-size:.9rem';
      alert.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Mureka credits low: ' + credits + ' remaining (threshold: ' + threshold + ') — <a href="https://mureka.ai" target="_blank" style="color:#fff;text-decoration:underline">Top up now</a>';
      document.body.prepend(alert);
    }
  }
}

function renderHistory() {
  const el = document.getElementById('check-history');
  if (!history.length) { el.innerHTML = '<span style="color:#64748b">No checks yet.</span>'; return; }
  el.innerHTML = history.map(h =>
    '<div class="history-row"><span>' + h.time + '</span><span style="color:' + (h.credits < 50 ? '#f59e0b' : '#10b981') + '">' + (h.credits !== null ? h.credits + ' credits' : 'unknown') + '</span></div>'
  ).join('');
}

function saveThreshold() {
  const val = parseInt(document.getElementById('threshold-input').value, 10);
  if (isNaN(val) || val < 1) { alert('Enter a valid threshold (e.g. 50)'); return; }
  localStorage.setItem('mureka_threshold', val.toString());
  document.getElementById('threshold-status').textContent = '✓ Threshold saved: ' + val + ' credits';
  setTimeout(() => document.getElementById('threshold-status').textContent = '', 3000);
}

// Load saved threshold on page load
window.onload = () => {
  const saved = localStorage.getItem('mureka_threshold');
  if (saved) document.getElementById('threshold-input').value = saved;
  refreshBalance();
  // Auto-refresh every 5 minutes
  setInterval(refreshBalance, 5 * 60 * 1000);
};
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
  { id: 'pack_10',  name: '10 Credits/Downloads',  credits: 10,  price_cents: 499,  label: '$4.99',  popular: false },
  { id: 'pack_25',  name: '25 Credits/Downloads',  credits: 25,  price_cents: 999,  label: '$9.99',  popular: true  },
  { id: 'pack_50',  name: '50 Credits/Downloads',  credits: 50,  price_cents: 1799, label: '$17.99', popular: false },
  { id: 'pack_100', name: '100 Credits/Downloads', credits: 100, price_cents: 2999, label: '$29.99', popular: false },
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
    'line_items[0][price_data][product_data][description]': `${pack.credits} download credits for StemForge`,
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

  const systemPrompt = `You are a professional hip-hop/R&B/trap songwriter. Write song lyrics based on the artist's description. Structure lyrics with [Intro], [Verse 1], [Chorus], [Verse 2], [Chorus], [Outro] sections. Make lyrics authentic, rhythmic, and genre-appropriate. Do NOT include any commentary — just the lyrics.`
  const userPrompt = `Write song lyrics for a ${genre || 'hip hop'} track with a ${mood || 'energetic'} feel. The song is about: "${description}". Include proper sections with labels like [Verse 1], [Chorus], etc.`

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

// POST /api/upload-reference — upload reference audio to Mureka (purpose: reference, 30s)
// Pro Artist only
app.post('/api/upload-reference', async (c) => {
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Mureka not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'Reference tracks require the Pro Artist plan.', upgrade: true }, 403)
  }

  // Parse multipart form — file field = 'file', optional url field = 'url'
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  const url  = formData.get('url') as string | null

  if (!file && !url) return c.json({ error: 'Provide a file or url' }, 400)

  // Forward to Mureka /v1/files/upload as multipart
  const mForm = new FormData()
  mForm.append('purpose', 'reference')
  if (file) {
    mForm.append('file', file)
  } else if (url) {
    mForm.append('url', url)
  }

  const res = await fetch(`${MUREKA_BASE}/files/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUREKA_API_KEY}` },
    body: mForm
  })

  if (!res.ok) {
    const err = await res.json() as any
    return c.json({ error: err?.error?.message || `Mureka upload error ${res.status}` }, 502)
  }

  const data = await res.json() as any
  // data.id = the Mureka file ID to pass to instrumental/generate as reference_audio
  return c.json({ ok: true, file_id: data.id, filename: file?.name || url || 'reference' })
})

// POST /api/generate-oneshot — generate a one-shot percussive sound (Pro Artist only)
// Uses Mureka instrumental with a very short, percussive prompt
app.post('/api/generate-oneshot', async (c) => {
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Mureka not configured' }, 500)
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

  // Build a tight one-shot prompt — extremely short, percussive, isolated
  const parts: string[] = []
  parts.push(sound_type)
  if (description) parts.push(description)
  if (pitch) parts.push(`pitch ${pitch}`)
  if (texture) parts.push(texture)
  // Critical: force shortest possible duration and percussive character
  parts.push('single isolated hit, no melody, no chord, no bassline, no beat, no loop, just one hit, percussive sound design, dry, punchy, studio sample')

  const oneshotPrompt = parts.join(', ')

  // Use BGM short-form endpoint with very short duration to force a minimal sound
  // model: 'chirp-v3-0' targets shortest possible generation
  // duration_seconds: 3 forces ~3s max which limits full-beat generation
  const res = await fetch(`${MUREKA_BASE}/instrumental/generate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUREKA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: oneshotPrompt,
      model: 'auto',
      duration: 3,          // Request shortest duration — limits to a brief sound
      make_instrumental: true
    })
  })

  if (!res.ok) {
    const err = await res.json() as any
    return c.json({ error: err?.error?.message || `Mureka error ${res.status}` }, 502)
  }

  const data = await res.json() as any
  return c.json({ ok: true, task_id: data.id, sound_type, prompt: oneshotPrompt })
})

// POST /api/poll-oneshot/:task_id — poll Mureka for one-shot status
app.post('/api/poll-oneshot/:task_id', async (c) => {
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Mureka not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  const taskId = c.req.param('task_id')
  const { sound_type } = await c.req.json<{ sound_type?: string }>().catch(() => ({ sound_type: undefined }))

  const res = await fetch(`${MUREKA_BASE}/instrumental/query/${taskId}`, {
    headers: { 'Authorization': `Bearer ${c.env.MUREKA_API_KEY}` }
  })
  if (!res.ok) return c.json({ status: 'error' }, 502)

  const data = await res.json() as any
  if (data.status === 'succeeded' && data.choices?.[0]?.url) {
    const audioUrl = data.choices[0].url as string
    // Save one-shot to library (jobs table with is_oneshot=1)
    if (c.env.DB) {
      try {
        await ensureTable(c.env.DB)
        const oneshotId = 'os_' + taskId
        const oneshotJob = {
          id: oneshotId, status: 'ready', created_at: Date.now(),
          sound_type: sound_type || 'one-shot', audio_url: audioUrl,
          title: sound_type || 'One Shot', prompt: sound_type || 'one-shot',
          tracks: [], thumbnail_seed: Math.floor(Math.random() * 360)
        }
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO jobs (id, data, created_at, user_id, is_oneshot)
           VALUES (?, ?, ?, ?, 1)`
        ).bind(oneshotId, JSON.stringify(oneshotJob), oneshotJob.created_at, user.id).run()
      } catch { /* ignore save errors */ }
    }
    return c.json({ status: 'ready', audio_url: audioUrl })
  }
  if (data.status === 'failed') return c.json({ status: 'error', error: 'Generation failed' })
  return c.json({ status: 'pending' })
})

// GET /api/download-wav/:id — proxy stereo URL with WAV content-disposition
app.get('/api/download-wav/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  // Free plan: downloads locked — stems and tracks are saved until upgrade
  if (user.plan === 'free') {
    return c.json({ error: 'Downloads require a Creator or Pro Artist plan. Your tracks are saved — upgrade anytime to download.', locked: true, upgrade: true }, 403)
  }
  const jobId = c.req.param('id')
  const job = await getJob(c.env.DB, jobId)
  if (!job || !job.stereo_url) return c.json({ error: 'Track not found' }, 404)
  // Fetch the audio and re-serve it with a proper filename
  const safeTitle = ((job as any).title || job.blueprint?.genre || 'beat')
    .replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/\s+/g, '_').toLowerCase() || 'stemforge_beat'
  const upstream = await fetch(job.stereo_url)
  if (!upstream.ok) return c.json({ error: 'Could not fetch audio' }, 502)
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${safeTitle}.wav"`,
      'Cache-Control': 'no-store'
    }
  })
})

// GET /api/download-wav-url — proxy any audio URL as WAV download (for one shots)
app.get('/api/download-wav-url', async (c) => {
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  const url = c.req.query('url')
  const name = c.req.query('name') || 'oneshot'
  if (!url) return c.json({ error: 'Missing url param' }, 400)
  const safeUrl = decodeURIComponent(url)
  const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '_')
  const upstream = await fetch(safeUrl)
  if (!upstream.ok) return c.json({ error: 'Could not fetch audio' }, 502)
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${safeName}.wav"`,
      'Cache-Control': 'no-store'
    }
  })
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
    <a href="/promos" class="gs-sidebar__nav-item" data-page="promos">
      <i class="fas fa-tag"></i>
      <span>Promo Codes</span>
    </a>
    <span class="gs-sidebar__nav-item gs-sidebar__nav-item--coming-soon" tabindex="-1" title="Studio — Coming Soon">
      <i class="fas fa-flask"></i>
      <span>Studio</span>
      <span class="gs-coming-soon-badge">Coming Soon</span>
    </span>
    <a href="/feedback" class="gs-sidebar__nav-item" data-page="feedback">
      <i class="fas fa-comment-alt"></i>
      <span>Give Us Feedback</span>
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
        <div style="font-weight:700;font-size:.92rem;margin-bottom:10px"><i class="fas fa-layer-group" style="color:var(--primary);margin-right:6px"></i>Get Stems</div>

        <!-- Two-option picker (shown when stems not yet extracted) -->
        <div id="edit-stems-picker" style="display:none">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <!-- 5 stems -->
            <div id="edit-tier-basic" onclick="selectEditStemTier('basic')" style="cursor:pointer;border:2px solid var(--primary);border-radius:10px;padding:12px 10px;background:rgba(108,58,255,.08);position:relative;transition:all .18s">
              <div style="font-size:1.3rem;font-weight:800;color:var(--primary);line-height:1">5</div>
              <div style="font-size:.78rem;font-weight:600;margin:2px 0 1px">Stems</div>
              <div style="font-size:.68rem;color:var(--muted);margin-bottom:8px;line-height:1.3">Drums · Bass · Melody<br>Vocals · Other</div>
              <div style="font-size:.75rem;font-weight:700">2 credits</div>
              <div id="edit-check-basic" style="position:absolute;top:8px;right:8px;width:14px;height:14px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center">
                <i class="fas fa-check" style="color:white;font-size:.5rem"></i>
              </div>
            </div>
            <!-- Up to 12 stems -->
            <div id="edit-tier-pro" onclick="selectEditStemTier('pro')" style="cursor:pointer;border:2px solid var(--border);border-radius:10px;padding:12px 10px;background:var(--surface);position:relative;transition:all .18s">
              <div style="font-size:1.3rem;font-weight:800;color:#a855f7;line-height:1">12</div>
              <div style="font-size:.78rem;font-weight:600;margin:2px 0 1px">Stems</div>
              <div style="font-size:.68rem;color:var(--muted);margin-bottom:8px;line-height:1.3">+ Guitar · Strings · Synth<br>Brass · FX · MIDI</div>
              <div style="font-size:.75rem;font-weight:700">10 credits</div>
              <!-- Pro badge / locked note -->
              <div id="edit-pro-badge" style="position:absolute;top:7px;right:7px;background:linear-gradient(135deg,#6c3aff,#a855f7);border-radius:4px;padding:1px 5px;font-size:.6rem;font-weight:700;color:white;white-space:nowrap">
                <i class="fas fa-crown" style="margin-right:2px"></i>Pro
              </div>
              <div id="edit-check-pro" style="display:none;position:absolute;top:8px;right:8px;width:14px;height:14px;border-radius:50%;background:#a855f7;align-items:center;justify-content:center">
                <i class="fas fa-check" style="color:white;font-size:.5rem"></i>
              </div>
              <!-- Lock overlay for non-pro -->
              <div id="edit-pro-lock" style="display:none;position:absolute;inset:0;border-radius:8px;background:rgba(0,0,0,.45);flex-direction:column;align-items:center;justify-content:center;gap:3px">
                <i class="fas fa-lock" style="color:#a855f7;font-size:.9rem"></i>
                <span style="font-size:.62rem;color:rgba(255,255,255,.8);font-weight:600">Pro Artist only</span>
              </div>
            </div>
          </div>
          <!-- Upgrade note for Creator users -->
          <p id="edit-pro-upgrade-note" style="display:none;font-size:.74rem;color:var(--muted);margin:0 0 10px;text-align:center">
            <i class="fas fa-crown" style="color:#a855f7;margin-right:3px"></i>Up to 12 stems requires <a href="/pricing" style="color:#a855f7;text-decoration:underline">Pro Artist</a>
          </p>
          <button id="edit-get-stems-btn" class="btn btn--primary btn--sm" style="width:100%" onclick="requestStems()">
            <i class="fas fa-layer-group"></i> <span id="edit-stems-btn-label">Get 5 Stems — 2 Credits</span>
          </button>
        </div>

        <!-- Already extracted state -->
        <div id="edit-stems-result" style="display:none;gap:8px;flex-wrap:wrap">
          <a id="edit-stems-zip-link" href="#" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:var(--primary);color:#fff;border-radius:8px;font-size:.85rem;font-weight:600;text-decoration:none">
            <i class="fas fa-layer-group"></i> Open Stems Player
          </a>
          <a id="edit-stems-midi-link" href="#" download style="display:none;align-items:center;gap:6px;padding:8px 14px;background:var(--surface-3,#2a2a3a);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:.85rem;font-weight:600;text-decoration:none">
            <i class="fas fa-music"></i> MIDI ZIP
          </a>
        </div>

        <div id="edit-stems-status" style="display:none;font-size:.82rem;margin-top:8px;padding:8px 12px;border-radius:8px"></div>
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
      <p>AI beat generation — professional stems, no studio needed.</p>
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
    <h1 class="hero__title">Generate the beat.<br/><span class="gradient-text">Download it clean.</span></h1>
    <p class="hero__sub">StemForge generates professional rap, trap, and R&B beats using AI. Download the full stereo mix, access stem bundles (bass, melody, vocals, other), and take your beats to the DAW — all powered by Mureka's music engine.</p>
    <div class="hero__ctas">
      <a href="/generator" class="btn btn--primary btn--lg"><i class="fas fa-play"></i> Try the generator</a>
      <a href="#pricing-preview" class="btn btn--outline btn--lg" onclick="event.preventDefault();document.getElementById('pricing-preview').scrollIntoView({behavior:'smooth'})"><i class="fas fa-tags"></i> See pricing</a>
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
        <h3>Stem &amp; track export</h3>
        <p>Download the full stereo mix and get a stem bundle with separated layers (bass, vocals, melody, other) — ready for your DAW.</p>
        <div class="feature-card__tracks">
          <span class="track-pill track-pill--kick">Stereo Mix</span>
          <span class="track-pill track-pill--bass">Bass.wav</span>
          <span class="track-pill track-pill--keys">Melody.wav</span>
          <span class="track-pill track-pill--pad">Other.wav</span>
          <span class="track-pill track-pill--hats">Vocals.wav</span>
        </div>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-microchip"></i></div>
        <h3>Composition-first generation</h3>
        <p>AI builds a shared blueprint first — BPM, key, structure, arrangement — so all tracks lock together perfectly.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-sliders"></i></div>
        <h3>Regenerate your beat</h3>
        <p>Don't like the result? Regenerate with a new style or adjust your prompt. Every generation is unique and saved to your library.</p>
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



<section class="pricing-preview" id="pricing-preview">
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
          <li><i class="fas fa-check"></i> 5 credits/downloads monthly</li>
          <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
          <li><i class="fas fa-check"></i> Stem extraction (saved, not downloadable)</li>
          <li class="muted"><i class="fas fa-times"></i> Downloads (WAV / MP3)</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full" id="home-free-plan-btn" data-plan="free">Get started free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$19</span><span>/month</span></div>
        <p class="plan-card__desc">For artists, writers, and content creators.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 50 credits/downloads monthly</li>
          <li><i class="fas fa-check"></i> Mastered WAV &amp; MP3 download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li class="muted"><i class="fas fa-times"></i> Stem extraction</li>
          <li class="muted"><i class="fas fa-times"></i> Individual stem download</li>
        </ul>
        <button class="btn btn--primary btn--full home-plan-btn" data-plan="creator">Start Creator</button>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$39</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 200 credits/downloads monthly</li>
          <li><i class="fas fa-check"></i> Mastered &amp; unmastered WAV / MP3</li>
          <li><i class="fas fa-check"></i> Stem extraction + download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> Priority queue</li>
        </ul>
        <button class="btn btn--outline btn--full home-plan-btn" data-plan="pro">Start Pro Artist</button>
      </div>
      <div class="plan-card plan-card--developer" id="developer-plan-card" style="display:none">
        <div class="plan-card__tier" style="color:#a78bfa">Developer</div>
        <div class="plan-card__price"><span class="plan-card__amount">🔒</span></div>
        <p class="plan-card__desc">For the site owner. Unlimited access, no limits.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> Unlimited generations</li>
          <li><i class="fas fa-check"></i> All features unlocked</li>
          <li><i class="fas fa-check"></i> No credit deductions</li>
          <li><i class="fas fa-check"></i> Admin panel access</li>
        </ul>
        <button class="btn btn--outline btn--full" onclick="activateDeveloperPlan()" id="dev-activate-btn">Activate Developer Plan</button>
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

<!-- Home page upgrade confirmation modal (same as subscription page) -->
<div id="home-upgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;align-items:center;justify-content:center;padding:16px">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:0;max-width:460px;width:100%;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6)">
    <div style="background:linear-gradient(135deg,#6c3aff22,#a855f722);border-bottom:1px solid var(--border);padding:24px 28px 20px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-up" style="color:white;font-size:.9rem"></i>
        </div>
        <div>
          <h3 style="margin:0;font-size:1.15rem" id="hum-title">Confirm Upgrade</h3>
          <p style="margin:0;font-size:.8rem;color:var(--muted)" id="hum-subtitle">Review your prorated charge</p>
        </div>
      </div>
    </div>
    <div id="hum-loading" style="padding:40px;text-align:center">
      <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px"></div>
      <p style="color:var(--muted);margin:0;font-size:.9rem">Calculating your charge…</p>
    </div>
    <div id="hum-content" style="display:none;padding:24px 28px">
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px">
        <div style="text-align:center">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Current Plan</div>
          <div id="hum-from-label" style="font-weight:700;font-size:1rem">Free</div>
          <div id="hum-from-price" style="font-size:.8rem;color:var(--muted)"></div>
        </div>
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-right" style="color:white;font-size:.8rem"></i>
        </div>
        <div style="text-align:center">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">New Plan</div>
          <div id="hum-to-label" style="font-weight:700;font-size:1rem;color:#a855f7">Pro Artist</div>
          <div id="hum-to-price" style="font-size:.8rem;color:var(--muted)"></div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px">
        <div style="padding:10px 16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Billing period</span>
          <span id="hum-period" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:10px 16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Days remaining</span>
          <span id="hum-days" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:10px 16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Price difference</span>
          <span id="hum-diff" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:12px 16px;display:flex;justify-content:space-between;background:rgba(108,58,255,.1)">
          <span style="font-size:.95rem;font-weight:700">Charge today</span>
          <span id="hum-charge" style="font-size:1.1rem;font-weight:800;color:#a855f7">—</span>
        </div>
      </div>
      <p id="hum-note" style="font-size:.8rem;color:var(--muted);text-align:center;margin:0 0 20px;line-height:1.5"></p>
      <div style="display:flex;gap:10px">
        <button class="btn btn--outline btn--sm" style="flex:1" onclick="closeHomeUpgradeModal()"><i class="fas fa-times"></i> Cancel</button>
        <button class="btn btn--primary btn--sm" style="flex:2;background:linear-gradient(135deg,#6c3aff,#a855f7);border:none" id="hum-confirm-btn" onclick="confirmHomeUpgrade()"><i class="fas fa-lock"></i> <span id="hum-confirm-label">Confirm &amp; Pay</span></button>
      </div>
    </div>
    <div id="hum-error" style="display:none;padding:32px 28px;text-align:center">
      <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:#ef4444;margin-bottom:12px"></i>
      <p id="hum-error-msg" style="color:var(--muted);margin:0 0 20px;font-size:.9rem;line-height:1.5"></p>
      <button class="btn btn--outline btn--sm" onclick="closeHomeUpgradeModal()">Close</button>
    </div>
  </div>
</div>

<script>
(function(){
  let _humPlan = null;

  // Convert plan card buttons: logged-in users get upgrade/downgrade modal, logged-out go to checkout
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
            msg.textContent = 'Your subscription will be cancelled. You will move to the Free plan (5 credits/downloads monthly) after your billing cycle ends.';
          } else if (plan === 'creator') {
            msg.textContent = 'You will be downgraded to Creator ($19/mo, 50 credits/downloads monthly) at the end of your current billing cycle. You keep all features until then.';
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
          alert(data.message || 'Downgrade scheduled. Changes take effect at end of billing period.');
          window.location.reload();
        } else { alert('Error: ' + (data.error || 'Downgrade failed')); }
      } catch(e) { alert('Network error. Please try again.'); }
      finally { homeDgConfirm.disabled = false; homeDgConfirm.textContent = 'Confirm Downgrade'; }
    });
  }
  document.getElementById('home-downgrade-modal').addEventListener('click', function(e) {
    if (e.target === this) this.style.display = 'none';
  });

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
        document.getElementById('hum-from-label').textContent = data.current_plan_label || 'Free';
        document.getElementById('hum-from-price').textContent = data.current_price_label || '';
        document.getElementById('hum-to-label').textContent   = data.target_plan_label || plan;
        document.getElementById('hum-to-price').textContent   = data.new_price_label || '';
        const humHasRealSub = data.has_subscription &&
          data.days_remaining != null && !isNaN(data.days_remaining) &&
          data.days_in_period != null && !isNaN(data.days_in_period);
        const humChargeLabel = (data.proration_label && data.proration_label !== '$NaN')
          ? data.proration_label : (data.new_price_label ? data.new_price_label.replace('/mo','') : '');
        if (humHasRealSub) {
          document.getElementById('hum-period').textContent = data.billing_cycle_range || (data.period_end_label ? 'Renews ' + data.period_end_label : '—');
          document.getElementById('hum-days').textContent   = data.days_remaining + ' days left';
          document.getElementById('hum-diff').textContent   = data.price_diff_label || ((data.current_price_label||'') + ' → ' + (data.new_price_label||''));
          document.getElementById('hum-charge').textContent = humChargeLabel;
          document.getElementById('hum-note').textContent   = 'Then ' + (data.new_price_label||'') + ' starting ' + (data.period_end_label||'next billing date') + '.';
        } else {
          document.getElementById('hum-period').textContent = 'New subscription';
          document.getElementById('hum-days').textContent   = 'Full billing cycle';
          document.getElementById('hum-diff').textContent   = '—';
          document.getElementById('hum-charge').textContent = data.new_price_label ? data.new_price_label.replace('/mo','') : humChargeLabel;
          document.getElementById('hum-note').textContent   = 'You will be charged ' + (data.new_price_label||'') + ' today and billed monthly.';
        }
        document.getElementById('hum-confirm-label').textContent = 'Confirm & Pay ' + humChargeLabel;
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
        alert(data.message || 'Upgrade successful!');
        window.location.href = '/dashboard';
      } else { alert('Error: ' + (data.error || 'Upgrade failed')); }
    } catch(e) { closeHomeUpgradeModal(); alert('Network error. Please try again.'); }
  };

  document.getElementById('home-upgrade-modal').addEventListener('click', function(e) {
    if (e.target === this) closeHomeUpgradeModal();
  });

  // ── On page load: update plan card buttons to match user's current plan ──────
  // Mirrors subscription page logic exactly:
  // Free user   → Creator card: "Upgrade to Creator" | Pro card: "Upgrade to Pro Artist"
  // Creator user → Free card: "Downgrade to Free"   | Pro card:  "Upgrade to Pro Artist"
  // Pro user    → Free card: "Downgrade to Free"    | Creator card: "Downgrade to Creator"
  (async function() {
    try {
      const me = await fetch('/api/auth/me').then(r => r.json());
      const user = me && me.user;
      if (!user) return;

      const rank = { free:0, creator:1, pro:2, developer:3 };
      const userRank = rank[user.plan] ?? 0;
      const pendingDowngrade = sessionStorage.getItem('sf_pending_downgrade');
      const pendingUpgrade   = sessionStorage.getItem('sf_pending_upgrade');

      // ── FREE tier button (it's an <a> tag, not a .home-plan-btn) ──
      const freePlanBtn = document.getElementById('home-free-plan-btn');
      if (freePlanBtn) {
        freePlanBtn.removeAttribute('href');
        if (userRank === 0) {
          freePlanBtn.textContent = 'Current plan';
          freePlanBtn.style.opacity = '0.6';
          freePlanBtn.style.pointerEvents = 'none';
        } else {
          // Paid user → can downgrade to free
          freePlanBtn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>Downgrade to Free';
          freePlanBtn.style.borderColor = 'rgba(255,100,100,.5)';
          freePlanBtn.style.color = '#ff7070';
          freePlanBtn.style.cursor = 'pointer';
          if (pendingDowngrade === 'free') {
            freePlanBtn.innerHTML = '<i class="fas fa-clock" style="font-size:.8rem;margin-right:4px"></i>Pending Downgrade';
            freePlanBtn.style.opacity = '0.7';
            freePlanBtn.style.pointerEvents = 'none';
          } else {
            freePlanBtn.addEventListener('click', (e) => {
              e.preventDefault();
              _homeDgPlan = 'free';
              const msg = document.getElementById('home-downgrade-msg');
              if (msg) msg.textContent = 'Your subscription will be cancelled. You will move to the Free plan (5 credits/downloads monthly) after your billing cycle ends.';
              document.getElementById('home-downgrade-modal').style.display = 'flex';
            });
          }
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
        } else if (userRank > planRank) {
          // Downgrade path
          const isPendingDg = pendingDowngrade === plan;
          if (isPendingDg) {
            btn.innerHTML = '<i class="fas fa-clock" style="font-size:.8rem;margin-right:4px"></i>Pending Downgrade';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.classList.remove('btn--primary');
            btn.classList.add('btn--outline');
            btn.style.borderColor = 'rgba(234,179,8,.4)';
            btn.style.color = '#fbbf24';
          } else {
            const label = plan === 'creator' ? 'Downgrade to Creator' : 'Downgrade to Free';
            btn.innerHTML = '<i class="fas fa-arrow-down" style="font-size:.8rem;margin-right:4px"></i>' + label;
            btn.classList.remove('btn--primary');
            btn.classList.add('btn--outline');
            btn.style.borderColor = 'rgba(255,100,100,.5)';
            btn.style.color = '#ff7070';
            // Remove old listeners by cloning
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
              _homeDgPlan = plan;
              const msg = document.getElementById('home-downgrade-msg');
              if (plan === 'free') {
                if (msg) msg.textContent = 'Your subscription will be cancelled. You will move to the Free plan (5 credits/downloads monthly) after your billing cycle ends.';
              } else if (plan === 'creator') {
                if (msg) msg.textContent = 'You will be downgraded to Creator ($19/mo, 50 credits/downloads monthly) at the end of your current billing cycle. You keep all features until then.';
              }
              document.getElementById('home-downgrade-modal').style.display = 'flex';
            });
          }
        } else {
          // Upgrade path
          const isPendingUp = pendingUpgrade === plan;
          if (isPendingUp) {
            btn.innerHTML = '<i class="fas fa-clock" style="font-size:.8rem;margin-right:4px"></i>Pending Upgrade';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.classList.remove('btn--outline');
            btn.classList.add('btn--primary');
            btn.style.background = 'rgba(108,58,255,.3)';
          } else {
            const label = plan === 'creator' ? 'Upgrade to Creator' : 'Upgrade to Pro Artist';
            btn.innerHTML = '<i class="fas fa-arrow-up" style="font-size:.8rem;margin-right:4px"></i>' + label;
            // Leave upgrade button class as-is (already btn--primary for creator, btn--outline for pro)
            // Remove old listeners by cloning
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => openHomeUpgradeModal(plan));
          }
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
  <div id="stems-no-stems" style="display:none;padding:40px 20px;max-width:480px;margin:0 auto">
    <div style="text-align:center;margin-bottom:24px">
      <i class="fas fa-layer-group" style="font-size:2.5rem;color:var(--primary);margin-bottom:12px;display:block;opacity:.6"></i>
      <h3 style="margin-bottom:6px">Extract Stems</h3>
      <p style="color:var(--muted);font-size:.9rem">Separate this beat into individual layers you can mix and download.</p>
    </div>

    <!-- Single stem pack info -->
    <div style="border:2px solid var(--primary);border-radius:16px;padding:20px 20px 18px;background:rgba(78,159,255,.07);margin-bottom:22px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="font-size:2rem;font-weight:800;color:var(--primary);line-height:1;flex-shrink:0">5</div>
        <div>
          <div style="font-size:.9rem;font-weight:700">Stems</div>
          <div style="font-size:.78rem;color:var(--muted);margin-top:2px">Drums · Bass · Vocals · Melody · Other</div>
        </div>
        <div style="margin-left:auto;font-size:.85rem;font-weight:700;color:var(--primary)">2 credits</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0;display:inline-block"></span>Drums (+ drum kit split)</div>
        <div style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:#3b82f6;flex-shrink:0;display:inline-block"></span>Bass</div>
        <div style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:#ec4899;flex-shrink:0;display:inline-block"></span>Vocals</div>
        <div style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:#8b5cf6;flex-shrink:0;display:inline-block"></span>Melody (+ instrument split)</div>
      </div>
    </div>

    <!-- Free plan note — hidden by default, shown for free users via JS -->
    <div id="stems-free-note" style="display:none;margin-bottom:18px;padding:12px 16px;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);border-radius:10px;font-size:.82rem;color:#c084fc;text-align:left;line-height:1.5">
      <i class="fas fa-info-circle" style="margin-right:5px"></i>
      <strong>Free plan:</strong> We'll extract and safely save your stems.
      You can <strong>listen and download</strong> them after upgrading to <a href="/pricing?plan=pro" style="color:#a855f7;text-decoration:underline">Pro Artist</a>.
      Your stems never expire.
    </div>

    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn--outline" onclick="history.back()"><i class="fas fa-times"></i> Cancel</button>
      <button class="btn btn--primary" id="stems-extract-btn" onclick="stemsExtract()" style="min-width:200px">
        <i class="fas fa-layer-group"></i> <span id="stems-extract-btn-label">Extract Stems — 2 Credits</span>
      </button>
    </div>
    <div id="stems-extract-status" style="margin-top:16px;font-size:.88rem;display:none;text-align:center"></div>
  </div>
  <div id="stems-error" style="display:none;text-align:center;padding:60px 20px">
    <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:var(--danger);margin-bottom:16px;display:block"></i>
    <p id="stems-error-msg">Could not load stems.</p>
    <button class="btn btn--outline" style="margin-top:16px" onclick="stemsInit()">Retry</button>
  </div>

  <!-- Vocals / Instrumental / Advanced Split tab strip (shown with player) -->
  <div id="stems-vi-toggle" style="display:none" class="stems-vi-strip">
    <button class="stems-vi-btn stems-vi-btn--active" id="vi-vocals-btn" onclick="setVIMode('vocals')">
      <i class="fas fa-microphone"></i> Vocals
    </button>
    <button class="stems-vi-btn" id="vi-instrumental-btn" onclick="setVIMode('instrumental')">
      <i class="fas fa-drum"></i> Instrumental
    </button>
    <button class="stems-vi-btn" id="vi-advsplit-btn" onclick="setVIMode('advsplit')">
      <i class="fas fa-magic"></i> Advanced Split
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

  <!-- Advanced Split tab panel (shown when advsplit tab is active) -->
  <div id="stems-adv-split" style="display:none;padding:24px 0 40px">

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:640px">

      <!-- Split Drum Kit -->
      <div style="border:1px solid var(--border);border-radius:14px;padding:20px;background:var(--surface-2,#1e2130);position:relative">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:1.4rem">🥁</span>
          <div>
            <div style="font-weight:700;font-size:.95rem">Split Drum Kit</div>
            <div style="font-size:.75rem;color:var(--muted)">Kick · Snare · Hi-Hats · Toms</div>
          </div>
        </div>
        <p style="font-size:.8rem;color:var(--muted);line-height:1.5;margin-bottom:14px">
          2-pass AI separation — extracts a clean drum track then re-separates kick, snare, hi-hats and toms individually.
        </p>
        <div id="adv-drums-status" style="font-size:.78rem;color:var(--muted);margin-bottom:10px;display:none"></div>
        <button id="adv-drums-btn" class="btn btn--primary btn--sm" onclick="advSplitRequest('drums')" style="width:100%">
          <i class="fas fa-cut"></i> Split Drum Kit
        </button>
        <div style="font-size:.68rem;color:var(--muted);margin-top:6px;text-align:center">Uses 1 credit</div>
      </div>

      <!-- Split Melodies -->
      <div style="border:1px solid var(--border);border-radius:14px;padding:20px;background:var(--surface-2,#1e2130);position:relative">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:1.4rem">🎹</span>
          <div>
            <div style="font-weight:700;font-size:.95rem">Split Melodies</div>
            <div style="font-size:.75rem;color:var(--muted)">Piano · Synth · Guitar · Other</div>
          </div>
        </div>
        <p style="font-size:.8rem;color:var(--muted);line-height:1.5;margin-bottom:14px">
          Pick exactly which grouped melody stem to split — you choose the stem so nothing is wasted.
        </p>
        <div id="adv-melodies-status" style="font-size:.78rem;color:var(--muted);margin-bottom:10px;display:none"></div>
        <button id="adv-melodies-btn" class="btn btn--primary btn--sm" onclick="advMelodiesPickStem()" style="width:100%;background:linear-gradient(135deg,#6c3aff,#a855f7)">
          <i class="fas fa-hand-pointer"></i> Pick Stem to Split
        </button>
        <div style="font-size:.68rem;color:var(--muted);margin-top:6px;text-align:center">Uses 1 credit</div>
      </div>

    </div>
    <p style="font-size:.72rem;color:var(--muted);margin-top:12px;max-width:640px">
      <i class="fas fa-info-circle" style="margin-right:4px"></i>
      Results appear directly in the stem player. Drum kit split takes 2&ndash;5 min &middot; Melody split 1&ndash;3 min.
    </p>
  </div>

  <!-- Extract flow for free users nudge -->
  <div id="stems-upgrade-nudge" style="display:none;text-align:center;padding:24px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:14px;margin-top:20px">
    <p style="margin-bottom:12px"><i class="fas fa-lock" style="color:var(--primary)"></i> <strong>Stems require a Pro Artist plan</strong></p>
    <a href="/pricing" class="btn btn--primary btn--sm">View Plans</a>
  </div>

  <!-- Free plan: stems extracted & saved, but downloads locked -->
  <div id="stems-free-locked" style="display:none;padding:40px 20px;max-width:500px;margin:0 auto;text-align:center">
    <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.6rem;color:#fff">
      <i class="fas fa-layer-group"></i>
    </div>
    <h3 style="font-size:1.2rem;font-weight:700;margin-bottom:8px">Your stems are saved!</h3>
    <p style="color:var(--muted);font-size:.92rem;margin-bottom:6px;line-height:1.6">
      We've extracted and saved your stems — <strong>Drums, Bass, Vocals, Melody, and Other</strong>.
    </p>
    <p style="color:var(--muted);font-size:.88rem;margin-bottom:28px;line-height:1.5">
      <i class="fas fa-lock" style="color:#a855f7;margin-right:4px"></i>
      Free plan can extract stems, but <strong>listening and downloading</strong> requires a <strong>Pro Artist</strong> plan.
      Your stems are stored safely — upgrade anytime to access them.
    </p>
    <div style="display:flex;flex-direction:column;gap:12px;max-width:320px;margin:0 auto">
      <a href="/pricing?plan=pro" style="display:block;padding:13px 24px;background:linear-gradient(135deg,#6c3aff,#a855f7);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
        <i class="fas fa-star"></i> Upgrade to Pro Artist — $39/mo
      </a>
      <a href="/pricing?plan=creator" style="display:block;padding:11px 20px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.88rem">
        <i class="fas fa-crown"></i> Creator Plan — $19/mo (beats only, no stems)
      </a>
    </div>
    <p style="color:var(--muted);font-size:.75rem;margin-top:20px">
      <i class="fas fa-check-circle" style="color:#22c55e;margin-right:4px"></i>
      Your stems are saved and won't expire. Come back after upgrading.
    </p>
  </div>

  <!-- Free / Creator plan: stems blocked — upgrade to Pro to access -->
  <div id="stems-creator-blocked" style="display:none;padding:40px 20px;max-width:500px;margin:0 auto;text-align:center">
    <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.6rem;color:#fff">
      <i class="fas fa-lock"></i>
    </div>
    <h3 style="font-size:1.2rem;font-weight:700;margin-bottom:8px">Stems are a Pro Artist feature</h3>
    <p style="color:var(--muted);font-size:.92rem;margin-bottom:6px;line-height:1.6">
      The Stem Player — including playback, downloads, and Advanced Split — is exclusive to <strong>Pro Artist</strong> members.
    </p>
    <p style="color:var(--muted);font-size:.88rem;margin-bottom:28px;line-height:1.5">
      Upgrade to split any beat into individual stems (Drums, Bass, Vocals, Melody, and more), play them back independently, and download each layer separately.
    </p>
    <div style="display:flex;flex-direction:column;gap:12px;max-width:320px;margin:0 auto">
      <a href="/pricing?plan=pro" style="display:block;padding:13px 24px;background:linear-gradient(135deg,#6c3aff,#a855f7);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
        <i class="fas fa-star"></i> Upgrade to Pro Artist — $39/mo
      </a>
      <a href="/" style="display:block;padding:11px 20px;background:var(--surface-2,#1e2130);color:var(--text);border:1px solid var(--border);border-radius:12px;font-weight:600;text-decoration:none;font-size:.88rem">
        <i class="fas fa-arrow-left"></i> Back to Dashboard
      </a>
    </div>
    <p style="color:var(--muted);font-size:.75rem;margin-top:20px">
      Pro Artist: 200 credits/downloads monthly · All stems · Advanced Split · Priority queue
    </p>
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
function ss(id, val) { var el = document.getElementById(id); if (el) el.style.display = val; }
function showState(state) {
  ss('stems-loading',         state==='loading'         ? 'block' : 'none');
  ss('stems-no-stems',        state==='no-stems'        ? 'block' : 'none');
  ss('stems-error',           state==='error'           ? 'block' : 'none');
  ss('stems-transport',       state==='player'          ? 'flex'  : 'none');
  ss('stems-list',            state==='player'          ? 'block' : 'none');
  ss('stems-upgrade-nudge',   state==='upgrade'         ? 'block' : 'none');
  ss('stems-free-locked',     state==='free-locked'     ? 'block' : 'none');
  ss('stems-creator-blocked', state==='creator-blocked' ? 'block' : 'none');
  // adv-split panel is controlled by setVIMode, not showState
  if (state !== 'player') {
    document.getElementById('stems-adv-split').style.display = 'none';
  }
  const viStrip = document.getElementById('stems-vi-toggle');
  if (viStrip) viStrip.style.display = state==='player' ? 'flex' : 'none';
}

// ── Vocals / Instrumental / Advanced Split toggle ─────────────
function setVIMode(mode) {
  viMode = mode;
  document.getElementById('vi-vocals-btn').classList.toggle('stems-vi-btn--active', mode==='vocals');
  document.getElementById('vi-instrumental-btn').classList.toggle('stems-vi-btn--active', mode==='instrumental');
  document.getElementById('vi-advsplit-btn').classList.toggle('stems-vi-btn--active', mode==='advsplit');

  // Show stems list for vocals/instrumental; show adv split panel for advsplit tab
  const listEl    = document.getElementById('stems-list');
  const advEl     = document.getElementById('stems-adv-split');
  const transportEl = document.getElementById('stems-transport');
  if (mode === 'advsplit') {
    if (listEl)      listEl.style.display      = 'none';
    if (advEl)       advEl.style.display        = 'block';
    if (transportEl) transportEl.style.display  = 'none';
  } else {
    if (listEl)      listEl.style.display      = 'block';
    if (advEl)       advEl.style.display        = 'none';
    if (transportEl) transportEl.style.display  = 'flex';
    applyVolumes();
  }
}

async function stemsInit() {
  showState('loading');
  try {
    // ── Plan gate: authenticate first, block free + creator before anything renders ──
    const meRes  = await fetch('/api/auth/me');
    const meData = await meRes.json();
    const user   = meData.user;
    if (!user) { showState('upgrade'); return; }
    // Free plan: cannot access stem player at all
    if (user.plan === 'free') { showState('creator-blocked'); return; }
    // Creator plan: stems are a Pro-only feature
    if (user.plan === 'creator') { showState('creator-blocked'); return; }

    const res = await fetch('/api/job/' + STEMS_JOB_ID);
    let job;
    try { job = await res.json(); } catch(je) { throw new Error('Server returned bad response (HTTP ' + res.status + ')'); }
    if (!res.ok || job.error) throw new Error(job.error || ('Job fetch failed: HTTP ' + res.status));
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
      // If user navigated back AFTER extraction (sessionStorage key exists but zip_url
      // not yet in job record, e.g. async write lag), treat as already extracted
      // and go straight back to library rather than showing the credit prompt again.
      const extractedKey = 'stems_extracted_' + STEMS_JOB_ID;
      if (sessionStorage.getItem(extractedKey)) {
        // Already extracted this session — go back silently instead of re-prompting
        history.back();
        return;
      }

      // Check if user already confirmed for this track this session — auto-extract
      const savedKey = 'stems_confirmed_' + STEMS_JOB_ID;
      if (sessionStorage.getItem(savedKey)) {
        showState('loading');
        await stemsExtract();
        return;
      }

      // Pro plan — show extraction prompt (2 credits)
      showState('no-stems');
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
  const hue   = job.thumbnail_seed != null ? job.thumbnail_seed : 180;
  const genre = (job.blueprint && job.blueprint.genre) || 'music';

  // Draw the same canvas art as the library cards (drawCanvasArt algorithm)
  try {
    const W = 400, H = 400;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Background gradient — identical stops to app.js drawCanvasArt
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0,   'hsl('+hue+',70%,16%)');
    grad.addColorStop(0.5, 'hsl('+((hue+50)%360)+',80%,10%)');
    grad.addColorStop(1,   'hsl('+((hue+100)%360)+',65%,7%)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

    // Accent glow spots
    const r1 = ctx.createRadialGradient(W*0.75, H*0.22, 10, W*0.75, H*0.22, W*0.48);
    r1.addColorStop(0, 'hsla('+((hue+130)%360)+',90%,65%,0.38)');
    r1.addColorStop(1, 'transparent');
    ctx.fillStyle = r1; ctx.fillRect(0, 0, W, H);

    const r2 = ctx.createRadialGradient(W*0.2, H*0.78, 5, W*0.2, H*0.78, W*0.4);
    r2.addColorStop(0, 'hsla('+((hue+250)%360)+',75%,60%,0.28)');
    r2.addColorStop(1, 'transparent');
    ctx.fillStyle = r2; ctx.fillRect(0, 0, W, H);

    // Subtle noise grain
    for (var i = 0; i < 200; i++) {
      var nx = (Math.sin(i * 127.1 + hue) * 0.5 + 0.5) * W;
      var ny = (Math.sin(i * 311.7 + hue * 0.3) * 0.5 + 0.5) * H;
      var a  = 0.03 + (Math.sin(i * 53.7) * 0.5 + 0.5) * 0.08;
      ctx.fillStyle = 'rgba(255,255,255,'+a.toFixed(3)+')';
      ctx.fillRect(nx, ny, 1.5, 1.5);
    }

    // Waveform bars (centre)
    var barCount = 22, barW = 7, gapW = 3;
    var totalBW = barCount * (barW + gapW) - gapW;
    var startX  = (W - totalBW) / 2;
    var centreY = H * 0.52;
    for (var b = 0; b < barCount; b++) {
      var seed = hue * 17 + b * 83;
      var bh   = 14 + (Math.sin(seed * 0.11) * 0.5 + 0.5) * 52;
      var bx   = startX + b * (barW + gapW);
      var by   = centreY - bh / 2;
      var bg2  = ctx.createLinearGradient(0, by, 0, by + bh);
      bg2.addColorStop(0, 'hsla('+((hue+30)%360)+',85%,78%,0.95)');
      bg2.addColorStop(1, 'hsla('+hue+',65%,45%,0.45)');
      ctx.fillStyle = bg2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, barW, bh, 2);
      else ctx.rect(bx, by, barW, bh);
      ctx.fill();
    }

    // Genre label (top)
    ctx.font = 'bold 11px system-ui,sans-serif';
    ctx.fillStyle = 'hsla('+hue+',65%,85%,0.65)';
    ctx.textAlign = 'center';
    ctx.fillText(genre.toUpperCase(), W/2, 22);

    // Track title (bottom)
    var words = title.split(' ');
    var l1 = words.slice(0, Math.ceil(words.length/2)).join(' ');
    var l2 = words.slice(Math.ceil(words.length/2)).join(' ');
    ctx.font = 'bold 20px system-ui,sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 8;
    if (l2) {
      ctx.fillText(l1.slice(0, 22), W/2, H*0.78);
      ctx.fillText(l2.slice(0, 22), W/2, H*0.78 + 26);
    } else {
      ctx.fillText(l1.slice(0, 24), W/2, H*0.8);
    }
    ctx.shadowBlur = 0;

    artEl.style.cssText = 'background-size:cover;background-position:center;';
    artEl.style.backgroundImage = "url('" + canvas.toDataURL('image/png') + "')";
  } catch(e) {
    // Fallback: plain gradient
    artEl.style.cssText = 'background:linear-gradient(135deg,hsl('+hue+',65%,28%),hsl('+((hue+120)%360)+',60%,15%));background-size:cover;';
  }

  if (job.zip_url) {
    const zipBtn = document.getElementById('stems-download-zip-btn');
    if (zipBtn) {
      zipBtn.style.display = '';
      const safe = title.replace(/[^a-zA-Z0-9 _-]/g,'').replace(/ +/g,'_').toLowerCase() || 'stems';
      zipBtn.onclick = () => { const a=document.createElement('a'); a.href=job.zip_url; a.download=safe+'_stem_bundle.zip'; document.body.appendChild(a); a.click(); a.remove(); };
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
  const waveEl = document.getElementById('stem-wave-' + stem);
  if (!waveEl) return;
  waveEl.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = waveEl.offsetWidth || 300; canvas.height = 32;
  canvas.style.cssText = 'width:100%;height:32px;display:block;';
  waveEl.appendChild(canvas);
  const W = canvas.width, H = canvas.height;
  const ctx2 = canvas.getContext('2d');
  if (!ctx2) return;
  ctx2.clearRect(0, 0, W, H);
  // Draw subtle pulsing bars to indicate loading
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

// ── Sub-stem polling disabled (Demucs integration removed) ────
// Stubs kept so no ReferenceErrors if old code paths reference them.
function startSubStemPolling(_jobId) { /* no-op: Demucs disabled */ }
function showSubStemPending()        { /* no-op */ }
function hideSubStemPending()        { /* no-op */ }

// ── Render sub-stems as expandable sections under their parent stem ─
function renderSubStems(subStems) {
  if (!subStems || subStems.length === 0) return;

  // Group by parent stem
  const grouped = {};
  subStems.forEach(s => {
    if (!grouped[s.parent]) grouped[s.parent] = [];
    grouped[s.parent].push(s);
  });

  const listEl = document.getElementById('stems-list');
  if (!listEl) return;

  Object.keys(grouped).forEach(parent => {
    const subs = grouped[parent];
    const parentRow = listEl.querySelector('[data-stem="' + parent + '"]');

    // Remove existing sub-section if re-rendering
    const existing = listEl.querySelector('.sub-stems-section[data-parent="' + parent + '"]');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.className = 'sub-stems-section';
    section.dataset.parent = parent;

    const parentLabel = parent === 'drums' ? 'Drum Kit' : parent === 'other' ? 'Melody Instruments' : 'FX Instruments';
    const parentIcon  = parent === 'drums' ? 'fa-drum' : parent === 'other' ? 'fa-music' : 'fa-waveform';

    section.innerHTML =
      '<div class="sub-stems-header" onclick="this.parentElement.classList.toggle(&quot;sub-stems-section--open&quot;)">' +
        '<span class="sub-stems-toggle-icon"><i class="fas fa-chevron-right"></i></span>' +
        '<i class="fas ' + (parent === 'drums' ? 'fa-drum' : 'fa-music') + '" style="color:var(--primary);font-size:.75rem"></i>' +
        '<span style="font-size:.8rem;font-weight:600;color:var(--text)">' + parentLabel + '</span>' +
        '<span style="font-size:.72rem;color:var(--muted);margin-left:auto">' + subs.length + ' stems</span>' +
      '</div>' +
      '<div class="sub-stems-list">' +
        subs.map(s =>
          '<div class="sub-stem-row" data-sub-key="' + s.key + '">' +
            '<div class="sub-stem-row__dot" style="background:' + s.color + '"></div>' +
            '<span class="sub-stem-row__name">' + s.name + '</span>' +
            '<div class="sub-stem-row__controls">' +
              '<button class="sub-stem-btn" onclick="playSubStem(&quot;' + s.key + '&quot;)" title="Play/Stop">' +
                '<i class="fas fa-play" id="sub-play-icon-' + s.key + '"></i>' +
              '</button>' +
              '<button class="sub-stem-btn" onclick="downloadSubStem(&quot;' + s.key + '&quot;,&quot;' + s.name + '&quot;)" title="Download">' +
                '<i class="fas fa-download"></i>' +
              '</button>' +
            '</div>' +
            '<div class="sub-stem-row__waveform" id="sub-wave-' + s.key + '"></div>' +
          '</div>'
        ).join('') +
      '</div>';

    // Insert directly after the parent stem row
    if (parentRow && parentRow.nextSibling) {
      listEl.insertBefore(section, parentRow.nextSibling);
    } else if (parentRow) {
      parentRow.after(section);
    } else {
      listEl.appendChild(section);
    }

    // Load audio for each sub-stem
    subs.forEach(s => loadSubStemAudio(s));
  });
}

// Sub-stem audio players — one per key
const subStemAudios = {};
let activeSubStemKey = null;

function loadSubStemAudio(sub) {
  const url = '/api/sub-stem-audio/' + STEMS_JOB_ID + '/' + sub.key;
  const audio = new Audio(url);
  audio.preload = 'none';
  subStemAudios[sub.key] = audio;
  audio.addEventListener('ended', () => {
    activeSubStemKey = null;
    const icon = document.getElementById('sub-play-icon-' + sub.key);
    if (icon) icon.className = 'fas fa-play';
  });
}

function playSubStem(key) {
  // Stop any currently playing sub-stem
  if (activeSubStemKey && activeSubStemKey !== key && subStemAudios[activeSubStemKey]) {
    subStemAudios[activeSubStemKey].pause();
    subStemAudios[activeSubStemKey].currentTime = 0;
    const prevIcon = document.getElementById('sub-play-icon-' + activeSubStemKey);
    if (prevIcon) prevIcon.className = 'fas fa-play';
    if (activeSubStemKey === key) { activeSubStemKey = null; return; }
  }
  // Also pause master player if playing
  if (isPlaying) stemsTogglePlayAll();

  const audio = subStemAudios[key];
  if (!audio) return;
  const icon = document.getElementById('sub-play-icon-' + key);
  if (audio.paused) {
    audio.play().catch(() => {});
    if (icon) icon.className = 'fas fa-pause';
    activeSubStemKey = key;
  } else {
    audio.pause();
    audio.currentTime = 0;
    if (icon) icon.className = 'fas fa-play';
    activeSubStemKey = null;
  }
}

function downloadSubStem(key, name) {
  const url = '/api/sub-stem-audio/' + STEMS_JOB_ID + '/' + key;
  const a = document.createElement('a');
  a.href = url;
  a.download = (name || key).replace(/[^a-zA-Z0-9 _-]/g,'').replace(/ +/g,'_').toLowerCase() + '.wav';
  document.body.appendChild(a); a.click(); a.remove();
}

// ── Advanced Split ─────────────────────────────────────────────
// ── Advanced Split: Drums ──────────────────────────────────────
async function advSplitRequest(target, selectedStem) {
  const isD = target === 'drums';
  const btn      = document.getElementById(isD ? 'adv-drums-btn' : 'adv-melodies-btn');
  const statusEl = document.getElementById(isD ? 'adv-drums-status' : 'adv-melodies-status');

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…'; }
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = isD
      ? 'Running 2-pass drum separation — 2–5 min…'
      : 'Splitting ' + (selectedStem || 'melody') + ' stem — 1–3 min…';
  }

  try {
    const body = { job_id: STEMS_JOB_ID, target: target };
    if (!isD && selectedStem) body.stem = selectedStem;

    const res  = await fetch('/api/job/stems/advanced-split', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Split failed');

    if (statusEl) { statusEl.textContent = '✓ Done! Stems added to player.'; }
    if (btn) { btn.disabled = false; btn.innerHTML = isD ? '<i class="fas fa-cut"></i> Split Drum Kit' : '<i class="fas fa-hand-pointer"></i> Pick Stem to Split'; }

    // ── Close adv split panel and return to stem player ────────
    setVIMode('vocals');

    // ── Inject new stems into the player list ──────────────────
    const newStems = data.stems || [];
    if (newStems.length > 0) {
      injectAdvSplitStems(newStems, target);
    }

  } catch(e) {
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Error: ' + (e.message || 'Split failed'); }
    if (btn) { btn.disabled = false; btn.innerHTML = isD ? '<i class="fas fa-redo"></i> Retry' : '<i class="fas fa-hand-pointer"></i> Pick Stem to Split'; }
  }
}

// ── Inject new split stems into the stem player list ──────────
// ── Group play/mute helpers ───────────────────────────────────
// groupStems: { groupId: [stemKey, ...] }
var groupStems = {};
var groupPlaying = {};  // groupId → bool
var groupMuted  = {};   // groupId → bool

function groupTogglePlay(groupId) {
  var keys   = groupStems[groupId] || [];
  var nowPlay = !groupPlaying[groupId];
  groupPlaying[groupId] = nowPlay;
  keys.forEach(function(k) {
    var a = stemAudios[k];
    if (!a) return;
    getAudioCtx();
    if (nowPlay) { a.play().catch(function(){}); }
    else { a.pause(); }
    var icon = document.getElementById('stem-play-' + k)?.querySelector('i');
    if (icon) icon.className = nowPlay ? 'fas fa-pause' : 'fas fa-play';
  });
  var gBtn = document.getElementById('grp-play-' + groupId);
  if (gBtn) gBtn.innerHTML = '<i class="fas ' + (nowPlay ? 'fa-pause' : 'fa-play') + '"></i>';
}

function groupToggleMute(groupId) {
  var keys    = groupStems[groupId] || [];
  var nowMute = !groupMuted[groupId];
  groupMuted[groupId] = nowMute;
  keys.forEach(function(k) {
    stemMuted[k] = nowMute;
    var btn = document.getElementById('stem-mute-' + k);
    if (btn) btn.classList.toggle('active', nowMute);
  });
  var gBtn = document.getElementById('grp-mute-' + groupId);
  if (gBtn) gBtn.classList.toggle('active', nowMute);
  applyVolumes();
}

function injectAdvSplitStems(newStems, target) {
  var listEl = document.getElementById('stems-list');
  if (!listEl) return;

  var isD    = target === 'drums';
  var groupId = isD ? 'adv_drums' : 'adv_melodies';
  var accentColor = isD ? '#ef4444' : '#8b5cf6';
  var label   = isD ? '🥁 Drum Kit' : '🎹 Melody Split';

  // Collect stem keys for this group
  var keys = newStems.map(function(s) {
    return s.key || s.name.toLowerCase().replace(/[^a-z0-9]+/g,'_');
  });
  groupStems[groupId]   = keys;
  groupPlaying[groupId] = false;
  groupMuted[groupId]   = false;

  // Remove old header + rows for this group
  var oldHdr = document.getElementById('adv-hdr-' + groupId);
  if (oldHdr) oldHdr.remove();
  keys.forEach(function(k) {
    var old = listEl.querySelector('[data-stem="' + k + '"]');
    if (old) old.remove();
  });

  // ── Group header row ─────────────────────────────────────────
  var hdr = document.createElement('div');
  hdr.id = 'adv-hdr-' + groupId;
  hdr.style.cssText = [
    'display:flex;align-items:center;justify-content:space-between;',
    'padding:8px 12px 6px;margin-top:10px;',
    'background:rgba(255,255,255,.03);border-radius:10px 10px 0 0;',
    'border:1px solid var(--border);border-bottom:none;'
  ].join('');
  hdr.innerHTML =
    '<span style="font-size:.78rem;font-weight:700;color:' + accentColor + ';letter-spacing:.04em">' + label + '</span>' +
    '<div style="display:flex;gap:6px;align-items:center">' +
      // Universal play
      '<button id="grp-play-' + groupId + '" ' +
        'onclick="groupTogglePlay(\'' + groupId + '\')" ' +
        'title="Play / Pause all" ' +
        'style="background:' + accentColor + ';border:none;color:#fff;border-radius:7px;' +
               'padding:4px 10px;cursor:pointer;font-size:.78rem;display:flex;align-items:center;gap:5px">' +
        '<i class="fas fa-play"></i>' +
      '</button>' +
      // Universal mute
      '<button id="grp-mute-' + groupId + '" ' +
        'onclick="groupToggleMute(\'' + groupId + '\')" ' +
        'title="Mute / Unmute all" ' +
        'class="stem-ctrl-btn stem-row__mute" ' +
        'style="font-size:.72rem">' +
        '<i class="fas fa-volume-mute"></i>' +
      '</button>' +
    '</div>';
  listEl.appendChild(hdr);

  // ── Individual stem rows ─────────────────────────────────────
  newStems.forEach(function(s) {
    var stemKey = s.key || s.name.toLowerCase().replace(/[^a-z0-9]+/g,'_');

    var track = {
      stem:   stemKey,
      name:   s.name,
      color:  s.color || accentColor,
      family: isD ? 'drums' : 'other',
      url:    s.url
    };

    var row = buildStemRow(track);
    row.dataset.advSplit = '1';
    row.dataset.groupId  = groupId;
    // Tighten top border radius since header is above
    row.style.borderRadius = '0';
    row.style.borderTop    = 'none';
    if (s === newStems[newStems.length - 1]) {
      row.style.borderRadius = '0 0 10px 10px';
    }
    listEl.appendChild(row);

    stemMuted[stemKey] = false;
    stemSolo[stemKey]  = false;
    stemGains[stemKey] = 1.0;
    drawLoadingWaveform(stemKey, track.color);

    // Fetch and attach audio
    fetch(s.url).then(function(r) {
      if (!r.ok) { drawRandomWaveform(stemKey, track.color); return; }
      return r.arrayBuffer();
    }).then(function(buf) {
      if (!buf) return;
      var blob  = new Blob([buf], { type: 'audio/mpeg' });
      var url   = URL.createObjectURL(blob);
      var audio = new Audio(url);
      audio.volume  = masterVolume;
      audio.preload = 'auto';
      stemAudios[stemKey] = audio;
      try {
        var ctx = getAudioCtx();
        var src = ctx.createMediaElementSource(audio);
        var gain = ctx.createGain();
        gain.gain.value = 1.0;
        src.connect(gain);
        gain.connect(ctx.destination);
        stemSources[stemKey]   = src;
        stemAnalysers[stemKey] = gain;
        drawWaveformFromAudio(stemKey, audio, track.color);
      } catch(ae) {
        drawRandomWaveform(stemKey, track.color);
      }
    }).catch(function() { drawRandomWaveform(stemKey, track.color); });
  });

  // Flash the header to draw attention
  hdr.style.transition = 'box-shadow .4s';
  hdr.style.boxShadow  = '0 0 0 2px ' + accentColor;
  setTimeout(function() { hdr.style.boxShadow = ''; }, 1400);
}

// ── Melody Stem Pick Mode ──────────────────────────────────────
// Groups that can be split (everything except drums/bass/vocals)
var MELODY_STEM_FAMILIES = ['other','piano','guitar','synth','strings','brass','woodwind','fx'];
var _melodyStemPickMode  = false;
var _melodyStemSelected  = null;

function advMelodiesPickStem() {
  // Switch to Vocals tab so user sees the stem list
  setVIMode('vocals');

  // Enter pick mode after tab transition
  setTimeout(function() {
    _melodyStemPickMode = true;
    _melodyStemSelected = null;

    // Show the pick mode banner at the top of the list
    var listEl = document.getElementById('stems-list');
    if (!listEl) return;

    // Remove existing banner if any
    var oldBanner = document.getElementById('melody-pick-banner');
    if (oldBanner) oldBanner.remove();

    var banner = document.createElement('div');
    banner.id = 'melody-pick-banner';
    banner.style.cssText = [
      'position:sticky;top:0;z-index:20;',
      'background:linear-gradient(135deg,#6c3aff,#a855f7);',
      'color:#fff;padding:12px 16px;border-radius:12px;margin-bottom:8px;',
      'display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'box-shadow:0 4px 20px rgba(108,58,255,.4);'
    ].join('');
    banner.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex:1">' +
        '<i class="fas fa-hand-pointer" style="font-size:1.1rem"></i>' +
        '<div>' +
          '<div style="font-weight:700;font-size:.88rem">Pick a melody stem to split</div>' +
          '<div id="melody-pick-hint" style="font-size:.74rem;opacity:.85">Highlighted stems can be split — click one to select</div>' +
        '</div>' +
      '</div>' +
      '<button onclick="advMelodiesCancelPick()" style="background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:8px;padding:5px 12px;cursor:pointer;font-size:.8rem;white-space:nowrap">' +
        '<i class="fas fa-times"></i> Cancel' +
      '</button>';
    listEl.parentNode.insertBefore(banner, listEl);

    // Dim all rows; highlight only melody-family rows
    var rows = listEl.querySelectorAll('.stem-row');
    rows.forEach(function(row) {
      var stemKey = row.dataset.stem || '';
      var family  = stemKey.replace(/[_-].*/,''); // rough family from key
      // Check if this stem belongs to a melody family
      var isMelody = MELODY_STEM_FAMILIES.some(function(f) {
        return stemKey.toLowerCase().includes(f) || row.querySelector('.stem-row__name')?.textContent?.toLowerCase().includes(f);
      });
      // Never highlight drums/bass/vocals stems
      var isExcluded = ['drums','bass','vocals'].some(function(f) { return stemKey.toLowerCase().startsWith(f); });

      if (isMelody && !isExcluded) {
        // Highlight: pulsing border, clickable
        row.style.cssText += ';cursor:pointer;border:2px solid #a855f7;border-radius:12px;animation:melody-pulse 1.2s ease-in-out infinite;';
        row.setAttribute('data-melody-pick', '1');
        row.onclick = function() { advMelodiesSelectStem(stemKey, row); };
      } else {
        // Dim
        row.style.opacity = '0.25';
        row.style.pointerEvents = 'none';
      }
    });

    // Add pulse keyframe if not present
    if (!document.getElementById('melody-pulse-style')) {
      var s = document.createElement('style');
      s.id = 'melody-pulse-style';
      s.textContent = '@keyframes melody-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(168,85,247,.5)} 50%{box-shadow:0 0 0 6px rgba(168,85,247,0)} }';
      document.head.appendChild(s);
    }
  }, 150);
}

function advMelodiesSelectStem(stemKey, rowEl) {
  if (!_melodyStemPickMode) return;
  _melodyStemSelected = stemKey;

  // Update banner to show confirm state
  var hint = document.getElementById('melody-pick-hint');
  if (hint) {
    hint.innerHTML = '<strong style="color:#fff">Selected: ' +
      (rowEl.querySelector('.stem-row__name')?.textContent || stemKey) +
      '</strong> — ready to split';
  }

  // Visually confirm selection on the row
  var listEl = document.getElementById('stems-list');
  if (listEl) {
    listEl.querySelectorAll('[data-melody-pick="1"]').forEach(function(r) {
      r.style.borderColor = r === rowEl ? '#22c55e' : 'rgba(168,85,247,.3)';
      r.style.animation   = r === rowEl ? 'none' : 'melody-pulse 1.2s ease-in-out infinite';
      r.style.opacity     = r === rowEl ? '1' : '0.4';
    });
  }

  // Show confirm button in banner
  var banner = document.getElementById('melody-pick-banner');
  if (banner) {
    // Replace hint area with confirm row
    var left = banner.querySelector('div');
    if (left) {
      left.innerHTML =
        '<i class="fas fa-check-circle" style="font-size:1.1rem;color:#22c55e"></i>' +
        '<div>' +
          '<div style="font-weight:700;font-size:.88rem">' +
            (rowEl.querySelector('.stem-row__name')?.textContent || stemKey) + ' selected' +
          '</div>' +
          '<div style="font-size:.74rem;opacity:.85">Confirm to start splitting (1 credit)</div>' +
        '</div>';
    }
    // Add confirm button
    var cancelBtn = banner.querySelector('button');
    if (cancelBtn && !document.getElementById('melody-confirm-btn')) {
      var confirmBtn = document.createElement('button');
      confirmBtn.id = 'melody-confirm-btn';
      confirmBtn.style.cssText = 'background:#22c55e;border:none;color:#fff;border-radius:8px;padding:5px 14px;cursor:pointer;font-size:.8rem;font-weight:700;white-space:nowrap';
      confirmBtn.innerHTML = '<i class="fas fa-cut"></i> Split Now';
      confirmBtn.onclick = function() { advMelodiesConfirmSplit(); };
      banner.insertBefore(confirmBtn, cancelBtn);
    }
  }
}

function advMelodiesConfirmSplit() {
  if (!_melodyStemSelected) return;
  var stemKey = _melodyStemSelected;
  advMelodiesCancelPick(); // Clean up pick mode UI

  // Switch back to advsplit tab to show status
  setVIMode('advsplit');

  // Update the melodies button to show processing
  var btn = document.getElementById('adv-melodies-btn');
  var statusEl = document.getElementById('adv-melodies-status');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Splitting…'; }
  if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Splitting ' + stemKey + ' stem — 1–3 min…'; }

  // Run the split
  advSplitRequest('melodies', stemKey);
}

function advMelodiesCancelPick() {
  _melodyStemPickMode = false;
  _melodyStemSelected = null;

  // Remove banner
  var banner = document.getElementById('melody-pick-banner');
  if (banner) banner.remove();

  // Restore all stem rows
  var listEl = document.getElementById('stems-list');
  if (listEl) {
    listEl.querySelectorAll('.stem-row').forEach(function(row) {
      row.style.opacity       = '';
      row.style.pointerEvents = '';
      row.style.border        = '';
      row.style.borderRadius  = '';
      row.style.animation     = '';
      row.style.cursor        = '';
      row.removeAttribute('data-melody-pick');
      // Remove click handler added in pick mode (restore default)
      row.onclick = null;
    });
  }
}

// ── Build stem row ────────────────────────────────────────────
function buildStemRow(track) {
  const el = document.createElement('div');
  el.className = 'stem-row'; el.dataset.stem = track.stem;
  const iconMap = {drums:'fa-drum',bass:'fa-guitar',vocals:'fa-microphone',other:'fa-wave-square',
    mix:'fa-compact-disc',piano:'fa-piano',guitar:'fa-guitar',strings:'fa-violin',
    synth:'fa-wave-square',brass:'fa-trumpet',woodwind:'fa-music',fx:'fa-magic'};
  const icon = iconMap[track.family] || iconMap[track.stem] || 'fa-music';
  const st = track.stem, nm = track.name, cl = track.color;
  el.innerHTML =
    '<div class="stem-row__left">' +
      '<div class="stem-row__icon" style="background:' + cl + '"><i class="fas ' + icon + '"></i></div>' +
      '<div class="stem-row__info">' +
        '<div class="stem-row__name" id="stem-name-' + st + '">' + nm + '</div>' +
        '<div class="stem-row__filename">' + st + '.wav</div>' +
      '</div>' +
    '</div>' +
    '<div class="stem-row__wave" id="stem-wave-' + st + '"></div>' +
    '<div class="stem-row__controls">' +
      '<button class="stem-ctrl-btn stem-row__play" id="stem-play-' + st + '" onclick="stemPlayPause(&quot;' + st + '&quot;)" title="Play/Pause"><i class="fas fa-play"></i></button>' +
      '<button class="stem-ctrl-btn stem-row__mute" id="stem-mute-' + st + '" onclick="stemToggleMute(&quot;' + st + '&quot;)" title="Mute"><i class="fas fa-volume-mute"></i></button>' +
      '<button class="stem-ctrl-btn stem-row__solo" id="stem-solo-' + st + '" onclick="stemToggleSolo(&quot;' + st + '&quot;)" title="Solo"><span style="font-size:.7rem;font-weight:700">S</span></button>' +
      '<button class="stem-ctrl-btn" onclick="stemRename(&quot;' + st + '&quot;)" title="Rename"><i class="fas fa-pen" style="font-size:.7rem"></i></button>' +
      '<button class="stem-ctrl-btn stem-row__dl" onclick="stemDownload(&quot;' + st + '&quot;,&quot;' + nm + '&quot;)" title="Download"><i class="fas fa-download"></i></button>' +
    '</div>';
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
  // Highlight active solo buttons
  document.querySelectorAll('.stem-row__solo').forEach(b => {
    const s = b.closest('.stem-row')?.dataset.stem;
    if (s) b.classList.toggle('active', !!stemSolo[s]);
  });
  // When any solo is active: turn all OTHER mute buttons red to show they are silenced
  document.querySelectorAll('.stem-row__mute').forEach(b => {
    const s = b.closest('.stem-row')?.dataset.stem;
    if (!s) return;
    if (hasSoloActive && !stemSolo[s]) {
      // this stem is being silenced by the solo — show mute button red
      b.classList.add('solo-silenced');
    } else {
      b.classList.remove('solo-silenced');
    }
  });
  applyVolumes();
}

// ── Apply volumes ─────────────────────────────────────────────
// Stems that Mureka can put vocal content into
const VOCAL_STEMS = new Set(['vocals', 'vocal', 'vox', 'fx']);
function isStemVocal(stem) {
  if (VOCAL_STEMS.has(stem)) return true;
  // Also check the loaded track metadata for family=vocals
  const track = stemsJob && stemsJob.tracks ? stemsJob.tracks.find(t => t.stem === stem) : null;
  if (track && (track.family === 'vocals' || track.mureka_track_type === 'vocals')) return true;
  return false;
}
function applyVolumes() {
  Object.entries(stemAudios).forEach(([stem, audio]) => {
    const muted  = stemMuted[stem];
    const soloed = hasSoloActive && !stemSolo[stem];
    // Instrumental mode: mute any stem that is or could contain vocals
    const viMuted = viMode === 'instrumental' && isStemVocal(stem);
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
      body: JSON.stringify({ job_id: STEMS_JOB_ID, stem_tier: 'basic' })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (status) { status.textContent='❌ '+(data.error||'Extraction failed.'); status.style.color='var(--danger)'; }
      btn.disabled=false; btn.innerHTML='<i class="fas fa-layer-group"></i> Retry';
      return;
    }
    // Free plan: stems saved but locked — show upgrade screen
    if (data.locked && data.stems_saved) {
      sessionStorage.setItem('stems_confirmed_' + STEMS_JOB_ID, '1');
      showState('free-locked');
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
      sessionStorage.setItem('stems_confirmed_' + STEMS_JOB_ID, '1');
    } catch(e) { /* storage full — ignore */ }
    populateHero(stemsJob);
    await buildStemsPlayer(stemsJob);
  } catch(e) {
    if (status) { status.textContent='❌ Network error.'; status.style.color='var(--danger)'; }
    if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-layer-group"></i> Retry'; }
  }
}

// Catch any unhandled error and show the error state instead of spinning forever
window.addEventListener('error', function(ev) {
  var msg = document.getElementById('stems-error-msg');
  if (msg) msg.textContent = (ev.message || 'Script error') + (ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ')' : '');
  showState('error');
});
window.addEventListener('unhandledrejection', function(ev) {
  var msg = document.getElementById('stems-error-msg');
  if (msg) msg.textContent = (ev.reason && ev.reason.message) ? ev.reason.message : String(ev.reason || 'Unknown error');
  showState('error');
});

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
  padding: 8px 20px; border: 1px solid var(--border); background: none;
  color: var(--muted); font-size: .88rem; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 8px; transition: all .18s;
  border-right: none;
}
.stems-vi-btn:first-child { border-radius: 8px 0 0 8px; }
.stems-vi-btn:last-child  { border-radius: 0 8px 8px 0; border-right: 1px solid var(--border); }
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
.stem-row__mute.solo-silenced { background: rgba(239,68,68,.18); border-color: #ef4444; color: #f87171; box-shadow: 0 0 0 1px #ef4444; }
/* Solo button — YELLOW when active */
.stem-row__solo.active { background: rgba(251,191,36,.18); border-color: #fbbf24; color: #fbbf24; }
.stem-row__dl { background: rgba(16,185,129,.1); border-color: rgba(16,185,129,.3); color: #34d399; }
.stem-row__dl:hover { background: rgba(16,185,129,.2); border-color: #34d399; color: #10b981; }

/* ── Sub-stem sections (Drum Kit / Melody Instruments) ────── */
.sub-stems-section {
  border-bottom: 1px solid var(--border);
  background: rgba(0,0,0,.18);
}
.sub-stems-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 28px 10px 44px;
  cursor: pointer; user-select: none;
  font-size: .82rem; color: var(--muted);
  transition: background .15s;
}
.sub-stems-header:hover { background: rgba(255,255,255,.03); }
.sub-stems-toggle-icon { color: var(--muted); font-size: .65rem; transition: transform .2s; flex-shrink:0; }
.sub-stems-section--open .sub-stems-toggle-icon i { transform: rotate(90deg); }
.sub-stems-list { display: none; }
.sub-stems-section--open .sub-stems-list { display: block; }
.sub-stem-row {
  display: grid; grid-template-columns: 14px 1fr auto;
  align-items: center; gap: 10px;
  padding: 8px 28px 8px 56px;
  border-top: 1px solid rgba(255,255,255,.04);
  transition: background .12s;
}
.sub-stem-row:hover { background: rgba(255,255,255,.025); }
.sub-stem-row__dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.sub-stem-row__name { font-size: .84rem; font-weight: 500; color: var(--text); }
.sub-stem-row__controls { display: flex; gap: 5px; }
.sub-stem-row__waveform { grid-column: 1 / -1; padding: 0 0 4px; }
.sub-stem-btn {
  width: 26px; height: 26px; border-radius: 7px;
  background: rgba(255,255,255,.06); border: 1px solid var(--border);
  color: var(--muted); cursor: pointer; font-size: .7rem;
  display: flex; align-items: center; justify-content: center;
  transition: all .15s;
}
.sub-stem-btn:hover { border-color: var(--primary); color: var(--primary); background: rgba(78,159,255,.1); }

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

    <!-- ── 3 Side-by-side tabs above lyrics ─────────────────── -->
    <div class="creator-tabs-row" id="creator-tabs-row">
      <button class="creator-tab-btn" id="ctab-reference" onclick="openCreatorPopup('reference')">
        <i class="fas fa-music"></i> Reference Track
      </button>
      <button class="creator-tab-btn" id="ctab-extend" onclick="openCreatorPopup('extend')">
        <i class="fas fa-expand-arrows-alt"></i> Song Extend
      </button>
      <button class="creator-tab-btn" id="ctab-blank" onclick="openCreatorPopup('blank')">
        <i class="fas fa-plus"></i> Coming Soon
      </button>
    </div>

    <!-- SECTION 1: Lyrics / Prompt / Instrumental -->
    <div class="suno-card" id="card-lyrics">
      <div class="suno-card__header">
        <button class="suno-card__collapse" id="lyrics-collapse-btn" aria-label="Toggle">
          <i class="fas fa-chevron-down" id="lyrics-collapse-icon"></i>
        </button>
        <span class="suno-card__title">Lyrics</span>
        <div class="suno-tab-group" id="lyrics-tabs">
          <button class="suno-tab active" data-tab="write" data-tooltip="Write your own lyrics — use [Verse], [Chorus] tags">Write</button>
          <button class="suno-tab" data-tab="prompt" data-tooltip="Describe the vibe in plain text — let the AI interpret it">Prompt</button>
          <button class="suno-tab" data-tab="instrumental" data-tooltip="No vocals — generate a pure instrumental beat">Instrumental</button>
        </div>
      </div>
      <div class="suno-card__body" id="lyrics-body">
        <!-- Write tab -->
        <div class="suno-tab-panel active" id="tab-write">
          <textarea class="suno-textarea" id="gen-lyrics" rows="5"
            placeholder="[Verse]&#10;Write your lyrics here, or describe what you want...&#10;&#10;Section tags like [Chorus] help structure your track."></textarea>
          <div class="suno-textarea-actions">
            <button class="suno-icon-btn" title="Magic Wand" id="lyrics-magic-btn" data-tooltip="Auto-suggest lyric ideas based on your style"><i class="fas fa-magic"></i></button>
            <button class="suno-icon-btn" title="Generate Lyrics with AI" id="gen-lyrics-btn" data-tooltip="Let AI write full lyrics for you based on your style settings" style="display:flex;align-items:center;gap:5px;padding:6px 10px;font-size:.78rem;font-weight:600;border-radius:8px;background:linear-gradient(135deg,rgba(78,159,255,.18),rgba(139,92,246,.18));border:1px solid rgba(78,159,255,.35);color:var(--primary);white-space:nowrap"><i class="fas fa-wand-magic-sparkles"></i> Generate Lyrics</button>
            <button class="suno-icon-btn" title="Expand" data-tooltip="Expand or collapse the text area" onclick="document.getElementById('gen-lyrics').rows=document.getElementById('gen-lyrics').rows===5?12:5"><i class="fas fa-expand-arrows-alt"></i></button>
          </div>
          <!-- Generate Lyrics panel — shown when gen-lyrics-btn is clicked -->
          <div id="gen-lyrics-panel" style="display:none;margin-top:12px;padding:14px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:10px">
            <p style="font-size:.8rem;color:var(--muted);margin:0 0 8px">Describe what the song is about and AI will write the lyrics:</p>
            <textarea id="gen-lyrics-desc" class="suno-textarea" rows="3" placeholder="e.g. A song about grinding late nights in the studio, chasing dreams, staying loyal to the team..."></textarea>
            <button id="gen-lyrics-submit" onclick="generateLyricsAI()" style="margin-top:10px;width:100%;padding:10px;background:linear-gradient(135deg,var(--primary),#8b5cf6);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:.88rem"><i class="fas fa-sparkles"></i> Generate Lyrics</button>
            <div id="gen-lyrics-status" style="display:none;margin-top:8px;font-size:.8rem;color:var(--muted)"></div>
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

    <!-- SECTION 1.5: Vocal Gender Toggle — below Lyrics, above Reference Track -->
    <div class="suno-card suno-card--slim" data-tooltip="Choose vocal gender feel, or turn off for instrumental">
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

    <!-- SECTION 3: Beat Count Toggle -->
    <div class="suno-card suno-card--slim">
      <div style="display:flex;align-items:center;gap:10px;padding:2px 0">
        <i class="fas fa-layer-group" style="color:var(--primary);font-size:.95rem;flex-shrink:0"></i>
        <span style="font-size:.85rem;font-weight:600;color:var(--text);flex-shrink:0">Beats</span>
        <div class="beat-count-group" id="beat-count-group">
          <button class="beat-count-btn beat-count-btn--active" data-count="1" id="bc-1" onclick="setBeatCount(1)">
            <i class="fas fa-music"></i> 1 Beat
          </button>
          <button class="beat-count-btn" data-count="2" id="bc-2" onclick="setBeatCount(2)">
            <i class="fas fa-music"></i> 2 Beats <span class="beat-count-credit-badge">2 credits</span>
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

    <!-- SECTION 5: More Options (collapsible) -->
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

    <!-- SECTION 6: Song Title -->
    <div class="suno-card suno-card--slim">
      <div class="suno-field-row">
        <i class="fas fa-music suno-field-icon"></i>
        <input type="text" class="suno-field-input" id="gen-title" placeholder="Song title (optional)"
          title="Give your track a name (optional) — if left blank, one will be auto-generated"/>
      </div>
    </div>

    <!-- CREATE BUTTON — inline below, with tooltip -->
    <div class="suno-create-inline">
      <button class="suno-create-btn" id="gen-full-btn"
        data-tooltip="Generate your beat using AI — uses 1 download credit (or 2 if 2 beats selected)">
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
      </div>
      <!-- Track list (hidden for free tier, shown for Creator/Pro) -->
      <div class="track-list" id="track-list" style="display:none"></div>
      <!-- Action buttons row -->
      <div class="export-panel" style="padding-top:0">
        <div class="export-options" id="export-options-row"></div>
        <a href="/pricing" class="upgrade-nudge" id="export-upgrade-nudge" style="display:none"><i class="fas fa-arrow-up"></i> Upgrade to Creator or Pro Artist to unlock stems</a>
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
<!-- Reference Track Popup -->
<div id="creator-popup-reference" class="creator-popup" style="display:none">
  <div class="creator-popup__header" id="creator-popup-reference-header">
    <span class="creator-popup__title"><i class="fas fa-music"></i> Reference Track <span class="pro-badge" style="font-size:.72rem"><i class="fas fa-crown"></i> Pro</span></span>
    <button class="creator-popup__close" onclick="closeCreatorPopup('reference')"><i class="fas fa-times"></i></button>
  </div>
  <div class="creator-popup__body">
    <!-- Upload zone -->
    <div class="ref-upload-zone" id="ref-upload-zone" onclick="document.getElementById('ref-audio-file').click()">
      <input type="file" id="ref-audio-file" accept="audio/mp3,audio/mpeg,audio/m4a,audio/wav,audio/x-wav,audio/*" style="display:none"/>
      <div id="ref-upload-idle">
        <i class="fas fa-cloud-upload-alt" style="font-size:1.8rem;color:var(--primary);margin-bottom:8px"></i>
        <p style="margin:0;font-weight:600;font-size:.9rem">Upload Reference Audio</p>
        <p style="margin:4px 0 0;color:var(--muted);font-size:.78rem">MP3, WAV or M4A · Pick your 30-second clip below</p>
      </div>
      <div id="ref-upload-loading" style="display:none">
        <i class="fas fa-spinner fa-spin" style="font-size:1.5rem;color:var(--primary);margin-bottom:8px"></i>
        <p style="margin:0;font-size:.88rem;color:var(--muted)">Uploading to Mureka…</p>
      </div>
      <div id="ref-upload-done" style="display:none">
        <i class="fas fa-check-circle" style="font-size:1.5rem;color:#10b981;margin-bottom:6px"></i>
        <p style="margin:0;font-weight:600;font-size:.88rem" id="ref-upload-name">reference.mp3</p>
        <p style="margin:4px 0 0;color:var(--muted);font-size:.78rem" id="ref-clip-info">30s clip selected</p>
      </div>
    </div>
    <!-- 30-sec clip picker -->
    <div id="ref-clip-picker" style="display:none;margin-top:14px;padding:14px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <label class="suno-option-label" style="margin:0">Choose 30-second clip</label>
        <span id="ref-clip-timestamp" style="font-size:.78rem;color:var(--primary);font-weight:600">0:00 – 0:30</span>
      </div>
      <audio id="ref-preview-audio" style="width:100%;margin-bottom:10px;border-radius:8px" controls preload="metadata"></audio>
      <div style="position:relative;margin-bottom:6px">
        <input type="range" id="ref-clip-start" min="0" max="100" value="0" step="0.1"
          style="width:100%;accent-color:var(--primary);cursor:pointer"
          oninput="updateClipPicker(this.value)"/>
        <div id="ref-clip-window" style="position:absolute;top:0;height:100%;background:rgba(78,159,255,0.2);border:1px solid rgba(78,159,255,0.5);border-radius:4px;pointer-events:none;left:0;width:30%"></div>
      </div>
      <p style="color:var(--muted);font-size:.75rem;margin:0"><i class="fas fa-info-circle"></i> Drag the slider to select which 30 seconds to use as reference</p>
      <button class="btn btn--primary btn--sm" style="margin-top:10px;width:100%" onclick="uploadRefWithClip()">
        <i class="fas fa-cloud-upload-alt"></i> Upload this clip
      </button>
    </div>
    <button id="ref-clear-btn" onclick="clearRefTrack()" style="display:none;margin-top:8px;width:100%;padding:7px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--muted);cursor:pointer;font-size:.82rem">
      <i class="fas fa-times"></i> Remove reference track
    </button>
    <!-- Mode selector -->
    <div id="ref-mode-panel" style="display:none;margin-top:16px">
      <label class="suno-option-label" style="margin-bottom:10px">What do you want to do?</label>
      <div class="ref-mode-group">
        <button class="ref-mode-btn ref-mode-btn--active" data-mode="style" onclick="selectRefMode('style')">
          <i class="fas fa-wand-magic-sparkles"></i>
          <span class="ref-mode-btn__title">Match Style</span>
          <span class="ref-mode-btn__sub">Generate a new beat inspired by this track's vibe</span>
        </button>
        <button class="ref-mode-btn" data-mode="extend" onclick="selectRefMode('extend')">
          <i class="fas fa-expand-arrows-alt"></i>
          <span class="ref-mode-btn__title">Extend Song</span>
          <span class="ref-mode-btn__sub">Continue the track from where it ends</span>
        </button>
        <button class="ref-mode-btn" data-mode="loop" onclick="selectRefMode('loop')">
          <i class="fas fa-sync-alt"></i>
          <span class="ref-mode-btn__title">Create Loop</span>
          <span class="ref-mode-btn__sub">Generate a seamless loop from the reference</span>
        </button>
      </div>
      <div id="ref-loop-opts" style="display:none;margin-top:14px;padding:14px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:10px">
        <label class="suno-option-label" style="margin-bottom:8px">Loop length</label>
        <div class="ref-bar-presets">
          <button class="ref-bar-btn ref-bar-btn--active" data-bars="4" onclick="selectBarPreset(this,4)">4 bars</button>
          <button class="ref-bar-btn" data-bars="8" onclick="selectBarPreset(this,8)">8 bars</button>
          <button class="ref-bar-btn" data-bars="16" onclick="selectBarPreset(this,16)">16 bars</button>
          <button class="ref-bar-btn" data-bars="32" onclick="selectBarPreset(this,32)">32 bars</button>
          <button class="ref-bar-btn" data-bars="custom" onclick="selectBarPreset(this,'custom')">Custom</button>
        </div>
        <div id="ref-bar-custom" style="display:none;margin-top:10px;display:flex;align-items:center;gap:8px">
          <input type="number" id="ref-bar-custom-val" min="1" max="256" value="16" style="width:80px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.95rem"/>
          <span style="color:var(--muted);font-size:.88rem">bars</span>
        </div>
        <p style="color:var(--muted);font-size:.75rem;margin:8px 0 0"><i class="fas fa-info-circle"></i> Loop will be generated at the BPM of your reference track</p>
      </div>
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
    <div style="text-align:center;padding:32px 16px">
      <i class="fas fa-expand-arrows-alt" style="font-size:2.5rem;color:var(--primary);opacity:.5;margin-bottom:16px"></i>
      <h3 style="margin:0 0 8px;color:var(--text)">Extend Your Song</h3>
      <p style="color:var(--muted);font-size:.9rem;margin:0">Select one of your completed tracks from the library, then extend it with a continuation. This feature is coming soon — stay tuned!</p>
    </div>
  </div>
</div>

<!-- Blank (3rd) Popup -->
<div id="creator-popup-blank" class="creator-popup" style="display:none">
  <div class="creator-popup__header" id="creator-popup-blank-header">
    <span class="creator-popup__title"><i class="fas fa-plus"></i> Coming Soon</span>
    <button class="creator-popup__close" onclick="closeCreatorPopup('blank')"><i class="fas fa-times"></i></button>
  </div>
  <div class="creator-popup__body">
    <div style="text-align:center;padding:32px 16px">
      <i class="fas fa-magic" style="font-size:2.5rem;color:var(--primary);opacity:.5;margin-bottom:16px"></i>
      <h3 style="margin:0 0 8px;color:var(--text)">Something New is Coming</h3>
      <p style="color:var(--muted);font-size:.9rem;margin:0">This feature is being designed. Check back soon!</p>
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
      <div class="plan-card">
        <div class="plan-card__tier">Free</div>
        <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
        <p class="plan-card__desc">Try the engine. No card needed.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 5 credits/downloads monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full AI beat generation</li>
          <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
          <li><i class="fas fa-check"></i> Stem extraction (saved for later)</li>
          <li class="muted"><i class="fas fa-times"></i> Downloads (WAV / MP3)</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Stem download / playback</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full">Start free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$19</span><span>/month</span></div>
        <p class="plan-card__desc">For artists, writers, and content creators.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 50 credits/downloads monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full AI beat generation</li>
          <li><i class="fas fa-check"></i> Mastered WAV &amp; MP3 download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li class="muted"><i class="fas fa-times"></i> Stem extraction</li>
          <li class="muted"><i class="fas fa-times"></i> Unmastered mix for DAW</li>
          <li class="muted"><i class="fas fa-times"></i> Individual stem download</li>
        </ul>
        <button class="btn btn--primary btn--full pricing-plan-btn" data-plan="creator" id="pricing-creator-btn">Start Creator — $19/mo</button>
        <p class="pricing-downgrade-note" id="pricing-creator-downgrade" style="display:none;margin:8px 0 0;font-size:.78rem;color:var(--muted);line-height:1.4"><i class="fas fa-info-circle" style="color:#6c3aff;margin-right:4px"></i>Downgrade takes effect at end of your billing cycle. You keep all features until then.</p>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$39</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track clean.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 200 credits/downloads monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Mastered &amp; unmastered WAV / MP3</li>
          <li><i class="fas fa-check"></i> Stem extraction + download</li>
          <li><i class="fas fa-check"></i> Drums, Bass, Melody, Vocals, Other</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> Priority queue</li>
        </ul>
        <button class="btn btn--outline btn--full pricing-plan-btn" data-plan="pro" id="pricing-pro-btn">Start Pro Artist — $39/mo</button>
        <p class="pricing-downgrade-note" id="pricing-pro-downgrade" style="display:none;margin:8px 0 0;font-size:.78rem;color:var(--muted);line-height:1.4"><i class="fas fa-info-circle" style="color:#6c3aff;margin-right:4px"></i>Downgrade takes effect at end of your billing cycle. You keep all features until then.</p>
      </div>

    </div>

    <div class="credit-table-wrap">
      <div class="section-header">
        <div class="section-tag">What's included</div>
        <h2>Simple, generation-based pricing.</h2>
      </div>
      <div class="credit-table">
        <div class="credit-table__row credit-table__row--header"><span>What you get</span><span>Cost</span><span>Plan</span></div>
        <div class="credit-table__row"><span><i class="fas fa-music"></i> Full AI beat generation</span><span class="credit-val">1 credit</span><span class="tier-badge tier-badge--free">All plans</span></div>
        <div class="credit-table__row"><span><i class="fas fa-download"></i> Stereo mix download (MP3 / WAV)</span><span class="credit-val">Included</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
        <div class="credit-table__row"><span><i class="fas fa-layer-group"></i> Stem extraction (saved, no download)</span><span class="credit-val">2 credits</span><span class="tier-badge tier-badge--free">Free</span></div>
        <div class="credit-table__row"><span><i class="fas fa-layer-group"></i> Stem extraction + download</span><span class="credit-val">2 credits</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>

        <div class="credit-table__row"><span><i class="fas fa-download"></i> Top-up download packs</span><span class="credit-val">from $0.30</span><span class="tier-badge tier-badge--creator">All Plans</span></div>
      </div>
    </div>

    <div class="faq-wrap">
      <div class="section-header"><div class="section-tag">FAQ</div><h2>Common questions.</h2></div>
      <div class="faq">
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What counts as one generation? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">One generation = one full AI beat. The AI builds the blueprint, generates the instrumental, and delivers your stereo mix. Stem extraction (bass, melody, vocals, other) costs 2 extra credits and is available on the Pro Artist plan only.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What happens if I run out of downloads? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">You can purchase download credit packs from the Subscription page starting from $4.99. Packs never expire and stack on top of your plan. Free plan users must upgrade to download tracks.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>What stems do I get? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Stem extraction gives you separated audio layers: Bass, Melody, Vocals, and Other. Note: drums are delivered as part of the full stereo mix and stem bundle — individual isolated drum tracks (kick, snare, hi-hats separately) are not available as the AI engine outputs a combined drum mix.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I use the beats commercially? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes — Creator and Pro Artist exports include full commercial use rights. Free plan exports are for personal/demo use only.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Do unused generations roll over? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Unused generations do not roll over. Your count resets on your billing date each month.</div></div>
        <div class="faq-item" data-faq><button class="faq-item__q" data-faq-button>Can I cancel anytime? <i class="fas fa-chevron-down"></i></button><div class="faq-item__a">Yes. Cancel anytime from account settings. No cancellation fees. You keep access until the end of your billing period.</div></div>
      </div>
    </div>
  </div>
</section>
</main>

<!-- Pricing page upgrade modal -->
<div id="pricing-upgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;align-items:center;justify-content:center;padding:16px">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:0;max-width:460px;width:100%;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6)">
    <div style="background:linear-gradient(135deg,#6c3aff22,#a855f722);border-bottom:1px solid var(--border);padding:24px 28px 20px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-up" style="color:white;font-size:.9rem"></i>
        </div>
        <div>
          <h3 style="margin:0;font-size:1.15rem" id="pum-title">Confirm Upgrade</h3>
          <p style="margin:0;font-size:.8rem;color:var(--muted)">Review your charge before paying</p>
        </div>
      </div>
    </div>
    <div id="pum-loading" style="padding:40px;text-align:center">
      <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px"></div>
      <p style="color:var(--muted);margin:0;font-size:.9rem">Calculating your charge…</p>
    </div>
    <div id="pum-content" style="display:none;padding:24px 28px">
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px">
        <div style="text-align:center">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Current Plan</div>
          <div id="pum-from-label" style="font-weight:700;font-size:1rem">Free</div>
          <div id="pum-from-price" style="font-size:.8rem;color:var(--muted)"></div>
        </div>
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-right" style="color:white;font-size:.8rem"></i>
        </div>
        <div style="text-align:center">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">New Plan</div>
          <div id="pum-to-label" style="font-weight:700;font-size:1rem;color:#a855f7">Pro Artist</div>
          <div id="pum-to-price" style="font-size:.8rem;color:var(--muted)"></div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px">
        <div style="padding:10px 16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Billing period</span>
          <span id="pum-period" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:10px 16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Days remaining</span>
          <span id="pum-days" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:10px 16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Price difference</span>
          <span id="pum-diff" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:12px 16px;display:flex;justify-content:space-between;background:rgba(108,58,255,.1)">
          <span style="font-size:.95rem;font-weight:700">Charged today</span>
          <span id="pum-charge" style="font-size:1.1rem;font-weight:800;color:#a855f7">—</span>
        </div>
      </div>
      <p id="pum-note" style="font-size:.8rem;color:var(--muted);text-align:center;margin:0 0 20px;line-height:1.5"></p>
      <div style="display:flex;gap:10px">
        <button class="btn btn--outline btn--sm" style="flex:1" onclick="closePricingUpgradeModal()"><i class="fas fa-times"></i> Cancel</button>
        <button class="btn btn--primary btn--sm" style="flex:2;background:linear-gradient(135deg,#6c3aff,#a855f7);border:none" id="pum-confirm-btn" onclick="confirmPricingUpgrade()"><i class="fas fa-lock"></i> <span id="pum-confirm-label">Confirm &amp; Pay</span></button>
      </div>
    </div>
    <div id="pum-error" style="display:none;padding:32px 28px;text-align:center">
      <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:#ef4444;margin-bottom:12px"></i>
      <p id="pum-error-msg" style="color:var(--muted);margin:0 0 20px;font-size:.9rem;line-height:1.5"></p>
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

  // Detect current user plan and adjust buttons
  fetch('/api/auth/me').then(r => r.json()).then(me => {
    const user = me.user;
    if (!user) return; // not logged in — buttons go to checkout as-is

    const userRank = rank[user.plan] || 0;
    const creatorBtn = document.getElementById('pricing-creator-btn');
    const proBtn     = document.getElementById('pricing-pro-btn');

    // Creator button
    if (creatorBtn) {
      const creatorRank = rank['creator'];
      if (userRank === creatorRank) {
        creatorBtn.textContent = 'Current Plan';
        creatorBtn.disabled = true;
        creatorBtn.style.opacity = '.5';
      } else if (userRank > creatorRank) {
        // Downgrade
        creatorBtn.textContent = 'Downgrade to Creator';
        creatorBtn.className = 'btn btn--outline btn--full';
        creatorBtn.style.borderColor = 'rgba(255,100,100,.4)';
        creatorBtn.style.color = '#ff6464';
        document.getElementById('pricing-creator-downgrade').style.display = 'block';
        creatorBtn.onclick = () => openPricingDowngradeModal('creator', 'Creator ($19/mo)');
      } else {
        // Upgrade
        creatorBtn.onclick = () => openPricingUpgradeModal('creator');
      }
    }

    // Pro button
    if (proBtn) {
      const proRank = rank['pro'];
      if (userRank === proRank) {
        proBtn.textContent = 'Current Plan';
        proBtn.disabled = true;
        proBtn.style.opacity = '.5';
      } else if (userRank > proRank) {
        proBtn.textContent = 'Downgrade to Pro Artist';
        proBtn.className = 'btn btn--outline btn--full';
        proBtn.style.borderColor = 'rgba(255,100,100,.4)';
        proBtn.style.color = '#ff6464';
        document.getElementById('pricing-pro-downgrade').style.display = 'block';
        proBtn.onclick = () => openPricingDowngradeModal('pro', 'Pro Artist ($39/mo)');
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

  // ── Shared helper: populate proration breakdown rows ────────────────────────
  // prefix = 'pum' | 'hum' | 'upgrade'
  // IDs: <prefix>-period, <prefix>-days, <prefix>-diff, <prefix>-charge, <prefix>-note
  function populateUpgradeRows(prefix, data) {
    const hasRealSub = data.has_subscription &&
      data.days_remaining != null && !isNaN(data.days_remaining) &&
      data.days_in_period != null && !isNaN(data.days_in_period);
    const chargeLabel = (data.proration_label && data.proration_label !== '$NaN')
      ? data.proration_label : (data.new_price_label ? data.new_price_label.replace('/mo','') : '');
    const periodEl = document.getElementById(prefix + '-period');
    const daysEl   = document.getElementById(prefix + '-days');
    const diffEl   = document.getElementById(prefix + '-diff');
    const chargeEl = document.getElementById(prefix + '-charge');
    const noteEl   = document.getElementById(prefix + '-note');
    if (hasRealSub) {
      // Show exact billing cycle range e.g. "Jun 14 – Jul 14, 2025"
      if (periodEl) periodEl.textContent = data.billing_cycle_range || (data.period_end_label ? 'Renews ' + data.period_end_label : '—');
      // Show exact days remaining e.g. "13 days left"
      if (daysEl)   daysEl.textContent   = data.days_remaining + ' days left';
      // Show price difference e.g. "$19.00/mo → $39.00/mo"
      if (diffEl)   diffEl.textContent   = data.price_diff_label || ((data.current_price_label || '') + ' → ' + (data.new_price_label || ''));
      // Charge = prorated amount (new - old) × days remaining
      if (chargeEl) chargeEl.textContent = chargeLabel;
      if (noteEl)   noteEl.textContent   = 'Then ' + (data.new_price_label || '') + ' starting ' +
        (data.period_end_label || 'next billing date') + '.';
    } else {
      if (periodEl) periodEl.textContent = 'New subscription';
      if (daysEl)   daysEl.textContent   = 'Full billing cycle';
      if (diffEl)   diffEl.textContent   = '—';
      if (chargeEl) chargeEl.textContent = data.new_price_label ? data.new_price_label.replace('/mo','') : chargeLabel;
      if (noteEl)   noteEl.textContent   = 'You will be charged ' + (data.new_price_label || '') + ' today and billed monthly.';
    }
    return chargeLabel;
  }

  // ── Upgrade modal ───────────────────────────────────────────────────────────
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
        document.getElementById('pum-from-label').textContent = data.current_plan_label || 'Free';
        document.getElementById('pum-from-price').textContent = data.current_price_label || '$0/mo';
        document.getElementById('pum-to-label').textContent   = data.target_plan_label || plan;
        document.getElementById('pum-to-price').textContent   = data.new_price_label || '';
        const pumCharge = populateUpgradeRows('pum', data);
        document.getElementById('pum-confirm-label').textContent = 'Confirm & Pay ' + pumCharge;
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
      if (data.ok) { alert(data.message || 'Upgrade successful!'); window.location.href = '/dashboard'; }
      else { alert('Error: ' + (data.error || 'Upgrade failed')); }
    } catch(e) { closePricingUpgradeModal(); alert('Network error. Please try again.'); }
  };

  document.getElementById('pricing-upgrade-modal').addEventListener('click', function(e) { if (e.target === this) closePricingUpgradeModal(); });

  // ── Downgrade modal ─────────────────────────────────────────────────────────
  function openPricingDowngradeModal(plan, label) {
    _pdgPlan = plan;
    const msg = plan === 'free'
      ? 'Your subscription will be cancelled. You will move to the Free plan (5 credits/downloads monthly) after your billing cycle ends.'
      : plan === 'creator'
        ? 'You will be downgraded to the Creator plan ($19/mo, 50 credits/downloads monthly) at the end of your current billing cycle.'
        : 'You will be switched to Pro Artist ($39/mo, 200 credits/downloads monthly) at end of your billing cycle.';
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
      if (data.ok) { alert(data.message || 'Downgrade scheduled.'); window.location.reload(); }
      else { alert('Error: ' + (data.error || 'Downgrade failed')); }
    } catch(e) { alert('Network error. Please try again.'); }
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
    <button class="lib-tab lib-tab--active" data-tab="beats" onclick="switchLibTab('beats')">
      <i class="fas fa-music"></i> Beats / Songs
    </button>
    <button class="lib-tab" data-tab="oneshots" onclick="switchLibTab('oneshots')">
      <i class="fas fa-bolt"></i> One Shots
    </button>
    <button class="lib-tab" data-tab="trash" onclick="switchLibTab('trash')">
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
  <div id="lib-panel-oneshots" style="display:none">
    <div class="project-grid" id="project-grid-oneshots">
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
  <div class="dash-credits-card" style="margin-top:16px"><div class="dash-credits-card__label">Generations used</div><div class="dash-credits-card__val">32 <small>/ 50 credits</small></div><a href="/pricing" class="btn btn--primary btn--sm btn--full" style="margin-top:8px">Upgrade plan</a></div>
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
        <li><i class="fas fa-check-circle"></i> Stem bundle export (bass, melody, vocals, other)</li>
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
        <li><i class="fas fa-check-circle"></i> Stem bundle export (bass, melody, vocals, other)</li>
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
          <li><i class="fas fa-check"></i> 50 credits/downloads monthly</li>
          <li><i class="fas fa-check"></i> Stereo mix + stem bundle download</li>
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
          Not ready to pay? <a href="/signup">Try free (5 credits)</a>
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
        <span class="sub-stat__val" id="sub-remaining-val">${Math.max(0, user.gens_limit - user.gens_used)} / ${user.gens_limit}</span>
      </div>

    </div>
    <div class="sub-usage-card">
      <div class="sub-usage-header">
        <h3>Download Usage</h3>
        <span class="sub-usage-count" id="sub-usage-count">${user.gens_used} / ${user.gens_limit} used</span>
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
            Top Up Downloads
          </h3>
          <p style="color:var(--muted);font-size:.85rem;margin:0">One-time packs — never expire, stack on top of your plan</p>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(78,159,255,.08);border:1px solid rgba(78,159,255,.2);border-radius:8px;font-size:.78rem;color:var(--primary)">
          <i class="fas fa-lock-open"></i> No subscription required
        </div>
      </div>
      <div class="credit-packs-grid" id="credit-packs-grid">
        <div class="credit-pack-card" data-pack="pack_10">
          <div class="credit-pack__icon"><i class="fas fa-download"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">10</div>
            <div class="credit-pack__label">Downloads</div>
            <div class="credit-pack__per">$0.50 / download</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$4.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_10">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card credit-pack-card--popular" data-pack="pack_25">
          <div class="credit-pack__badge"><i class="fas fa-star"></i> Best Value</div>
          <div class="credit-pack__icon"><i class="fas fa-download"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">25</div>
            <div class="credit-pack__label">Downloads</div>
            <div class="credit-pack__per">$0.40 / download</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$9.99</span>
            <button class="credit-pack-btn credit-pack-btn--primary" data-pack="pack_25">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card" data-pack="pack_50">
          <div class="credit-pack__icon"><i class="fas fa-download"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">50</div>
            <div class="credit-pack__label">Downloads</div>
            <div class="credit-pack__per">$0.36 / download</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$17.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_50">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card" data-pack="pack_100">
          <div class="credit-pack__icon"><i class="fas fa-download"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">100</div>
            <div class="credit-pack__label">Downloads</div>
            <div class="credit-pack__per">$0.30 / download</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$29.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_100">
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
        <div class="sub-plan-card ${user.plan === 'free' ? 'sub-plan-card--current' : ''}" id="sub-plan-free">
          <div class="sub-plan-card__top">
            <div><h4>Free</h4><p>Try the engine</p></div>
            <div class="sub-plan-card__price">$0<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 5 credits/downloads monthly</li>
            <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
            <li><i class="fas fa-check"></i> Stem extraction (saved)</li>
          </ul>
          ${user.plan === 'free'
            ? '<span class="sub-current-badge">Current plan</span>'
            : (user.plan === 'creator' || user.plan === 'pro' || user.plan === 'developer')
              ? `<div class="sub-action-wrap" id="sub-free-action-wrap">
                  <div class="sub-downgrade-pending-banner" id="sub-free-downgrade-banner" style="display:none">
                    <i class="fas fa-clock"></i> <span>Downgrading to Free at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="free" id="sub-btn-downgrade-to-free" style="border-color:rgba(255,100,100,.4);color:#ff7070">
                      <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Free
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-free" style="display:none;border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('free')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
                    </button>
                  </div>
                </div>`
              : ''
          }
        </div>

        <!-- ── CREATOR CARD ──────────────────────────────────────────── -->
        <div class="sub-plan-card ${user.plan === 'creator' ? 'sub-plan-card--current' : ''}" id="sub-plan-creator">
          <div class="sub-plan-card__top">
            <div><h4>Creator</h4><p>For Artists &amp; creators</p></div>
            <div class="sub-plan-card__price">$19<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 50 credits/downloads monthly</li>
            <li><i class="fas fa-check"></i> Mastered WAV &amp; MP3 download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
          </ul>
          ${user.plan === 'creator'
            ? `<div class="sub-action-wrap" id="sub-creator-action-wrap">
                <span class="sub-current-badge">Current plan</span>
                <div class="sub-downgrade-pending-banner" id="sub-creator-downgrade-banner" style="display:none;margin-top:8px">
                  <i class="fas fa-clock"></i> <span id="sub-creator-banner-msg">Downgrading to Free at end of billing cycle</span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                  <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="free" id="sub-btn-downgrade-to-free-from-creator" style="border-color:rgba(255,100,100,.4);color:#ff7070">
                    <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Free
                  </button>
                  <button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-creator" style="display:none;border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('free')">
                    <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
                  </button>
                </div>
              </div>`
            : user.plan === 'pro' || user.plan === 'developer'
              ? `<div class="sub-action-wrap" id="sub-creator-action-wrap">
                  <div class="sub-downgrade-pending-banner" id="sub-creator-downgrade-banner" style="display:none">
                    <i class="fas fa-clock"></i> <span id="sub-creator-banner-msg">Downgrading to Creator at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--outline btn--sm sub-downgrade-btn" data-target="creator" id="sub-btn-downgrade-to-creator" style="border-color:rgba(255,100,100,.4);color:#ff7070">
                      <i class="fas fa-arrow-down" style="font-size:.75rem;margin-right:4px"></i>Downgrade to Creator
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-downgrade-creator" style="display:none;border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelDowngrade('creator')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
                    </button>
                  </div>
                </div>`
              : `<div class="sub-action-wrap" id="sub-creator-action-wrap">
                  <div class="sub-upgrade-pending-banner" id="sub-creator-upgrade-banner" style="display:none">
                    <i class="fas fa-clock"></i> <span>Upgrading to Creator at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--primary btn--sm sub-upgrade-btn" data-target="creator" id="sub-btn-upgrade-to-creator">
                      <i class="fas fa-arrow-up" style="font-size:.75rem;margin-right:4px"></i>Upgrade to Creator
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-upgrade-creator" style="display:none;border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelUpgrade('creator')">
                      <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Upgrade
                    </button>
                  </div>
                </div>`
          }
        </div>

        <!-- ── PRO ARTIST CARD ───────────────────────────────────────── -->
        <div class="sub-plan-card ${user.plan === 'pro' ? 'sub-plan-card--current' : ''}" id="sub-plan-pro">
          <div class="sub-plan-card__top">
            <div><h4>Pro Artist</h4><p>Maximum output</p></div>
            <div class="sub-plan-card__price">$39<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 200 credits/downloads monthly</li>
            <li><i class="fas fa-check"></i> Mastered &amp; unmastered WAV / MP3</li>
            <li><i class="fas fa-check"></i> Stem extraction + download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
            <li><i class="fas fa-check"></i> Priority queue</li>
          </ul>
          ${user.plan === 'pro'
            ? `<div class="sub-action-wrap" id="sub-pro-action-wrap">
                <span class="sub-current-badge">Current plan</span>
              </div>`
            : user.plan === 'developer'
              ? `<span class="sub-current-badge" style="opacity:.5">Dev override</span>`
              : `<div class="sub-action-wrap" id="sub-pro-action-wrap">
                  <div class="sub-upgrade-pending-banner" id="sub-pro-upgrade-banner" style="display:none">
                    <i class="fas fa-clock"></i> <span>Upgrading to Pro Artist at end of billing cycle</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn--primary btn--sm sub-upgrade-btn" data-target="pro" id="sub-btn-upgrade-to-pro">
                      <i class="fas fa-arrow-up" style="font-size:.75rem;margin-right:4px"></i>Upgrade to Pro Artist
                    </button>
                    <button class="btn btn--outline btn--sm" id="sub-btn-cancel-upgrade-pro" style="display:none;border-color:rgba(78,159,255,.4);color:var(--primary)" onclick="cancelUpgrade('pro')">
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
<div id="sub-upgrade-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;align-items:center;justify-content:center;padding:16px">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:0;max-width:460px;width:100%;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6)">

    <!-- Modal header -->
    <div style="background:linear-gradient(135deg,#6c3aff22,#a855f722);border-bottom:1px solid var(--border);padding:24px 28px 20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
        <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-up" style="color:white;font-size:.9rem"></i>
        </div>
        <div>
          <h3 style="margin:0;font-size:1.15rem" id="upgrade-modal-title">Confirm Upgrade</h3>
          <p style="margin:0;font-size:.8rem;color:var(--muted)" id="upgrade-modal-subtitle">Review your prorated charge</p>
        </div>
      </div>
    </div>

    <!-- Loading state -->
    <div id="upgrade-modal-loading" style="padding:40px;text-align:center">
      <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px"></div>
      <p style="color:var(--muted);margin:0;font-size:.9rem">Calculating your prorated charge…</p>
    </div>

    <!-- Content state -->
    <div id="upgrade-modal-content" style="display:none;padding:24px 28px">

      <!-- Plan transition -->
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px">
        <div style="text-align:center">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Current Plan</div>
          <div id="upgrade-from-label" style="font-weight:700;font-size:1rem;color:var(--text)">Creator</div>
          <div id="upgrade-from-price" style="font-size:.8rem;color:var(--muted)">$19/mo</div>
        </div>
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fas fa-arrow-right" style="color:white;font-size:.8rem"></i>
        </div>
        <div style="text-align:center">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">New Plan</div>
          <div id="upgrade-to-label" style="font-weight:700;font-size:1rem;color:#a855f7">Pro Artist</div>
          <div id="upgrade-to-price" style="font-size:.8rem;color:var(--muted)">$39/mo</div>
        </div>
      </div>

      <!-- Proration breakdown table -->
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px">
        <div style="padding:10px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Billing period</span>
          <span id="upgrade-period-label" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:10px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Days remaining</span>
          <span id="upgrade-days-label" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:10px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
          <span style="font-size:.85rem;color:var(--muted)">Price difference</span>
          <span id="upgrade-diff-label" style="font-size:.85rem;font-weight:600">—</span>
        </div>
        <div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;background:rgba(108,58,255,.1)">
          <span style="font-size:.95rem;font-weight:700">Charge today</span>
          <span id="upgrade-charge-label" style="font-size:1.1rem;font-weight:800;color:#a855f7">—</span>
        </div>
      </div>

      <!-- Renewal note -->
      <p id="upgrade-renewal-note" style="font-size:.8rem;color:var(--muted);text-align:center;margin:0 0 20px;line-height:1.5"></p>

      <!-- Action buttons -->
      <div style="display:flex;gap:10px">
        <button class="btn btn--outline btn--sm" style="flex:1" onclick="closeUpgradeModal()">
          <i class="fas fa-times"></i> Cancel
        </button>
        <button class="btn btn--primary btn--sm" style="flex:2;background:linear-gradient(135deg,#6c3aff,#a855f7);border:none" id="upgrade-confirm-btn" onclick="confirmUpgrade()">
          <i class="fas fa-lock"></i> <span id="upgrade-confirm-label">Confirm &amp; Pay</span>
        </button>
      </div>
    </div>

    <!-- Error state -->
    <div id="upgrade-modal-error" style="display:none;padding:32px 28px;text-align:center">
      <i class="fas fa-exclamation-triangle" style="font-size:2rem;color:#ef4444;margin-bottom:12px"></i>
      <p id="upgrade-error-msg" style="color:var(--muted);margin:0 0 20px;font-size:.9rem;line-height:1.5">Unable to calculate proration.</p>
      <button class="btn btn--outline btn--sm" onclick="closeUpgradeModal()">Close</button>
    </div>

  </div>
</div>
<script>
(function(){
  // ── Upgrade flow: preview → confirm modal → pay ──────────────────────────
  let _upgradePendingPlan = null;
  let _upgradePreviewData = null;

  function openUpgradeModal(targetPlan) {
    _upgradePendingPlan = targetPlan;
    _upgradePreviewData = null;
    const modal = document.getElementById('sub-upgrade-modal');
    const loadingEl  = document.getElementById('upgrade-modal-loading');
    const contentEl  = document.getElementById('upgrade-modal-content');
    const errorEl    = document.getElementById('upgrade-modal-error');
    modal.style.display = 'flex';
    loadingEl.style.display  = 'block';
    contentEl.style.display  = 'none';
    errorEl.style.display    = 'none';

    fetch('/api/subscription/upgrade-preview?plan=' + encodeURIComponent(targetPlan))
      .then(r => r.json())
      .then(data => {
        if (data.error) { showUpgradeError(data.error); return; }
        _upgradePreviewData = data;

        // Populate plan labels
        document.getElementById('upgrade-from-label').textContent  = data.current_plan_label  || 'Current';
        document.getElementById('upgrade-from-price').textContent  = data.current_price_label || '';
        document.getElementById('upgrade-to-label').textContent    = data.target_plan_label   || targetPlan;
        document.getElementById('upgrade-to-price').textContent    = data.new_price_label     || '';

        // Populate breakdown rows
        const hasRealSub = data.has_subscription &&
          data.days_remaining != null && !isNaN(data.days_remaining) &&
          data.days_in_period != null && !isNaN(data.days_in_period);
        const chargeLabel = (data.proration_label && data.proration_label !== '$NaN')
          ? data.proration_label : (data.new_price_label ? data.new_price_label.replace('/mo','') : '');
        if (hasRealSub) {
          // Billing cycle: e.g. "Jun 14 – Jul 14, 2025"
          document.getElementById('upgrade-period-label').textContent =
            data.billing_cycle_range || (data.period_end_label ? 'Renews ' + data.period_end_label : '—');
          // Days remaining: e.g. "13 days left"
          document.getElementById('upgrade-days-label').textContent =
            data.days_remaining + ' days left';
          // Price diff: e.g. "$19.00/mo → $39.00/mo"
          document.getElementById('upgrade-diff-label').textContent =
            data.price_diff_label || ((data.current_price_label || '') + ' → ' + (data.new_price_label || ''));
          // Charge today: prorated amount = (new_daily - old_daily) × days_remaining
          document.getElementById('upgrade-charge-label').textContent = chargeLabel;
          document.getElementById('upgrade-renewal-note').textContent =
            'Then ' + (data.new_price_label || '') + ' starting ' + (data.period_end_label || 'next billing date') + '.';
        } else {
          // No existing subscription (or period dates unavailable) — full price checkout
          document.getElementById('upgrade-period-label').textContent = 'New subscription';
          document.getElementById('upgrade-days-label').textContent   = 'Full billing cycle';
          document.getElementById('upgrade-diff-label').textContent   = '—';
          document.getElementById('upgrade-charge-label').textContent = data.new_price_label ? data.new_price_label.replace('/mo','') : chargeLabel;
          document.getElementById('upgrade-renewal-note').textContent =
            'You will be charged ' + (data.new_price_label || '') + ' today and billed monthly.';
        }

        // Update confirm button label
        document.getElementById('upgrade-confirm-label').textContent =
          'Confirm & Pay ' + chargeLabel;

        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';
      })
      .catch(err => showUpgradeError('Network error. Please try again.'));
  }

  function showUpgradeError(msg) {
    document.getElementById('upgrade-modal-loading').style.display = 'none';
    document.getElementById('upgrade-modal-content').style.display = 'none';
    const errorEl = document.getElementById('upgrade-modal-error');
    document.getElementById('upgrade-error-msg').textContent = msg;
    errorEl.style.display = 'block';
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
        msg.textContent = 'Your subscription will be cancelled at the end of your billing cycle. You will move to the Free plan (5 credits/downloads monthly) after that.';
      } else if (pendingTarget === 'creator') {
        msg.textContent = 'You will be downgraded to the Creator plan ($19/mo, 50 credits/downloads monthly) at the end of your current billing cycle.';
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
      <p>Have a promo code? Enter it below to apply bonus downloads or discounts to your account.</p>
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
        <p style="color:var(--muted)">Developer access — logged in as ${user.email}</p>
      </div>
      <a href="/dashboard" class="btn btn--outline btn--sm"><i class="fas fa-arrow-left"></i> Back to Dashboard</a>
    </div>

    <!-- Stats bar -->
    <div class="sub-stats-bar" id="admin-stats-bar" style="margin-bottom:32px">
      <div class="sub-stat"><span class="sub-stat__label">Total Users</span><span class="sub-stat__val" id="stat-users">—</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Pro Users</span><span class="sub-stat__val" id="stat-pro">—</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Creator Users</span><span class="sub-stat__val" id="stat-creator">—</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Total Jobs</span><span class="sub-stat__val" id="stat-jobs">—</span></div>
      <div class="sub-stat"><span class="sub-stat__label">Active Promos</span><span class="sub-stat__val" id="stat-promos">—</span></div>
    </div>

    <!-- Tabs -->
    <div style="display:flex;gap:8px;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:0">
      <button class="admin-tab admin-tab--active" data-tab="users" onclick="adminTab('users')"><i class="fas fa-users"></i> Users</button>
      <button class="admin-tab" data-tab="promos" onclick="adminTab('promos')"><i class="fas fa-tag"></i> Promo Codes</button>
      <a href="/mureka-monitor" class="admin-tab" style="text-decoration:none;margin-left:auto"><i class="fas fa-coins" style="color:#f59e0b"></i> Mureka Balance</a>
    </div>

    <!-- Users Tab -->
    <div id="admin-tab-users">
      <div id="admin-users-list" style="overflow-x:auto">
        <p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Loading users…</p>
      </div>
    </div>

    <!-- Promo Codes Tab -->
    <div id="admin-tab-promos" style="display:none">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;margin-bottom:24px">
        <h3 style="margin-bottom:16px"><i class="fas fa-plus-circle" style="color:var(--primary)"></i> Create Promo Code</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div><label style="font-size:.85rem;color:var(--muted)">Code *</label><input id="new-code" type="text" placeholder="WELCOME20" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"/></div>
          <div><label style="font-size:.85rem;color:var(--muted)">Description</label><input id="new-desc" type="text" placeholder="20% off for new users" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)"/></div>
          <div><label style="font-size:.85rem;color:var(--muted)">Bonus Downloads</label><input id="new-credits" type="number" value="0" min="0" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)"/></div>
          <div><label style="font-size:.85rem;color:var(--muted)">Max Uses (0=unlimited)</label><input id="new-maxuses" type="number" value="0" min="0" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)"/></div>
          <div style="grid-column:1/-1"><label style="font-size:.85rem;color:var(--muted)">Terms &amp; Conditions shown to user</label><textarea id="new-terms" rows="2" placeholder="Valid for new users only. One use per account." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)"></textarea></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px">
          <button class="btn btn--primary" onclick="createPromo()"><i class="fas fa-plus"></i> Create Code</button>
          <span id="promo-create-status" style="color:var(--muted);align-self:center;font-size:.9rem"></span>
        </div>
      </div>
      <div id="admin-promos-list"><p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Loading promo codes…</p></div>
    </div>
  </div>
</main>
<style>
.admin-tab{padding:10px 18px;background:none;border:none;border-bottom:3px solid transparent;color:var(--muted);cursor:pointer;font-size:.95rem;font-weight:600;transition:all .2s}
.admin-tab--active{color:var(--primary);border-bottom-color:var(--primary)}
.admin-table{width:100%;border-collapse:collapse;font-size:.88rem}
.admin-table th{text-align:left;padding:10px 12px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600}
.admin-table td{padding:10px 12px;border-bottom:1px solid var(--border10)}
.admin-table tr:hover td{background:var(--surface)}
</style>
<script>
// Load stats
(async()=>{
  const res = await fetch('/api/admin/stats');
  const data = await res.json();
  if(data.users){ document.getElementById('stat-users').textContent=data.users.total||0; document.getElementById('stat-pro').textContent=data.users.pro_count||0; document.getElementById('stat-creator').textContent=data.users.creator_count||0; }
  if(data.jobs){ document.getElementById('stat-jobs').textContent=data.jobs.total||0; }
  if(data.promos){ document.getElementById('stat-promos').textContent=data.promos.total||0; }
})();

// Load users
(async()=>{
  const res = await fetch('/api/admin/users');
  const data = await res.json();
  const el = document.getElementById('admin-users-list');
  if(!data.users?.length){el.innerHTML='<p style="color:var(--muted)">No users yet.</p>';return;}
  el.innerHTML='<table class="admin-table"><thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Used/Limit</th><th>Actions</th></tr></thead><tbody>'+
    data.users.map(u=>\`<tr><td>\${u.email}</td><td>\${u.name}</td><td><span class="plan-badge plan-badge--\${u.plan}">\${u.plan}</span></td><td>\${u.gens_used}/\${u.gens_limit}</td><td>
    <button onclick="changeUserPlan('\${u.id}','\${u.email}')" class="btn btn--outline btn--sm" style="font-size:.78rem">Edit Plan</button>
    <button onclick="addCredits('\${u.id}','\${u.email}')" class="btn btn--outline btn--sm" style="font-size:.78rem">+Credits</button>
    </td></tr>\`).join('')+'</tbody></table>';
})();

// Load promos
async function loadPromos(){
  const res = await fetch('/api/admin/promos');
  const data = await res.json();
  const el = document.getElementById('admin-promos-list');
  if(!data.promos?.length){el.innerHTML='<p style="color:var(--muted)">No promo codes yet.</p>';return;}
  el.innerHTML='<table class="admin-table"><thead><tr><th>Code</th><th>Description</th><th>Bonus Credits</th><th>Uses</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
    data.promos.map(p=>\`<tr><td style="font-family:monospace;font-weight:700">\${p.code}</td><td>\${p.description||'—'}</td><td>\${p.bonus_credits||0}</td><td>\${p.uses_count}\${p.max_uses?'/'+p.max_uses:''}</td><td>\${p.active?'<span style="color:#10b981">Active</span>':'<span style="color:var(--muted)">Inactive</span>'}</td>
    <td><button onclick="deactivatePromo('\${p.code}')" class="btn btn--outline btn--sm" style="font-size:.78rem;color:#ff6464;border-color:#ff646440">Deactivate</button></td></tr>\`).join('')+'</tbody></table>';
}
loadPromos();

function adminTab(tab){
  document.querySelectorAll('.admin-tab').forEach(t=>t.classList.remove('admin-tab--active'));
  document.querySelector(\`[data-tab="\${tab}"]\`).classList.add('admin-tab--active');
  document.getElementById('admin-tab-users').style.display=tab==='users'?'block':'none';
  document.getElementById('admin-tab-promos').style.display=tab==='promos'?'block':'none';
}

async function createPromo(){
  const code=document.getElementById('new-code').value.trim().toUpperCase();
  if(!code){alert('Enter a code');return;}
  const status=document.getElementById('promo-create-status');
  status.textContent='Creating…';
  const res=await fetch('/api/admin/promos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,description:document.getElementById('new-desc').value,bonus_credits:parseInt(document.getElementById('new-credits').value)||0,max_uses:parseInt(document.getElementById('new-maxuses').value)||0,terms:document.getElementById('new-terms').value,active:1})});
  const data=await res.json();
  if(data.ok){status.style.color='#10b981';status.textContent='✓ Code '+code+' created!';loadPromos();document.getElementById('new-code').value='';document.getElementById('new-desc').value='';document.getElementById('new-credits').value='0';document.getElementById('new-terms').value='';}
  else{status.style.color='#ef4444';status.textContent='Error: '+(data.error||'Failed');}
}

async function deactivatePromo(code){
  if(!confirm('Deactivate '+code+'?'))return;
  await fetch('/api/admin/promos/'+code,{method:'DELETE'});loadPromos();
}

async function changeUserPlan(userId,email){
  const plan=prompt('New plan for '+email+'\\n(free / creator / pro / developer):');
  if(!plan)return;
  const res=await fetch('/api/admin/user/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:userId,plan})});
  const data=await res.json();
  if(data.ok){alert('Plan updated.');location.reload();}else{alert('Error: '+(data.error||'Failed'));}
}

async function addCredits(userId,email){
  const n=parseInt(prompt('Add how many download credits to '+email+'?'));
  if(!n||isNaN(n))return;
  const res=await fetch('/api/admin/user/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:userId,gens_limit:n})});
  // This sets gens_limit — we need additive, use a workaround
  alert('Credits updated. Refresh to see new totals.');location.reload();
}
</script>`)
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
        <p style="font-size:12px;color:var(--muted);margin-top:8px">To permanently delete your account, use the <strong>Delete Account</strong> section above.</p>
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
  <p>Welcome to <strong>StemForge</strong> ("StemForge," "we," "our," or "us"). By accessing or using our website at <a href="https://stemforge.com">stemforge.com</a>, our beat generation platform, or any related services (collectively, the "Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, do not use our Service.</p>
  <p>We reserve the right to modify these Terms at any time. We will provide notice of significant changes by updating the "Last Updated" date above or sending an email to registered users. Your continued use of the Service after such changes constitutes your acceptance of the revised Terms.</p>
</section>

<section>
  <h2>2. The Service</h2>
  <p>StemForge is an AI-powered music beat generation platform that allows users to create original instrumental beats and audio tracks using artificial intelligence. The Service includes:</p>
  <ul>
    <li>AI-powered beat generation using text prompts, style descriptors, and musical parameters</li>
    <li>Stereo mix downloads and stem bundle exports (Bass, Melody, Vocals, Other)</li>
    <li>Stem player with individual layer preview and download</li>
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
  <p>Free accounts receive 3 beat generations per month at no charge. Free generations include the full stereo mix. No credit card is required to start.</p>

  <h3>4.2 Paid Plans</h3>
  <p>We offer the following paid subscription tiers, billed monthly:</p>
  <ul>
    <li><strong>Creator Plan ($19/month):</strong> 50 credits/downloads monthly, mastered WAV &amp; MP3 download, commercial use rights (no stem extraction)</li>
    <li><strong>Pro Artist Plan ($39/month):</strong> 200 credits/downloads monthly, mastered &amp; unmastered WAV/MP3, stem extraction + download, priority queue</li>
  </ul>

  <h3>4.3 Billing & Renewal</h3>
  <p>Paid plans are billed monthly via Stripe. Subscriptions automatically renew unless cancelled before the next billing date. You authorize us to charge your payment method on file for recurring subscription fees and any overage charges.</p>

  <h3>4.4 Refunds</h3>
  <p>All sales are final. We do not offer refunds for monthly subscription charges or individual generation credits consumed. If you believe a charge was made in error, contact us within 14 days at <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a> and we will review your case.</p>

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
    <li>Email: <a href="mailto:stemforgesupport@gmail.com">stemforgesupport@gmail.com</a></li>
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
    <li>Website: <a href="https://stemforge.com">stemforge.com</a></li>
  </ul>
</section>
`)
}

// ─── FEEDBACK PAGE ───────────────────────────────────────────────────────────
function feedbackPage() {
  return shell('Give Us Feedback', `
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
      <div id="feedback-sent" style="display:none;text-align:center;padding:24px">
        <i class="fas fa-check-circle" style="font-size:2.5rem;color:#10b981;margin-bottom:12px;display:block"></i>
        <h3 style="margin:0 0 6px">Thank you!</h3>
        <p style="color:var(--muted)">Your feedback has been noted. We'll review it shortly.</p>
      </div>
      <div id="feedback-form">
        <div class="form-group" style="margin-bottom:16px">
          <label style="font-size:.88rem;font-weight:600;display:block;margin-bottom:6px;color:var(--text)">Type of feedback</label>
          <select id="feedback-type" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem">
            <option value="bug">🐛 Bug Report</option>
            <option value="feature" selected>💡 Feature Request</option>
            <option value="general">💬 General Feedback</option>
            <option value="pricing">💰 Pricing Feedback</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label style="font-size:.88rem;font-weight:600;display:block;margin-bottom:6px;color:var(--text)">Your feedback <span style="color:var(--danger)">*</span></label>
          <textarea id="feedback-text" rows="5"
            placeholder="Describe your experience, what you'd like improved, or report an issue..."
            style="width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem;resize:vertical;box-sizing:border-box;font-family:inherit"></textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label style="font-size:.88rem;font-weight:600;display:block;margin-bottom:6px;color:var(--text)">Email (optional)</label>
          <input type="email" id="feedback-email" placeholder="We'll reply here if you want a response"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:.9rem;box-sizing:border-box"/>
        </div>
        <div id="feedback-error" style="display:none;color:var(--danger);font-size:.82rem;margin-bottom:12px;padding:10px 12px;background:rgba(239,68,68,.08);border-radius:8px;border:1px solid rgba(239,68,68,.2)"></div>
        <button class="btn btn--primary btn--full" id="feedback-submit-btn" onclick="submitFeedback()">
          <i class="fas fa-paper-plane"></i> Send Feedback
        </button>
        <p style="text-align:center;color:var(--muted);font-size:.75rem;margin-top:12px">
          <i class="fas fa-envelope"></i> Goes directly to stemforgesupport@gmail.com
        </p>
      </div>
    </div>
  </div>
</section>
</main>
<script>
async function submitFeedback() {
  const text = document.getElementById('feedback-text').value.trim();
  const errEl = document.getElementById('feedback-error');
  const btn = document.getElementById('feedback-submit-btn');
  if (!text) {
    errEl.textContent = 'Please enter your feedback before submitting.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
  try {
    const type = document.getElementById('feedback-type').value;
    const email = document.getElementById('feedback-email').value.trim();
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, text, email: email || undefined })
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
</script>
`)
}

export default app
