/* ═══════════════════════════════════════════════════════════════
   StemForge — Frontend App JS
═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  // ── Nav scroll effect ──────────────────────────────────────────
  const nav = document.getElementById('sf-nav');
  if (nav) {
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 20);
    });
  }

  // ── Hamburger menu ─────────────────────────────────────────────
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobile-menu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      mobileMenu.classList.toggle('open');
    });
  }

  // ── Waveform animation (hero) ──────────────────────────────────
  const trackColors = {
    kick:   '#ef4444', snare: '#f97316', hats:   '#eab308',
    bass:   '#3b82f6', rhodes:'#8b5cf6', guitar: '#06b6d4',
    pad:    '#10b981', fx:    '#ec4899'
  };
  document.querySelectorAll('.wv-bars').forEach(container => {
    const track = container.dataset.track;
    const color = trackColors[track] || '#4e9fff';
    for (let i = 0; i < 80; i++) {
      const bar = document.createElement('div');
      bar.className = 'wv-bar';
      const h = Math.random() * 24 + 4;
      bar.style.cssText = `
        height: ${h}px;
        background: ${color};
        animation-delay: ${(Math.random() * 1.2).toFixed(2)}s;
        animation-duration: ${(0.8 + Math.random() * 0.8).toFixed(2)}s;
        opacity: ${0.4 + Math.random() * 0.6};
      `;
      container.appendChild(bar);
    }
  });

  // ── Track row waveforms (generator / project) ──────────────────
  const allTrackColors = {
    Kick:'#ef4444', Snare:'#f97316', 'Hi-hats':'#eab308',
    Bass:'#3b82f6', Rhodes:'#8b5cf6', Guitar:'#06b6d4',
    Pad:'#10b981', FX:'#ec4899'
  };
  function fillTrackWave(container, color) {
    for (let i = 0; i < 120; i++) {
      const b = document.createElement('div');
      const h = Math.random() * 26 + 4;
      b.style.cssText = `
        width:2px; height:${h}px; border-radius:1px;
        background:${color}; opacity:${0.4 + Math.random() * 0.5};
        flex-shrink:0;
      `;
      container.appendChild(b);
    }
  }
  document.querySelectorAll('.track-row').forEach(row => {
    const name = row.dataset.track;
    const color = allTrackColors[name] || '#4e9fff';
    const wave = row.querySelector('.track-row__wave');
    if (wave && !wave.dataset.autofill) fillTrackWave(wave, color);
  });
  document.querySelectorAll('[data-autofill]').forEach(wave => {
    const row = wave.closest('.track-row');
    const name = row?.dataset.track;
    const color = allTrackColors[name] || '#4e9fff';
    fillTrackWave(wave, color);
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

  // ── Credit calculator ──────────────────────────────────────────
  const calcInputs = {
    beats:   { el: document.getElementById('calc-beats'),   cost: 50 },
    masters: { el: document.getElementById('calc-masters'),  cost: 20 },
    stems:   { el: document.getElementById('calc-stems'),   cost: 60 },
    tracks:  { el: document.getElementById('calc-tracks'),  cost: 180 },
    regen:   { el: document.getElementById('calc-regen'),   cost: 15 },
  };
  const calcTotal = document.getElementById('calc-total');
  const calcPlan  = document.getElementById('calc-plan');
  function updateCalc() {
    let total = 0;
    Object.values(calcInputs).forEach(({ el, cost }) => {
      if (el) total += (parseInt(el.value) || 0) * cost;
    });
    if (calcTotal) calcTotal.textContent = total.toLocaleString();
    if (calcPlan) {
      if (total <= 150)       calcPlan.textContent = 'Free';
      else if (total <= 3000) calcPlan.textContent = 'Creator ($12/mo)';
      else                    calcPlan.textContent = 'Pro Artist ($29/mo)';
    }
  }
  Object.values(calcInputs).forEach(({ el }) => {
    if (el) el.addEventListener('input', updateCalc);
  });
  updateCalc();

  // ── Generator: BPM slider ──────────────────────────────────────
  const bpmSlider = document.getElementById('gen-bpm');
  const bpmVal    = document.getElementById('gen-bpm-val');
  if (bpmSlider && bpmVal) {
    bpmSlider.addEventListener('input', () => {
      bpmVal.textContent = bpmSlider.value + ' BPM';
    });
  }

  // ── Generator: toggle groups ───────────────────────────────────
  document.querySelectorAll('.toggle-group').forEach(group => {
    group.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  // ── Generator: instrument tags ─────────────────────────────────
  document.querySelectorAll('.inst-tag').forEach(tag => {
    tag.addEventListener('click', () => tag.classList.toggle('active'));
  });

  // ── Generator: filter buttons ──────────────────────────────────
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ── Generator: prompt preview ──────────────────────────────────
  const promptInput   = document.getElementById('gen-prompt');
  const promptPreview = document.getElementById('prompt-preview');
  if (promptInput && promptPreview) {
    promptInput.addEventListener('input', () => {
      promptPreview.textContent = promptInput.value.trim()
        || 'Start typing to build your prompt preview...';
    });
  }

  // ── Generator: simulate generate ──────────────────────────────
  const genFullBtn = document.getElementById('gen-full-btn');
  const genDraftBtn= document.getElementById('gen-draft-btn');
  const genResult  = document.getElementById('gen-result');
  const genEmpty   = document.getElementById('gen-empty');

  function showResult() {
    if (genResult) {
      genResult.style.display = 'block';
      const title = document.getElementById('gen-result-title');
      const sub   = document.getElementById('gen-result-sub');
      const genre = document.getElementById('gen-genre');
      const bpm   = document.getElementById('gen-bpm');
      if (title && genre && bpm) {
        title.textContent = (genre?.value || 'Beat') + ' — ' + (bpm?.value || '90') + ' BPM';
      }
      if (sub) sub.textContent = 'Generated · 8 individual tracks · 2:14';
    }
    if (genEmpty) genEmpty.style.display = 'none';
  }

  function simulateGenerate(btn, label) {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ' + label + '...';
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.disabled = false;
      showResult();
    }, 2000);
  }

  if (genFullBtn) genFullBtn.addEventListener('click', () => simulateGenerate(genFullBtn, 'Generating'));
  if (genDraftBtn) genDraftBtn.addEventListener('click', () => simulateGenerate(genDraftBtn, 'Drafting'));

  // ── Export buttons ─────────────────────────────────────────────
  document.querySelectorAll('.export-btn:not(.export-btn--locked)').forEach(btn => {
    btn.addEventListener('click', () => {
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing...';
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
    });
  });
  document.querySelectorAll('.export-btn--locked').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = '/pricing';
    });
  });

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
      if (v.length >= 8)  score++;
      if (/[A-Z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      const colors = ['#ef4444','#f97316','#eab308','#10b981'];
      const widths = ['25%','50%','75%','100%'];
      pwStrength.style.cssText = `
        height:3px; border-radius:2px; margin-top:6px;
        background:${colors[score-1]||'#1a2a48'};
        width:${widths[score-1]||'0%'};
        transition:all .3s ease;
      `;
    });
  }

  // ── Card number formatting ─────────────────────────────────────
  const cardNum = document.getElementById('card-num');
  if (cardNum) {
    cardNum.addEventListener('input', e => {
      let v = e.target.value.replace(/\D/g, '').substring(0, 16);
      e.target.value = v.replace(/(.{4})/g, '$1 ').trim();
    });
  }
  const cardExp = document.getElementById('card-exp');
  if (cardExp) {
    cardExp.addEventListener('input', e => {
      let v = e.target.value.replace(/\D/g, '').substring(0, 4);
      if (v.length >= 2) v = v.slice(0,2) + ' / ' + v.slice(2);
      e.target.value = v;
    });
  }

  // ── Signup form ────────────────────────────────────────────────
  const signupForm = document.getElementById('signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', e => {
      e.preventDefault();
      const plan = signupForm.querySelector('input[name="plan"]:checked')?.value;
      if (plan === 'free') window.location.href = '/dashboard';
      else window.location.href = '/checkout';
    });
  }

  // ── Login form ─────────────────────────────────────────────────
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', e => {
      e.preventDefault();
      window.location.href = '/dashboard';
    });
  }

  // ── Checkout form ──────────────────────────────────────────────
  const checkoutForm = document.getElementById('checkout-form');
  const checkoutSubmit = document.getElementById('checkout-submit');
  if (checkoutForm && checkoutSubmit) {
    checkoutForm.addEventListener('submit', e => {
      e.preventDefault();
      const orig = checkoutSubmit.innerHTML;
      checkoutSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
      checkoutSubmit.disabled = true;
      setTimeout(() => {
        checkoutSubmit.innerHTML = '<i class="fas fa-check"></i> Payment successful!';
        checkoutSubmit.style.background = '#10b981';
        setTimeout(() => window.location.href = '/dashboard', 1200);
      }, 2000);
    });
  }

  // ── Fade-up on scroll ──────────────────────────────────────────
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.feature-card, .plan-card, .testi-card, .how__step').forEach(el => {
    el.style.cssText += '; opacity:0; transform:translateY(20px); transition: opacity .5s ease, transform .5s ease;';
    observer.observe(el);
  });

  // ── Active nav link highlight ──────────────────────────────────
  const path = window.location.pathname;
  document.querySelectorAll('.sf-nav__links a, .sf-nav__mobile a').forEach(link => {
    if (link.getAttribute('href') === path) {
      link.style.color = 'var(--primary)';
    }
  });

});
