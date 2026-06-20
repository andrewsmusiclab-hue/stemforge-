/* ═══════════════════════════════════════════════════════════════
   StemForge — Frontend App JS
   Real pipeline: GPT-4o blueprint → Mureka generation → track extraction
═══════════════════════════════════════════════════════════════ */

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
      pro:     { name: 'Pro Artist Plan', price: '$39', total: '$39.00', features: ['150 downloads/month', 'Unmastered mix, mastered mix, or stems bundle', 'Priority queue'] },
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
      const limitMap = { free: 3, creator: 50, pro: 150 };
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
  const _libLoaded  = { beats: false, oneshots: false, trash: false };
  // Cached project arrays per tab (for client-side search)
  const _libData    = { beats: [], oneshots: [], trash: [] };
  let   _libActive  = 'beats';

  // ── Canvas art generator (shared helper) ───────────────────
  function drawCanvasArt(artEl, hue, title, genre) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 256, 256);
      grad.addColorStop(0, `hsl(${hue},65%,18%)`);
      grad.addColorStop(0.5, `hsl(${(hue+40)%360},75%,12%)`);
      grad.addColorStop(1, `hsl(${(hue+80)%360},60%,8%)`);
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 256, 256);
      const r1 = ctx.createRadialGradient(200, 60, 10, 200, 60, 120);
      r1.addColorStop(0, `hsla(${(hue+120)%360},80%,60%,0.35)`);
      r1.addColorStop(1, 'transparent');
      ctx.fillStyle = r1; ctx.fillRect(0, 0, 256, 256);
      const r2 = ctx.createRadialGradient(50, 200, 5, 50, 200, 100);
      r2.addColorStop(0, `hsla(${(hue+240)%360},70%,55%,0.25)`);
      r2.addColorStop(1, 'transparent');
      ctx.fillStyle = r2; ctx.fillRect(0, 0, 256, 256);
      ctx.font = 'bold 13px system-ui,sans-serif';
      ctx.fillStyle = `hsla(${hue},60%,85%,0.7)`;
      ctx.textAlign = 'center';
      ctx.fillText((genre||'music').toUpperCase(), 128, 36);
      const barCount = 18; const barW = 6; const gap = 4;
      const totalW = barCount * (barW + gap) - gap;
      const startX = (256 - totalW) / 2;
      for (let b = 0; b < barCount; b++) {
        const seed = (hue * 13 + b * 97) % 360;
        const h = 20 + (Math.sin(seed * 0.13) * 0.5 + 0.5) * 55;
        const x = startX + b * (barW + gap); const y = 128 - h / 2;
        const barGrad = ctx.createLinearGradient(0, y, 0, y + h);
        barGrad.addColorStop(0, `hsla(${(hue+40)%360},80%,75%,0.9)`);
        barGrad.addColorStop(1, `hsla(${hue},60%,50%,0.4)`);
        ctx.fillStyle = barGrad;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, barW, h, 2) : ctx.rect(x, y, barW, h);
        ctx.fill();
      }
      const words = (title||'').split(' ');
      const line1 = words.slice(0, Math.ceil(words.length/2)).join(' ');
      const line2 = words.slice(Math.ceil(words.length/2)).join(' ');
      ctx.font = 'bold 18px system-ui,sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6;
      ctx.textAlign = 'center';
      if (line2) { ctx.fillText(line1.slice(0,18), 128, 185); ctx.fillText(line2.slice(0,18), 128, 207); }
      else { ctx.fillText(line1.slice(0,20), 128, 197); }
      ctx.shadowBlur = 0;
      artEl.style.backgroundImage = `url('${canvas.toDataURL('image/png')}')`;
      artEl.style.backgroundSize = 'cover';
      artEl.style.backgroundPosition = 'center';
    } catch(e) { /* gradient fallback already shown */ }
  }

  // ── Load AI cover images async for a grid element ───────────
  function loadCoverImages(gridEl) {
    // Canvas-only art — no external image fetches, no AI cover images
    gridEl.querySelectorAll('.project-card[data-hue]').forEach((card) => {
      const hue   = parseInt(card.dataset.hue || '180', 10);
      const title = card.dataset.title || '';
      const genre = card.dataset.genre || 'music';
      const artEl = card.querySelector('.project-card__art');
      if (!artEl) return;
      // Draw granite gradient + StemForge logo canvas art
      drawCanvasArt(artEl, hue, title, genre);
      // Clear any leftover image background from previous sessions
      artEl.style.backgroundImage = '';
    });
  }

  // ── Render a single beats/songs card ───────────────────────
  function renderBeatCard(p, i) {
    const hue  = p.thumbnail_seed != null ? p.thumbnail_seed : (i * 47) % 360;
    const thumbBg = `linear-gradient(135deg, hsl(${hue},70%,30%) 0%, hsl(${(hue+60)%360},80%,20%) 100%)`;
    const bpm  = p.blueprint ? p.blueprint.bpm + ' BPM' : '';
    const genre= p.blueprint ? p.blueprint.genre : '';
    const durSecs = p.blueprint ? p.blueprint.duration_seconds : 0;
    const dur  = durSecs ? Math.floor(durSecs/60) + ':' + String(durSecs%60).padStart(2,'0') : '';
    const label= p.prompt ? p.prompt.slice(0,32) + (p.prompt.length>32?'…':'') : 'Beat';
    const rawTitle = p.title || (p.blueprint ? (p.blueprint.genre + (p.blueprint.key ? ' — '+p.blueprint.key:'')) : label);
    const sub  = [bpm, dur].filter(Boolean).join(' · ');
    const safeFilename = rawTitle.replace(/[^a-zA-Z0-9\s\-_]/g,'').replace(/\s+/g,'_').toLowerCase();
    return `
      <div class="project-card"
           data-stereo="${p.stereo_url||''}" data-zip="${p.zip_url||''}"
           data-id="${p.id}"
           data-title="${rawTitle.replace(/"/g,'&quot;')}"
           data-hue="${hue}"
           data-genre="${(genre||'music').replace(/"/g,'&quot;')}"
           data-dur="${dur}"
           >
        <div class="project-card__art" style="${thumbBg}">
          <div class="project-card__art-icon"><i class="fas fa-wave-square"></i></div>
          <div class="project-card__play" onclick="playDashProject(this)">
            <i class="fas fa-play"></i>${dur ? `<span class="card-play-dur">${dur}</span>` : ''}
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
    ['beats','oneshots','trash'].forEach(t => {
      const panel = document.getElementById('lib-panel-' + t);
      if (panel) panel.style.display = t === tab ? '' : 'none';
    });
    // Update search placeholder
    const searchInput = document.getElementById('lib-search');
    if (searchInput) {
      const placeholders = { beats: 'Search beats…', oneshots: 'Search one shots…', trash: 'Search trash…' };
      searchInput.placeholder = placeholders[tab] || 'Search…';
      // Reset search when switching tabs
      searchInput.value = '';
      filterLibrary('');
    }
    // Load data if not yet loaded
    fetchLibTab(tab);
  };

  // ── Client-side search filter ────────────────────────────────
  window.filterLibrary = function(query) {
    const tab = _libActive;
    const clearBtn = document.getElementById('lib-search-clear');
    if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
    const q = query.toLowerCase().trim();
    const gridEl = document.getElementById('project-grid-' + tab);
    if (!gridEl) return;
    const filtered = !q ? _libData[tab] : _libData[tab].filter(p => {
      const t  = (p.title || '').toLowerCase();
      const pr = (p.prompt || '').toLowerCase();
      const g  = (p.blueprint ? p.blueprint.genre : (p.sound_type||'')).toLowerCase();
      return t.includes(q) || pr.includes(q) || g.includes(q);
    });
    populateGrid(gridEl, tab, filtered);
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
      // Refresh both beats/oneshots and trash tabs
      _libLoaded.beats = false; _libLoaded.oneshots = false; _libLoaded.trash = false;
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
            <a href="/pricing?plan=pro" style="display:block;padding:12px 24px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.95rem"><i class="fas fa-star"></i> Pro Artist — $39/mo · 150 beats</a>
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

    // Edit & Stems only for full beats
    if (!isOneshot) {
      items.push({ icon: 'fa-pencil-alt', label: 'Edit track info', action: () => openSongEditModal(null, jobId) });
      items.push({ icon: 'fa-layer-group', label: 'Get Stems', action: () => {
        function dashUpgradePrompt() {
          const m = document.getElementById('sf-dash-upgrade');
          if (m) m.style.display = 'flex';
          else window.location.href = '/pricing';
        }
        const user = window._sfUser;
        if (user && user.plan !== 'free') {
          openStemPickerModal(jobId, user);
        } else if (!user) {
          fetch('/api/auth/me').then(r => r.json()).then(me => {
            const u = me && me.user;
            if (!u || u.plan === 'free') { dashUpgradePrompt(); return; }
            window._sfUser = window._sfUser || u;
            openStemPickerModal(jobId, u);
          }).catch(() => dashUpgradePrompt());
        } else { dashUpgradePrompt(); }
      }});
    }

    if (stereoUrl) {
      items.push({ icon: 'fa-download', label: isOneshot ? 'Download' : 'Download Full Track',
        action: () => openDownloadModal(jobId, stereoUrl, safeTitle) });
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
    player.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card-bg);border:1px solid var(--border);border-radius:16px;padding:16px 24px;display:flex;align-items:center;gap:16px;z-index:9999;box-shadow:0 8px 40px rgba(0,0,0,.5);min-width:320px;max-width:560px';
    player.innerHTML = `
      <audio id="dash-audio" src="${stereoUrl}" preload="auto"></audio>
      <button id="dash-play-pause" style="width:40px;height:40px;border-radius:50%;background:var(--primary);border:none;cursor:pointer;color:#fff;font-size:16px;flex-shrink:0" onclick="dashTogglePlay()"><i class="fas fa-play"></i></button>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${card.querySelector('h4').textContent}</div>
        <input type="range" id="dash-seek" min="0" max="100" value="0" step="0.1" style="width:100%;accent-color:var(--primary);cursor:pointer"/>
      </div>
      ${stereoUrl ? `<a href="${stereoUrl}" download="${(trackTitle||'beat').replace(/[^a-zA-Z0-9\s\-_]/g,'').replace(/\s+/g,'_').toLowerCase()}_stereo.mp3" style="font-size:18px;color:var(--muted)"><i class="fas fa-download"></i></a>` : ''}
      <button onclick="document.getElementById('dash-mini-player').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:18px"><i class="fas fa-times"></i></button>
    `;
    document.body.appendChild(player);
    const audio = document.getElementById('dash-audio');
    const seekBar = document.getElementById('dash-seek');
    audio.play().catch(()=>{});
    document.getElementById('dash-play-pause').innerHTML = '<i class="fas fa-pause"></i>';
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) seekBar.value = (audio.currentTime / audio.duration) * 100;
    });
    seekBar.addEventListener('input', () => {
      if (audio.duration) audio.currentTime = (seekBar.value / 100) * audio.duration;
    });
    audio.addEventListener('ended', () => {
      document.getElementById('dash-play-pause').innerHTML = '<i class="fas fa-play"></i>';
      seekBar.value = 0;
    });
  };
  window.dashTogglePlay = function() {
    const audio = document.getElementById('dash-audio');
    const btn = document.getElementById('dash-play-pause');
    if (!audio) return;
    if (audio.paused) { audio.play(); btn.innerHTML = '<i class="fas fa-pause"></i>'; }
    else { audio.pause(); btn.innerHTML = '<i class="fas fa-play"></i>'; }
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
      { icon: 'fa-drum',        label: bp.bpm + ' BPM' },
      { icon: 'fa-music',       label: bp.key + ' ' + bp.scale },
      { icon: 'fa-compact-disc',label: bp.genre },
      { icon: 'fa-heart',       label: bp.mood },
      { icon: 'fa-bolt',        label: bp.energy + ' energy' },
      { icon: 'fa-clock',       label: Math.round(bp.duration_seconds/60) + ':' + String(bp.duration_seconds%60).padStart(2,'0') },
    ];
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

  function buildTrackRow(track) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.id = 'track-' + track.stem;

    const iconMap = {
      drums: 'fa-drum', bass: 'fa-guitar', vocals: 'fa-microphone',
      other: 'fa-wave-square', instrumental: 'fa-music', mix: 'fa-compact-disc',
      synth: 'fa-wave-square', fx: 'fa-magic', default: 'fa-music'
    };
    const icon = iconMap[track.family] || iconMap[track.stem] || iconMap.default;

    row.innerHTML = `
      <div class="track-row__info">
        <span class="track-row__icon" style="background:${track.color}">
          <i class="fas ${icon}"></i>
        </span>
        <div>
          <strong>${track.name}</strong>
          <span>${track.stem}.wav</span>
        </div>
      </div>
      <div class="track-row__wave" id="wave-${track.stem}"></div>
      <div class="track-row__actions" id="actions-${track.stem}">
        ${renderTrackActions(track)}
      </div>`;

    // fill waveform bars
    const wave = row.querySelector('.track-row__wave');
    fillWave(wave, track.color);

    return row;
  }

  function renderTrackActions(track) {
    if (track.status === 'pending') {
      return `<span style="font-size:.78rem;color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Extracting...</span>`;
    }
    if (track.status === 'ready' && track.zip_url) {
      // Download individual WAV stem from ZIP — available to Creator+ plans
      return `
        <span class="stem-file-badge">${track.stem}.wav</span>
        <span class="track-row__dl locked-pro" title="Creator+ — download individual track"><i class="fas fa-lock"></i> Creator+</span>`;
    }
    if (track.status === 'error') {
      return `<span style="font-size:.78rem;color:var(--danger)"><i class="fas fa-times"></i> Error</span>`;
    }
    return `<span class="track-row__dl locked-pro"><i class="fas fa-lock"></i></span>`;
  }

  function fillWave(container, color) {
    for (let i = 0; i < 120; i++) {
      const b = document.createElement('div');
      const h = Math.random()*26+4;
      b.style.cssText = `width:2px;height:${h}px;border-radius:1px;background:${color};opacity:${0.4+Math.random()*0.5};flex-shrink:0;`;
      container.appendChild(b);
    }
  }

  function updateTrackRow(track) {
    const actionsEl = document.getElementById('actions-' + track.stem);
    if (actionsEl) actionsEl.innerHTML = renderTrackActions(track);
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

    // Validate: need either lyrics (write tab), prompt, style, or instrumental selected
    const hasContent = document.getElementById('gen-lyrics')?.value?.trim() ||
                       document.getElementById('gen-prompt')?.value?.trim() ||
                       document.getElementById('gen-style')?.value?.trim() ||
                       document.getElementById('gen-instrumental')?.checked;
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
          beat_count: window._beatCount || 1
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
            if (spinnerMsg) spinnerMsg.textContent = 'Extracting stems...';
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

            // Final update of all tracks (or build if not yet rendered)
            if (trackList) {
              if (trackList.children.length === 0) {
                job.tracks.forEach(t => trackList.appendChild(buildTrackRow(t)));
              } else {
                job.tracks.forEach(t => updateTrackRow(t));
              }
            }

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
                        <i class="fas fa-star"></i> Pro Artist — $39/mo · 150 beats
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
                // ── Pro Artist: Unmastered Mix (WAV/MP3) + Mastered Mix (WAV/MP3) + Stems (→ player) ──

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

                // (c) Stems — opens stem player page
                const stemsBtn = document.createElement('button');
                stemsBtn.className = 'export-btn export-btn--pro export-btn--stems';
                stemsBtn.title = 'Open interactive stem player — play and solo individual tracks';
                stemsBtn.innerHTML = '<i class="fas fa-layer-group"></i><span>Stem Player</span><small>Interactive</small>';
                stemsBtn.onclick = () => {
                  const jobIdNav = job.id || currentJobId;
                  window.location.href = '/stems/' + jobIdNav;
                };

                exportOptionsRow.appendChild(unmastBtn);
                exportOptionsRow.appendChild(mastBtn);
                exportOptionsRow.appendChild(stemsBtn);
              } else {
                // ── Creator: Mastered Mix only (WAV or MP3) ──
                const dlBtn = document.createElement('button');
                dlBtn.className = 'export-btn';
                dlBtn.title = 'Download your mastered stereo mix — WAV or MP3';
                dlBtn.innerHTML = '<i class="fas fa-compact-disc"></i><span>Mastered Mix</span><small>WAV / MP3</small>';
                dlBtn.onclick = () => showFormatPicker(dlBtn, 'Mastered Mix', (fmt) => doDownload(job.stereo_url, safeFilename + '_mastered', fmt));
                exportOptionsRow.appendChild(dlBtn);
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
              const stemCount = job.tracks.length;
              const dur = Math.floor((job.blueprint.duration_seconds||120)/60) + ':' + String((job.blueprint.duration_seconds||120)%60).padStart(2,'0');
              subEl.textContent = job.blueprint.bpm + ' BPM · ' + job.blueprint.key + ' ' + job.blueprint.scale + ' · ' + dur;
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
              const limitMap = { free: 3, creator: 50, pro: 150 };
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

  if (genRetryBtn) genRetryBtn.addEventListener('click', () => {
    if (genError) genError.style.display = 'none';
    if (genEmpty) genEmpty.style.display = 'block';
    if (trackList) trackList.innerHTML = '';
    currentJobId = null;
  });

});

// ── Global: download ZIP stems ─────────────────────────────────
// Stems are in a ZIP file — individual download requires Pro plan
// The ZIP contains: drums.wav, bass.wav, vocals.wav, other.wav,
//                   instrumental.wav, song.wav, song.mp3
window.downloadStem = function(zipUrl, stemName) {
  if (zipUrl) window.open(zipUrl, '_blank');
};

// ═══════════════════════════════════════════════════════════════
//  SONG EDIT MODAL
// ═══════════════════════════════════════════════════════════════

// Cache of loaded projects for the modal
window._sfProjects = {};

let _editStemTier = 'basic'; // 'basic' | 'pro'

function resetStemsSection() {
  const sec    = document.getElementById('edit-stems-section');
  const status = document.getElementById('edit-stems-status');
  const result = document.getElementById('edit-stems-result');
  const picker = document.getElementById('edit-stems-picker');
  if (sec)    sec.style.display = 'none';
  if (status) { status.style.display = 'none'; status.textContent = ''; }
  if (result) { result.style.display = 'none'; }
  if (picker) { picker.style.display = 'none'; }
  _editStemTier = 'basic';
}

function _renderStemsSection(job, user) {
  const sec    = document.getElementById('edit-stems-section');
  const picker = document.getElementById('edit-stems-picker');
  const result = document.getElementById('edit-stems-result');
  if (!sec) return;

  sec.style.display = 'block';

  // Already extracted — show Open Stems Player link
  if (job && job.zip_url) {
    if (picker) picker.style.display = 'none';
    if (result) {
      result.style.display = 'flex';
      const zipLink = document.getElementById('edit-stems-zip-link');
      if (zipLink) {
        zipLink.href = '/stems/' + job.id;
        zipLink.removeAttribute('download');
        zipLink.textContent = '';
        zipLink.innerHTML = '<i class="fas fa-layer-group"></i> Open Stems Player';
      }
      if (job.midi_zip_url) {
        const midiLink = document.getElementById('edit-stems-midi-link');
        if (midiLink) { midiLink.href = job.midi_zip_url; midiLink.style.display = 'inline-flex'; }
      }
    }
    return;
  }

  // Not yet extracted — show tier picker
  if (result) result.style.display = 'none';
  if (picker) picker.style.display = 'block';

  const isPro = user.plan === 'pro' || user.plan === 'developer';
  const proLock  = document.getElementById('edit-pro-lock');
  const proBadge = document.getElementById('edit-pro-badge');
  const proNote  = document.getElementById('edit-pro-upgrade-note');
  const proCard  = document.getElementById('edit-tier-pro');
  if (!isPro) {
    if (proCard)  { proCard.style.opacity = '0.6'; proCard.style.cursor = 'not-allowed'; }
    if (proLock)  proLock.style.display = 'flex';
    if (proBadge) proBadge.style.display = 'none';
    if (proNote)  proNote.style.display = 'block';
  } else {
    if (proCard)  { proCard.style.opacity = '1'; proCard.style.cursor = 'pointer'; }
    if (proLock)  proLock.style.display = 'none';
    if (proBadge) proBadge.style.display = 'block';
    if (proNote)  proNote.style.display = 'none';
  }
  // Start on basic
  _editStemTier = 'basic';
  selectEditStemTier('basic');
}

function showStemsSection(job) {
  // If user data is already available, render immediately
  if (window._sfUser && window._sfUser.plan !== 'free') {
    _renderStemsSection(job, window._sfUser);
    return;
  }
  // User not yet loaded (race condition) — fetch it now
  fetch('/api/auth/me').then(r => r.json()).then(data => {
    const user = data && data.user;
    if (!user || user.plan === 'free') return; // Free plan — no stems
    window._sfUser = window._sfUser || user; // cache if not already set
    _renderStemsSection(job, user);
  }).catch(() => {});
}

window.selectEditStemTier = function(tier) {
  const proLock = document.getElementById('edit-pro-lock');
  if (tier === 'pro' && proLock && proLock.style.display !== 'none') return;

  _editStemTier = tier;
  const isPro = tier === 'pro';

  const basicCard  = document.getElementById('edit-tier-basic');
  const proCard    = document.getElementById('edit-tier-pro');
  const basicCheck = document.getElementById('edit-check-basic');
  const proCheck   = document.getElementById('edit-check-pro');
  const proBadge   = document.getElementById('edit-pro-badge');
  const btnLabel   = document.getElementById('edit-stems-btn-label');
  const btn        = document.getElementById('edit-get-stems-btn');

  if (basicCard) basicCard.style.borderColor = isPro ? 'var(--border)' : 'var(--primary)';
  if (proCard && !(proLock && proLock.style.display !== 'none'))
    proCard.style.borderColor = isPro ? '#a855f7' : 'var(--border)';
  if (basicCheck) basicCheck.style.display = isPro ? 'none' : 'flex';
  if (proCheck)   proCheck.style.display   = isPro ? 'flex' : 'none';
  if (proBadge)   proBadge.style.display   = isPro ? 'none' : 'block';
  if (btnLabel)   btnLabel.textContent     = isPro ? 'Get Up to 12 Stems — 10 Credits' : 'Get 5 Stems — 2 Credits';
  if (btn)        btn.style.background     = isPro ? 'linear-gradient(135deg,#6c3aff,#a855f7)' : '';
};

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
  resetStemsSection();
  const infoBlock = document.getElementById('edit-info-block');
  if (infoBlock) infoBlock.style.display = 'none';

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
    var imageUrl = job.image_url || null;
    if (imageUrl && imageUrl.startsWith('http')) {
      _setCoverThumb(imageUrl);
      if (thumb) thumb.dataset.prevUrl = imageUrl;
    } else {
      _setCoverThumb(null);
      if (thumb) thumb.dataset.prevUrl = '';
    }
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
    // Show stems section if ready
    if (jobData.status === 'ready' && jobData.stereo_url) showStemsSection(jobData);

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
      window._sfProjects[jobId] = job;
      _loadCoverForJob(job);
      // Show stems section if ready
      if (job.status === 'ready' && job.stereo_url) showStemsSection(job);
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

// ── Stems popup modal — shown when user clicks "Get Stems" on a library card ──
window.openStemsPopup = async function(jobId, existingZipUrl) {
  // ── Fast-path: stems already extracted — skip credit prompt entirely ──
  // Check 1: sessionStorage (set after a successful extraction this session)
  const cacheKey = 'stems_extracted_' + jobId;
  if (sessionStorage.getItem(cacheKey)) {
    window.location.href = '/stems/' + jobId;
    return;
  }
  // Check 2: zip_url already exists in D1 (passed from the card render)
  if (existingZipUrl && existingZipUrl.startsWith('http')) {
    window.location.href = '/stems/' + jobId;
    return;
  }

  // Remove stale modal if exists
  const old = document.getElementById('sf-stems-popup');
  if (old) old.remove();

  // Build modal
  const modal = document.createElement('div');
  modal.id = 'sf-stems-popup';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(6px)';

  // Placeholder while we fetch plan
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:36px 32px;max-width:420px;width:90%;text-align:center;position:relative">
      <button onclick="document.getElementById('sf-stems-popup').remove()" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer"><i class="fas fa-times"></i></button>
      <div id="sf-stems-popup-body" style="min-height:120px;display:flex;align-items:center;justify-content:center">
        <i class="fas fa-spinner fa-spin" style="font-size:1.6rem;color:var(--primary)"></i>
      </div>
    </div>`;
  document.body.appendChild(modal);
  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Fetch user plan
  let plan = 'creator';
  try {
    const me = await fetch('/api/auth/me');
    const md = await me.json();
    plan = md.user?.plan || 'creator';
    if (!md.user || plan === 'free') {
      document.getElementById('sf-stems-popup-body').innerHTML = `
        <div>
          <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#4e9fff,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:1.3rem;color:#fff"><i class="fas fa-lock"></i></div>
          <h3 style="font-size:1.15rem;font-weight:700;margin-bottom:8px">Stems require a paid plan</h3>
          <p style="color:var(--muted);font-size:.9rem;margin-bottom:20px;line-height:1.5">Extract individual stems with a <strong>Creator</strong> or <strong>Pro Artist</strong> plan.</p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <a href="/pricing?plan=creator" style="display:block;padding:11px 20px;background:linear-gradient(135deg,#4e9fff,#6366f1);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.92rem"><i class="fas fa-crown"></i> Creator — $19/mo</a>
            <a href="/pricing?plan=pro" style="display:block;padding:11px 20px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:.92rem"><i class="fas fa-star"></i> Pro Artist — $39/mo</a>
          </div>
        </div>`;
      return;
    }
  } catch(e) { /* ignore — show default creator copy */ }

  const isPro = plan === 'pro';
  const creditCost = isPro ? 10 : 2;
  const stemCount  = isPro ? 'up to 12 stems + MIDI' : '5 stems';
  const planLabel  = isPro ? 'Pro Artist' : 'Creator';

  document.getElementById('sf-stems-popup-body').innerHTML = `
    <div style="width:100%">
      <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:1.3rem;color:#fff"><i class="fas fa-layer-group"></i></div>
      <h3 style="font-size:1.15rem;font-weight:700;margin-bottom:8px">Extract Stems</h3>
      <p style="color:var(--muted);font-size:.9rem;margin-bottom:6px;line-height:1.5">Extract <strong>${stemCount}</strong> from this track${isPro ? ' — Kick/Snare/Hi-Hats, Bass, Melody, Synth, Guitar, Strings, and more — plus MIDI export' : ' — Drums, Bass, Melody, Vocals, and Other'}. Preview and download each one individually.</p>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:22px"><strong>${creditCost} download credits</strong> will be used from your ${planLabel} plan.</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button id="sf-stems-popup-go" onclick="sfStemsGo('${jobId}')" style="flex:1;padding:11px 16px;background:linear-gradient(135deg,var(--primary),#8b5cf6);color:#fff;border:none;border-radius:12px;font-weight:700;cursor:pointer;font-size:.92rem">
          <i class="fas fa-layer-group"></i> Extract Stems — ${creditCost} Credits
        </button>
        <button onclick="document.getElementById('sf-stems-popup').remove()" style="padding:11px 18px;background:var(--surface-2,#1e2130);color:var(--text);border:1px solid var(--border);border-radius:12px;font-weight:600;cursor:pointer;font-size:.92rem">
          <i class="fas fa-times"></i> Cancel
        </button>
      </div>
      <div id="sf-stems-popup-status" style="margin-top:14px;font-size:.85rem;display:none;padding:10px 14px;border-radius:10px"></div>
    </div>`;
};

window.sfStemsGo = async function(jobId) {
  const btn    = document.getElementById('sf-stems-popup-go');
  const status = document.getElementById('sf-stems-popup-status');
  if (!btn) return;

  // Just navigate to the stems page — stemsInit() will handle extraction if needed
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening stems player...';
  window.location.href = '/stems/' + jobId;
};

// Request stems — called from "Get Stems" button in the Edit Track modal.
// Instead of extracting inline, navigates to the stems player page with the
// selected tier as a query param.  The stems player will handle extraction.
window.requestStems = function() {
  const jobId = document.getElementById('edit-job-id')?.value;
  const btn   = document.getElementById('edit-get-stems-btn');
  if (!jobId || !btn) return;
  const tier = _editStemTier || 'basic';
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening stems player…';
  window.location.href = '/stems/' + jobId + '?tier=' + tier;
};

// ── Stem Tier Picker Modal ─────────────────────────────────────────────────
window.openStemPickerModal = function(jobId, user) {
  let modal = document.getElementById('stem-picker-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'stem-picker-modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:0;max-width:480px;width:100%;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6)">
        <div style="background:linear-gradient(135deg,#6c3aff22,#a855f722);border-bottom:1px solid var(--border);padding:20px 24px 16px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <h3 style="margin:0;font-size:1.05rem"><i class="fas fa-layer-group" style="color:var(--primary);margin-right:8px"></i>Choose Stem Pack</h3>
            <p style="margin:4px 0 0;font-size:.8rem;color:var(--muted)">Select how many stems to extract</p>
          </div>
          <button onclick="closeStemPickerModal()" style="background:none;border:none;color:var(--muted);font-size:1.2rem;cursor:pointer;padding:4px 8px;border-radius:6px">&times;</button>
        </div>
        <div style="padding:20px 24px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div id="spm-basic-card" onclick="selectSpmTier('basic')" style="cursor:pointer;border:2px solid var(--primary);border-radius:14px;padding:18px 14px;background:rgba(108,58,255,.08);position:relative;transition:all .2s">
              <div style="font-size:1.6rem;font-weight:800;color:var(--primary);line-height:1">5</div>
              <div style="font-size:.82rem;font-weight:600;margin:3px 0 2px">Stems</div>
              <div style="font-size:.72rem;color:var(--muted);margin-bottom:10px;line-height:1.3">Drums · Bass · Melody<br>Vocals · Other</div>
              <div style="font-size:.8rem;font-weight:700;color:var(--text)">2 credits</div>
              <div id="spm-check-basic" style="position:absolute;top:9px;right:9px;width:16px;height:16px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center">
                <i class="fas fa-check" style="color:white;font-size:.55rem"></i>
              </div>
            </div>
            <div id="spm-pro-card" onclick="selectSpmTier('pro')" style="cursor:pointer;border:2px solid var(--border);border-radius:14px;padding:18px 14px;background:var(--surface-2,var(--surface));position:relative;transition:all .2s">
              <div style="font-size:1.6rem;font-weight:800;color:#a855f7;line-height:1">12</div>
              <div style="font-size:.82rem;font-weight:600;margin:3px 0 2px">Stems</div>
              <div style="font-size:.72rem;color:var(--muted);margin-bottom:10px;line-height:1.3">+ Guitar · Strings · Synth<br>Brass · FX · MIDI</div>
              <div style="font-size:.8rem;font-weight:700;color:var(--text)">10 credits</div>
              <div id="spm-pro-badge" style="position:absolute;top:8px;right:8px;background:linear-gradient(135deg,#6c3aff,#a855f7);border-radius:5px;padding:2px 6px;font-size:.62rem;font-weight:700;color:white">
                <i class="fas fa-crown" style="margin-right:2px"></i>Pro
              </div>
              <div id="spm-check-pro" style="display:none;position:absolute;top:9px;right:9px;width:16px;height:16px;border-radius:50%;background:#a855f7;align-items:center;justify-content:center">
                <i class="fas fa-check" style="color:white;font-size:.55rem"></i>
              </div>
              <div id="spm-pro-lock" style="display:none;position:absolute;inset:0;border-radius:12px;background:rgba(0,0,0,.45);flex-direction:column;align-items:center;justify-content:center;gap:3px">
                <i class="fas fa-lock" style="color:#a855f7;font-size:1rem"></i>
                <span style="font-size:.68rem;color:rgba(255,255,255,.7);font-weight:600">Pro Artist only</span>
              </div>
            </div>
          </div>
          <p id="spm-pro-note" style="display:none;font-size:.78rem;color:var(--muted);text-align:center;margin:0 0 14px">
            <i class="fas fa-crown" style="color:#a855f7;margin-right:4px"></i>Up to 12 stems is a <a href="/pricing" style="color:#a855f7;text-decoration:underline">Pro Artist</a> feature
          </p>
          <button id="spm-confirm-btn" class="btn btn--primary" style="width:100%" onclick="confirmStemPick()">
            <i class="fas fa-layer-group"></i> <span id="spm-confirm-label">Go to Stems Player — 5 stems</span>
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeStemPickerModal(); });
  }

  // Store current job id
  modal._jobId = jobId;
  modal._tier  = 'basic';

  // Set up Pro lock based on user plan
  const isPro = user && (user.plan === 'pro' || user.plan === 'developer');
  const proCard  = document.getElementById('spm-pro-card');
  const proLock  = document.getElementById('spm-pro-lock');
  const proBadge = document.getElementById('spm-pro-badge');
  const proNote  = document.getElementById('spm-pro-note');
  if (!isPro) {
    if (proCard)  { proCard.style.opacity = '0.6'; proCard.style.cursor = 'not-allowed'; }
    if (proLock)  { proLock.style.display = 'flex'; }
    if (proBadge) { proBadge.style.display = 'none'; }
    if (proNote)  { proNote.style.display = 'block'; }
  } else {
    if (proCard)  { proCard.style.opacity = '1'; proCard.style.cursor = 'pointer'; }
    if (proLock)  { proLock.style.display = 'none'; }
    if (proBadge) { proBadge.style.display = 'block'; }
    if (proNote)  { proNote.style.display = 'none'; }
  }

  // Reset to basic selection
  selectSpmTier('basic');
  modal.style.display = 'flex';
};

window.closeStemPickerModal = function() {
  const modal = document.getElementById('stem-picker-modal');
  if (modal) modal.style.display = 'none';
};

window.selectSpmTier = function(tier) {
  const modal = document.getElementById('stem-picker-modal');
  if (!modal) return;
  // Check Pro lock
  const proLock = document.getElementById('spm-pro-lock');
  if (tier === 'pro' && proLock && proLock.style.display !== 'none') return;

  modal._tier = tier;
  const isPro = tier === 'pro';

  const basicCard  = document.getElementById('spm-basic-card');
  const proCard    = document.getElementById('spm-pro-card');
  const basicCheck = document.getElementById('spm-check-basic');
  const proCheck   = document.getElementById('spm-check-pro');
  const proBadge   = document.getElementById('spm-pro-badge');
  const label      = document.getElementById('spm-confirm-label');
  const btn        = document.getElementById('spm-confirm-btn');

  if (basicCard) basicCard.style.borderColor = isPro ? 'var(--border)' : 'var(--primary)';
  if (proCard && !(proLock && proLock.style.display !== 'none'))
    proCard.style.borderColor = isPro ? '#a855f7' : 'var(--border)';
  if (basicCheck) basicCheck.style.display = isPro ? 'none' : 'flex';
  if (proCheck)   { proCheck.style.display = isPro ? 'flex' : 'none'; }
  if (proBadge)   { proBadge.style.display = isPro ? 'none' : 'block'; }

  if (label) label.textContent = isPro
    ? 'Go to Stems Player — up to 12 stems'
    : 'Go to Stems Player — 5 stems';
  if (btn) btn.style.background = isPro ? 'linear-gradient(135deg,#6c3aff,#a855f7)' : '';
};

window.confirmStemPick = function() {
  const modal = document.getElementById('stem-picker-modal');
  if (!modal || !modal._jobId) return;
  const tier = modal._tier || 'basic';
  modal.style.display = 'none';
  // Save tier choice to sessionStorage — stems player will use this to skip picker on revisit
  try { sessionStorage.setItem('stem_tier_' + modal._jobId, tier); } catch(e) {}
  // Navigate to stems page with tier as query param
  window.location.href = '/stems/' + modal._jobId + '?tier=' + tier;
};

window.saveSongEdit = function() {
  const jobId    = document.getElementById('edit-job-id').value;
  const title    = document.getElementById('edit-title').value.trim();
  const lyrics   = document.getElementById('edit-lyrics').value.trim();
  const bpm      = document.getElementById('edit-bpm').value;
  const genre    = document.getElementById('edit-genre').value.trim();
  const desc     = document.getElementById('edit-description').value.trim();
  const saveBtn  = document.getElementById('edit-save-btn');

  if (!jobId) { closeSongEditModal(); return; }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

  fetch('/api/job/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, title, lyrics, bpm: bpm ? parseInt(bpm) : null, genre, description: desc })
  })
  .then(r => r.json())
  .then(data => {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save changes'; }
    if (data.ok) {
      // Update title in result header if on generator page
      const titleEl = document.getElementById('gen-result-title');
      if (titleEl && title) titleEl.textContent = title;

      // Update card title in project grid if on dashboard
      const card = document.querySelector(`.project-card[data-id="${jobId}"] h4`);
      if (card && title) card.textContent = title;

      closeSongEditModal();
      // Show brief success toast
      const toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#10b981;color:#fff;padding:12px 20px;border-radius:10px;font-weight:600;z-index:99999;box-shadow:0 4px 20px rgba(16,185,129,.4)';
      toast.innerHTML = '<i class="fas fa-check"></i> Changes saved';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2500);
    } else {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save changes'; }
      alert(data.error || 'Could not save changes.');
    }
  })
  .catch(() => {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save changes'; }
    alert('Network error. Please try again.');
  });
};


// ── Developer plan activation (gated by ADMIN_EMAIL secret) ──────
// Called from the hidden developer plan card on the homepage/pricing page.
// The card is only shown when the user manually runs: 
//   document.getElementById('developer-plan-card').style.display='block'
// in the browser console. This keeps it hidden from public users.
window.activateDeveloperPlan = async function() {
  const btn = document.getElementById('dev-activate-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Activating...'; }
  try {
    const res = await fetch('/api/admin/activate-developer', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (btn) { btn.textContent = '✅ Developer Plan Active!'; btn.style.background = '#10b981'; btn.style.color = '#fff'; }
      setTimeout(() => window.location.href = '/dashboard', 1200);
    } else {
      alert('Error: ' + (data.error || 'Activation failed.\n\nMake sure ADMIN_EMAIL secret is set to your email in Cloudflare.'));
      if (btn) { btn.disabled = false; btn.textContent = 'Activate Developer Plan'; }
    }
  } catch(e) {
    alert('Network error. Please try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Activate Developer Plan'; }
  }
};

// ═══════════════════════════════════════════════════════════
//  REFERENCE TRACK FEATURE (Pro Artist)
// ═══════════════════════════════════════════════════════════

// State
let refFileId = null;
let refMode = 'style'; // 'style' | 'extend' | 'loop'
let refBars = 8;
let oneshotSelectedType = '808 bass hit';
let oneshotPollInterval = null;

// Toggle collapse of Reference Track card
window.toggleRefCard = function() {
  const body = document.getElementById('ref-body');
  const icon = document.getElementById('ref-collapse-icon');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (icon) {
    icon.className = isOpen ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
  }
};

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
        // Show upgrade prompt
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
  } catch(err) {
    if (loading) loading.style.display = 'none';
    if (idle) idle.style.display = 'flex';
    alert('Upload error: ' + err.message);
  }
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
  if (zone) zone.classList.remove('has-file');
  if (modePanel) modePanel.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'none';
  if (fileInput) fileInput.value = '';
};

window.selectRefMode = function(mode) {
  refMode = mode;
  document.querySelectorAll('.ref-mode-btn').forEach(b => {
    b.classList.toggle('ref-mode-btn--active', b.dataset.mode === mode);
  });
  const loopOpts = document.getElementById('ref-loop-opts');
  if (loopOpts) loopOpts.style.display = mode === 'loop' ? 'block' : 'none';
};

window.selectBarPreset = function(btn, bars) {
  refBars = bars;
  document.querySelectorAll('.ref-bar-btn').forEach(b => b.classList.remove('ref-bar-btn--active'));
  btn.classList.add('ref-bar-btn--active');
  const customInput = document.getElementById('ref-bar-custom');
  if (customInput) customInput.style.display = bars === 'custom' ? 'flex' : 'none';
};

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
          body.ref_mode = window._refMode;
          if (window._refMode === 'loop') body.ref_bars = window._refBars;
          if (window._refMode === 'extend') body.ref_extend = true;
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

// ── Downgrade-in-progress indicator ────────────────────────
(function initDowngradeIndicator() {
  const pendingDowngrade = sessionStorage.getItem('sf_pending_downgrade');
  if (!pendingDowngrade) return;
  const banner = document.getElementById('sub-creator-downgrade-banner');
  const cancelBtn = document.getElementById('sub-btn-cancel-downgrade-creator');
  const downgradeBtn = document.getElementById('sub-btn-downgrade-to-creator');
  if (pendingDowngrade === 'creator' && banner) {
    banner.style.display = 'flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (downgradeBtn) downgradeBtn.style.display = 'none';
  }
})();

window.cancelDowngrade = async function() {
  const cancelBtn = document.getElementById('sub-btn-cancel-downgrade-creator');
  if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling…'; }
  try {
    // Call real Stripe API to remove scheduled downgrade
    const res = await fetch('/api/subscription/cancel-downgrade', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');

    // Clear UI state
    sessionStorage.removeItem('sf_pending_downgrade');
    const banner = document.getElementById('sub-creator-downgrade-banner');
    const downgradeBtn = document.getElementById('sub-btn-downgrade-to-creator');
    if (banner) banner.style.display = 'none';
    if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.disabled = false; }
    if (downgradeBtn) downgradeBtn.style.display = 'inline-flex';

    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#10b981;color:#fff;padding:12px 20px;border-radius:10px;font-weight:600;z-index:99999;box-shadow:0 4px 20px rgba(16,185,129,.4)';
    toast.innerHTML = '<i class="fas fa-check"></i> ' + (data.message || 'Downgrade cancelled — you stay on your current plan');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  } catch(e) {
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '<i class="fas fa-undo"></i> Cancel Downgrade'; }
    alert('Could not cancel downgrade: ' + (e.message || 'Please contact stemforgesupport@gmail.com'));
  }
};

// Mark downgrade as pending when user confirms it
document.addEventListener('click', function(e) {
  const confirmBtn = e.target.closest('#sub-downgrade-confirm');
  if (!confirmBtn) return;
  const modal = document.getElementById('sub-downgrade-modal');
  const targetPlan = modal && modal._targetPlan;
  if (targetPlan === 'creator') {
    sessionStorage.setItem('sf_pending_downgrade', 'creator');
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
  if (windowEl) {
    const clipFrac = Math.min(1, 30 / dur);
    const startFrac = startSec / dur;
    windowEl.style.left = (startFrac * 100) + '%';
    windowEl.style.width = (clipFrac * 100) + '%';
  }
  window._refClipStart = startSec;
};

window.uploadRefWithClip = async function() {
  const fileInput = document.getElementById('ref-audio-file');
  if (!fileInput || !fileInput.files[0]) return;
  const file = fileInput.files[0];
  const startTime = window._refClipStart || 0;
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
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    window._refFileId = data.file_id;
    if (nameEl) nameEl.textContent = file.name.length > 28 ? file.name.slice(0,25)+'...' : file.name;
    const fmt = s => Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
    if (clipInfo) clipInfo.textContent = 'Clip: ' + fmt(startTime) + ' – ' + fmt(startTime+30) + ' used';
    if (done) { loading.style.display = 'none'; done.style.display = 'flex'; }
    if (zone) { zone.classList.add('has-file'); zone.onclick = null; }
    if (modePanel) modePanel.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'block';
  } catch(err) {
    if (loading) loading.style.display = 'none';
    if (idle) idle.style.display = 'flex';
    alert('Upload error: ' + err.message);
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
    if (file.size > 500 * 1024 || file.type.includes('wav')) {
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
    } else {
      uploadRefTrack(file, file.name);
    }
  }, true);
})();
