import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

// Serve static assets
app.use('/static/*', serveStatic({ root: './' }))

// ─── Pages ────────────────────────────────────────────────────────────────────

app.get('/', (c) => c.html(homePage()))
app.get('/pricing', (c) => c.html(pricingPage()))
app.get('/generator', (c) => c.html(generatorPage()))
app.get('/dashboard', (c) => c.html(dashboardPage()))
app.get('/project', (c) => c.html(projectPage()))
app.get('/signup', (c) => c.html(signupPage()))
app.get('/login', (c) => c.html(loginPage()))
app.get('/checkout', (c) => c.html(checkoutPage()))

// ─── API (stub) ───────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'StemForge' }))

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
      <p>AI beat generation with true individual track export. No two instruments share the same stem.</p>
    </div>
    <div class="sf-footer__cols">
      <div>
        <h4>Product</h4>
        <a href="/generator">Generator</a>
        <a href="/pricing">Pricing</a>
        <a href="/#features">Features</a>
        <a href="/#how">How it works</a>
      </div>
      <div>
        <h4>Account</h4>
        <a href="/signup">Sign up</a>
        <a href="/login">Log in</a>
        <a href="/dashboard">Dashboard</a>
      </div>
      <div>
        <h4>Legal</h4>
        <a href="#">Terms of service</a>
        <a href="#">Privacy policy</a>
        <a href="#">Cookie policy</a>
      </div>
    </div>
  </div>
  <div class="sf-footer__bottom">
    <p>© 2026 StemForge. All rights reserved.</p>
    <p>Built for artists who need every track clean.</p>
  </div>
</footer>`
}

// ─── HOME ─────────────────────────────────────────────────────────────────────

function homePage() {
  return shell('Generate Beats. Keep Every Track', `
<main>

<!-- HERO -->
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
      <a href="/signup" class="btn btn--primary btn--lg"><i class="fas fa-play"></i> Start generating free</a>
      <a href="/generator" class="btn btn--outline btn--lg"><i class="fas fa-headphones"></i> See the generator</a>
    </div>
    <div class="hero__proof">
      <span><i class="fas fa-check-circle"></i> No credit card required</span>
      <span><i class="fas fa-check-circle"></i> 150 free credits</span>
      <span><i class="fas fa-check-circle"></i> Commercial use on paid plans</span>
    </div>
  </div>
  <!-- waveform visual -->
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

<!-- LOGOS / SOCIAL PROOF -->
<section class="logos-bar">
  <div class="container">
    <p class="logos-bar__label">Trusted by artists making real music</p>
    <div class="logos-bar__items">
      <span><i class="fas fa-music"></i> Rap</span>
      <span><i class="fas fa-fire"></i> Trap</span>
      <span><i class="fas fa-heart"></i> R&B</span>
      <span><i class="fas fa-moon"></i> Drill</span>
      <span><i class="fas fa-star"></i> Afrobeats</span>
      <span><i class="fas fa-record-vinyl"></i> Lo-Fi</span>
      <span><i class="fas fa-film"></i> Cinematic</span>
    </div>
  </div>
</section>

<!-- FEATURES -->
<section class="features" id="features">
  <div class="container">
    <div class="section-header">
      <div class="section-tag">Features</div>
      <h2>Everything you need.<br/>Nothing you don't.</h2>
      <p>Built for artists who want more than a loop — built for producers who need every track clean.</p>
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
        <p>Every beat starts as a shared blueprint — BPM, key, structure, arrangement — so all tracks lock together perfectly.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-sliders"></i></div>
        <h3>Regenerate one track at a time</h3>
        <p>Don't like the bass line? Regenerate just the bass. Everything else stays locked in place.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-compact-disc"></i></div>
        <h3>Master + premaster exports</h3>
        <p>Get a polished mastered stereo mix or the clean premaster version for your own engineer to finish.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-tags"></i></div>
        <h3>Smart instrument labeling</h3>
        <p>A flute is labeled "Flute." A guitar is labeled "Guitar." No more guessing what's in the FX bus.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card__icon"><i class="fas fa-shield-alt"></i></div>
        <h3>Commercial use included</h3>
        <p>All paid plan exports come with full commercial use rights. Sell your beats, release your music, no restrictions.</p>
      </div>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
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
          <p>Type your prompt: genre, mood, BPM, vibe, instruments you want or don't want. StemForge reads intent.</p>
          <div class="how__step-example">"95 BPM dark surf noir trap beat, open vocal space, Rhodes and guitar texture, no hi energy drops"</div>
        </div>
      </div>
      <div class="how__step">
        <div class="how__step-num">02</div>
        <div class="how__step-body">
          <h3>StemForge builds the arrangement</h3>
          <p>Before any audio renders, the system builds a shared composition blueprint — BPM, key, structure, section map, instrument roles, and arrangement density.</p>
        </div>
      </div>
      <div class="how__step">
        <div class="how__step-num">03</div>
        <div class="how__step-body">
          <h3>Every instrument renders separately</h3>
          <p>Each track — kick, snare, hats, bass, keys, guitar, pad, FX — renders from the same blueprint. All perfectly locked together. All individually clean.</p>
        </div>
      </div>
      <div class="how__step">
        <div class="how__step-num">04</div>
        <div class="how__step-body">
          <h3>Download what you need</h3>
          <p>Grab the stereo mix to write over. Take the premaster to your engineer. Pull individual tracks for your DAW. Your plan determines what you can export.</p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- PRICING PREVIEW -->
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
        <p class="plan-card__desc">Test the engine. Hear the quality.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 150 credits/month</li>
          <li><i class="fas fa-check"></i> Draft previews</li>
          <li><i class="fas fa-check"></i> Limited stereo exports</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Stems or tracks</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full">Get started free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$12</span><span>/month</span></div>
        <p class="plan-card__desc">For rappers, writers, and content creators.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 3,000 credits/month</li>
          <li><i class="fas fa-check"></i> Full stereo beats</li>
          <li><i class="fas fa-check"></i> Master + premaster export</li>
          <li><i class="fas fa-check"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Individual track export</li>
        </ul>
        <a href="/signup?plan=creator" class="btn btn--primary btn--full">Start Creator</a>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$29</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists and producers who need stems.</p>
        <ul class="plan-card__features">
          <li><i class="fas fa-check"></i> 10,000 credits/month</li>
          <li><i class="fas fa-check"></i> Everything in Creator</li>
          <li><i class="fas fa-check"></i> Grouped stems export</li>
          <li><i class="fas fa-check"></i> Individual track export</li>
          <li><i class="fas fa-check"></i> Regenerate one track only</li>
        </ul>
        <a href="/signup?plan=pro" class="btn btn--outline btn--full">Start Pro Artist</a>
      </div>
    </div>
    <div class="pricing-preview__cta">
      <a href="/pricing" class="btn btn--ghost">See full pricing & credit calculator <i class="fas fa-arrow-right"></i></a>
    </div>
  </div>
</section>

<!-- TESTIMONIALS -->
<section class="testimonials">
  <div class="container">
    <div class="section-header">
      <div class="section-tag">Early feedback</div>
      <h2>Artists already using it.</h2>
    </div>
    <div class="testimonials__grid">
      <div class="testi-card">
        <p>"First time I've ever been able to pull a clean bass track from an AI beat without it bleeding into the kick. This is different."</p>
        <div class="testi-card__author">
          <div class="testi-card__avatar">KD</div>
          <div><strong>Kay D.</strong><span>Rapper / Atlanta</span></div>
        </div>
      </div>
      <div class="testi-card">
        <p>"I produce professionally. I was skeptical. The fact that every instrument is truly isolated — not separated from a mix — changes everything."</p>
        <div class="testi-card__author">
          <div class="testi-card__avatar">MR</div>
          <div><strong>M. Ramos</strong><span>Producer / LA</span></div>
        </div>
      </div>
      <div class="testi-card">
        <p>"Finally I can tell my engineer exactly what's in the beat. No guessing. Flute track says Flute. Done."</p>
        <div class="testi-card__author">
          <div class="testi-card__avatar">JL</div>
          <div><strong>Jada L.</strong><span>Artist / New York</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- FINAL CTA -->
<section class="final-cta">
  <div class="container">
    <div class="final-cta__box">
      <div class="final-cta__orb"></div>
      <h2>Your next beat.<br/>Every track. Ready to download.</h2>
      <p>Start with 150 free credits. No card required. Upgrade when you need stems.</p>
      <a href="/signup" class="btn btn--primary btn--lg">Start generating free <i class="fas fa-arrow-right"></i></a>
    </div>
  </div>
</section>

</main>`)
}

// ─── PRICING ──────────────────────────────────────────────────────────────────

function pricingPage() {
  return shell('Pricing', `
<main class="inner-page">
<section class="inner-hero">
  <div class="container">
    <div class="section-tag">Pricing</div>
    <h1>Simple, honest pricing.</h1>
    <p>Start free. Upgrade when you need more depth. No hidden fees, no confusing bundles.</p>
  </div>
</section>

<section class="pricing-full">
  <div class="container">
    <div class="plans-grid plans-grid--full">
      <div class="plan-card">
        <div class="plan-card__tier">Free</div>
        <div class="plan-card__price"><span class="plan-card__amount">$0</span><span>/month</span></div>
        <p class="plan-card__desc">Test the engine. Hear the quality. No card needed.</p>
        <div class="plan-card__credits">
          <i class="fas fa-coins"></i> 150 credits/month + 5/day refresh
        </div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Draft previews (10 credits each)</li>
          <li><i class="fas fa-check"></i> Limited stereo exports</li>
          <li><i class="fas fa-check"></i> Basic queue access</li>
          <li class="muted"><i class="fas fa-times"></i> Commercial use</li>
          <li class="muted"><i class="fas fa-times"></i> Master export</li>
          <li class="muted"><i class="fas fa-times"></i> Premaster export</li>
          <li class="muted"><i class="fas fa-times"></i> Grouped stems</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
          <li class="muted"><i class="fas fa-times"></i> Track regeneration</li>
          <li class="muted"><i class="fas fa-times"></i> Credit rollover</li>
        </ul>
        <a href="/signup" class="btn btn--outline btn--full">Start free</a>
      </div>
      <div class="plan-card plan-card--featured">
        <div class="plan-card__badge">Most popular</div>
        <div class="plan-card__tier">Creator</div>
        <div class="plan-card__price"><span class="plan-card__amount">$12</span><span>/month</span></div>
        <p class="plan-card__desc">For rappers, writers, and content creators who need clean beats.</p>
        <div class="plan-card__credits">
          <i class="fas fa-coins"></i> 3,000 credits/month + 25% rollover
        </div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Full stereo beats (50 credits)</li>
          <li><i class="fas fa-check"></i> Mastered export (10 credits)</li>
          <li><i class="fas fa-check"></i> Premaster export (10 credits)</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> Priority queue over free</li>
          <li><i class="fas fa-check"></i> 25% monthly credit rollover</li>
          <li class="muted"><i class="fas fa-times"></i> Grouped stems</li>
          <li class="muted"><i class="fas fa-times"></i> Individual tracks</li>
          <li class="muted"><i class="fas fa-times"></i> Track regeneration</li>
        </ul>
        <a href="/signup?plan=creator" class="btn btn--primary btn--full">Start Creator — $12/mo</a>
      </div>
      <div class="plan-card">
        <div class="plan-card__tier">Pro Artist</div>
        <div class="plan-card__price"><span class="plan-card__amount">$29</span><span>/month</span></div>
        <p class="plan-card__desc">For serious artists and producers who need every track clean.</p>
        <div class="plan-card__credits">
          <i class="fas fa-coins"></i> 10,000 credits/month + 50% rollover
        </div>
        <ul class="plan-card__features plan-card__features--full">
          <li><i class="fas fa-check"></i> Everything in Creator</li>
          <li><i class="fas fa-check"></i> Grouped stems (60 credits)</li>
          <li><i class="fas fa-check"></i> Individual track export (180 credits)</li>
          <li><i class="fas fa-check"></i> Regenerate one track (15 credits)</li>
          <li><i class="fas fa-check"></i> Replace one instrument (20 credits)</li>
          <li><i class="fas fa-check"></i> Rearrangement pass (20 credits)</li>
          <li><i class="fas fa-check"></i> Highest priority queue</li>
          <li><i class="fas fa-check"></i> 50% monthly credit rollover</li>
        </ul>
        <a href="/signup?plan=pro" class="btn btn--outline btn--full">Start Pro Artist — $29/mo</a>
      </div>
    </div>

    <!-- Credit table -->
    <div class="credit-table-wrap">
      <div class="section-header">
        <div class="section-tag">Credit costs</div>
        <h2>Exactly what each action costs.</h2>
        <p>No surprise charges. Every credit spend is shown before you confirm.</p>
      </div>
      <div class="credit-table">
        <div class="credit-table__row credit-table__row--header">
          <span>Action</span><span>Credits</span><span>Who can use it</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-play"></i> Draft preview (30–45s)</span><span class="credit-val">10</span><span class="tier-badge tier-badge--free">All plans</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-music"></i> Full stereo beat (2–3 min)</span><span class="credit-val">50</span><span class="tier-badge tier-badge--creator">Creator+</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-compact-disc"></i> Mastered export</span><span class="credit-val">10</span><span class="tier-badge tier-badge--creator">Creator+</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-sliders"></i> Premaster export</span><span class="credit-val">10</span><span class="tier-badge tier-badge--creator">Creator+</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-layer-group"></i> Grouped stems (4 files)</span><span class="credit-val">60</span><span class="tier-badge tier-badge--pro">Pro Artist</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-list"></i> Individual track export (8–12 files)</span><span class="credit-val">180</span><span class="tier-badge tier-badge--pro">Pro Artist</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-redo"></i> Regenerate one track only</span><span class="credit-val">15</span><span class="tier-badge tier-badge--pro">Pro Artist</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-exchange-alt"></i> Replace one instrument</span><span class="credit-val">20</span><span class="tier-badge tier-badge--pro">Pro Artist</span>
        </div>
        <div class="credit-table__row">
          <span><i class="fas fa-sitemap"></i> Rearrangement pass</span><span class="credit-val">20</span><span class="tier-badge tier-badge--pro">Pro Artist</span>
        </div>
      </div>
    </div>

    <!-- Credit calculator -->
    <div class="calc-wrap">
      <div class="section-header">
        <div class="section-tag">Credit calculator</div>
        <h2>Estimate your monthly usage.</h2>
      </div>
      <div class="calc-card">
        <div class="calc-row">
          <label>Full stereo beats per month</label>
          <div class="calc-input-wrap"><input type="number" id="calc-beats" value="10" min="0" max="200"/><span>× 50 credits</span></div>
        </div>
        <div class="calc-row">
          <label>Master + premaster exports</label>
          <div class="calc-input-wrap"><input type="number" id="calc-masters" value="8" min="0" max="200"/><span>× 20 credits</span></div>
        </div>
        <div class="calc-row">
          <label>Grouped stems packs</label>
          <div class="calc-input-wrap"><input type="number" id="calc-stems" value="3" min="0" max="200"/><span>× 60 credits</span></div>
        </div>
        <div class="calc-row">
          <label>Individual track exports</label>
          <div class="calc-input-wrap"><input type="number" id="calc-tracks" value="2" min="0" max="200"/><span>× 180 credits</span></div>
        </div>
        <div class="calc-row">
          <label>Track regenerations</label>
          <div class="calc-input-wrap"><input type="number" id="calc-regen" value="5" min="0" max="200"/><span>× 15 credits</span></div>
        </div>
        <div class="calc-result" id="calc-result">
          <div class="calc-result__total">Estimated: <span id="calc-total">1,035</span> credits/month</div>
          <div class="calc-result__rec" id="calc-rec">Recommended plan: <strong id="calc-plan">Pro Artist</strong></div>
        </div>
      </div>
    </div>

    <!-- FAQ -->
    <div class="faq-wrap">
      <div class="section-header">
        <div class="section-tag">FAQ</div>
        <h2>Common questions.</h2>
      </div>
      <div class="faq">
        <div class="faq-item" data-faq>
          <button class="faq-item__q" data-faq-button>Do unused credits roll over? <i class="fas fa-chevron-down"></i></button>
          <div class="faq-item__a">Free plans: no rollover. Creator: up to 25% of monthly credits roll over. Pro Artist: up to 50% of monthly credits roll over. Rolled-over credits expire at the end of the next billing cycle.</div>
        </div>
        <div class="faq-item" data-faq>
          <button class="faq-item__q" data-faq-button>What is the difference between grouped stems and individual tracks? <i class="fas fa-chevron-down"></i></button>
          <div class="faq-item__a">Grouped stems give you 4 files: Drums, Bass, Music, and FX. Individual tracks give you every single instrument separately — kick alone, snare alone, hats alone, bass alone, Rhodes alone, guitar alone, pad alone, and so on. Individual tracks is the professional option for DAW work, remixing, and full production control.</div>
        </div>
        <div class="faq-item" data-faq>
          <button class="faq-item__q" data-faq-button>Can I use the beats commercially? <i class="fas fa-chevron-down"></i></button>
          <div class="faq-item__a">Yes — all Creator and Pro Artist exports include full commercial use rights. Free plan exports are non-commercial only.</div>
        </div>
        <div class="faq-item" data-faq>
          <button class="faq-item__q" data-faq-button>How many instruments does a typical beat have? <i class="fas fa-chevron-down"></i></button>
          <div class="faq-item__a">Most StemForge beats generate between 8 and 12 individual instruments depending on genre and arrangement density. Your prompt can request more or fewer layers, and the system always tells you exactly how many tracks were generated before you export.</div>
        </div>
        <div class="faq-item" data-faq>
          <button class="faq-item__q" data-faq-button>Can I cancel anytime? <i class="fas fa-chevron-down"></i></button>
          <div class="faq-item__a">Yes. Cancel anytime from your account settings. You keep access until the end of your current billing period. No cancellation fees.</div>
        </div>
      </div>
    </div>
  </div>
</section>
</main>`)
}

// ─── GENERATOR ────────────────────────────────────────────────────────────────

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
    <h4>Duration</h4>
    <div class="toggle-group" id="gen-dur">
      <button class="toggle-btn" data-val="1">1 min</button>
      <button class="toggle-btn active" data-val="2">2 min</button>
      <button class="toggle-btn" data-val="3">3 min</button>
    </div>
  </div>
  <div class="app-sidebar__section">
    <h4>Instruments (include)</h4>
    <div class="tag-group" id="instr-include">
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
    <div class="tag-group" id="instr-exclude">
      <span class="inst-tag inst-tag--exclude" data-instr="Retro">Retro</span>
      <span class="inst-tag inst-tag--exclude" data-instr="8-bit">8-bit</span>
    </div>
  </div>
  <div class="credit-pill"><i class="fas fa-coins"></i> 150 credits remaining</div>
</div>

<div class="app-main">
  <div class="app-main__top">
    <div class="prompt-box">
      <label class="prompt-box__label">Beat description</label>
      <textarea class="prompt-box__input" id="gen-prompt" placeholder="Describe your beat... e.g. dark surf noir trap beat, open vocal space, minimal percussion, moody Rhodes"
      ></textarea>
      <div class="prompt-box__meta">
        <span class="prompt-box__preview" id="prompt-preview">Start typing to build your prompt preview...</span>
        <span class="prompt-box__cost"><i class="fas fa-coins"></i> 10 credits (draft) / 50 credits (full)</span>
      </div>
    </div>
    <div class="gen-actions">
      <button class="btn btn--ghost" id="gen-draft-btn"><i class="fas fa-eye"></i> Draft preview — 10 cr</button>
      <button class="btn btn--primary" id="gen-full-btn"><i class="fas fa-play"></i> Generate full beat — 50 cr</button>
    </div>
  </div>

  <!-- Result area -->
  <div class="gen-result" id="gen-result" style="display:none">
    <div class="gen-result__header">
      <div>
        <h3 id="gen-result-title">Surf Noir Trap — 90 BPM</h3>
        <p id="gen-result-sub">Generated · 8 individual tracks · 2:14</p>
      </div>
      <div class="gen-result__status"><span class="status-dot status-dot--ready"></span> Ready</div>
    </div>

    <!-- waveform tracks -->
    <div class="track-list" id="track-list">
      <div class="track-row" data-track="Kick">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--kick)"><i class="fas fa-drum"></i></span>
          <div><strong>Kick</strong><span>Drums</span></div>
        </div>
        <div class="track-row__wave" id="wave-kick"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="Snare">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--snare)"><i class="fas fa-drum"></i></span>
          <div><strong>Snare</strong><span>Drums</span></div>
        </div>
        <div class="track-row__wave" id="wave-snare"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="Hi-hats">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--hats)"><i class="fas fa-drum"></i></span>
          <div><strong>Hi-hats</strong><span>Drums</span></div>
        </div>
        <div class="track-row__wave" id="wave-hats"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="Bass">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--bass)"><i class="fas fa-guitar"></i></span>
          <div><strong>Bass</strong><span>Low end</span></div>
        </div>
        <div class="track-row__wave" id="wave-bass"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="Rhodes">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--rhodes)"><i class="fas fa-music"></i></span>
          <div><strong>Rhodes</strong><span>Keys</span></div>
        </div>
        <div class="track-row__wave" id="wave-rhodes"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="Guitar">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--guitar)"><i class="fas fa-guitar"></i></span>
          <div><strong>Guitar</strong><span>Melodic</span></div>
        </div>
        <div class="track-row__wave" id="wave-guitar"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="Pad">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--pad)"><i class="fas fa-wave-square"></i></span>
          <div><strong>Pad</strong><span>Atmosphere</span></div>
        </div>
        <div class="track-row__wave" id="wave-pad"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
      <div class="track-row" data-track="FX">
        <div class="track-row__info">
          <span class="track-row__icon" style="background:var(--fx)"><i class="fas fa-magic"></i></span>
          <div><strong>FX</strong><span>Transitions</span></div>
        </div>
        <div class="track-row__wave" id="wave-fx"></div>
        <div class="track-row__actions">
          <button class="icon-btn solo-btn" title="Solo"><i class="fas fa-headphones"></i></button>
          <button class="icon-btn mute-btn" title="Mute"><i class="fas fa-volume-mute"></i></button>
          <span class="track-row__dl locked-pro" title="Pro Artist only"><i class="fas fa-lock"></i></span>
        </div>
      </div>
    </div>

    <!-- Export panel -->
    <div class="export-panel">
      <h4>Export options</h4>
      <div class="export-options">
        <button class="export-btn"><i class="fas fa-file-audio"></i><span>Stereo mix</span><small>Free</small></button>
        <button class="export-btn"><i class="fas fa-compact-disc"></i><span>Master</span><small>10 cr</small></button>
        <button class="export-btn"><i class="fas fa-sliders"></i><span>Premaster</span><small>10 cr</small></button>
        <button class="export-btn export-btn--locked"><i class="fas fa-layer-group"></i><span>Grouped stems</span><small>60 cr · Pro</small></button>
        <button class="export-btn export-btn--locked"><i class="fas fa-list"></i><span>All tracks</span><small>180 cr · Pro</small></button>
      </div>
      <a href="/pricing" class="upgrade-nudge"><i class="fas fa-arrow-up"></i> Upgrade to Pro Artist to unlock grouped stems and all individual tracks</a>
    </div>
  </div>

  <!-- Empty state -->
  <div class="gen-empty" id="gen-empty">
    <div class="gen-empty__icon"><i class="fas fa-wave-square"></i></div>
    <h3>Your beat will appear here.</h3>
    <p>Set your options on the left, describe your beat above, and hit generate.</p>
  </div>
</div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>` + `
<style>
.app-shell { display:flex; min-height:calc(100vh - 0px); padding-top:70px; }
</style>`)
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function dashboardPage() {
  return shell('Dashboard', `
<main class="inner-page app-shell">
<div class="app-sidebar app-sidebar--dash">
  <div class="dash-user">
    <div class="dash-user__avatar">KD</div>
    <div><strong>Kay D.</strong><span class="dash-user__plan plan-badge plan-badge--creator">Creator</span></div>
  </div>
  <nav class="dash-nav">
    <a href="/dashboard" class="dash-nav__item active"><i class="fas fa-th-large"></i> Projects</a>
    <a href="/generator" class="dash-nav__item"><i class="fas fa-play-circle"></i> New beat</a>
    <a href="#" class="dash-nav__item"><i class="fas fa-coins"></i> Credits</a>
    <a href="#" class="dash-nav__item"><i class="fas fa-cog"></i> Settings</a>
  </nav>
  <div class="dash-credits-card">
    <div class="dash-credits-card__label">Credits remaining</div>
    <div class="dash-credits-card__val">1,840 <small>/ 3,000</small></div>
    <div class="dash-credits-card__bar"><div style="width:61%"></div></div>
    <div class="dash-credits-card__refresh">+5 daily refresh at midnight</div>
    <a href="/pricing" class="btn btn--primary btn--sm btn--full" style="margin-top:12px">Upgrade to Pro Artist</a>
  </div>
</div>

<div class="app-main">
  <div class="dash-header">
    <h2>My Projects</h2>
    <a href="/generator" class="btn btn--primary"><i class="fas fa-plus"></i> New beat</a>
  </div>

  <div class="dash-filters">
    <button class="filter-btn active">All</button>
    <button class="filter-btn">Trap</button>
    <button class="filter-btn">R&B</button>
    <button class="filter-btn">Drill</button>
  </div>

  <div class="project-grid">
    <a href="/project" class="project-card">
      <div class="project-card__art project-card__art--1">
        <div class="project-card__play"><i class="fas fa-play"></i></div>
      </div>
      <div class="project-card__body">
        <h4>Surf Noir Trap</h4>
        <p>90 BPM · 8 tracks · 2:14</p>
        <div class="project-card__tags">
          <span class="export-badge export-badge--stereo">Stereo</span>
          <span class="export-badge export-badge--master">Master</span>
        </div>
      </div>
    </a>
    <a href="/project" class="project-card">
      <div class="project-card__art project-card__art--2">
        <div class="project-card__play"><i class="fas fa-play"></i></div>
      </div>
      <div class="project-card__body">
        <h4>Dark Drill Night</h4>
        <p>140 BPM · 10 tracks · 3:01</p>
        <div class="project-card__tags">
          <span class="export-badge export-badge--stereo">Stereo</span>
        </div>
      </div>
    </a>
    <a href="/project" class="project-card">
      <div class="project-card__art project-card__art--3">
        <div class="project-card__play"><i class="fas fa-play"></i></div>
      </div>
      <div class="project-card__body">
        <h4>Melodic R&B Summer</h4>
        <p>78 BPM · 9 tracks · 2:45</p>
        <div class="project-card__tags">
          <span class="export-badge export-badge--stereo">Stereo</span>
          <span class="export-badge export-badge--master">Master</span>
          <span class="export-badge export-badge--pre">Premaster</span>
        </div>
      </div>
    </a>
    <div class="project-card project-card--new">
      <a href="/generator" class="project-card__new-inner">
        <i class="fas fa-plus-circle"></i>
        <span>New beat</span>
      </a>
    </div>
  </div>

  <div class="dash-activity">
    <h3>Recent activity</h3>
    <div class="activity-list">
      <div class="activity-item"><i class="fas fa-file-audio"></i><span>Stereo export — Surf Noir Trap</span><small>2 hours ago · free</small></div>
      <div class="activity-item"><i class="fas fa-compact-disc"></i><span>Master export — Melodic R&B Summer</span><small>Yesterday · 10 credits</small></div>
      <div class="activity-item"><i class="fas fa-play"></i><span>Full beat generated — Dark Drill Night</span><small>2 days ago · 50 credits</small></div>
      <div class="activity-item"><i class="fas fa-play"></i><span>Full beat generated — Surf Noir Trap</span><small>3 days ago · 50 credits</small></div>
    </div>
  </div>
</div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

// ─── PROJECT ──────────────────────────────────────────────────────────────────

function projectPage() {
  return shell('Project Export', `
<main class="inner-page app-shell">
<div class="app-sidebar app-sidebar--dash">
  <nav class="dash-nav">
    <a href="/dashboard" class="dash-nav__item"><i class="fas fa-arrow-left"></i> Back to projects</a>
    <a href="/generator" class="dash-nav__item"><i class="fas fa-plus"></i> New beat</a>
  </nav>
  <div class="project-meta-card">
    <div class="project-meta-card__art project-card__art--1"></div>
    <h4>Surf Noir Trap</h4>
    <p>90 BPM · D Minor · 2:14</p>
    <p>8 individual tracks generated</p>
    <div class="project-meta-card__plan plan-badge plan-badge--creator">Creator plan</div>
  </div>
  <div class="dash-credits-card" style="margin-top:16px">
    <div class="dash-credits-card__label">Credits remaining</div>
    <div class="dash-credits-card__val">1,840</div>
    <a href="/pricing" class="btn btn--primary btn--sm btn--full" style="margin-top:8px">Unlock stems — Upgrade</a>
  </div>
</div>

<div class="app-main">
  <div class="dash-header">
    <h2>Surf Noir Trap <span class="dash-header__sub">Export options</span></h2>
  </div>

  <!-- Export tier cards -->
  <div class="export-tier-grid">
    <div class="export-tier-card export-tier-card--available">
      <div class="export-tier-card__icon"><i class="fas fa-file-audio"></i></div>
      <div class="export-tier-card__body">
        <h4>Stereo mix</h4>
        <p>Full stereo bounce of the beat, mixed and ready.</p>
        <span class="credit-tag">Free</span>
      </div>
      <button class="btn btn--primary btn--sm"><i class="fas fa-download"></i> Download</button>
    </div>
    <div class="export-tier-card export-tier-card--available">
      <div class="export-tier-card__icon"><i class="fas fa-compact-disc"></i></div>
      <div class="export-tier-card__body">
        <h4>Mastered export</h4>
        <p>Professionally mastered stereo file, loudness normalized.</p>
        <span class="credit-tag">10 credits</span>
      </div>
      <button class="btn btn--primary btn--sm"><i class="fas fa-download"></i> Export — 10 cr</button>
    </div>
    <div class="export-tier-card export-tier-card--available">
      <div class="export-tier-card__icon"><i class="fas fa-sliders"></i></div>
      <div class="export-tier-card__body">
        <h4>Premaster export</h4>
        <p>Clean mix before mastering — send to your engineer.</p>
        <span class="credit-tag">10 credits</span>
      </div>
      <button class="btn btn--primary btn--sm"><i class="fas fa-download"></i> Export — 10 cr</button>
    </div>
    <div class="export-tier-card export-tier-card--locked">
      <div class="export-tier-card__icon"><i class="fas fa-layer-group"></i></div>
      <div class="export-tier-card__body">
        <h4>Grouped stems <span class="lock-badge"><i class="fas fa-lock"></i> Pro Artist</span></h4>
        <p>4 files: Drums / Bass / Music / FX. Great for remixing.</p>
        <span class="credit-tag">60 credits</span>
      </div>
      <a href="/pricing" class="btn btn--outline btn--sm">Upgrade to unlock</a>
    </div>
    <div class="export-tier-card export-tier-card--locked">
      <div class="export-tier-card__icon"><i class="fas fa-list"></i></div>
      <div class="export-tier-card__body">
        <h4>Individual tracks <span class="lock-badge"><i class="fas fa-lock"></i> Pro Artist</span></h4>
        <p>Every instrument on its own file. Kick. Snare. Rhodes. All 8 tracks.</p>
        <span class="credit-tag">180 credits</span>
      </div>
      <a href="/pricing" class="btn btn--outline btn--sm">Upgrade to unlock</a>
    </div>
  </div>

  <!-- Track preview -->
  <div class="project-tracks">
    <h3>8 individual tracks in this beat</h3>
    <p class="project-tracks__note">Upgrade to Pro Artist to download any of these as individual files.</p>
    <div class="track-list">
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--kick)"><i class="fas fa-drum"></i></span><div><strong>Kick</strong><span>Drums</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--snare)"><i class="fas fa-drum"></i></span><div><strong>Snare</strong><span>Drums</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--hats)"><i class="fas fa-drum"></i></span><div><strong>Hi-hats</strong><span>Drums</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--bass)"><i class="fas fa-guitar"></i></span><div><strong>Bass</strong><span>Low end</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--rhodes)"><i class="fas fa-music"></i></span><div><strong>Rhodes</strong><span>Keys</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--guitar)"><i class="fas fa-guitar"></i></span><div><strong>Guitar</strong><span>Melodic</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--pad)"><i class="fas fa-wave-square"></i></span><div><strong>Pad</strong><span>Atmosphere</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
      <div class="track-row"><div class="track-row__info"><span class="track-row__icon" style="background:var(--fx)"><i class="fas fa-magic"></i></span><div><strong>FX</strong><span>Transitions</span></div></div><div class="track-row__wave" data-autofill></div><div class="track-row__actions"><span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span></div></div>
    </div>
  </div>
</div>
</main>`, `<style>.sf-nav{display:none}</style>`)
}

// ─── SIGNUP ───────────────────────────────────────────────────────────────────

function signupPage() {
  return shell('Create your account', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo">
        <span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span>
        <span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <h1>Start generating.<br/>Keep every track.</h1>
      <ul class="auth-benefits">
        <li><i class="fas fa-check-circle"></i> 150 free credits, no card needed</li>
        <li><i class="fas fa-check-circle"></i> Real individual track export on Pro</li>
        <li><i class="fas fa-check-circle"></i> Commercial use on paid plans</li>
        <li><i class="fas fa-check-circle"></i> Cancel anytime</li>
      </ul>
      <div class="auth-testimonial">
        <p>"First time I've pulled a clean bass track from an AI beat without it bleeding into the kick."</p>
        <strong>Kay D. — Rapper / Atlanta</strong>
      </div>
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
          <div class="form-group">
            <label>Full name</label>
            <input type="text" placeholder="Your name" autocomplete="name"/>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" placeholder="you@example.com" autocomplete="email"/>
          </div>
          <div class="form-group">
            <label>Password</label>
            <div class="input-icon-wrap">
              <input type="password" id="pw-input" placeholder="At least 8 characters" autocomplete="new-password"/>
              <button type="button" class="input-icon-btn" id="pw-toggle"><i class="fas fa-eye" id="pw-eye"></i></button>
            </div>
            <div class="pw-strength" id="pw-strength"></div>
          </div>
          <div class="form-group">
            <label>Plan (you can change anytime)</label>
            <div class="plan-radio-group">
              <label class="plan-radio"><input type="radio" name="plan" value="free" checked/><span>Free — $0</span></label>
              <label class="plan-radio"><input type="radio" name="plan" value="creator"/><span>Creator — $12/mo</span></label>
              <label class="plan-radio"><input type="radio" name="plan" value="pro"/><span>Pro Artist — $29/mo</span></label>
            </div>
          </div>
          <div class="form-group form-group--check">
            <label class="checkbox-label"><input type="checkbox" required/> I agree to the <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a></label>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg">Create account <i class="fas fa-arrow-right"></i></button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────

function loginPage() {
  return shell('Log in', `
<main class="auth-page">
  <div class="auth-split">
    <div class="auth-split__left">
      <a href="/" class="sf-nav__logo auth-logo">
        <span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span>
        <span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
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

        <div class="oauth-btns">
          <button class="oauth-btn"><i class="fab fa-google"></i> Continue with Google</button>
          <button class="oauth-btn"><i class="fab fa-apple"></i> Continue with Apple</button>
        </div>
        <div class="auth-divider"><span>or log in with email</span></div>

        <form class="auth-form" id="login-form">
          <div class="form-group">
            <label>Email</label>
            <input type="email" placeholder="you@example.com" autocomplete="email"/>
          </div>
          <div class="form-group">
            <label>Password</label>
            <div class="input-icon-wrap">
              <input type="password" id="pw-input" placeholder="Your password" autocomplete="current-password"/>
              <button type="button" class="input-icon-btn" id="pw-toggle"><i class="fas fa-eye" id="pw-eye"></i></button>
            </div>
            <div class="form-group__hint"><a href="#">Forgot password?</a></div>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg">Log in <i class="fas fa-arrow-right"></i></button>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────

function checkoutPage() {
  return shell('Checkout', `
<main class="auth-page">
  <div class="checkout-wrap">
    <div class="checkout-left">
      <a href="/" class="sf-nav__logo auth-logo" style="margin-bottom:32px;display:inline-flex">
        <span class="sf-nav__logo-icon"><i class="fas fa-wave-square"></i></span>
        <span class="sf-nav__logo-text">Stem<span class="accent">Forge</span></span>
      </a>
      <div class="checkout-plan-summary">
        <div class="checkout-plan-summary__header">
          <div>
            <h3>Creator Plan</h3>
            <p>Billed monthly · Cancel anytime</p>
          </div>
          <div class="checkout-plan-summary__price">$12<span>/mo</span></div>
        </div>
        <ul class="checkout-plan-summary__features">
          <li><i class="fas fa-check"></i> 3,000 credits/month</li>
          <li><i class="fas fa-check"></i> Full stereo beats</li>
          <li><i class="fas fa-check"></i> Master + premaster exports</li>
          <li><i class="fas fa-check"></i> Commercial use rights</li>
          <li><i class="fas fa-check"></i> 25% credit rollover</li>
        </ul>
        <div class="checkout-plan-summary__total">
          <span>Total today</span>
          <strong>$12.00</strong>
        </div>
        <div class="checkout-plan-summary__switch">
          <a href="/pricing">Switch plan <i class="fas fa-arrow-right"></i></a>
        </div>
      </div>
      <div class="checkout-trust">
        <span><i class="fas fa-lock"></i> Secure payment</span>
        <span><i class="fas fa-shield-alt"></i> 256-bit SSL</span>
        <span><i class="fas fa-undo"></i> Cancel anytime</span>
      </div>
    </div>
    <div class="checkout-right">
      <div class="auth-card">
        <h2>Payment details</h2>
        <form class="auth-form" id="checkout-form">
          <div class="form-group">
            <label>Email</label>
            <input type="email" placeholder="you@example.com" value="kay@example.com"/>
          </div>
          <div class="form-group">
            <label>Cardholder name</label>
            <input type="text" placeholder="Name on card"/>
          </div>
          <div class="form-group">
            <label>Card number</label>
            <div class="input-icon-wrap">
              <input type="text" placeholder="1234 5678 9012 3456" maxlength="19" id="card-num"/>
              <span class="input-icon-btn" style="cursor:default;color:var(--muted)"><i class="fas fa-credit-card"></i></span>
            </div>
          </div>
          <div class="form-row-2">
            <div class="form-group">
              <label>Expiry</label>
              <input type="text" placeholder="MM / YY" maxlength="7" id="card-exp"/>
            </div>
            <div class="form-group">
              <label>CVC</label>
              <input type="text" placeholder="123" maxlength="4" id="card-cvc"/>
            </div>
          </div>
          <div class="form-group">
            <label>Billing country</label>
            <select class="sf-select">
              <option>United States</option>
              <option>United Kingdom</option>
              <option>Canada</option>
              <option>Australia</option>
              <option>Other</option>
            </select>
          </div>
          <button type="submit" class="btn btn--primary btn--full btn--lg" id="checkout-submit">
            <i class="fas fa-lock"></i> Start Creator — $12/month
          </button>
          <p class="checkout-legal">By subscribing you agree to our <a href="#">Terms</a> and <a href="#">Privacy Policy</a>. You can cancel at any time from account settings.</p>
        </form>
      </div>
    </div>
  </div>
</main>`, `<style>.sf-nav,.sf-footer{display:none}</style>`)
}

export default app
