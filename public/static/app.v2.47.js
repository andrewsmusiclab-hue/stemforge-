/* ═══════════════════════════════════════════════════════════════
   StemForge — Frontend App JS
   Real pipeline: GPT-4o blueprint → Mureka generation → track extraction
═══════════════════════════════════════════════════════════════ */

/**
 * _sfUpdateSidebarBonus(bonusCredits)
 * Shows/hides the bonus points row in the sidebar credits widget.
 * Bonus points are purchased top-up credits (consumed FIRST before subscription points).
 */
window._sfUpdateSidebarBonus = function(bonusCredits) {
  const row = document.getElementById('gs-bonus-row');
  const val = document.getElementById('gs-bonus-val');
  if (!row) return;
  if (bonusCredits > 0) {
    row.style.display = 'block';
    if (val) val.innerHTML = `${bonusCredits} <small>bonus</small>`;
  } else {
    row.style.display = 'none';
  }
};

/**
 * safeJson(res) — safely parse a fetch Response as JSON.
 * If the body is not valid JSON (e.g. Cloudflare "Internal Server Error" plain text),
 * returns { error: <status text>, _raw: <body text> } instead of throwing.
 */
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: res.ok ? 'Unexpected server response' : `Server error (${res.status})`, _raw: text };
  }
}

/* ── Global tooltip system ──────────────────────────────────────────────────
   Single <div id="sf-tooltip"> appended to <body> — completely outside all
   overflow/stacking-context containers. Triggered by any [data-tooltip] element.
   Appears BELOW the element (or to the right if near the bottom of the viewport).
   Style: light background + dark text matching the browser's native title tooltip.
────────────────────────────────────────────────────────────────────────────── */
(function sfTooltipSystem() {
  var tip = null;       // the singleton bubble
  var hideTimer = null; // delayed hide so rapid re-hover doesn't flicker

  function getTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'sf-tooltip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  function show(el) {
    var text = el.getAttribute('data-tooltip');
    if (!text) return;
    clearTimeout(hideTimer);

    var bubble = getTip();
    bubble.textContent = text;
    bubble.style.opacity = '0';
    bubble.style.display = 'block';

    // Position: prefer below-center, clamp to viewport edges
    var rect = el.getBoundingClientRect();
    var GAP  = 7;                              // px gap between element and bubble
    var vw   = window.innerWidth;
    var vh   = window.innerHeight;

    // Measure bubble after setting text (it's display:block now)
    var bw = bubble.offsetWidth;
    var bh = bubble.offsetHeight;

    // Try below first
    var top  = rect.bottom + GAP;
    var left = rect.left + (rect.width - bw) / 2;   // horizontally centered on element

    // If bubble would go off the bottom, flip to above
    if (top + bh > vh - 8) {
      top = rect.top - bh - GAP;
    }
    // Clamp left so it never goes off either side
    if (left < 8) left = 8;
    if (left + bw > vw - 8) left = vw - bw - 8;
    // If still somehow above the screen, pin to below regardless
    if (top < 4) top = rect.bottom + GAP;

    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top  = Math.round(top)  + 'px';
    bubble.style.opacity = '1';
  }

  function hide() {
    hideTimer = setTimeout(function() {
      if (tip) tip.style.opacity = '0';
    }, 80);
  }

  // Single delegated listeners on document — catches all current and future elements
  document.addEventListener('mouseover', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tooltip]') : null;
    if (el) show(el);
  }, true);

  document.addEventListener('mouseout', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tooltip]') : null;
    if (el) {
      // Only hide if we're actually leaving the element (not entering a child)
      var to = e.relatedTarget;
      if (!el.contains(to)) hide();
    }
  }, true);

  // Also hide on scroll/resize so stale tooltips don't hang around
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide, true);
})();

document.addEventListener('DOMContentLoaded', () => {

  // ── Nav scroll ─────────────────────────────────────────────────
  const nav = document.getElementById('sf-nav');
  if (nav) window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 20));

  // ── Hamburger ──────────────────────────────────────────────────
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobile-menu');
  if (hamburger && mobileMenu) hamburger.addEventListener('click', () => mobileMenu.classList.toggle('open'));

  // ── Waveform animation (hero) ──────────────────────────────────
  const trackColors = {
    kick:'#ef4444', snare:'#f97316', hats:'#eab308',
    bass:'#3b82f6', rhodes:'#8b5cf6', guitar:'#06b6d4',
    pad:'#10b981', fx:'#ec4899'
  };
  document.querySelectorAll('.wv-bars').forEach(container => {
    const color = trackColors[container.dataset.track] || '#4e9fff';
    for (let i = 0; i < 80; i++) {
      const bar = document.createElement('div');
      bar.className = 'wv-bar';
      bar.style.cssText = `height:${Math.random()*24+4}px;background:${color};
        animation-delay:${(Math.random()*1.2).toFixed(2)}s;
        animation-duration:${(0.8+Math.random()*0.8).toFixed(2)}s;
        opacity:${0.4+Math.random()*0.6};`;
      container.appendChild(bar);
    }
  });

  // ── FAQ accordion ──────────────────────────────────────────────
  document.querySelectorAll('[data-faq-button]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('[data-faq]');
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('[data-faq]').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  // ── Generator toggle groups ────────────────────────────────────
  document.querySelectorAll('.toggle-group').forEach(group => {
    group.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  // ── Instrument tags ────────────────────────────────────────────
  document.querySelectorAll('.inst-tag').forEach(tag => tag.addEventListener('click', () => tag.classList.toggle('active')));

  // ── Password toggle ────────────────────────────────────────────
  const pwToggle = document.getElementById('pw-toggle');
  const pwInput  = document.getElementById('pw-input');
  const pwEye    = document.getElementById('pw-eye');
  if (pwToggle && pwInput && pwEye) {
    pwToggle.addEventListener('click', () => {
      const isPass = pwInput.type === 'password';
      pwInput.type = isPass ? 'text' : 'password';
      pwEye.className = isPass ? 'fas fa-eye-slash' : 'fas fa-eye';
    });
  }

  // ── Password strength ──────────────────────────────────────────
  const pwStrength = document.getElementById('pw-strength');
  if (pwInput && pwStrength) {
    pwInput.addEventListener('input', () => {
      const v = pwInput.value;
      let score = 0;
      if (v.length >= 8) score++;
      if (/[A-Z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      const colors = ['#ef4444','#f97316','#eab308','#10b981'];
      const widths = ['25%','50%','75%','100%'];
      pwStrength.style.cssText = `height:3px;border-radius:2px;margin-top:6px;
        background:${colors[score-1]||'#1a2a48'};width:${widths[score-1]||'0%'};transition:all .3s ease;`;
    });
  }

  // ── Auth helper ────────────────────────────────────────────────
  function showAuthError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function hideAuthError(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  function setLoading(btn, loading, text) {
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<i class="fas fa-spinner fa-spin"></i> ' + (text || 'Please wait...')
      : btn.dataset.orig || btn.innerHTML;
  }

  // ── Signup form — real API call ────────────────────────────────
  const signupForm = document.getElementById('signup-form');
  if (signupForm) {
    const signupBtn = document.getElementById('signup-btn');
    signupBtn.dataset.orig = signupBtn.innerHTML;

    signupForm.addEventListener('submit', async e => {
      e.preventDefault();
      hideAuthError('auth-error');

      const name = signupForm.querySelector('[name=name]')?.value?.trim();
      const email = signupForm.querySelector('[name=email]')?.value?.trim();
      const password = signupForm.querySelector('[name=password]')?.value;
      const plan = signupForm.querySelector('input[name=plan]:checked')?.value || 'free';
      const terms = document.getElementById('su-terms')?.checked;

      if (!name) return showAuthError('auth-error', 'Please enter your full name.');
      if (!email) return showAuthError('auth-error', 'Please enter your email.');
      if (!password || password.length < 8) return showAuthError('auth-error', 'Password must be at least 8 characters.');
      if (!terms) return showAuthError('auth-error', 'Please agree to the Terms and Privacy Policy.');

      setLoading(signupBtn, true, 'Creating account...');
      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, plan })
        });
        const data = await res.json();
        if (!res.ok) {
          showAuthError('auth-error', data.error || 'Signup failed. Please try again.');
          setLoading(signupBtn, false);
          return;
        }
        // Account created — redirect
        signupBtn.innerHTML = '<i class="fas fa-check"></i> Account created!';
        signupBtn.style.background = '#10b981';
        setTimeout(() => window.location.href = data.redirect || '/dashboard', 800);
      } catch (err) {
        showAuthError('auth-error', 'Network error. Please try again.');
        setLoading(signupBtn, false);
      }
    });
  }

  // ── Login form — real API call ─────────────────────────────────
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    const loginBtn = document.getElementById('login-btn');
    loginBtn.dataset.orig = loginBtn.innerHTML;

    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      hideAuthError('auth-error');

      const email = loginForm.querySelector('[name=email]')?.value?.trim();
      const password = loginForm.querySelector('[name=password]')?.value;
      const next = loginForm.querySelector('[name=next]')?.value || '';

      if (!email) return showAuthError('auth-error', 'Please enter your email.');
      if (!password) return showAuthError('auth-error', 'Please enter your password.');

      setLoading(loginBtn, true, 'Logging in...');
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, next: next || undefined })
        });
        const data = await res.json();
        if (!res.ok) {
          showAuthError('auth-error', data.error || 'Login failed. Check your email and password.');
          setLoading(loginBtn, false);
          return;
        }
        loginBtn.innerHTML = '<i class="fas fa-check"></i> Logged in!';
        loginBtn.style.background = '#10b981';
        setTimeout(() => window.location.href = data.redirect || '/dashboard', 800);
      } catch (err) {
        showAuthError('auth-error', 'Network error. Please try again.');
        setLoading(loginBtn, false);
      }
    });
  }

  // ── Checkout page — Stripe redirect ───────────────────────────
  const checkoutSubmit = document.getElementById('checkout-submit');
  if (checkoutSubmit) {
    // Read plan from URL param
    const urlPlan = new URLSearchParams(window.location.search).get('plan') || 'creator';
    const planMeta = {
      creator: { name: 'Creator Plan', price: '$10', total: '$10.00', features: ['800 points/month', 'Mastered stereo mix download', 'Commercial use rights'] },
      pro:     { name: 'Pro Artist Plan', price: '$26', total: '$26.00', features: ['2,000 points/month', 'Stemforge Remix (20 pts)', 'Unmastered mix, mastered mix, or stems bundle', 'Priority queue'] },
    };
    const meta = planMeta[urlPlan] || planMeta.creator;

    // Update UI with plan details
    const coName = document.getElementById('co-plan-name');
    const coPrice = document.getElementById('co-plan-price');
    const coTotal = document.getElementById('co-plan-total');
    const coFeatures = document.getElementById('co-plan-features');
    const coBtnText = document.getElementById('co-btn-text');
    if (coName) coName.textContent = meta.name;
    if (coPrice) coPrice.textContent = meta.price;
    if (coTotal) coTotal.textContent = meta.total;
    if (coFeatures) coFeatures.innerHTML = meta.features.map(f => `<li><i class="fas fa-check"></i> ${f}</li>`).join('');
    if (coBtnText) coBtnText.textContent = `Continue to payment — ${meta.price}/mo`;

    checkoutSubmit.dataset.orig = checkoutSubmit.innerHTML;
    checkoutSubmit.addEventListener('click', async () => {
      const coError = document.getElementById('co-error');
      if (coError) coError.style.display = 'none';
      setLoading(checkoutSubmit, true, 'Redirecting to Stripe...');

      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: urlPlan })
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.redirect) { window.location.href = data.redirect; return; }
          if (coError) { coError.textContent = data.error || 'Checkout failed. Please try again.'; coError.style.display = 'block'; }
          setLoading(checkoutSubmit, false);
          return;
        }
        // Redirect to Stripe hosted checkout
        window.location.href = data.url;
      } catch (err) {
        if (coError) { coError.textContent = 'Network error. Please try again.'; coError.style.display = 'block'; }
        setLoading(checkoutSubmit, false);
      }
    });
  }

  // ── Dashboard payment=success banner ──────────────────────────
  if (window.location.pathname === '/dashboard') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:16px;right:16px;background:#10b981;color:#fff;padding:14px 20px;border-radius:10px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(16,185,129,.4);display:flex;align-items:center;gap:10px';
      banner.innerHTML = '<i class="fas fa-check-circle"></i> Subscription activated! Welcome to StemForge.';
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 5000);
      window.history.replaceState({}, '', '/dashboard');
    }
  }

  // ── Apply saved theme immediately ────────────────────────────
  const savedTheme = localStorage.getItem('sf-theme') || 'dark';
  if (savedTheme === 'light') document.body.classList.add('light');

  // ── Mark active sidebar nav item ─────────────────────────────
  const currentPath = window.location.pathname;
  document.querySelectorAll('.gs-sidebar__nav-item').forEach(link => {
    link.classList.remove('active');
    const page = link.dataset.page;
    const href  = link.getAttribute('href') || '';
    if (page === 'home'         && currentPath === '/')                    link.classList.add('active');
    if (page === 'generator'    && currentPath.startsWith('/generator'))   link.classList.add('active');
    if (page === 'dashboard'    && currentPath.startsWith('/dashboard'))   link.classList.add('active');
    if (page === 'feedback'     && currentPath.startsWith('/feedback'))    link.classList.add('active');
    if (page === 'admin'        && currentPath.startsWith('/admin'))       link.classList.add('active');
    // "Get More Credits" button links to /subscription — match by href
    if (!page && href === '/subscription' && currentPath.startsWith('/subscription')) link.classList.add('active');
  });

  // ── Mobile sidebar toggle ─────────────────────────────────────
  const gsMobileToggle = document.getElementById('gs-mobile-toggle');
  const gsSidebar = document.getElementById('gs-sidebar');
  if (gsMobileToggle && gsSidebar) {
    gsMobileToggle.addEventListener('click', () => gsSidebar.classList.toggle('open'));
    document.addEventListener('click', e => {
      if (!gsSidebar.contains(e.target)) gsSidebar.classList.remove('open');
    });
  }

  // ── What's New system ─────────────────────────────────────────
  // Add new entries here chronologically (newest first).
  // IMPORTANT: Each entry MUST have a unique `id` string.
  // The badge system compares localStorage against entries[0].id —
  // so every new entry automatically alerts ALL users with the NEW badge.
  window._sfWhatsNewEntries = [
    {
      id: 'aug2026-creator-autosplit-v2',
      date: 'August 2026',
      title: 'Creator Plan — Auto Split Now Available',
      tag: 'PLAN UPDATE',
      tagColor: '#38bdf8',
      body: `<ul style="margin:8px 0 0;padding:0 0 0 16px;line-height:1.7;font-size:.81rem;color:#94a3b8">
        <li><b style="color:#38bdf8">Creator can now use Auto Split</b> — Creator plan members can open the Stem Player on any beat and use the <b style="color:#38bdf8">Auto Split</b> tab to split their track into up to 5 stems: <span style="color:#e2e8f0">Vocals · Drums · Bass · Other · Instrumental</span>. One split costs 30 pts total — not per stem.</li>
        <li><b style="color:#e2e8f0">Vocals &amp; Instrumental stays Pro Artist only</b> — The V&amp;I tab (2-stem separation at 70 pts) remains exclusive to Pro Artist. Creator users will see a locked state with an upgrade prompt when they click that tab.</li>
        <li><b style="color:#e2e8f0">Free users still fully blocked</b> — Free plan users cannot access the Stem Player at all. Upgrade to Creator or Pro Artist to unlock splitting.</li>
        <li><b style="color:#e2e8f0">One Shot Creator added to Pro Artist</b> — The <i class="fas fa-bolt" style="color:#f59e0b"></i> <b style="color:#fcd34d">One Shot Creator</b> SFX generator is now listed on all Pro Artist plan cards across the site.</li>
      </ul>`
    },
    {
      id: 'aug2026-unlimited-downloads',
      date: 'August 2026',
      title: 'Unlimited WAV Downloads — No Caps',
      tag: 'UPGRADE',
      tagColor: '#22c55e',
      body: `<ul style="margin:8px 0 0;padding:0 0 0 16px;line-height:1.7;font-size:.81rem;color:#94a3b8">
        <li><b style="color:#4ade80">Unlimited WAV downloads for Creator &amp; Pro Artist</b> — We've removed all download caps. Download as many tracks as you want, whenever you want — no monthly limits, ever.</li>
        <li><b style="color:#e2e8f0">Free plan — upgrade to download</b> — Free users can create up to 3 tracks/month to try StemForge. Upgrade to Creator or Pro Artist to unlock WAV downloads with no restrictions.</li>
        <li><b style="color:#e2e8f0">Your beats, your files</b> — Every track you generate is yours. Download any time, as many times as you need.</li>
      </ul>`
    },
    {
      id: 'aug2026-visualizer',
      date: 'August 2026',
      title: 'Waveform Visualizer — Cards & Player',
      tag: 'NEW FEATURE',
      tagColor: '#a855f7',
      body: `<ul style="margin:8px 0 0;padding:0 0 0 16px;line-height:1.7;font-size:.81rem;color:#94a3b8">
        <li><b style="color:#e2e8f0">Animated beat cards</b> — Hover any beat or remix card in your library to see a live waveform animation in that track's color.</li>
        <li><b style="color:#e2e8f0">Mini player visualizer</b> — The player now shows a real-time waveform that reacts to whatever's playing, in full color.</li>
        <li><b style="color:#e2e8f0">Taller player</b> — The mini player has been expanded to give the visualizer more room and make playback controls easier to use.</li>
      </ul>`
    },
    {
      id: 'aug2026-bonus-points',
      date: 'August 2026',
      title: 'Bonus Points — Now Tracked Separately',
      tag: 'NEW FEATURE',
      tagColor: '#f59e0b',
      body: `<ul style="margin:8px 0 0;padding:0 0 0 16px;line-height:1.7;font-size:.81rem;color:#94a3b8">
        <li><b style="color:#e2e8f0">Bonus points separated</b> — Points you purchase via Top Up Packs are now shown in their own section in the sidebar and on your Subscription page, so you always know exactly how many subscription points vs. bonus points you have left.</li>
        <li><b style="color:#e2e8f0">Bonus consumed first</b> — When you use any feature, your bonus (purchased) points are always spent before your monthly subscription points. Your plan allowance lasts longer.</li>
        <li><b style="color:#e2e8f0">Sidebar upgrade</b> — The sidebar now shows two rows: <b>Points Remaining</b> (your plan allowance) and <b>⚡ Bonus Points</b> (your purchased top-up credits). The bonus row only appears when you have bonus points.</li>
        <li><b style="color:#e2e8f0">Subscription page upgrade</b> — The Points Remaining cell in the info bar now shows a gold <b>⚡ bonus pts</b> badge underneath when you have purchased credits available.</li>
      </ul>`
    },
    {
      id: 'aug2025-stem-upgrades',
      date: 'August 2025',
      title: 'Stem Player Upgrades & Credit Rebalance',
      tag: 'UPDATE',
      tagColor: '#4fc3f7',
      body: `<ul style="margin:8px 0 0;padding:0 0 0 16px;line-height:1.7;font-size:.81rem;color:#94a3b8">
        <li><b style="color:#e2e8f0">Auto Split renamed</b> — "Up to 5 Stems" is now called <b>Auto Split</b> for clarity.</li>
        <li><b style="color:#e2e8f0">New credit pricing</b> — Auto Split now costs <b>30 pts</b> (down from 75). Vocals &amp; Instrumental now costs <b>70 pts</b> (was 30) to reflect its higher quality output.</li>
        <li><b style="color:#e2e8f0">Master scrubber</b> — The stem player now has a full timeline scrubber so you can skip to any point in the track instantly.</li>
        <li><b style="color:#e2e8f0">Solo behaviour fixed</b> — Hitting Solo on a track now lights up the Mute button red on all other tracks, exactly like a DAW.</li>
        <li><b style="color:#e2e8f0">Full-mix stems removed</b> — "Song" and "Instrumental" stems (which were just the full stereo mix duplicated) no longer appear in the stem player.</li>
        <li><b style="color:#e2e8f0">Stem player header cleaned up</b> — Removed unnecessary branding from the stem player for a cleaner look.</li>
      </ul>`
    }
  ];

  // Badge key is based on the latest entry's unique id — every new entry
  // automatically triggers the NEW badge for all users who haven't seen it yet.
  const WHATS_NEW_KEY = 'sf_wn_seen_';
  window._sfOpenWhatsNew = function() {
    const overlay = document.getElementById('whats-new-overlay');
    if (!overlay) return;
    // Populate entries (repopulate each open so new entries always show)
    const container = overlay.querySelector('#whats-new-entries');
    if (container) {
      container.innerHTML = window._sfWhatsNewEntries.map(e => `
        <div style="background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:14px 16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:.6rem;font-weight:800;letter-spacing:.8px;background:${e.tagColor || '#4fc3f7'}22;color:${e.tagColor || '#4fc3f7'};border:1px solid ${e.tagColor || '#4fc3f7'}44;padding:2px 8px;border-radius:999px">${e.tag || 'UPDATE'}</span>
            <span style="font-size:.68rem;color:#6b7280">${e.date}</span>
          </div>
          <div style="font-size:.88rem;font-weight:700;color:#f1f5f9;margin-bottom:4px">${e.title}</div>
          ${e.body}
        </div>
      `).join('');
    }
    overlay.style.display = 'flex';
    // Mark latest entry as seen
    const latestId = window._sfWhatsNewEntries[0]?.id || 'seen';
    localStorage.setItem(WHATS_NEW_KEY + latestId, '1');
    const badge = document.getElementById('whats-new-badge');
    if (badge) badge.style.display = 'none';
  };
  window._sfCloseWhatsNew = function() {
    const overlay = document.getElementById('whats-new-overlay');
    if (overlay) overlay.style.display = 'none';
  };
  // Show NEW badge if user hasn't seen the latest entry by its unique id.
  // This means every time a new entry is added (new id), ALL users see the badge.
  window._sfCheckWhatsNewBadge = function() {
    const latestId = window._sfWhatsNewEntries[0]?.id || '';
    const seen = localStorage.getItem(WHATS_NEW_KEY + latestId);
    if (!seen) {
      const badge = document.getElementById('whats-new-badge');
      if (badge) badge.style.display = 'inline-flex';
    }
  };
  window._sfCheckWhatsNewBadge();

  // ── Show IP-blocked error on signup/register pages ────────────
  if (window.location.pathname === '/signup' || window.location.pathname === '/register') {
    const errParam = new URLSearchParams(window.location.search).get('error');
    if (errParam === 'ip_blocked') {
      const el = document.getElementById('auth-error');
      if (el) {
        el.innerHTML = '⚠️ <b>Account limit reached.</b> A free account was already created from your network. ' +
          'StemForge allows one free account per household. ' +
          'Please <a href="/login" style="color:inherit;text-decoration:underline">log in</a> to your existing account, or ' +
          '<a href="mailto:stemforgesupport@gmail.com" style="color:inherit;text-decoration:underline">contact support</a> if you think this is a mistake.';
        el.style.display = 'block';
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  }

  // ── Global auth state: populate sidebar + top nav ─────────────
  window._sfUser = null;
  (async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!res.ok) return;
      const { user } = await res.json();
      if (!user) return;
      window._sfUser = user;

      // ── Populate global sidebar ───────────────────────────────
      const gsUserBlock = document.getElementById('gs-user-block');
      const gsAvatar    = document.getElementById('gs-avatar');
      const gsUsername  = document.getElementById('gs-username');
      const gsPlanBadge = document.getElementById('gs-plan-badge');
      const gsCredits   = document.getElementById('gs-credits-block');
      const gsGensVal   = document.getElementById('gs-gens-val');
      const gsGensBar   = document.getElementById('gs-gens-bar');

      if (gsUserBlock) gsUserBlock.style.display = 'flex';
      if (gsCredits) gsCredits.style.display = 'block';
      // Hide the sign-in button now that we know the user is logged in
      const gsSigninBtn = document.getElementById('gs-signin-btn');
      if (gsSigninBtn) gsSigninBtn.style.display = 'none';
      // Show nav items that are hidden for unauthenticated users
      document.querySelectorAll('.gs-auth-nav').forEach(el => { el.style.display = 'flex'; });

      const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
      if (gsAvatar) {
        if (user.avatar) {
          gsAvatar.style.cssText += ';overflow:hidden;padding:0';
          gsAvatar.innerHTML = `<img src="${user.avatar}" alt="${user.name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
        } else {
          gsAvatar.textContent = initials;
        }
      }
      if (gsUsername) gsUsername.textContent = user.name;
      if (gsPlanBadge) {
        const planMap = { free: 'Free', creator: 'Creator', pro: 'Pro Artist' };
        const classMap = { creator: 'plan-badge--creator', pro: 'plan-badge--pro' };
        gsPlanBadge.textContent = planMap[user.plan] || 'Free';
        if (classMap[user.plan]) gsPlanBadge.classList.add(classMap[user.plan]);
      }
      // Show Admin sidebar link only to admin users (email-gated)
      if (user.is_admin) {
        const adminLink = document.getElementById('sidebar-admin-link');
        if (adminLink) adminLink.style.display = 'flex';
      }
      // Show What's New button + Get More Credits (logged-in only)
      const whatsNewBtn = document.getElementById('sidebar-whats-new-btn');
      if (whatsNewBtn) whatsNewBtn.style.display = 'flex';
      const getCreditsBtn = document.getElementById('sidebar-get-credits-btn');
      if (getCreditsBtn) getCreditsBtn.style.display = 'flex'; // show inside nav
      // Re-check badge now that button is visible
      if (typeof window._sfCheckWhatsNewBadge === 'function') window._sfCheckWhatsNewBadge();

      // ── Account locked overlay ────────────────────────────────
      if (user.account_locked) {
        const overlay = document.getElementById('account-locked-overlay');
        if (overlay) {
          // Populate reason text
          const reasonEl = document.getElementById('lock-reason-text');
          if (reasonEl && user.lock_reason) reasonEl.textContent = user.lock_reason;
          // Pre-fill support email with user's email
          const mailLink = overlay.querySelector('a[href^="mailto:"]');
          if (mailLink && user.email) {
            mailLink.href = mailLink.href + encodeURIComponent(user.email);
          }
          overlay.style.display = 'flex';
        }
      }
      // Show remaining points clearly: "X pts remaining" with used/limit below
      const plan = user.plan || 'free';
      const creditsLabel = document.getElementById('gs-credits-label');
      const limitMap = { free: 60, creator: 800, pro: 2000 };
      const displayLimit = user.gens_limit || limitMap[plan] || 3;
      const remaining = Math.max(0, displayLimit - user.gens_used);
      if (creditsLabel) creditsLabel.textContent = 'Points Remaining';
      if (gsGensVal) gsGensVal.innerHTML = `${remaining} <small>/ ${displayLimit}</small>`;
      if (gsGensBar) {
        const pct = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0;
        gsGensBar.style.width = pct + '%';
      }
      // Show bonus points row
      window._sfUpdateSidebarBonus(user.bonus_credits || 0);


            // ── Sidebar user dropdown toggle ──────────────────────────
      const gsUserBtn      = document.getElementById('gs-user-btn');
      const gsUserDropdown = document.getElementById('gs-user-dropdown');
      if (gsUserBtn && gsUserDropdown) {
        gsUserBtn.addEventListener('click', e => {
          e.stopPropagation();
          const wrap = gsUserBtn.closest('.gs-sidebar__user-wrap');
          const isOpen = wrap.classList.toggle('open');
          gsUserBtn.setAttribute('aria-expanded', isOpen);
          gsUserDropdown.setAttribute('aria-hidden', !isOpen);
        });
        // Close when clicking anywhere outside the sidebar user block
        document.addEventListener('click', e => {
          const wrap = document.querySelector('.gs-sidebar__user-wrap');
          if (wrap && !wrap.contains(e.target)) {
            wrap.classList.remove('open');
            gsUserBtn.setAttribute('aria-expanded', 'false');
            gsUserDropdown.setAttribute('aria-hidden', 'true');
          }
        });
      }

      // ── Theme toggle (sidebar dropdown) ──────────────────────
      const gsThemeBtn   = document.getElementById('gs-theme-btn');
      const gsThemeIcon  = document.getElementById('gs-theme-icon');
      const gsThemeLabel = document.getElementById('gs-theme-label');
      function applyThemeUI(isLight) {
        if (gsThemeIcon)  gsThemeIcon.className = isLight ? 'fas fa-sun' : 'fas fa-moon';
        if (gsThemeLabel) gsThemeLabel.textContent = isLight ? 'Light mode' : 'Dark mode';
        // Legacy top-nav theme elements (kept for compat)
        const legacyIcon  = document.getElementById('theme-icon');
        const legacyLabel = document.getElementById('theme-label');
        if (legacyIcon)  legacyIcon.className = isLight ? 'fas fa-sun' : 'fas fa-moon';
        if (legacyLabel) legacyLabel.textContent = isLight ? 'Light mode' : 'Dark mode';
      }
      applyThemeUI(savedTheme === 'light');
      if (gsThemeBtn) {
        gsThemeBtn.addEventListener('click', () => {
          const isLight = document.body.classList.toggle('light');
          localStorage.setItem('sf-theme', isLight ? 'light' : 'dark');
          applyThemeUI(isLight);
        });
      }
      // Legacy top-nav theme button (kept for compat)
      const legacyThemeBtn = document.getElementById('theme-toggle-btn');
      if (legacyThemeBtn) {
        legacyThemeBtn.addEventListener('click', () => {
          const isLight = document.body.classList.toggle('light');
          localStorage.setItem('sf-theme', isLight ? 'light' : 'dark');
          applyThemeUI(isLight);
        });
      }

      // ── Sign out (sidebar dropdown + legacy top-nav) ──────────
      async function doSignOut() {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login';
      }
      const gsSignoutBtn  = document.getElementById('gs-signout-btn');
      const legacySignout = document.getElementById('nav-signout-btn');
      if (gsSignoutBtn)  gsSignoutBtn.addEventListener('click', doSignOut);
      if (legacySignout) legacySignout.addEventListener('click', doSignOut);

      // ── Show track-list only for creator/pro plans ────────────
      const trackListEl = document.getElementById('track-list');
      if (trackListEl && (user.plan === 'creator' || user.plan === 'pro')) {
        trackListEl.style.display = 'block';
      }

      // ── Hide guest links, show user nav menu (legacy top nav) ─
      document.querySelectorAll('.nav-guest-only').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.nav-auth-only').forEach(el => el.style.display = '');
      const navUserMenu = document.getElementById('nav-user-menu');
      if (navUserMenu) navUserMenu.style.display = 'flex';

      const avatarEl = document.getElementById('nav-avatar-text');
      const nameEl   = document.getElementById('nav-username-text');
      if (avatarEl) {
        if (user.avatar) {
          avatarEl.innerHTML = `<img src="${user.avatar}" alt="${user.name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
        } else {
          avatarEl.textContent = initials;
        }
      }
      if (nameEl) nameEl.textContent = user.name.split(' ')[0];

      // Legacy top-nav dropdown toggle
      const avatarBtn = document.getElementById('nav-avatar-btn');
      const dropdown  = document.getElementById('nav-dropdown');
      if (avatarBtn && dropdown) {
        avatarBtn.addEventListener('click', e => {
          e.stopPropagation();
          dropdown.classList.toggle('open');
        });
        document.addEventListener('click', () => dropdown.classList.remove('open'));
      }

      // Legacy dashboard fields (kept for compat)
      const dashAvatar    = document.getElementById('dash-avatar');
      const dashUsername  = document.getElementById('dash-username');
      const dashPlanBadge = document.getElementById('dash-plan-badge');
      const dashGensVal   = document.getElementById('dash-gens-val');
      const dashGensBar   = document.getElementById('dash-gens-bar');
      if (dashAvatar) {
        if (user.avatar) { dashAvatar.style.cssText='overflow:hidden;padding:0'; dashAvatar.innerHTML=`<img src="${user.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`; }
        else dashAvatar.textContent = initials;
      }
      if (dashUsername) dashUsername.textContent = user.name;
      if (dashPlanBadge) {
        const planMap2 = { free:'Free', creator:'Creator', pro:'Pro Artist' };
        const classMap2 = { creator:'plan-badge--creator', pro:'plan-badge--pro' };
        dashPlanBadge.textContent = planMap2[user.plan] || 'Free';
        if (classMap2[user.plan]) dashPlanBadge.classList.add(classMap2[user.plan]);
      }
      const dashRemaining = Math.max(0, user.gens_limit - user.gens_used);
      if (dashGensVal) dashGensVal.innerHTML = `${dashRemaining} <small>/ ${user.gens_limit} pts left</small>`;
      if (dashGensBar) {
        const pct2 = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0;
        dashGensBar.style.width = pct2 + '%';
      }
    } catch(e) {}
  })();

  // ── One Shot: Pro Artist only — show/hide tab + creator button ──
  // Called once after user data loads; also called on plan change.
  function applyOneShotVisibility() {
    const plan = (window._sfUser && window._sfUser.plan) || 'free';
    const isPro = plan === 'pro' || plan === 'developer';
    // Library "One Shots" tab
    const oneshotTab = document.getElementById('lib-tab-oneshots');
    if (oneshotTab) oneshotTab.style.display = isPro ? '' : 'none';
    // Creator toolbar button — keep it visible but locked for non-Pro so users know it exists
    // (clicking it calls openOneShotGated which shows the upgrade prompt)
  }
  // Run on page load (after _sfUser resolves) and on any plan update
  // We use a MutationObserver-free approach: just call after the async block
  setTimeout(applyOneShotVisibility, 500);

  // ── Hide free-tier signup CTAs for users who already have an account ───────
  // Logged-in users don't need "Get started free" — but keep the Free card
  // visible on home/pricing so Creator/Pro users can see it (for downgrade info).
  // Only hide the signup button inside the card; keep the card itself shown.
  function applyFreeTierVisibility() {
    if (!window._sfUser) return; // not logged in — show everything
    // Hide just the "Get started free" signup button on home free card
    const homeFreeBtn = document.getElementById('home-free-plan-btn');
    if (homeFreeBtn) homeFreeBtn.style.display = 'none';
    // Hide just the signup button on pricing free card
    const pricingFreeBtn = document.getElementById('pricing-free-btn');
    if (pricingFreeBtn) pricingFreeBtn.style.display = 'none';
    // Hide "Try free (60 pts)" link on checkout page
    const tryFreeLinks = document.querySelectorAll('a[href="/signup"]');
    tryFreeLinks.forEach(function(el) {
      if (el.textContent && el.textContent.trim().startsWith('Try free')) {
        const parent = el.parentElement;
        if (parent) parent.style.display = 'none';
      }
    });
    // Hide "Start free. Upgrade when you need more depth." subtitle
    const pricingSubtitles = document.querySelectorAll('.section-header p');
    pricingSubtitles.forEach(function(el) {
      if (el.textContent && el.textContent.includes('Start free')) {
        el.style.display = 'none';
      }
    });
  }
  setTimeout(applyFreeTierVisibility, 600);

  // openRemixGated — Pro Artist only, blocks free and creator plans
  window.openRemixGated = function() {
    var plan = (window._sfUser && window._sfUser.plan) || 'free';
    if (plan !== 'pro' && plan !== 'developer') {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e1e3a;border:1px solid rgba(167,139,250,.4);color:#a78bfa;padding:12px 20px;border-radius:10px;font-size:.88rem;font-weight:600;z-index:9999;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,.4)';
      t.innerHTML = '<i class="fas fa-crown"></i> AI Remix is a Pro Artist feature. <a href="/pricing" style="color:#fff;text-decoration:underline;margin-left:8px">Upgrade</a>';
      document.body.appendChild(t);
      setTimeout(function() { t.remove(); }, 4000);
      return;
    }
    if (typeof window.openRemixUploadModal === 'function') window.openRemixUploadModal();
  };

  // openOneShotGated — checks plan before opening the One Shot popup
  window.openOneShotGated = function() {
    const plan = (window._sfUser && window._sfUser.plan) || 'free';
    if (plan !== 'pro' && plan !== 'developer') {
      if (typeof showUpgradeModal === 'function') {
        showUpgradeModal('One Shot Creator');
      } else if (typeof showUpgradeToast === 'function') {
        showUpgradeToast('One Shot Creator is a Pro Artist feature. Upgrade to unlock.');
      } else {
        alert('One Shot Creator requires the Pro Artist plan.\n\nUpgrade at stemforge.studio/pricing');
      }
      return;
    }
    if (typeof window.openCreatorPopup === 'function') window.openCreatorPopup('oneshot');
  };

  // ── Subscription page: Manage dropdown ─────────────────────────
  const subManageBtn = document.getElementById('sub-manage-btn');
  const subManageDrop = document.getElementById('sub-manage-dropdown');
  if (subManageBtn && subManageDrop) {
    subManageBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = subManageDrop.style.display === 'flex';
      subManageDrop.style.display = isOpen ? 'none' : 'flex';
      subManageDrop.style.flexDirection = 'column';
    });
    document.addEventListener('click', () => { if (subManageDrop) subManageDrop.style.display = 'none'; });
  }

  // ── Account page: sign out everywhere ──────────────────────────
  const signoutAllBtn = document.getElementById('signout-all-btn');
  if (signoutAllBtn) {
    signoutAllBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  LIBRARY (3-tab: Beats/Songs · One Shots · Trash)
  // ══════════════════════════════════════════════════════════════

  // Track which tabs have been fetched so we only fetch once per session
  const _libLoaded  = { beats: false, oneshots: false, trash: false, extended: false, uploads: false, remixes: false };
  // Expose on window so external code (generator, extend) can invalidate cache
  window._libLoaded = _libLoaded;
  // Cached project arrays per tab (for client-side search)
  const _libData    = { beats: [], oneshots: [], trash: [], extended: [], uploads: [], remixes: [] };
  let   _libActive  = 'beats';

  // ── Stable unique hue from any ID string ───────────────────
  // Spreads across full 360° — same ID always returns same hue,
  // neighbouring IDs land far apart (golden-angle stepping).
  function hueFromId(id) {
    // Hash the id string into a number
    var h = 0;
    var s = String(id || '0');
    for (var k = 0; k < s.length; k++) {
      h = (Math.imul(31, h) + s.charCodeAt(k)) | 0;
    }
    // Multiply by golden angle (137.508°) so sequential IDs spread evenly
    return ((Math.abs(h) * 137) % 360);
  }

  // ── Position-based hue spreader ─────────────────────────────
  // Uses the golden angle (137.508°) on the card's position index
  // so card 0, 1, 2, 3… always land far apart on the colour wheel.
  // A full palette of 12 perceptually-distinct hues cycles before any
  // repeat; at 26 cards the spread is still >13° between neighbours.
  // Falls back to hueFromId when no index is available.
  function hueFromIndex(idx, id) {
    if (idx == null || idx === undefined) return hueFromId(id);
    // Golden-angle stepping: 137.508° ≈ 137 — irrational, never repeats neatly
    return ((Math.round(idx) * 137) % 360 + 360) % 360;
  }

  // ── Canvas art generator (shared helper) ───────────────────
  // ── Logo pool: index 0 = original (hue-rotated), 1–20 = new unique variants (no filter) ──
  var _sfLogoPool = [
    { src: '/static/stemforge-logo.png',     hueRotate: true  }, // original — keep hue-rotate behaviour
    { src: '/static/stemforge-logo-v2.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v3.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v4.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v5.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v6.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v7.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v8.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v9.png',  hueRotate: false },
    { src: '/static/stemforge-logo-v10.png', hueRotate: false },
    { src: '/static/stemforge-logo-v11.png', hueRotate: false },
    { src: '/static/stemforge-logo-v12.png', hueRotate: false },
    { src: '/static/stemforge-logo-v13.png', hueRotate: false },
    { src: '/static/stemforge-logo-v14.png', hueRotate: false },
    { src: '/static/stemforge-logo-v15.png', hueRotate: false },
    { src: '/static/stemforge-logo-v16.png', hueRotate: false },
    { src: '/static/stemforge-logo-v17.png', hueRotate: false },
    { src: '/static/stemforge-logo-v18.png', hueRotate: false },
    { src: '/static/stemforge-logo-v19.png', hueRotate: false },
    { src: '/static/stemforge-logo-v20.png', hueRotate: false },
    { src: '/static/stemforge-logo-v21.png', hueRotate: false },
  ];
  // Cache of loaded Image objects keyed by src
  var _sfLogoCache = {};

  // Pick a stable logo index from the pool based on card position.
  // Pattern: every 6th card (positions 5, 11, 17...) gets a unique new logo
  // (cycling through v2–v21). All other cards get the original (index 0) with hue-rotate.
  // cardIdx = the card's position index in the grid (0-based)
  function _sfPickLogoIndex(cardIdx) {
    if ((cardIdx + 1) % 6 === 0) {
      // Which unique logo to use — cycle through indices 1–20 (v2–v21)
      var newLogoSlot = Math.floor(cardIdx / 6) % 20; // 0–19
      return newLogoSlot + 1; // maps to pool index 1–20
    }
    return 0; // original logo with hue-rotate
  }

  function _sfLoadLogo(idx, callback) {
    var entry = _sfLogoPool[idx];
    if (_sfLogoCache[entry.src] && _sfLogoCache[entry.src].complete && _sfLogoCache[entry.src].naturalWidth) {
      callback(_sfLogoCache[entry.src], entry.hueRotate);
      return;
    }
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = function() { _sfLogoCache[entry.src] = img; callback(img, entry.hueRotate); };
    img.onerror = function() { callback(null, false); };
    img.src = entry.src;
    _sfLogoCache[entry.src] = img; // store early to avoid double-loads
  }

  function drawCanvasArt(artEl, hue, title, genre, cardIdx) {
    var logoIdx = _sfPickLogoIndex(cardIdx != null ? cardIdx : 0);

    function doDraw(logoImg, applyHueRotate) {
    try {
      const W = 320, H = 320;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');

      // ── LAYER 1: Dark background gradient ──
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0,   `hsl(${hue},70%,14%)`);
      grad.addColorStop(0.5, `hsl(${(hue+50)%360},80%,8%)`);
      grad.addColorStop(1,   `hsl(${(hue+100)%360},65%,5%)`);
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      // ── LAYER 2: Logo ──
      if (logoImg && logoImg.complete && logoImg.naturalWidth) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        const off = document.createElement('canvas');
        off.width = W; off.height = H;
        const octx = off.getContext('2d');
        octx.drawImage(logoImg, 0, 0, W, H);
        // Original logo: apply hue-rotate so it matches the card colour
        // New unique logos: no filter — display their own colours as-is
        if (applyHueRotate) {
          ctx.filter = `hue-rotate(${hue}deg) saturate(1.4) brightness(0.8)`;
        }
        ctx.beginPath();
        ctx.rect(0, 48, W, H - 48);
        ctx.clip();
        ctx.drawImage(off, 0, 0);
        ctx.filter = 'none';
        ctx.restore();
      }

      // ── LAYER 3: Solid dark top band (title label area) ──
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      ctx.fillRect(0, 0, W, 46);

      // ── LAYER 4: Song title ──
      const _badLabel = /instrumental\s+only|no\s+vocals|include\s+instruments/i;
      const _rawLabel = (title && !_badLabel.test(title)) ? title : (genre || 'music');
      const labelText = _rawLabel.toUpperCase().replace(/_/g,' ').slice(0,18);
      ctx.font = '700 12px system-ui,sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 1.0;
      ctx.textAlign = 'center';
      ctx.letterSpacing = '2px';
      ctx.fillText(labelText, W/2, 29);
      ctx.letterSpacing = '0';

      // ── LAYER 5: Faint watermark ──
      ctx.font = '600 9px system-ui,sans-serif';
      ctx.fillStyle = `hsla(${hue},60%,70%,0.35)`;
      ctx.textAlign = 'right';
      ctx.letterSpacing = '0.5px';
      ctx.fillText('STEMFORGE', W - 10, H - 8);
      ctx.letterSpacing = '0';

      artEl.style.backgroundImage = `url('${canvas.toDataURL('image/png')}')`;
      artEl.style.backgroundSize = 'cover';
      artEl.style.backgroundPosition = 'center';
    } catch(e) { /* gradient fallback */ }
    }

    _sfLoadLogo(logoIdx, doDraw);
  }
  // Expose globally so the edit modal (outside this IIFE) can call it
  window.drawCanvasArt = drawCanvasArt;

  // ══════════════════════════════════════════════════════════════
  //  CARD AMBIENT WAVEFORM — idle sine animation on each art card
  // ══════════════════════════════════════════════════════════════
  // Each card gets a <canvas> injected into .project-card__art.
  // The canvas draws a gentle multi-layer sine waveform that drifts
  // continuously. It uses the card's data-hue for colouring.
  // When the card's audio is actively playing (dash-audio src matches)
  // the waveform is driven by the live AnalyserNode instead.

  (function initCardWaveforms() {
    // Map: artEl → { canvas, ctx, raf, hue, liveMode }
    var _cardWaves = new WeakMap();
    var _cardWaveGlobal = window._cardWaveGlobal = window._cardWaveGlobal || {
      analyser: null,   // set by mini player when audio starts
      hue: 180          // hue of currently-playing card
    };

    function startCardWave(artEl, hue) {
      // If already running, just update hue
      var existing = _cardWaves.get(artEl);
      if (existing) { existing.hue = hue; return; }

      // Build canvas — sits behind play button, above background img
      var cv = document.createElement('canvas');
      cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;opacity:0;transition:opacity .4s ease';
      artEl.appendChild(cv);

      // Fade in after one frame so transition fires
      requestAnimationFrame(function(){ cv.style.opacity = '1'; });

      var ctx = cv.getContext('2d');
      var state = { canvas: cv, ctx: ctx, hue: hue, raf: null, t: Math.random() * 1000, liveMode: false };
      _cardWaves.set(artEl, state);

      function resize() {
        cv.width  = artEl.offsetWidth  || 160;
        cv.height = artEl.offsetHeight || 160;
      }
      resize();

      function drawFrame() {
        resize();
        var W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);

        var g = _cardWaveGlobal;
        var isLive = g.analyser && g.hue === state.hue;

        if (isLive && g.analyser) {
          // ── LIVE mode: draw real waveform from AnalyserNode ──
          var bufLen = g.analyser.fftSize;
          var buf = new Uint8Array(bufLen);
          g.analyser.getByteTimeDomainData(buf);

          var h = state.hue;
          ctx.save();
          ctx.strokeStyle = 'hsla(' + h + ',80%,65%,0.9)';
          ctx.lineWidth = 2.5;
          ctx.shadowColor = 'hsla(' + h + ',80%,65%,0.7)';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          var sliceW = W / bufLen;
          var x = 0;
          for (var i = 0; i < bufLen; i++) {
            var v = buf[i] / 128.0;
            var y = (v * H) / 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            x += sliceW;
          }
          ctx.stroke();

          // Second glow pass
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.restore();

        } else {
          // ── IDLE mode: multi-layer drifting sine ──
          state.t += 0.012;
          var t = state.t;
          var h = state.hue;

          // Three overlapping sine layers at different speeds/amplitudes/phases
          var layers = [
            { amp: H * 0.18, freq: 2.1, speed: 1.0,  phase: 0,           alpha: 0.7, width: 2.0 },
            { amp: H * 0.10, freq: 3.4, speed: 1.6,  phase: Math.PI/3,   alpha: 0.4, width: 1.5 },
            { amp: H * 0.06, freq: 5.2, speed: 2.3,  phase: Math.PI*0.8, alpha: 0.25, width: 1.0 }
          ];

          layers.forEach(function(l) {
            ctx.save();
            ctx.beginPath();
            ctx.strokeStyle = 'hsla(' + h + ',75%,62%,' + l.alpha + ')';
            ctx.lineWidth = l.width;
            ctx.shadowColor = 'hsla(' + h + ',80%,65%,0.5)';
            ctx.shadowBlur = 8;
            var steps = 120;
            for (var i = 0; i <= steps; i++) {
              var x = (i / steps) * W;
              var y = H / 2 + Math.sin((i / steps) * Math.PI * 2 * l.freq + t * l.speed + l.phase) * l.amp;
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
          });
        }

        state.raf = requestAnimationFrame(drawFrame);
      }

      state.raf = requestAnimationFrame(drawFrame);
    }

    function stopCardWave(artEl) {
      var s = _cardWaves.get(artEl);
      if (!s) return;
      cancelAnimationFrame(s.raf);
      if (s.canvas && s.canvas.parentNode) {
        s.canvas.style.opacity = '0';
        setTimeout(function(){ if (s.canvas.parentNode) s.canvas.parentNode.removeChild(s.canvas); }, 400);
      }
      _cardWaves.delete(artEl);
    }

    // Attach hover listeners to any .project-card__art inside a card with data-hue
    function attachCardWaveListeners(gridEl) {
      var root = gridEl || document;
      root.querySelectorAll('.project-card[data-hue] .project-card__art').forEach(function(artEl) {
        if (artEl._waveListened) return;
        artEl._waveListened = true;
        var hue = parseInt(artEl.closest('.project-card').dataset.hue || '180', 10);

        artEl.addEventListener('mouseenter', function() { startCardWave(artEl, hue); });
        artEl.addEventListener('mouseleave', function() {
          // Keep wave going if this card is the one playing
          if (_cardWaveGlobal.hue !== hue || !_cardWaveGlobal.analyser) {
            stopCardWave(artEl);
          }
        });
      });
    }

    // Expose so populateGrid can call it after rendering
    window._attachCardWaveListeners = attachCardWaveListeners;

    // Run on existing cards (in case dashboard already loaded)
    attachCardWaveListeners(document);
  })();

  // ── Load AI cover images async for a grid element ───────────
  function loadCoverImages(gridEl) {
    // Canvas-only art — no external image fetches, no AI cover images
    // Use forEach index so each card's position drives logo selection
    const cards = Array.from(gridEl.querySelectorAll('.project-card[data-hue]'));
    cards.forEach((card, cardIdx) => {
      const hue   = parseInt(card.dataset.hue || '180', 10);
      const title = card.dataset.title || '';
      const genre = card.dataset.genre || 'music';
      const artEl = card.querySelector('.project-card__art');
      if (!artEl) return;
      drawCanvasArt(artEl, hue, title, genre, cardIdx);
    });
  }

  // ── Format a card title: strip underscores, highlight "Remix" in purple neon ──
  var _remixSpan = '<span style="color:#c084fc;font-weight:700;text-shadow:0 0 8px rgba(192,132,252,.6)">Remix</span>';
  function formatCardTitle(raw) {
    // Strip underscores → spaces
    var t = (raw || '').replace(/_/g, ' ').trim();
    // Legacy pattern: "AI Remix of X" or "Stemforge Remix of X" → rewrite to "X Remix"
    var legacyRe = /^(?:AI|Stemforge)\s+Remix\s+of\s+(.+)$/i;
    var lm = t.match(legacyRe);
    if (lm) { t = lm[1].trim() + ' Remix'; }
    // Highlight trailing " Remix" (case-insensitive) in purple neon
    var trailingRe = /^(.*?)\s*\b(Remix)\s*$/i;
    var m = t.match(trailingRe);
    if (m) {
      return m[1].trim() + ' ' + _remixSpan;
    }
    return t;
  }

  // ── Render a single beats/songs card ───────────────────────
  // ── Detect if a genre string is actually a user prompt (not a real genre) ──
  function _isPromptGenre(g) {
    if (!g || g.length <= 3) return false;
    // Prompt-like if: very long, contains spaces AND looks like a sentence/request
    var lc = g.toLowerCase();
    var promptKeywords = /make me|female|male|hook|verse|vocal|rap song|please|create|with|and a|include|want|need|style of/;
    if (promptKeywords.test(lc)) return true;
    // Long and contains multiple words (more than 4 words = likely a prompt)
    if (g.split(/\s+/).length > 4) return true;
    return false;
  }

  // ── Auto-fix prompt genres via API (fire-and-forget, updates card in place) ──
  function _autoFixGenre(jobId, cardEl, hue) {
    fetch('/api/job/fix-genre', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.genre) return;
      var genreEl = cardEl.querySelector('.sf-genre-label');
      if (genreEl) {
        genreEl.textContent = data.genre;
        genreEl.style.display = '';
      }
      // Also update the data-genre attribute
      cardEl.setAttribute('data-genre', data.genre);
    })
    .catch(function() {}); // silent fail
  }

  function renderBeatCard(p, i) {
    const hue  = p.thumbnail_seed != null ? p.thumbnail_seed : hueFromIndex(i, p.id);
    const thumbBg = 'linear-gradient(135deg, hsl(' + hue + ',70%,30%) 0%, hsl(' + ((hue+60)%360) + ',80%,20%) 100%)';
    const bpm  = p.blueprint ? p.blueprint.bpm + ' BPM' : '';
    var rawGenre = (p.blueprint && p.blueprint.genre) ? p.blueprint.genre : 'music';

    // If genre looks like a user prompt, show a placeholder and fix it async
    var isPromptGenre = _isPromptGenre(rawGenre);
    var genre = isPromptGenre ? 'detecting...' : rawGenre;

    // ── Card title priority: user song title > genre+key > fallback ──
    const _badTitle = /instrumental\s+only|no\s+vocals|include\s+instruments/i;
    const _userTitle  = (p.title && !_badTitle.test(p.title)) ? p.title : null;
    const _genreRaw   = p.blueprint ? p.blueprint.genre : null;
    const _genreClean = (_genreRaw && !_badTitle.test(_genreRaw) && !_isPromptGenre(_genreRaw)) ? _genreRaw : null;
    const _genreKey   = _genreClean
      ? (_genreClean + (p.blueprint && p.blueprint.key ? ' \u2014 '+p.blueprint.key : ''))
      : ((!isPromptGenre && genre !== 'music') ? genre : 'Beat');

    const displayTitle = _userTitle || _genreKey;
    const safeFilename = displayTitle.replace(/[^a-zA-Z0-9\s\-_]/g,'').replace(/\s+/g,'_').toLowerCase();
    const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';

    // ── Neon genre label: hue-colored glow text ──
    var showGenreLabel = genre && genre !== 'music';
    var genreLabelHtml = showGenreLabel
      ? '<p class="sf-genre-label" style="margin:0 0 4px;font-size:.75rem;font-weight:600;text-transform:capitalize;letter-spacing:.04em;color:hsl(' + hue + ',80%,68%);text-shadow:0 0 8px hsla(' + hue + ',80%,60%,.55),0 0 2px hsla(' + hue + ',60%,80%,.3)">' + genre + '</p>'
      : '<p class="sf-genre-label" style="display:none;margin:0 0 4px;font-size:.75rem;font-weight:600;text-transform:capitalize;letter-spacing:.04em;color:hsl(' + hue + ',80%,68%);text-shadow:0 0 8px hsla(' + hue + ',80%,60%,.55),0 0 2px hsla(' + hue + ',60%,80%,.3)"></p>';

    // ── data-prompt attribute for async genre fix ──
    var needsFix = isPromptGenre ? ' data-needs-genre-fix="1"' : '';

    return '<div class="project-card"' + needsFix +
           ' data-stereo="' + (p.stereo_url||'') + '"' +
           ' data-zip="' + (p.zip_url||'') + '"' +
           ' data-id="' + p.id + '"' +
           ' data-title="' + displayTitle.replace(/"/g,'&quot;') + '"' +
           ' data-hue="' + hue + '"' +
           ' data-genre="' + (rawGenre||'music').replace(/"/g,'&quot;') + '"' +
           '>' +
      '<div class="project-card__art" style="background:linear-gradient(135deg,hsl(' + hue + ',55%,12%),hsl(' + ((hue+60)%360) + ',65%,8%));position:relative;overflow:hidden">' +
        '<img src="' + (function(){var e=_sfLogoPool[_sfPickLogoIndex(i)];return e?e.src:'/static/stemforge-logo.png';}()) + '" alt="StemForge"' +
          ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.75;filter:' + (function(){var e=_sfLogoPool[_sfPickLogoIndex(i)];return(e&&e.hueRotate)?'hue-rotate('+hue+'deg) saturate(1.6) brightness(0.9)':'none';}()) + ';pointer-events:none;user-select:none"/>' +
        '<div class="project-card__play" onclick="playDashProject(this)">' +
          '<i class="fas fa-play"></i>' +
        '</div>' +
      '</div>' +
      '<div class="project-card__body">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">' +
          '<h4 style="margin:0;flex:1">' + formatCardTitle(displayTitle) + '</h4>' +
          '<button class="song-dots-btn" title="More options"' +
            ' onclick="event.stopPropagation();openCardMenu(this,\'' + p.id + '\',\'' + (p.stereo_url||'') + '\',\'' + (p.zip_url||'') + '\',\'' + safeFilename + '\',\'beats\')"' +
            ' style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>' +
        '</div>' +
        genreLabelHtml +
        '<p style="margin-bottom:4px">' + (bpm ? bpm + (dateStr ? ' \xb7 ' : '') : '') + dateStr + '</p>' +
        '<div class="project-card__tags">' +
          (bpm ? '<span class="export-badge" style="background:rgba(78,159,255,.12);color:var(--primary);border:1px solid rgba(78,159,255,.25);font-size:.72rem">' + bpm + '</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // ── Render a single one-shot card ───────────────────────────
  function renderOneshotCard(p, i) {
    const soundType = p.sound_type || 'One Shot';
    const label = soundType.charAt(0).toUpperCase() + soundType.slice(1);
    const safeFilename = soundType.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase();
    const audioUrl = p.audio_url || '';
    const hue  = hueFromIndex(i, p.id);
    const hue2 = (hue + 50) % 360;
    return `
      <div class="project-card project-card--oneshot"
           data-stereo="${audioUrl}"
           data-id="${p.id}"
           data-title="${label.replace(/"/g,'&quot;')}">
        <div class="project-card__art" style="background:linear-gradient(135deg,hsl(${hue},60%,16%),hsl(${hue2},70%,9%));position:relative;overflow:hidden">
          <img src="${(function(){var e=_sfLogoPool[_sfPickLogoIndex(i)];return e?e.src:'/static/stemforge-logo.png';}())}" alt="StemForge"
            style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.75;filter:${(function(){var e=_sfLogoPool[_sfPickLogoIndex(i)];return(e&&e.hueRotate)?'hue-rotate('+hue+'deg) saturate(1.6) brightness(0.9)':'none';}())};pointer-events:none;user-select:none"/>
          ${audioUrl ? `<div class="project-card__play" onclick="playDashProject(this)"><i class="fas fa-play"></i></div>` : '<div class="project-card__play" style="opacity:.3;pointer-events:none"><i class="fas fa-hourglass-half"></i></div>'}
        </div>
        <div class="project-card__body">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
            <h4 style="margin:0;flex:1">${label}</h4>
            <button class="song-dots-btn" title="More options"
              onclick="event.stopPropagation();openCardMenu(this,'${p.id}','${audioUrl}','','${safeFilename}','oneshots')"
              style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>
          </div>
          <p style="margin-bottom:4px">One Shot · ${new Date(p.created_at).toLocaleDateString()}</p>
        </div>
      </div>`;
  }

  // ── Render a single trash card ──────────────────────────────
  // Trash cards always use thumbnail_seed or hueFromId (ID-stable hash, not position)
  // so a track keeps the same colour it had before it was deleted.
  function renderTrashCard(p, i) {
    const hue  = p.thumbnail_seed != null ? p.thumbnail_seed : hueFromId(p.id);
    const bpm  = p.blueprint ? p.blueprint.bpm + ' BPM' : '';
    const genre= p.blueprint ? p.blueprint.genre : (p.sound_type || '');
    const label= p.prompt ? p.prompt.slice(0,32)+(p.prompt.length>32?'…':'') : (p.title||'Item');
    const rawTitle = p.title || (p.blueprint ? (p.blueprint.genre+(p.blueprint.key?' — '+p.blueprint.key:'')) : label);
    const days = p.days_until_purge != null ? p.days_until_purge : '?';
    const isOneshot = p.is_oneshot;
    const icon = isOneshot ? 'fa-bolt' : 'fa-wave-square';
    return `
      <div class="project-card project-card--trash"
           data-id="${p.id}"
           data-title="${rawTitle.replace(/"/g,'&quot;')}"
           data-hue="${hue}"
           data-genre="${(genre||'music').replace(/"/g,'&quot;')}"
           >
        <div class="project-card__art" style="background:linear-gradient(135deg,hsl(${hue},40%,14%),hsl(${hue},30%,8%))">
          <div class="project-card__art-icon" style="opacity:.5"><i class="fas ${icon}"></i></div>
        </div>
        <div class="project-card__body">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
            <h4 style="margin:0;flex:1;opacity:.75">${rawTitle}</h4>
            <span class="trash-days-badge">${days}d</span>
          </div>
          <p>${genre||bpm||label}</p>
          <div class="trash-actions">
            <button class="trash-btn trash-btn--restore"
              onclick="restoreLibItem('${p.id}')">
              <i class="fas fa-undo"></i> Restore
            </button>
            <button class="trash-btn trash-btn--purge"
              onclick="purgeLibItem('${p.id}', '${rawTitle.replace(/'/g,'\\u0027')}')">
              <i class="fas fa-trash"></i> Delete
            </button>
          </div>
        </div>
      </div>`;
  }

  // ── Populate a grid element with cards + "new beat" card ────
  function populateGrid(gridEl, tab, projects) {
    if (!gridEl) return;
    if (!projects || projects.length === 0) {
      const emptyMsgs = {
        beats:    '<i class="fas fa-music" style="font-size:40px;opacity:.3;margin-bottom:16px"></i><p>No beats yet. <a href="/generator">Generate your first beat!</a></p>',
        oneshots: '<i class="fas fa-bolt" style="font-size:40px;opacity:.3;margin-bottom:16px"></i><p>No one shots yet. Head to the <a href="/generator">Generator</a> to create some!</p>',
        trash:    '<i class="fas fa-trash-alt" style="font-size:40px;opacity:.3;margin-bottom:16px"></i><p>Trash is empty.</p>',
        remixes:  '<i class="fas fa-wand-magic-sparkles" style="font-size:40px;opacity:.3;margin-bottom:16px;color:#a855f7"></i><p>No remixes yet. Upload a track on the Create page to remix it!</p>',
      };
      gridEl.innerHTML = `<div class="project-grid-empty">${emptyMsgs[tab]||''}</div>`;
      return;
    }
    let html = '';
    // Filter out error-status jobs from beats/oneshots — they shouldn't appear in library
    const visibleProjects = (tab === 'beats' || tab === 'oneshots')
      ? projects.filter(p => p.status !== 'error' && p.status !== 'generating')
      : projects;
    visibleProjects.forEach((p, i) => {
      if (tab === 'beats')    html += renderBeatCard(p, i);
      else if (tab === 'oneshots') html += renderOneshotCard(p, i);
      else if (tab === 'trash')    html += renderTrashCard(p, i);
      else if (tab === 'remixes')  html += renderBeatCard(p, i); // remixes use same card layout as beats
    });
    if (tab === 'beats') {
      html += `<div class="project-card project-card--new"><a href="/generator" class="project-card__new-inner"><i class="fas fa-plus-circle"></i><span>New beat</span></a></div>`;
    }
    gridEl.innerHTML = html;
    if (tab === 'beats') loadCoverImages(gridEl);
    // Attach idle waveform hover listeners to newly rendered cards
    if (window._attachCardWaveListeners) window._attachCardWaveListeners(gridEl);
    // Auto-fix prompt genres: find cards with data-needs-genre-fix and call API
    gridEl.querySelectorAll('.project-card[data-needs-genre-fix]').forEach(function(cardEl) {
      var jobId = cardEl.getAttribute('data-id');
      var hue   = parseInt(cardEl.getAttribute('data-hue') || '200', 10);
      if (jobId) _autoFixGenre(jobId, cardEl, hue);
    });
  }

  // ── Update tab count badges ─────────────────────────────────
  function updateTabCount(tab, count) {
    const btn = document.querySelector(`.lib-tab[data-tab="${tab}"]`);
    if (!btn) return;
    let badge = btn.querySelector('.lib-tab-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'lib-tab-count';
      btn.appendChild(badge);
    }
    badge.textContent = count;
  }

  // ── Fetch one tab's data from API ───────────────────────────
  async function fetchLibTab(tab) {
    // Extended tab is fully handled by reloadExtendedTab — route there directly
    // so there is no dependency on override timing or _libLoaded cache.
    if (tab === 'extended') {
      if (window.reloadExtendedTab) window.reloadExtendedTab();
      return;
    }
    const gridEl = document.getElementById('project-grid-' + tab);
    if (!gridEl) return;
    if (_libLoaded[tab]) { populateGrid(gridEl, tab, _libData[tab]); return; }
    gridEl.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    try {
      const res = await fetch('/api/projects?tab=' + tab);
      if (!res.ok) {
        if (res.status === 401) {
          gridEl.innerHTML = `<div class="project-grid-loading" style="color:var(--muted)"><i class="fas fa-lock"></i> Sign in to see your projects. <a href="/login">Log in</a></div>`;
          return;
        }
        throw new Error('HTTP ' + res.status);
      }
      const { projects } = await res.json();
      _libData[tab] = projects || [];
      _libLoaded[tab] = true;
      updateTabCount(tab, _libData[tab].length);
      populateGrid(gridEl, tab, _libData[tab]);
    } catch(e) {
      gridEl.innerHTML = `<div class="project-grid-loading" style="color:var(--muted)">Could not load projects.</div>`;
    }
  }

  // ── Switch active tab ───────────────────────────────────────
  window.switchLibTab = function(tab) {
    _libActive = tab;
    // Update tab buttons
    document.querySelectorAll('.lib-tab').forEach(btn => {
      btn.classList.toggle('lib-tab--active', btn.dataset.tab === tab);
      if (tab === 'trash') btn.classList.toggle('lib-tab--trash', btn.dataset.tab === tab);
    });
    // Show/hide panels
    ['beats','extended','oneshots','uploads','trash','remixes'].forEach(t => {
      const panel = document.getElementById('lib-panel-' + t);
      if (panel) panel.style.display = t === tab ? '' : 'none';
    });
    // Update search placeholder
    const searchInput = document.getElementById('lib-search');
    if (searchInput) {
      const placeholders = { beats: 'Search beats…', extended: 'Search extended tracks…', oneshots: 'Search one shots…', uploads: 'Search uploads…', trash: 'Search trash…', remixes: 'Search remixes…' };
      searchInput.placeholder = placeholders[tab] || 'Search…';
      // Reset search when switching tabs
      searchInput.value = '';
      filterLibrary('');
    }
    // Load data — extended and uploads have their own dedicated loaders
    if (tab === 'uploads') {
      fetchUploadsTab();
    } else if (tab === 'remixes') {
      fetchLibTab('remixes');
    } else if (tab === 'extended') {
      // Always hard-reload extended tab — bypasses stale _libLoaded cache
      if (window.reloadExtendedTab) {
        window.reloadExtendedTab();
      } else {
        fetchLibTab(tab); // fallback in case IIFE hasn't run yet (calls reloadExtendedTab internally)
      }
    } else {
      fetchLibTab(tab);
    }
  };

  // ── Client-side search filter ────────────────────────────────
  window.filterLibrary = function(query) {
    const tab = _libActive;
    const clearBtn = document.getElementById('lib-search-clear');
    if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
    const q = query.toLowerCase().trim();
    const gridEl = document.getElementById('project-grid-' + tab);
    if (!gridEl) return;
    // Uploads tab uses its own renderer
    if (tab === 'uploads') {
      const filtered = !q ? _libData.uploads : _libData.uploads.filter(u => {
        const fn = (u.filename || '').toLowerCase();
        const g  = (u.analysis && u.analysis.genre ? u.analysis.genre : '').toLowerCase();
        const m  = (u.analysis && u.analysis.mood ? u.analysis.mood : '').toLowerCase();
        return fn.includes(q) || g.includes(q) || m.includes(q);
      });
      renderUploadsGrid(gridEl, filtered);
      return;
    }
    const filtered = !q ? _libData[tab] : _libData[tab].filter(p => {
      const t  = (p.title || '').toLowerCase();
      const pr = (p.prompt || '').toLowerCase();
      const g  = (p.blueprint ? p.blueprint.genre : (p.sound_type||'')).toLowerCase();
      return t.includes(q) || pr.includes(q) || g.includes(q);
    });
    populateGrid(gridEl, tab, filtered);
  };

  // ── Fetch uploads tab ──────────────────────────────────────
  async function fetchUploadsTab() {
    const gridEl = document.getElementById('project-grid-uploads');
    if (!gridEl) return;
    // Always refetch uploads — never cache, list changes after each upload/delete
    _libLoaded.uploads = false;
    gridEl.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    try {
      const res = await fetch('/api/reference-uploads');
      if (!res.ok) {
        if (res.status === 401) {
          gridEl.innerHTML = '<div class="project-grid-loading" style="color:var(--muted)"><i class="fas fa-lock"></i> Sign in to see your uploads. <a href="/login">Log in</a></div>';
          return;
        }
        // Try to get error body for better diagnostics
        let errBody = '';
        try { const j = await res.json(); errBody = j.error || ''; } catch {}
        throw new Error('HTTP ' + res.status + (errBody ? ': ' + errBody : ''));
      }
      const { uploads } = await res.json();
      _libData.uploads = uploads || [];
      _libLoaded.uploads = true;
      updateTabCount('uploads', _libData.uploads.length);
      renderUploadsGrid(gridEl, _libData.uploads);
    } catch(e) {
      console.error('[fetchUploadsTab] error:', e);
      gridEl.innerHTML = '<div class="project-grid-loading" style="color:var(--muted)"><i class="fas fa-exclamation-circle"></i> Could not load uploads' + (e && e.message ? ' (' + e.message + ')' : '') + '. <button onclick="window.fetchUploadsTab()" style="background:none;border:none;color:var(--primary);cursor:pointer;text-decoration:underline;font-size:inherit">Retry</button></div>';
    }
  }
  // Expose so override + retry button can call it
  window.fetchUploadsTab = fetchUploadsTab;

  // ── Render uploads grid ─────────────────────────────────────
  function renderUploadsGrid(gridEl, uploads) {
    if (!gridEl) return;
    if (!uploads || uploads.length === 0) {
      gridEl.innerHTML = '<div class="project-grid-empty"><i class="fas fa-cloud-upload-alt" style="font-size:40px;opacity:.3;margin-bottom:16px"></i><p>No uploads yet. Upload a reference track to get started.</p></div>';
      return;
    }
    let html = '';
    uploads.forEach((u) => {
      const analysis = u.analysis || {};
      const genre = analysis.genre || '';
      const bpm = analysis.bpm ? (analysis.bpm + ' BPM') : '';
      const dur = u.duration ? (Math.floor(u.duration/60) + ':' + String(Math.floor(u.duration%60)).padStart(2,'0')) : '';
      const instruments = analysis.instruments ? analysis.instruments.slice(0,4).join(', ') : '';
      const mood = analysis.mood || '';
      const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString() : '';
      const summary = analysis.summary || '';
      html += `
        <div class="upload-item" onclick="useExistingUpload('${u.file_id}','${(u.filename||'').replace(/'/g,'\\u0027')}',' ${ (summary||genre||'').replace(/'/g,'\\u0027').replace(/"/g,'&quot;').slice(0,120) }')">
          <div class="upload-item__icon"><i class="fas fa-music"></i></div>
          <div class="upload-item__body">
            <div class="upload-item__name">${u.filename || 'Reference track'}</div>
            <div class="upload-item__meta">${[genre, bpm, dur].filter(Boolean).join(' · ')}</div>
            ${instruments ? `<div class="upload-item__instruments"><i class="fas fa-guitar" style="color:var(--primary);margin-right:4px;font-size:.7rem"></i>${instruments}</div>` : ''}
            ${mood ? `<div class="upload-item__mood">${mood}</div>` : ''}
            ${summary ? `<div class="upload-item__summary">${summary}</div>` : ''}
            <div class="upload-item__date">${dateStr}</div>
          </div>
          <button class="upload-item__use-btn" onclick="event.stopPropagation();useExistingUpload('${u.file_id}','${(u.filename||'').replace(/'/g,'\\u0027')}','${(summary||genre||'').replace(/'/g,'\\u0027').replace(/"/g,'&quot;').slice(0,120)}')" title="Use as reference">
            <i class="fas fa-arrow-right"></i>
          </button>
        </div>`;
    });
    gridEl.innerHTML = html;
  }

  // ── Use an existing upload as reference ─────────────────────
  window.useExistingUpload = function(fileId, filename, description) {
    // Navigate to generator and set the ref file
    window._refFileId = fileId;
    window.refFileId = fileId;
    // If on dashboard, switch to generator
    const genPage = document.getElementById('ref-upload-done');
    if (genPage) {
      const nameEl = document.getElementById('ref-upload-name');
      if (nameEl) nameEl.textContent = filename;
      const doneEl = document.getElementById('ref-upload-done');
      const idleEl = document.getElementById('ref-upload-idle');
      const loadEl = document.getElementById('ref-upload-loading');
      if (idleEl) idleEl.style.display = 'none';
      if (loadEl) loadEl.style.display = 'none';
      if (doneEl) doneEl.style.display = 'flex';
      const zone = document.getElementById('ref-upload-zone');
      if (zone) { zone.classList.add('has-file'); }
      const modePanel = document.getElementById('ref-mode-panel');
      if (modePanel) modePanel.style.display = 'block';
      const clearBtn = document.getElementById('ref-clear-btn');
      if (clearBtn) clearBtn.style.display = 'block';
      updateRefTabBadge && updateRefTabBadge();
    } else {
      // Redirect to generator with file_id param
      window.location.href = '/generator?ref_file_id=' + encodeURIComponent(fileId) + '&ref_filename=' + encodeURIComponent(filename);
    }
  };

  // ── Soft-delete a card ──────────────────────────────────────
  window.deleteLibItem = async function(jobId) {
    if (!confirm('Move this item to Trash?')) return;
    try {
      const r = await fetch('/api/job/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      if (!r.ok) {
        let errMsg = 'HTTP ' + r.status;
        try { const j = await r.json(); errMsg = j.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      // Refresh beats/extended/oneshots and trash tabs
      _libLoaded.beats = false; _libLoaded.oneshots = false; _libLoaded.trash = false; _libLoaded.extended = false;
      fetchLibTab(_libActive);
      if (_libActive !== 'trash') fetchLibTab('trash'); // pre-load trash count
    } catch(e) { alert('Could not delete item: ' + e.message); }
  };

  // ── Restore a trashed card ──────────────────────────────────
  window.restoreLibItem = async function(jobId) {
    try {
      const r = await fetch('/api/job/restore', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      if (!r.ok) {
        let errMsg = 'HTTP ' + r.status;
        try { const j = await r.json(); errMsg = j.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      _libLoaded.beats = false; _libLoaded.oneshots = false; _libLoaded.trash = false;
      fetchLibTab('trash');
    } catch(e) { alert('Could not restore item: ' + e.message); }
  };

  // ── Permanently delete a trashed card ──────────────────────
  window.purgeLibItem = async function(jobId, title) {
    if (!confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    try {
      const r = await fetch('/api/job/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      if (!r.ok) throw new Error('Purge failed');
      _libLoaded.trash = false;
      fetchLibTab('trash');
    } catch(e) { alert('Could not delete item permanently. Please try again.'); }
  };

  // ── Bootstrap: init library if dashboard tab elements exist ─
  const libTabsEl = document.getElementById('lib-tabs');
  if (libTabsEl) {
    // Inject upgrade modal
    if (!document.getElementById('sf-dash-upgrade')) {
      const m = document.createElement('div');
      m.id = 'sf-dash-upgrade';
      m.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(6px)';
      m.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:36px 32px;max-width:420px;width:90%;text-align:center;position:relative">
          <button onclick="document.getElementById('sf-dash-upgrade').style.display='none'" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#4e9fff,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.4rem;color:#fff"><i class="fas fa-lock-open"></i></div>
          <h3 style="font-size:1.25rem;font-weight:700;margin-bottom:8px">Upgrade to access</h3>
          <p style="color:var(--muted);font-size:.9rem;margin-bottom:24px;line-height:1.5">Free accounts can listen, but downloads require a <strong>Creator</strong> or <strong>Pro Artist</strong> plan.</p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <a href="/pricing?plan=creator" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-crown"></i> Creator — $10/mo · 800 pts</a>
            <a href="/pricing?plan=pro" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-star"></i> Pro Artist — $26/mo · 2,000 pts</a>
          </div>
          <p style="color:var(--muted);font-size:.78rem;margin-top:16px">Your beats are saved — upgrade anytime to download them.</p>
        </div>`;
      document.body.appendChild(m);
    }
    // Load initial tab (beats)
    fetchLibTab('beats');
  }

  // ── Remix a full stereo track from the card menu ─────────────────
  window.openRemixCard = async function(jobId, stereoUrl, safeTitle) {
    if (!stereoUrl) { alert('No audio available for this track yet.'); return; }

    // ── 1. Inject a "Remixing…" placeholder card at the top of the beats grid ──
    var gridEl = document.getElementById('project-grid-beats');
    var placeholderId = 'remix-placeholder-' + Date.now();
    var placeholder = document.createElement('div');
    placeholder.id = placeholderId;
    placeholder.className = 'project-card';
    placeholder.style.cssText = 'position:relative;overflow:hidden;opacity:.9;border:1px solid rgba(168,85,247,.35);background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05))';
    placeholder.innerHTML =
      '<div style="padding:16px;display:flex;flex-direction:column;gap:10px;min-height:120px;justify-content:center;align-items:center;text-align:center">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<i class="fas fa-wand-magic-sparkles" style="color:#a855f7;font-size:1.1rem;animation:sf-pulse 1.5s ease-in-out infinite"></i>' +
          '<span style="font-weight:700;font-size:.9rem;color:#c084fc">Remixing…</span>' +
        '</div>' +
        '<p style="margin:0;font-size:.75rem;color:rgba(255,255,255,.45);line-height:1.4">Stemforge is generating a new beat<br>inspired by <b style="color:rgba(255,255,255,.65)">' + (safeTitle || 'your track') + '</b></p>' +
        '<div style="width:100%;height:3px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden;margin-top:4px">' +
          '<div id="' + placeholderId + '-bar" style="height:100%;width:10%;background:linear-gradient(90deg,#a855f7,#ec4899);border-radius:3px;transition:width 2s ease;animation:sf-progress-bar 90s linear forwards"></div>' +
        '</div>' +
      '</div>';
    // Add pulse animation if not already in page
    if (!document.getElementById('sf-remix-styles')) {
      var styleEl = document.createElement('style');
      styleEl.id = 'sf-remix-styles';
      styleEl.textContent = '@keyframes sf-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.2)}}' +
        '@keyframes sf-progress-bar{0%{width:10%}50%{width:75%}90%{width:90%}100%{width:92%}}';
      document.head.appendChild(styleEl);
    }
    // Navigate to beats tab and prepend card
    var beatsTab = document.querySelector('.lib-tab[data-tab="beats"]');
    if (beatsTab && !beatsTab.classList.contains('active')) beatsTab.click();
    if (gridEl) gridEl.insertBefore(placeholder, gridEl.firstChild);

    // ── 2. POST to backend ──
    try {
      var res = await fetch('/api/job/remix', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, stereo_url: stereoUrl, title: safeTitle })
      });
      var data = await res.json();
      if (!res.ok) {
        placeholder.remove();
        var errDiv = document.createElement('div');
        errDiv.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;' +
          'background:#1a0a0a;border:1px solid rgba(239,68,68,.5);color:#f87171;' +
          'border-radius:10px;padding:12px 18px;font-size:.82rem;font-weight:600;' +
          'box-shadow:0 8px 32px rgba(0,0,0,.55);display:flex;align-items:center;gap:10px';
        errDiv.innerHTML = '<i class="fas fa-exclamation-circle"></i><span>' +
          (data.error || 'Remix failed') + '</span>' +
          '<button onclick="this.parentNode.remove()" style="margin-left:8px;background:none;border:none;' +
          'color:rgba(255,255,255,.4);cursor:pointer;font-size:.9rem;padding:0">\u2715</button>';
        document.body.appendChild(errDiv);
        setTimeout(function() { if (errDiv.parentNode) errDiv.remove(); }, 8000);
        return;
      }
      var newJobId = data.job_id;
      if (!newJobId) { placeholder.remove(); return; }

      // ── 3. Poll until ready, then replace placeholder with real card ──
      var pollCount = 0;
      var pollInterval = setInterval(async function() {
        if (++pollCount > 84) { // 7 min max
          clearInterval(pollInterval);
          placeholder.remove();
          return;
        }
        try {
          var pr = await fetch('/api/poll/' + newJobId, { method: 'POST' });
          if (!pr.ok) return;
          var pd = await pr.json();
          if (pd.status === 'ready' || pd.status === 'error') {
            clearInterval(pollInterval);
            placeholder.remove();
            // Refresh library so the real card appears
            if (window._libLoaded) window._libLoaded.beats = false;
            if (typeof fetchLibTab === 'function') fetchLibTab('beats');
            if (pd.status === 'ready') {
              // Green toast
              var done = document.createElement('div');
              done.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;' +
                'background:linear-gradient(135deg,#10b981,#059669);color:#fff;' +
                'border-radius:10px;padding:12px 18px;font-size:.82rem;font-weight:600;' +
                'box-shadow:0 8px 32px rgba(16,185,129,.35);display:flex;align-items:center;gap:10px';
              done.innerHTML = '<i class="fas fa-check-circle"></i><span>Remix ready!</span>' +
                '<button onclick="this.parentNode.remove()" style="margin-left:8px;background:none;border:none;' +
                'color:rgba(255,255,255,.6);cursor:pointer;font-size:.9rem;padding:0">\u2715</button>';
              document.body.appendChild(done);
              setTimeout(function() { if (done.parentNode) done.remove(); }, 6000);
            }
          }
        } catch(e) { /* transient */ }
      }, 5000);
    } catch(err) {
      placeholder.remove();
      console.error('[remix]', err);
    }
  };

  // ── Dashboard: card 3-dots context menu ─────────────────────────
  window.openCardMenu = function(btn, jobId, stereoUrl, zipUrl, safeTitle, cardTab) {
    const existing = document.getElementById('card-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'card-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.55);min-width:200px;overflow:hidden;padding:4px 0';

    const isOneshot = cardTab === 'oneshots';
    const _plan = (window._sfUser && window._sfUser.plan) || 'free';
    const isFree = _plan === 'free';

    const items = [];

    // Edit only for full beats
    if (!isOneshot) {
      items.push({ icon: 'fa-pencil-alt', label: 'Edit track info', action: () => openSongEditModal(null, jobId) });
      items.push({ icon: 'fa-expand-arrows-alt', label: 'Extend Song', action: () => {
        window.location.href = '/generator?extend=' + encodeURIComponent(jobId);
      }});
    }

    if (stereoUrl) {
      if (isFree) {
        // Show locked download item for free users — clicking opens upgrade prompt
        items.push({ icon: 'fa-lock', label: isOneshot ? 'Download (upgrade to unlock)' : 'Download Track (upgrade to unlock)',
          action: () => {
            const upgradeModal = document.getElementById('sf-dash-upgrade');
            if (upgradeModal) upgradeModal.style.display = 'flex';
            else window.location.href = '/pricing';
          }
        });
      } else {
        items.push({ icon: 'fa-download', label: isOneshot ? 'Download' : 'Download Full Track',
          action: () => openDownloadModal(jobId, stereoUrl, safeTitle) });
      }
    }

    // Get Stems — Creator and Pro only
    if (!isOneshot && stereoUrl) {
      if (isFree) {
        items.push({ icon: 'fa-lock', label: 'Get Stems (Pro Artist only)', action: () => {
          const upgradeModal = document.getElementById('sf-dash-upgrade');
          if (upgradeModal) upgradeModal.style.display = 'flex';
          else window.location.href = '/pricing';
        }});
      } else {
        items.push({ icon: 'fa-layer-group', label: 'Get Stems', action: () => {
          if (typeof window.openStemsPanel === 'function') {
            window.openStemsPanel(jobId, stereoUrl, safeTitle, _plan);
          }
        }});
      }
    }

    // Remix — for full beats (not oneshots), paid plans only, requires stereoUrl
    if (!isOneshot && !isFree && stereoUrl) {
      items.push({ icon: 'fa-wand-magic-sparkles', label: 'Remix', tooltip: 'Remix your beat inspired by this track', action: () => {
        window.openRemixCard(jobId, stereoUrl, safeTitle);
      }});
    }

    // Delete — goes to trash
    items.push({ icon: 'fa-trash-alt', label: 'Move to Trash', danger: true,
      action: () => deleteLibItem(jobId) });

    items.forEach(item => {
      const el = document.createElement('button');
      el.style.cssText = `display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;background:none;border:none;color:${item.danger?'var(--danger)':'var(--text)'};cursor:pointer;font-size:.875rem;font-weight:500;text-align:left;transition:background .12s;position:relative`;
      el.innerHTML = `<i class="fas ${item.icon}" style="width:15px;opacity:.7;flex-shrink:0"></i><span style="flex:1">${item.label}</span>` +
        (item.tooltip ? `<i class="fas fa-circle-info" style="font-size:.7rem;opacity:.35;flex-shrink:0" title="${item.tooltip}"></i>` : '');
      if (item.tooltip) el.title = item.tooltip;
      el.onmouseover = () => el.style.background = 'rgba(255,255,255,.06)';
      el.onmouseout  = () => el.style.background = 'none';
      el.onclick = (e) => { e.stopPropagation(); menu.remove(); item.action(); };
      menu.appendChild(el);
    });

    const rect = btn.getBoundingClientRect();
    document.body.appendChild(menu);
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    let top  = rect.bottom + 6;
    let left = rect.right  - mw;
    if (left < 8) left = 8;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
    menu.style.top  = top  + 'px';
    menu.style.left = left + 'px';

    setTimeout(() => {
      document.addEventListener('click', function closeMenu(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu); }
      });
    }, 0);
  };

  // ── Dashboard: Download Full Track modal (WAV / MP3) ────────────
  window.openDownloadModal = function(jobId, stereoUrl, safeTitle) {
    if (!stereoUrl) {
      alert('No audio available for this track yet. Forge the beat first.');
      return;
    }
    // Gate for free users
    if (window._sfUser && window._sfUser.plan === 'free') {
      const upgradeModal = document.getElementById('sf-dash-upgrade');
      if (upgradeModal) upgradeModal.style.display = 'flex';
      return;
    }

    const old = document.getElementById('sf-download-modal');
    if (old) old.remove();

    const title = safeTitle || 'stemforge_beat';
    const modal = document.createElement('div');
    modal.id = 'sf-download-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(6px)';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:32px 28px;max-width:360px;width:90%;text-align:center;position:relative">
        <button onclick="document.getElementById('sf-download-modal').remove()" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>
        <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:1.2rem;color:#fff"><i class="fas fa-download"></i></div>
        <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:6px">Download Full Track</h3>
        <p style="color:var(--muted);font-size:.85rem;margin-bottom:22px">Choose your format:</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <a href="/api/download-mp3/${jobId}" download="${title}.mp3"
             onclick="document.getElementById('sf-download-modal').remove()"
             style="display:flex;align-items:center;justify-content:center;gap:10px;padding:13px 20px;background:linear-gradient(135deg,var(--primary),#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
            <i class="fas fa-file-audio"></i> Download MP3
          </a>
          <button onclick="document.getElementById('sf-download-modal').remove();doWavDownload('${jobId}','${title}')"
             style="display:flex;align-items:center;justify-content:center;gap:10px;padding:13px 20px;background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border);border-radius:12px;font-weight:700;cursor:pointer;font-size:.95rem;width:100%">
            <i class="fas fa-file-waveform"></i> Download WAV
          </button>
        </div>
        <p style="color:var(--muted);font-size:.75rem;margin-top:14px;opacity:.7">WAV = lossless quality · MP3 = smaller file size</p>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  };

  // ── Dashboard: play project audio ───────────────────────────────
  // ══════════════════════════════════════════════════════════════
  //  MINI PLAYER — taller layout with live waveform visualizer
  // ══════════════════════════════════════════════════════════════

  // Shared AudioContext + AnalyserNode (reused across plays)
  var _dashAudioCtx  = null;
  var _dashAnalyser  = null;
  var _dashSourceNode= null;
  var _dashWaveRAF   = null;

  function _teardownDashAudio() {
    if (_dashWaveRAF) { cancelAnimationFrame(_dashWaveRAF); _dashWaveRAF = null; }
    if (_dashSourceNode) { try { _dashSourceNode.disconnect(); } catch(e){} _dashSourceNode = null; }
    // Don't close AudioContext — reuse it
    if (window._cardWaveGlobal) { window._cardWaveGlobal.analyser = null; }
  }

  function _setupDashVisualizer(audio, hue, canvasEl) {
    _teardownDashAudio();
    try {
      if (!_dashAudioCtx) _dashAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_dashAudioCtx.state === 'suspended') _dashAudioCtx.resume();

      _dashAnalyser = _dashAudioCtx.createAnalyser();
      _dashAnalyser.fftSize = 1024;
      _dashAnalyser.smoothingTimeConstant = 0.82;

      _dashSourceNode = _dashAudioCtx.createMediaElementSource(audio);
      _dashSourceNode.connect(_dashAnalyser);
      _dashAnalyser.connect(_dashAudioCtx.destination);

      // Feed into card wave system
      if (window._cardWaveGlobal) {
        window._cardWaveGlobal.analyser = _dashAnalyser;
        window._cardWaveGlobal.hue      = hue;
      }
    } catch(e) {
      // AudioContext blocked or already connected — visualizer degrades gracefully
      console.warn('Dash visualizer:', e.message);
    }

    var ctx  = canvasEl.getContext('2d');
    var bufLen = _dashAnalyser ? _dashAnalyser.fftSize : 1024;
    var buf  = new Uint8Array(bufLen);

    // Idle sine state (fallback / initial frames before audio loads)
    var _idleT = 0;

    function drawWave() {
      _dashWaveRAF = requestAnimationFrame(drawWave);
      var W = canvasEl.width = canvasEl.offsetWidth || 460;
      var H = canvasEl.height= canvasEl.offsetHeight || 60;
      ctx.clearRect(0, 0, W, H);

      var hasLive = _dashAnalyser && !audio.paused;

      if (hasLive) {
        _dashAnalyser.getByteTimeDomainData(buf);

        // ── Main waveform line ──
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = 'hsla(' + hue + ',75%,65%,0.95)';
        ctx.lineWidth   = 2.5;
        ctx.lineJoin    = 'round';
        ctx.shadowColor = 'hsla(' + hue + ',80%,65%,0.6)';
        ctx.shadowBlur  = 14;
        var sliceW = W / bufLen;
        var x = 0;
        for (var i = 0; i < bufLen; i++) {
          var v = buf[i] / 128.0;
          var y = (v * H) / 2;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          x += sliceW;
        }
        ctx.stroke();

        // ── Soft glow duplicate ──
        ctx.globalAlpha = 0.28;
        ctx.lineWidth   = 7;
        ctx.shadowBlur  = 22;
        ctx.stroke();
        ctx.restore();

      } else {
        // ── Idle ambient when paused / loading ──
        _idleT += 0.018;
        var layers = [
          { amp: H * 0.22, freq: 2.0, speed: 1.0,  phase: 0,           alpha: 0.6,  width: 2.2 },
          { amp: H * 0.12, freq: 3.5, speed: 1.7,  phase: Math.PI/3,   alpha: 0.35, width: 1.4 },
          { amp: H * 0.07, freq: 5.5, speed: 2.5,  phase: Math.PI*0.7, alpha: 0.2,  width: 1.0 }
        ];
        layers.forEach(function(l) {
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = 'hsla(' + hue + ',70%,62%,' + l.alpha + ')';
          ctx.lineWidth   = l.width;
          ctx.lineJoin    = 'round';
          ctx.shadowColor = 'hsla(' + hue + ',75%,65%,0.4)';
          ctx.shadowBlur  = 8;
          var steps = 160;
          for (var i = 0; i <= steps; i++) {
            var x = (i / steps) * W;
            var y = H/2 + Math.sin((i/steps)*Math.PI*2*l.freq + _idleT*l.speed + l.phase) * l.amp;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.restore();
        });
      }
    }
    drawWave();
  }

  window.playDashProject = function(btn) {
    const card       = btn.closest('.project-card');
    const stereoUrl  = card ? card.dataset.stereo : '';
    const jobId      = card ? card.dataset.id : '';
    const hue        = parseInt((card && card.dataset.hue) || '200', 10);
    const trackTitle = (card && (card.dataset.title || (card.querySelector('h4') && card.querySelector('h4').textContent))) || 'Beat';

    // Use proxied audio URL — routes through our server to avoid CORS/expired CDN URL issues
    const playUrl = jobId ? '/api/track-audio/' + jobId : stereoUrl;

    console.log('[SF play] jobId:', jobId, '| playUrl:', playUrl, '| stereoUrl:', stereoUrl);

    if (!stereoUrl && !jobId) {
      // Audio not ready yet — show a brief visual pulse on the art
      const artEl = btn.closest('.project-card__art');
      if (artEl) { artEl.style.opacity = '0.4'; setTimeout(() => artEl.style.opacity = '', 700); }
      (function() {
        var t = document.createElement('div');
        t.textContent = 'Audio not ready yet — try refreshing';
        t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e1e3a;color:#94a3b8;font-size:.8rem;padding:8px 18px;border-radius:20px;z-index:99999;pointer-events:none;border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 20px rgba(0,0,0,.5)';
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
      })();
      return;
    }

    // Tear down previous player
    const existing = document.getElementById('dash-mini-player');
    if (existing) { _teardownDashAudio(); existing.remove(); }

    // ── Build the taller mini player ──
    const player = document.createElement('div');
    player.id = 'dash-mini-player';
    player.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(14,14,28,0.92)',
      'border:1px solid hsla(' + hue + ',50%,40%,0.4)',
      'border-radius:20px',
      'padding:0',
      'z-index:9999',
      'box-shadow:0 12px 48px rgba(0,0,0,.7), 0 0 0 1px hsla(' + hue + ',60%,50%,0.1)',
      'min-width:360px',
      'max-width:600px',
      'width:min(94vw,560px)',
      'backdrop-filter:blur(16px)',
      'overflow:hidden',
      'display:flex',
      'flex-direction:column'
    ].join(';');

    player.innerHTML = `
      <audio id="dash-audio" src="${playUrl}" preload="auto" crossorigin="anonymous"></audio>

      <!-- Waveform canvas — full width, sits at top of player -->
      <div style="position:relative;width:100%;height:68px;background:linear-gradient(180deg,hsla(${hue},40%,8%,0.9) 0%,hsla(${hue},30%,5%,0.6) 100%)">
        <canvas id="dash-wave-cv" style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
        <!-- Subtle hue glow edge at top -->
        <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,hsla(${hue},70%,60%,0.6),transparent)"></div>
      </div>

      <!-- Controls row -->
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px 14px">
        <!-- Play/Pause -->
        <button id="dash-play-pause"
          style="width:44px;height:44px;border-radius:50%;background:hsl(${hue},65%,45%);border:none;cursor:pointer;color:#fff;font-size:17px;flex-shrink:0;display:flex;align-items:center;justify-content:center;box-shadow:0 0 16px hsla(${hue},70%,50%,0.4);transition:transform .1s"
          onmousedown="this.style.transform='scale(.92)'" onmouseup="this.style.transform=''" onmouseleave="this.style.transform=''"
          onclick="dashTogglePlay()">
          <i class="fas fa-pause"></i>
        </button>

        <!-- Repeat -->
        <button id="dash-repeat-btn" title="Repeat" onclick="dashToggleRepeat()"
          style="width:32px;height:32px;border-radius:50%;background:none;border:1px solid rgba(255,255,255,.12);cursor:pointer;color:rgba(255,255,255,.4);font-size:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s">
          <i class="fas fa-redo"></i>
        </button>

        <!-- Title + seek row -->
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;letter-spacing:.3px">
            ${card.querySelector('h4')?.textContent || trackTitle}
          </div>
          <div style="display:flex;align-items:center;gap:7px">
            <span id="dash-time-cur" style="font-size:.68rem;color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:30px">0:00</span>
            <div style="flex:1;position:relative;height:4px;border-radius:2px;background:rgba(255,255,255,.1);cursor:pointer" id="dash-seek-track">
              <div id="dash-seek-fill" style="position:absolute;left:0;top:0;height:100%;border-radius:2px;width:0%;background:linear-gradient(90deg,hsl(${hue},65%,50%),hsl(${(hue+40)%360},75%,65%));transition:width .25s linear"></div>
              <input type="range" id="dash-seek" min="0" max="100" value="0" step="0.1"
                style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;margin:0"/>
            </div>
            <span id="dash-time-dur" style="font-size:.68rem;color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:30px;text-align:right"></span>
          </div>
        </div>

        <!-- Close -->
        <button onclick="(function(){var p=document.getElementById('dash-mini-player');if(p){window._teardownDashAudio&&window._teardownDashAudio();p.remove();}})()"
          style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,.35);font-size:17px;flex-shrink:0;line-height:1;padding:4px;transition:color .15s"
          onmouseenter="this.style.color='rgba(255,255,255,.8)'" onmouseleave="this.style.color='rgba(255,255,255,.35)'">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `;

    document.body.appendChild(player);

    const audio   = document.getElementById('dash-audio');
    const seekBar  = document.getElementById('dash-seek');
    const seekFill = document.getElementById('dash-seek-fill');
    const timeCur  = document.getElementById('dash-time-cur');
    const timeDur  = document.getElementById('dash-time-dur');
    const waveCV   = document.getElementById('dash-wave-cv');

    // Expose teardown globally so close button can call it
    window._teardownDashAudio = _teardownDashAudio;

    function fmtSecs(s) {
      if (!isFinite(s)) return '0:00';
      const m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return m + ':' + String(sec).padStart(2, '0');
    }

    // Start waveform (idle mode first, live after AudioContext connects)
    _setupDashVisualizer(audio, hue, waveCV);

    // Handle audio load error (e.g. expired CDN URL)
    audio.addEventListener('error', function() {
      var code = audio.error ? audio.error.code : 0;
      console.warn('[SF audio] error code:', code, '| src:', audio.src);
      var pp = document.getElementById('dash-play-pause');
      if (pp) { pp.innerHTML = '<i class="fas fa-exclamation-triangle"></i>'; pp.style.background = 'rgba(239,68,68,.7)'; }
      var t = document.createElement('div');
      t.textContent = 'Audio unavailable — this track may need to be regenerated';
      t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e1e3a;color:#f87171;font-size:.8rem;padding:8px 18px;border-radius:20px;z-index:99999;pointer-events:none;border:1px solid rgba(239,68,68,.3);box-shadow:0 4px 20px rgba(0,0,0,.5)';
      document.body.appendChild(t);
      setTimeout(function() { t.remove(); }, 3500);
    });

    audio.play().catch(function(e) { console.warn('[SF audio] play() rejected:', e && e.message); });

    audio.addEventListener('loadedmetadata', () => {
      if (timeDur) timeDur.textContent = fmtSecs(audio.duration);
    });
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      seekBar.value = pct;
      if (seekFill) seekFill.style.width = pct + '%';
      if (timeCur) timeCur.textContent = fmtSecs(audio.currentTime);
      if (timeDur) timeDur.textContent = fmtSecs(audio.duration);
    });
    seekBar.addEventListener('input', () => {
      if (audio.duration) {
        audio.currentTime = (seekBar.value / 100) * audio.duration;
        if (seekFill) seekFill.style.width = seekBar.value + '%';
      }
    });
    audio.addEventListener('ended', () => {
      const btn = document.getElementById('dash-repeat-btn');
      if (btn && btn.dataset.repeat === '1') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      } else {
        const ppBtn = document.getElementById('dash-play-pause');
        if (ppBtn) ppBtn.innerHTML = '<i class="fas fa-play"></i>';
        seekBar.value = 0;
        if (seekFill) seekFill.style.width = '0%';
        if (timeCur) timeCur.textContent = '0:00';
      }
    });
  };

  window.dashTogglePlay = function() {
    const audio = document.getElementById('dash-audio');
    const btn   = document.getElementById('dash-play-pause');
    if (!audio) return;
    if (audio.paused) {
      if (_dashAudioCtx && _dashAudioCtx.state === 'suspended') _dashAudioCtx.resume();
      audio.play().catch(() => {});
      if (btn) btn.innerHTML = '<i class="fas fa-pause"></i>';
    } else {
      audio.pause();
      if (btn) btn.innerHTML = '<i class="fas fa-play"></i>';
    }
  };

  window.dashToggleRepeat = function() {
    const audio = document.getElementById('dash-audio');
    const btn   = document.getElementById('dash-repeat-btn');
    if (!btn || !audio) return;
    const isRepeat = btn.dataset.repeat === '1';
    btn.dataset.repeat = isRepeat ? '0' : '1';
    audio.loop = !isRepeat;
    if (!isRepeat) {
      btn.style.color       = 'hsl(var(--hue,200),65%,60%)';
      btn.style.borderColor = 'hsl(var(--hue,200),50%,45%)';
      btn.style.background  = 'hsla(var(--hue,200),60%,50%,0.12)';
    } else {
      btn.style.color       = 'rgba(255,255,255,.4)';
      btn.style.borderColor = 'rgba(255,255,255,.12)';
      btn.style.background  = 'none';
    }
  };

  // ── Scroll fade-in ─────────────────────────────────────────────
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.style.opacity='1'; e.target.style.transform='translateY(0)'; }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.feature-card,.plan-card,.testi-card,.how__step').forEach(el => {
    el.style.cssText += ';opacity:0;transform:translateY(20px);transition:opacity .5s ease,transform .5s ease;';
    observer.observe(el);
  });

  // ═══════════════════════════════════════════════════════════════
  //  SUNO-STYLE GENERATOR CONTROLS
  // ═══════════════════════════════════════════════════════════════

  // ── Tab switching (Write / Prompt / Instrumental) ─────────────
  let activeTab = 'write'; // track active tab
  document.querySelectorAll('.suno-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      activeTab = target;
      document.querySelectorAll('.suno-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.suno-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById('tab-' + target);
      if (panel) panel.classList.add('active');

      // Auto-toggle instrumental switch when Instrumental tab is clicked
      const instrCheckbox = document.getElementById('gen-instrumental');
      const instrNote = document.getElementById('instrumental-note');
      if (target === 'instrumental') {
        if (instrCheckbox && !instrCheckbox.checked) {
          instrCheckbox.checked = true;
          if (instrNote) instrNote.style.display = 'block';
        }
      } else {
        // Switching away from instrumental tab — turn the toggle off
        if (instrCheckbox && instrCheckbox.checked) {
          instrCheckbox.checked = false;
          if (instrNote) instrNote.style.display = 'none';
        }
      }
    });
  });

  // ── Instrumental toggle note ──────────────────────────────────
  const instrCheckbox = document.getElementById('gen-instrumental');
  const instrNote = document.getElementById('instrumental-note');
  if (instrCheckbox && instrNote) {
    instrCheckbox.addEventListener('change', () => {
      instrNote.style.display = instrCheckbox.checked ? 'block' : 'none';
    });
  }

  // ── Style chips ───────────────────────────────────────────────
  const styleInput = document.getElementById('gen-style');
  document.querySelectorAll('.suno-chip[data-style]').forEach(chip => {
    chip.addEventListener('click', () => {
      if (!styleInput) return;
      const style = chip.dataset.style;
      const current = styleInput.value.trim();
      const styles = current ? current.split(',').map(s => s.trim()).filter(Boolean) : [];
      const idx = styles.findIndex(s => s.toLowerCase() === style.toLowerCase());
      if (idx > -1) {
        styles.splice(idx, 1);
        chip.classList.remove('active');
      } else {
        styles.push(style);
        chip.classList.add('active');
      }
      styleInput.value = styles.join(', ');
    });
  });

  // ── Chips scroll arrows ───────────────────────────────────────
  const chipsScroll = document.getElementById('style-chips-scroll');
  const arrowLeft   = document.getElementById('chips-arrow-left');
  const arrowRight  = document.getElementById('chips-arrow-right');
  if (chipsScroll && arrowLeft && arrowRight) {
    const SCROLL_STEP = 140;
    const updateArrows = () => {
      const atStart = chipsScroll.scrollLeft <= 2;
      const atEnd   = chipsScroll.scrollLeft + chipsScroll.clientWidth >= chipsScroll.scrollWidth - 2;
      arrowLeft.disabled  = atStart;
      arrowRight.disabled = atEnd;
    };
    arrowLeft.addEventListener('click',  () => { chipsScroll.scrollLeft -= SCROLL_STEP; });
    arrowRight.addEventListener('click', () => { chipsScroll.scrollLeft += SCROLL_STEP; });
    chipsScroll.addEventListener('scroll', updateArrows, { passive: true });
    // Run once on load so right arrow is enabled correctly
    updateArrows();
  }

  // ── More Options collapse ─────────────────────────────────────
  const moreToggle = document.getElementById('more-options-toggle');
  const moreBody   = document.getElementById('more-body');
  const moreIcon   = document.getElementById('more-collapse-icon');
  if (moreToggle && moreBody) {
    moreToggle.addEventListener('click', () => {
      const isOpen = moreBody.style.display !== 'none';
      moreBody.style.display = isOpen ? 'none' : 'block';
      if (moreIcon) moreIcon.className = isOpen ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
    });
  }

  // ── Card collapses (Prompt / Lyrics / Styles) ────────────────
  ['prompt', 'lyrics', 'styles'].forEach(id => {
    const btn  = document.getElementById(id + '-collapse-btn');
    const body = document.getElementById(id + '-body');
    const icon = document.getElementById(id + '-collapse-icon');
    if (btn && body) {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        if (icon) icon.className = isOpen ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
      });
    }
  });

  // ── Magic wand (auto-fill prompt) ────────────────────────────
  const magicPrompts = [
    'dark surf noir trap beat, moody Rhodes, open hi-hats, deep 808 bass',
    'melodic R&B soul beat, lush chords, soft snare, 90 BPM, emotional',
    'hard drill beat, sliding 808s, rattling hi-hats, aggressive energy',
    'lo-fi chill hop, dusty samples, slow tempo, mellow vibes',
    'afrobeats groovy instrumental, percussion-heavy, uplifting, 110 BPM',
    'cinematic orchestral hip-hop, strings, dramatic, dark trap drums',
    'boom bap classic, punchy kicks, vinyl crackle, sample-based, soulful',
  ];
  ['lyrics-magic-btn','prompt-magic-btn','style-magic-btn'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', () => {
        const rnd = magicPrompts[Math.floor(Math.random() * magicPrompts.length)];
        const promptEl = document.getElementById('gen-prompt');
        const styleEl  = document.getElementById('gen-style');
        if (btnId === 'style-magic-btn' && styleEl) {
          // extract genre/mood parts as style
          styleEl.value = rnd.split(',').slice(0,2).join(',');
        } else if (promptEl) {
          promptEl.value = rnd;
          // switch to prompt tab
          document.querySelectorAll('.suno-tab').forEach(t => { if(t.dataset.tab==='prompt') t.click(); });
        }
        btn.style.transform = 'rotate(360deg)';
        setTimeout(() => btn.style.transform = '', 400);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  REAL PIPELINE — Beat Generator
  // ═══════════════════════════════════════════════════════════════

  const genBtn        = document.getElementById('gen-full-btn');
  const genRetryBtn   = document.getElementById('gen-retry-btn');
  const pipelineStatus= document.getElementById('pipeline-status');
  const genResult     = document.getElementById('gen-result');
  const genEmpty      = document.getElementById('gen-empty');
  const genError      = document.getElementById('gen-error');
  const genErrorMsg   = document.getElementById('gen-error-msg');
  const trackList     = document.getElementById('track-list');
  const stereoPlayer  = document.getElementById('stereo-player');
  const stereoAudio   = document.getElementById('stereo-audio');
  const stereoDownload= document.getElementById('stereo-download');
  const bpBlueprint   = document.getElementById('pipeline-blueprint');
  const bpPills       = document.getElementById('blueprint-pills');

  if (!genBtn) return; // not on generator page

  let currentJobId = null;
  let pollInterval = null;

  function getInputs() {
    const lyrics      = document.getElementById('gen-lyrics')?.value?.trim() || '';
    const prompt      = document.getElementById('gen-prompt')?.value?.trim() || '';
    const style       = document.getElementById('gen-style')?.value?.trim() || '';
    const instrumental= document.getElementById('gen-instrumental')?.checked || false;
    const instruments = document.getElementById('gen-instruments')?.value?.trim() || '';
    const title       = document.getElementById('gen-title')?.value?.trim() || '';

    // Build the combined prompt — genre/style MUST come first so GPT honours it
    const parts = [];
    if (style) parts.push(style);  // genre first
    if (prompt) parts.push(prompt);
    if (instrumental) parts.push('instrumental only, no vocals');
    if (instruments) parts.push('include instruments: ' + instruments);

    return {
      genre: style || '',
      prompt: parts.join('. '),
      // lyrics are passed separately — backend routes to song/generate when present
      lyrics: (activeTab === 'write' && lyrics) ? lyrics : '',
      vocal_space: instrumental ? 'none' : 'high',
      instruments_include: instruments ? instruments.split(',').map(s=>s.trim()).filter(Boolean) : [],
      instruments_exclude: [],
      title,
      instrumental
    };
  }

  // ── Live duration estimate from lyrics ───────────────────────
  function estimateLyricsDuration(text) {
    if (!text || !text.trim()) return null;
    const wordCount = text.trim().split(/\s+/).length;
    const estimatedSec = Math.round((wordCount / 120) * 60);
    const clamped = Math.max(60, Math.min(300, estimatedSec));
    return Math.ceil(clamped / 15) * 15;
  }
  function fmtDuration(sec) {
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  const lyricsTextarea = document.getElementById('gen-lyrics');
  const lyricsDurationHint = document.getElementById('lyrics-duration-hint');
  const lyricsDurationText = document.getElementById('lyrics-duration-text');
  if (lyricsTextarea) {
    lyricsTextarea.addEventListener('input', () => {
      const dur = estimateLyricsDuration(lyricsTextarea.value);
      if (dur && lyricsTextarea.value.trim()) {
        if (lyricsDurationHint) lyricsDurationHint.style.display = 'flex';
        if (lyricsDurationText) lyricsDurationText.textContent = 'Estimated duration: ~' + fmtDuration(dur);
      } else {
        if (lyricsDurationHint) lyricsDurationHint.style.display = 'none';
      }
    });
  }

  function setStep(step, state) {
    // state: 'active' | 'done' | 'error' | ''
    const ind = document.getElementById('ind-' + step);
    const row = document.getElementById('step-' + step);
    if (!ind || !row) return;
    ind.innerHTML = state === 'active'
      ? '<i class="fas fa-spinner fa-spin" style="color:var(--primary)"></i>'
      : state === 'done'
      ? '<i class="fas fa-check-circle" style="color:var(--accent-2)"></i>'
      : state === 'error'
      ? '<i class="fas fa-times-circle" style="color:var(--danger)"></i>'
      : '';
    row.style.opacity = (state === '' ) ? '0.4' : '1';
  }

  function showBlueprint(bp) {
    if (!bp) return;

    // Build pill HTML fragments
    const pills = [
      { icon: 'fa-drum',        label: bp.bpm ? bp.bpm + ' BPM' : null },
      { icon: 'fa-music',       label: (bp.key || bp.scale) ? (bp.key + ' ' + bp.scale).trim() : null },
      { icon: 'fa-compact-disc',label: bp.genre || null },
      { icon: 'fa-heart',       label: bp.mood || null },
      { icon: 'fa-bolt',        label: bp.energy ? bp.energy + ' energy' : null },
    ].filter(p => p.label);

    function buildPillHTML(extraClass) {
      let html = '';
      pills.forEach(p => {
        html += `<span class="blueprint-pill${extraClass||''}"><i class="fas ${p.icon}"></i> ${p.label}</span>`;
      });
      if (bp.instruments && bp.instruments.length > 0) {
        const familyIconMap = {
          drums: 'fa-drum', bass: 'fa-guitar', keys: 'fa-keyboard',
          guitar: 'fa-guitar', strings: 'fa-music', brass: 'fa-music',
          woodwind: 'fa-music', synth: 'fa-wave-square', fx: 'fa-wand-magic-sparkles',
          vocals: 'fa-microphone', default: 'fa-music'
        };
        bp.instruments.forEach(ins => {
          const icon = familyIconMap[ins.family] || familyIconMap.default;
          html += `<span class="blueprint-pill blueprint-pill--instr${extraClass||''}"><i class="fas ${icon}"></i> ${ins.name}</span>`;
        });
      } else if (bp.instrument_count) {
        html += `<span class="blueprint-pill${extraClass||''}"><i class="fas fa-layer-group"></i> ${bp.instrument_count} instruments</span>`;
      }
      return html;
    }

    // Populate hidden legacy blueprint-pills (for backward compat)
    if (bpPills) {
      bpPills.innerHTML = '';
      pills.forEach(p => {
        const el = document.createElement('span');
        el.className = 'blueprint-pill';
        el.innerHTML = `<i class="fas ${p.icon}"></i> ${p.label}`;
        bpPills.appendChild(el);
      });
      if (bp.instruments && bp.instruments.length > 0) {
        const familyIconMap = {
          drums: 'fa-drum', bass: 'fa-guitar', keys: 'fa-keyboard',
          guitar: 'fa-guitar', strings: 'fa-music', brass: 'fa-music',
          woodwind: 'fa-music', synth: 'fa-wave-square', fx: 'fa-wand-magic-sparkles',
          vocals: 'fa-microphone', default: 'fa-music'
        };
        bp.instruments.forEach(ins => {
          const icon = familyIconMap[ins.family] || familyIconMap.default;
          const el = document.createElement('span');
          el.className = 'blueprint-pill blueprint-pill--instr';
          el.innerHTML = `<i class="fas ${icon}"></i> ${ins.name}`;
          bpPills.appendChild(el);
        });
      } else if (bp.instrument_count) {
        const el = document.createElement('span');
        el.className = 'blueprint-pill';
        el.innerHTML = `<i class="fas fa-layer-group"></i> ${bp.instrument_count} instruments`;
        bpPills.appendChild(el);
      }
      if (bpBlueprint) bpBlueprint.style.display = 'block';
    }

    // Update status msg in cards to show key blueprint info (no pills in cards)
    ['1','2'].forEach(n => {
      const msg = document.getElementById('pipeline-card-' + n + '-msg');
      if (msg && bp.bpm) {
        msg.textContent = bp.bpm + ' BPM · ' + (bp.key||'') + ' ' + (bp.scale||'');
      }
    });
  }


  function fillWave(container, color) {
    for (let i = 0; i < 120; i++) {
      const b = document.createElement('div');
      const h = Math.random()*26+4;
      b.style.cssText = `width:2px;height:${h}px;border-radius:1px;background:${color};opacity:${0.4+Math.random()*0.5};flex-shrink:0;`;
      container.appendChild(b);
    }
  }


  function showError(msg) {
    genBtn.innerHTML = '<i class="fas fa-music"></i> Create';
    genBtn.disabled = false;
    if (pipelineStatus) pipelineStatus.style.display = 'none';
    if (genEmpty) genEmpty.style.display = 'none';
    if (genResult) genResult.style.display = 'none';
    if (genError) genError.style.display = 'block';
    if (genErrorMsg) genErrorMsg.textContent = msg || 'Something went wrong. Please try again.';
    if (pollInterval) clearInterval(pollInterval);
  }

  // ── Cancel generation ────────────────────────────────────────
  window.cancelGeneration = function() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (pipelineStatus) { pipelineStatus.style.display = 'none'; }
    if (genBtn) { genBtn.innerHTML = '<i class="fas fa-music"></i> Create'; genBtn.disabled = false; }
    if (genEmpty) genEmpty.style.display = 'block';
    if (genResult) genResult.style.display = 'none';
    if (genError) genError.style.display = 'none';
    currentJobId = null;
  };

  // ── Scrubber time formatter ───────────────────────────────────
  function _pipelineFmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── Wire scrubber to an audio element (call once per card when audio src is set) ──
  function _pipelineWireScrubber(n) {
    var audio    = document.getElementById('pipeline-audio-' + n);
    var scrubber = document.getElementById('pipeline-scrubber-' + n);
    var range    = document.getElementById('pipeline-scrubber-' + n + '-range');
    var curEl    = document.getElementById('pipeline-scrubber-' + n + '-cur');
    var durEl    = document.getElementById('pipeline-scrubber-' + n + '-dur');
    if (!audio || !range) return;

    // Show scrubber panel
    if (scrubber) scrubber.style.display = 'block';

    // Range is always 0-100 (percentage). Never change max.
    range.min = 0; range.max = 100; range.step = 0.1;

    function _setFill(pct) {
      range.style.background = 'linear-gradient(to right, #a78bfa 0%, #a78bfa ' + pct + '%, rgba(255,255,255,.15) ' + pct + '%, rgba(255,255,255,.15) 100%)';
    }

    // Duration: set immediately if already loaded (readyState >= 1), OR wait for event.
    // This fixes the race where src is set then wireScrubber is called — loadedmetadata
    // may have already fired before the listener is attached.
    function _applyDuration() {
      if (durEl && isFinite(audio.duration) && audio.duration > 0)
        durEl.textContent = _pipelineFmtTime(audio.duration);
    }
    if (audio.readyState >= 1) {
      _applyDuration();
    } else {
      audio.addEventListener('loadedmetadata', _applyDuration);
    }
    // Also handle the case where metadata loads slightly after wiring
    audio.addEventListener('loadedmetadata', _applyDuration);

    // Tick: update position while playing (skip if user is scrubbing)
    // Also refreshes duration in case it wasn't set yet on first tick
    audio.addEventListener('timeupdate', function() {
      if (durEl && (!durEl.textContent || durEl.textContent === '0:00') && isFinite(audio.duration) && audio.duration > 0)
        durEl.textContent = _pipelineFmtTime(audio.duration);
      if (range._seeking) return;
      var pct = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0;
      range.value = pct;
      if (curEl) curEl.textContent = _pipelineFmtTime(audio.currentTime);
      _setFill(pct);
    });

    // While dragging: preview time display + fill only, do NOT seek yet
    range.addEventListener('input', function() {
      range._seeking = true;
      var pct = parseFloat(range.value);
      var previewTime = (pct / 100) * (audio.duration || 0);
      if (curEl) curEl.textContent = _pipelineFmtTime(previewTime);
      _setFill(pct);
    });

    // On release: commit the seek
    range.addEventListener('change', function() {
      var pct = parseFloat(range.value);
      var seekTo = (pct / 100) * (audio.duration || 0);
      audio.currentTime = seekTo;
      range._seeking = false;
    });

    // Mouseup/touchend safety: ensure _seeking is cleared even if 'change' fires late
    function _endSeek() { range._seeking = false; }
    range.addEventListener('mouseup', _endSeek);
    range.addEventListener('touchend', _endSeek);

    // Reset range on ended
    audio.addEventListener('ended', function() {
      range.value = 0;
      range._seeking = false;
      _setFill(0);
      if (curEl) curEl.textContent = '0:00';
    });
  }

  // ── Pipeline card play/pause (called from card onclick) ──────
  window.pipelineCardPlay = function(n) {
    const audio = document.getElementById('pipeline-audio-' + n);
    const playBtn = document.getElementById('pipeline-card-' + n + '-play');
    if (!audio || !audio.src) return;
    // Pause the other card if it's playing
    const other = n === 1 ? 2 : 1;
    const otherAudio = document.getElementById('pipeline-audio-' + other);
    const otherPlayBtn = document.getElementById('pipeline-card-' + other + '-play');
    if (otherAudio && !otherAudio.paused) {
      otherAudio.pause();
      if (otherPlayBtn) { otherPlayBtn.classList.remove('is-playing'); otherPlayBtn.innerHTML = '<i class="fas fa-play"></i>'; }
    }
    if (audio.paused) {
      audio.play().catch(() => {});
      if (playBtn) { playBtn.classList.add('is-playing'); playBtn.innerHTML = '<i class="fas fa-pause"></i>'; }
    } else {
      audio.pause();
      if (playBtn) { playBtn.classList.remove('is-playing'); playBtn.innerHTML = '<i class="fas fa-play"></i>'; }
    }
    audio.onended = function() {
      if (playBtn) { playBtn.classList.remove('is-playing'); playBtn.innerHTML = '<i class="fas fa-play"></i>'; }
    };
  };

  async function startGeneration() {
    const inputs = getInputs();

    // Validate: need either lyrics (write tab), prompt, style, instrumental, OR a reference track
    const hasContent = document.getElementById('gen-lyrics')?.value?.trim() ||
                       document.getElementById('gen-prompt')?.value?.trim() ||
                       document.getElementById('gen-style')?.value?.trim() ||
                       document.getElementById('gen-instrumental')?.checked ||
                       window._refFileId;  // reference track counts as content
    if (!hasContent) {
      const left = document.getElementById('suno-left');
      if (left) { left.style.animation = 'shake .3s ease'; setTimeout(() => left.style.animation = '', 400); }
      const inlineBtn = document.querySelector('.suno-create-inline');
      if (inlineBtn) { inlineBtn.style.background = 'rgba(239,68,68,.1)'; setTimeout(() => inlineBtn.style.background = '', 600); }
      return;
    }

    // Scroll result area into view on mobile
    const sunoRight = document.querySelector('.suno-right');
    if (sunoRight && window.innerWidth < 900) sunoRight.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Reset UI
    genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    genBtn.disabled = true;
    if (genEmpty) genEmpty.style.display = 'none';
    if (genError) genError.style.display = 'none';
    if (genResult) genResult.style.display = 'none';
    // Remove any dual-card layout from previous run
    const oldDual = document.getElementById('gen-result-dual');
    if (oldDual) oldDual.remove();
    if (pipelineStatus) { pipelineStatus.style.display = 'block'; pipelineStatus.style.opacity = '1'; }
    if (bpBlueprint) bpBlueprint.style.display = 'none';

    // ── Reset pipeline cards to spinner state ─────────────────
    window._pipelineAudioUrl = [null, null, null];
    [1, 2].forEach(n => {
      const card    = document.getElementById('pipeline-card-' + n);
      const overlay = document.getElementById('pipeline-card-' + n + '-overlay');
      const playBtn = document.getElementById('pipeline-card-' + n + '-play');
      const titleEl = document.getElementById('pipeline-card-' + n + '-title');
      const msgEl   = document.getElementById('pipeline-card-' + n + '-msg');
      const pillsEl = document.getElementById('pipeline-card-' + n + '-pills');
      const audio   = document.getElementById('pipeline-audio-' + n);
      const scrubber = document.getElementById('pipeline-scrubber-' + n);
      const scrubRange = document.getElementById('pipeline-scrubber-' + n + '-range');
      const scrubCur = document.getElementById('pipeline-scrubber-' + n + '-cur');
      if (card)    { card.classList.remove('is-ready'); }
      if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; overlay.style.transition = ''; }
      if (playBtn) { playBtn.style.display = 'none'; playBtn.classList.remove('is-playing'); playBtn.innerHTML = '<i class="fas fa-play"></i>'; }
      if (titleEl) titleEl.textContent = '';
      if (msgEl)   { msgEl.textContent = 'Generating…'; msgEl.classList.remove('is-done'); }
      if (pillsEl) { pillsEl.innerHTML = ''; pillsEl.style.display = 'none'; }
      if (audio)   { audio.pause(); audio.src = ''; }
      // Reset scrubber
      if (scrubber) scrubber.style.display = 'none';
      if (scrubRange) { scrubRange.value = 0; scrubRange.style.background = 'rgba(255,255,255,.15)'; }
      if (scrubCur) scrubCur.textContent = '0:00';
      // Remove any old download buttons
      const scrubberEl = document.getElementById('pipeline-scrubber-' + n);
      if (scrubberEl && scrubberEl.nextSibling && scrubberEl.nextSibling.tagName === 'BUTTON') {
        scrubberEl.nextSibling.remove();
      }
    });
    // Restore cancel btn and status sub
    const cancelBtnReset = document.getElementById('gen-cancel-btn');
    if (cancelBtnReset) cancelBtnReset.style.display = 'block';
    const statusSubReset = document.getElementById('pipeline-status-sub');
    if (statusSubReset) { statusSubReset.textContent = 'Stemforge is forging your beats…'; statusSubReset.style.display = 'block'; }

    setStep('blueprint', 'active');
    setStep('generating', '');
    setStep('extracting', '');

    try {
      // Start the pipeline job
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: inputs.prompt,
          genre: inputs.genre,
          lyrics: inputs.lyrics || '',
          vocal_mode: inputs.instrumental ? 'instrumental' : 'write',
          vocal_space: inputs.vocal_space,
          energy: inputs.energy,
          instruments_include: inputs.instruments_include,
          instruments_exclude: inputs.instruments_exclude,
          title: inputs.title || '',
          vocal_gender: window._vocalGender || 'off',
          user_duration: window._userDuration || 0
        })
      });

      if (!res.ok) {
        const err = await safeJson(res);
        if (err.login_required) {
          // Not logged in — redirect to login
          genBtn.innerHTML = '<i class="fas fa-music"></i> Create';
          genBtn.disabled = false;
          if (pipelineStatus) pipelineStatus.style.display = 'none';
          const loginMsg = document.createElement('div');
          loginMsg.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-top:16px;text-align:center';
          loginMsg.innerHTML = `<i class="fas fa-user-lock" style="font-size:1.5rem;color:var(--accent);margin-bottom:10px;display:block"></i>
            <strong style="display:block;margin-bottom:6px">Sign in to generate beats</strong>
            <p style="color:var(--text-2);font-size:.9rem;margin-bottom:14px">All your beats are saved to your library when you're logged in. Sign in or create a free account to continue.</p>
            <a href="/login" class="btn btn--primary btn--sm"><i class="fas fa-sign-in-alt"></i> Sign in / Sign up</a>`;
          const resultArea = document.getElementById('gen-result');
          if (resultArea) resultArea.parentNode.insertBefore(loginMsg, resultArea);
          else document.querySelector('.gen-panel')?.appendChild(loginMsg);
          return;
        }
        if (err.limit_reached) {
          // Show upgrade prompt instead of generic error
          genBtn.innerHTML = '<i class="fas fa-music"></i> Create';
          genBtn.disabled = false;
          if (pipelineStatus) pipelineStatus.style.display = 'none';
          const limitMsg = document.createElement('div');
          limitMsg.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-top:16px;text-align:center';
          limitMsg.innerHTML = `<i class="fas fa-lock" style="font-size:1.5rem;color:var(--accent);margin-bottom:10px;display:block"></i>
            <strong style="display:block;margin-bottom:6px">Generation limit reached</strong>
            <p style="color:var(--text-2);font-size:.9rem;margin-bottom:14px">${err.error}</p>
            <a href="/pricing" class="btn btn--primary btn--sm"><i class="fas fa-arrow-up"></i> Upgrade plan</a>`;
          const resultArea = document.getElementById('gen-result');
          if (resultArea) resultArea.parentNode.insertBefore(limitMsg, resultArea);
          else pipelineStatus.parentNode.appendChild(limitMsg);
          return;
        }
        throw new Error(err.error || 'Failed to start generation');
      }

      const { job_id } = await safeJson(res);
      currentJobId = job_id;

      genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';

      // Poll for status
      // While status=generating, use POST /api/poll/:id (advances Mureka check each call)
      // For all other statuses, GET /api/job/:id is fine (read-only)
      let lastStatus = '';
      pollInterval = setInterval(async () => {
        try {
          const usePost = (lastStatus === 'generating' || lastStatus === 'pending' || lastStatus === 'blueprint' || lastStatus === '');
          const pollRes = usePost
            ? await fetch('/api/poll/' + job_id, { method: 'POST' })
            : await fetch('/api/job/' + job_id);
          if (!pollRes.ok) return;
          const job = await safeJson(pollRes);

          // ── Helper: set both card status messages ────────────────
          function setCardMsg(txt) {
            ['1','2'].forEach(n => {
              const el = document.getElementById('pipeline-card-' + n + '-msg');
              if (el) el.textContent = txt;
            });
          }

          // Update pipeline steps + card messages based on status
          const statusSub = document.getElementById('pipeline-status-sub');
          if (job.status === 'blueprint' && lastStatus !== 'blueprint') {
            setStep('blueprint', 'active');
            setCardMsg('Designing…');
            if (statusSub) statusSub.textContent = 'Designing your beat blueprint…';
            lastStatus = 'blueprint';
          }
          if (job.status === 'generating' && lastStatus !== 'generating') {
            setStep('blueprint', 'done');
            setStep('generating', 'active');
            setCardMsg('Generating…');
            if (statusSub) statusSub.textContent = 'StemForge is forging your beat…';
            if (job.blueprint) showBlueprint(job.blueprint);
            lastStatus = 'generating';
          }
          if (job.status === 'extracting' && lastStatus !== 'extracting') {
            setStep('blueprint', 'done');
            setStep('generating', 'done');
            setStep('extracting', 'active');
            setCardMsg('Extracting stems…');
            if (statusSub) statusSub.textContent = 'Extracting stems…';
            if (job.blueprint) showBlueprint(job.blueprint);
            lastStatus = 'extracting';
          }

          if (job.status === 'ready') {
            clearInterval(pollInterval);
            setStep('blueprint', 'done');
            setStep('generating', 'done');
            setStep('extracting', 'done');

            // ── Cards STAY — transition to ready state ────────────
            // Hide cancel button
            const cancelBtn = document.getElementById('gen-cancel-btn');
            if (cancelBtn) cancelBtn.style.display = 'none';
            // Hide status sub-line
            const statusSubReady = document.getElementById('pipeline-status-sub');
            if (statusSubReady) statusSubReady.style.display = 'none';
            // Keep gen-result hidden (cards are the result now)
            if (genResult) genResult.style.display = 'none';

            // ── Resolve final track title ─────────────────────────
            // Prefer blueprint genre; only use job.title if it's a real name (not a prompt string)
            const _jobTitleClean = (job.title && !/instrumental\s+only|no\s+vocals|include\s+instruments/i.test(job.title)) ? job.title : null;
            const _pipelineGenreRaw = job.blueprint ? job.blueprint.genre : null;
            const _pipelineGenreClean = (_pipelineGenreRaw && !/instrumental\s+only|no\s+vocals|include\s+instruments/i.test(_pipelineGenreRaw)) ? _pipelineGenreRaw : null;
            const finalTitle = (_pipelineGenreClean ? (_pipelineGenreClean + (job.blueprint.key ? ' — ' + job.blueprint.key + ' ' + (job.blueprint.scale||'') : '')) : null) ||
              _jobTitleClean || 'Beat Ready';
            // Sanitize for filename: replace special chars with underscores, ensure non-empty
            const safeFilename = (finalTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').toLowerCase().replace(/^_+|_+$/g, '')) || 'stemforge_beat';



            // ── Determine user plan for download gating ─────────
            const currentPlan = (window._sfUser && window._sfUser.plan) || 'free';
            const isFree = currentPlan === 'free';
            const userPlan = currentPlan;

            // Helper: show upgrade modal when free user tries to download
            function showUpgradePrompt() {
              let modal = document.getElementById('sf-upgrade-modal');
              if (!modal) {
                modal = document.createElement('div');
                modal.id = 'sf-upgrade-modal';
                modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(6px)';
                modal.innerHTML = `
                  <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:36px 32px;max-width:420px;width:90%;text-align:center;position:relative">
                    <button onclick="document.getElementById('sf-upgrade-modal').style.display='none'" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>
                    <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#4e9fff,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.4rem;color:#fff">
                      <i class="fas fa-lock-open"></i>
                    </div>
                    <h3 style="font-size:1.25rem;font-weight:700;margin-bottom:8px">Upgrade to access</h3>
                    <p style="color:var(--muted);font-size:.9rem;margin-bottom:24px;line-height:1.5">Free accounts can listen to your beat, but downloads require a <strong>Creator</strong> or <strong>Pro Artist</strong> plan.</p>
                    <div style="display:flex;flex-direction:column;gap:10px">
                      <a href="/pricing?plan=creator" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
                        <i class="fas fa-crown"></i> Creator — $10/mo · 800 pts
                      </a>
                      <a href="/pricing?plan=pro" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
                        <i class="fas fa-star"></i> Pro Artist — $26/mo · 2,000 pts
                      </a>
                    </div>
                    <p style="color:var(--muted);font-size:.78rem;margin-top:16px">You keep your generated beat — just upgrade anytime to download it.</p>
                  </div>`;
                document.body.appendChild(modal);
              } else {
                modal.style.display = 'flex';
              }
            }

            // ── Update pipeline cards in-place (cards STAY as result) ──
            const hasAlt = !!job.stereo_url_alt;
            const urls = [job.stereo_url, job.stereo_url_alt || job.stereo_url];

            // Store audio URLs for card playback
            window._pipelineAudioUrl = [null, job.stereo_url, job.stereo_url_alt || job.stereo_url];

            // Activate each card: hide spinner, show play button, scrubber, update body
            [1, 2].forEach(n => {
              // If no alt, card 2 gets a "plan limit" state instead of duplicating card 1
              const url = hasAlt ? urls[n - 1] : (n === 1 ? urls[0] : null);
              const card    = document.getElementById('pipeline-card-' + n);
              const overlay = document.getElementById('pipeline-card-' + n + '-overlay');
              const playBtn = document.getElementById('pipeline-card-' + n + '-play');
              const titleEl = document.getElementById('pipeline-card-' + n + '-title');
              const msgEl   = document.getElementById('pipeline-card-' + n + '-msg');
              const audio   = document.getElementById('pipeline-audio-' + n);
              const scrubberEl = document.getElementById('pipeline-scrubber-' + n);

              // Always fade the spinner out on both cards
              if (overlay) {
                overlay.style.transition = 'opacity .4s';
                overlay.style.opacity = '0';
                setTimeout(() => { overlay.style.display = 'none'; }, 400);
              }

              if (!url) {
                // No second clip — show "plan limit" message on card 2
                if (card) card.classList.add('is-ready');
                if (titleEl) titleEl.textContent = 'Only 1 version';
                if (msgEl) {
                  msgEl.innerHTML = '<i class="fas fa-crown" style="color:#f59e0b;margin-right:4px"></i>Upgrade for 2 versions';
                  msgEl.classList.remove('is-done');
                }
                return;
              }

              if (playBtn) playBtn.style.display = 'flex';
              if (card)    card.classList.add('is-ready');
              if (titleEl) titleEl.textContent = (finalTitle.replace(/_/g,' ') + (hasAlt ? (n === 1 ? ' — V1' : ' — V2') : ''));
              if (msgEl)   { msgEl.textContent = 'Ready · tap to play'; msgEl.classList.add('is-done'); }
              if (audio)   { audio.src = url; audio.preload = 'auto'; }
              // Show X close button on first card ready
              if (n === 1) {
                var closeBtnEl2 = document.getElementById('pipeline-close-btn');
                if (closeBtnEl2) { closeBtnEl2.style.display = 'flex'; }
              }

              // Wire scrubber
              _pipelineWireScrubber(n);

              // Pills + Download button — appended to card body (scrubber's parent)
              const scrubParent = scrubberEl ? scrubberEl.parentNode : null;
              if (scrubParent) {
                // Remove old pills/download if re-running
                scrubParent.querySelectorAll('.pipeline-card-pills, .pipeline-dl-btn').forEach(el => el.remove());

                // ── Blueprint pills (above download) ──
                if (job.blueprint) {
                  const bp = job.blueprint;
                  const pillDefs = [
                    { icon: 'fa-drum',         label: bp.bpm ? bp.bpm + ' BPM' : null },
                    { icon: 'fa-music',        label: (bp.key || bp.scale) ? ((bp.key||'') + ' ' + (bp.scale||'')).trim() : null },
                    { icon: 'fa-compact-disc', label: bp.genre || null },
                    { icon: 'fa-heart',        label: bp.mood || null },
                  ].filter(p => p.label);
                  if (pillDefs.length) {
                    const pillsDiv = document.createElement('div');
                    pillsDiv.className = 'pipeline-card-pills project-card__tags';
                    pillsDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;margin-bottom:4px';
                    pillDefs.forEach(p => {
                      const sp = document.createElement('span');
                      sp.className = 'blueprint-pill';
                      sp.style.cssText = 'font-size:.68rem;padding:2px 6px';
                      sp.innerHTML = '<i class="fas ' + p.icon + '"></i> ' + p.label;
                      pillsDiv.appendChild(sp);
                    });
                    scrubParent.appendChild(pillsDiv);
                  }
                }

                // ── Download button ──
                const dlBtn = document.createElement('button');
                dlBtn.className = 'pipeline-dl-btn btn btn--sm';
                if (isFree) {
                  dlBtn.style.cssText = 'margin-top:6px;width:100%;padding:5px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--muted);cursor:pointer;font-size:.75rem';
                  dlBtn.innerHTML = '<i class="fas fa-lock"></i> Upgrade to download';
                  dlBtn.onclick = function() { showUpgradePrompt(); };
                } else {
                  dlBtn.style.cssText = 'margin-top:6px;width:100%;padding:5px;border-radius:8px;border:1px solid rgba(78,159,255,.3);background:rgba(78,159,255,.08);color:var(--primary,#4e9fff);cursor:pointer;font-size:.75rem;font-weight:600';
                  dlBtn.innerHTML = '<i class="fas fa-download"></i> Download' + (hasAlt ? ' V' + n : '');
                  const dlUrl = url, dlName = safeFilename + (hasAlt ? '_v' + n : '') + '.mp3';
                  dlBtn.onclick = function() { var a=document.createElement('a');a.href=dlUrl;a.download=dlName;document.body.appendChild(a);a.click();a.remove(); };
                }
                scrubParent.appendChild(dlBtn);
              }
            });

            // Build export action buttons — Creator: mastered only; Pro: 3 options
            const exportOptionsRow = document.getElementById('export-options-row');
            if (exportOptionsRow) {
              exportOptionsRow.innerHTML = '';

              // Helper: trigger download in WAV (via /api/download-wav) or MP3 (direct)
              function doDownload(url, filename, format) {
                if (format === 'wav') {
                  const jobIdDl = job.id || currentJobId;
                  doWavDownload(jobIdDl, filename);
                } else {
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = filename + '.mp3';
                  document.body.appendChild(a); a.click(); a.remove();
                }
              }

              // Helper: show format picker popup (WAV / MP3)
              function showFormatPicker(anchorBtn, label, onPick) {
                const existing = document.getElementById('export-fmt-popup');
                if (existing) existing.remove();
                const popup = document.createElement('div');
                popup.id = 'export-fmt-popup';
                popup.style.cssText = 'position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:var(--card-bg,#1a1a2e);border:1px solid var(--border,#333);border-radius:10px;padding:8px;display:flex;gap:8px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.5);white-space:nowrap';
                popup.innerHTML = `
                  <button onclick="this.closest('#export-fmt-popup').remove();(${onPick.toString()})('mp3')" style="flex:1;padding:8px 14px;border-radius:8px;border:1px solid var(--border,#333);background:var(--surface-2,#222);color:var(--text,#fff);cursor:pointer;font-size:.82rem"><i class="fas fa-file-audio"></i> MP3</button>
                  <button onclick="this.closest('#export-fmt-popup').remove();(${onPick.toString()})('wav')" style="flex:1;padding:8px 14px;border-radius:8px;border:1px solid rgba(78,159,255,.4);background:rgba(78,159,255,.1);color:var(--primary,#4e9fff);cursor:pointer;font-size:.82rem"><i class="fas fa-file-waveform"></i> WAV</button>
                `;
                anchorBtn.style.position = 'relative';
                anchorBtn.appendChild(popup);
                const close = (e) => { if (!popup.contains(e.target) && e.target !== anchorBtn) { popup.remove(); document.removeEventListener('click', close); } };
                setTimeout(() => document.addEventListener('click', close), 50);
              }

              if (isFree) {
                // Free users: locked download + upgrade nudge
                const lockBtn = document.createElement('button');
                lockBtn.className = 'export-btn export-btn--locked';
                lockBtn.innerHTML = '<i class="fas fa-download"></i><span>Download Beat</span><small>Creator+</small>';
                lockBtn.onclick = () => showUpgradePrompt();
                exportOptionsRow.appendChild(lockBtn);
              } else if (userPlan === 'pro' || userPlan === 'developer') {
                // ── Pro Artist: Unmastered Mix (WAV/MP3) + Mastered Mix (WAV/MP3) ──

                // (a) Unmastered mix — WAV or MP3
                const unmastBtn = document.createElement('button');
                unmastBtn.className = 'export-btn export-btn--pro';
                unmastBtn.title = 'Raw unmastered mix — WAV or MP3, ideal for your DAW';
                unmastBtn.innerHTML = '<i class="fas fa-sliders-h"></i><span>Unmastered Mix</span><small>WAV / MP3</small>';
                unmastBtn.onclick = () => showFormatPicker(unmastBtn, 'Unmastered Mix', (fmt) => doDownload(job.stereo_url, safeFilename + '_unmastered', fmt));

                // (b) Mastered mix — WAV or MP3
                const mastBtn = document.createElement('button');
                mastBtn.className = 'export-btn export-btn--pro';
                mastBtn.title = 'Mastered stereo mix ready for release — WAV or MP3';
                mastBtn.innerHTML = '<i class="fas fa-compact-disc"></i><span>Mastered Mix</span><small>WAV / MP3</small>';
                mastBtn.onclick = () => showFormatPicker(mastBtn, 'Mastered Mix', (fmt) => doDownload(job.stereo_url, safeFilename + '_mastered', fmt));

                exportOptionsRow.appendChild(unmastBtn);
                exportOptionsRow.appendChild(mastBtn);
              } else {
                // ── Creator: Mastered Mix only (WAV or MP3) ──
                const dlBtn = document.createElement('button');
                dlBtn.className = 'export-btn';
                dlBtn.title = 'Download your mastered stereo mix — WAV or MP3';
                dlBtn.innerHTML = '<i class="fas fa-compact-disc"></i><span>Mastered Mix</span><small>WAV / MP3</small>';
                dlBtn.onclick = () => showFormatPicker(dlBtn, 'Mastered Mix', (fmt) => doDownload(job.stereo_url, safeFilename + '_mastered', fmt));
                exportOptionsRow.appendChild(dlBtn);
              }

              // ── Get Stems — available to Creator and Pro (not free) ──
              if (!isFree && job.stereo_url) {
                const stemsBtn = document.createElement('button');
                stemsBtn.className = 'export-btn';
                stemsBtn.title = 'Extract individual stems: vocals, drums, bass, and more';
                stemsBtn.innerHTML = '<i class="fas fa-layer-group"></i><span>Get Stems</span><small>Extract</small>';
                stemsBtn.onclick = () => {
                  if (typeof window.openStemsPanel === 'function') {
                    window.openStemsPanel(job.id, job.stereo_url, finalTitle || safeFilename, userPlan);
                  }
                };
                exportOptionsRow.appendChild(stemsBtn);
              }
            }

            // Show upgrade nudge below export panel for free users
            const upgradeNudge = document.getElementById('export-upgrade-nudge');
            if (upgradeNudge) {
              if (isFree) {
                upgradeNudge.innerHTML = '<i class="fas fa-arrow-up"></i> Upgrade to Creator or Pro Artist to download your beat';
                upgradeNudge.style.display = 'block';
              } else {
                upgradeNudge.style.display = 'none';
              }
            }

            // Update result header with title — strip underscores for display
            const titleEl = document.getElementById('gen-result-title');
            const subEl   = document.getElementById('gen-result-sub');
            if (titleEl) titleEl.textContent = finalTitle.replace(/_/g, ' ');
            if (subEl && job.blueprint) {
              const dur = Math.floor((job.blueprint.duration_seconds||120)/60) + ':' + String((job.blueprint.duration_seconds||120)%60).padStart(2,'0');
              subEl.textContent = job.blueprint.bpm + ' BPM · ' + job.blueprint.key + ' ' + job.blueprint.scale;
            }

            // Show thumbnail on result card — granite gradient + StemForge logo + title
            const thumbEl = document.getElementById('gen-result-thumb');
            const thumbLabel = document.getElementById('gen-result-thumb-label');
            if (thumbEl) {
              const hue = job.thumbnail_seed ?? 180;
              thumbEl.style.display = 'flex';
              if (thumbLabel) thumbLabel.textContent = finalTitle;
              // Use shared drawCanvasArt for consistent card art
              const genre = (job.blueprint && job.blueprint.genre) || 'music';
              drawCanvasArt(thumbEl, hue, finalTitle, genre);
            }

            // gen-result panel stays hidden — pipeline cards are the result
            if (genResult) genResult.style.display = 'none';
            genBtn.innerHTML = '<i class="fas fa-check"></i> Done!';
            genBtn.disabled = false;
            // Invalidate library cache so new beat appears immediately when user navigates to library
            if (window._libLoaded) { window._libLoaded.beats = false; }
            // If library is already visible, reload the beats tab immediately
            if (typeof fetchLibTab === 'function' && document.getElementById('lib-tab-beats')) {
              fetchLibTab('beats');
            }
            // Show toast confirming library save
            (function() {
              var t = document.createElement('div');
              t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:12px 18px;border-radius:12px;font-size:.85rem;font-weight:600;z-index:99999;box-shadow:0 4px 20px rgba(16,185,129,.4);display:flex;align-items:center;gap:8px;max-width:280px';
              t.innerHTML = '<i class="fas fa-check-circle" style="font-size:1.1rem;flex-shrink:0"></i><span>Beats saved to your library!</span>';
              document.body.appendChild(t);
              setTimeout(function() { t.style.transition='opacity .4s'; t.style.opacity='0'; setTimeout(function(){ t.remove(); }, 400); }, 4000);
            })();
            // Refresh sidebar points counter to reflect the new usage
            fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(({ user }) => {
              if (!user) return;
              // Update global user object
              if (window._sfUser) {
                window._sfUser.gens_used    = user.gens_used;
                window._sfUser.gens_limit   = user.gens_limit;
                window._sfUser.plan         = user.plan;
                window._sfUser.bonus_credits= user.bonus_credits || 0;
              }
              const gv = document.getElementById('gs-gens-val');
              const gb = document.getElementById('gs-gens-bar');
              const cl = document.getElementById('gs-credits-label');
              // Show remaining points clearly
              const limitMap = { free: 60, creator: 800, pro: 2000 };
              const displayLimit = user.gens_limit || limitMap[user.plan] || 3;
              const remaining = Math.max(0, displayLimit - user.gens_used);
              if (cl) cl.textContent = 'Points Remaining';
              if (gv) gv.innerHTML = `${remaining} <small>/ ${displayLimit}</small>`;
              if (gb) {
                const pct = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0;
                gb.style.width = pct + '%';
              }
              window._sfUpdateSidebarBonus(user.bonus_credits || 0);
              // Show credits-exhausted alert if user has no points left
              const totalRemaining = Math.max(0, displayLimit - user.gens_used) + (user.bonus_credits || 0);
              if (totalRemaining === 0 && user.plan !== 'developer') {
                setTimeout(() => showCreditsExhaustedAlert(), 2500);
              }
            }).catch(() => {});
            // Show 3-dot edit button on result
            const dotsBtn = document.getElementById('gen-result-dots');
            if (dotsBtn) {
              dotsBtn.style.display = 'flex';
              dotsBtn.onclick = () => openSongEditModal(job, null);
            }
            setTimeout(() => {
              genBtn.innerHTML = '<i class="fas fa-music"></i> Create';
            }, 3000);
          }

          if (job.status === 'error') {
            clearInterval(pollInterval);
            setStep('blueprint', lastStatus === 'blueprint' ? 'error' : lastStatus === '' ? '' : 'done');
            setStep('generating', lastStatus === 'generating' ? 'error' : '');
            setStep('extracting', lastStatus === 'extracting' ? 'error' : '');
            // Server-busy (concurrent limit) — show friendly retry message, not a hard fail
            if (job.server_busy || (job.error && job.error.startsWith('SERVER_BUSY:'))) {
              const cleanMsg = (job.error || '').replace('SERVER_BUSY:', '').trim();
              if (genError) genError.style.display = 'block';
              if (genErrorMsg) genErrorMsg.innerHTML =
                '<i class="fas fa-clock" style="color:#f59e0b;margin-right:6px"></i>' +
                '<strong style="color:#f59e0b">Server busy</strong> — ' +
                (cleanMsg || 'Our generation server is at capacity right now.') +
                ' <button onclick="cancelGeneration()" style="margin-left:10px;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);color:#fcd34d;padding:4px 14px;border-radius:6px;cursor:pointer;font-size:.82rem;font-weight:600">Try Again</button>';
              if (pipelineStatus) pipelineStatus.style.display = 'none';
              genBtn.innerHTML = '<i class="fas fa-music"></i> Create';
              genBtn.disabled = false;
              if (pollInterval) clearInterval(pollInterval);
            } else {
              showError(job.error || 'Generation failed. Please try again.');
            }
          }

        } catch (pollErr) {
          console.error('Poll error:', pollErr);
        }
      }, 5000); // poll every 5 seconds (POST /api/poll advances Mureka check each call)

    } catch (err) {
      showError(err.message || 'Failed to start generation. Please try again.');
    }
  }

  // ── Generate Lyrics with AI ──────────────────────────────────────
  const genLyricsBtn = document.getElementById('gen-lyrics-btn');
  if (genLyricsBtn) {
    genLyricsBtn.addEventListener('click', () => {
      const panel = document.getElementById('gen-lyrics-panel');
      if (panel) {
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
      }
    });
  }

  window.generateLyricsAI = async function() {
    const desc    = document.getElementById('gen-lyrics-desc')?.value?.trim();
    const status  = document.getElementById('gen-lyrics-status');
    const submitBtn = document.getElementById('gen-lyrics-submit');
    const style   = document.getElementById('gen-style')?.value?.trim() || '';

    if (!desc) {
      if (status) { status.textContent = 'Please describe what the song is about.'; status.style.color = 'var(--danger)'; status.style.display = 'block'; }
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...'; }
    if (status) { status.textContent = 'Writing your lyrics...'; status.style.color = 'var(--muted)'; status.style.display = 'block'; }

    try {
      const res = await fetch('/api/generate-lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, genre: style || 'hip hop', mood: 'energetic' })
      });
      const data = await res.json();
      if (!res.ok || !data.lyrics) throw new Error(data.error || 'Generation failed');

      // Paste lyrics into the textarea
      const lyricsEl = document.getElementById('gen-lyrics');
      if (lyricsEl) lyricsEl.value = data.lyrics;

      // Hide panel, show success
      if (status) { status.textContent = '✅ Lyrics generated! Edit them above if needed.'; status.style.color = '#10b981'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-sparkles"></i> Generate Lyrics'; }
      // Close the panel after a short delay
      setTimeout(() => {
        const panel = document.getElementById('gen-lyrics-panel');
        if (panel) panel.style.display = 'none';
      }, 1500);
    } catch(err) {
      if (status) { status.textContent = '❌ ' + (err.message || 'Failed to generate lyrics.'); status.style.color = 'var(--danger)'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-sparkles"></i> Generate Lyrics'; }
    }
  };

    genBtn.addEventListener('click', startGeneration);
    window.startGeneration = startGeneration;

  if (genRetryBtn) genRetryBtn.addEventListener('click', () => {
    if (genError) genError.style.display = 'none';
    if (genEmpty) genEmpty.style.display = 'block';
    if (trackList) trackList.innerHTML = '';
    currentJobId = null;
  });

});


// ═══════════════════════════════════════════════════════════════
//  SONG EDIT MODAL
// ═══════════════════════════════════════════════════════════════

// Cache of loaded projects for the modal
window._sfProjects = {};


// ── Render instrument pills into the edit modal ─────────────────────────────
function renderEditInstrumentPills(bp) {
  var group = document.getElementById('edit-instruments-group');
  var container = document.getElementById('edit-blueprint-pills');
  if (!group || !container) return;

  // Hide if no instruments data
  var instruments = bp && bp.instruments_include;
  if (!instruments || instruments.length === 0) {
    group.style.display = 'none';
    return;
  }

  // Icon map matching the create-page logic
  var familyIconMap = {
    drums: 'fa-drum', bass: 'fa-guitar', keys: 'fa-keyboard',
    guitar: 'fa-guitar', strings: 'fa-music', brass: 'fa-music',
    woodwind: 'fa-music', synth: 'fa-wave-square', fx: 'fa-wand-magic-sparkles',
    vocals: 'fa-microphone', default: 'fa-music'
  };

  container.innerHTML = '';
  instruments.forEach(function(ins) {
    // ins is a string like "Kick Drum" from instruments_include array
    // Try to map family from name if available
    var name = typeof ins === 'object' ? ins.name : ins;
    var family = typeof ins === 'object' ? ins.family : null;
    if (!family) {
      var lower = (name || '').toLowerCase();
      if (lower.includes('kick') || lower.includes('snare') || lower.includes('drum') || lower.includes('hi-hat') || lower.includes('hat')) family = 'drums';
      else if (lower.includes('bass')) family = 'bass';
      else if (lower.includes('synth') || lower.includes('pad')) family = 'synth';
      else if (lower.includes('guitar')) family = 'guitar';
      else if (lower.includes('piano') || lower.includes('key') || lower.includes('Rhodes')) family = 'keys';
      else if (lower.includes('vocal') || lower.includes('chop')) family = 'vocals';
      else if (lower.includes('fx') || lower.includes('magic') || lower.includes('effect')) family = 'fx';
      else family = 'default';
    }
    var icon = familyIconMap[family] || familyIconMap.default;
    var el = document.createElement('span');
    el.className = 'blueprint-pill blueprint-pill--instr';
    el.innerHTML = '<i class="fas ' + icon + '"></i> ' + (name || ins);
    container.appendChild(el);
  });

  group.style.display = '';
}

window.openSongEditModal = function(jobData, jobId) {
  const modal = document.getElementById('song-edit-modal');
  if (!modal) return;

  // Reset fields
  document.getElementById('edit-job-id').value = '';
  document.getElementById('edit-title').value = '';
  document.getElementById('edit-lyrics').value = '';
  document.getElementById('edit-bpm').value = '';
  document.getElementById('edit-genre').value = '';
  document.getElementById('edit-description').value = '';
  const infoBlock = document.getElementById('edit-info-block');
  if (infoBlock) infoBlock.style.display = 'none';
  // Reset instruments section
  var instrGroup = document.getElementById('edit-instruments-group');
  if (instrGroup) instrGroup.style.display = 'none';
  var instrContainer = document.getElementById('edit-blueprint-pills');
  if (instrContainer) instrContainer.innerHTML = '';

  // Reset cover art UI
  _setCoverThumb(null);
  _setEditCoverStatus('', false);
  var removeBtn = document.getElementById('edit-cover-remove');
  if (removeBtn) removeBtn.style.display = 'none';
  var coverInput = document.getElementById('edit-cover-file');
  if (coverInput) coverInput.value = '';

  // Helper to populate cover from a job object
  function _loadCoverForJob(job) {
    var thumb = document.getElementById('edit-cover-thumb');
    if (!thumb) return;
    // Always draw canvas art — same as library cards (library never shows image_url, only canvas)
    var hue   = (job.thumbnail_seed != null && job.thumbnail_seed !== undefined) ? job.thumbnail_seed : 180;
    var title = job.title || (job.blueprint ? job.blueprint.genre : '') || 'Untitled';
    var genre = (job.blueprint && job.blueprint.genre) ? job.blueprint.genre : 'music';
    // Clear any previously set backgroundImage first
    thumb.style.backgroundImage = '';
    var icon = thumb.querySelector('.edit-cover-thumb__icon');
    if (icon) icon.style.display = 'none';
    if (window.drawCanvasArt) {
      window.drawCanvasArt(thumb, hue, title, genre);
    }
    thumb.dataset.prevUrl = job.image_url || '';
    if (job.image_url_custom) {
      var rb = document.getElementById('edit-cover-remove');
      if (rb) rb.style.display = '';
    }
  }

  if (jobData) {
    // Opened from generator result
    document.getElementById('edit-job-id').value = jobData.id || '';
    document.getElementById('edit-title').value = jobData.title || (jobData.blueprint ? jobData.blueprint.genre : '');
    document.getElementById('edit-lyrics').value = jobData.user_lyrics || '';
    document.getElementById('edit-bpm').value = jobData.blueprint ? jobData.blueprint.bpm : '';
    document.getElementById('edit-genre').value = jobData.blueprint ? jobData.blueprint.genre : '';
    document.getElementById('edit-description').value = jobData.blueprint ? jobData.blueprint.arrangement || '' : '';
    window._sfProjects[jobData.id] = jobData;
    _loadCoverForJob(jobData);

    // Show read-only info
    if (jobData.blueprint && infoBlock) {
      infoBlock.style.display = 'grid';
      document.getElementById('edit-info-key').textContent = (jobData.blueprint.key || '—') + ' ' + (jobData.blueprint.scale || '');
      document.getElementById('edit-info-scale').textContent = jobData.blueprint.scale || '—';
      document.getElementById('edit-info-mood').textContent = jobData.blueprint.mood || '—';
      // Use actual audio duration from stereo_url if available, fallback to blueprint estimate
      var durEl = document.getElementById('edit-info-duration');
      durEl.textContent = '…';
      if (jobData.stereo_url) {
        var _a = new Audio(); _a.preload = 'metadata';
        _a.onloadedmetadata = function() {
          var s = Math.round(_a.duration);
          durEl.textContent = Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
        };
        _a.onerror = function() {
          var dur = jobData.blueprint.duration_seconds;
          durEl.textContent = dur ? Math.floor(dur/60)+':'+String(dur%60).padStart(2,'0') : '—';
        };
        _a.src = jobData.stereo_url;
      } else {
        var dur = jobData.blueprint.duration_seconds;
        durEl.textContent = dur ? Math.floor(dur/60)+':'+String(dur%60).padStart(2,'0') : '—';
      }
    }
    // Render instrument pills
    renderEditInstrumentPills(jobData.blueprint);
  } else if (jobId) {
    // Opened from project card — need to fetch job data
    document.getElementById('edit-job-id').value = jobId;
    // Show modal immediately with spinner, populate once data arrives
    fetch('/api/job/' + jobId).then(r => r.json()).then(job => {
      if (!job || job.error) return;
      document.getElementById('edit-title').value = job.title || (job.blueprint ? job.blueprint.genre : '');
      document.getElementById('edit-lyrics').value = job.user_lyrics || '';
      document.getElementById('edit-bpm').value = job.blueprint ? job.blueprint.bpm : '';
      document.getElementById('edit-genre').value = job.blueprint ? job.blueprint.genre : '';
      document.getElementById('edit-description').value = job.blueprint ? job.blueprint.arrangement || '' : '';
      if (job.blueprint && infoBlock) {
        infoBlock.style.display = 'grid';
        document.getElementById('edit-info-key').textContent = (job.blueprint.key || '—') + ' ' + (job.blueprint.scale || '');
        document.getElementById('edit-info-scale').textContent = job.blueprint.scale || '—';
        document.getElementById('edit-info-mood').textContent = job.blueprint.mood || '—';
        // Use actual audio duration from stereo_url if available, fallback to blueprint estimate
        var durEl2 = document.getElementById('edit-info-duration');
        durEl2.textContent = '…';
        if (job.stereo_url) {
          var _a2 = new Audio(); _a2.preload = 'metadata';
          _a2.onloadedmetadata = function() {
            var s = Math.round(_a2.duration);
            durEl2.textContent = Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
          };
          _a2.onerror = function() {
            var dur = job.blueprint.duration_seconds;
            durEl2.textContent = dur ? Math.floor(dur/60)+':'+String(dur%60).padStart(2,'0') : '—';
          };
          _a2.src = job.stereo_url;
        } else {
          var dur = job.blueprint.duration_seconds;
          durEl2.textContent = dur ? Math.floor(dur/60)+':'+String(dur%60).padStart(2,'0') : '—';
        }
      }
      // Render instrument pills
      renderEditInstrumentPills(job.blueprint);
      window._sfProjects[jobId] = job;
      _loadCoverForJob(job);
    }).catch(() => {});
  }

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.closeSongEditModal = function() {
  const modal = document.getElementById('song-edit-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
};

// ── Cover art helpers used by the edit modal ────────────────────────────────

// Set the thumbnail preview in the edit modal.
// Accepts a URL (http/https or data:) or null to reset to the music-note icon.
function _setCoverThumb(url) {
  var thumb = document.getElementById('edit-cover-thumb');
  if (!thumb) return;
  if (url) {
    thumb.style.backgroundImage = 'url(' + url + ')';
    thumb.style.backgroundSize  = 'cover';
    thumb.style.backgroundPosition = 'center';
    var icon = thumb.querySelector('.edit-cover-thumb__icon');
    if (icon) icon.style.display = 'none';
  } else {
    thumb.style.backgroundImage = '';
    var icon = thumb.querySelector('.edit-cover-thumb__icon');
    if (icon) icon.style.display = '';
  }
}

function _setEditCoverStatus(msg, isError) {
  var el = document.getElementById('edit-cover-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#e55' : '#4caf50';
}

// Wire up the file-input change event once the DOM is ready.
// We use event delegation via a single listener on the document so we don't
// need to call this repeatedly when the modal is opened.
(function _initCoverUpload() {
  document.addEventListener('change', function(e) {
    var input = e.target;
    if (!input || input.id !== 'edit-cover-file') return;

    var file = input.files && input.files[0];
    if (!file) return;

    // Client-side validation
    var allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.indexOf(file.type) === -1) {
      _setEditCoverStatus('Only JPG, PNG or WebP allowed.', true);
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      _setEditCoverStatus('Image too large — max 5 MB.', true);
      input.value = '';
      return;
    }

    // Show a local preview immediately
    var reader = new FileReader();
    reader.onload = function(evt) { _setCoverThumb(evt.target.result); };
    reader.readAsDataURL(file);

    // Upload to server
    var jobId = (document.getElementById('edit-job-id') || {}).value;
    if (!jobId) { _setEditCoverStatus('No track selected.', true); return; }

    _setEditCoverStatus('Uploading…', false);
    var form = new FormData();
    form.append('job_id', jobId);
    form.append('image', file);

    fetch('/api/job/cover', { method: 'POST', body: form })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          _setEditCoverStatus('Cover updated!', false);
          // Show remove button
          var removeBtn = document.getElementById('edit-cover-remove');
          if (removeBtn) removeBtn.style.display = '';
          // Bust sessionStorage so the card refreshes on next render
          try { sessionStorage.removeItem('cover_img_' + jobId); } catch(e) {}
          // Keep the preview already set from FileReader — or switch to server URL
          if (data.url) _setCoverThumb(data.url);
        } else {
          _setEditCoverStatus(data.error || 'Upload failed.', true);
          // Revert preview to whatever was there before
          var prev = document.getElementById('edit-cover-thumb');
          if (prev && prev.dataset.prevUrl) {
            _setCoverThumb(prev.dataset.prevUrl);
          } else {
            _setCoverThumb(null);
          }
        }
      })
      .catch(function() { _setEditCoverStatus('Network error. Try again.', true); });
  });
}());

// Remove custom cover image — called by the "Remove custom image" button.
window.removeCoverImage = function() {
  var jobId = (document.getElementById('edit-job-id') || {}).value;
  if (!jobId) return;

  _setEditCoverStatus('Removing…', false);
  fetch('/api/job/cover/' + jobId, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        _setCoverThumb(null);
        var removeBtn = document.getElementById('edit-cover-remove');
        if (removeBtn) removeBtn.style.display = 'none';
        _setEditCoverStatus('Custom image removed.', false);
        // Bust sessionStorage so the card re-fetches the AI cover
        try { sessionStorage.removeItem('cover_img_' + jobId); } catch(e) {}
      } else {
        _setEditCoverStatus(data.error || 'Remove failed.', true);
      }
    })
    .catch(function() { _setEditCoverStatus('Network error. Try again.', true); });
};


// ── Creator Tab Popup system ─────────────────────────────────
(function() {
  let _activeOverlay = null;

  // Move all creator popups to <body> on first open to avoid stacking context issues
  function ensurePopupsAtBodyLevel() {
    document.querySelectorAll('.creator-popup').forEach(function(popup) {
      if (popup.parentNode !== document.body) {
        document.body.appendChild(popup);
      }
    });
  }

  window.openCreatorPopup = function(name) {
    // Reference track is now an inline dropdown — skip popup for it
    if (name === 'reference') { window.toggleRefDropdown(); return; }

    // Ensure popups are at body level (escapes any stacking context from parent containers)
    ensurePopupsAtBodyLevel();

    // Close any open popup first
    document.querySelectorAll('.creator-popup').forEach(p => p.style.display = 'none');
    if (_activeOverlay) { _activeOverlay.remove(); _activeOverlay = null; }

    const popup = document.getElementById('creator-popup-' + name);
    if (!popup) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'creator-popup-overlay';
    overlay.addEventListener('click', () => closeCreatorPopup(name));
    document.body.appendChild(overlay);
    _activeOverlay = overlay;

    // Center and show
    popup.style.display = 'flex';
    popup.style.top = '50%';
    popup.style.left = '50%';
    popup.style.transform = 'translate(-50%, -50%)';

    // Mark active tab
    document.querySelectorAll('.creator-tab-btn').forEach(b => { if (b.id !== 'ctab-reference') b.classList.remove('active'); });
    const btn = document.getElementById('ctab-' + name);
    if (btn) btn.classList.add('active');

    // Make draggable
    makeDraggable(popup, popup.querySelector('.creator-popup__header'));
  };

  window.closeCreatorPopup = function(name) {
    if (name === 'reference') {
      var panel = document.getElementById('ref-inline-panel');
      if (panel) panel.style.display = 'none';
      var btn = document.getElementById('ctab-reference');
      var chev = document.getElementById('ctab-ref-chevron');
      if (btn && !refFileId) btn.classList.remove('active');
      if (chev) chev.style.transform = '';
      return;
    }
    const popup = document.getElementById('creator-popup-' + name);
    if (popup) popup.style.display = 'none';
    if (_activeOverlay) { _activeOverlay.remove(); _activeOverlay = null; }
    document.querySelectorAll('.creator-tab-btn').forEach(b => { if (b.id !== 'ctab-reference') b.classList.remove('active'); });
  };

  function makeDraggable(el, handle) {
    if (!handle) return;
    let startX, startY, origX, origY;

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onTouchDown, { passive: true });

    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      // Switch from transform to fixed px positioning
      el.style.transform = 'none';
      el.style.left = origX + 'px';
      el.style.top  = origY + 'px';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    function onTouchDown(e) {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      const rect = el.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      el.style.transform = 'none';
      el.style.left = origX + 'px';
      el.style.top  = origY + 'px';
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onTouchUp);
    }
    function onMove(e) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      el.style.left = Math.max(0, origX + dx) + 'px';
      el.style.top  = Math.max(0, origY + dy) + 'px';
    }
    function onTouchMove(e) {
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      el.style.left = Math.max(0, origX + dx) + 'px';
      el.style.top  = Math.max(0, origY + dy) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    function onTouchUp() {
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchUp);
    }
  }
})();

// Legacy stub — ref card is now in popup, no toggle needed
window.toggleRefCard = function() {};

// Toggle collapse of One Shot card
window.toggleOneShotCard = function() {
  const body = document.getElementById('oneshot-body');
  const icon = document.getElementById('oneshot-collapse-icon');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (icon) {
    icon.className = isOpen ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
  }
};

// Handle reference audio file selection
(function() {
  const fileInput = document.getElementById('ref-audio-file');
  if (!fileInput) return;
  fileInput.addEventListener('change', async function() {
    const file = this.files?.[0];
    if (!file) return;
    await uploadRefTrack(file, file.name);
  });

  // Drag-and-drop on the upload zone
  const zone = document.getElementById('ref-upload-zone');
  if (zone) {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--primary)'; });
    zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.style.borderColor = '';
      const file = e.dataTransfer?.files?.[0];
      if (file) await uploadRefTrack(file, file.name);
    });
  }
})();

async function uploadRefTrack(file, name) {
  // Check file size — warn if likely > 30s (rough estimate: 30s MP3 ≈ 720KB at 192kbps)
  const zone = document.getElementById('ref-upload-zone');
  const idle = document.getElementById('ref-upload-idle');
  const loading = document.getElementById('ref-upload-loading');
  const done = document.getElementById('ref-upload-done');
  const nameEl = document.getElementById('ref-upload-name');
  const modePanel = document.getElementById('ref-mode-panel');
  const clearBtn = document.getElementById('ref-clear-btn');

  if (loading) { idle.style.display = 'none'; loading.style.display = 'flex'; done.style.display = 'none'; }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload-reference', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      if (data.upgrade) {
        if (loading) loading.style.display = 'none';
        idle.style.display = 'flex';
        showUpgradeToast('Reference tracks require the Pro Artist plan.');
        return;
      }
      throw new Error(data.error || 'Upload failed');
    }

    refFileId = data.file_id;
    if (nameEl) nameEl.textContent = name.length > 28 ? name.slice(0, 25) + '...' : name;
    if (done) { loading.style.display = 'none'; done.style.display = 'flex'; }
    if (zone) zone.classList.add('has-file');
    if (modePanel) modePanel.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'block';
    if (typeof updateRefTabBadge === 'function') updateRefTabBadge();
    // Populate info strip
    _showRefInfoStrip({ serverDuration: data.duration, startTime: 0, audioDuration: null });
  } catch(err) {
    if (loading) loading.style.display = 'none';
    if (idle) idle.style.display = 'flex';
    // Show error inline instead of alert
    var errEl = document.getElementById('ref-upload-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.id = 'ref-upload-error';
      errEl.style.cssText = 'margin:8px 0 0;color:#ef4444;font-size:.78rem;text-align:center';
      if (zone && zone.parentNode) zone.parentNode.insertBefore(errEl, zone.nextSibling);
    }
    errEl.textContent = '\u26a0\ufe0f ' + (err.message || 'Upload failed — try again');
    setTimeout(function() { if (errEl) errEl.textContent = ''; }, 6000);
  }
}

// Show ref track info strip below the upload done state
function _showRefInfoStrip(opts) {
  var trackInfoEl = document.getElementById('ref-track-info');
  var durEl       = document.getElementById('ref-info-duration');
  var durValEl    = document.getElementById('ref-info-duration-val');
  var clipEl      = document.getElementById('ref-info-clip');
  var clipValEl   = document.getElementById('ref-info-clip-val');
  if (!trackInfoEl) return;

  var fmtTime = function(s) { return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'); };
  var shown = false;

  // Full file duration (from audio element or server)
  var totalDur = opts.audioDuration || opts.serverDuration;
  if (totalDur && totalDur > 0 && durEl && durValEl) {
    durValEl.textContent = fmtTime(totalDur) + ' total';
    durEl.style.display = '';
    shown = true;
  } else if (durEl) {
    durEl.style.display = 'none';
  }

  // Clip window used
  var startTime = opts.startTime || 0;
  if (clipEl && clipValEl) {
    var clipEnd = Math.min(startTime + 30, totalDur || startTime + 30);
    clipValEl.textContent = fmtTime(startTime) + ' – ' + fmtTime(clipEnd) + ' used';
    clipEl.style.display = '';
    shown = true;
  }

  trackInfoEl.style.display = shown ? 'flex' : 'none';
}

window.clearRefTrack = function() {
  refFileId = null;
  const zone = document.getElementById('ref-upload-zone');
  const idle = document.getElementById('ref-upload-idle');
  const done = document.getElementById('ref-upload-done');
  const modePanel = document.getElementById('ref-mode-panel');
  const clearBtn = document.getElementById('ref-clear-btn');
  const fileInput = document.getElementById('ref-audio-file');
  if (idle) idle.style.display = 'flex';
  if (done) done.style.display = 'none';
  var trackInfo = document.getElementById('ref-track-info');
  if (trackInfo) trackInfo.style.display = 'none';
  if (zone) zone.classList.remove('has-file');
  if (modePanel) modePanel.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'none';
  if (fileInput) fileInput.value = '';
  if (typeof updateRefTabBadge === 'function') updateRefTabBadge();
  // Close the dropdown if nothing is loaded
  var panel = document.getElementById('ref-inline-panel');
  var btn   = document.getElementById('ctab-reference');
  var chev  = document.getElementById('ctab-ref-chevron');
  if (panel) panel.style.display = 'none';
  if (btn)   btn.classList.remove('active');
  if (chev)  chev.style.transform = '';
};

window.selectRefMode = function(mode) {
  refMode = mode;
  document.querySelectorAll('.ref-mode-btn').forEach(b => {
    const isActive = b.dataset.mode === mode;
    b.classList.toggle('ref-mode-btn--active', isActive);
  });
};

// submitRefAndGenerate no longer needed — panel stays open, user hits main Create button

window.selectBarPreset = function(btn, bars) {
  refBars = bars;
  document.querySelectorAll('.ref-bar-btn').forEach(b => b.classList.remove('ref-bar-btn--active'));
  btn.classList.add('ref-bar-btn--active');
  const customInput = document.getElementById('ref-bar-custom');
  if (customInput) customInput.style.display = bars === 'custom' ? 'flex' : 'none';
};

// ── Song Extend popup ─────────────────────────────────────────────────────────
(function initSongExtend() {
  let extSelectedJob = null; // { id, title, meta, coverUrl, audioDuration }
  let extPoint = 'end'; // 'end' | 'half' | 'custom'

  // Load library tracks into the extend picker
  window._loadExtendLibrary = async function() {
    const list = document.getElementById('ext-track-list');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin" style="margin-bottom:8px;display:block;font-size:1.4rem"></i>Loading your library…</div>';
    try {
      const res = await fetch('/api/projects?tab=beats');
      const data = await res.json();
      const projects = data.projects || [];
      if (!projects.length) {
        list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:.85rem"><i class="fas fa-music" style="display:block;font-size:1.8rem;margin-bottom:8px;opacity:.4"></i>No completed tracks yet</div>';
        return;
      }
      list.innerHTML = '';
      projects.slice(0, 20).forEach(p => {
        const coverUrl = p.cover_url || '';
        const title = p.title || p.prompt || 'Untitled';
        const meta = [p.genre, p.bpm ? p.bpm + ' BPM' : null].filter(Boolean).join(' · ') || '';
        const card = document.createElement('div');
        card.className = 'ext-track-card';
        card.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface-2,rgba(255,255,255,.04));border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s ease';
        card.innerHTML = '<div style="width:38px;height:38px;border-radius:7px;background:var(--card-bg);flex-shrink:0;overflow:hidden">' +
          (coverUrl ? '<img src="'+coverUrl+'" style="width:100%;height:100%;object-fit:cover"/>' : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--primary);font-size:.9rem"><i class="fas fa-music"></i></div>') +
          '</div>' +
          '<div style="flex:1;min-width:0"><div style="font-size:.85rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+title+'</div>' +
          '<div style="font-size:.74rem;color:var(--muted)">'+meta+'</div></div>' +
          '<i class="fas fa-chevron-right" style="color:var(--muted);font-size:.75rem"></i>';
        card.onmouseenter = function() { this.style.borderColor = 'rgba(78,159,255,.5)'; this.style.background = 'rgba(78,159,255,.08)'; };
        card.onmouseleave = function() { this.style.borderColor = 'var(--border)'; this.style.background = 'var(--surface-2,rgba(255,255,255,.04))'; };
        card.onclick = function() {
          extSelectedJob = { id: p.id, title: title, meta: meta, coverUrl: coverUrl, audioDuration: p.duration_ms || 0 };
          extSelectTrack(extSelectedJob);
        };
        list.appendChild(card);
      });
    } catch(e) {
      list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:.85rem">Failed to load library</div>';
    }
  };

  function extSelectTrack(job) {
    const stepPick = document.getElementById('ext-step-pick');
    const stepOpts = document.getElementById('ext-step-options');
    const selTitle = document.getElementById('ext-sel-title');
    const selMeta = document.getElementById('ext-sel-meta');
    const selImg = document.getElementById('ext-sel-cover-img');
    const selIcon = document.getElementById('ext-sel-cover-icon');
    if (stepPick) stepPick.style.display = 'none';
    if (stepOpts) stepOpts.style.display = 'block';
    if (selTitle) selTitle.textContent = job.title;
    if (selMeta) selMeta.textContent = job.meta || 'No metadata';
    if (selImg && job.coverUrl) { selImg.src = job.coverUrl; selImg.style.display = 'block'; if(selIcon) selIcon.style.display = 'none'; }
    else { if(selImg) selImg.style.display = 'none'; if(selIcon) selIcon.style.display = 'flex'; }
    extPoint = 'end';
    document.querySelectorAll('[data-ext]').forEach(b => b.classList.toggle('ref-bar-btn--active', b.dataset.ext === 'end'));
    const customMs = document.getElementById('ext-custom-ms');
    if (customMs) customMs.style.display = 'none';
  }

  window.extResetPick = function() {
    window._extMode = 'instrumental';
    window.setExtMode && window.setExtMode('instrumental');
    window._extActiveTab = 'upload';
    _extLibLoaded = false; // Allow re-fetch next open
    // Reset tabs back to Upload (use extSwitchTab so loop panel is also hidden)
    var stepLib   = document.getElementById('ext-step-library');
    if (stepLib)   stepLib.style.display = 'none';
    // Restore submit btn to upload mode
    var submitBtn = document.getElementById('ext-submit-btn');
    if (submitBtn) { submitBtn.onclick = function() { window.submitSongExtendUpload(); }; }
    extSelectedJob = null;
    const stepPick = document.getElementById('ext-step-pick');
    const stepOpts = document.getElementById('ext-step-options');
    if (stepPick) stepPick.style.display = 'block';
    if (stepOpts) stepOpts.style.display = 'none';
  };

  window.selectExtPoint = function(btn, point) {
    extPoint = point;
    document.querySelectorAll('[data-ext]').forEach(b => b.classList.toggle('ref-bar-btn--active', b.dataset.ext === point));
    const customMs = document.getElementById('ext-custom-ms');
    if (customMs) customMs.style.display = point === 'custom' ? 'block' : 'none';
  };

  // ── Extend popup: Upload / Library tab switcher ─────────────────────────────
  window._extActiveTab = 'upload'; // 'upload' | 'library'

  window.extSwitchTab = function(tab) {
    window._extActiveTab = tab;
    var uploadBtn  = document.getElementById('ext-tab-upload');
    var libBtn     = document.getElementById('ext-tab-library');
    var loopBtn    = document.getElementById('ext-tab-loop');
    var stepPick   = document.getElementById('ext-step-pick');
    var stepLib    = document.getElementById('ext-step-library');
    var stepOpts   = document.getElementById('ext-step-options');
    var stepLoop   = document.getElementById('ext-step-loop');

    // Reset all tab styles
    var allBtns = [uploadBtn, libBtn, loopBtn];
    allBtns.forEach(function(b) {
      if (b) { b.style.borderBottom = '2px solid transparent'; b.style.color = 'var(--muted)'; b.style.fontWeight = '600'; }
    });
    // Hide all panels
    if (stepOpts) stepOpts.style.display = 'none';
    if (stepPick) stepPick.style.display = 'none';
    if (stepLib)  stepLib.style.display  = 'none';
    if (stepLoop) stepLoop.style.display = 'none';

    if (tab === 'upload') {
      if (uploadBtn) { uploadBtn.style.borderBottom = '2px solid var(--primary)'; uploadBtn.style.color = 'var(--primary)'; uploadBtn.style.fontWeight = '700'; }
      if (stepPick)  stepPick.style.display = 'block';
    } else if (tab === 'loop') {
      if (loopBtn) { loopBtn.style.borderBottom = '2px solid var(--primary)'; loopBtn.style.color = 'var(--primary)'; loopBtn.style.fontWeight = '700'; }
      if (stepLoop) stepLoop.style.display = 'block';
    } else {
      // library
      if (libBtn)    { libBtn.style.borderBottom = '2px solid var(--primary)'; libBtn.style.color = 'var(--primary)'; libBtn.style.fontWeight = '700'; }
      if (stepLib)   stepLib.style.display = 'block';
      extLoadLibraryPicker();
    }
  };

  // ── Load library beats into the picker ───────────────────────────────────────
  var _extLibLoaded = false;

  function extLoadLibraryPicker() {
    if (_extLibLoaded) return;
    var loadingEl = document.getElementById('ext-lib-loading');
    var listEl    = document.getElementById('ext-lib-list');
    var emptyEl   = document.getElementById('ext-lib-empty');
    if (!listEl) return;

    if (loadingEl) loadingEl.style.display = 'block';
    if (emptyEl)   emptyEl.style.display = 'none';
    listEl.innerHTML = '';

    fetch('/api/projects?tab=beats&limit=50')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _extLibLoaded = true;
        if (loadingEl) loadingEl.style.display = 'none';
        var projects = (d.projects || []).filter(function(p) { return p.stereo_url || (p.data && JSON.parse(p.data || '{}').stereo_url); });
        if (!projects.length) {
          if (emptyEl) emptyEl.style.display = 'block';
          return;
        }
        projects.forEach(function(p) {
          var data = {};
          try { data = JSON.parse(p.data || '{}'); } catch(e) {}
          var title    = p.title || data.prompt || p.id || 'Untitled Beat';
          var stereoUrl = p.stereo_url || data.stereo_url || '';
          var bpm      = data.bpm  ? data.bpm + ' BPM' : '';
          var genre    = data.genre || '';
          var meta     = [genre, bpm].filter(Boolean).join(' · ');
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;cursor:pointer;gap:10px;transition:border-color .15s';
          row.onmouseenter = function() { row.style.borderColor = 'var(--primary)'; };
          row.onmouseleave = function() { row.style.borderColor = 'var(--border)'; };
          row.innerHTML =
            '<div style="min-width:0;flex:1">' +
              '<div style="font-size:.84rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + title.replace(/</g,'&lt;') + '</div>' +
              (meta ? '<div style="font-size:.72rem;color:var(--muted);margin-top:2px">' + meta + '</div>' : '') +
            '</div>' +
            '<button style="background:rgba(78,159,255,.15);border:1px solid rgba(78,159,255,.3);border-radius:8px;padding:5px 14px;color:var(--primary);cursor:pointer;font-size:.8rem;font-weight:700;white-space:nowrap;flex-shrink:0">' +
              '<i class="fas fa-expand-arrows-alt" style="margin-right:5px"></i>Select' +
            '</button>';
          row.querySelector('button').onclick = function(e) {
            e.stopPropagation();
            extSelectLibraryBeat(p.id, title, stereoUrl);
          };
          row.onclick = function() { extSelectLibraryBeat(p.id, title, stereoUrl); };
          listEl.appendChild(row);
        });
      })
      .catch(function() {
        if (loadingEl) loadingEl.style.display = 'none';
        if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.innerHTML = '<i class="fas fa-exclamation-circle" style="font-size:2rem;opacity:.4;display:block;margin-bottom:10px"></i>Could not load library. Please try again.'; }
      });
  }

  // ── Select a beat from library → switch to scrubber/options step ─────────────
  function extSelectLibraryBeat(jobId, title, stereoUrl) {
    // Store the selected library job so submitSongExtend can use it
    extSelectedJob = { id: jobId, title: title, stereo_url: stereoUrl, audioDuration: 0 };

    var stepLib  = document.getElementById('ext-step-library');
    var stepOpts = document.getElementById('ext-step-options');
    var titleEl  = document.getElementById('ext-sel-title');
    var changeBtn = stepOpts && stepOpts.querySelector('button[onclick="extResetUpload()"]');

    // Hide library list, show options/scrubber
    if (stepLib)  stepLib.style.display = 'none';
    if (stepOpts) stepOpts.style.display = 'block';
    if (titleEl)  titleEl.textContent = title;

    // Update change button to go back to library tab
    if (changeBtn) {
      changeBtn.onclick = function() { extResetToLibrary(); };
    }

    // Update submit button to use library extend (not upload extend)
    var submitBtn = document.getElementById('ext-submit-btn');
    if (submitBtn) {
      submitBtn.onclick = function() { window.submitSongExtend(); };
    }

    // Load audio into scrubber if URL available
    if (stereoUrl) {
      var audio = document.getElementById('ext-preview-audio');
      if (audio) {
        audio.src = stereoUrl;
        audio.load();
        audio.onloadedmetadata = function() {
          extSelectedJob.audioDuration = Math.round(audio.duration * 1000);
          var durEl = document.getElementById('ext-duration-label');
          if (durEl) {
            var s = Math.round(audio.duration);
            durEl.textContent = Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
          }
          // Reset scrubber to "End of track" — call via window so we reach
          // the real extUpdateScrubberUI inside initExtendUpload (different IIFE scope)
          if (window.extUpdateScrubberUI) window.extUpdateScrubberUI(1.0);
          // Draw waveform after metadata loads and canvas has painted dimensions.
          // extDrawFlatWaveform lives in initExtendUpload (different IIFE) so call
          // via window. Double rAF ensures canvas offsetWidth/Height are non-zero.
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              if (window.extDrawFlatWaveform) window.extDrawFlatWaveform();
            });
          });
        };
      }
    }

    // Reset scrubber position
    var fill = document.getElementById('ext-scrubber-fill');
    var head = document.getElementById('ext-playhead');
    var badge = document.getElementById('ext-time-badge');
    if (fill)  fill.style.width = '0%';
    if (head)  head.style.left = '0%';
    if (badge) badge.textContent = 'End of track';
    if (window.extExtendAtMs !== undefined) window.extExtendAtMs = 0;
    if (window.extAudioDuration !== undefined) window.extAudioDuration = 0;
  }

  // ── Reset from library-selected back to library tab ──────────────────────────
  function extResetToLibrary() {
    extSelectedJob = null;
    var stepOpts = document.getElementById('ext-step-options');
    var stepLib  = document.getElementById('ext-step-library');
    if (stepOpts) stepOpts.style.display = 'none';
    if (stepLib)  stepLib.style.display = 'block';
    // Restore submit btn to upload mode
    var submitBtn = document.getElementById('ext-submit-btn');
    if (submitBtn) submitBtn.onclick = function() { window.submitSongExtendUpload(); };
  }

  // Expose for external callers
  window.extSwitchTab = window.extSwitchTab;

  // Extend popup: vocal mode toggle state
  // 'instrumental' = make_instrumental:true; 'vocal' = continuation with lyrics
  window._extMode = 'instrumental'; // default: instrumental

  window.setExtMode = function(mode) {
    window._extMode = mode;
    var instrBtn = document.getElementById('ext-mode-instr-btn');
    var vocalBtn = document.getElementById('ext-mode-vocal-btn');
    var lyricsSection = document.getElementById('ext-lyrics-section');
    if (instrBtn) instrBtn.classList.toggle('beat-count-btn--active', mode === 'instrumental');
    if (vocalBtn) vocalBtn.classList.toggle('beat-count-btn--active', mode === 'vocal');
    // Show lyrics textarea only in vocal mode
    if (lyricsSection) lyricsSection.style.display = mode === 'vocal' ? 'block' : 'none';
  };

  // Legacy alias (in case old code calls setExtVocalMode)
  window.setExtVocalMode = window.setExtMode;

  window.submitSongExtend = async function() {
    if (!extSelectedJob) return;
    const status = document.getElementById('ext-submit-status');
    const btn = document.getElementById('ext-submit-btn');
    const lyrics = (document.getElementById('ext-lyrics') || {}).value || '';

    let extendAt = 0;
    if (extPoint === 'end') {
      extendAt = extSelectedJob.audioDuration || 0;
    } else if (extPoint === 'half') {
      extendAt = Math.floor((extSelectedJob.audioDuration || 0) / 2);
    } else {
      extendAt = parseInt((document.getElementById('ext-custom-ms-val') || {}).value || '0', 10);
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extending…'; }
    if (status) { status.style.display = 'block'; var _stxt2 = document.getElementById('ext-submit-status-text'); if (_stxt2) _stxt2.textContent = 'Stemforge is forging your track…'; }

    try {
      const isInstr = (window._extMode !== 'vocal');
      const res = await fetch('/api/job/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_job_id: extSelectedJob.id, extend_at: extendAt, lyrics: isInstr ? '' : lyrics, make_instrumental: isInstr })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (status) { var _stxt3 = document.getElementById('ext-submit-status-text'); if (_stxt3) _stxt3.textContent = 'Extend job started! Check your library.'; }
      // Close popup after short delay
      setTimeout(() => {
        closeCreatorPopup('extend');
        window.extResetPick();
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> Extend Track'; }
        if (status) { status.style.display = 'none'; }
        // Navigate to library to see result
        if (window.navigate) window.navigate('library');
      }, 1800);
    } catch(e) {
      if (status) { status.style.display = 'block'; var _stxtE = document.getElementById('ext-submit-status-text'); if (_stxtE) { _stxtE.textContent = 'Error: ' + (e.message || 'Unknown error'); _stxtE.style.color = '#f87171'; } }
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> Extend Track'; }
    }
  };

  // Hook into openCreatorPopup to load library when extend popup is opened
  const _origOpenCreatorPopup = window.openCreatorPopup;
  window.openCreatorPopup = function(type) {
    if (_origOpenCreatorPopup) _origOpenCreatorPopup(type);
    if (type === 'extend') {
      window.extResetPick && window.extResetPick();
      // Read and consume the pending job ID (set by ?extend=JOBID URL param)
      const targetJobId = window._extendFromJobId || null;
      window._extendFromJobId = null; // consume it

      if (targetJobId) {
        // Switch to Library tab and show a loading state while we fetch the job
        extSwitchTabInternal('library');
        var loadingEl = document.getElementById('ext-lib-loading');
        var listEl    = document.getElementById('ext-lib-list');
        var emptyEl   = document.getElementById('ext-lib-empty');
        if (loadingEl) { loadingEl.style.display = 'block'; loadingEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Loading track…'; }
        if (listEl)    listEl.innerHTML = '';
        if (emptyEl)   emptyEl.style.display = 'none';

        // Fetch the specific job, then auto-select it into the scrubber
        (async function() {
          try {
            const res = await fetch('/api/job/' + targetJobId);
            const job = await res.json();
            if (job && !job.error) {
              const title     = job.title || job.prompt || 'Untitled';
              const genre     = (job.blueprint && job.blueprint.genre) ? job.blueprint.genre : '';
              const bpm       = (job.blueprint && job.blueprint.bpm)   ? job.blueprint.bpm + ' BPM' : '';
              const meta      = [genre, bpm].filter(Boolean).join(' · ');
              const stereoUrl = job.stereo_url || '';
              // Use extSelectLibraryBeat — works with the current DOM (ext-step-library → ext-step-options)
              if (loadingEl) loadingEl.style.display = 'none';
              extSelectLibraryBeat(job.id, title, stereoUrl);
              return;
            }
          } catch(e) {}
          // Fallback: load full library list
          if (loadingEl) loadingEl.style.display = 'none';
          _extLibLoaded = false; // force reload
          extLoadLibraryPicker();
        })();
      } else {
        extLoadLibraryPicker();
      }
    }
  };

  // Internal tab switcher (no side-effects like loading library)
  function extSwitchTabInternal(tab) {
    var tabUpload  = document.getElementById('ext-tab-upload');
    var tabLibrary = document.getElementById('ext-tab-library');
    var stepPick   = document.getElementById('ext-step-pick');
    var stepLib    = document.getElementById('ext-step-library');
    if (tab === 'library') {
      if (tabUpload)  { tabUpload.style.borderBottom  = '2px solid transparent'; tabUpload.style.color  = 'var(--muted)'; tabUpload.style.fontWeight = '600'; }
      if (tabLibrary) { tabLibrary.style.borderBottom = '2px solid var(--primary)'; tabLibrary.style.color = 'var(--primary)'; tabLibrary.style.fontWeight = '700'; }
      if (stepPick) stepPick.style.display = 'none';
      if (stepLib)  stepLib.style.display  = 'block';
    } else {
      if (tabUpload)  { tabUpload.style.borderBottom  = '2px solid var(--primary)'; tabUpload.style.color  = 'var(--primary)'; tabUpload.style.fontWeight = '700'; }
      if (tabLibrary) { tabLibrary.style.borderBottom = '2px solid transparent'; tabLibrary.style.color = 'var(--muted)'; tabLibrary.style.fontWeight = '600'; }
      if (stepPick) stepPick.style.display = 'block';
      if (stepLib)  stepLib.style.display  = 'none';
    }
  }
})();

// Override getInputs to inject reference_file_id into the generate payload
// We patch the startGeneration fetch call via a global variable
(function patchStartGenerationForRef() {
  // We'll inject refFileId into the fetch body inside startGeneration
  // by hooking into the existing startGeneration function via a window override
  const _originalFetch = window.fetch;
  // We don't override fetch globally — instead we rely on the app reading window._refFileId
  // and window._refMode at generate time
})();

// Update the "ON" badge on the Reference tab button
function updateRefTabBadge() {
  var badge = document.getElementById('ctab-ref-badge');
  if (!badge) return;
  badge.style.display = refFileId ? 'inline' : 'none';
}
window.updateRefTabBadge = updateRefTabBadge;

// Expose ref info so startGeneration can read it
Object.defineProperty(window, '_refFileId', { get: () => refFileId });
Object.defineProperty(window, '_refMode', { get: () => refMode });
Object.defineProperty(window, '_refPrompt', { get: () => {
  // Use the main prompt/lyrics field — whatever the user typed there
  const prompt = document.getElementById('gen-prompt');
  if (prompt && prompt.value.trim()) return prompt.value.trim();
  const lyrics = document.getElementById('gen-lyrics');
  if (lyrics && lyrics.value.trim()) return lyrics.value.trim();
  return '';
}});
Object.defineProperty(window, '_refBars', { get: () => {
  if (refBars === 'custom') {
    return parseInt(document.getElementById('ref-bar-custom-val')?.value || '16') || 16;
  }
  return refBars;
}});

function showUpgradeToast(msg) {
  let t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e1e3a;border:1px solid rgba(167,139,250,.4);color:#a78bfa;padding:12px 20px;border-radius:10px;font-size:.88rem;font-weight:600;z-index:9999;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  t.innerHTML = `<i class="fas fa-crown"></i> ${msg} <a href="/pricing" style="color:#fff;text-decoration:underline;margin-left:8px">Upgrade</a>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ═══════════════════════════════════════════════════════════
//  ONE SHOT CREATOR — ElevenLabs SFX (all plans, 5 pts)
// ═══════════════════════════════════════════════════════════

var _oneshotSfxSelectedType = 'kick drum';

window.selectOneshotSfxType = function(btn) {
  _oneshotSfxSelectedType = btn.dataset.sound || 'kick drum';
  document.querySelectorAll('.oneshot-type-btn').forEach(b => b.classList.remove('oneshot-type-btn--active'));
  btn.classList.add('oneshot-type-btn--active');
  // Pre-fill description textarea with the chosen type as a hint
  const desc = document.getElementById('oneshot-sfx-desc');
  if (desc && !desc.value.trim()) {
    const hints = {
      'kick drum':       'deep punchy kick drum, sub bass rumble, tight attack',
      'snare drum':      'cracking snare with crisp attack and short snappy tail',
      'hi-hat':          'tight closed hi-hat, crisp metallic sheen',
      '808 bass hit':    'deep 808 bass hit with heavy sub, long pitched tail',
      'clap':            'sharp studio clap, layered crack and slap',
      'crash cymbal':    'wide crash cymbal wash, bright metallic shimmer',
      'percussion hit':  'dry percussive hit, wooden or metallic texture',
      'fx riser':        'sweeping fx riser building tension, whoosh and swell'
    };
    if (hints[_oneshotSfxSelectedType]) desc.value = hints[_oneshotSfxSelectedType];
  }
};

// Legacy alias — kept so any old references don't throw
window.selectOneshotType = window.selectOneshotSfxType;

window.generateOneshotSfx = async function() {
  // Pro Artist only gate
  const _plan = (window._sfUser && window._sfUser.plan) || 'free';
  if (_plan !== 'pro' && _plan !== 'developer') {
    if (typeof showUpgradeToast === 'function') {
      showUpgradeToast('One Shot Creator is a Pro Artist feature. Upgrade to unlock.');
    } else {
      alert('One Shot Creator requires the Pro Artist plan. Upgrade to unlock.');
    }
    return;
  }

  const btn = document.getElementById('oneshot-sfx-gen-btn');
  const statusEl = document.getElementById('oneshot-sfx-status');
  const statusMsg = document.getElementById('oneshot-sfx-status-msg');
  const resultEl = document.getElementById('oneshot-sfx-result');

  const description = document.getElementById('oneshot-sfx-desc')?.value?.trim() || '';

  if (!description) {
    const descEl = document.getElementById('oneshot-sfx-desc');
    if (descEl) {
      descEl.focus();
      descEl.style.borderColor = 'var(--danger,#ef4444)';
      setTimeout(() => { descEl.style.borderColor = ''; }, 2000);
    }
    alert('Please describe the sound you want to generate.');
    return;
  }

  // Read duration slider — slider value × 0.5 = seconds (range 0.5s–8s, default 3.0s)
  const durSlider = document.getElementById('oneshot-sfx-duration');
  const durVal = durSlider ? parseInt(durSlider.value, 10) : 6;
  const durationSeconds = durVal > 0 ? durVal * 0.5 : 3.0;

  const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> Generate One Shot <span style="opacity:.7;font-size:.8rem;font-weight:400">(10 pts)</span>'; } };

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…'; }
  if (statusEl) statusEl.style.display = 'block';
  if (statusMsg) statusMsg.textContent = 'StemForge is crafting your sound…';
  if (resultEl) resultEl.style.display = 'none';

  try {
    const payload = { prompt: description, duration_seconds: durationSeconds };
    const res = await fetch('/api/generate-oneshot-sfx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      resetBtn();
      if (statusEl) statusEl.style.display = 'none';
      if (data.upgrade) {
        if (typeof showUpgradeToast === 'function') showUpgradeToast('One Shot Creator requires the Pro Artist plan.');
        else alert('One Shot Creator requires the Pro Artist plan.');
      } else if (data.limit_reached) {
        alert('Not enough points. ' + (data.error || ''));
      } else {
        alert('Error: ' + (data.error || 'Generation failed'));
      }
      return;
    }

    resetBtn();
    if (statusEl) statusEl.style.display = 'none';

    // Backend returns base64-encoded MP3 bytes — build a data URI for instant playback
    const dataUri = 'data:audio/mpeg;base64,' + data.audio_b64;
    const displayTitle = data.title || description;
    const safeName = displayTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50) || 'oneshot';

    const audio = document.getElementById('oneshot-sfx-audio');
    const titleEl = document.getElementById('oneshot-sfx-result-title');
    const dlMp3 = document.getElementById('oneshot-sfx-dl-mp3');

    if (audio) {
      audio.src = dataUri;
      audio.load();
      audio.play().catch(() => {});
    }
    if (titleEl) titleEl.textContent = displayTitle.charAt(0).toUpperCase() + displayTitle.slice(1) + ' — Ready';
    if (dlMp3) { dlMp3.href = dataUri; dlMp3.setAttribute('download', safeName + '.mp3'); }
    if (resultEl) resultEl.style.display = 'block';

    // Invalidate oneshots library tab cache so new shot appears
    if (window._libLoaded) window._libLoaded.oneshots = false;

    // Refresh sidebar points
    fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(({ user }) => {
      if (!user) return;
      if (window._sfUser) { window._sfUser.gens_used = user.gens_used; window._sfUser.gens_limit = user.gens_limit; window._sfUser.bonus_credits = user.bonus_credits || 0; }
      const gv = document.getElementById('gs-gens-val');
      const gb = document.getElementById('gs-gens-bar');
      const cl = document.getElementById('gs-credits-label');
      const limitMap = { free: 60, creator: 800, pro: 2000 };
      const displayLimit = user.gens_limit || limitMap[user.plan] || 3;
      const remaining = Math.max(0, displayLimit - user.gens_used);
      if (cl) cl.textContent = 'Points Remaining';
      if (gv) gv.innerHTML = `${remaining} <small>/ ${displayLimit}</small>`;
      if (gb) { const pct = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0; gb.style.width = pct + '%'; }
      window._sfUpdateSidebarBonus(user.bonus_credits || 0);
    }).catch(() => {});

  } catch(err) {
    resetBtn();
    if (statusEl) statusEl.style.display = 'none';
    alert('Network error: ' + err.message);
  }
};

// ═══════════════════════════════════════════════════════════
//  Patch startGeneration to send reference_file_id
// ═══════════════════════════════════════════════════════════
// We intercept the fetch('/api/generate',...) call by overriding window.fetch
// ONLY for that specific path, injecting refFileId and ref mode data.
(function patchFetchForRef() {
  const _orig = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url === '/api/generate' && init?.method === 'POST' && init?.body) {
      try {
        const body = JSON.parse(init.body);
        if (window._refFileId) {
          body.reference_file_id = window._refFileId;
          body.ref_mode = window._refMode || 'style';
          if (window._refPrompt) body.ref_prompt = window._refPrompt;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {}
    }
    return _orig(input, init);
  };
})();

// ═══════════════════════════════════════════════════════════
//  NEW FEATURE JS — Tasks 8, 11, 12, 13, 15, 16
// ═══════════════════════════════════════════════════════════

// ── Vocal gender toggle (Male / Off / Female) ──────────────
window._vocalGender = 'off';
window.setVocalToggle = function(val) {
  window._vocalGender = val;
  ['male','off','female'].forEach(v => {
    const btn = document.getElementById('vt-' + v);
    if (!btn) return;
    btn.classList.toggle('vocal-toggle-btn--active', v === val);
  });
};

// ── Duration picker ──────────────────────────────────────────
window._userDuration = 0; // 0 = Auto
window.setDuration = function(sec) {
  window._userDuration = sec;
  document.querySelectorAll('#duration-btn-group .beat-count-btn').forEach(btn => {
    btn.classList.toggle('beat-count-btn--active', parseInt(btn.dataset.dur||'0') === sec);
  });
};
// Set Auto as default active
window.addEventListener('DOMContentLoaded', () => {
  const autoBtn = document.getElementById('dur-auto');
  if (autoBtn) autoBtn.classList.add('beat-count-btn--active');
});

// ── Auto-open Song Extend popup when arriving at /generator?extend=JOBID ──────
(function handleExtendQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const extJobId = params.get('extend');
  if (!extJobId) return;

  // Only run on the generator page
  if (!window.location.pathname.includes('/generator')) return;

  // Clean the URL so a reload doesn't re-trigger
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);

  // Store the job ID so the extend popup can pick it up
  window._extendFromJobId = extJobId;

  // Wait for the page (including IIFEs) to be fully ready, then open the popup
  function tryOpen(attemptsLeft) {
    if (window.openCreatorPopup && document.getElementById('creator-popup-extend')) {
      window.openCreatorPopup('extend');
    } else if (attemptsLeft > 0) {
      setTimeout(() => tryOpen(attemptsLeft - 1), 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => tryOpen(15), 300));
  } else {
    setTimeout(() => tryOpen(15), 300);
  }
})();

// ── Delete account modal handlers ─────────────────────────
window.showDeleteAccountModal = function() {
  const m = document.getElementById('delete-account-modal');
  if (m) { m.style.display = 'flex'; }
};
window.closeDeleteAccountModal = function() {
  const m = document.getElementById('delete-account-modal');
  if (m) { m.style.display = 'none'; }
};
window.confirmDeleteAccount = async function() {
  const inp = document.getElementById('delete-confirm-input');
  const errEl = document.getElementById('delete-account-error');
  const btn = document.getElementById('delete-account-confirm-btn');
  if (!inp || inp.value.trim() !== 'DELETE') {
    if (errEl) { errEl.textContent = 'Please type DELETE in all caps to confirm.'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...'; }
  try {
    const r = await fetch('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm_text: 'DELETE' })
    });
    const data = await r.json();
    if (data.ok) { window.location.href = '/?deleted=1'; }
    else {
      if (errEl) { errEl.textContent = data.error || 'Deletion failed. Try again.'; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete Forever'; }
    }
  } catch(e) {
    if (errEl) { errEl.textContent = 'Network error. Please try again.'; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete Forever'; }
  }
};

// ── Pending subscription indicator (downgrade + upgrade) ───
(function initPendingSubIndicator() {
  const pendingDowngrade = sessionStorage.getItem('sf_pending_downgrade');
  const pendingUpgrade   = sessionStorage.getItem('sf_pending_upgrade');

  function showDowngradeBanner(target) {
    // Possible downgrade banner IDs: sub-free-downgrade-banner, sub-creator-downgrade-banner
    const banner    = document.getElementById('sub-' + target + '-downgrade-banner') ||
                      document.getElementById('sub-creator-downgrade-banner'); // creator-on-creator uses same banner
    const cancelBtn = document.getElementById('sub-btn-cancel-downgrade-' + target);
    // Main downgrade button (may have different IDs depending on current plan)
    const dlBtn     = document.getElementById('sub-btn-downgrade-to-' + target) ||
                      document.getElementById('sub-btn-downgrade-to-' + target + '-from-creator');
    if (banner)    banner.style.display = 'flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (dlBtn)     dlBtn.style.display = 'none';
  }

  function showUpgradeBanner(target) {
    const banner    = document.getElementById('sub-' + target + '-upgrade-banner');
    const cancelBtn = document.getElementById('sub-btn-cancel-upgrade-' + target);
    const upBtn     = document.getElementById('sub-btn-upgrade-to-' + target);
    if (banner)    banner.style.display = 'flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (upBtn)     upBtn.style.display = 'none';
  }

  if (pendingDowngrade === 'creator') showDowngradeBanner('creator');
  if (pendingDowngrade === 'free')    showDowngradeBanner('free');
  if (pendingUpgrade === 'creator')   showUpgradeBanner('creator');
  if (pendingUpgrade === 'pro')       showUpgradeBanner('pro');
})();

// ── Cancel a scheduled downgrade ───────────────────────────
window.cancelDowngrade = async function(targetOverride) {
  const target = targetOverride || sessionStorage.getItem('sf_pending_downgrade') || 'creator';
  const cancelBtn = document.getElementById('sub-btn-cancel-downgrade-' + target);
  if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling…'; }

  try {
    const res = await fetch('/api/subscription/cancel-downgrade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');

    sessionStorage.removeItem('sf_pending_downgrade');

    // Hide banner, hide cancel btn, restore the downgrade btn
    const banner = document.getElementById('sub-' + target + '-downgrade-banner') ||
                   document.getElementById('sub-creator-downgrade-banner');
    const dlBtn  = document.getElementById('sub-btn-downgrade-to-' + target) ||
                   document.getElementById('sub-btn-downgrade-to-' + target + '-from-creator');
    if (banner)    banner.style.display = 'none';
    if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.disabled = false; }
    if (dlBtn)     dlBtn.style.display = 'inline-flex';

    showSubToast('<i class="fas fa-check"></i> ' + (data.message || 'Downgrade cancelled — your plan continues as normal'), '#10b981', 'rgba(16,185,129,.4)');
  } catch(e) {
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '<i class="fas fa-undo"></i> Cancel Downgrade'; }
    alert('Could not cancel downgrade: ' + (e.message || 'Please contact stemforgesupport@gmail.com'));
  }
};

// ── Cancel a scheduled upgrade ──────────────────────────────
window.cancelUpgrade = async function(targetOverride) {
  const target = targetOverride || sessionStorage.getItem('sf_pending_upgrade') || 'pro';
  const cancelBtn = document.getElementById('sub-btn-cancel-upgrade-' + target);
  if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling…'; }

  try {
    const res = await fetch('/api/subscription/cancel-upgrade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');

    sessionStorage.removeItem('sf_pending_upgrade');

    // Hide banner, hide cancel btn, restore the upgrade btn
    const banner = document.getElementById('sub-' + target + '-upgrade-banner');
    const upBtn  = document.getElementById('sub-btn-upgrade-to-' + target);
    if (banner)    banner.style.display = 'none';
    if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.disabled = false; }
    if (upBtn)     upBtn.style.display = 'inline-flex';

    showSubToast('<i class="fas fa-check"></i> ' + (data.message || 'Upgrade cancelled — your current plan continues'), '#10b981', 'rgba(16,185,129,.4)');
  } catch(e) {
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '<i class="fas fa-undo"></i> Cancel Upgrade'; }
    alert('Could not cancel upgrade: ' + (e.message || 'Please contact stemforgesupport@gmail.com'));
  }
};

// ── Shared toast helper ─────────────────────────────────────
function showSubToast(html, bg, shadow) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:' + bg + ';color:#fff;padding:12px 20px;border-radius:10px;font-weight:600;z-index:99999;box-shadow:0 4px 20px ' + shadow;
  toast.innerHTML = html;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

// ── Credits exhausted alert ───────────────────────────────────
function showCreditsExhaustedAlert() {
  const existing = document.getElementById('sf-credits-exhausted-modal');
  if (existing) { existing.style.display = 'flex'; return; }
  const plan = (window._sfUser && window._sfUser.plan) || 'free';
  const isFree = plan === 'free';
  const modal = document.createElement('div');
  modal.id = 'sf-credits-exhausted-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);backdrop-filter:blur(6px)';
  modal.innerHTML = `
    <div style="background:var(--surface,#1a1a2e);border:1px solid rgba(234,179,8,.35);border-radius:20px;padding:36px 32px;max-width:420px;width:90%;text-align:center;position:relative;box-shadow:0 0 40px rgba(234,179,8,.12)">
      <button onclick="document.getElementById('sf-credits-exhausted-modal').style.display='none'" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted,#888);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>
      <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#eab308,#f97316);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.3rem;color:#fff">
        <i class="fas fa-bolt"></i>
      </div>
      <h3 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;color:var(--text,#fff)">Out of generation points</h3>
      <p style="color:var(--muted,#aaa);font-size:.9rem;margin-bottom:24px;line-height:1.5">
        You've used all your points for this billing cycle.<br>
        ${isFree ? 'Upgrade to a paid plan for more points.' : 'Buy a credit pack to keep creating now, or wait for your cycle to reset.'}
      </p>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${!isFree ? `<a href="/subscription#credits" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#eab308,#f97316);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-bolt"></i> Buy Credits</a>` : ''}
        ${isFree ? `<a href="/pricing?plan=creator" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-crown"></i> Upgrade Plan</a>` : ''}
        <button onclick="document.getElementById('sf-credits-exhausted-modal').style.display='none'" style="padding:11px 24px;background:rgba(255,255,255,.07);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:12px;font-weight:600;cursor:pointer;font-size:.9rem">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
}

// ── Shared WAV download helper (with download-cap error handling) ──
async function doWavDownload(jobId, filename) {
  try {
    const res = await fetch('/api/download-wav/' + jobId);
    if (!res.ok) {
      let errData = {};
      try { errData = await res.json(); } catch {}
      // Generic error toast
      showSubToast('<i class="fas fa-exclamation-triangle"></i> Download failed: ' + (errData.error || 'Please try again'), '#ef4444', 'rgba(239,68,68,.4)');
      return;
    }
    // Stream the blob and trigger browser download
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (filename || 'stemforge_beat') + '.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    showSubToast('<i class="fas fa-exclamation-triangle"></i> Download failed: network error', '#ef4444', 'rgba(239,68,68,.4)');
  }
}

// Mark downgrade as pending when user confirms it (subscription page modal)
document.addEventListener('click', function(e) {
  const confirmBtn = e.target.closest('#sub-downgrade-confirm');
  if (!confirmBtn) return;
  const modal = document.getElementById('sub-downgrade-modal');
  const targetPlan = modal && modal._targetPlan;
  if (targetPlan === 'creator' || targetPlan === 'free') {
    sessionStorage.setItem('sf_pending_downgrade', targetPlan);
  }
});

// ── Clip picker: update timestamp + window overlay ─────────
window.updateClipPicker = function(val) {
  const audio = document.getElementById('ref-preview-audio');
  const tsEl = document.getElementById('ref-clip-timestamp');
  const windowEl = document.getElementById('ref-clip-window');
  if (!audio || !audio.duration) return;
  const dur = audio.duration;
  const startSec = (val / 100) * Math.max(0, dur - 30);
  const endSec = Math.min(dur, startSec + 30);
  const fmt = s => Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
  if (tsEl) tsEl.textContent = fmt(startSec) + ' – ' + fmt(endSec);
  // Position the blue rectangle to start exactly where the knob is
  if (windowEl) {
    const clipFrac = Math.min(1, 30 / dur);
    const startFrac = startSec / dur;
    windowEl.style.left = (startFrac * 100) + '%';
    windowEl.style.width = (clipFrac * 100) + '%';
  }
  // Seek audio to the clip start position so playback starts from the knob
  try {
    if (!audio.paused) {
      audio.currentTime = startSec;
    } else {
      audio.currentTime = startSec;
    }
  } catch(e) {}
  window._refClipStart = startSec;
};

window.uploadRefWithClip = async function() {
  const fileInput = document.getElementById('ref-audio-file');
  if (!fileInput || !fileInput.files[0]) return;
  const file = fileInput.files[0];
  const startTime = window._refClipStart || 0;

  // ── Duplicate check ──────────────────────────────────────────
  try {
    const dupRes = await fetch('/api/check-duplicate-upload?filename=' + encodeURIComponent(file.name));
    if (dupRes.ok) {
      const dupData = await dupRes.json();
      if (dupData.exists && dupData.upload) {
        const choice = await showDuplicateUploadModal(file.name, dupData.upload);
        if (choice === 'use_existing') {
          const existingUpload = dupData.upload;
          refFileId = existingUpload.file_id;
          document.getElementById('ref-clip-picker').style.display = 'none';
          const nameEl = document.getElementById('ref-upload-name');
          if (nameEl) nameEl.textContent = file.name.length > 28 ? file.name.slice(0,25)+'...' : file.name;
          const idle2 = document.getElementById('ref-upload-idle');
          const loading2 = document.getElementById('ref-upload-loading');
          const done2 = document.getElementById('ref-upload-done');
          if (idle2) idle2.style.display = 'none';
          if (loading2) loading2.style.display = 'none';
          if (done2) done2.style.display = 'flex';
          const zone2 = document.getElementById('ref-upload-zone');
          if (zone2) { zone2.classList.add('has-file'); zone2.onclick = null; }
          const modePanel2 = document.getElementById('ref-mode-panel');
          if (modePanel2) modePanel2.style.display = 'block';
          const clearBtn2 = document.getElementById('ref-clear-btn');
          if (clearBtn2) clearBtn2.style.display = 'block';
          if (typeof updateRefTabBadge === 'function') updateRefTabBadge();
          // Fetch cached analysis and display
          try {
            const upRow = await fetch('/api/reference-uploads').then(r => r.json());
            const found = (upRow.uploads || []).find(u => u.file_id === existingUpload.file_id);
            if (found && found.analysis) {
              renderAnalysisPanel(found.analysis);
            } else {
              startAnalysis(existingUpload.file_id, file.name, null);
            }
          } catch { startAnalysis(existingUpload.file_id, file.name, null); }
          return;
        }
        if (choice === 'cancel') return;
        // choice === 'overwrite' — continue with normal upload
      }
    }
  } catch {}

  // ── Normal upload flow ────────────────────────────────────────
  document.getElementById('ref-clip-picker').style.display = 'none';
  const idle = document.getElementById('ref-upload-idle');
  const loading = document.getElementById('ref-upload-loading');
  const done = document.getElementById('ref-upload-done');
  const nameEl = document.getElementById('ref-upload-name');
  const clipInfo = document.getElementById('ref-clip-info');
  const modePanel = document.getElementById('ref-mode-panel');
  const clearBtn = document.getElementById('ref-clear-btn');
  const zone = document.getElementById('ref-upload-zone');
  if (idle) idle.style.display = 'none';
  if (loading) loading.style.display = 'flex';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('start_time', String(Math.round(startTime)));
  try {
    const res = await fetch('/api/upload-reference', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    refFileId = data.file_id;  // use shared var (window._refFileId getter reads this)
    if (nameEl) nameEl.textContent = file.name.length > 28 ? file.name.slice(0,25)+'...' : file.name;
    const fmt = s => Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
    if (clipInfo) clipInfo.textContent = 'Clip: ' + fmt(startTime) + ' \u2013 ' + fmt(startTime+30) + ' used';
    if (done) { loading.style.display = 'none'; done.style.display = 'flex'; }
    if (zone) { zone.classList.add('has-file'); zone.onclick = null; }
    if (modePanel) modePanel.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'block';
    if (typeof updateRefTabBadge === 'function') updateRefTabBadge();
    // Populate info strip
    var audioEl = document.getElementById('ref-preview-audio');
    var audioDur = (audioEl && audioEl.duration && !isNaN(audioEl.duration)) ? audioEl.duration : null;
    _showRefInfoStrip({ serverDuration: data.duration, startTime: startTime, audioDuration: audioDur });
    // Start track analysis
    startAnalysis(data.file_id, file.name, data.duration);
    // Save to uploads DB
    saveReferenceUpload(data.file_id, file.name, data.duration, null);
  } catch(err) {
    if (loading) loading.style.display = 'none';
    if (idle) idle.style.display = 'flex';
    var errEl = document.getElementById('ref-upload-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.id = 'ref-upload-error';
      errEl.style.cssText = 'margin:8px 0 0;color:#ef4444;font-size:.78rem;text-align:center';
      var z2 = document.getElementById('ref-upload-zone');
      if (z2 && z2.parentNode) z2.parentNode.insertBefore(errEl, z2.nextSibling);
    }
    errEl.textContent = '\u26a0\ufe0f ' + (err.message || 'Upload failed \u2014 try again');
    setTimeout(function() { if (errEl) errEl.textContent = ''; }, 6000);
  }
};

// Override file input change to show clip picker for larger/WAV files
(function patchRefFileInputForClipPicker() {
  const fileInput = document.getElementById('ref-audio-file');
  if (!fileInput) return;
  fileInput.addEventListener('change', function(e) {
    e.stopImmediatePropagation();
    const file = this.files?.[0];
    if (!file) return;
    // Show clip picker for WAV or files > 500KB (likely full track)
    // Always show clip picker so user can choose which 30 seconds to use
    const preview = document.getElementById('ref-preview-audio');
    if (preview) {
      preview.src = URL.createObjectURL(file);
      preview.load();
      preview.onloadedmetadata = function() {
        const clipPicker = document.getElementById('ref-clip-picker');
        if (clipPicker) clipPicker.style.display = 'block';
        window._refClipStart = 0;
        updateClipPicker(0);
      };
    }
  }, true);
})();

// ══ Duplicate upload modal ══════════════════════════════════════════════════
function showDuplicateUploadModal(filename, existing) {
  return new Promise((resolve) => {
    const existingModal = document.getElementById('dup-upload-modal');
    if (existingModal) existingModal.remove();
    const dateStr = existing.created_at ? new Date(existing.created_at).toLocaleDateString() : '';
    const modal = document.createElement('div');
    modal.id = 'dup-upload-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);backdrop-filter:blur(6px)';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:32px 28px;max-width:400px;width:90%;text-align:center;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.4)">
        <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,rgba(245,158,11,.25),rgba(245,158,11,.1));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:1.4rem;color:#f59e0b"><i class="fas fa-exclamation-triangle"></i></div>
        <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:8px">File already uploaded</h3>
        <p style="color:var(--muted);font-size:.85rem;margin-bottom:6px"><strong style="color:var(--text)">${filename.length > 36 ? filename.slice(0,33)+'...' : filename}</strong></p>
        <p style="color:var(--muted);font-size:.8rem;margin-bottom:24px">You uploaded this file on <strong>${dateStr || 'a previous date'}</strong>. What would you like to do?</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button id="dup-use-existing" style="width:100%;padding:12px;background:linear-gradient(135deg,var(--primary),#8b5cf6);color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:.9rem">
            <i class="fas fa-check-circle" style="margin-right:6px"></i>Use Existing Upload
          </button>
          <button id="dup-overwrite" style="width:100%;padding:12px;background:var(--surface-2,rgba(255,255,255,.06));color:var(--text);border:1px solid var(--border);border-radius:10px;font-weight:600;cursor:pointer;font-size:.9rem">
            <i class="fas fa-upload" style="margin-right:6px"></i>Overwrite with New File
          </button>
          <button id="dup-cancel" style="width:100%;padding:8px;background:none;color:var(--muted);border:none;cursor:pointer;font-size:.82rem">
            Cancel
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#dup-use-existing').onclick = () => { modal.remove(); resolve('use_existing'); };
    modal.querySelector('#dup-overwrite').onclick = () => { modal.remove(); resolve('overwrite'); };
    modal.querySelector('#dup-cancel').onclick = () => { modal.remove(); resolve('cancel'); };
  });
}

// ══ Start async track analysis ══════════════════════════════════════════════
async function startAnalysis(fileId, filename, duration) {
  const panel = document.getElementById('ref-analysis-panel');
  const loadingEl = document.getElementById('ref-analysis-loading');
  const content = document.getElementById('ref-analysis-content');
  if (!panel) return;
  panel.style.display = 'block';
  if (loadingEl) loadingEl.style.display = 'flex';
  if (content) content.innerHTML = '';
  try {
    const res = await fetch('/api/analyze-reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, filename, duration })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');
    if (loadingEl) loadingEl.style.display = 'none';
    if (data.analysis) {
      renderAnalysisPanel(data.analysis);
      // Update the saved upload entry with analysis data
      saveReferenceUpload(fileId, filename, duration, data.analysis);
    }
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (content) content.innerHTML = `<p style="color:var(--muted);font-size:.78rem"><i class="fas fa-exclamation-circle" style="margin-right:4px"></i>Analysis unavailable &mdash; ${err.message || 'please try again'}</p>`;
  }
}

// ══ Render analysis results panel ══════════════════════════════════════════
function renderAnalysisPanel(analysis) {
  const panel = document.getElementById('ref-analysis-panel');
  const content = document.getElementById('ref-analysis-content');
  if (!panel || !content || !analysis) return;
  panel.style.display = 'block';

  const chip = (v) => `<span style="display:inline-block;padding:2px 9px;margin:2px 2px;background:rgba(78,159,255,.12);border:1px solid rgba(78,159,255,.25);border-radius:20px;font-size:.72rem;color:var(--primary)">${v}</span>`;

  const row = (icon, label, value) => value
    ? `<div style="display:flex;gap:8px;margin-bottom:9px;align-items:flex-start">
         <span style="min-width:18px;color:var(--primary);font-size:.8rem;margin-top:2px"><i class="fas fa-${icon}"></i></span>
         <div><div style="color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">${label}</div><div style="color:var(--text);font-size:.8rem;font-weight:500;line-height:1.5">${value}</div></div>
       </div>` : '';

  let html = '';

  // Summary — Suno style description
  if (analysis.summary) {
    html += `<div style="padding:10px 12px;background:rgba(78,159,255,.07);border-left:3px solid var(--primary);border-radius:0 8px 8px 0;margin-bottom:14px;font-size:.82rem;line-height:1.65;color:var(--text);font-style:italic">&ldquo;${analysis.summary}&rdquo;</div>`;
  }

  // Core meta badges
  const metaItems = [
    analysis.genre ? `<span style="font-weight:700;color:var(--primary)">${analysis.genre}${analysis.subgenre ? ' &middot; ' + analysis.subgenre : ''}</span>` : '',
    analysis.bpm ? `<b>${analysis.bpm} BPM</b>` : '',
    analysis.key ? `${analysis.key}` : '',
    analysis.energy ? `Energy: <b>${analysis.energy}</b>` : '',
  ].filter(Boolean);
  if (metaItems.length) {
    html += `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px;font-size:.8rem;color:var(--text)">${metaItems.join('<span style="color:var(--border);margin:0 2px">&bull;</span>')}</div>`;
  }

  // Mood
  if (analysis.mood) html += row('heart', 'Mood &amp; Vibe', analysis.mood);

  // Instruments
  if (analysis.instruments && analysis.instruments.length) {
    html += `<div style="margin-bottom:10px">
      <div style="color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px"><i class="fas fa-guitar" style="color:var(--primary);margin-right:4px"></i>Instruments</div>
      <div>${analysis.instruments.map(chip).join('')}</div>
    </div>`;
  }

  // Vocals
  if (analysis.vocals) {
    const v = analysis.vocals;
    if (v.present) {
      let vStyle = v.style || 'Vocals detected';
      if (v.effects && v.effects.length) {
        vStyle += `<br><span style="color:var(--muted);font-size:.75rem">Effects: ${v.effects.map(chip).join('')}</span>`;
      }
      html += row('microphone', 'Vocals', vStyle);
    } else {
      html += row('microphone-slash', 'Vocals', '<span style="color:var(--muted)">Instrumental &mdash; no vocals</span>');
    }
  }

  // Production & Texture
  if (analysis.production_style) html += row('sliders-h', 'Production Style', analysis.production_style);
  if (analysis.sonic_texture) html += row('wave-square', 'Sonic Texture', analysis.sonic_texture);
  if (analysis.arrangement) html += row('list-music', 'Arrangement', analysis.arrangement);

  // Similar artists
  if (analysis.similar_artists && analysis.similar_artists.length) {
    html += `<div style="margin-bottom:4px">
      <div style="color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px"><i class="fas fa-users" style="color:var(--primary);margin-right:4px"></i>Similar Artists</div>
      <div>${analysis.similar_artists.map(chip).join('')}</div>
    </div>`;
  }

  content.innerHTML = html || '<p style="color:var(--muted);font-size:.8rem">No analysis data available.</p>';
}

// ══ Save reference upload metadata to DB ═══════════════════════════════════
async function saveReferenceUpload(fileId, filename, duration, analysis) {
  try {
    await fetch('/api/save-reference-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, filename, duration, analysis_json: analysis })
    });
  } catch {}
}


// ══════════════════════════════════════════════════════════════════════════════
//  STEM PLAYER — openStemsPanel(jobId, stereoUrl, title, userPlan)
//  Centered modal (Suno-style), 3 tabs, lazy load, per-stem S/M/waveform/vol
//  Advanced tab: first extracts stems via audio-separation-2, then lets user
//  pick a stem to regenerate clean via Mureka /v1/track/generate (no bleed).
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  //  CONSTANTS
  // ─────────────────────────────────────────────────────────────────────────
  var STEM_COLORS = {
    vocals:            '#4e9fff',
    'lead vocals':     '#4e9fff',
    'background vocals':'#38bdf8',
    'rap vocals':      '#7dd3fc',
    drums:             '#f59e0b',
    'kick drum':       '#fbbf24',
    snare:             '#fcd34d',
    'hi-hat':          '#fde68a',
    cymbals:           '#fef3c7',
    percussion:        '#f97316',
    bass:              '#a855f6',
    'bass guitar':     '#c084fc',
    'electric bass':   '#d8b4fe',
    'upright bass':    '#e9d5ff',
    guitar:            '#ef4444',
    'electric guitar': '#f87171',
    'acoustic guitar': '#fca5a5',
    'rhythm guitar':   '#fb923c',
    'lead guitar':     '#f43f5e',
    piano:             '#06b6d4',
    'electric piano':  '#22d3ee',
    'grand piano':     '#67e8f9',
    synth:             '#84cc16',
    'synth lead':      '#a3e635',
    'synth pad':       '#bef264',
    strings:           '#10b981',
    violin:            '#34d399',
    viola:             '#6ee7b7',
    cello:             '#a7f3d0',
    orchestra:         '#059669',
    brass:             '#eab308',
    trumpet:           '#facc15',
    trombone:          '#fde047',
    choir:             '#c084fc',
    other:             '#64748b',
    instrumental:      '#475569',
    default:           '#8b5cf6'
  };

  // Track types supported by Mureka /v1/track/generate for advanced regeneration
  var REGEN_TYPES = [
    'Vocals','Drums','Bass','Guitar','Piano',
    'Strings','Brass','Synth','Keyboard','Flute','Woodwinds'
  ];

  // ─────────────────────────────────────────────────────────────────────────
  //  STATE
  // ─────────────────────────────────────────────────────────────────────────
  var _panel        = null;
  var _jobId        = null;
  var _stereoUrl    = null;
  var _title        = null;
  var _userPlan     = 'free';   // 'free' | 'creator' | 'pro' | 'developer'
  var _activeTab    = null;
  var _stems        = [];
  var _audios       = [];
  var _playing      = false;
  var _playPending  = false;    // true while play() promises are in-flight (prevents AbortError)
  var _pollTimer    = null;
  var _curTaskId    = null;
  var _rafId        = null;     // requestAnimationFrame id for timeline loop
  // Advanced tab state
  var _advStems     = [];       // stems extracted by audio-separation-2 for adv tab
  var _origStemUrls = {};       // { stemName: proxyUrl } — original auto URLs, set once and never overwritten
  // _selectedRegen and _regenStemName removed — regen feature moved to card menu
  var _stemLabels   = {};       // user-renamed stem labels: { stemName: customLabel }
  var _advStemsReset= false;    // true after manual Reset — suppresses auto-restore

  // ─────────────────────────────────────────────────────────────────────────
  //  OPEN / CLOSE
  // ─────────────────────────────────────────────────────────────────────────
  window.openStemsPanel = function (jobId, stereoUrl, title, userPlan) {
    // Gate: stem splitting — Free is fully blocked; Creator can use Auto Split only
    var _resolvedPlan = userPlan || (window._sfUser && window._sfUser.plan) || 'free';
    if (_resolvedPlan === 'free') {
      // Show a targeted upgrade prompt
      var existingGate = document.getElementById('sf-stem-gate-modal');
      if (existingGate) existingGate.remove();
      var gateEl = document.createElement('div');
      gateEl.id = 'sf-stem-gate-modal';
      gateEl.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.78);backdrop-filter:blur(8px);padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
      gateEl.innerHTML = [
        '<div style="background:#12152a;border:1px solid rgba(108,58,255,.4);border-radius:20px;max-width:400px;width:100%;padding:32px 28px;text-align:center;box-shadow:0 20px 60px rgba(108,58,255,.25)">',
          '<div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;margin:0 auto 18px">',
            '<i class="fas fa-scissors" style="color:white;font-size:1.3rem"></i>',
          '</div>',
          '<h3 style="margin:0 0 8px;font-size:1.2rem;font-weight:800;color:#e2e8f0">Stem Splitting is Creator+</h3>',
          '<p style="margin:0 0 24px;font-size:.88rem;color:#94a3b8;line-height:1.6">Upgrade to <strong style="color:#38bdf8">Creator</strong> to split your beats with Auto Split, or go <strong style="color:#c084fc">Pro Artist</strong> for Vocals &amp; Instrumental separation too.</p>',
          '<div style="display:flex;flex-direction:column;gap:10px">',
            '<a href="/pricing" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#6c3aff,#a855f7);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-crown" style="margin-right:6px"></i>View Plans</a>',
            '<button onclick="document.getElementById(\'sf-stem-gate-modal\').remove()" style="padding:10px 24px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#94a3b8;border-radius:12px;font-size:.88rem;cursor:pointer;font-weight:600">Maybe later</button>',
          '</div>',
        '</div>'
      ].join('');
      document.body.appendChild(gateEl);
      return;
    }
    _jobId     = jobId;
    _stereoUrl = stereoUrl;
    _title     = title || 'Beat';
    _userPlan  = _resolvedPlan;

    var old = document.getElementById('sf-stems-panel');
    if (old) old.remove();
    _cleanup();

    _panel = document.createElement('div');
    _panel.id = 'sf-stems-panel';
    _panel.style.cssText = [
      'position:fixed;inset:0;z-index:99990',
      'display:flex;align-items:center;justify-content:center',
      'background:rgba(0,0,0,0.75)',
      'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)',
      'padding:16px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'color:#e2e8f0',
      'user-select:none',
      'opacity:0',
      'transition:opacity 0.22s ease'
    ].join(';');

    _panel.innerHTML = _buildShell();
    document.body.appendChild(_panel);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        _panel.style.opacity = '1';
        var card = document.getElementById('sp-card');
        if (card) card.style.transform = 'translateY(0) scale(1)';
      });
    });

    _bindEvents();

    // Silently restore any previously cached stems so the Advanced tab
    // has its _advStems ready without the user needing to re-extract.
    _restoreCachedStems();
  };

  window.closeStemsPanel = function () {
    if (!_panel) return;
    _panel.style.opacity = '0';
    var card = document.getElementById('sp-card');
    if (card) { card.style.transform = 'translateY(8px) scale(0.98)'; }
    var p = _panel;
    setTimeout(function () { if (p && p.parentNode) p.parentNode.removeChild(p); }, 240);
    _panel = null;
    _cleanup();
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  PANEL SHELL HTML
  // ─────────────────────────────────────────────────────────────────────────
  function _buildShell() {
    return '<div id="sp-card" style="' +
        'background:#0d0d1a;' +
        'border:1px solid rgba(255,255,255,0.09);' +
        'border-radius:14px;' +
        'box-shadow:0 32px 96px rgba(0,0,0,0.9);' +
        'width:100%;max-width:560px;' +
        'display:flex;flex-direction:column;' +
        'overflow:hidden;' +
        'transform:translateY(10px) scale(0.98);' +
        'transition:transform 0.28s cubic-bezier(0.22,1,0.36,1)' +
      '">' +

      // ── Header ──────────────────────────────────────────────
      '<div style="display:flex;align-items:center;gap:11px;padding:14px 16px 12px;' +
          'border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0">' +
        '<div style="width:34px;height:34px;border-radius:8px;flex-shrink:0;' +
            'background:linear-gradient(135deg,rgba(78,159,255,.18),rgba(99,102,241,.18));' +
            'display:flex;align-items:center;justify-content:center">' +
          '<i class="fas fa-layer-group" style="color:#4e9fff;font-size:.8rem"></i>' +
        '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div id="sp-title" style="font-weight:700;font-size:.9rem;color:#f8fafc;' +
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + formatCardTitle(_title) + '</div>' +
          '<div style="font-size:.68rem;color:rgba(255,255,255,0.32);margin-top:1px">Stem Extractor</div>' +
        '</div>' +
        '<button onclick="closeStemsPanel()" aria-label="Close" style="' +
            'background:rgba(255,255,255,0.06);border:none;color:rgba(255,255,255,0.4);' +
            'width:26px;height:26px;border-radius:50%;cursor:pointer;display:flex;' +
            'align-items:center;justify-content:center;font-size:1rem;flex-shrink:0;transition:background .15s"' +
          ' onmouseover="this.style.background=\'rgba(255,255,255,.12)\'"' +
          ' onmouseout="this.style.background=\'rgba(255,255,255,.06)\'">&times;</button>' +
      '</div>' +

      // ── Track rows (hidden until extracted) ─────────────────
      '<div id="sp-tracks" style="display:none;flex-direction:column;overflow-y:auto;max-height:240px"></div>' +

      // ── Playback bar (hidden until stems ready) ──────────────
      '<div id="sp-playbar" style="display:none;align-items:center;gap:9px;padding:9px 16px;' +
          'border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:#0a0a14">' +
        '<button id="sp-play-btn" onclick="window._spPlay()" aria-label="Play/Pause" style="' +
            'width:30px;height:30px;border-radius:50%;border:none;' +
            'background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;cursor:pointer;' +
            'display:flex;align-items:center;justify-content:center;font-size:.75rem;flex-shrink:0;transition:transform .1s"' +
          ' onmouseover="this.style.transform=\'scale(1.1)\'" onmouseout="this.style.transform=\'scale(1)\'">' +
          '<i id="sp-play-icon" class="fas fa-play"></i>' +  /* FIX: default is fa-play not fa-pause */
        '</button>' +
        '<span id="sp-time-cur" style="font-size:.7rem;color:rgba(255,255,255,0.38);min-width:28px;flex-shrink:0">0:00</span>' +
        '<div id="sp-timeline-wrap" onclick="window._spSeek(event)" style="flex:1;height:3px;' +
            'background:rgba(255,255,255,0.1);border-radius:2px;cursor:pointer;position:relative">' +
          '<div id="sp-timeline-fill" style="position:absolute;left:0;top:0;bottom:0;width:0%;' +
              'background:linear-gradient(90deg,#4e9fff,#6366f1);border-radius:2px;pointer-events:none"></div>' +
          '<div id="sp-timeline-thumb" style="position:absolute;top:50%;width:9px;height:9px;' +
              'border-radius:50%;background:#fff;transform:translate(-50%,-50%);left:0%;' +
              'pointer-events:none;transition:left .1s linear"></div>' +
        '</div>' +
        '<span id="sp-time-tot" style="font-size:.7rem;color:rgba(255,255,255,0.38);min-width:28px;flex-shrink:0;text-align:right">0:00</span>' +
      '</div>' +

      // ── Tab section ──────────────────────────────────────────
      '<div style="flex-shrink:0">' +
        '<div style="display:flex;gap:4px;padding:10px 16px 0;background:#0d0d1a">' +
          '<button class="sp-tab" data-tab="auto" style="' +
              'flex:1;height:27px;border-radius:6px;border:none;cursor:pointer;' +
              'font-size:.72rem;font-weight:600;background:rgba(255,255,255,0.04);' +
              'color:rgba(255,255,255,0.42);transition:all .2s">Auto split</button>' +
          '<button class="sp-tab" data-tab="split_from_mix" style="' +
              'flex:1;height:27px;border-radius:6px;border:none;cursor:pointer;' +
              'font-size:.72rem;font-weight:600;background:rgba(255,255,255,0.04);' +
              'color:rgba(255,255,255,0.42);transition:all .2s">Vocals &amp; Inst.' +
            (_userPlan === 'creator' ? ' <span style="font-size:.55rem;background:#6c3aff;color:#fff;padding:1px 4px;border-radius:3px;vertical-align:middle;margin-left:2px">Pro</span>' : '') +
          '</button>' +
          '<button class="sp-tab" data-tab="advanced" style="' +
              'flex:1;height:27px;border-radius:6px;border:none;cursor:pointer;' +
              'font-size:.72rem;font-weight:600;background:rgba(255,255,255,0.04);' +
              'color:rgba(255,255,255,0.42);transition:all .2s">' +
            'Advanced <span style="font-size:.58rem;background:#ec4899;color:#fff;' +
                'padding:1px 4px;border-radius:3px;vertical-align:middle;margin-left:2px">Pro</span>' +
          '</button>' +
        '</div>' +
        '<div id="sp-tab-body" style="padding:12px 16px 14px">' +
          '<p style="color:rgba(255,255,255,0.22);font-size:.78rem;text-align:center;margin:14px 0">' +
            'Select a tab above to extract stems' +
          '</p>' +
        '</div>' +
      '</div>' +

    '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  // Silently fetch cached 'auto' stems from D1 when the panel opens.
  // Populates _advStems so the Advanced tab doesn't need a fresh extraction
  // even after the panel is closed and reopened.
  function _restoreCachedStems() {
    var jobId = _jobId;
    // Step 1: fetch cached auto stems
    fetch('/api/job/stems/' + jobId + '?mode=auto')
      .then(function(r) {
        if (!r.ok) { console.warn('[StemPlayer] restore: HTTP ' + r.status); return null; }
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        if (!data.stems || !data.stems.length || data.status !== 'ready') {
          console.log('[StemPlayer] restore: no cached auto stems yet (status=' + (data && data.status) + ')');
          return;
        }
        // Only restore if _advStems is still empty and user hasn't manually Reset
        if (!_advStems.length && !_advStemsReset && _jobId === jobId) {
          _advStems = data.stems.slice(); // copy
          _captureOrigUrls(_advStems);    // snapshot original URLs before any regens are merged
          console.log('[StemPlayer] restore: loaded ' + _advStems.length + ' auto stems for ' + jobId);
          // Render the Advanced tab if it's active (regen section always starts empty on reopen)
          if (_activeTab === 'advanced' && _panel) {
            _renderStemTracks(_advStems, 'advanced');
          }
        }
      })
      .catch(function(e) { console.warn('[StemPlayer] restore failed:', e); });
  }

  // _mergeRestoredRegens removed — regen feature moved to card menu

  function _bindEvents() {
    _panel.querySelectorAll('.sp-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { _onTabClick(btn.dataset.tab); });
    });
    // Only close via X button (onclick="closeStemsPanel()") or Escape key.
    // Clicking outside the card / on the backdrop should NOT close the panel.
    document.addEventListener('keydown', _onKey);
  }

  function _onKey(e) {
    if (e.key === 'Escape' && _panel) closeStemsPanel();
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  TABS
  // ─────────────────────────────────────────────────────────────────────────
  function _onTabClick(tab) {
    if (!_panel) return;
    _activeTab = tab;
    // FIX: query tabs within panel so we don't bleed into other panels on page
    _panel.querySelectorAll('.sp-tab').forEach(function (btn) {
      var on = btn.dataset.tab === tab;
      btn.style.background = on ? '#fff' : 'rgba(255,255,255,0.04)';
      btn.style.color       = on ? '#000' : 'rgba(255,255,255,0.42)';
    });
    // FIX: reset stems/audio when switching tabs so old state doesn't bleed
    _stopAllAudio();
    _playing = false;
    _stems = [];
    _audios = [];
    _curTaskId = null;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    var tracksEl = _panel.querySelector('#sp-tracks');
    var playbar  = _panel.querySelector('#sp-playbar');
    if (tracksEl) { tracksEl.style.display = 'none'; tracksEl.innerHTML = ''; }
    if (playbar)  playbar.style.display = 'none';
    if (tab === 'auto')            _showAutoTab();
    else if (tab === 'split_from_mix') _showSplitTab();
    else if (tab === 'advanced')   _showAdvancedTab();
  }

  // ── Auto split tab ────────────────────────────────────────────────────────
  function _showAutoTab() {
    _setTabBody(
      '<div style="display:flex;align-items:center;gap:12px">' +
        '<p style="flex:1;color:rgba(255,255,255,0.48);font-size:.77rem;line-height:1.55;margin:0">' +
          'Splits into up to 5 stems: ' +
          '<span style="color:rgba(255,255,255,0.75)">Vocals · Drums · Bass · Other · Instrumental</span>' +
        '</p>' +
        '<button onclick="window._spExtract(\'auto\')" style="' +
            'flex-shrink:0;padding:6px 14px;border-radius:7px;border:none;' +
            'background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;' +
            'font-weight:600;font-size:.73rem;cursor:pointer;transition:opacity .15s;white-space:nowrap"' +
          ' onmouseover="this.style.opacity=\'.78\'" onmouseout="this.style.opacity=\'1\'">' +
          'Extract' +
        '</button>' +
      '</div>'
    );
  }

  // ── Vocals & Instrumental tab ─────────────────────────────────────────────
  function _showSplitTab() {
    // Gate: V+I is Pro Artist only — Creator can only use Auto Split
    if (_userPlan === 'creator') {
      _setTabBody(
        '<div style="text-align:center;padding:14px 0">' +
          '<div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6c3aff,#a855f7);display:flex;align-items:center;justify-content:center;margin:0 auto 10px">' +
            '<i class="fas fa-microphone" style="color:white;font-size:.85rem"></i>' +
          '</div>' +
          '<p style="margin:0 0 6px;font-size:.84rem;font-weight:700;color:#e2e8f0">Vocals &amp; Instrumental is Pro Only</p>' +
          '<p style="margin:0 0 14px;font-size:.77rem;color:#64748b;line-height:1.5">Upgrade to Pro Artist to separate vocals from the full instrumental track.</p>' +
          '<a href="/pricing" style="display:inline-block;padding:7px 18px;background:linear-gradient(135deg,#6c3aff,#a855f7);color:#fff;border-radius:8px;font-weight:700;text-decoration:none;font-size:.8rem"><i class="fas fa-crown" style="margin-right:5px"></i>Upgrade to Pro Artist</a>' +
        '</div>'
      );
      return;
    }
    _setTabBody(
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap">' +
          // Vocals chip
          '<span style="display:inline-flex;align-items:center;gap:4px;' +
              'background:rgba(78,159,255,0.1);border:1px solid rgba(78,159,255,0.22);' +
              'border-radius:6px;padding:4px 8px;font-size:.72rem;color:#4e9fff;font-weight:600">' +
            '<i class="fas fa-microphone" style="font-size:.6rem"></i> Vocals' +
          '</span>' +
          // label moved right after Vocals chip
          '<span style="font-size:.68rem;color:rgba(255,255,255,0.26)">lead &amp; backing</span>' +
          '<span style="color:rgba(255,255,255,0.2);font-size:.72rem">+</span>' +
          // Instrumental chip
          '<span style="display:inline-flex;align-items:center;gap:4px;' +
              'background:rgba(100,116,139,0.1);border:1px solid rgba(100,116,139,0.2);' +
              'border-radius:6px;padding:4px 8px;font-size:.72rem;color:#94a3b8;font-weight:600">' +
            '<i class="fas fa-music" style="font-size:.6rem"></i> Instrumental' +
          '</span>' +
        '</div>' +
        '<button onclick="window._spExtract(\'split_from_mix\')" style="' +
            'flex-shrink:0;padding:6px 14px;border-radius:7px;border:none;' +
            'background:#fff;color:#000;font-weight:600;font-size:.73rem;cursor:pointer;' +
            'transition:opacity .15s;white-space:nowrap"' +
          ' onmouseover="this.style.opacity=\'.8\'" onmouseout="this.style.opacity=\'1\'">' +
          'Extract' +
        '</button>' +
      '</div>'
    );
  }

  // ── Advanced tab ──────────────────────────────────────────────────────────
  function _showAdvancedTab() {
    if (_advStems.length > 0) {
      _renderStemTracks(_advStems, 'advanced');
    } else {
      // Not yet extracted — show Extract button
      _setTabBody(
        '<div style="display:flex;align-items:flex-start;gap:12px">' +
          '<div style="flex:1;min-width:0">' +
            '<p style="color:rgba(255,255,255,0.48);font-size:.77rem;line-height:1.55;margin:0 0 4px 0">' +
              '<span style="color:#c084fc;font-weight:600">Advanced Stem Extraction</span> — ' +
              'Extracts individual stems (vocals, drums, bass, other) from your track.' +
            '</p>' +
            '<p style="color:rgba(255,255,255,0.28);font-size:.7rem;margin:0">' +
              'Each stem can be muted, soloed, and downloaded independently.' +
            '</p>' +
          '</div>' +
          '<button onclick="window._spExtractAdvanced()" style="' +
              'flex-shrink:0;padding:6px 14px;border-radius:7px;border:none;' +
              'background:linear-gradient(135deg,#a855f6,#ec4899);color:#fff;' +
              'font-weight:600;font-size:.73rem;cursor:pointer;transition:opacity .15s;white-space:nowrap"' +
            ' onmouseover="this.style.opacity=\'.8\'" onmouseout="this.style.opacity=\'1\'">' +
            'Extract' +
          '</button>' +
        '</div>'
      );
    }
  }

  // Legacy: no longer used but kept for safety
  function _showAdvancedRegenPicker() {
    _showAdvancedTab();
  }

  function _setTabBody(html) {
    var el = _panel && _panel.querySelector('#sp-tab-body');
    if (el) el.innerHTML = html;
  }

  // Safe JSON reader — returns parsed data or throws a clean error.
  // Prevents "Unexpected token '<'" when server returns HTML (Worker crash / edge error).
  async function _safeJson(res) {
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      // Server returned non-JSON (HTML error page, Cloudflare edge error, etc.)
      var status = res.status;
      if (text.trimStart().startsWith('<')) {
        throw new Error('Server error ' + status + ' (try again — if it persists the beat audio may have expired)');
      }
      throw new Error('Bad response ' + status + ': ' + text.slice(0, 120));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ADVANCED TAB ACTIONS
  // ─────────────────────────────────────────────────────────────────────────

  // Step 1: Extract stems for the advanced tab (uses audio-separation-2)
  window._spExtractAdvanced = async function () {
    if (!_jobId) return;
    _stopAllAudio();
    _playing = false;
    _stems = [];
    _audios = [];
    _advStems = [];
    _advStemsReset = false;   // fresh extraction — allow future restore
    _curTaskId = null;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }

    var tracksEl = _panel && _panel.querySelector('#sp-tracks');
    var playbar  = _panel && _panel.querySelector('#sp-playbar');
    if (tracksEl) { tracksEl.style.display = 'none'; tracksEl.innerHTML = ''; }
    if (playbar)  playbar.style.display = 'none';

    _showProgress('Detecting stems…');

    try {
      var res = await fetch('/api/job/stems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: _jobId, mode: 'auto' })
      });
      var data = await _safeJson(res);
      if (!res.ok) {
        var upgradeMsg = data.upgrade
          ? (data.error || 'Advanced requires Pro') + ' <a href="/pricing" style="color:#4e9fff;text-decoration:underline">Upgrade →</a>'
          : (data.error || 'Extraction failed');
        _showError(upgradeMsg);
        return;
      }
      if (data.status === 'ready' && data.stems && data.stems.length) {
        _advStems = data.stems;
        _captureOrigUrls(_advStems);
        _renderStemTracks(_advStems, 'advanced');
        return;
      }
      _curTaskId = data.task_id;
      _pollForAdvancedStems();
    } catch (err) {
      _showError('Network error: ' + (err.message || 'Unknown'));
    }
  };

  function _pollForAdvancedStems() {
    var dots = 0;
    var pollStart = Date.now();
    var MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
    _pollTimer = setInterval(async function () {
      if (!_panel) { clearInterval(_pollTimer); return; }
      // Timeout guard: if polling for > 5 min, show error so user can retry
      if (Date.now() - pollStart > MAX_POLL_MS) {
        clearInterval(_pollTimer); _pollTimer = null;
        _showError('Stem extraction timed out. Please try again.');
        return;
      }
      dots = (dots + 1) % 4;
      _showProgress('Detecting stems' + '.'.repeat(dots + 1));
      try {
        var params = '?mode=auto';
        if (_curTaskId) params += '&task_id=' + encodeURIComponent(_curTaskId);
        var res  = await fetch('/api/job/stems/' + _jobId + params);
        var data = await _safeJson(res);
        if (data.status === 'ready' && data.stems && data.stems.length) {
          clearInterval(_pollTimer); _pollTimer = null;
          _advStems = data.stems;
          _captureOrigUrls(_advStems);
          _renderStemTracks(_advStems, 'advanced');
        } else if (data.status === 'error') {
          clearInterval(_pollTimer); _pollTimer = null;
          _showError(data.error || 'Extraction failed');
        }
      } catch (e) { if (e && e.message && !e.message.includes('keep polling')) { /* transient — keep polling */ } }
    }, 2500);
  }

  // Snapshot the proxy URL for each stem the first time extraction completes.
  // Uses /api/stem-audio/:jobId/:stemName (no ?regen flag) = original auto extraction.
  // _origStemUrls is NEVER overwritten after it's set — it always stores the pre-regen URLs.
  function _captureOrigUrls(stems) {
    stems.forEach(function(s) {
      var key = s.name.toLowerCase();
      if (!_origStemUrls[key]) {
        _origStemUrls[key] = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(s.name);
      }
    });
  }

  // Reset advanced tab back to Extract button
  window._spResetAdvanced = function () {
    _advStems = [];
    _origStemUrls = {};
    _stemLabels = {};
    _advStemsReset = true;   // suppress auto-restore until user manually extracts again
    _stopAllAudio();
    _playing = false;
    _stems = [];
    _audios = [];
    _curTaskId = null;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    var tracksEl = _panel && _panel.querySelector('#sp-tracks');
    var playbar  = _panel && _panel.querySelector('#sp-playbar');
    if (tracksEl) { tracksEl.style.display = 'none'; tracksEl.innerHTML = ''; }
    if (playbar)  playbar.style.display = 'none';
    _showAdvancedTab();
  };

  // _spRunRegen and _pollForRegen removed — regen feature moved to card menu (openRemixCard)

  // ─────────────────────────────────────────────────────────────────────────
  //  EXTRACT (Auto + Split tabs)
  // ─────────────────────────────────────────────────────────────────────────
  window._spExtract = async function (mode) {
    if (!_jobId) return;
    _stopAllAudio();
    _playing = false;
    _stems = [];
    _audios = [];
    _curTaskId = null;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }

    var tracksEl = _panel && _panel.querySelector('#sp-tracks');
    var playbar  = _panel && _panel.querySelector('#sp-playbar');
    if (tracksEl) { tracksEl.style.display = 'none'; tracksEl.innerHTML = ''; }
    if (playbar)  playbar.style.display = 'none';

    _showProgress('Starting extraction…');

    var body = { job_id: _jobId, mode: mode };

    try {
      var res = await fetch('/api/job/stems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await _safeJson(res);

      if (!res.ok) {
        var msg = data.error || 'Extraction failed';
        if (data.upgrade) {
          _showError(msg + ' <a href="/pricing" style="color:#4e9fff;text-decoration:underline">Upgrade →</a>');
        } else {
          _showError(msg);
        }
        return;
      }

      if (data.status === 'ready' && data.stems && data.stems.length) {
        _renderStemTracks(data.stems, mode);
        return;
      }

      _curTaskId = data.task_id;
      _pollForStems(mode);

    } catch (err) {
      _showError('Network error: ' + (err.message || 'Unknown'));
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  POLLING
  // ─────────────────────────────────────────────────────────────────────────
  function _pollForStems(mode) {
    var dots = 0;
    var pollStart = Date.now();
    var MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
    _pollTimer = setInterval(async function () {
      if (!_panel) { clearInterval(_pollTimer); return; }
      if (Date.now() - pollStart > MAX_POLL_MS) {
        clearInterval(_pollTimer); _pollTimer = null;
        _showError('Stem extraction timed out. Please try again.');
        return;
      }
      dots = (dots + 1) % 4;
      _showProgress('Extracting stems' + '.'.repeat(dots + 1));
      try {
        var params = '?mode=' + encodeURIComponent(mode);
        if (_curTaskId) params += '&task_id=' + encodeURIComponent(_curTaskId);
        var res  = await fetch('/api/job/stems/' + _jobId + params);
        var data = await _safeJson(res);
        if (data.status === 'ready' && data.stems && data.stems.length) {
          clearInterval(_pollTimer); _pollTimer = null;
          _renderStemTracks(data.stems, mode);
        } else if (data.status === 'error') {
          clearInterval(_pollTimer); _pollTimer = null;
          _showError(data.error || 'Extraction failed');
        }
      } catch (e) { /* network glitch — keep polling */ }
    }, 2500);
  }

  function _showProgress(text) {
    _setTabBody(
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 0">' +
        '<div style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.1);' +
            'border-top-color:#4e9fff;border-radius:50%;animation:sp-spin 0.7s linear infinite;flex-shrink:0"></div>' +
        '<span style="color:rgba(255,255,255,0.5);font-size:.77rem">' + _escHtml(text || 'Processing…') + '</span>' +
        '<style>@keyframes sp-spin{to{transform:rotate(360deg)}}</style>' +
      '</div>'
    );
  }

  function _showError(html) {
    var retryAction = _activeTab === 'advanced'
      ? 'window._spResetAdvanced()'
      : 'window._spReExtract(\'' + (_activeTab || 'auto') + '\')';
    _setTabBody(
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 0">' +
        '<i class="fas fa-exclamation-triangle" style="color:#f59e0b;font-size:.9rem;flex-shrink:0"></i>' +
        '<span style="color:rgba(255,255,255,0.55);font-size:.77rem;flex:1">' + html + '</span>' +
        '<button onclick="' + retryAction + '" style="' +
            'flex-shrink:0;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);' +
            'background:rgba(255,255,255,.06);color:rgba(255,255,255,.5);font-size:.7rem;cursor:pointer">' +
          'Retry' +
        '</button>' +
      '</div>'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RENDER STEM TRACKS
  // ─────────────────────────────────────────────────────────────────────────
  function _renderStemTracks(stems, mode) {
    if (!_panel) return;

    var isAdv = (mode === 'advanced');

    _stems = stems.map(function (s) {
      return { name: s.name, url: s.url, muted: false, solo: false, vol: 1.0 };
    });

    // Tab body: status + reset/re-extract button + stereo download button
    _setTabBody(
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
        '<span style="color:rgba(255,255,255,0.35);font-size:.72rem">' +
          '<i class="fas fa-check-circle" style="color:#10b981;margin-right:4px"></i>' +
          _stems.length + ' stem' + (_stems.length !== 1 ? 's' : '') + ' extracted' +
        '</span>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          _buildDownloadBtn(mode) +
          (isAdv
            ? '<button onclick="window._spResetAdvanced()" style="' +
                'padding:3px 10px;border-radius:5px;border:1px solid rgba(255,255,255,.1);' +
                'background:rgba(255,255,255,.04);color:rgba(255,255,255,.38);font-size:.68rem;cursor:pointer">Reset</button>'
            : '<button onclick="window._spReExtract(\'' + mode + '\')" style="' +
                'padding:3px 10px;border-radius:5px;border:1px solid rgba(255,255,255,.1);' +
                'background:rgba(255,255,255,.04);color:rgba(255,255,255,.38);font-size:.68rem;cursor:pointer">Re-extract</button>'
          ) +
        '</div>' +
      '</div>'
    );

    var tracksEl = _panel.querySelector('#sp-tracks');
    if (!tracksEl) return;

    // Render stem rows
    var origHtml = _stems.map(function (s, i) {
      return _buildTrackRow(s, i, isAdv);
    }).join('');

    tracksEl.innerHTML = origHtml;
    tracksEl.style.display = 'flex';

    // Preserve playback position when re-rendering (e.g. after regen completes).
    // Capture current time from the first active audio before rebuilding _audios.
    var savedTime    = (_audios[0] && !isNaN(_audios[0].currentTime)) ? _audios[0].currentTime : 0;
    var wasPlaying   = _playing;

    // Pause all old audio objects cleanly before discarding them
    _audios.forEach(function(a) { try { a.pause(); } catch(e){} });

    // Build Audio objects — always the original audio (never remix for mixer)
    _audios = [];
    _stems.forEach(function (s, i) {
      var audio = new Audio();
      // preload='auto': buffers the full audio so pause/resume and seek work correctly
      // without depending on the browser keeping the HTTP connection alive.
      // With preload='metadata' the browser drops the connection on pause, then on
      // resume some browsers reset currentTime to 0 before re-fetching — causing the
      // "always plays from beginning" bug even with Range support on the server.
      audio.preload = 'auto';
      // Always use ORIGINAL audio for the mixer — remix versions live in the separate section
      audio.src = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(s.name);
      _audios.push(audio);

      audio.addEventListener('error', function (e) {
        var err = audio.error;
        var code = err ? err.code : '?';
        var msg = err ? err.message : 'unknown';
        console.error('[StemPlayer] Audio load error stem=' + s.name + ' code=' + code + ' msg=' + msg + ' src=' + audio.src);
        fetch(audio.src).then(function(r){
          if (!r.ok) console.error('[StemPlayer] HTTP ' + r.status + ' for stem ' + s.name);
          else console.log('[StemPlayer] URL reachable (HTTP ' + r.status + ') for stem ' + s.name);
        }).catch(function(e2){ console.error('[StemPlayer] fetch check failed:', e2); });
      });

      if (i === 0) {
        audio.addEventListener('loadedmetadata', function () { _updateDuration(audio.duration); });
        audio.addEventListener('ended', function () {
          _playing = false;
          _updatePlayIcon();
          _updateTimeline(0, audio.duration);
          _audios.forEach(function(a){ try { a.currentTime = 0; } catch(e){} });
          _stopRaf();
        });
      }
    });

    // Restore playback position after audio objects are ready.
    // Use loadedmetadata on the first track to seek accurately, then resume if playing.
    if (savedTime > 0 && _audios.length) {
      var firstAudio = _audios[0];
      var doRestore = function() {
        _audios.forEach(function(a) { try { a.currentTime = savedTime; } catch(e){} });
        _updateTimeline(savedTime, firstAudio.duration || 0);
        if (wasPlaying) {
          // Small delay so all audio elements have had a chance to seek
          setTimeout(function() { window._spPlay && _spPlay(); }, 80);
        }
      };
      if (firstAudio.readyState >= 1) {
        // Metadata already known — restore immediately
        doRestore();
      } else {
        firstAudio.addEventListener('loadedmetadata', doRestore, { once: true });
      }
    }

    requestAnimationFrame(function () {
      _stems.forEach(function (s, i) {
        var canvas = _panel && _panel.querySelector('#sp-wave-' + i);
        if (canvas) _drawWaveform(canvas, STEM_COLORS[s.name] || STEM_COLORS.default);
      });
    });

    var playbar = _panel && _panel.querySelector('#sp-playbar');
    if (playbar) playbar.style.display = 'flex';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RAF TIMELINE LOOP
  //  Replaces timeupdate. Runs every animation frame while playing or for a
  //  short burst after a seek, so the playhead + wave bars always reflect the
  //  true audio.currentTime (including after seeks settle).
  // ─────────────────────────────────────────────────────────────────────────
  var _rafBurst = 0;  // frames remaining in a post-seek burst

  function _startRaf() {
    if (_rafId) return;  // already running
    _rafId = requestAnimationFrame(_rafTick);
  }

  function _stopRaf() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _rafBurst = 0;
  }

  function _rafTick() {
    _rafId = null;
    if (!_panel || !_audios.length) return;
    var a = _audios[0];
    if (a && !isNaN(a.duration) && isFinite(a.duration) && a.duration > 0) {
      _updateTimeline(a.currentTime, a.duration);
    }
    // Keep looping while playing OR during a post-seek burst
    if (_playing) {
      _rafId = requestAnimationFrame(_rafTick);
    } else if (_rafBurst > 0) {
      _rafBurst--;
      _rafId = requestAnimationFrame(_rafTick);
    }
  }

  // Call after every seek: runs a short burst so the UI catches up immediately
  function _rafSeekBurst() {
    _rafBurst = 8;   // ~8 frames = ~130ms — enough for browser to commit the seek
    _startRaf();
  }

  // Test hook: allows test pages to inject mock stems
  window.__testInjectStems = function(stems) {
    _renderStemTracks(stems, _activeTab || 'auto');
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  DOWNLOAD BUTTON (per-tab stereo mix)
  // ─────────────────────────────────────────────────────────────────────────
  //  DOWNLOAD BUTTON — opens a centered modal popup (bulletproof, no positioning)
  // ─────────────────────────────────────────────────────────────────────────
  function _buildDownloadBtn(mode) {
    // Free users: upgrade prompt
    if (_userPlan === 'free') {
      return '<button title="Upgrade to access" onclick="window.location=\'/pricing\'" style="' +
        'padding:3px 10px;border-radius:5px;border:1px solid rgba(255,200,0,.2);' +
        'background:rgba(255,200,0,.05);color:rgba(255,200,0,.5);font-size:.68rem;cursor:pointer;' +
        'display:flex;align-items:center;gap:4px">' +
        '<i class="fas fa-lock" style="font-size:.6rem"></i> Download' +
      '</button>';
    }

    // All paid tiers get the popup button (creator gets MP3 only inside popup)
    return '<button onclick="window._spOpenDlPopup()" style="' +
        'padding:3px 10px;border-radius:5px;border:1px solid rgba(78,159,255,.25);' +
        'background:rgba(78,159,255,.07);color:#4e9fff;font-size:.68rem;cursor:pointer;' +
        'display:flex;align-items:center;gap:4px">' +
      '<i class="fas fa-download" style="font-size:.6rem"></i> Download' +
      '<i class="fas fa-chevron-down" style="font-size:.5rem;margin-left:2px"></i>' +
    '</button>';
  }

  // Opens the full-track download popup:
  //   Creator plan → Mastered Mix only (MP3 or WAV)
  //   Pro Artist  → Mastered Mix + Unmastered Mix (MP3 or WAV each)
  window._spOpenDlPopup = function () {
    var existing = document.getElementById('sp-dl-popup-overlay');
    if (existing) { existing.remove(); return; }

    var isPro  = (_userPlan === 'pro' || _userPlan === 'developer');
    var canWav = isPro;

    // Helper: build a format card
    function fmtCard(fmt, type, colorClass, icon, label, sublabel, extraStyle) {
      var borderCol = colorClass === 'blue' ? 'rgba(78,159,255,.5)' : 'rgba(168,85,247,.5)';
      var bgCol     = colorClass === 'blue' ? 'rgba(78,159,255,.12)' : 'rgba(168,85,247,.12)';
      var bgHov     = colorClass === 'blue' ? 'rgba(78,159,255,.25)' : 'rgba(168,85,247,.25)';
      var txtCol    = colorClass === 'blue' ? '#4e9fff' : '#c084fc';
      return '<button onclick="window._spDownloadMix(\'' + fmt + '\',\'' + type + '\')" style="' +
                'flex:1;padding:12px 8px;border-radius:10px;cursor:pointer;' +
                'border:1px solid ' + borderCol + ';background:' + bgCol + ';' +
                'color:' + txtCol + ';font-size:.78rem;display:flex;flex-direction:column;' +
                'align-items:center;gap:5px;transition:background .15s;' + (extraStyle || '') + '"' +
              ' onmouseover="this.style.background=\'' + bgHov + '\'"' +
              ' onmouseout="this.style.background=\'' + bgCol + '\'">' +
              '<i class="' + icon + '" style="font-size:1.25rem"></i>' +
              '<span style="font-weight:700">' + fmt.toUpperCase() + '</span>' +
              '<span style="font-size:.62rem;opacity:.7">' + sublabel + '</span>' +
            '</button>';
    }

    // Mastered section
    var masteredSection =
      '<div style="margin-bottom:16px">' +
        '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">' +
          '<i class="fas fa-star" style="color:#f59e0b;font-size:.75rem"></i>' +
          '<span style="font-size:.8rem;font-weight:700;color:#f1f5f9">Mastered Mix</span>' +
        '</div>' +
        '<div style="display:flex;gap:8px">' +
          fmtCard('mp3', 'mastered', 'blue', 'fas fa-file-audio', 'MP3', 'Compressed') +
          (canWav
            ? fmtCard('wav', 'mastered', 'purple', 'fas fa-wave-square', 'WAV', 'Lossless')
            : '<div style="flex:1;padding:12px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.06);' +
                'background:rgba(255,255,255,.02);color:rgba(255,255,255,.22);font-size:.78rem;' +
                'display:flex;flex-direction:column;align-items:center;gap:5px">' +
                '<i class="fas fa-wave-square" style="font-size:1.25rem"></i>' +
                '<span style="font-weight:700">WAV</span>' +
                '<a href="/pricing" style="font-size:.6rem;color:#a855f6;text-decoration:none">Pro only</a>' +
              '</div>'
          ) +
        '</div>' +
      '</div>';

    // Unmastered section (Pro only)
    var unmasteredSection = isPro
      ? '<div style="border-top:1px solid rgba(255,255,255,.07);padding-top:14px">' +
          '<div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">' +
            '<i class="fas fa-sliders-h" style="color:#10b981;font-size:.75rem"></i>' +
            '<span style="font-size:.8rem;font-weight:700;color:#f1f5f9">Unmastered Mix</span>' +
            '<span style="font-size:.6rem;background:rgba(16,185,129,.15);color:#10b981;' +
              'border:1px solid rgba(16,185,129,.3);padding:1px 6px;border-radius:99px">Pro</span>' +
          '</div>' +
          '<p style="margin:0 0 10px;color:rgba(255,255,255,.38);font-size:.68rem;line-height:1.5">' +
            'The raw, unprocessed stereo mix — ideal if you want to bring it into your own DAW to apply ' +
            'your own EQ, compression, reverb, and mastering chain.' +
          '</p>' +
          '<div style="display:flex;gap:8px">' +
            fmtCard('mp3', 'unmastered', 'blue', 'fas fa-file-audio', 'MP3', 'Compressed') +
            fmtCard('wav', 'unmastered', 'purple', 'fas fa-wave-square', 'WAV', 'Lossless') +
          '</div>' +
        '</div>'
      : '<div style="border-top:1px solid rgba(255,255,255,.07);padding-top:14px">' +
          '<div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">' +
            '<i class="fas fa-sliders-h" style="color:rgba(255,255,255,.2);font-size:.75rem"></i>' +
            '<span style="font-size:.8rem;font-weight:700;color:rgba(255,255,255,.3)">Unmastered Mix</span>' +
            '<span style="font-size:.6rem;background:rgba(168,85,247,.15);color:#c084fc;' +
              'border:1px solid rgba(168,85,247,.3);padding:1px 6px;border-radius:99px">Pro only</span>' +
          '</div>' +
          '<p style="margin:0 0 8px;color:rgba(255,255,255,.28);font-size:.68rem;line-height:1.5">' +
            'Raw unprocessed mix for your own DAW mastering — available on ' +
            '<a href="/pricing" style="color:#a855f6;text-decoration:none">Pro Artist plan</a>.' +
          '</p>' +
        '</div>';

    var overlay = document.createElement('div');
    overlay.id = 'sp-dl-popup-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999999',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.6)', 'backdrop-filter:blur(4px)'
    ].join(';');

    overlay.innerHTML =
      '<div style="background:#0f0f1a;border:1px solid rgba(255,255,255,.12);border-radius:16px;' +
          'padding:22px;min-width:300px;max-width:380px;box-shadow:0 24px 60px rgba(0,0,0,.9);' +
          'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">' +
          '<h3 style="margin:0;color:#f1f5f9;font-size:.95rem;font-weight:600">' +
            '<i class="fas fa-download" style="color:#4e9fff;margin-right:8px"></i>Download Track' +
          '</h3>' +
          '<button onclick="document.getElementById(\'sp-dl-popup-overlay\').remove()" style="' +
              'background:none;border:none;color:rgba(255,255,255,.4);font-size:1.1rem;' +
              'cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1"' +
            ' onmouseover="this.style.color=\'#fff\'" onmouseout="this.style.color=\'rgba(255,255,255,.4)\'">' +
            '&times;' +
          '</button>' +
        '</div>' +
        masteredSection +
        unmasteredSection +
      '</div>';

    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  };

  window._spDownloadMix = function (fmt, type) {
    // Close popup if open
    var popup = document.getElementById('sp-dl-popup-overlay');
    if (popup) popup.remove();
    var mixType = type || 'mastered'; // 'mastered' | 'unmastered'
    // Trigger download
    var a = document.createElement('a');
    a.href = '/api/stem-mix/' + _jobId + '?fmt=' + fmt + '&type=' + mixType;
    a.download = 'stems_mix_' + mixType + '.' + fmt;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); }, 500);
  };

  // Per-stem download picker — small inline popover anchored to the download button
  window._spDownloadStemPicker = function (stemName, isAdvStr, anchorBtn) {
    var existing = document.getElementById('sp-stem-dl-popup');
    if (existing) { existing.remove(); if (existing._anchor === anchorBtn) return; }
    var canWav = (_userPlan === 'pro' || _userPlan === 'developer');
    var customLabel = _stemLabels[stemName] || _capFirst(stemName);
    var popup = document.createElement('div');
    popup.id = 'sp-stem-dl-popup';
    popup._anchor = anchorBtn;
    popup.style.cssText = [
      'position:fixed', 'z-index:9999999',
      'background:#0f0f1a', 'border:1px solid rgba(255,255,255,.14)',
      'border-radius:10px', 'padding:10px 12px',
      'box-shadow:0 12px 40px rgba(0,0,0,.85)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'min-width:160px'
    ].join(';');

    // Stem download always uses the /api/stem-audio proxy route
    var mp3Url = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(stemName) + '?dl=1&fmt=mp3';
    var wavUrl = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(stemName) + '?dl=1&fmt=wav';
    var safeName = (_stemLabels[stemName] || stemName).replace(/[^a-z0-9_\-]/gi, '_');
    var mp3DlName = safeName + '_stem.mp3';
    var wavDlName = safeName + '_stem.wav';
    var wavLabel  = 'WAV <span style="font-weight:400;opacity:.6;font-size:.68rem">Lossless · Pro</span>';

    popup.innerHTML =
      '<div style="font-size:.68rem;color:rgba(255,255,255,.35);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">' +
        '<i class="fas fa-download" style="margin-right:5px;color:#4e9fff"></i>Download ' + _escHtml(customLabel) +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:5px">' +
        '<a href="' + mp3Url + '" download="' + mp3DlName + '"' +
            ' onclick="document.getElementById(\'sp-stem-dl-popup\').remove()"' +
            ' style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;' +
              'border:1px solid rgba(78,159,255,.35);background:rgba(78,159,255,.08);' +
              'color:#4e9fff;text-decoration:none;font-size:.75rem;font-weight:600;transition:background .12s"' +
            ' onmouseover="this.style.background=\'rgba(78,159,255,.2)\'"' +
            ' onmouseout="this.style.background=\'rgba(78,159,255,.08)\'">' +
          '<i class="fas fa-file-audio" style="font-size:.85rem"></i>' +
          '<span>MP3 <span style="font-weight:400;opacity:.6;font-size:.68rem">Compressed</span></span>' +
        '</a>' +
        (canWav
          ? '<a href="' + wavUrl + '" download="' + wavDlName + '"' +
                ' onclick="document.getElementById(\'sp-stem-dl-popup\').remove()"' +
                ' style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;' +
                  'border:1px solid rgba(168,85,247,.35);background:rgba(168,85,247,.08);' +
                  'color:#c084fc;text-decoration:none;font-size:.75rem;font-weight:600;transition:background .12s"' +
                ' onmouseover="this.style.background=\'rgba(168,85,247,.2)\'"' +
                ' onmouseout="this.style.background=\'rgba(168,85,247,.08)\'">' +
              '<i class="fas fa-wave-square" style="font-size:.85rem"></i>' +
              '<span>' + wavLabel + '</span>' +
            '</a>'
          : '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;' +
                'border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.02);' +
                'color:rgba(255,255,255,.25);font-size:.75rem;cursor:not-allowed">' +
              '<i class="fas fa-wave-square" style="font-size:.85rem"></i>' +
              '<span>WAV <a href="/pricing" style="color:#a855f6;text-decoration:none;font-size:.68rem" onclick="event.stopPropagation()">· Pro only</a></span>' +
            '</div>'
        ) +
      '</div>';

    // Position below anchor button
    document.body.appendChild(popup);
    var rect = anchorBtn.getBoundingClientRect();
    var popW = popup.offsetWidth || 180;
    var left = Math.min(rect.left, window.innerWidth - popW - 8);
    popup.style.top  = (rect.bottom + 6) + 'px';
    popup.style.left = Math.max(8, left) + 'px';

    // Close on outside click
    setTimeout(function() {
      document.addEventListener('click', function _closeStemDl(e) {
        if (!popup.contains(e.target) && e.target !== anchorBtn) {
          popup.remove();
          document.removeEventListener('click', _closeStemDl);
        }
      });
    }, 10);
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  TRACK ROW
  // ─────────────────────────────────────────────────────────────────────────
  // Build a single stem track row (mixer row).
  function _buildTrackRow(s, i, isAdv) {
    var color = STEM_COLORS[s.name] || STEM_COLORS.default;
    var customLabel = _stemLabels[s.name] || _capFirst(s.name);

    // Rename pencil — inline edit on click
    var renameBtn =
      '<button onclick="window._spRenameStart(' + i + ',\'' + _escHtml(s.name) + '\')" title="Rename stem" style="' +
        'flex-shrink:0;background:none;border:none;padding:0 2px;cursor:pointer;' +
        'color:rgba(255,255,255,0.2);font-size:.62rem;line-height:1;transition:color .15s"' +
        ' onmouseover="this.style.color=\'rgba(255,255,255,0.55)\'" onmouseout="this.style.color=\'rgba(255,255,255,0.2)\'">' +
        '<i class="fas fa-pencil"></i>' +
      '</button>';

    // Name block
    var nameBlock =
      '<div style="width:82px;flex-shrink:0;display:flex;flex-direction:column;gap:1px;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:3px">' +
          '<span id="sp-label-' + i + '" style="font-size:.74rem;font-weight:600;color:#f1f5f9;' +
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:56px">' +
            _escHtml(customLabel) +
          '</span>' +
          renameBtn +
        '</div>' +
      '</div>';

    var row =
      '<div style="display:flex;align-items:center;gap:7px;padding:8px 16px;' +
          'border-bottom:1px solid rgba(255,255,255,0.04);transition:background .15s"' +
          ' onmouseover="this.style.background=\'rgba(255,255,255,.02)\'"' +
          ' onmouseout="this.style.background=\'none\'">' +

        // color bar
        '<div style="width:2.5px;height:28px;border-radius:2px;background:' + color + ';flex-shrink:0"></div>' +

        // name block with rename
        nameBlock +

        // S button
        '<button id="sp-solo-' + i + '" onclick="window._spSolo(' + i + ')" title="Solo" style="' +
            'width:22px;height:22px;flex-shrink:0;border-radius:4px;' +
            'border:1px solid rgba(255,255,255,0.13);background:rgba(255,255,255,0.04);' +
            'color:rgba(255,255,255,0.48);font-size:.6rem;font-weight:700;cursor:pointer;transition:all .15s">S</button>' +

        // M button
        '<button id="sp-mute-' + i + '" onclick="window._spMute(' + i + ')" title="Mute" style="' +
            'width:22px;height:22px;flex-shrink:0;border-radius:4px;' +
            'border:1px solid rgba(255,255,255,0.13);background:rgba(255,255,255,0.04);' +
            'color:rgba(255,255,255,0.48);font-size:.6rem;font-weight:700;cursor:pointer;transition:all .15s">M</button>' +

        // waveform
        '<div style="flex:1;position:relative;height:32px;border-radius:5px;overflow:hidden;' +
            'cursor:pointer;background:rgba(255,255,255,0.025)" onclick="window._spSeekWave(event,this)">' +
          '<canvas id="sp-wave-' + i + '" width="400" height="32" style="position:absolute;inset:0;width:100%;height:100%"></canvas>' +
          '<div id="sp-wave-prog-' + i + '" style="position:absolute;top:0;left:0;bottom:0;width:0%;' +
              'background:rgba(255,255,255,0.07);pointer-events:none"></div>' +
          '<div id="sp-wave-line-' + i + '" style="position:absolute;top:0;left:0;bottom:0;width:0%;' +
              'border-right:1.5px solid rgba(255,255,255,0.4);pointer-events:none"></div>' +
        '</div>' +

        // volume slider
        '<input type="range" min="0" max="1" step="0.01" value="1"' +
          ' oninput="window._spVol(' + i + ',parseFloat(this.value))"' +
          ' title="Volume"' +
          ' style="width:48px;flex-shrink:0;accent-color:' + color + ';cursor:pointer">' +

        // Per-stem download icon — ORIGINAL audio
        (_userPlan !== 'free'
          ? '<button onclick="window._spDownloadStemPicker(\'' + _escHtml(s.name) + '\',\'0\',this)" ' +
              'title="Download ' + _escHtml(customLabel) + '" style="' +
              'flex-shrink:0;background:none;border:none;padding:0 3px;cursor:pointer;' +
              'color:rgba(255,255,255,0.28);font-size:.78rem;display:flex;align-items:center;' +
              'justify-content:center;width:20px;height:20px;transition:color .15s"' +
            ' onmouseover="this.style.color=\'#4e9fff\'" onmouseout="this.style.color=\'rgba(255,255,255,0.28)\'">' +
            '<i class="fas fa-download"></i>' +
          '</button>'
          : '<button onclick="window.location=\'/pricing\'" title="Upgrade to download" style="' +
              'flex-shrink:0;background:none;border:none;padding:0 3px;cursor:pointer;' +
              'color:rgba(255,200,0,0.3);font-size:.72rem;display:flex;align-items:center;' +
              'justify-content:center;width:20px;height:20px">' +
            '<i class="fas fa-lock"></i>' +
          '</button>'
        ) +

      '</div>';

    return row;
  }

  // _buildRegenSectionRow and _spToggleOrig removed — regen feature moved to card menu

  // Inline rename: replaces label span with a tiny input field
  window._spRenameStart = function (idx, stemName) {
    var labelEl = _panel && _panel.querySelector('#sp-label-' + idx);
    if (!labelEl) return;
    var current = _stemLabels[stemName] || _capFirst(stemName);
    var input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.maxLength = 24;
    input.style.cssText = 'width:54px;font-size:.74rem;font-weight:600;color:#f1f5f9;' +
      'background:rgba(255,255,255,0.08);border:1px solid rgba(78,159,255,0.6);' +
      'border-radius:3px;padding:1px 4px;outline:none;';
    function commit() {
      var v = input.value.trim();
      if (v) _stemLabels[stemName] = v;
      labelEl.textContent = _stemLabels[stemName] || _capFirst(stemName);
      labelEl.style.display = '';
      if (input.parentNode) input.parentNode.replaceChild(labelEl, input);
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { if (input.parentNode) input.parentNode.replaceChild(labelEl, input); }
    });
    labelEl.style.display = 'none';
    labelEl.parentNode.insertBefore(input, labelEl);
    input.focus();
    input.select();
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  WAVEFORM
  // ─────────────────────────────────────────────────────────────────────────
  function _drawWaveform(canvas, color) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    var bars = 80, gap = 2;
    var bw = (W - gap * (bars - 1)) / bars;
    var seed = color.split('').reduce(function (a, c) { return a + c.charCodeAt(0); }, 0);
    function rand() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (var i = 0; i < bars; i++) {
      var t = i / (bars - 1);
      var env = Math.sin(t * Math.PI) * 0.7 + 0.3;
      var h = (rand() * 0.6 + 0.25) * env * H;
      var x = i * (bw + gap);
      var y = (H - h) / 2;
      var grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, color + 'cc');
      grad.addColorStop(0.5, color);
      grad.addColorStop(1, color + '77');
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, bw, h, 1); } else { ctx.rect(x, y, bw, h); }
      ctx.fill();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PLAYBACK
  // ─────────────────────────────────────────────────────────────────────────
  window._spPlay = function () {
    if (!_audios.length) return;
    if (_playing) {
      // Pause — cancel any in-flight play() to avoid AbortError
      _playPending = false;
      _audios.forEach(function (a) { try { a.pause(); } catch(e){} });
      _playing = false;
      _updatePlayIcon();
      _stopRaf();
      return;
    }
    // Guard: if a play() is still resolving, ignore rapid re-clicks
    if (_playPending) return;
    _playPending = true;
    // Sync all tracks to track 0 time before playing.
    // Read currentTime BEFORE touching any element — some browsers update it asynchronously.
    var refTime = (_audios[0] && !isNaN(_audios[0].currentTime)) ? _audios[0].currentTime : 0;
    // Set ALL audio elements (including index 0) to refTime so they're in sync.
    // Skipping index 0 was a bug — if the browser dropped its buffer on pause the
    // element could silently reset to 0; re-asserting ensures it starts at the right position.
    _audios.forEach(function (a) { try { a.currentTime = refTime; } catch(e){} });
    // Collect all play() promises
    var promises = [];
    _audios.forEach(function (a) {
      // Only try to play if we have a real src (not empty or about:blank)
      var src = a.src || '';
      if (src && src.indexOf('/api/stem-audio/') !== -1) {
        var p = a.play();
        if (p) promises.push(p);
      }
    });
    if (promises.length === 0) {
      _playPending = false;
      console.warn('[StemPlayer] No playable audio sources found');
      return;
    }
    // Optimistically update UI immediately — revert if all fail
    _playing = true;
    _updatePlayIcon();
    _startRaf();  // start the rAF timeline loop
    // Track resolutions — clear _playPending once at least one resolves
    var settled = false;
    var failCount = 0;
    promises.forEach(function (p) {
      if (p && p.then) {
        p.then(function () {
          if (!settled) { settled = true; _playPending = false; }
        });
      }
      if (p && p.catch) {
        p.catch(function (e) {
          failCount++;
          if (!settled) { settled = true; _playPending = false; }
          // Suppress expected AbortError when pause() races play()
          if (e && e.name === 'AbortError') return;
          console.warn('[StemPlayer] play() rejected:', e.name, e.message);
          if (failCount === promises.length) {
            // All failed — revert
            _playing = false;
            _updatePlayIcon();
            console.error('[StemPlayer] ALL stems failed to play. Check browser console for onerror details.');
          }
        });
      }
    });
  };

  window._spSeek = function (e) {
    var wrap = _panel && _panel.querySelector('#sp-timeline-wrap');
    if (!wrap || !_audios.length) return;
    var rect = wrap.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var dur  = _audios[0] ? _audios[0].duration : 0;
    if (!dur || isNaN(dur)) return;
    var t = pct * dur;
    // Update UI immediately so it feels instant, then let rAF keep it in sync
    _updateTimeline(t, dur);
    // Seek all audio elements — browser will settle to actual position asynchronously
    _audios.forEach(function (a) { try { a.currentTime = t; } catch(ee){} });
    // Run a short rAF burst so UI snaps to the real settled time
    _rafSeekBurst();
  };

  window._spSeekWave = function (e, el) {
    var rect = el.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (!_audios.length) return;
    var dur = _audios[0] ? _audios[0].duration : 0;
    if (!dur || isNaN(dur)) return;
    var t = pct * dur;
    // Update UI immediately so it feels instant
    _updateTimeline(t, dur);
    // Seek all audio elements
    _audios.forEach(function (a) { try { a.currentTime = t; } catch(ee){} });
    // Run a short rAF burst so UI snaps to the real settled time
    _rafSeekBurst();
  };

  window._spSolo = function (idx) {
    var s = _stems[idx];
    if (!s) return;
    var wasSolo = s.solo;
    // Clear solo on ALL tracks
    _stems.forEach(function (st) { st.solo = false; });
    // Toggle: if it wasn't solo, enable it; if it was solo, leave off (deactivate)
    if (!wasSolo) s.solo = true;
    var anySolo = _stems.some(function (x) { return x.solo; });

    _stems.forEach(function (st, i) {
      var active = !anySolo || st.solo;

      // ── Update S button ──────────────────────────────────────────
      var sb = _panel && _panel.querySelector('#sp-solo-' + i);
      if (sb) {
        sb.style.background  = st.solo ? 'rgba(250,204,21,0.22)' : 'rgba(255,255,255,0.04)';
        sb.style.borderColor = st.solo ? '#facc15'               : 'rgba(255,255,255,0.13)';
        sb.style.color       = st.solo ? '#facc15'               : 'rgba(255,255,255,0.48)';
      }

      // ── Update M button ──────────────────────────────────────────
      var mb = _panel && _panel.querySelector('#sp-mute-' + i);
      if (mb) {
        if (st.solo) {
          // This track IS the solo track — always clear its mute (can't be both)
          st.muted = false;
          mb.style.background  = 'rgba(255,255,255,0.04)';
          mb.style.borderColor = 'rgba(255,255,255,0.13)';
          mb.style.color       = 'rgba(255,255,255,0.48)';
        } else if (anySolo) {
          // Another track is soloed — show this M as silenced-by-solo (orange)
          mb.style.background  = 'rgba(251,146,60,0.18)';
          mb.style.borderColor = 'rgba(251,146,60,0.4)';
          mb.style.color       = 'rgba(251,146,60,0.7)';
        } else {
          // No solo active — restore each M to its real muted/unmuted state
          if (st.muted) {
            mb.style.background  = 'rgba(239,68,68,0.22)';
            mb.style.borderColor = '#ef4444';
            mb.style.color       = '#ef4444';
          } else {
            mb.style.background  = 'rgba(255,255,255,0.04)';
            mb.style.borderColor = 'rgba(255,255,255,0.13)';
            mb.style.color       = 'rgba(255,255,255,0.48)';
          }
        }
      }

      // ── Update audio volume ──────────────────────────────────────
      if (_audios[i]) _audios[i].volume = st.muted ? 0 : (active ? st.vol : 0);
    });
  };

  window._spMute = function (idx) {
    var s = _stems[idx];
    if (!s) return;
    // FIX: muting a soloed track — clear solo first (can't be both)
    if (s.solo) {
      s.solo = false;
      var sb = _panel && _panel.querySelector('#sp-solo-' + idx);
      if (sb) {
        sb.style.background  = 'rgba(255,255,255,0.04)';
        sb.style.borderColor = 'rgba(255,255,255,0.13)';
        sb.style.color       = 'rgba(255,255,255,0.48)';
      }
      // also reset all other tracks' M buttons that were lit orange by solo
      _stems.forEach(function (st, i) {
        if (i === idx) return;
        var mb = _panel && _panel.querySelector('#sp-mute-' + i);
        if (mb && !st.muted) {
          mb.style.background  = 'rgba(255,255,255,0.04)';
          mb.style.borderColor = 'rgba(255,255,255,0.13)';
          mb.style.color       = 'rgba(255,255,255,0.48)';
        }
        // restore volume on other tracks
        if (_audios[i]) _audios[i].volume = st.muted ? 0 : st.vol;
      });
    }
    s.muted = !s.muted;
    if (_audios[idx]) {
      var anySolo = _stems.some(function (x) { return x.solo; });
      var active  = !anySolo || s.solo;
      _audios[idx].volume = s.muted ? 0 : (active ? s.vol : 0);
    }
    var btn = _panel && _panel.querySelector('#sp-mute-' + idx);
    if (btn) {
      btn.style.background  = s.muted ? 'rgba(239,68,68,0.22)' : 'rgba(255,255,255,0.04)';
      btn.style.borderColor = s.muted ? '#ef4444' : 'rgba(255,255,255,0.13)';
      btn.style.color       = s.muted ? '#ef4444' : 'rgba(255,255,255,0.48)';
    }
  };

  window._spVol = function (idx, vol) {
    var s = _stems[idx];
    if (!s) return;
    s.vol = vol;
    if (_audios[idx] && !s.muted) {
      var anySolo = _stems.some(function (x) { return x.solo; });
      _audios[idx].volume = (!anySolo || s.solo) ? vol : 0;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  RE-EXTRACT
  // ─────────────────────────────────────────────────────────────────────────
  window._spReExtract = function (mode) {
    _stopAllAudio();
    _playing = false;
    _stems = [];
    _audios = [];
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    var tracksEl = _panel && _panel.querySelector('#sp-tracks');
    var playbar  = _panel && _panel.querySelector('#sp-playbar');
    if (tracksEl) { tracksEl.style.display = 'none'; tracksEl.innerHTML = ''; }
    if (playbar)  playbar.style.display = 'none';
    _onTabClick(mode || _activeTab || 'auto');
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  TIMELINE UI
  // ─────────────────────────────────────────────────────────────────────────
  function _updateTimeline(cur, dur) {
    if (!dur || isNaN(dur) || !isFinite(dur)) return;
    var pct = (cur / dur * 100).toFixed(2);
    var fill  = _panel && _panel.querySelector('#sp-timeline-fill');
    var thumb = _panel && _panel.querySelector('#sp-timeline-thumb');
    var curEl = _panel && _panel.querySelector('#sp-time-cur');
    if (fill)  fill.style.width  = pct + '%';
    if (thumb) thumb.style.left  = pct + '%';
    if (curEl) curEl.textContent = _fmtTime(cur);
    _stems.forEach(function (s, i) {
      var prog = _panel && _panel.querySelector('#sp-wave-prog-' + i);
      var line = _panel && _panel.querySelector('#sp-wave-line-' + i);
      if (prog) prog.style.width = pct + '%';
      if (line) line.style.width = pct + '%';
    });
  }

  function _updateDuration(dur) {
    var el = _panel && _panel.querySelector('#sp-time-tot');
    if (el) el.textContent = _fmtTime(dur);
  }

  function _updatePlayIcon() {
    var icon = _panel && _panel.querySelector('#sp-play-icon');
    if (icon) icon.className = _playing ? 'fas fa-pause' : 'fas fa-play';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  CLEANUP
  // ─────────────────────────────────────────────────────────────────────────
  function _stopAllAudio() {
    _stopRaf();
    _playPending = false;
    _audios.forEach(function (a) { try { a.pause(); a.src = ''; } catch (e) {} });
    _audios = [];
    // Also stop any "Original" comparison audio previews
    _stopOrigPreviews();
  }

  function _stopOrigPreviews() {
    if (!_panel) return;
    _panel.querySelectorAll('[data-audio-id]').forEach(function(btn) {
      var a = document.getElementById(btn.getAttribute('data-audio-id'));
      if (a && !a.paused) {
        a.pause();
        a.currentTime = 0;
        var ico = btn.querySelector('i');
        if (ico) ico.className = 'fas fa-play';
        btn.style.background = 'rgba(255,255,255,0.06)';
      }
    });
  }

  function _cleanup() {
    _stopAllAudio();
    _playing = false;
    _stems = [];
    _advStems = [];
    _origStemUrls = {};
    _stemLabels = {};
    _advStemsReset = false;
    _activeTab = null;
    _curTaskId = null;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    document.removeEventListener('keydown', _onKey);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  UTILS
  // ─────────────────────────────────────────────────────────────────────────
  function _fmtTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function _capFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
  }

  function _escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

}()); // end stem player IIFE

// ═══════════════════════════════════════════════════════════════════════════
//  EDIT SONG — Save Changes
//  Called by the "Save changes" button in the song-edit-modal.
//  Reads all form fields and POSTs to /api/job/update.
// ═══════════════════════════════════════════════════════════════════════════
window.saveSongEdit = function () {
  var jobId = (document.getElementById('edit-job-id') || {}).value;
  if (!jobId) {
    alert('No track selected.');
    return;
  }

  var title       = (document.getElementById('edit-title')       || {}).value || '';
  var lyrics      = (document.getElementById('edit-lyrics')      || {}).value || '';
  var bpm         = (document.getElementById('edit-bpm')         || {}).value || '';
  var genre       = (document.getElementById('edit-genre')       || {}).value || '';
  var description = (document.getElementById('edit-description') || {}).value || '';

  var btn = document.getElementById('edit-save-btn');
  var origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
  }

  fetch('/api/job/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, title: title, lyrics: lyrics, bpm: bpm, genre: genre, description: description })
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    if (data.ok) {
      if (btn) {
        btn.innerHTML = '<i class="fas fa-check"></i> Saved!';
        btn.style.background = 'rgba(34,197,94,.18)';
        btn.style.borderColor = '#22c55e';
        btn.style.color = '#22c55e';
        setTimeout(function () {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
          }
        }, 1800);
      }
      // Update the in-memory cache so cards re-render with the new title
      if (window._sfProjects && window._sfProjects[jobId]) {
        window._sfProjects[jobId].title = title;
        if (window._sfProjects[jobId].blueprint) {
          if (bpm) window._sfProjects[jobId].blueprint.bpm = parseInt(bpm, 10);
          if (genre) window._sfProjects[jobId].blueprint.genre = genre;
          if (description) window._sfProjects[jobId].blueprint.arrangement = description;
        }
        window._sfProjects[jobId].user_lyrics = lyrics;
      }
      // ── Live-update any visible project card that matches this job ──────────
      // Update data attrs, the h4 title, the subtitle <p>, and redraw canvas art
      (function syncCards() {
        var cards = document.querySelectorAll('.project-card[data-id="' + jobId + '"]');
        cards.forEach(function (card) {
          // Update stored attrs
          if (title) card.dataset.title = title;
          if (genre) card.dataset.genre = genre;
          // Update visible title (h4)
          var h4 = card.querySelector('h4');
          if (h4 && title) h4.textContent = title;
          // Update subtitle <p> — it shows genre/bpm
          var sub = card.querySelector('.project-card__body > p');
          if (sub) {
            var parts = [];
            if (genre) parts.push(genre);
            if (bpm)   parts.push(bpm + ' BPM');
            if (parts.length) sub.textContent = parts.join(' · ');
          }
          // Redraw canvas art with new genre label
          var artEl = card.querySelector('.project-card__art');
          var hue   = parseInt(card.dataset.hue || '180', 10);
          if (artEl && window.drawCanvasArt) {
            window.drawCanvasArt(artEl, hue, title || card.dataset.title, genre || card.dataset.genre || 'music');
          }
        });
      })();
      // Close modal after short delay
      setTimeout(function () { if (window.closeSongEditModal) window.closeSongEditModal(); }, 1200);
    } else {
      alert(data.error || 'Save failed. Please try again.');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  })
  .catch(function (err) {
    console.error('[saveSongEdit] error:', err);
    alert('Network error. Please try again.');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  EDIT SONG — Instrument Pills (enhanced)
//  Overrides the existing renderEditInstrumentPills from app_base_final.js
//  to handle both bp.instruments_include (strings) and bp.instruments (objects)
//  so all tracks — past and future — show their instruments as highlighted pills.
// ═══════════════════════════════════════════════════════════════════════════
window.renderEditInstrumentPills = function (bp) {
  var group     = document.getElementById('edit-instruments-group');
  var container = document.getElementById('edit-blueprint-pills');
  if (!group || !container) return;

  // Collect instruments from either field
  var pills = [];

  // 1. bp.instruments — array of {family, name} objects (from GPT blueprint)
  if (bp && bp.instruments && bp.instruments.length > 0) {
    bp.instruments.forEach(function (ins) {
      pills.push({ name: typeof ins === 'object' ? ins.name : ins,
                   family: typeof ins === 'object' ? ins.family : null });
    });
  }

  // 2. bp.instruments_include — array of strings (from user form input)
  if (bp && bp.instruments_include && bp.instruments_include.length > 0) {
    // Merge: only add entries not already covered by bp.instruments
    var existingNames = pills.map(function (p) { return (p.name || '').toLowerCase(); });
    bp.instruments_include.forEach(function (ins) {
      var name = typeof ins === 'object' ? ins.name : ins;
      if (existingNames.indexOf((name || '').toLowerCase()) === -1) {
        pills.push({ name: name, family: null });
      }
    });
  }

  if (pills.length === 0) {
    group.style.display = 'none';
    return;
  }

  var familyIconMap = {
    drums: 'fa-drum', bass: 'fa-guitar', keys: 'fa-keyboard',
    guitar: 'fa-guitar', strings: 'fa-music', brass: 'fa-music',
    woodwind: 'fa-music', synth: 'fa-wave-square', fx: 'fa-wand-magic-sparkles',
    vocals: 'fa-microphone', default: 'fa-music'
  };

  container.innerHTML = '';
  pills.forEach(function (pill) {
    var name   = pill.name || '';
    var family = pill.family;
    if (!family) {
      var lower = name.toLowerCase();
      if (lower.includes('kick') || lower.includes('snare') || lower.includes('drum') || lower.includes('hi-hat') || lower.includes('hat')) family = 'drums';
      else if (lower.includes('bass')) family = 'bass';
      else if (lower.includes('synth') || lower.includes('pad')) family = 'synth';
      else if (lower.includes('guitar')) family = 'guitar';
      else if (lower.includes('piano') || lower.includes('key') || lower.includes('rhodes')) family = 'keys';
      else if (lower.includes('vocal') || lower.includes('chop')) family = 'vocals';
      else if (lower.includes('fx') || lower.includes('effect')) family = 'fx';
      else family = 'default';
    }
    var icon = familyIconMap[family] || familyIconMap.default;
    var el = document.createElement('span');
    el.className = 'blueprint-pill blueprint-pill--instr';
    el.innerHTML = '<i class="fas ' + icon + '"></i> ' + name;
    container.appendChild(el);
  });

  group.style.display = '';
};

// ══ Song Extend — Upload-based workflow with waveform scrubber ═══════════════
(function initExtendUpload() {
  var extUploadAudioId = null;  // Mureka upload_audio_id (purpose=audio)
  var extUploadTitle   = '';    // filename (no extension)
  var extExtendAtMs    = 0;     // current scrubber position in ms
  var extAudioDuration = 0;     // total track duration in seconds
  var extIsPlaying     = false;
  var extRafId         = null;  // requestAnimationFrame id for playhead updates
  var extWaveData      = null;  // Float32Array of normalised peak amplitudes

  // ── Drag-and-drop on upload zone ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var zone = document.getElementById('ext-upload-zone');
    if (!zone) return;
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.style.borderColor = 'rgba(78,159,255,.7)';
      zone.style.background  = 'rgba(78,159,255,.1)';
    });
    zone.addEventListener('dragleave', function () {
      zone.style.borderColor = '';
      zone.style.background  = '';
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.style.borderColor = '';
      zone.style.background  = '';
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var ext = (file.name || '').split('.').pop().toLowerCase();
      var mimeOk = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || file.type === 'audio/wav' || file.type === 'audio/wave' || file.type === 'audio/x-wav';
      var extOk  = ext === 'mp3' || ext === 'wav';
      if (!mimeOk && !extOk) {
        var errEl = document.getElementById('ext-upload-error');
        if (errEl) {
          errEl.textContent = 'Only MP3 or WAV files are supported.';
          errEl.style.display = 'block';
        }
        return;
      }
      extUploadFile(file);
    });

    // Scrubber: mouse/touch drag on the scrubber wrap
    var wrap = document.getElementById('ext-scrubber-wrap');
    if (wrap) {
      wrap.addEventListener('mousemove', function(e) { extScrubHover(e, wrap); });
      wrap.addEventListener('mouseleave', function() {
        var tt = document.getElementById('ext-scrub-tooltip');
        if (tt) tt.style.display = 'none';
      });
      // Touch scrub
      wrap.addEventListener('touchmove', function(e) {
        e.preventDefault();
        extScrubClick(e.touches[0], wrap);
      }, { passive: false });
    }
  });

  // ── Called by file input onchange ─────────────────────────────────────────
  window.extHandleFileSelect = function(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    // Validate MP3 or WAV
    var ext = (file.name || '').split('.').pop().toLowerCase();
    var mimeOk = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || file.type === 'audio/wav' || file.type === 'audio/wave' || file.type === 'audio/x-wav';
    var extOk  = ext === 'mp3' || ext === 'wav';
    if (!mimeOk && !extOk) {
      var errEl = document.getElementById('ext-upload-error');
      if (errEl) {
        errEl.textContent = 'Only MP3 or WAV files are supported.';
        errEl.style.display = 'block';
      }
      // Reset the input so user can try again
      if (input) input.value = '';
      return;
    }
    extUploadFile(file);
  };

  // ── State helpers ─────────────────────────────────────────────────────────
  function setExtZoneState(state, filename) {
    var idle    = document.getElementById('ext-upload-idle');
    var loading = document.getElementById('ext-upload-loading');
    var done    = document.getElementById('ext-upload-done');
    var nameEl  = document.getElementById('ext-upload-name');
    var errEl   = document.getElementById('ext-upload-error');
    var nextBtn = document.getElementById('ext-upload-next-btn');
    if (idle)    idle.style.display    = (state === 'idle')    ? 'flex' : 'none';
    if (loading) loading.style.display = (state === 'loading') ? 'flex' : 'none';
    if (done)    done.style.display    = (state === 'done')    ? 'flex' : 'none';
    if (errEl)   errEl.style.display   = 'none';
    if (nameEl && filename) nameEl.textContent = filename;
    if (nextBtn) nextBtn.style.display = (state === 'done') ? 'block' : 'none';
  }

  // ── Upload file to /api/upload-extend-audio (file blob → R2 → MusicAPI) ──
  function extUploadFile(file) {
    var errEl = document.getElementById('ext-upload-error');
    if (errEl) errEl.style.display = 'none';
    setExtZoneState('loading');
    var name = file.name || 'track';
    extUploadTitle = name.replace(/\.[^.]+$/, '');

    // Load file into local audio element for scrubbing (happens regardless of upload result)
    var audio = document.getElementById('ext-preview-audio');
    if (audio) {
      var localUrl = URL.createObjectURL(file);
      audio.src = localUrl;
      audio.onloadedmetadata = function() {
        extAudioDuration = audio.duration;
        extExtendAtMs = 0;
        var durLabel = document.getElementById('ext-duration-label');
        if (durLabel) durLabel.textContent = extFmtTime(extAudioDuration);
        extUpdateScrubberUI(1.0);
        extDrawWaveform(file);
      };
    }

    // Send file as multipart — backend stores it in R2 and passes the proxy URL to MusicAPI
    var fd = new FormData();
    fd.append('file', file);

    fetch('/api/upload-extend-audio', { method: 'POST', credentials: 'include', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);
        // R2 proxy flow — backend returns audio_url directly (current flow)
        if (data.audio_url || data.status === 'ready') {
          extUploadAudioId = data.audio_url || data.clip_id;
          setExtZoneState('done', name);
          return;
        }
        // Legacy: clip_id returned directly
        if (data.clip_id) {
          extUploadAudioId = data.clip_id;
          setExtZoneState('done', name);
          return;
        }
        // Async fallback: if a task_id comes back, poll for it
        var taskId = data.task_id || data.upload_task_id;
        if (taskId) {
          setExtZoneState('loading');
          _extPollUploadTask(taskId, name, 0);
          return;
        }
        throw new Error('Upload failed — please try again.');
      })
      .catch(function(err) {
        setExtZoneState('idle');
        if (errEl) {
          errEl.textContent = 'Upload failed: ' + (err.message || 'Unknown error');
          errEl.style.display = 'block';
        }
      });
  }

  // Poll /api/poll-upload-task/:taskId until clip_id is ready (async fallback only)
  function _extPollUploadTask(taskId, name, attempt) {
    var errEl = document.getElementById('ext-upload-error');
    if (attempt > 40) { // ~3.3 minutes max
      setExtZoneState('idle');
      if (errEl) { errEl.textContent = 'Upload timed out — please try again.'; errEl.style.display = 'block'; }
      return;
    }
    setTimeout(function() {
      fetch('/api/poll-upload-task/' + encodeURIComponent(taskId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) throw new Error(data.error);
          if (data.status === 'ready' && data.clip_id) {
            extUploadAudioId = data.clip_id;
            setExtZoneState('done', name);
          } else if (data.status === 'failed') {
            throw new Error(data.error || 'Upload processing failed');
          } else {
            _extPollUploadTask(taskId, name, attempt + 1);
          }
        })
        .catch(function(err) {
          setExtZoneState('idle');
          if (errEl) { errEl.textContent = 'Upload failed: ' + (err.message || 'Unknown error'); errEl.style.display = 'block'; }
        });
    }, attempt === 0 ? 3000 : 5000);
  }

  // ── Draw waveform on canvas using Web Audio API ───────────────────────────
  function extDrawWaveform(file) {
    var canvas = document.getElementById('ext-waveform-canvas');
    if (!canvas || (!window.AudioContext && !window.webkitAudioContext)) {
      extDrawFlatWaveform();
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      var actx = new (window.AudioContext || window.webkitAudioContext)();
      actx.decodeAudioData(e.target.result.slice(0), function(buffer) {
        // Downsample to bar count for peaks
        var dpr  = window.devicePixelRatio || 1;
        var W    = Math.round((canvas.offsetWidth || 300) * dpr);
        var H    = Math.round((canvas.offsetHeight || 54) * dpr);
        canvas.width  = W;
        canvas.height = H;
        // Use 3px bar pitch (same as stem player)
        var n    = Math.floor(W / 3);
        var data = buffer.getChannelData(0);
        var step = Math.max(1, Math.floor(data.length / n));
        var peaks = new Float32Array(n);
        for (var i = 0; i < n; i++) {
          var max = 0;
          for (var j = 0; j < step; j++) {
            var v = Math.abs(data[i * step + j] || 0);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        extWaveData = peaks;
        extPaintWaveform(0);
        actx.close();
      }, function() { extDrawFlatWaveform(); });
    };
    reader.readAsArrayBuffer(file);
  }

  function extDrawFlatWaveform() {
    var canvas = document.getElementById('ext-waveform-canvas');
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var W   = Math.round((canvas.offsetWidth || 300) * dpr);
    canvas.width  = W;
    canvas.height = Math.round(canvas.offsetHeight || 54) * dpr;
    // Smooth pseudo-waveform (sin + noise, looks realistic)
    var n     = Math.floor(W / 3);
    var peaks = new Float32Array(n);
    var phase = Math.random() * Math.PI * 2;
    for (var i = 0; i < n; i++) {
      var t   = i / n;
      var env = Math.sin(Math.PI * t);   // fade in+out at edges
      peaks[i] = env * (0.35 + 0.45 * Math.abs(Math.sin(t * 18 + phase)) + 0.2 * Math.random());
    }
    extWaveData = peaks;
    extPaintWaveform(0);
  }
  // Expose to window so other IIFEs (initSongExtend) can call it
  window.extDrawFlatWaveform = extDrawFlatWaveform;

  function extPaintWaveform(progress) {
    var canvas = document.getElementById('ext-waveform-canvas');
    if (!canvas || !extWaveData) return;
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.width;
    var H = canvas.height;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // ── Match stem player style: rounded bars, gradient fill ──
    var n     = extWaveData.length;
    var gap   = Math.max(1, Math.floor(W / n * 0.18));
    var barW  = Math.max(1, Math.floor(W / n) - gap);
    var split = Math.floor(progress * W);

    // Played gradient (cyan-blue)
    var gradPlayed = ctx.createLinearGradient(0, 0, 0, H);
    gradPlayed.addColorStop(0,   'rgba(79,195,247,1.0)');
    gradPlayed.addColorStop(0.5, 'rgba(78,159,255,0.85)');
    gradPlayed.addColorStop(1,   'rgba(78,159,255,0.5)');

    // Unplayed gradient (white muted)
    var gradRest = ctx.createLinearGradient(0, 0, 0, H);
    gradRest.addColorStop(0,   'rgba(255,255,255,0.30)');
    gradRest.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    gradRest.addColorStop(1,   'rgba(255,255,255,0.10)');

    for (var i = 0; i < n; i++) {
      var amp  = extWaveData[i];
      // Taller bars — 90% max height, 4px min
      var barH = Math.max(4, amp * H * 0.90);
      var x    = Math.floor((i / n) * W);
      var y    = Math.floor((H - barH) / 2);
      var r    = Math.min(barW / 2, 3); // corner radius

      ctx.fillStyle = (x < split) ? gradPlayed : gradRest;

      // Rounded rect
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, r);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barW, barH);
      }
    }

    // ── Extend-marker line (where user set the split point) ──
    if (extExtendAtMs > 0 && extAudioDuration > 0) {
      var markerPct = extExtendAtMs / (extAudioDuration * 1000);
      var mx = Math.floor(markerPct * W);
      ctx.save();
      ctx.strokeStyle = 'rgba(245,158,11,0.9)';
      ctx.lineWidth   = 2 * dpr;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, H);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Scrubber interactions ─────────────────────────────────────────────────
  window.extScrubClick = function(e, wrap) {
    if (!extAudioDuration) return;
    var rect = (wrap || document.getElementById('ext-scrubber-wrap')).getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // At the very end (last 1%), treat as "end of track" = default extend behaviour
    extExtendAtMs = pct >= 0.99 ? 0 : Math.round(pct * extAudioDuration * 1000);
    extUpdateScrubberUI(pct >= 0.99 ? 1.0 : pct);
    // Seek the audio element
    var audio = document.getElementById('ext-preview-audio');
    if (audio && extAudioDuration) audio.currentTime = pct * extAudioDuration;
  };

  function extScrubHover(e, wrap) {
    if (!extAudioDuration) return;
    var rect = wrap.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var tt   = document.getElementById('ext-scrub-tooltip');
    if (tt) {
      tt.style.display = 'block';
      tt.style.left    = (pct * 100) + '%';
      tt.textContent   = extFmtTime(pct * extAudioDuration);
    }
  }

  function extUpdateScrubberUI(pct) {
    var fill = document.getElementById('ext-scrubber-fill');
    var head = document.getElementById('ext-playhead');
    var badge = document.getElementById('ext-time-badge');
    if (fill)  fill.style.width  = (pct * 100) + '%';
    if (head)  head.style.left   = (pct * 100) + '%';
    // Show "End of track" when scrubber is at or very near the end
    if (badge) badge.textContent = (pct >= 0.999 || extExtendAtMs <= 0) ? 'End of track' : extFmtTime(extExtendAtMs / 1000);
    extPaintWaveform(pct);
  }
  // Expose to window so initSongExtend (different IIFE) can call it
  window.extUpdateScrubberUI = extUpdateScrubberUI;

  // ── Play / pause ──────────────────────────────────────────────────────────
  window.extTogglePlay = function() {
    var audio = document.getElementById('ext-preview-audio');
    if (!audio || !extAudioDuration) return;
    if (extIsPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
  };

  // Wire up audio events once (via delegation)
  document.addEventListener('DOMContentLoaded', function() {
    var audio = document.getElementById('ext-preview-audio');
    if (!audio) return;
    audio.onplay = function() {
      extIsPlaying = true;
      var icon = document.getElementById('ext-play-icon');
      var label = document.getElementById('ext-play-label');
      if (icon) icon.className = 'fas fa-pause';
      if (label) label.textContent = 'Pause';
      extRafLoop();
    };
    audio.onpause = audio.onended = function() {
      extIsPlaying = false;
      var icon = document.getElementById('ext-play-icon');
      var label = document.getElementById('ext-play-label');
      if (icon) icon.className = 'fas fa-play';
      if (label) label.textContent = 'Play';
      if (extRafId) { cancelAnimationFrame(extRafId); extRafId = null; }
    };
  });

  function extRafLoop() {
    var audio = document.getElementById('ext-preview-audio');
    if (!audio || !extAudioDuration) return;
    var pct = audio.currentTime / extAudioDuration;
    extExtendAtMs = Math.round(audio.currentTime * 1000);
    extUpdateScrubberUI(pct);
    if (extIsPlaying) extRafId = requestAnimationFrame(extRafLoop);
  }

  // ── "Next" button — show scrubber panel ───────────────────────────────────
  window.extGoToOptions = function() {
    if (!extUploadAudioId) return;
    var stepPick = document.getElementById('ext-step-pick');
    var stepOpts = document.getElementById('ext-step-options');
    var selTitle = document.getElementById('ext-sel-title');
    if (stepPick) stepPick.style.display = 'none';
    if (stepOpts) stepOpts.style.display = 'block';
    if (selTitle) selTitle.textContent = extUploadTitle || 'Uploaded Track';
    // Reset scrubber to end of track (default: append after track)
    extExtendAtMs = 0;
    extUpdateScrubberUI(1.0);
  };

  // ── "Change" — back to upload ─────────────────────────────────────────────
  window.extResetUpload = function() {
    extUploadAudioId = null;
    extUploadTitle   = '';
    extExtendAtMs    = 0;
    extAudioDuration = 0;
    extIsPlaying     = false;
    extWaveData      = null;
    if (extRafId) { cancelAnimationFrame(extRafId); extRafId = null; }
    var audio = document.getElementById('ext-preview-audio');
    if (audio) { try { audio.pause(); } catch(e) {} audio.src = ''; }
    var stepPick = document.getElementById('ext-step-pick');
    var stepOpts = document.getElementById('ext-step-options');
    if (stepPick) stepPick.style.display = 'block';
    if (stepOpts) stepOpts.style.display = 'none';
    setExtZoneState('idle');
    var fi = document.getElementById('ext-audio-file');
    if (fi) fi.value = '';
    var canvas = document.getElementById('ext-waveform-canvas');
    if (canvas) { var ctx2 = canvas.getContext('2d'); if (ctx2) ctx2.clearRect(0,0,canvas.width,canvas.height); }
    // Reset badge to "End of track"
    extUpdateScrubberUI(1.0);
  };

  // ── Format seconds → m:ss ────────────────────────────────────────────────
  function extFmtTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── Close popup → reset ───────────────────────────────────────────────────
  var _origClose = window.closeCreatorPopup;
  window.closeCreatorPopup = function(type) {
    if (type === 'extend') window.extResetUpload && window.extResetUpload();
    if (_origClose) _origClose(type);
  };

  // ── Override openCreatorPopup for 'extend' + close ref panel ─────────────
  var _origOpen = window.openCreatorPopup;
  window.openCreatorPopup = function(type) {
    // Always close the ref inline panel when any popup/tab is opened
    var refPanel = document.getElementById('ref-inline-panel');
    var refChev  = document.getElementById('ctab-ref-chevron');
    var refBtn   = document.getElementById('ctab-reference');
    if (refPanel && refPanel.style.display !== 'none') {
      refPanel.style.display = 'none';
      if (refChev) refChev.style.transform = '';
      if (refBtn && !window._refFileId) refBtn.classList.remove('active');
    }
    if (type === 'extend') {
      // Pro Artist only — but wait for _sfUser to be populated first.
      // On page load the auto-open fires at ~300ms; _sfUser may still be null.
      // Defaulting to 'free' here caused false "Pro Artist only" popups for Pro users.
      if (!window._sfUser) {
        // User data not yet loaded — retry in 600ms instead of blocking
        var _retryType = type;
        setTimeout(function() { window.openCreatorPopup(_retryType); }, 600);
        return;
      }
      var _extPlan = window._sfUser.plan || 'free';
      if (_extPlan !== 'pro' && _extPlan !== 'developer') {
        showProUpgradeModal('Song Extend');
        return;
      }
      // IMPORTANT: Do NOT clear _extendFromJobId here — the inner wrapper (initSongExtend)
      // reads it to auto-select the track. Only reset the upload state when there is NO
      // pre-selected job, so the modal doesn't flash blank before the auto-select runs.
      var _hasPendingJob = !!window._extendFromJobId;
      if (_origOpen) _origOpen(type);
      if (!_hasPendingJob) window.extResetUpload && window.extResetUpload();
      return;
    }
    if (_origOpen) _origOpen(type);
  };

  // ── Submit using uploaded audio ID ────────────────────────────────────────
  // ── Background poll for an extend job ────────────────────────────────────────
  // ui = optional object with creator-page pipeline elements to drive
  // ── Render one extended-track card (mirrors renderBeatCard style) ──────────
  function renderExtendedCard(p, i) {
    // Inline hue calculation — no dependency on out-of-scope hueFromIndex/hueFromId
    var hue;
    if (p.thumbnail_seed != null) {
      hue = p.thumbnail_seed;
    } else {
      // Golden-angle hash from index, fallback to id string hash
      if (i != null) {
        hue = ((Math.round(i) * 137) % 360 + 360) % 360;
      } else {
        var h = 0; var s = String(p.id || '0');
        for (var k = 0; k < s.length; k++) { h = (Math.imul(31, h) + s.charCodeAt(k)) | 0; }
        hue = ((Math.abs(h) * 137) % 360);
      }
    }
    var hue2     = (hue + 60) % 360;
    var title    = p.title || 'Extended Track';
    // Inline formatCardTitle — strip underscores, handle legacy remix pattern
    var displayTitle = title.replace(/_/g, ' ').trim();
    var legacyM = displayTitle.match(/^(?:AI|Stemforge)\s+Remix\s+of\s+(.+)$/i);
    if (legacyM) displayTitle = legacyM[1].trim() + ' Remix';
    var safeTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g,'').replace(/\s+/g,'_').toLowerCase() || 'extended_track';
    var stereoUrl = p.stereo_url || '';
    var date     = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';
    var playBtn  = stereoUrl
      ? '<div class="project-card__play" onclick="playDashProject(this)"><i class="fas fa-play"></i></div>'
      : '<div class="project-card__play" style="opacity:.3;pointer-events:none"><i class="fas fa-hourglass-half"></i></div>';
    return '<div class="project-card"' +
      ' data-stereo="' + stereoUrl + '"' +
      ' data-id="' + p.id + '"' +
      ' data-title="' + title.replace(/"/g,'&quot;') + '"' +
      ' data-hue="' + hue + '">' +
      '<div class="project-card__art" style="background:linear-gradient(135deg,hsl(' + hue + ',60%,18%),hsl(' + hue2 + ',70%,10%));position:relative;overflow:hidden">' +
        '<img src="/static/stemforge-logo.png" alt="StemForge"' +
          ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.75;filter:hue-rotate(' + hue + 'deg) saturate(1.6) brightness(0.9);pointer-events:none;user-select:none"/>' +
        playBtn +
      '</div>' +
      '<div class="project-card__body">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">' +
          '<h4 style="margin:0;flex:1">' + displayTitle + '</h4>' +
          '<button class="song-dots-btn" title="More options"' +
            ' onclick="event.stopPropagation();openCardMenu(this,\'' + p.id + '\',\'' + stereoUrl + '\',\'\',\'' + safeTitle + '\',\'extended\')"' +
            ' style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>' +
        '</div>' +
        '<p style="margin-bottom:6px;color:var(--muted);font-size:.8rem"><i class="fas fa-expand-arrows-alt" style="font-size:.7rem;margin-right:4px;opacity:.6"></i>Extended · ' + date + '</p>' +
        (!stereoUrl ? '<p style="color:var(--muted);font-size:.78rem"><i class="fas fa-spinner fa-spin"></i> Generating...</p>' : '') +
      '</div>' +
    '</div>';
  }

  // ── Hard-reload the extended library tab — renders directly, bypasses _libLoaded closure ──
  function reloadExtendedTab() {
    var gridEl = document.getElementById('project-grid-extended');
    if (!gridEl) return;
    gridEl.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    fetch('/api/projects?tab=extended', { credentials: 'include' })
      .then(function(r) {
        if (!r.ok && r.status !== 200) {
          // Non-200 — read as text first so a gateway HTML page doesn't crash .json()
          return r.text().then(function(txt) {
            var msg = txt;
            try { msg = JSON.parse(txt).error || msg; } catch(_) {}
            throw new Error('HTTP ' + r.status + ': ' + msg);
          });
        }
        return r.json();
      })
      .then(function(d) {
        if (d.error && !d.projects) {
          // Authenticated error (e.g. DB issue)
          gridEl.innerHTML = '<div class="project-grid-loading" style="color:var(--muted)">Could not load extended tracks: ' + d.error + '</div>';
          return;
        }
        var projects = d.projects || [];
        if (!projects.length) {
          gridEl.innerHTML = '<div class="project-grid-empty"><i class="fas fa-expand-arrows-alt" style="font-size:40px;opacity:.3;margin-bottom:16px"></i><p>No extended tracks yet. Use the <strong>Extend</strong> tab in the Creator to extend any track.</p></div>';
          return;
        }
        // Render cards directly — never touch the IIFE cache (_libLoaded/_libData)
        var html = '';
        // Only count ready tracks for the badge
        var readyCount = 0;
        projects.forEach(function(p, i) {
          html += renderExtendedCard(p, i);
          if (p.status === 'ready' || p.stereo_url) readyCount++;
        });
        gridEl.innerHTML = html;
        // Update the tab badge count (show total including in-progress)
        var extBtn = document.querySelector('.lib-tab[data-tab="extended"]');
        if (extBtn) {
          var badge = extBtn.querySelector('.lib-tab-count');
          if (!badge) { badge = document.createElement('span'); badge.className = 'lib-tab-count'; extBtn.appendChild(badge); }
          badge.textContent = projects.length;
        }
        // Make sure the extended panel is visible
        var panel = document.getElementById('lib-panel-extended');
        if (panel && panel.style.display === 'none') panel.style.display = '';
      })
      .catch(function(err) {
        console.error('[reloadExtendedTab] fetch error:', err);
        gridEl.innerHTML = '<div class="project-grid-loading" style="color:var(--muted)">Could not load extended tracks. Please refresh the page.</div>';
      });
  }
  // Expose globally so other code can call it (e.g. after extend from library card menu)
  window.reloadExtendedTab = reloadExtendedTab;

  // ── Override switchLibTab: intercept 'extended' and 'uploads' ───────────
  // CRITICAL: The base switchLibTab is set inside a DOMContentLoaded listener (line ~867).
  // If we override at parse-time, the DOMContentLoaded handler will OVERWRITE our override.
  // Fix: register our override inside a DOMContentLoaded listener that runs AFTER the base,
  // using setTimeout(0) to push to the back of the DOMContentLoaded queue.
  // Also attach directly to tab buttons as onclick fallback to guarantee correct behavior.
  (function() {
    function installSwitchLibTabOverride() {
      var _baseSwitchLibTab = window.switchLibTab;

      // Shared: manually switch panels + tab buttons
      function manualSwitchUI(tab) {
        var placeholders = { beats: 'Search beats…', extended: 'Search extended tracks…', oneshots: 'Search one shots…', uploads: 'Search uploads…', trash: 'Search trash…', remixes: 'Search remixes…' };
        document.querySelectorAll('.lib-tab').forEach(function(btn) {
          btn.classList.toggle('lib-tab--active', btn.dataset.tab === tab);
          btn.classList.toggle('lib-tab--trash', tab === 'trash' && btn.dataset.tab === tab);
          if (tab !== 'trash') btn.classList.remove('lib-tab--trash');
        });
        ['beats', 'extended', 'oneshots', 'uploads', 'trash', 'remixes'].forEach(function(t) {
          var panel = document.getElementById('lib-panel-' + t);
          if (panel) panel.style.display = t === tab ? '' : 'none';
        });
        var searchInput = document.getElementById('lib-search');
        if (searchInput) {
          searchInput.placeholder = placeholders[tab] || 'Search…';
          searchInput.value = '';
        }
        var clearBtn = document.getElementById('lib-search-clear');
        if (clearBtn) clearBtn.style.display = 'none';
      }

      window.switchLibTab = function(tab) {
        if (tab === 'extended') {
          manualSwitchUI('extended');
          reloadExtendedTab();

        } else if (tab === 'uploads') {
          manualSwitchUI('uploads');
          // Delegate to the IIFE's exposed fetchUploadsTab — single source of truth for
          // fetch + error handling + rendering. It always resets _libLoaded.uploads = false
          // so it always refetches regardless of cache state.
          if (window.fetchUploadsTab) {
            window.fetchUploadsTab();
          } else {
            // Safety fallback in case IIFE hasn't exposed it yet
            var gridEl2 = document.getElementById('project-grid-uploads');
            if (gridEl2) gridEl2.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
            setTimeout(function() { if (window.fetchUploadsTab) window.fetchUploadsTab(); }, 200);
          }

        } else if (tab === 'remixes') {
          manualSwitchUI('remixes');
          // fetchLibTab handles remixes via the base — just need to ensure _libLoaded.remixes is cleared on switch
          if (window._libLoaded) window._libLoaded.remixes = false;
          if (_baseSwitchLibTab) _baseSwitchLibTab(tab);

        } else {
          if (_baseSwitchLibTab) _baseSwitchLibTab(tab);
        }
      };

      // Also bind directly to the Extended tab button so it always calls our version
      var extTabBtn = document.querySelector('.lib-tab[data-tab="extended"]');
      if (extTabBtn) {
        extTabBtn.onclick = function() { window.switchLibTab('extended'); };
      }
      var uploadsTabBtn = document.querySelector('.lib-tab[data-tab="uploads"]');
      if (uploadsTabBtn) {
        uploadsTabBtn.onclick = function() { window.switchLibTab('uploads'); };
      }
      var remixesTabBtn = document.querySelector('.lib-tab[data-tab="remixes"]');
      if (remixesTabBtn) {
        remixesTabBtn.onclick = function() { window.switchLibTab('remixes'); };
      }

      // ── Also override window.filterLibrary so search bar can't wipe extended grid ──
      var _baseFilterLibrary = window.filterLibrary;
      window.filterLibrary = function(query) {
        var activeBtn = document.querySelector('.lib-tab--active');
        var tab = activeBtn ? activeBtn.dataset.tab : null;
        if (tab === 'extended') return; // don't wipe — reloadExtendedTab owns the grid
        if (tab === 'uploads') {
          var gridEl = document.getElementById('project-grid-uploads');
          if (!gridEl) return;
          fetch('/api/reference-uploads')
            .then(function(r) { return r.json(); })
            .then(function(d) {
              var uploads = d.uploads || [];
              if (query) {
                var q = query.toLowerCase();
                uploads = uploads.filter(function(u) {
                  var fn = (u.filename || '').toLowerCase();
                  var g  = (u.analysis && u.analysis.genre ? u.analysis.genre : '').toLowerCase();
                  return fn.includes(q) || g.includes(q);
                });
              }
              if (window.renderUploadsGrid) window.renderUploadsGrid(gridEl, uploads);
            })
            .catch(function() {});
          return;
        }
        if (_baseFilterLibrary) _baseFilterLibrary(query);
      };
    }

    // Run after ALL DOMContentLoaded handlers (including the base library IIFE) complete.
    // setTimeout(0) pushes to end of microtask queue so base switchLibTab is already set.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        setTimeout(installSwitchLibTabOverride, 0);
      });
    } else {
      // DOM already ready (script loaded async/defer)
      setTimeout(installSwitchLibTabOverride, 0);
    }
  })();

  // ── Patch deleteLibItem to hard-reload extended/remixes tab after deletion ──
  // The base deleteLibItem sets _libLoaded.extended = false then calls fetchLibTab
  // which hits populateGrid with no extended case. Override so extended always uses reloadExtendedTab.
  // Also handles remixes tab: clears _libLoaded.remixes cache so item disappears immediately.
  (function() {
    var _baseDeleteLibItem = window.deleteLibItem;
    window.deleteLibItem = async function(jobId) {
      // Determine the active tab before deletion
      var activeTabEl = document.querySelector('.lib-tab--active');
      var activeTab   = (activeTabEl && activeTabEl.dataset) ? activeTabEl.dataset.tab : '';
      var wasExtended = activeTab === 'extended';
      var wasRemixes  = activeTab === 'remixes';
      if (_baseDeleteLibItem) await _baseDeleteLibItem(jobId);
      if (wasExtended) {
        // Base already cleared _libLoaded.extended and tried fetchLibTab — now hard-reload
        setTimeout(reloadExtendedTab, 100);
      }
      if (wasRemixes) {
        // Force cache invalidation so the grid re-fetches without the deleted item
        if (window._libLoaded) window._libLoaded.remixes = false;
        setTimeout(function() {
          if (window.switchLibTab) window.switchLibTab('remixes');
        }, 100);
      }
    };
  })();

  function _extPollJob(jobId, ui) {
    var maxAttempts = 180; // 15 min max (~900s) — chaining can take up to 15 min
    var attempts    = 0;
    ui = ui || {};

    // Immediately switch to the extended library tab so user sees progress
    // Also show a "generating" placeholder card immediately
    var extBtnInit = document.querySelector('.lib-tab[data-tab="extended"]');
    if (extBtnInit) extBtnInit.click();

    function doPoll() {
      if (attempts++ >= maxAttempts) {
        // Timeout — reset creator UI
        if (ui.pipelineStatus) ui.pipelineStatus.style.display = 'none';
        if (ui.genBtn) { ui.genBtn.disabled = false; ui.genBtn.innerHTML = '<i class="fas fa-music"></i> Create'; }
        return;
      }

      fetch('/api/poll/' + jobId, { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(job) {
          // Update spinner message — show chain progress if available
          if (ui.spinnerMsg && ui.pipelineStatus) {
            if (job.status === 'generating') {
              var chainStep = job.chain_step || 0;
              var chainTargetMs = job.chain_target_ms || 0;
              var chainCurrentMs = job.chain_current_duration_ms || 0;
              if (chainStep > 0 && chainTargetMs > 0) {
                var doneSec = Math.round(chainCurrentMs / 1000);
                var targetSec = Math.round(chainTargetMs / 1000);
                var pct = chainTargetMs > 0 ? Math.min(99, Math.round((chainCurrentMs / chainTargetMs) * 100)) : 0;
                ui.spinnerMsg.textContent = 'Building your track… ' + doneSec + 's / ' + targetSec + 's (' + pct + '%) — step ' + chainStep;
              } else {
                ui.spinnerMsg.textContent = 'Stemforge is forging your track…';
              }
            }
          }

          if (job.status === 'ready') {
            // ── Done: collapse spinner, show audio player on creator page ──
            if (ui.pipelineStatus) {
              ui.pipelineStatus.style.transition = 'opacity .4s ease';
              ui.pipelineStatus.style.opacity = '0';
              setTimeout(function() {
                ui.pipelineStatus.style.display = 'none';
                ui.pipelineStatus.style.opacity = '1';
              }, 400);
            }
            if (ui.genBtn) { ui.genBtn.disabled = false; ui.genBtn.innerHTML = '<i class="fas fa-music"></i> Create'; }

            // Show the stereo player with the extended continuation
            if (job.stereo_url && ui.stereoPlayer && ui.stereoAudio) {
              ui.stereoAudio.src = job.stereo_url;
              ui.stereoPlayer.style.display = 'block';
              // Update the player label to clarify this is the continuation portion
              var playerLabel = ui.stereoPlayer.querySelector('.stereo-player__label');
              if (playerLabel) playerLabel.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> Extended continuation';
              if (ui.stereoDownload) {
                var currentPlan = (window._sfUser && window._sfUser.plan) || 'free';
                if (currentPlan === 'free') {
                  ui.stereoDownload.href = '#';
                  ui.stereoDownload.innerHTML = '<i class="fas fa-lock"></i> Upgrade to access';
                  ui.stereoDownload.style.opacity = '0.7';
                } else {
                  var safeTitle = (job.title || 'extended_track').replace(/[^a-zA-Z0-9\s\-_]/g,'').replace(/\s+/g,'_').toLowerCase() || 'extended_track';
                  ui.stereoDownload.href = job.stereo_url;
                  ui.stereoDownload.setAttribute('download', safeTitle + '_extended.mp3');
                  ui.stereoDownload.innerHTML = '<i class="fas fa-download"></i> Download';
                  ui.stereoDownload.style.opacity = '';
                }
              }
              if (ui.genResult) ui.genResult.style.display = 'block';
            }

            // Hard-reload the extended library tab so the new card appears
            reloadExtendedTab();

          } else if (job.status === 'error') {
            if (ui.pipelineStatus) ui.pipelineStatus.style.display = 'none';
            if (ui.genBtn) { ui.genBtn.disabled = false; ui.genBtn.innerHTML = '<i class="fas fa-music"></i> Create'; }
            // Show error toast
            var toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#ef4444;color:#fff;padding:12px 20px;border-radius:10px;font-weight:600;z-index:99999;box-shadow:0 4px 20px rgba(239,68,68,.4)';
            toast.textContent = 'Extend failed: ' + (job.error || 'Generation error');
            document.body.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 5000);
            reloadExtendedTab();

          } else {
            // Still generating — keep polling
            setTimeout(doPoll, 5000);
          }
        })
        .catch(function() { setTimeout(doPoll, 8000); });
    }

    setTimeout(doPoll, 5000); // first poll after 5s
  }

  window.submitSongExtendUpload = async function() {
    if (!extUploadAudioId) {
      alert('Please upload a track first.');
      return;
    }
    var status  = document.getElementById('ext-submit-status');
    var btn     = document.getElementById('ext-submit-btn');
    var lyrics  = (document.getElementById('ext-lyrics') || {}).value || '';

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extending…'; }
    if (status) { status.style.display = 'block'; var _stxt = document.getElementById('ext-submit-status-text'); if (_stxt) _stxt.textContent = 'Submitting extend job…'; }

    try {
      // Default extend_at to end of track (in ms) so Mureka appends after the track ends.
      // If the user set a scrubber position, use that instead.
      var effectiveExtendAt = extExtendAtMs > 0 ? extExtendAtMs
        : (extAudioDuration > 0 ? Math.round(extAudioDuration * 1000) : 0);
      var isInstr = (window._extMode !== 'vocal');
      var body = {
        upload_audio_id: extUploadAudioId,
        title: extUploadTitle || 'Uploaded Track',
        make_instrumental: isInstr
      };
      // Always pass source_duration_ms — backend uses it as extend_at to maximize new content
      if (extAudioDuration > 0) body.source_duration_ms = Math.round(extAudioDuration * 1000);
      if (effectiveExtendAt > 0) body.extend_at = effectiveExtendAt;
      // Pass lyrics in vocal mode if user typed something
      if (!isInstr && lyrics.trim()) body.lyrics = lyrics.trim();

      var res = await fetch('/api/job/extend-upload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      var jobId = data.job_id;

      // Stop scrubber playback
      var previewAudio = document.getElementById('ext-preview-audio');
      if (previewAudio) try { previewAudio.pause(); } catch(e) {}

      // Close the extend popup immediately
      window.closeCreatorPopup && window.closeCreatorPopup('extend');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> Extend Track'; }
      if (status) { status.style.display = 'none'; }

      // ── Drive the creator-page pipeline UI (same as a normal generation) ──
      var pipelineStatus  = document.getElementById('pipeline-status');
      var genResult       = document.getElementById('gen-result');
      var genEmpty        = document.getElementById('gen-empty');
      var genError        = document.getElementById('gen-error');
      var spinnerMsg      = document.getElementById('pipeline-spinner-msg');
      var genBtn          = document.getElementById('gen-full-btn');
      var stereoPlayer    = document.getElementById('stereo-player');
      var stereoAudio     = document.getElementById('stereo-audio');
      var stereoDownload  = document.getElementById('stereo-download');

      if (pipelineStatus) {
        if (genEmpty)  genEmpty.style.display  = 'none';
        if (genError)  genError.style.display  = 'none';
        if (genResult) genResult.style.display = 'none';
        pipelineStatus.style.display = 'block';
        pipelineStatus.style.opacity = '1';
        if (spinnerMsg) spinnerMsg.textContent = 'Stemforge is forging your track…';
        if (genBtn) { genBtn.disabled = true; genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extending…'; }
      }

      // Start background polling — updates the pipeline UI and the extended library tab
      _extPollJob(jobId, {
        pipelineStatus: pipelineStatus,
        spinnerMsg: spinnerMsg,
        genResult: genResult,
        genEmpty: genEmpty,
        genBtn: genBtn,
        stereoPlayer: stereoPlayer,
        stereoAudio: stereoAudio,
        stereoDownload: stereoDownload
      });

    } catch(e) {
      if (status) { status.style.display = 'block'; var _stxtE2 = document.getElementById('ext-submit-status-text'); if (_stxtE2) { _stxtE2.textContent = 'Error: ' + (e.message || 'Unknown error'); _stxtE2.style.color = '#f87171'; } }
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> Extend Track'; }
    }
  };

})();

// ══ Loop Extend Engine ════════════════════════════════════════════════════════
// True loop extension: decodes audio in-browser, analyses BPM + boundary
// quality, auto-picks crossfade, stitches repeats to add ~60s, encodes MP3.
// No server call, no points charged.
(function initLoopExtend() {

  // ── State ──────────────────────────────────────────────────────────────────
  var _loopFile        = null;   // original File object
  var _loopAudioBuffer = null;   // decoded Web Audio AudioBuffer
  var _loopBpm         = 0;
  var _loopCrossfadeMs = 40;     // auto-determined, ms
  var _loopReps        = 1;      // number of extra full-loop repetitions
  var _loopAddedSec    = 0;      // seconds being added

  // ── File input handler ─────────────────────────────────────────────────────
  window.loopHandleFileSelect = function(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    _loopFile = file;
    _loopAudioBuffer = null;
    loopSetZoneState('loading');
    var errEl = document.getElementById('loop-upload-error');
    if (errEl) errEl.style.display = 'none';

    // Decode with Web Audio API
    var reader = new FileReader();
    reader.onload = function(e) {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.decodeAudioData(e.target.result, function(buf) {
        ctx.close();
        _loopAudioBuffer = buf;
        loopAnalyse(buf, file.name);
      }, function(err) {
        loopSetZoneState('idle');
        if (errEl) { errEl.textContent = 'Could not decode audio: ' + (err && err.message || 'unsupported format'); errEl.style.display = 'block'; }
      });
    };
    reader.onerror = function() {
      loopSetZoneState('idle');
      if (errEl) { errEl.textContent = 'Could not read file.'; errEl.style.display = 'block'; }
    };
    reader.readAsArrayBuffer(file);
  };

  // Drag-and-drop support
  document.addEventListener('DOMContentLoaded', function() {
    var zone = document.getElementById('loop-upload-zone');
    if (!zone) return;
    zone.addEventListener('dragover',  function(e) { e.preventDefault(); zone.style.borderColor = 'rgba(78,159,255,.7)'; zone.style.background = 'rgba(78,159,255,.1)'; });
    zone.addEventListener('dragleave', function()  { zone.style.borderColor = ''; zone.style.background = ''; });
    zone.addEventListener('drop', function(e) {
      e.preventDefault(); zone.style.borderColor = ''; zone.style.background = '';
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) { document.getElementById('loop-audio-file').value = ''; _loopFile = file; _loopAudioBuffer = null; loopSetZoneState('loading'); var errEl = document.getElementById('loop-upload-error'); if (errEl) errEl.style.display = 'none'; var reader = new FileReader(); reader.onload = function(ev) { var ctx = new (window.AudioContext || window.webkitAudioContext)(); ctx.decodeAudioData(ev.target.result, function(buf) { ctx.close(); _loopAudioBuffer = buf; loopAnalyse(buf, file.name); }, function() { loopSetZoneState('idle'); }); }; reader.readAsArrayBuffer(file); }
    });
  });

  // ── Zone state helper ──────────────────────────────────────────────────────
  function loopSetZoneState(state, filename) {
    var idle    = document.getElementById('loop-upload-idle');
    var loading = document.getElementById('loop-upload-loading');
    var done    = document.getElementById('loop-upload-done');
    var nameEl  = document.getElementById('loop-upload-name');
    if (idle)    idle.style.display    = state === 'idle'    ? 'flex' : 'none';
    if (loading) loading.style.display = state === 'loading' ? 'flex' : 'none';
    if (done)    done.style.display    = state === 'done'    ? 'flex' : 'none';
    if (nameEl && filename) nameEl.textContent = filename;
  }

  // ── Analysis: BPM + boundary RMS + transient density → crossfade ──────────
  function loopAnalyse(buf, filename) {
    var sr       = buf.sampleRate;
    var ch0      = buf.getChannelData(0);
    var durSec   = buf.duration;

    // ── 1. Estimate BPM via autocorrelation on RMS envelope ──────────────────
    // Downsample envelope: RMS in 10ms windows
    var winSamples = Math.floor(sr * 0.010);
    var envLen = Math.floor(ch0.length / winSamples);
    var env = new Float32Array(envLen);
    for (var i = 0; i < envLen; i++) {
      var sum = 0;
      var off = i * winSamples;
      for (var j = 0; j < winSamples; j++) sum += ch0[off + j] * ch0[off + j];
      env[i] = Math.sqrt(sum / winSamples);
    }
    // Autocorrelate env in BPM range 60–180 → period 333ms–1000ms
    var minPeriodFrames = Math.floor(0.333 / 0.010);
    var maxPeriodFrames = Math.floor(1.000 / 0.010);
    var bestPeriod = minPeriodFrames, bestCorr = -Infinity;
    for (var p = minPeriodFrames; p <= maxPeriodFrames; p++) {
      var corr = 0, n = envLen - p;
      for (var k = 0; k < n; k++) corr += env[k] * env[k + p];
      corr /= n;
      if (corr > bestCorr) { bestCorr = corr; bestPeriod = p; }
    }
    var beatDurationSec = bestPeriod * 0.010;
    var bpm = Math.round(60 / beatDurationSec);
    // Clamp to sane range
    if (bpm < 60)  bpm = Math.round(bpm  * 2);
    if (bpm > 200) bpm = Math.round(bpm  / 2);
    _loopBpm = bpm;

    // ── 2. Measure boundary energy at start & end (first/last 2048 samples) ──
    var boundaryLen = Math.min(2048, Math.floor(sr * 0.05));
    var rmsStart = 0, rmsEnd = 0;
    for (var i = 0; i < boundaryLen; i++) {
      rmsStart += ch0[i] * ch0[i];
      rmsEnd   += ch0[ch0.length - boundaryLen + i] * ch0[ch0.length - boundaryLen + i];
    }
    rmsStart = Math.sqrt(rmsStart / boundaryLen);
    rmsEnd   = Math.sqrt(rmsEnd   / boundaryLen);
    var boundaryDelta = Math.abs(rmsStart - rmsEnd) / (Math.max(rmsStart, rmsEnd) + 1e-9);

    // ── 3. Count transients (fast onset proxy: samples where RMS env spikes >2×) ──
    var transients = 0;
    for (var i = 1; i < envLen - 1; i++) {
      if (env[i] > env[i-1] * 2.0 && env[i] > 0.05) transients++;
    }
    var transientDensity = transients / durSec; // per second

    // ── 4. Auto-pick crossfade ────────────────────────────────────────────────
    // Rule: punchy/percussive = short; mismatched boundaries = longer
    var xfadeMs;
    if (transientDensity > 6) {
      // Dense percussive content — short crossfade to preserve transient attacks
      xfadeMs = boundaryDelta < 0.3 ? 20 : 40;
    } else if (boundaryDelta > 0.4) {
      // Boundaries are very different energy — blend them
      xfadeMs = 120;
    } else {
      // Mid-range: melodic, pads, moderate percussion
      xfadeMs = 60;
    }
    // Never exceed half a beat at the estimated BPM
    var halfBeatMs = (60000 / bpm) / 2;
    xfadeMs = Math.min(xfadeMs, Math.floor(halfBeatMs));
    xfadeMs = Math.max(xfadeMs, 10); // floor 10ms
    _loopCrossfadeMs = xfadeMs;

    // ── 5. Calculate how many reps to add ~60s ───────────────────────────────
    var targetAddSec = 60;
    var reps = Math.max(1, Math.round(targetAddSec / durSec));
    // Check we're not undershooting too badly — prefer rounding up if < 70% of target
    if (reps * durSec < targetAddSec * 0.7 && reps < 16) reps++;
    _loopReps    = reps;
    _loopAddedSec = Math.round(reps * durSec);

    // ── 6. Update UI ─────────────────────────────────────────────────────────
    var name = filename || 'track';
    loopSetZoneState('done', name);
    var metaEl   = document.getElementById('loop-upload-meta');
    var cardEl   = document.getElementById('loop-analysis-card');
    var bpmEl    = document.getElementById('loop-info-bpm');
    var durEl    = document.getElementById('loop-info-dur');
    var addEl    = document.getElementById('loop-info-add');
    var xfEl     = document.getElementById('loop-info-xfade');
    var genBtn   = document.getElementById('loop-generate-btn');
    var resultEl = document.getElementById('loop-result');
    if (metaEl)   metaEl.textContent = bpm + ' BPM · ' + durSec.toFixed(1) + 's';
    if (cardEl)   cardEl.style.display = 'block';
    if (bpmEl)    bpmEl.textContent = bpm + ' BPM';
    if (durEl)    durEl.textContent = durSec.toFixed(1) + 's';
    if (addEl)    addEl.textContent = '+' + _loopAddedSec + 's (' + reps + '× loop)';
    if (xfEl)     xfEl.textContent = xfadeMs + 'ms';
    if (genBtn)   genBtn.style.display = 'block';
    if (resultEl) resultEl.style.display = 'none';
    var prog = document.getElementById('loop-progress');
    if (prog) prog.style.display = 'none';
  }

  // ── Generate: stitch buffer + encode MP3 ──────────────────────────────────
  window.loopGenerate = function() {
    if (!_loopAudioBuffer || !_loopFile) return;
    var genBtn   = document.getElementById('loop-generate-btn');
    var prog     = document.getElementById('loop-progress');
    var progBar  = document.getElementById('loop-progress-bar');
    var progMsg  = document.getElementById('loop-progress-msg');
    var resultEl = document.getElementById('loop-result');
    var errEl    = document.getElementById('loop-upload-error');

    if (genBtn)  { genBtn.disabled = true; genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Stemforge is forging your loop\u2026'; }
    if (prog)    prog.style.display = 'block';
    if (progBar) progBar.style.width = '0%';
    if (progMsg) progMsg.textContent = 'Stitching loops…';
    if (errEl)   errEl.style.display = 'none';

    // Use setTimeout to yield to the browser before heavy work
    setTimeout(function() {
      try {
        var buf    = _loopAudioBuffer;
        var sr     = buf.sampleRate;
        var xfSamp = Math.floor(_loopCrossfadeMs * sr / 1000);
        var nCh    = Math.min(buf.numberOfChannels, 2);

        // ── 1. Build total output: original + N reps stitched with crossfade ──
        // Each stitch point blends last xfSamp of previous with first xfSamp of loop
        // Output length = (1 + reps) * loopSamples - reps * xfSamp
        var loopSamples = buf.length;
        var totalSamples = loopSamples + _loopReps * (loopSamples - xfSamp);

        // Allocate output channels
        var out = [];
        for (var c = 0; c < nCh; c++) out.push(new Float32Array(totalSamples));

        if (progMsg) progMsg.textContent = 'Building loop buffer…';
        if (progBar) progBar.style.width = '15%';

        for (var c = 0; c < nCh; c++) {
          var src = buf.getChannelData(c);
          var dst = out[c];
          // Copy original loop
          for (var i = 0; i < loopSamples; i++) dst[i] = src[i];
          // Append reps with crossfade overlap
          var writePos = loopSamples;
          for (var r = 0; r < _loopReps; r++) {
            // Crossfade region: blend tail of previous content with head of new loop
            for (var x = 0; x < xfSamp; x++) {
              var fadeOut = 1 - (x / xfSamp); // previous content fades out
              var fadeIn  =     (x / xfSamp); // new loop fades in
              // writePos - xfSamp + x is the blend position
              var blendPos = writePos - xfSamp + x;
              // dst already has the previous tail — blend with loop start
              dst[blendPos] = dst[blendPos] * fadeOut + src[x] * fadeIn;
            }
            // Copy remainder of loop after the crossfade region
            var copyStart = xfSamp;
            var copyLen   = loopSamples - xfSamp;
            for (var i = 0; i < copyLen; i++) dst[writePos + i] = src[copyStart + i];
            writePos += copyLen;
          }
        }

        if (progMsg) progMsg.textContent = 'Encoding MP3…';
        if (progBar) progBar.style.width = '40%';

        // ── 2. Encode to MP3 via lamejs (loaded from CDN) ─────────────────────
        // lamejs is loaded lazily here on first use
        function encodeAndFinish() {
          var lame = new lamejs.Mp3Encoder(nCh, sr, 192);
          var blockSize = 1152;
          var mp3Chunks = [];
          var totalBlocks = Math.ceil(totalSamples / blockSize);
          var blocksDone  = 0;

          function encodeBlock(startSample) {
            if (startSample >= totalSamples) {
              // Flush
              var last = lame.flush();
              if (last && last.length) mp3Chunks.push(new Int8Array(last));
              // Done — assemble blob
              var totalBytes = 0;
              for (var i = 0; i < mp3Chunks.length; i++) totalBytes += mp3Chunks[i].length;
              var mp3Data = new Uint8Array(totalBytes);
              var offset = 0;
              for (var i = 0; i < mp3Chunks.length; i++) {
                mp3Data.set(new Uint8Array(mp3Chunks[i].buffer), offset);
                offset += mp3Chunks[i].length;
              }
              var blob = new Blob([mp3Data], { type: 'audio/mpeg' });
              var blobUrl = URL.createObjectURL(blob);

              if (progBar) progBar.style.width = '100%';
              if (progMsg) progMsg.textContent = 'Stemforge is saving your loop\u2026';

              // Populate result immediately (local playback + download)
              var audioEl  = document.getElementById('loop-result-audio');
              var dlBtn    = document.getElementById('loop-dl-btn');
              var metaEl   = document.getElementById('loop-result-meta');
              var origName = (_loopFile.name || 'track').replace(/\.[^.]+$/, '');
              var dlName   = origName + '_loop_extended.mp3';
              var totalDurSec = parseFloat((totalSamples / sr).toFixed(1));
              if (audioEl) { audioEl.src = blobUrl; }
              if (dlBtn)   { dlBtn.href = blobUrl; dlBtn.setAttribute('download', dlName); }
              if (metaEl)  { metaEl.textContent = totalDurSec + 's total \xb7 ' + _loopAddedSec + 's added'; }
              if (resultEl) resultEl.style.display = 'block';
              if (genBtn)  { genBtn.disabled = false; genBtn.innerHTML = '<i class="fas fa-redo"></i> Loop-Extend Track <span style="opacity:.65;font-size:.8rem;font-weight:400;margin-left:4px">10 pts</span>'; }
              setTimeout(function() { if (prog) prog.style.display = 'none'; }, 800);

              // ── Upload to R2 + save to D1 library (background, non-blocking) ──
              (function saveLoopToLibrary() {
                var saveTitle = origName + ' (Loop Extended)';
                var saveForm = new FormData();
                // Build a File from the blob so the server receives a proper filename
                var loopFile = new File([blob], dlName, { type: 'audio/mpeg' });
                saveForm.append('file', loopFile);

                if (progMsg) progMsg.textContent = 'Saving to your library\u2026';

                fetch('/api/upload-loop-audio', { method: 'POST', body: saveForm })
                  .then(function(r) { return r.json(); })
                  .then(function(uploadData) {
                    if (uploadData.error) throw new Error(uploadData.error);
                    var audioUrl = uploadData.audio_url;
                    if (!audioUrl) throw new Error('No audio URL returned from upload');

                    // Now save job to D1 via loop-save endpoint
                    return fetch('/api/job/loop-save', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        audio_url: audioUrl,
                        title: saveTitle,
                        duration_seconds: totalDurSec,
                        bpm: _loopBpm || undefined
                      })
                    }).then(function(r) { return r.json(); });
                  })
                  .then(function(saveData) {
                    if (saveData.error) {
                      if (saveData.upgrade) {
                        // Free plan — Loop Extend is Creator+ only
                        if (metaEl) metaEl.textContent = totalDurSec + 's total \xb7 Loop Extend requires Creator or Pro plan';
                      } else if (saveData.code === 'insufficient_credits') {
                        if (metaEl) metaEl.textContent = totalDurSec + 's total \xb7 ' + _loopAddedSec + 's added \xb7 Not saved (no points)';
                      }
                      return;
                    }
                    // Success — reload extended tab so the new card appears
                    if (metaEl) metaEl.textContent = totalDurSec + 's total \xb7 ' + _loopAddedSec + 's added \xb7 Saved to library';
                    if (window.reloadExtendedTab) window.reloadExtendedTab();
                  })
                  .catch(function(err) {
                    // Save failed silently — track still plays and can be downloaded
                    console.warn('[loop-save] Could not save to library:', err && err.message);
                  });
              })();

              return;
            }

            var end = Math.min(startSample + blockSize, totalSamples);
            var len = end - startSample;

            // lamejs expects Int16Array
            function toInt16(floatArr, start, length) {
              var buf16 = new Int16Array(length);
              for (var i = 0; i < length; i++) {
                var s = Math.max(-1, Math.min(1, floatArr[start + i]));
                buf16[i] = s < 0 ? s * 32768 : s * 32767;
              }
              return buf16;
            }

            var encoded;
            if (nCh === 2) {
              encoded = lame.encodeBuffer(
                toInt16(out[0], startSample, len),
                toInt16(out[1], startSample, len)
              );
            } else {
              var mono = toInt16(out[0], startSample, len);
              encoded = lame.encodeBuffer(mono, mono);
            }
            if (encoded && encoded.length) mp3Chunks.push(new Int8Array(encoded));

            blocksDone++;
            if (progBar) progBar.style.width = (40 + Math.floor(blocksDone / totalBlocks * 55)) + '%';

            // Yield every 50 blocks so the UI can update
            if (blocksDone % 50 === 0) {
              setTimeout(function() { encodeBlock(startSample + blockSize); }, 0);
            } else {
              encodeBlock(startSample + blockSize);
            }
          }

          encodeBlock(0);
        }

        // Load lamejs from CDN if not already present, then encode
        if (window.lamejs) {
          encodeAndFinish();
        } else {
          if (progMsg) progMsg.textContent = 'Loading encoder…';
          var script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
          script.onload = function() { if (progMsg) progMsg.textContent = 'Encoding MP3…'; encodeAndFinish(); };
          script.onerror = function() {
            if (errEl) { errEl.textContent = 'Could not load MP3 encoder. Please check your connection and try again.'; errEl.style.display = 'block'; }
            if (genBtn) { genBtn.disabled = false; genBtn.innerHTML = '<i class="fas fa-redo"></i> Loop-Extend Track <span style="opacity:.65;font-size:.8rem;font-weight:400;margin-left:4px">10 pts</span>'; }
            if (prog)   prog.style.display = 'none';
          };
          document.head.appendChild(script);
        }

      } catch(e) {
        if (errEl) { errEl.textContent = 'Error: ' + (e.message || 'Unknown error'); errEl.style.display = 'block'; }
        if (genBtn) { genBtn.disabled = false; genBtn.innerHTML = '<i class="fas fa-redo"></i> Loop-Extend Track <span style="opacity:.65;font-size:.8rem;font-weight:400;margin-left:4px">10 pts</span>'; }
        if (prog)   prog.style.display = 'none';
      }
    }, 30); // 30ms yield so spinner renders first
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  window.loopReset = function() {
    _loopFile        = null;
    _loopAudioBuffer = null;
    _loopBpm         = 0;
    _loopCrossfadeMs = 40;
    _loopReps        = 1;
    _loopAddedSec    = 0;
    loopSetZoneState('idle');
    var cardEl   = document.getElementById('loop-analysis-card');
    var genBtn   = document.getElementById('loop-generate-btn');
    var resultEl = document.getElementById('loop-result');
    var prog     = document.getElementById('loop-progress');
    var errEl    = document.getElementById('loop-upload-error');
    var fileIn   = document.getElementById('loop-audio-file');
    if (cardEl)   cardEl.style.display   = 'none';
    if (genBtn)   { genBtn.style.display = 'none'; genBtn.disabled = false; genBtn.innerHTML = '<i class="fas fa-redo"></i> Loop-Extend Track <span style="opacity:.65;font-size:.8rem;font-weight:400;margin-left:4px">10 pts</span>'; }
    if (resultEl) resultEl.style.display = 'none';
    if (prog)     prog.style.display     = 'none';
    if (errEl)    errEl.style.display    = 'none';
    if (fileIn)   fileIn.value           = '';
  };

})(); // end Loop Extend Engine

// ── Override renderUploadsGrid with card-style layout matching beats/oneshots ─
// Cards have three-dot menu (Use as reference, Delete), no arrow badge.
(function() {
  // Open a context menu for an upload card
  window.openUploadCardMenu = function(btn, fileId, filename, summary) {
    var existing = document.getElementById('card-context-menu');
    if (existing) existing.remove();

    var menu = document.createElement('div');
    menu.id = 'card-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.55);min-width:200px;overflow:hidden;padding:4px 0';

    var items = [
      {
        icon: 'fa-headphones',
        label: 'Use as Reference',
        action: function() { if (window.useExistingUpload) window.useExistingUpload(fileId, filename, summary); }
      },
      {
        icon: 'fa-trash-alt',
        label: 'Delete Upload',
        danger: true,
        action: function() { deleteUploadItem(fileId, filename); }
      }
    ];

    items.forEach(function(item) {
      var el = document.createElement('button');
      el.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;background:none;border:none;color:' + (item.danger ? 'var(--danger)' : 'var(--text)') + ';cursor:pointer;font-size:.875rem;font-weight:500;text-align:left;transition:background .12s';
      el.innerHTML = '<i class="fas ' + item.icon + '" style="width:15px;opacity:.7;flex-shrink:0"></i>' + item.label;
      el.onmouseover = function() { el.style.background = 'rgba(255,255,255,.06)'; };
      el.onmouseout  = function() { el.style.background = 'none'; };
      el.onclick = function(e) { e.stopPropagation(); menu.remove(); item.action(); };
      menu.appendChild(el);
    });

    var rect = btn.getBoundingClientRect();
    document.body.appendChild(menu);
    var mh = menu.offsetHeight, mw = menu.offsetWidth;
    var top  = rect.bottom + 6;
    var left = rect.right  - mw;
    if (left < 8) left = 8;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
    menu.style.top  = top  + 'px';
    menu.style.left = left + 'px';

    setTimeout(function() {
      document.addEventListener('click', function closeMenu(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu); }
      });
    }, 0);
  };

  // Delete an upload item (calls API then re-renders)
  function deleteUploadItem(fileId, filename) {
    if (!confirm('Delete "' + filename + '"? This cannot be undone.')) return;
    fetch('/api/reference-uploads/' + encodeURIComponent(fileId), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok || d.success) {
          // Re-fetch uploads and re-render
          var gridEl = document.getElementById('project-grid-uploads');
          if (gridEl) {
            gridEl.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
            fetch('/api/reference-uploads').then(function(r) { return r.json(); }).then(function(data) {
              window.renderUploadsGrid(gridEl, data.uploads || []);
            }).catch(function() {});
          }
        } else {
          alert(d.error || 'Could not delete upload.');
        }
      })
      .catch(function() { alert('Network error. Please try again.'); });
  }

  function installUploadGridOverride() {
    window.renderUploadsGrid = function(gridEl, uploads) {
      if (!gridEl) return;
      if (!uploads || uploads.length === 0) {
        gridEl.innerHTML = '<div class="project-grid-empty"><i class="fas fa-cloud-upload-alt" style="font-size:40px;opacity:.3;margin-bottom:16px"></i><p>No uploads yet. Upload a reference track to get started.</p></div>';
        return;
      }
      var html = '';
      uploads.forEach(function(u, i) {
        var analysis    = u.analysis || {};
        var genre       = analysis.genre || '';
        var bpm         = analysis.bpm ? (analysis.bpm + ' BPM') : '';
        var dur         = u.duration ? (Math.floor(u.duration / 60) + ':' + String(Math.floor(u.duration % 60)).padStart(2, '0')) : '';
        var mood        = analysis.mood || '';
        var instruments = analysis.instruments ? analysis.instruments.slice(0, 3).join(', ') : '';
        var dateStr     = u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '';
        var filename    = (u.filename || 'Reference track').replace(/\.[^.]+$/, '');
        var summary     = (analysis.summary || '').slice(0, 90);
        var hue         = hueFromIndex(i, u.file_id);
        var hue2        = (hue + 40) % 360;
        var safeFileId  = (u.file_id || '').replace(/'/g, '');
        var safeFilename = (u.filename || '').replace(/'/g, '\\u0027');
        var safeSummary  = (analysis.summary || genre || '').replace(/'/g, '\\u0027').replace(/"/g, '&quot;').slice(0, 120);
        var displayName  = filename.replace(/"/g, '&quot;');

        html +=
          // Card — clicking the art/body uses as reference; three-dot opens menu
          '<div class="project-card upload-card">' +
            // Art area — click to use as reference
            '<div class="project-card__art" style="background:linear-gradient(135deg,hsl(' + hue + ',50%,14%),hsl(' + hue2 + ',60%,8%));position:relative;cursor:pointer;overflow:hidden"' +
              ' onclick="useExistingUpload(\'' + safeFileId + '\',\'' + safeFilename + '\',\'' + safeSummary + '\')" title="Use as reference">' +
              '<img src="/static/stemforge-logo.png" alt="StemForge"' +
                ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.75;filter:hue-rotate(' + hue + 'deg) saturate(1.6) brightness(0.9);pointer-events:none;user-select:none"/>' +
              '<div style="position:absolute;top:10px;left:10px">' +
                '<span style="background:rgba(0,0,0,.45);color:hsl(' + hue + ',80%,70%);font-size:.62rem;font-weight:700;padding:2px 7px;border-radius:99px;letter-spacing:.04em;backdrop-filter:blur(4px)">' +
                  '<i class="fas fa-cloud-upload-alt" style="margin-right:3px;font-size:.55rem"></i>UPLOAD' +
                '</span>' +
              '</div>' +
              (dur ? '<div style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.5);color:rgba(255,255,255,.8);font-size:.67rem;padding:2px 6px;border-radius:6px;backdrop-filter:blur(4px)">' + dur + '</div>' : '') +
            '</div>' +
            // Body
            '<div class="project-card__body">' +
              '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">' +
                '<h4 style="font-size:.88rem;margin:0 0 3px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + (u.filename || '') + '">' + displayName + '</h4>' +
                '<button class="song-dots-btn" title="More options"' +
                  ' onclick="event.stopPropagation();openUploadCardMenu(this,\'' + safeFileId + '\',\'' + safeFilename + '\',\'' + safeSummary + '\')"' +
                  ' style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>' +
              '</div>' +
              '<p style="font-size:.75rem;color:var(--primary);font-weight:500;margin-bottom:5px">' +
                [genre, bpm].filter(Boolean).join(' · ') +
              '</p>' +
              (mood ? '<p style="font-size:.72rem;color:var(--muted);font-style:italic;margin-bottom:4px">' + mood + '</p>' : '') +
              (instruments ? '<p style="font-size:.71rem;color:var(--muted);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i class="fas fa-guitar" style="color:var(--primary);margin-right:3px;font-size:.65rem"></i>' + instruments + '</p>' : '') +
              (summary ? '<p style="font-size:.72rem;color:var(--muted);line-height:1.45;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + summary + '</p>' : '') +
              '<div class="project-card__tags">' +
                (dateStr ? '<span style="font-size:.67rem;color:var(--muted)">' + dateStr + '</span>' : '') +
                '<span style="font-size:.67rem;color:var(--primary);margin-left:auto;opacity:.7"><i class="fas fa-headphones" style="margin-right:3px;font-size:.6rem"></i>Tap to use</span>' +
              '</div>' +
            '</div>' +
          '</div>';
      });
      gridEl.innerHTML = html;
    };

    // If uploads tab is already loaded with old list-row style, re-render
    var uploadsGrid = document.getElementById('project-grid-uploads');
    if (uploadsGrid && uploadsGrid.querySelector('.upload-item')) {
      uploadsGrid.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
      fetch('/api/reference-uploads').then(function(r) { return r.json(); }).then(function(d) {
        window.renderUploadsGrid(uploadsGrid, d.uploads || []);
      }).catch(function() {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installUploadGridOverride);
  } else {
    installUploadGridOverride();
  }
})();

// ── Pro Artist upgrade modal (Reference Track / Song Extend) ─────────────────
function showProUpgradeModal(featureName) {
  var existing = document.getElementById('sf-pro-upgrade-modal');
  if (existing) { existing.style.display = 'flex'; return; }
  var modal = document.createElement('div');
  modal.id = 'sf-pro-upgrade-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);backdrop-filter:blur(6px)';
  modal.innerHTML =
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:36px 32px;max-width:400px;width:90%;text-align:center;position:relative">' +
      '<button onclick="document.getElementById(\'sf-pro-upgrade-modal\').style.display=\'none\'" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>' +
      '<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#ec4899);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:1.4rem;color:#fff"><i class="fas fa-star"></i></div>' +
      '<h3 style="font-size:1.2rem;font-weight:700;margin-bottom:8px">Pro Artist only</h3>' +
      '<p style="color:var(--muted);font-size:.9rem;margin-bottom:24px;line-height:1.6"><strong>' + featureName + '</strong> is a Pro Artist feature. Upgrade to unlock reference track uploads, song extend, advanced splits, WAV downloads, and priority queue.</p>' +
      '<a href="/pricing?plan=pro" style="display:block;padding:13px 24px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-star"></i> Upgrade to Pro Artist — $26/mo</a>' +
      '<p style="color:var(--muted);font-size:.78rem;margin-top:14px">Your existing beats and points are kept when you upgrade.</p>' +
    '</div>';
  modal.addEventListener('click', function(e){ if (e.target === modal) modal.style.display = 'none'; });
  document.body.appendChild(modal);
}

// ══ Remix Upload Modal — upload MP3/WAV and apply AI Remix ════════════════════
(function initRemixUploadModal() {
  var remixUploadAudioUrl = null;  // R2 proxy URL of uploaded file
  var remixUploadTitle    = '';    // filename without extension

  // ── State helpers ──────────────────────────────────────────────────────────
  // IDs match the HTML: remix-drop-idle / remix-drop-loading / remix-drop-done / remix-file-name / remix-go-btn
  function setRemixZoneState(state, filename) {
    var idle     = document.getElementById('remix-drop-idle');
    var loading  = document.getElementById('remix-drop-loading');
    var done     = document.getElementById('remix-drop-done');
    var nameEl   = document.getElementById('remix-file-name');
    var errEl    = document.getElementById('remix-upload-error');
    var remixBtn = document.getElementById('remix-go-btn');
    if (idle)    idle.style.display    = (state === 'idle')    ? '' : 'none';
    if (loading) loading.style.display = (state === 'loading') ? '' : 'none';
    if (done)    done.style.display    = (state === 'done')    ? '' : 'none';
    if (errEl)   errEl.style.display   = 'none';
    if (nameEl && filename) nameEl.textContent = filename;
    if (remixBtn) {
      remixBtn.disabled = (state !== 'done');
      remixBtn.style.opacity = (state === 'done') ? '1' : '0.4';
      remixBtn.style.cursor  = (state === 'done') ? 'pointer' : 'not-allowed';
    }
  }

  // ── Open modal ──────────────────────────────────────────────────────────────
  window.openRemixUploadModal = function() {
    var overlay = document.getElementById('remix-upload-overlay');
    if (!overlay) return;
    // Reset state
    remixUploadAudioUrl = null;
    remixUploadTitle    = '';
    setRemixZoneState('idle');
    var fileInput = document.getElementById('remix-file-input');
    if (fileInput) fileInput.value = '';
    overlay.style.display = 'flex';
  };

  // ── Close modal ─────────────────────────────────────────────────────────────
  window.closeRemixUploadModal = function() {
    var overlay = document.getElementById('remix-upload-overlay');
    if (overlay) overlay.style.display = 'none';
  };

  // ── Drag-drop handler ───────────────────────────────────────────────────────
  window.handleRemixFileDrop = function(event) {
    event.preventDefault();
    var zone = document.getElementById('remix-drop-zone');
    if (zone) { zone.style.borderColor = ''; zone.style.background = ''; }
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    var ext    = (file.name || '').split('.').pop().toLowerCase();
    var mimeOk = file.type === 'audio/mpeg' || file.type === 'audio/mp3'
              || file.type === 'audio/wav'  || file.type === 'audio/wave' || file.type === 'audio/x-wav';
    var extOk  = ext === 'mp3' || ext === 'wav';
    if (!mimeOk && !extOk) {
      var errEl = document.getElementById('remix-upload-error');
      if (errEl) { errEl.textContent = 'Only MP3 or WAV files are supported.'; errEl.style.display = 'block'; }
      return;
    }
    _remixUploadFile(file);
  };

  // ── File input handler ──────────────────────────────────────────────────────
  window.handleRemixFileSelect = function(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var ext    = (file.name || '').split('.').pop().toLowerCase();
    var mimeOk = file.type === 'audio/mpeg' || file.type === 'audio/mp3'
              || file.type === 'audio/wav'  || file.type === 'audio/wave' || file.type === 'audio/x-wav';
    var extOk  = ext === 'mp3' || ext === 'wav';
    if (!mimeOk && !extOk) {
      var errEl = document.getElementById('remix-upload-error');
      if (errEl) { errEl.textContent = 'Only MP3 or WAV files are supported.'; errEl.style.display = 'block'; }
      if (input) input.value = '';
      return;
    }
    _remixUploadFile(file);
  };

  // ── Internal: convert WAV→MP3 via lamejs then upload ────────────────────────
  function _remixConvertAndUpload(audioBuffer, fileName) {
    var errEl = document.getElementById('remix-upload-error');
    var statusEl = document.getElementById('remix-upload-status');
    if (statusEl) statusEl.textContent = 'Converting to MP3\u2026';

    var nCh = audioBuffer.numberOfChannels;
    var sr  = audioBuffer.sampleRate;
    // Cap at 60 seconds — MusicAPI only needs a reference snippet and has a file size limit
    var maxSamples = sr * 30;
    var totalSamples = Math.min(audioBuffer.length, maxSamples);
    // 96kbps × 30s = ~353KB — proven working window for MusicAPI /upload-cover
    var lame = new lamejs.Mp3Encoder(Math.min(nCh, 2), sr, 96);
    var blockSize = 1152;
    var mp3Chunks = [];

    // Encode all blocks synchronously (Web Worker would be ideal but this works for <10min files)
    for (var start = 0; start < totalSamples; start += blockSize) {
      var end = Math.min(start + blockSize, totalSamples);
      var len = end - start;
      var leftF  = audioBuffer.getChannelData(0).subarray(start, end);
      var leftI  = new Int16Array(len);
      for (var i = 0; i < len; i++) leftI[i] = Math.max(-32768, Math.min(32767, leftF[i] * 32767));
      var chunk;
      if (nCh >= 2) {
        var rightF = audioBuffer.getChannelData(1).subarray(start, end);
        var rightI = new Int16Array(len);
        for (var i = 0; i < len; i++) rightI[i] = Math.max(-32768, Math.min(32767, rightF[i] * 32767));
        chunk = lame.encodeBuffer(leftI, rightI);
      } else {
        chunk = lame.encodeBuffer(leftI, leftI);
      }
      if (chunk && chunk.length) mp3Chunks.push(new Int8Array(chunk));
    }
    var last = lame.flush();
    if (last && last.length) mp3Chunks.push(new Int8Array(last));

    var totalBytes = 0;
    for (var i = 0; i < mp3Chunks.length; i++) totalBytes += mp3Chunks[i].length;
    var mp3Data = new Uint8Array(totalBytes);
    var offset = 0;
    for (var i = 0; i < mp3Chunks.length; i++) { mp3Data.set(new Uint8Array(mp3Chunks[i].buffer), offset); offset += mp3Chunks[i].length; }

    var mp3BaseName = fileName.replace(/\.[^.]+$/, '');
    var mp3File = new File([mp3Data], mp3BaseName + '.mp3', { type: 'audio/mpeg' });

    if (statusEl) statusEl.textContent = 'Uploading\u2026';
    var fd = new FormData();
    fd.append('file', mp3File);
    fetch('/api/upload-remix-audio', { method: 'POST', credentials: 'include', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);
        if (data.audio_url || data.status === 'ready') {
          remixUploadAudioUrl = data.audio_url;
          setRemixZoneState('done', mp3BaseName);
          return;
        }
        throw new Error('Upload failed \u2014 please try again.');
      })
      .catch(function(err) {
        setRemixZoneState('idle');
        var errEl2 = document.getElementById('remix-upload-error');
        if (errEl2) { errEl2.textContent = 'Upload failed: ' + (err.message || 'Unknown error'); errEl2.style.display = 'block'; }
      });
  }

  // ── Internal: upload file to R2 via /api/upload-remix-audio ────────────────
  // WAV files are always decoded + trimmed to 30s + re-encoded at 96kbps.
  // MP3 files >400KB are also decoded + trimmed (MusicAPI /upload-cover has a size limit).
  // MP3 files <=400KB are uploaded directly.
  var REMIX_MAX_BYTES = 400 * 1024; // 400KB — MusicAPI proven limit
  function _remixUploadFile(file) {
    var errEl = document.getElementById('remix-upload-error');
    if (errEl) errEl.style.display = 'none';
    setRemixZoneState('loading');
    var name = file.name || 'track';
    remixUploadTitle = name.replace(/\.[^.]+$/, '');

    var ext = (name).split('.').pop().toLowerCase();
    var isWav = ext === 'wav' || file.type === 'audio/wav' || file.type === 'audio/wave' || file.type === 'audio/x-wav';
    var isSmallMp3 = !isWav && file.size <= REMIX_MAX_BYTES;

    if (isSmallMp3) {
      // Small MP3 (<=400KB) — upload directly, no re-encoding needed
      var fd = new FormData();
      fd.append('file', file);
      fetch('/api/upload-remix-audio', { method: 'POST', credentials: 'include', body: fd })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) throw new Error(data.error);
          if (data.audio_url || data.status === 'ready') { remixUploadAudioUrl = data.audio_url; setRemixZoneState('done', name); return; }
          throw new Error('Upload failed \u2014 please try again.');
        })
        .catch(function(err) {
          setRemixZoneState('idle');
          var e2 = document.getElementById('remix-upload-error');
          if (e2) { e2.textContent = 'Upload failed: ' + (err.message || 'Unknown error'); e2.style.display = 'block'; }
        });
      return;
    }

    // WAV: decode audio, convert to MP3 via lamejs, then upload
    var statusEl = document.getElementById('remix-upload-status');
    if (statusEl) statusEl.textContent = 'Reading audio\u2026';

    var reader = new FileReader();
    reader.onload = function(ev) {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.decodeAudioData(ev.target.result, function(audioBuffer) {
        ctx.close();
        // Load lamejs if not already available
        function runConvert() { _remixConvertAndUpload(audioBuffer, name); }
        if (window.lamejs) {
          runConvert();
        } else {
          if (statusEl) statusEl.textContent = 'Loading encoder\u2026';
          var script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
          script.onload = runConvert;
          script.onerror = function() {
            setRemixZoneState('idle');
            var e2 = document.getElementById('remix-upload-error');
            if (e2) { e2.textContent = 'Could not load MP3 encoder. Please check your connection and try again.'; e2.style.display = 'block'; }
          };
          document.head.appendChild(script);
        }
      }, function() {
        ctx.close();
        setRemixZoneState('idle');
        var e2 = document.getElementById('remix-upload-error');
        if (e2) { e2.textContent = 'Could not read audio file. Try converting to MP3 first.'; e2.style.display = 'block'; }
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Close / dismiss the pipeline player after it's done ─────────────────────
  window.closePipelinePlayer = function() {
    var pipelineEl = document.getElementById('pipeline-status');
    if (!pipelineEl) return;
    // Pause any playing audio
    [1, 2].forEach(function(n) {
      var a = document.getElementById('pipeline-audio-' + n);
      if (a && !a.paused) { a.pause(); a.currentTime = 0; }
      var playBtn = document.getElementById('pipeline-card-' + n + '-play');
      if (playBtn) { playBtn.classList.remove('is-playing'); playBtn.innerHTML = '<i class="fas fa-play"></i>'; }
    });
    // Hide the close button itself
    var closeBtn = document.getElementById('pipeline-close-btn');
    if (closeBtn) closeBtn.style.display = 'none';
    // Fade out and hide the player
    pipelineEl.style.transition = 'opacity .3s';
    pipelineEl.style.opacity = '0';
    setTimeout(function() {
      pipelineEl.style.display = 'none';
      pipelineEl.style.opacity = '';
      pipelineEl.style.transition = '';
      // Reset cards for next generation
      [1, 2].forEach(function(n) {
        var card = document.getElementById('pipeline-card-' + n);
        if (card) card.classList.remove('is-ready');
        var overlay = document.getElementById('pipeline-card-' + n + '-overlay');
        if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; overlay.style.transition = ''; }
        var playBtnEl = document.getElementById('pipeline-card-' + n + '-play');
        if (playBtnEl) playBtnEl.style.display = 'none';
        var scrubber = document.getElementById('pipeline-scrubber-' + n);
        if (scrubber) scrubber.style.display = 'none';
        var msgEl = document.getElementById('pipeline-card-' + n + '-msg');
        if (msgEl) { msgEl.textContent = 'Generating\u2026'; msgEl.classList.remove('is-done'); }
        var titleEl = document.getElementById('pipeline-card-' + n + '-title');
        if (titleEl) titleEl.textContent = 'Your Beat';
      });
    }, 300);
  };

  // ── Start remix: close modal, show pipeline wave player, stay on Create page ─
  // When done: wire up playback just like regular beat generation, also save to Remixes tab.
  window.startRemixFromUpload = function() {
    if (!remixUploadAudioUrl) return;
    var audioUrl = remixUploadAudioUrl;
    var title    = remixUploadTitle || 'Uploaded Track';

    // Close the modal
    window.closeRemixUploadModal();

    // ── Grab pipeline elements (same ones used by regular beat generation) ──────
    var pipelineEl   = document.getElementById('pipeline-status');
    var msgEl        = document.getElementById('pipeline-card-1-msg');
    var titleEl      = document.getElementById('pipeline-card-1-title');
    var statusSubEl  = document.getElementById('pipeline-status-sub');
    var cancelBtnEl  = document.getElementById('gen-cancel-btn');
    var overlayEl    = document.getElementById('pipeline-card-1-overlay');
    var playBtnEl    = document.getElementById('pipeline-card-1-play');
    var audioEl      = document.getElementById('pipeline-audio-1');
    var scrubberEl   = document.getElementById('pipeline-scrubber-1');

    // ── Reset card 2 (dummy, hide it) ──────────────────────────────────────────
    var card2 = document.getElementById('pipeline-card-2');
    if (card2) card2.style.display = 'none';

    // Show pipeline player in generating state
    if (pipelineEl) {
      if (titleEl)     titleEl.textContent  = title;
      if (msgEl)       { msgEl.textContent = 'Applying AI Remix\u2026'; msgEl.classList.remove('is-done'); }
      if (statusSubEl) { statusSubEl.textContent = 'StemForge is remixing your track\u2026'; statusSubEl.style.display = ''; }
      if (cancelBtnEl) cancelBtnEl.style.display = 'none'; // no cancel for remix
      if (overlayEl)   overlayEl.style.display = 'flex';   // spinner visible
      if (playBtnEl)   playBtnEl.style.display = 'none';   // play hidden until ready
      if (scrubberEl)  scrubberEl.style.display = 'none';
      pipelineEl.style.opacity = '1';
      pipelineEl.style.display = 'block';
    }

    // POST to /api/job/remix with audio_url (direct upload mode)
    fetch('/api/job/remix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ audio_url: audioUrl, title: title })
    })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(result) {
        if (!result.ok) {
          // Error — hide pipeline, show error toast
          if (pipelineEl) pipelineEl.style.display = 'none';
          if (cancelBtnEl) cancelBtnEl.style.display = '';
          _remixShowError(result.data.error || 'Remix failed — please try again.');
          return;
        }
        var newJobId = result.data.job_id;
        if (!newJobId) {
          if (pipelineEl) pipelineEl.style.display = 'none';
          if (cancelBtnEl) cancelBtnEl.style.display = '';
          return;
        }

        // ── Poll until ready — stays on Create page the whole time ──────────────
        var pollCount = 0;
        var pollInterval = setInterval(function() {
          if (++pollCount > 84) { // 7 min max
            clearInterval(pollInterval);
            if (pipelineEl) pipelineEl.style.display = 'none';
            if (cancelBtnEl) cancelBtnEl.style.display = '';
            return;
          }
          fetch('/api/poll/' + newJobId, { method: 'POST', credentials: 'include' })
            .then(function(r) { return r.json(); })
            .then(function(pd) {
              if (pd.status === 'ready') {
                clearInterval(pollInterval);

                // ── Transition pipeline card to READY state (playable) ──────────
                // Exactly mirrors what the regular generator does when job is ready.
                var stereoUrl = pd.stereo_url || '';
                window._pipelineAudioUrl = [null, stereoUrl, stereoUrl];

                // Hide spinner overlay, show play button
                if (overlayEl) {
                  overlayEl.style.transition = 'opacity .4s';
                  overlayEl.style.opacity = '0';
                  setTimeout(function() { overlayEl.style.display = 'none'; }, 400);
                }
                if (playBtnEl) playBtnEl.style.display = 'flex';

                // Update title and message
                var remixLabel = (pd.title || title).replace(/_/g,' ');
                // Highlight "Remix" suffix in purple neon
                var displayLabel = remixLabel.replace(/\s*Remix\s*$/i,
                  ' <span style="color:#c084fc;font-weight:700;text-shadow:0 0 8px rgba(192,132,252,.6)">Remix</span>');
                if (titleEl) titleEl.innerHTML = displayLabel;
                if (msgEl)   { msgEl.textContent = 'Ready \u00b7 tap to play'; msgEl.classList.add('is-done'); }
                if (statusSubEl) statusSubEl.style.display = 'none';
                if (cancelBtnEl) cancelBtnEl.style.display = 'none';
                // Show X close button now that it's ready
                var closeBtnEl = document.getElementById('pipeline-close-btn');
                if (closeBtnEl) { closeBtnEl.style.display = 'flex'; }

                // Wire audio element
                if (audioEl && stereoUrl) {
                  audioEl.src = stereoUrl;
                  audioEl.preload = 'auto';
                }
                // Wire scrubber
                if (scrubberEl) scrubberEl.style.display = '';
                if (window._pipelineWireScrubber) window._pipelineWireScrubber(1);

                // Mark card ready
                var card1 = document.getElementById('pipeline-card-1');
                if (card1) card1.classList.add('is-ready');

                // Mark remixes tab cache stale so it reloads next time user opens it
                if (window._libLoaded) window._libLoaded.remixes = false;

              } else if (pd.status === 'error') {
                clearInterval(pollInterval);
                if (pipelineEl) pipelineEl.style.display = 'none';
                if (cancelBtnEl) cancelBtnEl.style.display = '';
                _remixShowError('Remix failed — please try again.');
              }
            })
            .catch(function() { /* transient poll error — keep retrying */ });
        }, 5000);
      })
      .catch(function(err) {
        if (pipelineEl) pipelineEl.style.display = 'none';
        if (cancelBtnEl) cancelBtnEl.style.display = '';
        _remixShowError('Remix request failed: ' + (err.message || 'Unknown error'));
      });
  };

  // ── Show error toast ────────────────────────────────────────────────────────
  function _remixShowError(msg) {
    var errDiv = document.createElement('div');
    errDiv.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;' +
      'background:#1a0a0a;border:1px solid rgba(239,68,68,.5);color:#f87171;' +
      'border-radius:10px;padding:12px 18px;font-size:.82rem;font-weight:600;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.55);display:flex;align-items:center;gap:10px';
    errDiv.innerHTML = '<i class="fas fa-exclamation-circle"></i><span>' + msg + '</span>' +
      '<button onclick="this.parentNode.remove()" style="margin-left:8px;background:none;border:none;' +
      'color:rgba(255,255,255,.4);cursor:pointer;font-size:.9rem;padding:0">\u2715</button>';
    document.body.appendChild(errDiv);
    setTimeout(function() { if (errDiv.parentNode) errDiv.remove(); }, 8000);
  }

  // ── Drag-over/leave for drop zone ────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    var zone = document.getElementById('remix-drop-zone');
    if (!zone) return;
    zone.addEventListener('dragover', function(e) {
      e.preventDefault();
      zone.style.borderColor = 'rgba(168,85,247,.7)';
      zone.style.background  = 'rgba(168,85,247,.08)';
    });
    zone.addEventListener('dragleave', function() {
      zone.style.borderColor = '';
      zone.style.background  = '';
    });
  });
})();

// ── Reference Track Dropdown toggle ──────────────────────────────────────────
// Closes any open popup/overlay first, then toggles the ref inline panel.
window.toggleRefDropdown = function() {
  // Pro Artist only
  var _plan = (window._sfUser && window._sfUser.plan) || 'free';
  if (_plan !== 'pro' && _plan !== 'developer') {
    showProUpgradeModal('Reference Track');
    return;
  }
  // Close any open creator popup first (e.g. extend popup)
  var anyOpen = document.querySelector('.creator-popup[style*="display: flex"], .creator-popup[style*="display:flex"]');
  if (anyOpen) {
    var popupId = anyOpen.id || '';
    var name = popupId.replace('creator-popup-', '');
    if (name && window.closeCreatorPopup) window.closeCreatorPopup(name);
  }

  var panel = document.getElementById('ref-inline-panel');
  var chev  = document.getElementById('ctab-ref-chevron');
  var btn   = document.getElementById('ctab-reference');
  if (!panel) return;
  var isOpen = panel.style.display !== 'none' && panel.style.display !== '';
  if (isOpen) {
    panel.style.display = 'none';
    if (chev) chev.style.transform = '';
    var refLoaded = window._refFileId || window.refFileId;
    if (btn && !refLoaded) btn.classList.remove('active');
  } else {
    panel.style.display = 'block';
    if (chev) chev.style.transform = 'rotate(180deg)';
    if (btn) btn.classList.add('active');
  }
};
