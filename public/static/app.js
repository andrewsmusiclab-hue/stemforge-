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
      creator: { name: 'Creator Plan', price: '$19', total: '$19.00', features: ['50 generations/month', 'Stereo mix + stem bundle', 'Commercial use rights', '+$0.49 per extra generation'] },
      pro:     { name: 'Pro Artist Plan', price: '$39', total: '$39.00', features: ['150 generations/month', 'Everything in Creator', 'Priority queue', '+$0.49 per extra generation'] },
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

  // ── Dashboard: load real projects from /api/projects ───────────
  const projectGrid = document.getElementById('project-grid');
  if (projectGrid) {
    (async () => {
      try {
        const res = await fetch('/api/projects');
        if (!res.ok) {
          projectGrid.innerHTML = `<div class="project-grid-loading" style="color:var(--muted)"><i class="fas fa-lock"></i> Sign in to see your projects. <a href="/login">Log in</a></div>
            <div class="project-card project-card--new"><a href="/generator" class="project-card__new-inner"><i class="fas fa-plus-circle"></i><span>New beat</span></a></div>`;
          return;
        }
        const { projects } = await res.json();
        let html = '';
        if (projects && projects.length > 0) {
          projects.forEach((p, i) => {
            const hue = p.thumbnail_seed != null ? p.thumbnail_seed : (i * 47) % 360;
            const thumbBg = `linear-gradient(135deg, hsl(${hue},70%,30%) 0%, hsl(${(hue+60)%360},80%,20%) 100%)`;
            const bpm   = p.blueprint ? p.blueprint.bpm + ' BPM' : '';
            const genre = p.blueprint ? p.blueprint.genre : '';
            const dur   = p.blueprint ? Math.floor(p.blueprint.duration_seconds / 60) + ':' + String(p.blueprint.duration_seconds % 60).padStart(2,'0') : '';
            const label = p.prompt ? p.prompt.slice(0, 32) + (p.prompt.length > 32 ? '…' : '') : 'Beat';
            const rawTitle = p.title || (p.blueprint ? (p.blueprint.genre + (p.blueprint.key ? ' — ' + p.blueprint.key : '')) : label);
            const sub   = [bpm, dur].filter(Boolean).join(' · ');
            const safeFilename = rawTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g,'_').toLowerCase();
            // Build art style: gradient base always shown first; Canvas art applied after
            const artStyle = thumbBg;
            html += `
              <div class="project-card" data-stereo="${p.stereo_url || ''}" data-zip="${p.zip_url || ''}" data-id="${p.id}" data-title="${rawTitle.replace(/"/g,'&quot;')}" data-hue="${hue}" data-genre="${(genre||'music').replace(/"/g,'&quot;')}" data-imgurl="${p.image_url || ''}">
                <div class="project-card__art" style="${artStyle}">
                  <div class="project-card__art-icon"><i class="fas fa-wave-square"></i></div>
                  <div class="project-card__play" onclick="playDashProject(this)"><i class="fas fa-play"></i></div>
                </div>
                <div class="project-card__body">
                  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
                    <h4 style="margin:0;flex:1">${rawTitle}</h4>
                    <button class="song-dots-btn" title="More options" onclick="event.stopPropagation();openCardMenu(this,'${p.id}','${p.stereo_url||''}','${p.zip_url||''}','${safeFilename}')" style="flex-shrink:0"><i class="fas fa-ellipsis-h"></i></button>
                  </div>
                  <p>${sub || genre || label}</p>
                  <div class="project-card__tags">
                    ${bpm ? `<span class="export-badge" style="background:rgba(78,159,255,.12);color:var(--primary);border:1px solid rgba(78,159,255,.25);font-size:.72rem">${bpm}</span>` : ''}
                  </div>
                </div>
              </div>`;
          });
        } else {
          html = `<div class="project-grid-empty">
            <i class="fas fa-music" style="font-size:40px;opacity:.3;margin-bottom:16px"></i>
            <p>No beats yet. <a href="/generator">Generate your first beat!</a></p>
          </div>`;
        }
        html += `<div class="project-card project-card--new"><a href="/generator" class="project-card__new-inner"><i class="fas fa-plus-circle"></i><span>New beat</span></a></div>`;
        projectGrid.innerHTML = html;

        // Draw canvas placeholder instantly for all cards, then load real AI images async
        projectGrid.querySelectorAll('.project-card[data-hue]').forEach(card => {
          const hue    = parseInt(card.dataset.hue || '180', 10);
          const title  = card.dataset.title || '';
          const genre  = card.dataset.genre || 'music';
          const jobId  = card.dataset.id || '';
          const imgUrl = card.dataset.imgurl || '';   // permanent /api/cover-art/ URL if already cached
          const artEl  = card.querySelector('.project-card__art');
          if (!artEl) return;

          // Step 1: draw Canvas placeholder instantly
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
            ctx.fillText(genre.toUpperCase(), 128, 36);
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
            const words = title.split(' ');
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

          // Step 2: load real AI image
          // If the server already returned a permanent /api/cover-art/ URL, use it immediately —
          // no API call needed (the browser caches it with immutable Cache-Control headers).
          // Only call /api/cover-image/ when no cached URL exists yet.
          if (!jobId) return;

          if (imgUrl && imgUrl.includes('/api/cover-art/')) {
            // Already cached — apply directly, no fetch needed
            const img = new Image();
            img.onload = () => {
              artEl.style.backgroundImage = `url('${imgUrl}')`;
              artEl.style.backgroundSize = 'cover';
              artEl.style.backgroundPosition = 'center';
            };
            img.src = imgUrl;
            return;
          }

          // No cached URL — fetch from server (generates once, caches forever)
          // Small stagger to avoid hammering the API simultaneously for all cards
          const imgCacheKey = 'cover_img_' + jobId;
          // Clean up any legacy data: URLs from sessionStorage
          try {
            const stale = sessionStorage.getItem(imgCacheKey);
            if (stale && stale.startsWith('data:')) sessionStorage.removeItem(imgCacheKey);
          } catch(e) {}

          const cardIndex = Array.from(projectGrid.querySelectorAll('.project-card[data-hue]')).indexOf(card);
          setTimeout(() => {
            fetch('/api/cover-image/' + jobId)
              .then(r => r.ok ? r.json() : null)
              .then(data => {
                if (!data || !data.url) return;
                // Update the card's data-imgurl so subsequent renders use the cached URL
                card.dataset.imgurl = data.url;
                const img = new Image();
                img.onload = () => {
                  artEl.style.backgroundImage = `url('${data.url}')`;
                  artEl.style.backgroundSize = 'cover';
                  artEl.style.backgroundPosition = 'center';
                };
                img.src = data.url;
              })
              .catch(() => { /* keep canvas art */ });
          }, cardIndex * 800); // 800ms stagger between cards
        });

        // Inject dashboard upgrade modal if not already present
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
      } catch(e) {
        projectGrid.innerHTML = `<div class="project-grid-loading" style="color:var(--muted)">Could not load projects.</div>
          <div class="project-card project-card--new"><a href="/generator" class="project-card__new-inner"><i class="fas fa-plus-circle"></i><span>New beat</span></a></div>`;
      }
    })();
  }

  // ── Dashboard: card 3-dots context menu ─────────────────────────
  window.openCardMenu = function(btn, jobId, stereoUrl, zipUrl, safeTitle) {
    // Remove any existing menu
    const existing = document.getElementById('card-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'card-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.55);min-width:200px;overflow:hidden;padding:4px 0';

    const items = [
      { icon: 'fa-pencil-alt', label: 'Edit track info', action: () => openSongEditModal(null, jobId) },
      { icon: 'fa-layer-group', label: 'Get Stems', action: () => openStemsPopup(jobId, zipUrl) },
      { icon: 'fa-download', label: 'Download Full Track', action: () => openDownloadModal(jobId, stereoUrl, safeTitle) },
    ];

    items.forEach(item => {
      const el = document.createElement('button');
      el.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;background:none;border:none;color:var(--text);cursor:pointer;font-size:.875rem;font-weight:500;text-align:left;transition:background .12s';
      el.innerHTML = `<i class="fas ${item.icon}" style="width:15px;opacity:.65;flex-shrink:0"></i>${item.label}`;
      el.onmouseover = () => el.style.background = 'rgba(255,255,255,.06)';
      el.onmouseout  = () => el.style.background = 'none';
      el.onclick = (e) => { e.stopPropagation(); menu.remove(); item.action(); };
      menu.appendChild(el);
    });

    // Position near the button
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

    // Close on outside click
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
      { icon: 'fa-drum',       label: bp.bpm + ' BPM' },
      { icon: 'fa-music',      label: bp.key + ' ' + bp.scale },
      { icon: 'fa-compact-disc',label: bp.genre },
      { icon: 'fa-heart',      label: bp.mood },
      { icon: 'fa-bolt',       label: bp.energy + ' energy' },
      { icon: 'fa-clock',      label: Math.round(bp.duration_seconds/60) + ' min' },
      { icon: 'fa-layer-group',label: bp.instrument_count + ' instruments' },
    ];
    pills.forEach(p => {
      const el = document.createElement('span');
      el.className = 'blueprint-pill';
      el.innerHTML = `<i class="fas ${p.icon}"></i> ${p.label}`;
      bpPills.appendChild(el);
    });
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
          title: inputs.title || ''
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

            // Export panel stereo button
            const expStereoBtn = document.getElementById('exp-stereo');
            if (expStereoBtn) {
              if (isFree) {
                expStereoBtn.classList.add('export-btn--locked');
                expStereoBtn.querySelector('small').textContent = 'Creator+';
                expStereoBtn.onclick = () => showUpgradePrompt();
              } else {
                expStereoBtn.classList.remove('export-btn--locked');
                expStereoBtn.querySelector('small').textContent = 'Stereo';
                expStereoBtn.onclick = () => {
                  const a = document.createElement('a');
                  a.href = job.stereo_url;
                  a.download = safeFilename + '_stereo.mp3';
                  document.body.appendChild(a); a.click(); a.remove();
                };
              }
            }

            // Get Stems button — opens stems player page
            const zipBtn = document.getElementById('exp-stems');
            if (zipBtn) {
              if (isFree) {
                zipBtn.classList.add('export-btn--locked');
                zipBtn.onclick = () => showUpgradePrompt();
              } else {
                zipBtn.classList.remove('export-btn--locked');
                zipBtn.onclick = () => {
                  window.location.href = '/stems/' + job.id;
                };
              }
            }

            // "Get up to 12 stems" button — same stems page
            const tracksBtn = document.getElementById('exp-tracks');
            if (tracksBtn) {
              if (isFree) {
                tracksBtn.classList.add('export-btn--locked');
                tracksBtn.onclick = () => showUpgradePrompt();
              } else {
                tracksBtn.classList.remove('export-btn--locked');
                tracksBtn.onclick = () => {
                  window.location.href = '/stems/' + job.id;
                };
              }
            }

            // Show upgrade nudge below export panel for free users
            const upgradeNudge = document.querySelector('.upgrade-nudge');
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

            // Show thumbnail on result card — real AI image with gradient fallback
            const thumbEl = document.getElementById('gen-result-thumb');
            const thumbLabel = document.getElementById('gen-result-thumb-label');
            if (thumbEl) {
              // Always set gradient as base background (shows instantly)
              const hue = job.thumbnail_seed ?? 180;
              const hue2 = (hue + 55) % 360;
              const hue3 = (hue + 120) % 360;
              const gradientBg = `linear-gradient(135deg, hsl(${hue},65%,28%) 0%, hsl(${hue2},75%,20%) 55%, hsl(${hue3},60%,15%) 100%)`;
              thumbEl.style.backgroundImage = gradientBg;
              thumbEl.style.backgroundSize = 'cover';
              thumbEl.style.backgroundPosition = 'center';
              thumbEl.style.display = 'flex';
              if (thumbLabel) thumbLabel.textContent = finalTitle;

              // Generate Canvas-based cover art (no external service)
              try {
                const genre = (job.blueprint && job.blueprint.genre) || 'music';
                const cnv = document.createElement('canvas');
                cnv.width = 300; cnv.height = 300;
                const ctx = cnv.getContext('2d');
                const g = ctx.createLinearGradient(0,0,300,300);
                g.addColorStop(0,`hsl(${hue},60%,18%)`);
                g.addColorStop(0.5,`hsl(${(hue+40)%360},70%,12%)`);
                g.addColorStop(1,`hsl(${(hue+80)%360},55%,8%)`);
                ctx.fillStyle=g; ctx.fillRect(0,0,300,300);
                const r1=ctx.createRadialGradient(240,60,8,240,60,140);
                r1.addColorStop(0,`hsla(${(hue+120)%360},80%,60%,0.3)`);
                r1.addColorStop(1,'transparent');
                ctx.fillStyle=r1; ctx.fillRect(0,0,300,300);
                const r2=ctx.createRadialGradient(60,240,4,60,240,120);
                r2.addColorStop(0,`hsla(${(hue+240)%360},70%,55%,0.2)`);
                r2.addColorStop(1,'transparent');
                ctx.fillStyle=r2; ctx.fillRect(0,0,300,300);
                ctx.font='bold 13px system-ui,sans-serif';
                ctx.fillStyle=`hsla(${hue},60%,85%,0.65)`;
                ctx.textAlign='center';
                ctx.fillText(genre.toUpperCase(),150,36);
                const bc=20; const bw=7; const bg2=4;
                const tw=bc*(bw+bg2)-bg2; const sx=(300-tw)/2;
                for(let b=0;b<bc;b++){
                  const sd=(hue*13+b*97)%360;
                  const bh=22+(Math.sin(sd*0.13)*0.5+0.5)*56;
                  const x=sx+b*(bw+bg2); const y=145-bh/2;
                  const bg3=ctx.createLinearGradient(0,y,0,y+bh);
                  bg3.addColorStop(0,`hsla(${(hue+40)%360},80%,75%,0.85)`);
                  bg3.addColorStop(1,`hsla(${hue},60%,50%,0.3)`);
                  ctx.fillStyle=bg3;
                  ctx.beginPath();
                  if(ctx.roundRect) ctx.roundRect(x,y,bw,bh,2); else ctx.rect(x,y,bw,bh);
                  ctx.fill();
                }
                const words=finalTitle.split(' ');
                const l1=words.slice(0,Math.ceil(words.length/2)).join(' ');
                const l2=words.slice(Math.ceil(words.length/2)).join(' ');
                ctx.font='bold 18px system-ui,sans-serif';
                ctx.fillStyle='#fff';
                ctx.shadowColor='rgba(0,0,0,0.9)'; ctx.shadowBlur=6;
                if(l2){ctx.fillText(l1.slice(0,18),150,222);ctx.fillText(l2.slice(0,18),150,246);}
                else{ctx.fillText(l1.slice(0,20),150,234);}
                ctx.shadowBlur=0;
                const du=cnv.toDataURL('image/png');
                thumbEl.style.backgroundImage=`url('${du}')`;
                thumbEl.style.backgroundSize='cover';
              } catch(e){/* gradient fallback already shown */}

              // Load real AI image async on top of the canvas placeholder
              if (job.id) {
                fetch('/api/cover-image/' + job.id)
                  .then(r => r.ok ? r.json() : null)
                  .then(data => {
                    if (!data || !data.url) return;
                    // Clear any stale data: URL from sessionStorage now that we have a permanent R2 URL
                    if (!data.url.startsWith('data:')) {
                      try { sessionStorage.removeItem('cover_img_' + job.id); } catch(e) {}
                    }
                    const img = new Image();
                    img.onload = () => {
                      thumbEl.style.backgroundImage = `url('${data.url}')`;
                      thumbEl.style.backgroundSize = 'cover';
                      thumbEl.style.backgroundPosition = 'center';
                    };
                    img.src = data.url;
                  })
                  .catch(() => {});
              }
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

function resetStemsSection() {
  const sec    = document.getElementById('edit-stems-section');
  const status = document.getElementById('edit-stems-status');
  const result = document.getElementById('edit-stems-result');
  const btn    = document.getElementById('edit-get-stems-btn');
  if (sec)    sec.style.display = 'none';
  if (status) { status.style.display = 'none'; status.textContent = ''; }
  if (result) result.style.display = 'none';
  if (btn)    { btn.disabled = false; btn.innerHTML = '<i class="fas fa-layer-group"></i> Extract'; }
}

function showStemsSection(job) {
  const user = window._sfUser;
  if (!user || user.plan === 'free') return; // free plan — don't show
  const sec  = document.getElementById('edit-stems-section');
  const desc = document.getElementById('edit-stems-desc');
  if (!sec) return;

  // Already extracted — link to stems player page
  if (job && job.zip_url) {
    sec.style.display = 'block';
    if (desc) desc.textContent = 'Stems extracted — open the stems player to preview and download.';
    const btn = document.getElementById('edit-get-stems-btn');
    if (btn) {
      btn.innerHTML = '<i class="fas fa-play-circle"></i> Open Stems Player';
      btn.onclick = () => { window.location.href = '/stems/' + job.id; };
      btn.style.display = '';
    }
    const result = document.getElementById('edit-stems-result');
    const zipLink = document.getElementById('edit-stems-zip-link');
    if (result && zipLink) {
      zipLink.href = job.zip_url;
      const title = (job.title || job.blueprint?.genre || 'beat').replace(/[^a-zA-Z0-9 \-_]/g,'').replace(/\s+/g,'_').toLowerCase();
      zipLink.download = title + '_stems.zip';
      result.style.display = 'flex';
    }
    if (job.midi_zip_url) {
      const midiLink = document.getElementById('edit-stems-midi-link');
      if (midiLink) { midiLink.href = job.midi_zip_url; midiLink.style.display = 'inline-flex'; }
    }
    return;
  }

  // Not yet extracted — show cost info
  sec.style.display = 'block';
  const isPro = user.plan === 'pro';
  const cost  = isPro ? 10 : 2;
  const stems = isPro ? 'up to 12 stems' : '5 stems';
  if (desc) desc.textContent = `${stems} · costs ${cost} credits (you have ${user.gens_limit - user.gens_used} remaining)`;
  const btn = document.getElementById('edit-get-stems-btn');
  if (btn) btn.style.display = '';
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

// Request stems on-demand — called from "Get Stems" button in 3-dot modal
window.requestStems = async function() {
  const jobId  = document.getElementById('edit-job-id')?.value;
  const btn    = document.getElementById('edit-get-stems-btn');
  const status = document.getElementById('edit-stems-status');
  const result = document.getElementById('edit-stems-result');
  if (!jobId || !btn) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extracting...';
  if (status) { status.style.display = 'block'; status.style.background = 'rgba(99,102,241,.12)'; status.style.color = 'var(--text)'; status.textContent = '⏳ Extracting stems — this takes ~10 seconds...'; }

  try {
    const res  = await fetch('/api/job/stems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      if (status) { status.style.background = 'rgba(239,68,68,.12)'; status.style.color = '#f87171'; status.textContent = '❌ ' + (data.error || 'Stem extraction failed. Please try again.'); }
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-layer-group"></i> Retry';
      return;
    }

    // Success — update sidebar credits
    if (window._sfUser) {
      const cost = data.credits_used || 0;
      window._sfUser.gens_used = (window._sfUser.gens_used || 0) + cost;
      const gsGensVal = document.getElementById('gs-gens-val');
      const limitMap  = { free: 3, creator: 50, pro: 150 };
      const lim = window._sfUser.gens_limit || limitMap[window._sfUser.plan] || 3;
      if (gsGensVal) gsGensVal.innerHTML = `${window._sfUser.gens_used} <small>/ ${lim}</small>`;
    }

    // Update cached job
    if (window._sfProjects && window._sfProjects[jobId]) {
      window._sfProjects[jobId].zip_url = data.zip_url;
    }

    // Redirect to stems player page
    if (status) { status.style.background = 'rgba(16,185,129,.12)'; status.style.color = '#34d399'; status.textContent = `✅ Done! Redirecting to stems player...`; }
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening...';
    setTimeout(() => { window.location.href = '/stems/' + jobId; }, 800);

  } catch(e) {
    if (status) { status.style.background = 'rgba(239,68,68,.12)'; status.style.color = '#f87171'; status.textContent = '❌ Network error. Please try again.'; }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-layer-group"></i> Retry';
  }
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
