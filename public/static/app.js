/* ═══════════════════════════════════════════════════════════════
   StemForge — Frontend App JS
   Real pipeline: GPT-4o blueprint → Mureka generation → track extraction
═══════════════════════════════════════════════════════════════ */

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
      creator: { name: 'Creator Plan', price: '$19', total: '$19.00', features: ['50 downloads/month', 'Mastered stereo mix download', 'Commercial use rights'] },
      pro:     { name: 'Pro Artist Plan', price: '$39', total: '$39.00', features: ['200 downloads/month', 'Unmastered mix, mastered mix, or stems bundle', 'Priority queue'] },
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
    if (page === 'home' && currentPath === '/') link.classList.add('active');
    if (page === 'generator' && currentPath.startsWith('/generator')) link.classList.add('active');
    if (page === 'dashboard' && currentPath.startsWith('/dashboard')) link.classList.add('active');
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

  // ── Global auth state: populate sidebar + top nav ─────────────
  window._sfUser = null;
  (async () => {
    try {
      const res = await fetch('/api/auth/me');
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
      // All tiers show downloads used / limit directly (1 generation = 1 download)
      const plan = user.plan || 'free';
      const creditsLabel = document.getElementById('gs-credits-label');
      const limitMap = { free: 5, creator: 50, pro: 200 };
      const displayLimit = user.gens_limit || limitMap[plan] || 3;
      if (creditsLabel) creditsLabel.textContent = 'Downloads';
      if (gsGensVal) gsGensVal.innerHTML = `${user.gens_used} <small>/ ${displayLimit}</small>`;
      if (gsGensBar) {
        const pct = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0;
        gsGensBar.style.width = pct + '%';
      }

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
      if (dashGensVal) dashGensVal.innerHTML = `${user.gens_used} <small>/ ${user.gens_limit} gen</small>`;
      if (dashGensBar) {
        const pct2 = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0;
        dashGensBar.style.width = pct2 + '%';
      }
    } catch(e) {}
  })();

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
  const _libLoaded  = { beats: false, oneshots: false, trash: false, extended: false, uploads: false };
  // Cached project arrays per tab (for client-side search)
  const _libData    = { beats: [], oneshots: [], trash: [], extended: [], uploads: [] };
  let   _libActive  = 'beats';

  // ── Canvas art generator (shared helper) ───────────────────
  function drawCanvasArt(artEl, hue, title, genre) {
    try {
      const W = 320, H = 320;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');

      // ── Background gradient (unique per hue) ──
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0,   `hsl(${hue},70%,16%)`);
      grad.addColorStop(0.5, `hsl(${(hue+50)%360},80%,10%)`);
      grad.addColorStop(1,   `hsl(${(hue+100)%360},65%,7%)`);
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      // ── Accent glow spots ──
      const r1 = ctx.createRadialGradient(W*0.75, H*0.22, 10, W*0.75, H*0.22, W*0.48);
      r1.addColorStop(0, `hsla(${(hue+130)%360},90%,65%,0.38)`);
      r1.addColorStop(1, 'transparent');
      ctx.fillStyle = r1; ctx.fillRect(0, 0, W, H);

      const r2 = ctx.createRadialGradient(W*0.2, H*0.78, 5, W*0.2, H*0.78, W*0.4);
      r2.addColorStop(0, `hsla(${(hue+250)%360},75%,60%,0.28)`);
      r2.addColorStop(1, 'transparent');
      ctx.fillStyle = r2; ctx.fillRect(0, 0, W, H);

      // ── Subtle noise grain ──
      for (let i = 0; i < 200; i++) {
        const nx = (Math.sin(i * 127.1 + hue) * 0.5 + 0.5) * W;
        const ny = (Math.sin(i * 311.7 + hue * 0.3) * 0.5 + 0.5) * H;
        const a = 0.03 + (Math.sin(i * 53.7) * 0.5 + 0.5) * 0.08;
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.fillRect(nx, ny, 1.5, 1.5);
      }

      // ── Waveform bars (centre) ──
      const barCount = 22, barW = 7, gap = 3;
      const totalW = barCount * (barW + gap) - gap;
      const startX = (W - totalW) / 2;
      const centreY = H * 0.52;
      for (let b = 0; b < barCount; b++) {
        const seed = hue * 17 + b * 83;
        const h = 14 + (Math.sin(seed * 0.11) * 0.5 + 0.5) * 52;
        const x = startX + b * (barW + gap);
        const y = centreY - h / 2;
        const bg = ctx.createLinearGradient(0, y, 0, y + h);
        bg.addColorStop(0, `hsla(${(hue+30)%360},85%,78%,0.95)`);
        bg.addColorStop(1, `hsla(${hue},65%,45%,0.45)`);
        ctx.fillStyle = bg;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, barW, h, 2);
        else ctx.rect(x, y, barW, h);
        ctx.fill();
      }

      // ── Genre label (top) ──
      ctx.font = 'bold 11px system-ui,sans-serif';
      ctx.fillStyle = `hsla(${hue},65%,85%,0.65)`;
      ctx.textAlign = 'center';
      ctx.letterSpacing = '1.5px';
      ctx.fillText((genre||'music').toUpperCase().slice(0,16), W/2, 26);
      ctx.letterSpacing = '0';

      // ── Song title (bottom) — large, bold, white with shadow ──
      const displayTitle = (title || 'Untitled Beat').trim();
      const maxChars = 18;
      const words = displayTitle.split(' ');
      let line1 = '', line2 = '';
      // Split into 2 lines smartly
      let cur = '';
      for (let i = 0; i < words.length; i++) {
        const test = cur ? cur + ' ' + words[i] : words[i];
        if (test.length <= maxChars) { cur = test; }
        else { line1 = cur; cur = words[i]; }
      }
      if (!line1) { line1 = cur; cur = ''; }
      line2 = cur;

      // Semi-transparent title background strip
      const titleY = line2 ? H - 60 : H - 44;
      const stripH = line2 ? 54 : 38;
      const stripGrad = ctx.createLinearGradient(0, titleY - 8, 0, titleY + stripH);
      stripGrad.addColorStop(0, 'rgba(0,0,0,0)');
      stripGrad.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = stripGrad;
      ctx.fillRect(0, titleY - 8, W, stripH + 16);

      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      if (line2) {
        ctx.font = 'bold 17px system-ui,sans-serif';
        ctx.fillText(line1.slice(0, maxChars), W/2, titleY + 14);
        ctx.fillText(line2.slice(0, maxChars), W/2, titleY + 35);
      } else {
        ctx.font = 'bold 19px system-ui,sans-serif';
        ctx.fillText(line1.slice(0, maxChars), W/2, titleY + 20);
      }
      ctx.shadowBlur = 0;

      // ── StemForge "SF" monogram mark (bottom-right corner) ──
      ctx.font = 'bold 10px system-ui,sans-serif';
      ctx.fillStyle = `hsla(${hue},70%,75%,0.45)`;
      ctx.textAlign = 'right';
      ctx.fillText('STEMFORGE', W - 10, H - 8);

      artEl.style.backgroundImage = `url('${canvas.toDataURL('image/png')}')`;
      artEl.style.backgroundSize = 'cover';
      artEl.style.backgroundPosition = 'center';
    } catch(e) { /* gradient fallback */ }
  }
  // Expose globally so the edit modal (outside this IIFE) can call it
  window.drawCanvasArt = drawCanvasArt;

  // ── Load AI cover images async for a grid element ───────────
  function loadCoverImages(gridEl) {
    // Canvas-only art — no external image fetches, no AI cover images
    gridEl.querySelectorAll('.project-card[data-hue]').forEach((card) => {
      const hue   = parseInt(card.dataset.hue || '180', 10);
      const title = card.dataset.title || '';
      const genre = card.dataset.genre || 'music';
      const artEl = card.querySelector('.project-card__art');
      if (!artEl) return;
      // Draw canvas art — this sets artEl.style.backgroundImage to the canvas data URL
      // NOTE: do NOT clear backgroundImage after calling drawCanvasArt — that would wipe the canvas art
      drawCanvasArt(artEl, hue, title, genre);
    });
  }

  // ── Render a single beats/songs card ───────────────────────
  function renderBeatCard(p, i) {
    const hue  = p.thumbnail_seed != null ? p.thumbnail_seed : (i * 47) % 360;
    const thumbBg = `linear-gradient(135deg, hsl(${hue},70%,30%) 0%, hsl(${(hue+60)%360},80%,20%) 100%)`;
    const bpm  = p.blueprint ? p.blueprint.bpm + ' BPM' : '';
    const genre= (p.blueprint && p.blueprint.genre) ? p.blueprint.genre : 'music';
    const rawTitle = p.title || (p.blueprint ? (p.blueprint.genre + (p.blueprint.key ? ' — '+p.blueprint.key:'')) : (p.blueprint ? p.blueprint.genre : 'Beat'));
    const sub  = bpm || '';
    const safeFilename = rawTitle.replace(/[^a-zA-Z0-9\s\-_]/g,'').replace(/\s+/g,'_').toLowerCase();
    return `
      <div class="project-card"
           data-stereo="${p.stereo_url||''}" data-zip="${p.zip_url||''}"
           data-id="${p.id}"
           data-title="${rawTitle.replace(/"/g,'&quot;')}"
           data-hue="${hue}"
           data-genre="${(genre||'music').replace(/"/g,'&quot;')}"
           >
        <div class="project-card__art" style="background:hsl(${hue},50%,10%)">
          <div class="project-card__play" onclick="playDashProject(this)">
            <i class="fas fa-play"></i>
          </div>
        </div>
        <div class="project-card__body">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
            <h4 style="margin:0;flex:1">${rawTitle}</h4>
            <button class="song-dots-btn" title="More options"
              onclick="event.stopPropagation();openCardMenu(this,'${p.id}','${p.stereo_url||''}','${p.zip_url||''}','${safeFilename}','beats')"
              style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>
          </div>
          <p>${sub||genre||label}</p>
          <div class="project-card__tags">
            ${bpm ? `<span class="export-badge" style="background:rgba(78,159,255,.12);color:var(--primary);border:1px solid rgba(78,159,255,.25);font-size:.72rem">${bpm}</span>` : ''}
          </div>
        </div>
      </div>`;
  }

  // ── Render a single one-shot card ───────────────────────────
  function renderOneshotCard(p, i) {
    const soundType = p.sound_type || 'One Shot';
    const label = soundType.charAt(0).toUpperCase() + soundType.slice(1);
    const safeFilename = soundType.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase();
    const audioUrl = p.audio_url || '';
    return `
      <div class="project-card project-card--oneshot"
           data-stereo="${audioUrl}"
           data-id="${p.id}"
           data-title="${label.replace(/"/g,'&quot;')}">
        <div class="project-card__art" style="background:linear-gradient(135deg,#1a1240,#0d0a1e)">
          <div class="project-card__art-icon"><i class="fas fa-bolt" style="color:#a855f7"></i></div>
          ${audioUrl ? `<div class="project-card__play" onclick="playDashProject(this)"><i class="fas fa-play"></i></div>` : ''}
        </div>
        <div class="project-card__body">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
            <h4 style="margin:0;flex:1">${label}</h4>
            <button class="song-dots-btn" title="More options"
              onclick="event.stopPropagation();openCardMenu(this,'${p.id}','${audioUrl}','','${safeFilename}','oneshots')"
              style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>
          </div>
          <p style="margin-bottom:8px">One Shot · ${new Date(p.created_at).toLocaleDateString()}</p>
          ${audioUrl ? `<audio class="oneshot-card-audio" src="${audioUrl}" controls preload="none"></audio>` : ''}
        </div>
      </div>`;
  }

  // ── Render a single trash card ──────────────────────────────
  function renderTrashCard(p, i) {
    const hue  = p.thumbnail_seed != null ? p.thumbnail_seed : (i * 47) % 360;
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
      };
      gridEl.innerHTML = `<div class="project-grid-empty">${emptyMsgs[tab]||''}</div>`;
      return;
    }
    let html = '';
    projects.forEach((p, i) => {
      if (tab === 'beats')    html += renderBeatCard(p, i);
      else if (tab === 'oneshots') html += renderOneshotCard(p, i);
      else if (tab === 'trash')    html += renderTrashCard(p, i);
    });
    if (tab === 'beats') {
      html += `<div class="project-card project-card--new"><a href="/generator" class="project-card__new-inner"><i class="fas fa-plus-circle"></i><span>New beat</span></a></div>`;
    }
    gridEl.innerHTML = html;
    if (tab === 'beats') loadCoverImages(gridEl);
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
    ['beats','extended','oneshots','uploads','trash'].forEach(t => {
      const panel = document.getElementById('lib-panel-' + t);
      if (panel) panel.style.display = t === tab ? '' : 'none';
    });
    // Update search placeholder
    const searchInput = document.getElementById('lib-search');
    if (searchInput) {
      const placeholders = { beats: 'Search beats…', extended: 'Search extended tracks…', oneshots: 'Search one shots…', uploads: 'Search uploads…', trash: 'Search trash…' };
      searchInput.placeholder = placeholders[tab] || 'Search…';
      // Reset search when switching tabs
      searchInput.value = '';
      filterLibrary('');
    }
    // Load data if not yet loaded
    if (tab === 'uploads') {
      fetchUploadsTab();
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
    if (_libLoaded.uploads) { renderUploadsGrid(gridEl, _libData.uploads); return; }
    gridEl.innerHTML = '<div class="project-grid-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    try {
      const res = await fetch('/api/reference-uploads');
      if (!res.ok) {
        if (res.status === 401) {
          gridEl.innerHTML = '<div class="project-grid-loading" style="color:var(--muted)"><i class="fas fa-lock"></i> Sign in to see your uploads. <a href="/login">Log in</a></div>';
          return;
        }
        throw new Error('HTTP ' + res.status);
      }
      const { uploads } = await res.json();
      _libData.uploads = uploads || [];
      _libLoaded.uploads = true;
      updateTabCount('uploads', _libData.uploads.length);
      renderUploadsGrid(gridEl, _libData.uploads);
    } catch(e) {
      gridEl.innerHTML = '<div class="project-grid-loading" style="color:var(--muted)">Could not load uploads.</div>';
    }
  }

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      if (!r.ok) throw new Error('Delete failed');
      // Refresh beats/extended/oneshots and trash tabs
      _libLoaded.beats = false; _libLoaded.oneshots = false; _libLoaded.trash = false; _libLoaded.extended = false;
      fetchLibTab(_libActive);
      if (_libActive !== 'trash') fetchLibTab('trash'); // pre-load trash count
    } catch(e) { alert('Could not delete item. Please try again.'); }
  };

  // ── Restore a trashed card ──────────────────────────────────
  window.restoreLibItem = async function(jobId) {
    try {
      const r = await fetch('/api/job/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      if (!r.ok) throw new Error('Restore failed');
      _libLoaded.beats = false; _libLoaded.oneshots = false; _libLoaded.trash = false;
      fetchLibTab('trash');
    } catch(e) { alert('Could not restore item. Please try again.'); }
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
          <h3 style="font-size:1.25rem;font-weight:700;margin-bottom:8px">Upgrade to download</h3>
          <p style="color:var(--muted);font-size:.9rem;margin-bottom:24px;line-height:1.5">Free accounts can listen, but downloads require a <strong>Creator</strong> or <strong>Pro Artist</strong> plan.</p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <a href="/pricing?plan=creator" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-crown"></i> Creator — $19/mo · 50 beats</a>
            <a href="/pricing?plan=pro" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-star"></i> Pro Artist — $39/mo · 200 beats</a>
          </div>
          <p style="color:var(--muted);font-size:.78rem;margin-top:16px">Your beats are saved — upgrade anytime to download them.</p>
        </div>`;
      document.body.appendChild(m);
    }
    // Load initial tab (beats)
    fetchLibTab('beats');
  }

  // ── Dashboard: card 3-dots context menu ─────────────────────────
  window.openCardMenu = function(btn, jobId, stereoUrl, zipUrl, safeTitle, cardTab) {
    const existing = document.getElementById('card-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'card-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.55);min-width:200px;overflow:hidden;padding:4px 0';

    const isOneshot = cardTab === 'oneshots';

    const items = [];

    // Edit only for full beats
    if (!isOneshot) {
      items.push({ icon: 'fa-pencil-alt', label: 'Edit track info', action: () => openSongEditModal(null, jobId) });
      items.push({ icon: 'fa-expand-arrows-alt', label: 'Extend Song — 2 Credits', action: () => {
        // Navigate to the generator page with ?extend=jobId — the page will auto-open the popup
        window.location.href = '/generator?extend=' + encodeURIComponent(jobId);
      }});
    }

    if (stereoUrl) {
      items.push({ icon: 'fa-download', label: isOneshot ? 'Download' : 'Download Full Track',
        action: () => openDownloadModal(jobId, stereoUrl, safeTitle) });
    }

    // Get Stems — for full beats (not oneshots)
    if (!isOneshot && stereoUrl) {
      items.push({ icon: 'fa-layer-group', label: 'Get Stems', action: () => {
        if (typeof window.openStemsPanel === 'function') {
          window.openStemsPanel(jobId, stereoUrl, safeTitle);
        }
      }});
    }

    // Delete — goes to trash
    items.push({ icon: 'fa-trash-alt', label: 'Move to Trash', danger: true,
      action: () => deleteLibItem(jobId) });

    items.forEach(item => {
      const el = document.createElement('button');
      el.style.cssText = `display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;background:none;border:none;color:${item.danger?'var(--danger)':'var(--text)'};cursor:pointer;font-size:.875rem;font-weight:500;text-align:left;transition:background .12s`;
      el.innerHTML = `<i class="fas ${item.icon}" style="width:15px;opacity:.7;flex-shrink:0"></i>${item.label}`;
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
      alert('No audio available for this track yet. Generate the beat first.');
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
          <a href="${stereoUrl}" download="${title}.mp3"
             onclick="document.getElementById('sf-download-modal').remove()"
             style="display:flex;align-items:center;justify-content:center;gap:10px;padding:13px 20px;background:linear-gradient(135deg,var(--primary),#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
            <i class="fas fa-file-audio"></i> Download MP3
          </a>
          <a href="/api/download-wav/${jobId}" download="${title}.wav"
             onclick="document.getElementById('sf-download-modal').remove()"
             style="display:flex;align-items:center;justify-content:center;gap:10px;padding:13px 20px;background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border);border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
            <i class="fas fa-file-waveform"></i> Download WAV
          </a>
        </div>
        <p style="color:var(--muted);font-size:.75rem;margin-top:14px;opacity:.7">WAV = lossless quality · MP3 = smaller file size</p>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  };

  // ── Dashboard: play project audio ───────────────────────────────
  window.playDashProject = function(btn) {
    const card = btn.closest('.project-card');
    const stereoUrl = card.dataset.stereo;
    const trackTitle = card.dataset.title || card.querySelector('h4')?.textContent || 'Beat';
    if (!stereoUrl) {
      btn.closest('.project-card__art').style.opacity = '0.5';
      setTimeout(() => btn.closest('.project-card__art').style.opacity = '', 800);
      return;
    }
    // Stop any existing mini-player
    const existing = document.getElementById('dash-mini-player');
    if (existing) existing.remove();
    // Create mini player
    const player = document.createElement('div');
    player.id = 'dash-mini-player';
    player.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card-bg,#1a1a2e);border:1px solid var(--border,#333);border-radius:16px;padding:14px 20px;display:flex;align-items:center;gap:14px;z-index:9999;box-shadow:0 8px 40px rgba(0,0,0,.6);min-width:340px;max-width:580px;backdrop-filter:blur(12px)';
    player.innerHTML = `
      <audio id="dash-audio" src="${stereoUrl}" preload="auto"></audio>
      <button id="dash-play-pause" style="width:42px;height:42px;border-radius:50%;background:var(--primary,#4e9fff);border:none;cursor:pointer;color:#fff;font-size:17px;flex-shrink:0;display:flex;align-items:center;justify-content:center" onclick="dashTogglePlay()"><i class="fas fa-pause"></i></button>
      <button id="dash-repeat-btn" title="Repeat" onclick="dashToggleRepeat()" style="width:34px;height:34px;border-radius:50%;background:none;border:1px solid var(--border,#333);cursor:pointer;color:var(--muted,#888);font-size:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s"><i class="fas fa-redo"></i></button>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${card.querySelector('h4')?.textContent || trackTitle}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="dash-time-cur" style="font-size:.72rem;color:var(--muted,#888);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:32px">0:00</span>
          <input type="range" id="dash-seek" min="0" max="100" value="0" step="0.1" style="flex:1;accent-color:var(--primary,#4e9fff);cursor:pointer;height:3px"/>
          <span id="dash-time-dur" style="font-size:.72rem;color:var(--muted,#888);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:32px;text-align:right"></span>
        </div>
      </div>
      <button onclick="document.getElementById('dash-mini-player').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted,#888);font-size:18px;flex-shrink:0;line-height:1"><i class="fas fa-times"></i></button>
    `;
    document.body.appendChild(player);
    const audio = document.getElementById('dash-audio');
    const seekBar = document.getElementById('dash-seek');
    const timeCur = document.getElementById('dash-time-cur');
    const timeDur = document.getElementById('dash-time-dur');

    function fmtSecs(s) {
      if (!isFinite(s)) return '0:00';
      const m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return m + ':' + String(sec).padStart(2, '0');
    }

    let _dashRepeat = false;

    audio.play().catch(()=>{});
    audio.addEventListener('loadedmetadata', () => {
      if (timeDur) timeDur.textContent = fmtSecs(audio.duration);
    });
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) {
        seekBar.value = (audio.currentTime / audio.duration) * 100;
        if (timeCur) timeCur.textContent = fmtSecs(audio.currentTime);
        if (timeDur) timeDur.textContent = fmtSecs(audio.duration);
      }
    });
    seekBar.addEventListener('input', () => {
      if (audio.duration) audio.currentTime = (seekBar.value / 100) * audio.duration;
    });
    audio.addEventListener('ended', () => {
      if (_dashRepeat) {
        audio.currentTime = 0;
        audio.play().catch(()=>{});
      } else {
        document.getElementById('dash-play-pause').innerHTML = '<i class="fas fa-play"></i>';
        seekBar.value = 0;
        if (timeCur) timeCur.textContent = '0:00';
      }
    });
  };
  window.dashTogglePlay = function() {
    const audio = document.getElementById('dash-audio');
    const btn = document.getElementById('dash-play-pause');
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(()=>{});
      if (btn) btn.innerHTML = '<i class="fas fa-pause"></i>';
    } else {
      audio.pause();
      if (btn) btn.innerHTML = '<i class="fas fa-play"></i>';
    }
  };
  window.dashToggleRepeat = function() {
    const player = document.getElementById('dash-mini-player');
    if (!player) return;
    // Find the _dashRepeat variable via closure — toggle via data attribute
    const audio = document.getElementById('dash-audio');
    const btn = document.getElementById('dash-repeat-btn');
    if (!btn || !audio) return;
    const isRepeat = btn.dataset.repeat === '1';
    btn.dataset.repeat = isRepeat ? '0' : '1';
    audio.loop = !isRepeat;
    if (!isRepeat) {
      btn.style.color = 'var(--primary,#4e9fff)';
      btn.style.borderColor = 'var(--primary,#4e9fff)';
      btn.style.background = 'rgba(78,159,255,.12)';
    } else {
      btn.style.color = 'var(--muted,#888)';
      btn.style.borderColor = 'var(--border,#333)';
      btn.style.background = 'none';
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

  // ── Card collapses (Lyrics / Styles) ─────────────────────────
  ['lyrics', 'styles'].forEach(id => {
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
    if (activeTab === 'write' && lyrics) parts.push('lyrics: ' + lyrics);
    if (prompt) parts.push(prompt);
    if (instrumental) parts.push('instrumental only, no vocals');
    if (instruments) parts.push('include instruments: ' + instruments);

    return {
      genre: style || '',
      prompt: parts.join('. '),
      vocal_space: instrumental ? 'none' : 'high',
      instruments_include: instruments ? instruments.split(',').map(s=>s.trim()).filter(Boolean) : [],
      instruments_exclude: [],
      title,
      instrumental
    };
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
    if (!bp || !bpPills) return;
    bpPills.innerHTML = '';
    const pills = [
      { icon: 'fa-drum',        label: bp.bpm ? bp.bpm + ' BPM' : null },
      { icon: 'fa-music',       label: (bp.key || bp.scale) ? (bp.key + ' ' + bp.scale).trim() : null },
      { icon: 'fa-compact-disc',label: bp.genre || null },
      { icon: 'fa-heart',       label: bp.mood || null },
      { icon: 'fa-bolt',        label: bp.energy ? bp.energy + ' energy' : null },
    ].filter(p => p.label);
    pills.forEach(p => {
      const el = document.createElement('span');
      el.className = 'blueprint-pill';
      el.innerHTML = `<i class="fas ${p.icon}"></i> ${p.label}`;
      bpPills.appendChild(el);
    });
    // Show individual instrument name pills if available, otherwise show count
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
    bpBlueprint.style.display = 'block';
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
    if (pipelineStatus) { pipelineStatus.style.display = 'block'; }
    if (bpBlueprint) bpBlueprint.style.display = 'none';

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
          vocal_space: inputs.vocal_space,
          energy: inputs.energy,
          instruments_include: inputs.instruments_include,
          instruments_exclude: inputs.instruments_exclude,
          title: inputs.title || '',
          vocal_gender: window._vocalGender || 'off',
          beat_count: window._beatCount || 1,
          user_duration: window._userDuration || 0
        })
      });

      if (!res.ok) {
        const err = await res.json();
        if (err.limit_reached) {
          // Show upgrade prompt instead of generic error
          genBtn.innerHTML = '<i class="fas fa-music"></i> Create';
          genBtn.disabled = false;
          pipelineStatus.style.display = 'none';
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

      const { job_id } = await res.json();
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
          const job = await pollRes.json();

          // Update pipeline steps
          // Update spinner message based on status
          const spinnerMsg = document.getElementById('pipeline-spinner-msg');
          if (job.status === 'blueprint' && lastStatus !== 'blueprint') {
            setStep('blueprint', 'active');
            if (spinnerMsg) spinnerMsg.textContent = 'Analyzing your prompt...';
            lastStatus = 'blueprint';
          }
          if (job.status === 'generating' && lastStatus !== 'generating') {
            setStep('blueprint', 'done');
            setStep('generating', 'active');
            if (spinnerMsg) spinnerMsg.textContent = 'Composing your beat...';
            if (job.blueprint) showBlueprint(job.blueprint);
            lastStatus = 'generating';
          }
          if (job.status === 'extracting' && lastStatus !== 'extracting') {
            setStep('blueprint', 'done');
            setStep('generating', 'done');
            setStep('extracting', 'active');
            if (job.blueprint) showBlueprint(job.blueprint);

            // Show stereo player immediately (audio player always shown; download gated by plan)
            if (job.stereo_url && stereoPlayer && stereoAudio) {
              stereoAudio.src = job.stereo_url;
              stereoPlayer.style.display = 'block';
              if (stereoDownload) {
                // Hide download link during extraction (will be finalized in 'ready' block)
                stereoDownload.style.display = 'none';
              }
            }

            // Show result panel early
            if (genResult) genResult.style.display = 'block';
            lastStatus = 'extracting';
          }

          if (job.status === 'ready') {
            clearInterval(pollInterval);
            setStep('blueprint', 'done');
            setStep('generating', 'done');
            setStep('extracting', 'done');

            // ── Collapse the spinner window ──────────────────────
            if (pipelineStatus) {
              pipelineStatus.style.transition = 'opacity .4s ease';
              pipelineStatus.style.opacity = '0';
              setTimeout(() => { pipelineStatus.style.display = 'none'; pipelineStatus.style.opacity = '1'; }, 400);
            }

            // ── Resolve final track title ─────────────────────────
            const finalTitle = job.title ||
              (job.blueprint ? (job.blueprint.genre + ' — ' + job.blueprint.key + ' ' + job.blueprint.scale) : 'Beat Ready');
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
                    <h3 style="font-size:1.25rem;font-weight:700;margin-bottom:8px">Upgrade to download</h3>
                    <p style="color:var(--muted);font-size:.9rem;margin-bottom:24px;line-height:1.5">Free accounts can listen to your beat, but downloads require a <strong>Creator</strong> or <strong>Pro Artist</strong> plan.</p>
                    <div style="display:flex;flex-direction:column;gap:10px">
                      <a href="/pricing?plan=creator" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
                        <i class="fas fa-crown"></i> Creator — $19/mo · 50 beats
                      </a>
                      <a href="/pricing?plan=pro" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem">
                        <i class="fas fa-star"></i> Pro Artist — $39/mo · 200 beats
                      </a>
                    </div>
                    <p style="color:var(--muted);font-size:.78rem;margin-top:16px">You keep your generated beat — just upgrade anytime to download it.</p>
                  </div>`;
                document.body.appendChild(modal);
              } else {
                modal.style.display = 'flex';
              }
            }

            // Stereo player — show audio player always, gate the download button
            if (job.stereo_url && stereoPlayer && stereoAudio) {
              stereoAudio.src = job.stereo_url;
              stereoPlayer.style.display = 'block';
              if (stereoDownload) {
                stereoDownload.style.display = '';  // make visible again
                if (isFree) {
                  // Show lock state on download button
                  stereoDownload.href = '#';
                  stereoDownload.setAttribute('download', '');
                  stereoDownload.innerHTML = '<i class="fas fa-lock"></i> Upgrade to download';
                  stereoDownload.style.opacity = '0.7';
                  stereoDownload.addEventListener('click', e => { e.preventDefault(); showUpgradePrompt(); });
                } else {
                  stereoDownload.href = job.stereo_url;
                  stereoDownload.setAttribute('download', safeFilename + '_stereo.mp3');
                  stereoDownload.innerHTML = '<i class="fas fa-download"></i> Download';
                  stereoDownload.style.opacity = '';
                }
              }
            }

            // Build export action buttons — Creator: mastered only; Pro: 3 options
            const exportOptionsRow = document.getElementById('export-options-row');
            if (exportOptionsRow) {
              exportOptionsRow.innerHTML = '';

              // Helper: trigger download in WAV (via /api/download-wav) or MP3 (direct)
              function doDownload(url, filename, format) {
                if (format === 'wav') {
                  const jobIdDl = job.id || currentJobId;
                  const a = document.createElement('a');
                  a.href = '/api/download-wav/' + jobIdDl;
                  a.download = filename + '.wav';
                  document.body.appendChild(a); a.click(); a.remove();
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
                    window.openStemsPanel(job.id, job.stereo_url, finalTitle || safeFilename);
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

            // Update result header with AI-generated or user title
            const titleEl = document.getElementById('gen-result-title');
            const subEl   = document.getElementById('gen-result-sub');
            if (titleEl) titleEl.textContent = finalTitle;
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

            if (genResult) genResult.style.display = 'block';
            genBtn.innerHTML = '<i class="fas fa-check"></i> Done!';
            genBtn.disabled = false;
            // Refresh sidebar downloads counter to reflect the new usage
            fetch('/api/auth/me').then(r => r.json()).then(({ user }) => {
              if (!user) return;
              // Update global user object
              if (window._sfUser) {
                window._sfUser.gens_used  = user.gens_used;
                window._sfUser.gens_limit = user.gens_limit;
                window._sfUser.plan       = user.plan;
              }
              const gv = document.getElementById('gs-gens-val');
              const gb = document.getElementById('gs-gens-bar');
              const cl = document.getElementById('gs-credits-label');
              if (cl) cl.textContent = 'Downloads';
              // Always show downloads used / limit directly
              const limitMap = { free: 5, creator: 50, pro: 200 };
              const displayLimit = user.gens_limit || limitMap[user.plan] || 3;
              if (gv) gv.innerHTML = `${user.gens_used} <small>/ ${displayLimit}</small>`;
              if (gb) {
                const pct = user.gens_limit > 0 ? Math.min(100, Math.round(user.gens_used / user.gens_limit * 100)) : 0;
                gb.style.width = pct + '%';
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
            showError(job.error || 'Generation failed. Please try again.');
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
      const dur = jobData.blueprint.duration_seconds;
      document.getElementById('edit-info-duration').textContent = dur ? Math.floor(dur/60)+':'+String(dur%60).padStart(2,'0') : '—';
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
        const dur = job.blueprint.duration_seconds;
        document.getElementById('edit-info-duration').textContent = dur ? Math.floor(dur/60)+':'+String(dur%60).padStart(2,'0') : '—';
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
    updateRefTabBadge();
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
  updateRefTabBadge();
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
    if (status) { status.style.display = 'block'; status.textContent = 'Submitting extend job…'; }

    try {
      const res = await fetch('/api/job/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_job_id: extSelectedJob.id, extend_at: extendAt, lyrics: lyrics })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (status) status.textContent = 'Extend job started! Check your library for the result.';
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
      if (status) { status.style.display = 'block'; status.style.color = '#f87171'; status.textContent = 'Error: ' + (e.message || 'Unknown error'); }
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> Extend Track'; }
    }
  };

  // Hook into openCreatorPopup to load library when extend popup is opened
  const _origOpenCreatorPopup = window.openCreatorPopup;
  window.openCreatorPopup = function(type) {
    if (_origOpenCreatorPopup) _origOpenCreatorPopup(type);
    if (type === 'extend') {
      window.extResetPick && window.extResetPick();
      // Load library, then if a job was pre-selected from the ellipsis menu, auto-select it
      const targetJobId = window._extendFromJobId || null;
      window._extendFromJobId = null; // consume it
      if (targetJobId) {
        // Show loading, then fetch just that job to pre-select
        (async function() {
          try {
            const res = await fetch('/api/job/' + targetJobId);
            const job = await res.json();
            if (job && !job.error) {
              const title = job.title || job.prompt || 'Untitled';
              const genre = (job.blueprint && job.blueprint.genre) ? job.blueprint.genre : '';
              const bpm   = (job.blueprint && job.blueprint.bpm)   ? job.blueprint.bpm + ' BPM' : '';
              const meta  = [genre, bpm].filter(Boolean).join(' · ');
              extSelectedJob = { id: job.id, title: title, meta: meta, coverUrl: job.cover_url || '', audioDuration: job.duration_ms || 0 };
              extSelectTrack(extSelectedJob);
              return;
            }
          } catch(e) {}
          // fallback: load full library
          window._loadExtendLibrary && window._loadExtendLibrary();
        })();
      } else {
        window._loadExtendLibrary && window._loadExtendLibrary();
      }
    }
  };
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
//  ONE SHOT CREATOR (Pro Artist)
// ═══════════════════════════════════════════════════════════

window.selectOneshotType = function(btn) {
  oneshotSelectedType = btn.dataset.sound || '808 bass hit';
  document.querySelectorAll('.oneshot-type-btn').forEach(b => b.classList.remove('oneshot-type-btn--active'));
  btn.classList.add('oneshot-type-btn--active');
};

window.generateOneShot = async function() {
  const btn = document.getElementById('oneshot-gen-btn');
  const statusEl = document.getElementById('oneshot-status');
  const statusMsg = document.getElementById('oneshot-status-msg');
  const resultEl = document.getElementById('oneshot-result');

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…'; }
  if (statusEl) { statusEl.style.display = 'block'; }
  if (statusMsg) statusMsg.textContent = 'Submitting to AI…';
  if (resultEl) resultEl.style.display = 'none';

  const description = document.getElementById('oneshot-desc')?.value?.trim() || '';
  const pitch = document.getElementById('oneshot-pitch')?.value || '';
  const texture = document.getElementById('oneshot-texture')?.value || '';

  // Description is now required (no type tabs)
  if (!description) {
    const descEl = document.getElementById('oneshot-desc');
    if (descEl) { descEl.focus(); descEl.style.borderColor = 'var(--danger,#ef4444)'; setTimeout(() => descEl.style.borderColor = '', 2000); }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> Generate One Shot'; }
    if (statusEl) statusEl.style.display = 'none';
    alert('Please describe the one-shot you want to generate.');
    return;
  }

  // Use the description directly as the sound type (no preset tabs)
  const soundType = description;

  try {
    const res = await fetch('/api/generate-oneshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sound_type: soundType, description, pitch, texture })
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.upgrade) { showUpgradeToast('One Shot Creator requires the Pro Artist plan.'); }
      else { alert('Error: ' + (data.error || 'Generation failed')); }
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> Generate One Shot'; }
      if (statusEl) statusEl.style.display = 'none';
      return;
    }

    const taskId = data.task_id;
    if (statusMsg) statusMsg.textContent = 'AI is crafting your one-shot…';

    // Poll for result
    if (oneshotPollInterval) clearInterval(oneshotPollInterval);
    oneshotPollInterval = setInterval(async () => {
      try {
        const pr = await fetch('/api/poll-oneshot/' + taskId, { method: 'POST' });
        const pd = await pr.json();

        if (pd.status === 'ready') {
          clearInterval(oneshotPollInterval);
          if (statusEl) statusEl.style.display = 'none';
          if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> Generate One Shot'; }

          // Show result
          const audio = document.getElementById('oneshot-audio');
          const titleEl = document.getElementById('oneshot-result-title');
          const dlMp3 = document.getElementById('oneshot-dl-mp3');
          const dlWav = document.getElementById('oneshot-dl-wav');

          if (audio) audio.src = pd.audio_url;
          const safeName = oneshotSelectedType.replace(/[^a-z0-9]/gi, '_').toLowerCase();
          if (titleEl) titleEl.textContent = oneshotSelectedType.charAt(0).toUpperCase() + oneshotSelectedType.slice(1) + ' — Ready';
          if (dlMp3) { dlMp3.href = pd.audio_url; dlMp3.setAttribute('download', safeName + '.mp3'); }
          if (dlWav) { dlWav.href = '/api/download-wav-url?url=' + encodeURIComponent(pd.audio_url) + '&name=' + encodeURIComponent(safeName); dlWav.setAttribute('download', safeName + '.wav'); }
          if (resultEl) resultEl.style.display = 'block';

          if (audio) audio.play().catch(() => {});

        } else if (pd.status === 'error') {
          clearInterval(oneshotPollInterval);
          if (statusEl) statusEl.style.display = 'none';
          if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> Generate One Shot'; }
          alert('Generation failed. Please try again.');
        }
        // else still pending — keep polling
      } catch {}
    }, 4000);

  } catch(err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> Generate One Shot'; }
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

// ── Beat count toggle (1 or 2) — 2 beats is Pro Artist only ──
window._beatCount = 1;
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

window.setBeatCount = function(n) {
  // 2-beat option requires Pro Artist plan
  if (n === 2) {
    const plan = (window._currentPlan || window.currentPlan || '').toLowerCase();
    if (plan !== 'pro' && plan !== 'developer') {
      // Show upgrade nudge
      const bc2 = document.getElementById('bc-2');
      if (bc2) {
        bc2.style.animation = 'none';
        bc2.offsetHeight; // reflow
        bc2.style.animation = 'shake 0.4s ease';
      }
      // Create a temporary tooltip
      let tip = document.getElementById('beat-count-pro-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'beat-count-pro-tip';
        tip.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e1e2e;border:1px solid rgba(168,85,247,.4);color:#c4b5fd;padding:10px 18px;border-radius:10px;font-size:.85rem;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.5)';
        tip.innerHTML = '<i class="fas fa-crown" style="color:#a855f7;margin-right:6px"></i>2 Beats is a <strong>Pro Artist</strong> feature — <a href="/pricing" style="color:#a855f7">upgrade</a>';
        document.body.appendChild(tip);
        setTimeout(() => tip && tip.remove(), 3500);
      }
      return;
    }
  }
  window._beatCount = n;
  [1, 2].forEach(c => {
    const btn = document.getElementById('bc-' + c);
    if (btn) btn.classList.toggle('beat-count-btn--active', c === n);
  });
};

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
//  STEM PLAYER — openStemsPanel(jobId, stereoUrl, title)
//  Centered modal (Suno-style), 3 tabs, lazy load, per-stem S/M/waveform/vol
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

  var ADVANCED_INSTRUMENTS = [
    'vocals','background vocals','lead vocals','rap vocals',
    'drums','kick drum','snare','hi-hat','cymbals','percussion',
    'bass','bass guitar','electric bass','upright bass',
    'guitar','electric guitar','acoustic guitar','rhythm guitar','lead guitar',
    'piano','electric piano','grand piano',
    'synth','synth lead','synth pad','synth bass',
    'strings','violin','viola','cello','double bass','orchestra',
    'brass','trumpet','trombone','french horn','tuba',
    'woodwinds','flute','clarinet','oboe','saxophone','bassoon',
    'organ','hammond organ','church organ',
    'harp','mandolin','banjo','ukulele','accordion',
    'marimba','xylophone','vibraphone','steel pan',
    'choir','backing vocals'
  ];

  // ─────────────────────────────────────────────────────────────────────────
  //  STATE
  // ─────────────────────────────────────────────────────────────────────────
  var _panel       = null;
  var _jobId       = null;
  var _stereoUrl   = null;
  var _title       = null;
  var _activeTab   = null;
  var _stems       = [];
  var _audios      = [];
  var _playing     = false;
  var _pollTimer   = null;
  var _selectedInst= 'vocals';
  var _curTaskId   = null;

  // ─────────────────────────────────────────────────────────────────────────
  //  OPEN / CLOSE
  // ─────────────────────────────────────────────────────────────────────────
  window.openStemsPanel = function (jobId, stereoUrl, title) {
    _jobId     = jobId;
    _stereoUrl = stereoUrl;
    _title     = title || 'Beat';

    var old = document.getElementById('sf-stems-panel');
    if (old) old.remove();
    _cleanup();

    // Outer element = full-screen backdrop
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

    // Animate in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        _panel.style.opacity = '1';
        var card = document.getElementById('sp-card');
        if (card) card.style.transform = 'translateY(0) scale(1)';
      });
    });

    _bindEvents();
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
        'width:100%;max-width:540px;' +
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
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(_title) + '</div>' +
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
          '<i id="sp-play-icon" class="fas fa-play"></i>' +
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
        // pill tab buttons
        '<div style="display:flex;gap:4px;padding:10px 16px 0;background:#0d0d1a">' +
          '<button class="sp-tab" data-tab="auto" style="' +
              'flex:1;height:27px;border-radius:6px;border:none;cursor:pointer;' +
              'font-size:.72rem;font-weight:600;background:rgba(255,255,255,0.04);' +
              'color:rgba(255,255,255,0.42);transition:all .2s">Auto split</button>' +
          '<button class="sp-tab" data-tab="split_from_mix" style="' +
              'flex:1;height:27px;border-radius:6px;border:none;cursor:pointer;' +
              'font-size:.72rem;font-weight:600;background:rgba(255,255,255,0.04);' +
              'color:rgba(255,255,255,0.42);transition:all .2s">Vocals &amp; Inst.</button>' +
          '<button class="sp-tab" data-tab="advanced" style="' +
              'flex:1;height:27px;border-radius:6px;border:none;cursor:pointer;' +
              'font-size:.72rem;font-weight:600;background:rgba(255,255,255,0.04);' +
              'color:rgba(255,255,255,0.42);transition:all .2s">' +
            'Advanced <span style="font-size:.58rem;background:#ec4899;color:#fff;' +
                'padding:1px 4px;border-radius:3px;vertical-align:middle;margin-left:2px">Pro</span>' +
          '</button>' +
        '</div>' +
        // tab body
        '<div id="sp-tab-body" style="padding:12px 16px 14px">' +
          '<p style="color:rgba(255,255,255,0.22);font-size:.78rem;text-align:center;margin:14px 0">' +
            'Select a tab above to extract stems' +
          '</p>' +
        '</div>' +
      '</div>' +

    '</div>'; // end #sp-card
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  function _bindEvents() {
    _panel.querySelectorAll('.sp-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { _onTabClick(btn.dataset.tab); });
    });
    // Click backdrop (outside card) to close.
    // IMPORTANT: use composedPath() not contains() — when Extract is clicked,
    // _setTabBody() replaces innerHTML mid-click, orphaning e.target from the DOM.
    // contains() then returns false on the detached node and falsely fires closeStemsPanel().
    // composedPath() captures the original path BEFORE any DOM mutation, so it still
    // includes #sp-card even after the button is destroyed.
    _panel.addEventListener('click', function (e) {
      var card = document.getElementById('sp-card');
      if (!card) return;
      // composedPath() is the authoritative pre-mutation path
      var path = e.composedPath ? e.composedPath() : [];
      var inCard = path.indexOf(card) !== -1 || card.contains(e.target);
      if (!inCard) closeStemsPanel();
    });
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
    _panel.querySelectorAll('.sp-tab').forEach(function (btn) {
      var on = btn.dataset.tab === tab;
      btn.style.background = on ? '#fff' : 'rgba(255,255,255,0.04)';
      btn.style.color       = on ? '#000' : 'rgba(255,255,255,0.42)';
    });
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
    _setTabBody(
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap">' +
          '<span style="display:inline-flex;align-items:center;gap:4px;' +
              'background:rgba(78,159,255,0.1);border:1px solid rgba(78,159,255,0.22);' +
              'border-radius:6px;padding:4px 8px;font-size:.72rem;color:#4e9fff;font-weight:600">' +
            '<i class="fas fa-microphone" style="font-size:.6rem"></i> Vocals' +
          '</span>' +
          '<span style="color:rgba(255,255,255,0.2);font-size:.72rem">+</span>' +
          '<span style="display:inline-flex;align-items:center;gap:4px;' +
              'background:rgba(100,116,139,0.1);border:1px solid rgba(100,116,139,0.2);' +
              'border-radius:6px;padding:4px 8px;font-size:.72rem;color:#94a3b8;font-weight:600">' +
            '<i class="fas fa-music" style="font-size:.6rem"></i> Instrumental' +
          '</span>' +
          '<span style="font-size:.68rem;color:rgba(255,255,255,0.26)">lead &amp; backing split</span>' +
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

  // ── Advanced tab — dropdown selector ─────────────────────────────────────
  function _showAdvancedTab() {
    var opts = ADVANCED_INSTRUMENTS.map(function (inst) {
      return '<option value="' + inst + '"' + (inst === _selectedInst ? ' selected' : '') + '>' +
        _capFirst(inst) + '</option>';
    }).join('');

    _setTabBody(
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">' +
          '<span style="font-size:.72rem;color:rgba(255,255,255,0.36);white-space:nowrap;flex-shrink:0">Isolate</span>' +
          // custom dropdown wrapper
          '<div style="position:relative;flex:1;min-width:0">' +
            '<select id="sp-adv-select" onchange="window._spSelectInstDrop(this.value)" style="' +
                'width:100%;box-sizing:border-box;' +
                'appearance:none;-webkit-appearance:none;' +
                'background:rgba(168,85,247,0.1);' +
                'border:1px solid rgba(168,85,247,0.3);' +
                'border-radius:7px;' +
                'padding:6px 28px 6px 10px;' +
                'color:#c084fc;font-size:.76rem;font-weight:600;' +
                'cursor:pointer;outline:none">' +
              opts +
            '</select>' +
            '<i class="fas fa-chevron-down" style="' +
                'position:absolute;right:9px;top:50%;transform:translateY(-50%);' +
                'pointer-events:none;color:rgba(168,85,247,0.55);font-size:.58rem"></i>' +
          '</div>' +
          '<span style="font-size:.68rem;color:rgba(255,255,255,0.25);white-space:nowrap;flex-shrink:0">+ everything else</span>' +
        '</div>' +
        '<button onclick="window._spExtract(\'advanced\')" style="' +
            'flex-shrink:0;padding:6px 14px;border-radius:7px;border:none;' +
            'background:linear-gradient(135deg,#a855f6,#ec4899);color:#fff;' +
            'font-weight:600;font-size:.73rem;cursor:pointer;transition:opacity .15s;white-space:nowrap"' +
          ' onmouseover="this.style.opacity=\'.8\'" onmouseout="this.style.opacity=\'1\'">' +
          'Extract' +
        '</button>' +
      '</div>'
    );
  }

  function _setTabBody(html) {
    var el = _panel && _panel.querySelector('#sp-tab-body');
    if (el) el.innerHTML = html;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  INSTRUMENT SELECTION (dropdown version)
  // ─────────────────────────────────────────────────────────────────────────
  window._spSelectInstDrop = function (inst) {
    _selectedInst = inst;
  };

  // kept for any legacy callers
  window._spSelectInst = function (btn, inst) {
    _selectedInst = inst;
  };

  window._spFilterChips = function () {}; // no-op (chips removed)

  // ─────────────────────────────────────────────────────────────────────────
  //  EXTRACT
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
    if (mode !== 'auto') body.target_instrument = _selectedInst;

    try {
      var res = await fetch('/api/job/stems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await res.json();

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
    _pollTimer = setInterval(async function () {
      if (!_panel) { clearInterval(_pollTimer); return; }
      dots = (dots + 1) % 4;
      _showProgress('Extracting stems' + '.'.repeat(dots + 1));
      try {
        var params = '?mode=' + encodeURIComponent(mode);
        if (_curTaskId) params += '&task_id=' + encodeURIComponent(_curTaskId);
        if (mode !== 'auto') params += '&target=' + encodeURIComponent(_selectedInst);
        var res  = await fetch('/api/job/stems/' + _jobId + params);
        var data = await res.json();
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
    _setTabBody(
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 0">' +
        '<i class="fas fa-exclamation-triangle" style="color:#f59e0b;font-size:.9rem;flex-shrink:0"></i>' +
        '<span style="color:rgba(255,255,255,0.55);font-size:.77rem;flex:1">' + html + '</span>' +
        '<button onclick="window._spReExtract(\'' + (_activeTab||'auto') + '\')" style="' +
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
    _stems = stems.map(function (s) {
      return { name: s.name, url: s.url, muted: false, solo: false, vol: 1.0 };
    });

    _setTabBody(
      '<div style="display:flex;align-items:center;justify-content:space-between">' +
        '<span style="color:rgba(255,255,255,0.35);font-size:.72rem">' +
          '<i class="fas fa-check-circle" style="color:#10b981;margin-right:4px"></i>' +
          _stems.length + ' stem' + (_stems.length !== 1 ? 's' : '') + ' extracted' +
        '</span>' +
        '<button onclick="window._spReExtract(\'' + mode + '\')" style="' +
            'padding:3px 10px;border-radius:5px;border:1px solid rgba(255,255,255,.1);' +
            'background:rgba(255,255,255,.04);color:rgba(255,255,255,.38);font-size:.68rem;cursor:pointer">' +
          'Re-extract' +
        '</button>' +
      '</div>'
    );

    var tracksEl = _panel.querySelector('#sp-tracks');
    if (!tracksEl) return;
    tracksEl.innerHTML = _stems.map(function (s, i) {
      return _buildTrackRow(s, i);
    }).join('');
    tracksEl.style.display = 'flex';

    _audios = [];
    _stems.forEach(function (s, i) {
      var audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.preload = 'metadata';
      audio.src = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(s.name);
      _audios.push(audio);
      if (i === 0) {
        audio.addEventListener('loadedmetadata', function () { _updateDuration(audio.duration); });
        audio.addEventListener('timeupdate', function () { _updateTimeline(audio.currentTime, audio.duration); });
        audio.addEventListener('ended', function () { _playing = false; _updatePlayIcon(); });
      }
    });

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
  //  TRACK ROW
  // ─────────────────────────────────────────────────────────────────────────
  function _buildTrackRow(s, i) {
    var color = STEM_COLORS[s.name] || STEM_COLORS.default;
    var label = _capFirst(s.name);
    var dlUrl = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(s.name);

    return '<div style="display:flex;align-items:center;gap:7px;padding:8px 16px;' +
        'border-bottom:1px solid rgba(255,255,255,0.04);transition:background .15s"' +
        ' onmouseover="this.style.background=\'rgba(255,255,255,.02)\'"' +
        ' onmouseout="this.style.background=\'none\'">' +

      // color bar
      '<div style="width:2.5px;height:28px;border-radius:2px;background:' + color + ';flex-shrink:0"></div>' +

      // name
      '<div style="width:80px;flex-shrink:0;font-size:.74rem;font-weight:600;color:#f1f5f9;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(label) + '</div>' +

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
        ' style="width:56px;flex-shrink:0;accent-color:' + color + ';cursor:pointer">' +

      // download
      '<a href="' + dlUrl + '" download="' + _escHtml(label) + '_stem.mp3" title="Download ' + _escHtml(label) + '" style="' +
          'color:rgba(255,255,255,0.3);font-size:.8rem;flex-shrink:0;text-decoration:none;' +
          'display:flex;align-items:center;justify-content:center;width:22px;height:22px;transition:color .15s"' +
        ' onmouseover="this.style.color=\'#4e9fff\'" onmouseout="this.style.color=\'rgba(255,255,255,0.3)\'">' +
        '<i class="fas fa-download"></i>' +
      '</a>' +

    '</div>';
  }

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
      _audios.forEach(function (a) { a.pause(); });
      _playing = false;
    } else {
      var ps = _audios.map(function (a) { return a.play().catch(function(){}); });
      Promise.all(ps).then(function () { _playing = true; _updatePlayIcon(); });
      _playing = true;
    }
    _updatePlayIcon();
  };

  window._spSeek = function (e) {
    var wrap = _panel && _panel.querySelector('#sp-timeline-wrap');
    if (!wrap || !_audios.length) return;
    var rect = wrap.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var dur  = _audios[0].duration;
    if (!dur || isNaN(dur)) return;
    var t = pct * dur;
    _audios.forEach(function (a) { a.currentTime = t; });
    _updateTimeline(t, dur);
  };

  window._spSeekWave = function (e, el) {
    var rect = el.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (!_audios.length) return;
    var dur = _audios[0].duration;
    if (!dur || isNaN(dur)) return;
    var t = pct * dur;
    _audios.forEach(function (a) { a.currentTime = t; });
    _updateTimeline(t, dur);
  };

  window._spSolo = function (idx) {
    var s = _stems[idx];
    if (!s) return;
    var wasSolo = s.solo;
    _stems.forEach(function (st) { st.solo = false; });
    if (!wasSolo) s.solo = true;
    _stems.forEach(function (st, i) {
      var anySolo = _stems.some(function (x) { return x.solo; });
      var active  = !anySolo || st.solo;
      if (_audios[i]) _audios[i].volume = st.muted ? 0 : (active ? st.vol : 0);
      var btn = _panel && _panel.querySelector('#sp-solo-' + i);
      if (btn) {
        btn.style.background  = st.solo ? 'rgba(250,204,21,0.22)' : 'rgba(255,255,255,0.04)';
        btn.style.borderColor = st.solo ? '#facc15' : 'rgba(255,255,255,0.13)';
        btn.style.color       = st.solo ? '#facc15' : 'rgba(255,255,255,0.48)';
      }
    });
  };

  window._spMute = function (idx) {
    var s = _stems[idx];
    if (!s) return;
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
    if (!dur || isNaN(dur)) return;
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
    _audios.forEach(function (a) { try { a.pause(); a.src = ''; } catch (e) {} });
    _audios = [];
  }

  function _cleanup() {
    _stopAllAudio();
    _playing = false;
    _stems = [];
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
