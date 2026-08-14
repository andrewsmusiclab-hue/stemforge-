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
  gens_limit: number       // base plan limit (resets on billing cycle)
  bonus_credits: number    // extra purchased credits (consumed FIRST, don't reset)
  stripe_customer_id?: string
  stripe_subscription_id?: string
  account_locked?: number   // 1 = locked, 0/null = active
  lock_reason?: string
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
  // ── Lock specific policy-violating accounts (idempotent) ──
  try {
    await db.prepare(
      `UPDATE users SET account_locked=1, lock_reason='Duplicate account — your household already has a free StemForge account. Only one free account is allowed per household. Contact support@stemforge.studio to appeal.' WHERE email='miriamsreality@gmail.com' AND account_locked=0`
    ).run()
  } catch {}

  // ── Migrate existing users to correct point limits (runs on every cold start, idempotent) ──
  // Free users: 60 pts (3 beats)
  await db.prepare(`UPDATE users SET gens_limit = 60   WHERE plan = 'free'      AND gens_limit < 60`).run()
  // Creator users below 800 → 800 pts
  await db.prepare(`UPDATE users SET gens_limit = 800  WHERE plan = 'creator'   AND gens_limit < 800`).run()
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
      bonus_credits: row.bonus_credits ?? 0,
      stripe_customer_id: row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
      account_locked: row.account_locked ?? 0,
      lock_reason: row.lock_reason ?? null,
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
  password_hash?: string, google_id?: string, plan?: string, registration_ip?: string
}): Promise<void> {
  await ensureAuthTables(db)
  const planLimits: Record<string, number> = { free:60, creator:800, pro:2000 }
  const plan = data.plan || 'free'
  await db.prepare(
    `INSERT INTO users (id, email, name, avatar, plan, gens_used, gens_limit, password_hash, google_id, registration_ip, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).bind(data.id, data.email, data.name, data.avatar || null, plan,
    planLimits[plan] || 60, data.password_hash || null, data.google_id || null,
    data.registration_ip || null, Date.now()).run()
}

async function updateUserPlan(db: D1Database, userId: string, plan: string,
  stripeCustomerId: string, stripeSubId: string): Promise<void> {
  const planLimits: Record<string, number> = { free:60, creator:800, pro:2000 }
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
  const planLimits: Record<string, number> = { free:60, creator:800, pro:2000 }
  const newMonthBase = planLimits[plan] || 60
  const currentUser = await db.prepare('SELECT gens_used, gens_limit FROM users WHERE stripe_customer_id=?').bind(customerId).first<{gens_used:number,gens_limit:number}>()
  if (!currentUser) return
  const unused = Math.max(0, currentUser.gens_limit - currentUser.gens_used)
  const rolledLimit = Math.min(5000, newMonthBase + unused)
  await db.prepare(
    `UPDATE users SET gens_used=0, gens_limit=? WHERE stripe_customer_id=?`
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
          from: 'StemForge <onboarding@resend.dev>',
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
    throw new Error(`MusicAPI Producer error: ${err?.message || err?.error || res.status}`)
  }

  const data = await res.json() as any
  // Producer returns { task_id: "..." } or { data: { task_id: "..." } }
  const taskId = data.task_id || data.data?.task_id
  if (!taskId) throw new Error(`MusicAPI Producer returned no task_id: ${JSON.stringify(data).slice(0, 200)}`)
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
    throw new Error(`MusicAPI Sonic error: ${err?.message || err?.error || res.status}`)
  }

  const data = await res.json() as any
  // Sonic returns { data: [{ id, state, ... }] } or { task_id }
  const taskId = data.task_id || data.data?.[0]?.id
  if (!taskId) throw new Error(`MusicAPI Sonic returned no task_id: ${JSON.stringify(data).slice(0, 200)}`)
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
      if (errData.type === 'failed') throw new Error(errData.error || 'MusicAPI task failed')
    } catch (parseErr: any) {
      if (parseErr.message !== 'MusicAPI task failed' && !parseErr.message?.startsWith('MusicAPI')) {
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
  if (clips.every((c: any) => c.state === 'failed')) throw new Error(clips[0]?.error || 'MusicAPI instrumental generation failed')
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
  if (clip.state === 'failed') throw new Error(clip.error || 'MusicAPI song extend failed')
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
      const extBody: Record<string, any> = {
        task_type: 'extend_music',
        continue_clip_id: sourceclipId,
        mv: 'sonic-v5'
      }
      if (hasCustomLyrics) extBody.prompt = chainLyrics
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

      const extBody: Record<string, any> = {
        task_type: 'extend_music',
        continue_clip_id: uploadedClipId,
        mv: 'sonic-v5'
      }
      if (hasCustomLyrics) extBody.prompt = chainLyrics
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
          job.error = 'MusicAPI generation timed out after 10 minutes'
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
        job.error = 'MusicAPI generation timed out'
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
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Mureka not configured' }, 500)
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

// GET /api/job/stems/:jobId — poll stem extraction status (Mureka)
app.get('/api/job/stems/:jobId', async (c) => {
  if (!c.env.MUREKA_API_KEY) return c.json({ error: 'Mureka not configured' }, 500)
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
            let errMsg = `Mureka error ${murekaRes.status}`
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
            const errMsg = 'Mureka returned no zip_url: ' + JSON.stringify(data).slice(0, 200)
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
            freshStem.error = bgErr?.message || 'Mureka stem extraction failed'
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
      const dlMime = dlFmt === 'mp3' ? 'audio/mpeg' : 'audio/wav'
      const dlExt  = dlFmt === 'mp3' ? 'mp3' : 'wav'
      const totalBytes = audioBuffer.byteLength

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
          const chunk = audioBuffer.slice(start, safeEnd + 1)
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
        'Content-Type': wantDl ? dlMime : 'audio/wav',
        'Content-Length': String(totalBytes),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      }
      if (wantDl) dlHeaders['Content-Disposition'] = `attachment; filename="${safeStemName}_stem.${dlExt}"`
      return new Response(audioBuffer, { headers: dlHeaders })
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
    const upHeaders: Record<string, string> = {
      'Content-Type': wantDl ? dlMime2 : (upstream.headers.get('Content-Type') || 'audio/wav'),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    }
    if (upContentLength) upHeaders['Content-Length'] = upContentLength
    if (upContentRange)  upHeaders['Content-Range']  = upContentRange
    if (wantDl) upHeaders['Content-Disposition'] = `attachment; filename="${safeStemName2}_stem.${dlExt2}"`
    return new Response(upstream.body, { status: upstream.status, headers: upHeaders })
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
  const fmt     = c.req.query('fmt')  || 'wav'    // 'wav' or 'mp3'

  if (!cdnUrl) return c.json({ error: 'url param required' }, 400)

  // Validate the URL is a Mureka CDN URL (prevent open proxy abuse)
  let decodedUrl: string
  try { decodedUrl = decodeURIComponent(cdnUrl) } catch { return c.json({ error: 'Invalid url param' }, 400) }
  if (!decodedUrl.startsWith('https://')) return c.json({ error: 'url must be https' }, 400)

  try {
    const upstream = await fetch(decodedUrl)
    if (!upstream.ok) return c.json({ error: 'CDN fetch failed' }, 502)

    // Build a safe filename from the stem name
    const safeStem = rawName.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40)
    const ext = fmt === 'mp3' ? 'mp3' : 'wav'
    const mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    const filename = `${safeStem}_ai_remix.${ext}`

    const body = await upstream.arrayBuffer()
    return new Response(body, {
      headers: {
        'Content-Type': mime,
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
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Not configured' }, 500)
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
      let errMsg = `MusicAPI upload error ${uploadRes.status}`
      try { const j = JSON.parse(errText) as any; errMsg = j?.message || j?.error || errMsg } catch {}
      console.error(`[regen] upload error ${uploadRes.status}: ${errText}`)
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: errMsg }, 500)
    }
    const uploadData = await uploadRes.json() as any
    const uploadTaskId = uploadData.task_id || uploadData.data?.task_id
    if (!uploadTaskId) {
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: 'No task_id from MusicAPI upload' }, 500)
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
      return c.json({ error: 'MusicAPI upload timed out or failed' }, 500)
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
      let errMsg = `MusicAPI Producer error ${genRes.status}`
      try { const j = JSON.parse(errText) as any; errMsg = j?.message || j?.error || errMsg } catch {}
      console.error(`[regen] producer/create error ${genRes.status}: ${errText}`)
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: errMsg }, 500)
    }
    const genData = await genRes.json() as any
    taskId = genData.task_id || genData.data?.task_id
    if (!taskId) {
      await c.env.DB.prepare(`UPDATE users SET gens_used = MAX(0, gens_used - 30) WHERE id=?`).bind(user.id).run()
      return c.json({ error: 'No task_id from MusicAPI Producer' }, 500)
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
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Not configured' }, 500)
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
      if (!url) return c.json({ status: 'error', error: 'No audio URL in MusicAPI response' })
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
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'Not configured' }, 500)
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
      return c.json({ error: 'Remix failed to start — MusicAPI returned no task ID. Please try again.' }, 500)
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
//  Download the stereo mix (original beat audio) as mp3 or wav.
//  Plan gating: free → 403, creator → mp3 only, pro/developer → mp3 + wav
//  For now we proxy the Mureka CDN stereo_url directly (it's already a WAV).
//  MP3: we serve the WAV with audio/mpeg content-type header (lossy-free for now;
//  true transcode requires ffmpeg which isn't available in Cloudflare Workers).
// ═══════════════════════════════════════════════════════════════
app.get('/api/stem-mix/:jobId', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  if (user.plan === 'free') {
    return c.json({ error: 'Download requires a Creator or Pro Artist plan.', upgrade: true }, 403)
  }

  const jobId = c.req.param('jobId')
  const fmt  = c.req.query('fmt')  || 'wav'   // 'mp3' | 'wav' — WAV is default output
  const job = await getJob(c.env.DB, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!job.stereo_url) return c.json({ error: 'Audio not ready' }, 400)

  try {
    const upstream = await fetch(job.stereo_url)
    if (!upstream.ok) return c.json({ error: 'Audio fetch failed' }, 502)

    const ext      = fmt === 'mp3' ? 'mp3' : 'wav'
    const mime     = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    const safeName = (job.title || jobId).replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60)
    const suffix   = '_mix'

    return new Response(upstream.body, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${safeName}${suffix}.${ext}"`, // suffix = '_mix'
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=300'
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
    const { name, email, password, plan } = await c.req.json()
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
    await createUser(c.env.DB, {
      id: userId, email: email.toLowerCase(), name: name.trim(),
      password_hash: passwordHash, plan: plan || 'free',
      registration_ip: registrationIp || undefined
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
    `SELECT gens_used, gens_limit, plan, account_locked, lock_reason, bonus_credits FROM users WHERE id = ?`
  ).bind(user.id).first<{ gens_used: number; gens_limit: number; plan: string; account_locked: number; lock_reason: string | null; bonus_credits: number }>()
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')
  return c.json({
    user: {
      id: user.id, name: user.name, email: user.email,
      avatar: user.avatar,
      plan: fresh?.plan ?? user.plan,
      gens_used: fresh?.gens_used ?? user.gens_used,
      gens_limit: fresh?.gens_limit ?? user.gens_limit,
      bonus_credits: fresh?.bonus_credits ?? user.bonus_credits ?? 0,
      account_locked: fresh?.account_locked ?? 0,
      lock_reason: fresh?.lock_reason ?? null,
      is_admin: isAdmin(user, c.env)
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
      await createUser(c.env.DB, {
        id: userId, email: profile.email.toLowerCase(),
        name: profile.name, avatar: profile.picture, google_id: profile.sub,
        registration_ip: googleIp || undefined
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
          `UPDATE users SET plan='free', gens_limit=50, stripe_subscription_id=NULL WHERE stripe_customer_id=?`
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
  return c.html(homePage())
})
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
  return c.html(generatorPage())
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
          from: 'StemForge Feedback <onboarding@resend.dev>',
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
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.redirect('/login')
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
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
    return c.redirect('/login')
  }
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')

  // ── Detect any pending Stripe plan changes + fetch real billing date ──
  let pendingDowngrade: string | null = null  // 'free' | 'creator' | null
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
      // cancel_at_period_end = true means downgrading to free (cancellation)
      if (sub.cancel_at_period_end) {
        pendingDowngrade = 'free'
      }
      // Check for subscription schedules (downgrade to creator / upgrade)
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
    } catch { /* Stripe check failed — show no pending banner */ }
  }

  return c.html(subscriptionPage(user, c.env, pendingDowngrade, pendingUpgrade, realNextBillingDate))
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
    } else {
      // beats tab: regular beats (not one-shots, not extended, not remixes), not deleted
      // Note: song_generate ext_type is a relic of the old two-song feature — those are valid beats
      const res = await c.env.DB.prepare(
        `SELECT id, data, created_at, deleted_at, is_oneshot FROM jobs
         WHERE user_id = ? AND is_oneshot = 0 AND deleted_at IS NULL
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
// Body: { upload_audio_id: string (R2 proxy URL), extend_at?: number (ms), lyrics?: string, title?: string, make_instrumental?: boolean, source_duration_ms?: number }
app.post('/api/job/extend-upload', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'Not configured' }, 500)
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'MusicAPI not configured' }, 500)
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
  const EXTEND_COST = 15
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
    // upload_audio_id is now always the full R2 proxy URL returned by /api/upload-extend-audio
    // e.g. https://stemforge.studio/api/extend-audio-proxy/<encoded-r2-key>
    // Pass it directly to /sonic/upload-extend — no clip_id lookup needed.
    const isInstrumental = make_instrumental === true
    const siteUrl2 = (c.env as any).SITE_URL || 'https://stemforge.studio'
    const audioSrc = upload_audio_id.startsWith('http')
      ? upload_audio_id
      : `${siteUrl2}/api/extend-audio-proxy/${encodeURIComponent(upload_audio_id)}`
    console.log(`[extend-upload] audioSrc=${audioSrc.slice(0, 100)}`)

    // /sonic/upload-extend — single request: upload URL + extend parameters
    // Rules:
    //   custom_mode:true  → requires prompt (lyrics)
    //   custom_mode:false → requires gpt_description_prompt (AI description)
    //   make_instrumental can be combined with either mode
    const typedLyricsUpload = lyrics && lyrics.trim()
    const hasCustomLyrics = !isInstrumental && typedLyricsUpload && typedLyricsUpload !== '[Verse]' && typedLyricsUpload !== '[Instrumental]'
    // continue_at: use user's scrubber position (extend_at ms → seconds), else use end of track.
    // Must be >= 1 (MusicAPI requirement).
    const uploadSrcDurSec = source_duration_ms ? source_duration_ms / 1000 : 0
    const extendAtSec = extend_at ? extend_at / 1000 : uploadSrcDurSec
    const uploadContinueAt = Math.max(1, Math.floor(extendAtSec))
    const uploadExtBody: Record<string, any> = {
      url: audioSrc,
      mv: 'sonic-v5',
      continue_at: uploadContinueAt
    }
    if (isInstrumental) {
      // Instrumental: AI description mode + make_instrumental flag
      uploadExtBody.custom_mode = false
      uploadExtBody.gpt_description_prompt = 'Continue this track as an instrumental in the same style'
      uploadExtBody.make_instrumental = true
    } else if (hasCustomLyrics) {
      // Custom lyrics: custom mode + prompt
      uploadExtBody.custom_mode = true
      uploadExtBody.prompt = typedLyricsUpload
    } else {
      // Vocal no lyrics: AI description mode
      uploadExtBody.custom_mode = false
      uploadExtBody.gpt_description_prompt = 'Continue this track in the same style'
    }
    console.log(`[extend-upload] /sonic/upload-extend url=${audioSrc.slice(0,80)} instrumental=${isInstrumental} custom_mode=${uploadExtBody.custom_mode}`)
    let extTaskId: string
    {
      const sonicRes = await fetch(`${MUSICAPI_SONIC}/upload-extend`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadExtBody)
      })
      const sonicErrText = await sonicRes.text()
      console.log(`[extend-upload] /sonic/upload-extend HTTP ${sonicRes.status} raw: ${sonicErrText.slice(0, 600)}`)
      if (!sonicRes.ok) {
        return c.json({ error: `MusicAPI Sonic extend error: HTTP ${sonicRes.status}`, raw: sonicErrText.slice(0, 800) }, 500)
      }
      let sonicData: any
      try { sonicData = JSON.parse(sonicErrText) } catch (_) { sonicData = {} }
      console.log('[extend-upload] /sonic/upload-extend response:', JSON.stringify(sonicData).slice(0, 600))
      if (sonicData.error || sonicData.message?.toLowerCase().includes('fail')) {
        return c.json({ error: `MusicAPI Sonic extend error: ${sonicData.message || sonicData.error}`, raw: sonicErrText.slice(0, 800) }, 500)
      }
      // Response: { task_id, steps: { upload: { clip_id }, extend: { task_id } } }
      extTaskId = sonicData.task_id || sonicData.steps?.extend?.task_id || sonicData.data?.[0]?.id
      if (!extTaskId) {
        console.error('[extend-upload] missing task_id:', JSON.stringify(sonicData).slice(0, 500))
        return c.json({ error: `MusicAPI returned unexpected response`, raw: sonicErrText.slice(0, 800) }, 500)
      }
    }

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
      upload_audio_url: audioSrc
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
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'MusicAPI not configured' }, 500)
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
  const EXTEND_COST = 15
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
    // FIX: use /sonic/upload-extend (one-stop API) instead of upload→extend_music.
    // Rules: custom_mode:true needs prompt; custom_mode:false needs gpt_description_prompt
    let extTaskId: string
    {
      const typedLyricsExtend = lyrics && lyrics.trim()
      const hasCustomLyricsExtend = !isInstrumental && typedLyricsExtend && typedLyricsExtend !== '[Verse]' && typedLyricsExtend !== '[Instrumental]'
      // continue_at must be >= 1 (MusicAPI requirement)
      const srcDurationSec = (sourceJob.duration_ms ? sourceJob.duration_ms / 1000 : 0)
      const continueAt = srcDurationSec > 3 ? Math.max(1, srcDurationSec - 2) : 1

      // ── Mirror audio into R2 before calling MusicAPI ──────────────────────
      // Cloudflare Workers have a 30s wall-clock limit. Mureka CDN URLs are
      // 4-8 MB and MusicAPI downloads them server-side which can take 30-40s,
      // killing the Worker before a response arrives. Solution: fetch the audio
      // into R2 ourselves first (fast — same edge), then give MusicAPI the R2
      // proxy URL which it can download in <1s.
      let audioUrlForMusicApi = sourceJob.stereo_url
      if (c.env.IMAGES) {
        try {
          const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
          const audioFetch = await fetch(sourceJob.stereo_url)
          if (audioFetch.ok) {
            const audioBuffer = await audioFetch.arrayBuffer()
            const ext = sourceJob.stereo_url.includes('.mp3') ? 'mp3' : 'm4a'
            // proxy endpoint prepends 'extend-uploads/' so key param must NOT include it
            const r2Filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-src.${ext}`
            await c.env.IMAGES.put(`extend-uploads/${r2Filename}`, audioBuffer, {
              httpMetadata: { contentType: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' }
            })
            audioUrlForMusicApi = `${siteUrl}/api/extend-audio-proxy/${encodeURIComponent(r2Filename)}`
            console.log(`[job/extend] mirrored audio to R2: extend-uploads/${r2Filename}`)
          }
        } catch (mirrorErr: any) {
          // Mirror failed — fall back to original URL and hope it's fast enough
          console.warn('[job/extend] R2 mirror failed, using original URL:', mirrorErr?.message)
        }
      }

      const uploadExtBody: Record<string, any> = {
        url: audioUrlForMusicApi,
        mv: 'sonic-v5',
        continue_at: continueAt
      }
      if (styleStr) uploadExtBody.tags = styleStr.slice(0, 200)
      if (isInstrumental) {
        // Instrumental: AI description mode + make_instrumental
        uploadExtBody.custom_mode = false
        uploadExtBody.gpt_description_prompt = styleStr
          ? `Continue this instrumental track in the same style: ${styleStr.slice(0, 150)}`
          : 'Continue this track as an instrumental in the same style'
        uploadExtBody.make_instrumental = true
      } else if (hasCustomLyricsExtend) {
        // Custom lyrics provided
        uploadExtBody.custom_mode = true
        uploadExtBody.prompt = typedLyricsExtend
      } else {
        // Vocal no lyrics: AI description
        uploadExtBody.custom_mode = false
        uploadExtBody.gpt_description_prompt = styleStr
          ? `Continue this track in the same style: ${styleStr.slice(0, 150)}`
          : 'Continue this track in the same style'
      }
      console.log(`[job/extend] /sonic/upload-extend url=${sourceJob.stereo_url.slice(0,80)} instrumental=${isInstrumental} custom_mode=${uploadExtBody.custom_mode} style="${styleStr.slice(0,60)}"`)
      const sonicRes = await fetch(`${MUSICAPI_SONIC}/upload-extend`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadExtBody)
      })
      const errText = await sonicRes.text()
      console.log(`[job/extend] /sonic/upload-extend HTTP ${sonicRes.status} raw: ${errText.slice(0, 600)}`)
      if (!sonicRes.ok) {
        // Return the FULL raw response so we can see exactly what MusicAPI said
        return c.json({ error: `MusicAPI Sonic extend error: HTTP ${sonicRes.status}`, raw: errText.slice(0, 800) }, 500)
      }
      let sonicData: any
      try { sonicData = JSON.parse(errText) } catch (_) { sonicData = {} }
      console.log('[job/extend] /sonic/upload-extend response:', JSON.stringify(sonicData).slice(0, 600))
      // Check for application-level errors (HTTP 200 but error in body)
      if (sonicData.error || sonicData.message?.toLowerCase().includes('fail')) {
        return c.json({ error: `MusicAPI Sonic extend error: ${sonicData.message || sonicData.error}`, raw: errText.slice(0, 800) }, 500)
      }
      // Response: { task_id, steps: { upload: { clip_id }, extend: { task_id } } }
      extTaskId = sonicData.task_id || sonicData.steps?.extend?.task_id || sonicData.data?.[0]?.id
      if (!extTaskId) {
        console.error('[job/extend] missing task_id:', JSON.stringify(sonicData).slice(0, 500))
        return c.json({ error: `MusicAPI returned unexpected response`, raw: JSON.stringify(sonicData).slice(0, 800) }, 500)
      }
    }

    // chain_target_ms: aim for 80 seconds total output (~1 min 20s, 5 steps max)
    const CHAIN_TARGET_MS = 80000

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
      chain_max_steps: 5,
      chain_lyrics: (lyrics && lyrics.trim() && lyrics.trim() !== '[Verse]' && lyrics.trim() !== '[Instrumental]') ? lyrics.trim() : '',
      chain_style: styleStr || null,
      continue_at_ms: extend_at || Math.max(1, (srcJob.duration_ms || 0))
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

// POST /api/debug/test-cover-url — test /sonic/upload-cover with a direct audio URL (admin only)
// Body: { url: string, tags?: string }
app.post('/api/debug/test-cover-url', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'No MUSICAPI_KEY' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 401)
  const body = await c.req.json<{ url: string; tags?: string }>()
  const { url, tags } = body
  if (!url) return c.json({ error: 'url required' }, 400)
  const coverBody = {
    url,
    mv: 'sonic-v5',
    tags: tags || 'instrumental, no vocals, energetic',
    custom_mode: false,
    gpt_description_prompt: 'Instrumental beat, no vocals, energetic mood. Keep same energy and style.',
    make_instrumental: true
  }
  console.log(`[debug/test-cover-url] url=${url.slice(0,100)} tags="${coverBody.tags}"`)
  const r = await fetch(`${MUSICAPI_SONIC}/upload-cover`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.MUSICAPI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(coverBody)
  })
  const t = await r.text()
  let parsed: any = {}
  try { parsed = JSON.parse(t) } catch {}
  console.log(`[debug/test-cover-url] HTTP ${r.status}: ${t.slice(0,300)}`)
  return c.json({ status: r.status, ok: r.ok, body_sent: coverBody, response: parsed, raw: t.slice(0,800) })
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

// ─── PENDING STATE ───────────────────────────────────────────────────────────
// GET /api/subscription/pending-state — returns { pendingDowngrade, pendingUpgrade } for home/pricing pages
// pendingDowngrade: 'free' | 'creator' | null
// pendingUpgrade:   'creator' | 'pro' | null
app.get('/api/subscription/pending-state', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ pendingDowngrade: null, pendingUpgrade: null })
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!user || !user.stripe_subscription_id || !stripeConfigured(c.env)) {
    return c.json({ pendingDowngrade: null, pendingUpgrade: null })
  }
  try {
    let pendingDowngrade: string | null = null
    let pendingUpgrade: string | null = null
    const sub = await stripeRequest('GET', `/subscriptions/${user.stripe_subscription_id}`, {}, c.env.STRIPE_SECRET_KEY)
    if (sub.cancel_at_period_end) {
      pendingDowngrade = 'free'
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

// GET /api/admin/users — list all users
app.get('/api/admin/users', async (c) => {
  if (!c.env.DB || !c.env.SESSION_SECRET) return c.json({ error: 'No DB' }, 500)
  const token = getSessionCookie(c.req.raw)
  const user = token ? await getSessionUser(c.env.DB, token) : null
  if (!isAdmin(user, c.env)) return c.json({ error: 'Forbidden' }, 403)
  const rows = await c.env.DB.prepare(`SELECT id,email,name,plan,gens_used,gens_limit,bonus_credits,account_locked,lock_reason,created_at FROM users ORDER BY created_at DESC LIMIT 100`).all<any>()
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
!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};ttq.load('D9SVAV3C77UA78AD7EU0');ttq.page()}(window,document,'ttq');
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
      <strong>MusicAPI Credit Balance: <span id="credit-balance" style="color:#4e9fff">loading…</span></strong><br/>
      Credits are fetched live from the MusicAPI. Sonic (Suno v5.5) + Producer (Lyria 3 Pro) share the same account balance.<br/>
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
  { id: 'pack_50',   name: '50 Points',   credits: 50,   price_cents: 499,  label: '$4.99',  popular: false },
  { id: 'pack_150',  name: '150 Points',  credits: 150,  price_cents: 999,  label: '$9.99',  popular: true  },
  { id: 'pack_400',  name: '400 Points',  credits: 400,  price_cents: 1799, label: '$17.99', popular: false },
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
// Used by upload-extend-audio and upload-remix-audio routes to give MusicAPI a public URL
app.get('/api/extend-audio-proxy/:key', async (c) => {
  if (!c.env.IMAGES) return c.json({ error: 'Storage unavailable' }, 503)
  const rawKey = c.req.param('key')
  // Try extend-uploads/ first (original extend flow), then remix-uploads/ (new remix flow)
  let obj = await c.env.IMAGES.get(`extend-uploads/${rawKey}`)
  if (!obj) obj = await c.env.IMAGES.get(`remix-uploads/${rawKey}`)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'audio/mpeg',
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
// Accepts: multipart { file } or multipart/JSON { url }
// Stores the file in R2 and returns the public proxy URL.
// The URL is then passed to /api/job/extend-upload which calls MusicAPI directly.
// NO MusicAPI call is made here — just R2 storage + URL generation.
app.post('/api/upload-extend-audio', async (c) => {
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  const siteUrl = (c.env as any).SITE_URL || 'https://stemforge.studio'
  const contentType = c.req.header('content-type') || ''

  // JSON body: { audio_url } — caller is providing a URL directly (no R2 upload needed)
  if (contentType.includes('application/json')) {
    const body = await c.req.json<{ audio_url?: string; url?: string }>().catch(() => ({}))
    const directUrl = body.audio_url || body.url || null
    if (!directUrl) return c.json({ error: 'audio_url required' }, 400)
    console.log(`[upload-extend-audio] Using direct URL: ${directUrl.slice(0, 80)}`)
    return c.json({ ok: true, audio_url: directUrl, status: 'ready' })
  }

  // Multipart: file blob or url field
  const formData = await c.req.formData()
  const urlField = formData.get('url') as string | null
  if (urlField) {
    console.log(`[upload-extend-audio] Using URL from form field: ${urlField.slice(0, 80)}`)
    return c.json({ ok: true, audio_url: urlField, status: 'ready' })
  }

  // File blob — store in R2
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file or url provided' }, 400)
  if (!c.env.IMAGES) return c.json({ error: 'File storage not configured' }, 500)

  const safeFilename = (file.name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_')
  const r2Key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFilename}`
  await c.env.IMAGES.put(`extend-uploads/${r2Key}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'audio/mpeg' }
  })
  const audioUrl = `${siteUrl}/api/extend-audio-proxy/${encodeURIComponent(r2Key)}`
  console.log(`[upload-extend-audio] Stored in R2, proxy URL: ${audioUrl}`)
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
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'MusicAPI not configured' }, 500)
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
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'MusicAPI not configured' }, 500)
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
    return c.json({ error: err?.message || err?.error || `MusicAPI error ${res.status}` }, 500)
  }

  const data = await res.json() as any
  const taskId = data.task_id || data.data?.task_id
  return c.json({ ok: true, task_id: taskId, sound_type, prompt: oneshotPrompt })
})

// POST /api/poll-oneshot/:task_id — poll MusicAPI for one-shot status
app.post('/api/poll-oneshot/:task_id', async (c) => {
  if (!c.env.MUSICAPI_KEY) return c.json({ error: 'MusicAPI not configured' }, 500)
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
  if (!c.env.ELEVENLABS_API_KEY) return c.json({ error: 'ElevenLabs not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.json({ error: 'Not logged in' }, 401)

  // Pro Artist only
  if (user.plan !== 'pro' && user.plan !== 'developer') {
    return c.json({ error: 'One Shot Creator requires the Pro Artist plan.', upgrade: true }, 403)
  }

  // Deduct 10 pts before generation (refunded on hard API error) — bonus first
  const SFX_COST = 10
  if (c.env.DB) {
    const fresh = await c.env.DB.prepare('SELECT gens_used, gens_limit, bonus_credits FROM users WHERE id=?').bind(user.id).first<{gens_used:number,gens_limit:number,bonus_credits:number}>()
    const sfxBonus = fresh?.bonus_credits ?? 0
    const sfxMain = fresh ? (fresh.gens_limit - fresh.gens_used) : 0
    if (!fresh || sfxMain + sfxBonus < SFX_COST) {
      return c.json({ error: `Not enough points. One Shot Creator costs ${SFX_COST} points and you only have ${Math.max(0, sfxMain + sfxBonus)} remaining.`, limit_reached: true }, 403)
    }
    if (sfxBonus >= SFX_COST) {
      await c.env.DB.prepare('UPDATE users SET bonus_credits = bonus_credits - ? WHERE id=?').bind(SFX_COST, user.id).run()
    } else if (sfxBonus > 0) {
      await c.env.DB.prepare('UPDATE users SET bonus_credits = 0, gens_used = gens_used + ? WHERE id=?').bind(SFX_COST - sfxBonus, user.id).run()
    } else {
      await c.env.DB.prepare('UPDATE users SET gens_used = gens_used + ? WHERE id=?').bind(SFX_COST, user.id).run()
    }
  }

  const { prompt, duration_seconds } = await c.req.json<{ prompt: string; duration_seconds?: number }>()
  if (!prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)

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

// GET /api/download-wav/:id — proxy stereo URL with WAV content-disposition
app.get('/api/download-wav/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'DB not configured' }, 500)
  const token = c.env.SESSION_SECRET ? getSessionCookie(c.req.raw) : null
  const user = (token && c.env.DB) ? await getSessionUser(c.env.DB, token) : null
  if (!user) return c.redirect('/login')
  // Free plan: downloads locked — stems and tracks are saved until upgrade
  if (user.plan === 'free') {
    return c.json({ error: 'Downloading tracks requires a Creator or Pro Artist plan. Your tracks are saved — upgrade anytime to download.', locked: true, upgrade: true }, 403)
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

// GET /api/download-mp3/:id — legacy endpoint, now redirects to WAV download
app.get('/api/download-mp3/:id', async (c) => {
  const jobId = c.req.param('id')
  return c.redirect(`/api/download-wav/${jobId}`, 301)
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
// Cache-buster: changes every deploy so browsers always fetch fresh CSS/JS
const ASSET_VER = '20260814-01'

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
!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};ttq.load('D9SVAV3C77UA78AD7EU0');ttq.page()}(window,document,'ttq');
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

<script src="/static/app.v2.45.js"></script>
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
    <a href="/feedback" class="gs-sidebar__nav-item" data-page="feedback">
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
    <!-- Admin link — only shown to developer/admin plan via JS -->
    <a href="/admin" class="gs-sidebar__nav-item gs-sidebar__nav-item--admin" data-page="admin" id="sidebar-admin-link" style="display:none">
      <i class="fas fa-shield-alt" style="color:#a78bfa"></i>
      <span>Admin</span>
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
<section class="hero">
  <div class="hero__bg">
    <div class="hero__orb hero__orb--1"></div>
    <div class="hero__orb hero__orb--2"></div>
    <div class="hero__grid"></div>
    <!-- Looping background video — fixed to viewport, fades out on scroll past hero -->
    <video id="hero-bg-video" autoplay muted loop playsinline
      style="position:fixed;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.18;mix-blend-mode:screen;pointer-events:none;z-index:0;transition:opacity .4s ease">
      <source src="/static/hero-wave.mp4" type="video/mp4">
    </video>
    <script>
      (function(){
        var vid = document.getElementById('hero-bg-video');
        var hero = vid && vid.closest('.hero');
        if (!vid || !hero) return;
        function onScroll() {
          var bottom = hero.getBoundingClientRect().bottom;
          if (bottom <= 0) {
            vid.style.opacity = '0';
            vid.style.visibility = 'hidden';
          } else {
            vid.style.visibility = 'visible';
            /* fade from 0.18 → 0 as hero bottom approaches viewport top */
            var fade = Math.max(0, Math.min(1, bottom / window.innerHeight));
            vid.style.opacity = (0.18 * fade).toFixed(3);
          }
        }
        window.addEventListener('scroll', onScroll, { passive: true });
      })();
    </script>
  </div>
  <div class="container hero__content">
    <div class="hero__badge"><i class="fas fa-bolt"></i> AI-powered multitrack generation</div>
    <h1 class="hero__title">Forge the beat.<br/><span class="gradient-text">Make it yours.</span></h1>
    <p class="hero__sub">StemForge generates professional tracks in your favorite genre using AI. Download the full stereo mix and take your beats straight to the DAW.</p>
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
      <span><i class="fas fa-music"></i> Beat Engine</span>
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
        <div class="feature-card__icon"><i class="fas fa-compact-disc"></i></div>
        <h3>Studio-quality downloads</h3>
        <p>Download the full stereo mix in lossless WAV — ready for release, streaming, or your DAW.</p>
        <div class="feature-card__tracks">
          <span class="track-pill track-pill--kick">Stereo Mix</span>
          <span class="track-pill track-pill--bass">WAV</span>
          <span class="track-pill track-pill--keys">Lossless</span>
          <span class="track-pill track-pill--hats">Commercial rights</span>
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
        <h3>Lossless WAV exports</h3>
        <p>Download the full stereo mix as a lossless WAV file — ready for distribution, streaming, or your own DAW workflow.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-tags"></i></div>
        <h3>Intelligent stem naming</h3>
        <p>Each stem is named by what it actually contains — drums, bass, keys, lead — so you can work with them straight out of the export.</p>
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
          <li><i class="fas fa-check"></i> 60 points monthly</li>
          <li><i class="fas fa-check"></i> Stereo preview &amp; playback</li>
          <li class="muted"><i class="fas fa-times"></i> Downloads</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full" id="home-free-plan-btn" data-plan="free">Get started free</a>
        <div id="home-free-plan-status" style="margin:8px 0 0">
          <div class="home-downgrade-note sub-downgrade-pending-banner" id="home-free-downgrade-note" style="display:none">
            <i class="fas fa-clock"></i> <span id="home-free-downgrade-msg">Downgrading to Free at end of billing cycle</span>
          </div>
          <button class="btn btn--outline btn--sm" id="home-btn-cancel-downgrade-free" style="display:none;margin-top:6px;border-color:rgba(78,159,255,.4);color:var(--primary);width:100%" onclick="homeCancelDowngrade('free')">
            <i class="fas fa-undo" style="font-size:.75rem;margin-right:4px"></i>Cancel Downgrade
          </button>
        </div>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$10</span><span>/month</span></div>
        <p class="plan-card__desc">For artists, writers, and content creators.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 800 points monthly</li>
          <li><i class="fas fa-check"></i> Auto Split &amp; Vocals+Instrumental</li>
          <li><i class="fas fa-check"></i> WAV download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
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
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$26</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 2,000 points monthly</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-expand-arrows-alt" style="font-size:.75rem;opacity:.8"></i> Song Extend</li>
          <li><i class="fas fa-check"></i> All stem split modes</li>
          <li><i class="fas fa-check"></i> Stem download</li>
          <li><i class="fas fa-check"></i> Reference track upload</li>
          <li><i class="fas fa-check"></i> WAV download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> Priority queue</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-wand-magic-sparkles" style="color:#a855f7;font-size:.75rem"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span> — reinvent any beat</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator — StemForge SFX</li>
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

<!-- Bottom stems video — fixed to viewport bottom, fades in as user scrolls to bottom -->
<!-- Wrapper handles the gradient bleed — transparent top, solid bottom -->
<div id="stems-bg-wrap" style="position:fixed;bottom:0;left:0;width:100%;height:65vh;pointer-events:none;z-index:0;opacity:0;transition:opacity .6s ease;will-change:opacity;-webkit-mask-image:linear-gradient(to bottom,transparent 0%,black 38%);mask-image:linear-gradient(to bottom,transparent 0%,black 38%)">
  <video id="stems-bg-video" autoplay muted loop playsinline
    style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;mix-blend-mode:screen;pointer-events:none">
    <source src="/static/stems-wave.mp4" type="video/mp4">
  </video>
</div>
<script>
(function(){
  var wrap = document.getElementById('stems-bg-wrap');
  if (!wrap) return;
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function() {
      ticking = false;
      var scrolled = window.scrollY;
      var winH     = window.innerHeight;
      var docH     = document.documentElement.scrollHeight;
      /* progress: 0 = page top, 1 = page bottom */
      var progress = scrolled / Math.max(1, docH - winH);
      /* fade in from 70% → 90% scroll; once visible, stays visible all the way to bottom */
      var opacity  = parseFloat((0.22 * Math.max(0, Math.min(1, (progress - 0.70) / 0.20))).toFixed(3));
      wrap.style.opacity    = opacity;
      wrap.style.visibility = opacity < 0.005 ? 'hidden' : 'visible';
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
</script>

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

    // ── Free card: show banner+cancel when pending downgrade is 'free' ──
    const frNote  = document.getElementById('home-free-downgrade-note');
    const frMsg   = document.getElementById('home-free-downgrade-msg');
    const frCancel= document.getElementById('home-btn-cancel-downgrade-free');
    const freePlanBtn = document.getElementById('home-free-plan-btn');
    if (pd === 'free' && frNote) {
      if (frMsg) frMsg.textContent = 'Downgrading to Free at end of billing cycle';
      frNote.style.display = 'flex';
      if (frCancel) frCancel.style.display = 'inline-flex';
      // Hide/disable the downgrade button itself
      if (freePlanBtn) { freePlanBtn.style.display = 'none'; }
    } else if (frNote) {
      frNote.style.display = 'none';
      if (frCancel) frCancel.style.display = 'none';
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
            msg.textContent = 'You will be downgraded to Creator ($10/mo, 800 points/mo) at the end of your current billing cycle. You keep all features until then.';
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
              if (msg) msg.textContent = 'You will be downgraded to Creator ($10/mo, 800 points/mo) at the end of your current billing cycle. You keep all features until then.';
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
    </div>


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

      <!-- Close/dismiss button (shown once ready, hidden during generation) -->
      <button id="pipeline-close-btn" onclick="closePipelinePlayer()" style="display:none;position:absolute;top:10px;right:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:50%;width:30px;height:30px;cursor:pointer;color:rgba(255,255,255,.6);font-size:14px;display:none;align-items:center;justify-content:center;transition:all .15s;z-index:10" onmouseover="this.style.background='rgba(255,255,255,.18)';this.style.color='#fff'" onmouseout="this.style.background='rgba(255,255,255,.08)';this.style.color='rgba(255,255,255,.6)'">
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
      <div class="plan-card">
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
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$10</span><span>/month</span></div>
        <p class="plan-card__desc">For artists, writers, and content creators.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 800 points monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full StemForge beat generation</li>
          <li><i class="fas fa-check"></i> Auto Split (up to 5 stems) — 30 pts</li>
          <li><i class="fas fa-check"></i> Vocals &amp; Instrumental — 70 pts</li>
          <li><i class="fas fa-check"></i> WAV download — commercial use</li>
          <li><i class="fas fa-check"></i> Top-up point packs available</li>
          <li class="muted"><i class="fas fa-times"></i> Extend song</li>
          <li class="muted"><i class="fas fa-times"></i> WAV downloads</li>

          <li class="muted"><i class="fas fa-times"></i> Stem regeneration</li>
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
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$26</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists who need every track clean.</p>
        <div class="plan-card__credits"><i class="fas fa-music"></i> 2,000 points monthly</div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Everything in Creator</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-expand-arrows-alt" style="font-size:.75rem;opacity:.8"></i> Song Extend</li>
          <li><i class="fas fa-check"></i> All stem split modes + stem download</li>
          <li><i class="fas fa-check"></i> Reference track upload</li>
          <li><i class="fas fa-check"></i> Stem regeneration</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-wand-magic-sparkles" style="color:#a855f7;font-size:.75rem"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span> — reinvent any beat</li>
          <li><i class="fas fa-check"></i> WAV download</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> Priority queue — faster generations</li>
          <li><i class="fas fa-check"></i> Top-up point packs available</li>
          <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator — StemForge SFX</li>
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
        <div class="credit-table__row"><span><i class="fas fa-music"></i> 1 StemForge beat</span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--free">All plans</span></div>
        <div class="credit-table__row"><span><i class="fas fa-cut"></i> Auto Split (up to 5 stems)</span><span class="credit-val">30 pts</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-microphone"></i> Vocals &amp; Instrumental</span><span class="credit-val">70 pts</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-expand-arrows-alt"></i> Extend song</span><span class="credit-val">15 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span></span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-upload"></i> Reference track</span><span class="credit-val">15 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-download"></i> WAV download</span><span class="credit-val">Included</span><span class="tier-badge tier-badge--creator">Creator+ &amp; Pro Artist</span></div>
        <div class="credit-table__row"><span><i class="fas fa-bolt" style="color:#f59e0b"></i> One Shot Creator (StemForge SFX)</span><span class="credit-val">10 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
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

  // ── Apply Stripe pending state to pricing cards ─────────────────────────────
  function pricingApplyPendingState(pendingState, userPlan) {
    const pd   = (pendingState && pendingState.pendingDowngrade) || null;
    const plan = userPlan || (pendingState && pendingState.plan) || null;

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
        ? 'You will be downgraded to the Creator plan ($10/mo, 800 points/mo) at the end of your current billing cycle.'
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
    <button class="lib-tab lib-tab--active" data-tab="beats" onclick="switchLibTab('beats')">
      <i class="fas fa-music"></i> Beats / Songs
    </button>
    <button class="lib-tab" data-tab="remixes" onclick="switchLibTab('remixes')">
      <i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc">Remixes</span>
    </button>
    <button class="lib-tab" data-tab="extended" onclick="switchLibTab('extended')">
      <i class="fas fa-expand-arrows-alt"></i> Extended
    </button>
    <button class="lib-tab" data-tab="oneshots" id="lib-tab-oneshots" onclick="switchLibTab('oneshots')">
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
        <img src="/static/stemforge-logo.png" alt="StemForge" style="height:30px;width:30px;object-fit:contain;flex-shrink:0"/><span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <div class="checkout-plan-summary" id="co-plan-summary">
        <div class="checkout-plan-summary__header">
          <div><h3 id="co-plan-name">Creator Plan</h3><p>Billed monthly · Cancel anytime</p></div>
          <div class="checkout-plan-summary__price"><span id="co-plan-price">$10</span><span>/mo</span></div>
        </div>
        <ul class="checkout-plan-summary__features" id="co-plan-features">
          <li><i class="fas fa-check"></i> 800 points monthly</li>
          <li><i class="fas fa-check"></i> Auto Split &amp; Vocals+Instrumental</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
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
function subscriptionPage(user: User, env: Bindings, pendingDowngrade: string | null = null, pendingUpgrade: string | null = null, realNextBillingDate: string | null = null) {
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
        <span class="sub-stat__label">Points Remaining</span>
        <span class="sub-stat__val" id="sub-remaining-val">${Math.max(0, user.gens_limit - user.gens_used)} / ${user.gens_limit}</span>
        ${user.bonus_credits > 0 ? `<span class="sub-stat__bonus" id="sub-bonus-val"><i class="fas fa-bolt"></i> ${user.bonus_credits} bonus pts</span>` : `<span class="sub-stat__bonus" id="sub-bonus-val" style="display:none"></span>`}
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
        <div class="credit-pack-card" data-pack="pack_50">
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">50</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$4.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_50">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card credit-pack-card--popular" data-pack="pack_150">
          <div class="credit-pack__badge"><i class="fas fa-star"></i> Best Value</div>
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">150</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$9.99</span>
            <button class="credit-pack-btn credit-pack-btn--primary" data-pack="pack_150">
              <i class="fas fa-cart-plus"></i> Buy
            </button>
          </div>
        </div>
        <div class="credit-pack-card" data-pack="pack_400">
          <div class="credit-pack__icon"><i class="fas fa-coins"></i></div>
          <div class="credit-pack__main">
            <div class="credit-pack__credits">400</div>
            <div class="credit-pack__label">Points</div>
          </div>
          <div class="credit-pack__price-row">
            <span class="credit-pack__price">$17.99</span>
            <button class="credit-pack-btn credit-pack-btn--default" data-pack="pack_400">
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
        <div class="sub-plan-card ${user.plan === 'free' ? 'sub-plan-card--current' : ''}" id="sub-plan-free">
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
        <div class="sub-plan-card ${user.plan === 'creator' ? 'sub-plan-card--current' : ''}" id="sub-plan-creator">
          <div class="sub-plan-card__top">
            <div><h4>Creator</h4><p>For Artists &amp; creators</p></div>
            <div class="sub-plan-card__price">$10<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 800 points monthly</li>
            <li><i class="fas fa-check"></i> WAV download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
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
          <div class="sub-plan-card__top">
            <div><h4>Pro Artist</h4><p>Maximum output</p></div>
            <div class="sub-plan-card__price">$26<span>/mo</span></div>
          </div>
          <ul>
            <li><i class="fas fa-check"></i> 2,000 points monthly</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-expand-arrows-alt" style="font-size:.75rem;opacity:.8"></i> Song Extend</li>
            <li><i class="fas fa-check"></i> All stem split modes + stem download</li>
            <li><i class="fas fa-check"></i> Reference track upload</li>
            <li><i class="fas fa-check"></i> WAV download</li>
            <li><i class="fas fa-check"></i> Commercial use rights</li>
            <li><i class="fas fa-check"></i> Priority queue</li>
            <li><i class="fas fa-check"></i> <i class="fas fa-wand-magic-sparkles" style="color:#a855f7;font-size:.8rem"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span></li>
            <li><i class="fas fa-check"></i> <i class="fas fa-bolt" style="color:#f59e0b;font-size:.75rem"></i> One Shot Creator</li>
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
          <div class="credit-table__row"><span><i class="fas fa-music"></i> Generate 1 StemForge beat</span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--free">All plans</span></div>
          <div class="credit-table__row"><span><i class="fas fa-cut"></i> Auto Split (up to 5 stems)</span><span class="credit-val">30 pts</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
          <div class="credit-table__row"><span><i class="fas fa-microphone"></i> Vocals &amp; Instrumental</span><span class="credit-val">70 pts</span><span class="tier-badge tier-badge--creator">Creator+</span></div>
          <div class="credit-table__row"><span><i class="fas fa-expand-arrows-alt"></i> Extend song</span><span class="credit-val">15 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>

          <div class="credit-table__row"><span><i class="fas fa-wand-magic-sparkles" style="color:#a855f7"></i> <span style="color:#c084fc;font-weight:600">Stemforge Remix</span></span><span class="credit-val">20 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
          <div class="credit-table__row"><span><i class="fas fa-upload"></i> Reference track upload</span><span class="credit-val">15 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
          <div class="credit-table__row"><span><i class="fas fa-bolt" style="color:#f59e0b"></i> One Shot Creator (SFX)</span><span class="credit-val">10 pts</span><span class="tier-badge tier-badge--pro">Pro Artist</span></div>
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
        msg.textContent = 'Your subscription will be cancelled at the end of your billing cycle. You will move to the Free plan (50 points monthly) after that.';
      } else if (pendingTarget === 'creator') {
        msg.textContent = 'You will be downgraded to the Creator plan ($10/mo, 800 points/mo) at the end of your current billing cycle.';
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
    </div>

    <!-- ANALYTICS TAB -->
    <div id="admin-tab-analytics">
      <div class="sub-stats-bar" style="margin-bottom:28px">
        <div class="sub-stat"><span class="sub-stat__label">Views Today</span><span class="sub-stat__val" id="an-today">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Views This Week</span><span class="sub-stat__val" id="an-week">—</span></div>
        <div class="sub-stat"><span class="sub-stat__label">Views This Month</span><span class="sub-stat__val" id="an-month">—</span></div>
        <div class="sub-stat" title="MusicAPI + Mureka capacity errors in last 30 days">
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
<script src="/static/admin.v1.js?v=${ASSET_VER}"></script>

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
    <li><strong>Creator Plan ($10/month):</strong> 800 points monthly, Auto Split (30 pts), Vocals &amp; Instrumental (70 pts), WAV download, commercial use rights</li>
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

export default app
