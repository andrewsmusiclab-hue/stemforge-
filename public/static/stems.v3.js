// ═══════════════════════════════════════════════════════════════════════════
//  StemForge Stem Player v3 — clean build, MusicAPI only, no Mureka legacy
//  API contract:
//    POST /api/job/stems  { job_id, mode }  → { ok, task_id, status, stems? }
//    GET  /api/job/stems/:jobId?mode=&task_id=  → { status, stems?, error? }
//    GET  /api/stem-audio/:jobId/:stemName   → audio stream (proxied)
//    GET  /api/stem-audio/:jobId/:stemName?dl=1  → download
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Stem colour palette ──────────────────────────────────────────────────
  var COLORS = {
    vocals:       '#3b82f6',
    instrumental: '#8b5cf6',
    drums:        '#f59e0b',
    bass:         '#ec4899',
    piano:        '#06b6d4',
    guitar:       '#ef4444',
    synth:        '#84cc16',
    strings:      '#10b981',
    other:        '#64748b',
    _default:     '#6366f1'
  };

  // ── Stem icons ────────────────────────────────────────────────────────────
  var ICONS = {
    vocals:       'fa-microphone',
    instrumental: 'fa-music',
    drums:        'fa-drum',
    bass:         'fa-guitar',
    piano:        'fa-piano-keys',
    guitar:       'fa-guitar',
    synth:        'fa-wave-square',
    strings:      'fa-violin',
    other:        'fa-layer-group',
    _default:     'fa-music'
  };

  // ── State ─────────────────────────────────────────────────────────────────
  var _panel     = null;
  var _jobId     = null;
  var _title     = null;
  var _plan      = 'free';
  var _mode      = null;         // 'split_from_mix' | 'auto'
  var _taskId    = null;
  var _pollTimer = null;
  var _stems     = [];           // [{ name, url, muted, solo, vol }]
  var _audios    = [];           // [Audio]
  var _playing   = false;
  var _rafId     = null;

  // ── Public API ────────────────────────────────────────────────────────────
  window.openStemsPanel = function (jobId, stereoUrl, title, userPlan) {
    _jobId = jobId;
    _title = title || 'Track';
    _plan  = userPlan || 'free';

    _cleanup();
    var old = document.getElementById('sfp-overlay');
    if (old) old.remove();

    _panel = _buildPanel();
    document.body.appendChild(_panel);

    // Fade in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        _panel.style.opacity = '1';
        var card = _panel.querySelector('.sfp-card');
        if (card) card.style.transform = 'translateY(0) scale(1)';
      });
    });

    _bindPanelEvents();
    _tryRestoreCache();
  };

  window.closeStemsPanel = function () {
    if (!_panel) return;
    _panel.style.opacity = '0';
    var card = _panel.querySelector('.sfp-card');
    if (card) card.style.transform = 'translateY(12px) scale(0.97)';
    var p = _panel;
    setTimeout(function () { if (p && p.parentNode) p.parentNode.removeChild(p); }, 220);
    _panel = null;
    _cleanup();
  };

  // ── Build panel HTML ──────────────────────────────────────────────────────
  function _buildPanel() {
    var overlay = document.createElement('div');
    overlay.id = 'sfp-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99990',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.8)',
      'backdrop-filter:blur(12px)', '-webkit-backdrop-filter:blur(12px)',
      'padding:16px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'opacity:0', 'transition:opacity 0.2s ease',
      'user-select:none'
    ].join(';');

    overlay.innerHTML = _cardHTML();
    return overlay;
  }

  function _cardHTML() {
    var safeTitle = _esc(_title).slice(0, 48);
    return [
      '<div class="sfp-card" style="',
        'background:linear-gradient(160deg,#0f0f1e 0%,#111128 100%);',
        'border:1px solid rgba(255,255,255,0.07);',
        'border-radius:20px;',
        'box-shadow:0 40px 120px rgba(0,0,0,0.95),0 0 0 1px rgba(255,255,255,0.04);',
        'width:100%;max-width:580px;',
        'display:flex;flex-direction:column;overflow:hidden;',
        'transform:translateY(14px) scale(0.97);',
        'transition:transform 0.28s cubic-bezier(0.22,1,0.36,1)',
      '">',

        // ── Header
        '<div style="display:flex;align-items:center;gap:12px;padding:18px 20px 14px;',
            'border-bottom:1px solid rgba(255,255,255,0.05)">',
          '<div style="width:38px;height:38px;border-radius:10px;flex-shrink:0;',
              'background:linear-gradient(135deg,rgba(99,102,241,.25),rgba(168,85,246,.25));',
              'display:flex;align-items:center;justify-content:center">',
            '<i class="fas fa-layer-group" style="color:#818cf8;font-size:.85rem"></i>',
          '</div>',
          '<div style="flex:1;min-width:0">',
            '<div style="font-size:.88rem;font-weight:700;color:#f1f5f9;',
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + safeTitle + '</div>',
            '<div style="font-size:.65rem;color:rgba(255,255,255,0.28);margin-top:2px;letter-spacing:.04em">STEM EXTRACTOR</div>',
          '</div>',
          '<button id="sfp-close" aria-label="Close" style="',
              'width:30px;height:30px;border-radius:50%;border:none;',
              'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.4);',
              'cursor:pointer;display:flex;align-items:center;justify-content:center;',
              'font-size:1.1rem;flex-shrink:0;transition:background .15s,color .15s"',
            ' onmouseover="this.style.background=\'rgba(255,255,255,.14)\';this.style.color=\'#fff\'"',
            ' onmouseout="this.style.background=\'rgba(255,255,255,.06)\';this.style.color=\'rgba(255,255,255,.4)\'">&times;</button>',
        '</div>',

        // ── Mode selector
        '<div id="sfp-mode-bar" style="display:flex;gap:8px;padding:14px 20px 0">',
          _modeBtn('split_from_mix', 'fa-microphone', 'Vocals & Inst.', 'Split into Vocals + Instrumental — fast, 2 stems'),
          _modeBtn('auto',           'fa-layer-group','Full Stems',      'Up to 5 stems: Vocals · Drums · Bass · Other · Instrumental'),
        '</div>',

        // ── Tab body (description + extract button)
        '<div id="sfp-body" style="padding:16px 20px 18px;min-height:72px">',
          '<p style="color:rgba(255,255,255,0.28);font-size:.8rem;text-align:center;margin:12px 0">',
            'Select a mode above to extract stems',
          '</p>',
        '</div>',

        // ── Stems area (hidden until ready)
        '<div id="sfp-stems" style="display:none;flex-direction:column;max-height:280px;overflow-y:auto;',
            'border-top:1px solid rgba(255,255,255,0.05)"></div>',

        // ── Playback bar (hidden until ready)
        '<div id="sfp-playbar" style="display:none;align-items:center;gap:10px;padding:10px 20px;',
            'border-top:1px solid rgba(255,255,255,0.05);background:rgba(0,0,0,0.2);flex-shrink:0">',
          '<button id="sfp-play-btn" aria-label="Play/Pause" style="',
              'width:34px;height:34px;border-radius:50%;border:none;',
              'background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;',
              'cursor:pointer;display:flex;align-items:center;justify-content:center;',
              'font-size:.78rem;flex-shrink:0;transition:transform .12s,opacity .15s"',
            ' onmouseover="this.style.opacity=\'.82\'"',
            ' onmouseout="this.style.opacity=\'1\'">',
            '<i id="sfp-play-icon" class="fas fa-play"></i>',
          '</button>',
          '<span id="sfp-time-cur" style="font-size:.68rem;color:rgba(255,255,255,0.35);min-width:30px;flex-shrink:0">0:00</span>',
          '<div id="sfp-timeline" style="flex:1;height:4px;background:rgba(255,255,255,0.08);',
              'border-radius:4px;cursor:pointer;position:relative">',
            '<div id="sfp-tl-fill" style="position:absolute;left:0;top:0;bottom:0;width:0%;',
                'background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:4px;pointer-events:none"></div>',
            '<div id="sfp-tl-thumb" style="position:absolute;top:50%;width:10px;height:10px;',
                'border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(99,102,241,.6);',
                'transform:translate(-50%,-50%);left:0%;pointer-events:none"></div>',
          '</div>',
          '<span id="sfp-time-tot" style="font-size:.68rem;color:rgba(255,255,255,0.35);min-width:30px;text-align:right;flex-shrink:0">0:00</span>',
          // Download button (right side)
          '<div id="sfp-dl-area"></div>',
        '</div>',

      '</div>'
    ].join('');
  }

  function _modeBtn(mode, icon, label, desc) {
    return [
      '<button class="sfp-mode-btn" data-mode="' + mode + '" style="',
          'flex:1;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);',
          'background:rgba(255,255,255,0.03);cursor:pointer;text-align:left;',
          'transition:all .2s;color:#cbd5e1">',
        '<div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">',
          '<i class="fas ' + icon + '" style="font-size:.75rem;color:rgba(255,255,255,0.35)"></i>',
          '<span style="font-size:.78rem;font-weight:700;color:rgba(255,255,255,0.7)">' + label + '</span>',
        '</div>',
        '<div style="font-size:.66rem;color:rgba(255,255,255,0.25);line-height:1.4">' + desc + '</div>',
      '</button>'
    ].join('');
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function _bindPanelEvents() {
    // Close button
    var closeBtn = _panel.querySelector('#sfp-close');
    if (closeBtn) closeBtn.addEventListener('click', window.closeStemsPanel);

    // Escape key
    document.addEventListener('keydown', _onKey);

    // Mode buttons
    _panel.querySelectorAll('.sfp-mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { _selectMode(btn.dataset.mode); });
    });

    // Play button
    var playBtn = _panel.querySelector('#sfp-play-btn');
    if (playBtn) playBtn.addEventListener('click', _togglePlay);

    // Timeline seek
    var tl = _panel.querySelector('#sfp-timeline');
    if (tl) tl.addEventListener('click', _onSeek);
  }

  function _onKey(e) {
    if (e.key === 'Escape' && _panel) window.closeStemsPanel();
  }

  // ── Mode selection ────────────────────────────────────────────────────────
  function _selectMode(mode) {
    if (!_panel) return;

    // Stop any in-progress poll / playback from previous mode
    _stopPoll();
    _stopAudio();
    _playing = false;
    _stems = [];
    _audios = [];
    _taskId = null;

    _mode = mode;

    // Highlight selected mode button
    _panel.querySelectorAll('.sfp-mode-btn').forEach(function (btn) {
      var active = btn.dataset.mode === mode;
      btn.style.background      = active ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.03)';
      btn.style.borderColor     = active ? 'rgba(99,102,241,0.5)'  : 'rgba(255,255,255,0.07)';
      btn.style.color           = active ? '#c7d2fe' : '#cbd5e1';
      var icon = btn.querySelector('i');
      if (icon) icon.style.color = active ? '#818cf8' : 'rgba(255,255,255,0.35)';
      var label = btn.querySelector('span');
      if (label) label.style.color = active ? '#c7d2fe' : 'rgba(255,255,255,0.7)';
    });

    // Hide stem + playbar areas
    var stemsEl  = _panel.querySelector('#sfp-stems');
    var playbar  = _panel.querySelector('#sfp-playbar');
    if (stemsEl)  { stemsEl.style.display  = 'none'; stemsEl.innerHTML = ''; }
    if (playbar)  playbar.style.display = 'none';

    // Show body with credits info + extract button
    _showModeBody(mode);
  }

  function _showModeBody(mode) {
    var isSplit = mode === 'split_from_mix';
    var cost    = isSplit ? 30 : 75;
    var stemsDesc = isSplit
      ? '<span style="color:rgba(255,255,255,.6)">Vocals</span> + <span style="color:rgba(255,255,255,.6)">Instrumental</span>'
      : '<span style="color:rgba(255,255,255,.6)">Vocals · Drums · Bass · Other · Instrumental</span>';

    _setBody([
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">',
        '<div>',
          '<div style="font-size:.78rem;color:rgba(255,255,255,0.45);line-height:1.55">' + stemsDesc + '</div>',
          '<div style="font-size:.66rem;color:rgba(255,255,255,0.22);margin-top:4px">',
            '<i class="fas fa-bolt" style="color:#fbbf24;margin-right:3px;font-size:.6rem"></i>' + cost + ' credits',
          '</div>',
        '</div>',
        '<button id="sfp-extract-btn" style="',
            'padding:9px 20px;border-radius:10px;border:none;cursor:pointer;',
            'background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;',
            'font-weight:700;font-size:.8rem;white-space:nowrap;',
            'box-shadow:0 4px 16px rgba(79,70,229,.35);',
            'transition:opacity .15s,transform .1s"',
          ' onmouseover="this.style.opacity=\'.85\'"',
          ' onmouseout="this.style.opacity=\'1\'"',
          ' onmousedown="this.style.transform=\'scale(.96)\'"',
          ' onmouseup="this.style.transform=\'scale(1)\'"',
          ' onmouseleave="this.style.transform=\'scale(1)\'"',
        '>',
          '<i class="fas fa-wand-magic-sparkles" style="margin-right:6px;font-size:.75rem"></i>Extract',
        '</button>',
      '</div>'
    ].join(''));

    var btn = _panel.querySelector('#sfp-extract-btn');
    if (btn) btn.addEventListener('click', function () { _startExtract(mode); });
  }

  // ── Extract → POST → poll ─────────────────────────────────────────────────
  function _startExtract(mode) {
    _showSpinner('Starting extraction…');

    fetch('/api/job/stems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: _jobId, mode: mode })
    })
    .then(_safeJson)
    .then(function (data) {
      if (data._httpErr) {
        var msg = data.error || 'Extraction failed';
        if (data.limit_reached) msg += ' — <a href="/pricing" style="color:#818cf8;text-decoration:none">Upgrade</a>';
        return _showError(msg);
      }
      if (data.status === 'ready' && data.stems && data.stems.length) {
        return _renderStems(data.stems);
      }
      _taskId = data.task_id;
      _pollForStems(mode);
    })
    .catch(function (err) {
      _showError('Network error: ' + (err.message || 'Unknown'));
    });
  }

  function _pollForStems(mode) {
    var dots = 0;
    var startMs = Date.now();
    var MAX_MS  = 5 * 60 * 1000;

    _pollTimer = setInterval(function () {
      if (!_panel) { _stopPoll(); return; }
      if (Date.now() - startMs > MAX_MS) {
        _stopPoll();
        _showError('Timed out after 5 minutes. Please try again.');
        return;
      }
      dots = (dots + 1) % 4;
      _showSpinner('Extracting stems' + '.'.repeat(dots + 1));

      var url = '/api/job/stems/' + _jobId + '?mode=' + encodeURIComponent(mode);
      if (_taskId) url += '&task_id=' + encodeURIComponent(_taskId);

      fetch(url)
        .then(_safeJson)
        .then(function (data) {
          if (data.status === 'ready' && data.stems && data.stems.length) {
            _stopPoll();
            _renderStems(data.stems);
          } else if (data.status === 'error') {
            _stopPoll();
            _showError(data.error || 'Extraction failed');
          }
          // status === 'processing' → keep polling
        })
        .catch(function () { /* transient — keep polling */ });
    }, 2500);
  }

  // ── Silent cache restore on open ─────────────────────────────────────────
  function _tryRestoreCache() {
    fetch('/api/job/stems/' + _jobId + '?mode=auto')
      .then(_safeJson)
      .then(function (data) {
        if (data.status === 'ready' && data.stems && data.stems.length) {
          // Auto-select 'auto' mode and render without charging
          _mode = 'auto';
          _panel.querySelectorAll('.sfp-mode-btn').forEach(function (btn) {
            var active = btn.dataset.mode === 'auto';
            btn.style.background  = active ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.03)';
            btn.style.borderColor = active ? 'rgba(99,102,241,0.5)'  : 'rgba(255,255,255,0.07)';
            var icon  = btn.querySelector('i');
            var label = btn.querySelector('span');
            if (icon)  icon.style.color  = active ? '#818cf8' : 'rgba(255,255,255,0.35)';
            if (label) label.style.color = active ? '#c7d2fe' : 'rgba(255,255,255,0.7)';
          });
          _renderStems(data.stems);
        }
      })
      .catch(function () { /* no cache — fine */ });
  }

  // ── Render stems ──────────────────────────────────────────────────────────
  function _renderStems(stems) {
    if (!_panel) return;
    _stopAudio();
    _playing = false;

    _stems = stems.map(function (s) {
      return { name: s.name, url: s.url, muted: false, solo: false, vol: 1.0 };
    });

    // Build audio objects
    _audios = _stems.map(function (s, i) {
      var a = new Audio();
      a.preload = 'auto';
      a.src = '/api/stem-audio/' + _jobId + '/' + encodeURIComponent(s.name);
      if (i === 0) {
        a.addEventListener('loadedmetadata', function () {
          var tot = _panel && _panel.querySelector('#sfp-time-tot');
          if (tot) tot.textContent = _fmtTime(a.duration);
        });
        a.addEventListener('ended', function () {
          _playing = false;
          _updatePlayIcon();
          _stopRaf();
          _audios.forEach(function (x) { try { x.currentTime = 0; } catch(e){} });
          _updateTimeline(0, a.duration);
        });
      }
      return a;
    });

    // Render stem rows
    var stemsEl = _panel.querySelector('#sfp-stems');
    if (stemsEl) {
      stemsEl.innerHTML = _stems.map(function (s, i) { return _buildStemRow(s, i); }).join('');
      stemsEl.style.display = 'flex';
      stemsEl.style.flexDirection = 'column';
    }

    // Show playback bar with download
    var playbar = _panel.querySelector('#sfp-playbar');
    if (playbar) playbar.style.display = 'flex';

    // Show download area
    var dlArea = _panel.querySelector('#sfp-dl-area');
    if (dlArea) dlArea.innerHTML = _buildDlBtn();

    // Update body to "ready" state
    _setBody([
      '<div style="display:flex;align-items:center;justify-content:space-between">',
        '<span style="font-size:.75rem;color:rgba(255,255,255,0.35)">',
          '<i class="fas fa-check-circle" style="color:#10b981;margin-right:5px"></i>',
          _stems.length + ' stem' + (_stems.length !== 1 ? 's' : '') + ' ready',
        '</span>',
        '<button id="sfp-reextract-btn" style="',
            'padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);',
            'background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.38);',
            'font-size:.7rem;cursor:pointer;transition:background .15s"',
          ' onmouseover="this.style.background=\'rgba(255,255,255,.09)\'"',
          ' onmouseout="this.style.background=\'rgba(255,255,255,.04)\'"',
        '>Re-extract</button>',
      '</div>'
    ].join(''));

    var reb = _panel.querySelector('#sfp-reextract-btn');
    if (reb) reb.addEventListener('click', function () { _selectMode(_mode); });
  }

  // ── Stem row HTML ─────────────────────────────────────────────────────────
  function _buildStemRow(s, i) {
    var color = COLORS[s.name] || COLORS._default;
    var icon  = ICONS[s.name]  || ICONS._default;
    var label = _capFirst(s.name);

    return [
      '<div class="sfp-stem-row" data-stem="' + i + '" style="',
          'display:flex;align-items:center;gap:12px;padding:10px 20px;',
          'border-bottom:1px solid rgba(255,255,255,0.04);transition:background .15s"',
        ' onmouseover="this.style.background=\'rgba(255,255,255,0.025)\'"',
        ' onmouseout="this.style.background=\'transparent\'">',

        // Colour accent bar
        '<div style="width:3px;height:32px;border-radius:2px;flex-shrink:0;background:' + color + ';opacity:0.8"></div>',

        // Icon
        '<div style="width:30px;height:30px;border-radius:8px;flex-shrink:0;',
            'background:' + color + '18;display:flex;align-items:center;justify-content:center">',
          '<i class="fas ' + icon + '" style="color:' + color + ';font-size:.72rem"></i>',
        '</div>',

        // Label
        '<div style="flex:1;min-width:0">',
          '<div style="font-size:.8rem;font-weight:700;color:#f1f5f9">' + _esc(label) + '</div>',
        '</div>',

        // Volume slider
        '<input type="range" min="0" max="1" step="0.01" value="1"',
          ' data-stem-vol="' + i + '"',
          ' style="width:72px;accent-color:' + color + ';cursor:pointer;flex-shrink:0"',
          ' title="Volume">',

        // Mute button
        '<button class="sfp-mute-btn" data-stem-mute="' + i + '"',
            ' title="Mute" style="',
            'width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,0.08);',
            'background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.45);',
            'cursor:pointer;font-size:.68rem;flex-shrink:0;transition:all .15s">',
          'M',
        '</button>',

        // Solo button
        '<button class="sfp-solo-btn" data-stem-solo="' + i + '"',
            ' title="Solo" style="',
            'width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,0.08);',
            'background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.45);',
            'cursor:pointer;font-size:.68rem;flex-shrink:0;transition:all .15s">',
          'S',
        '</button>',

        // Download stem button
        '<a href="/api/stem-audio/' + _jobId + '/' + encodeURIComponent(s.name) + '?dl=1"',
            ' download="' + _esc(label) + '_stem.wav"',
            ' title="Download ' + _esc(label) + '"',
            ' style="width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,0.08);',
              'background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.45);',
              'display:flex;align-items:center;justify-content:center;text-decoration:none;',
              'font-size:.68rem;flex-shrink:0;transition:all .15s"',
            ' onmouseover="this.style.background=\'rgba(255,255,255,.1)\';this.style.color=\'#fff\'"',
            ' onmouseout="this.style.background=\'rgba(255,255,255,.04)\';this.style.color=\'rgba(255,255,255,.45)\'"',
          '>',
          '<i class="fas fa-download"></i>',
        '</a>',

      '</div>'
    ].join('');
  }

  // ── Stem row interaction (delegate from stems container) ──────────────────
  function _bindStemEvents() {
    var stemsEl = _panel && _panel.querySelector('#sfp-stems');
    if (!stemsEl) return;

    stemsEl.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.dataset.stemVol) return;
      var i = parseInt(t.dataset.stemVol, 10);
      _stems[i].vol = parseFloat(t.value);
      if (_audios[i]) _audios[i].volume = _getEffectiveVol(i);
    });

    stemsEl.addEventListener('click', function (e) {
      var t = e.target.closest('[data-stem-mute]');
      var s = e.target.closest('[data-stem-solo]');
      if (t) {
        var i = parseInt(t.dataset.stemMute, 10);
        _stems[i].muted = !_stems[i].muted;
        t.style.background  = _stems[i].muted ? 'rgba(239,68,68,.25)' : 'rgba(255,255,255,.04)';
        t.style.borderColor = _stems[i].muted ? 'rgba(239,68,68,.5)'  : 'rgba(255,255,255,.08)';
        t.style.color       = _stems[i].muted ? '#ef4444' : 'rgba(255,255,255,.45)';
        _applyVolumes();
      } else if (s) {
        var i = parseInt(s.dataset.stemSolo, 10);
        _stems[i].solo = !_stems[i].solo;
        s.style.background  = _stems[i].solo ? 'rgba(250,204,21,.2)'  : 'rgba(255,255,255,.04)';
        s.style.borderColor = _stems[i].solo ? 'rgba(250,204,21,.5)'  : 'rgba(255,255,255,.08)';
        s.style.color       = _stems[i].solo ? '#facc15' : 'rgba(255,255,255,.45)';
        _applyVolumes();
      }
    });
  }

  function _getEffectiveVol(i) {
    var s = _stems[i];
    var anySolo = _stems.some(function (x) { return x.solo; });
    if (s.muted) return 0;
    if (anySolo && !s.solo) return 0;
    return s.vol;
  }

  function _applyVolumes() {
    _stems.forEach(function (s, i) {
      if (_audios[i]) _audios[i].volume = _getEffectiveVol(i);
    });
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  function _togglePlay() {
    if (!_audios.length) return;
    if (_playing) {
      _audios.forEach(function (a) { a.pause(); });
      _playing = false;
      _stopRaf();
    } else {
      var promises = _audios.map(function (a) { return a.play().catch(function(){}); });
      Promise.all(promises).then(function () {
        _playing = true;
        _startRaf();
      });
    }
    _updatePlayIcon();
  }

  function _updatePlayIcon() {
    var icon = _panel && _panel.querySelector('#sfp-play-icon');
    if (icon) {
      icon.className = _playing ? 'fas fa-pause' : 'fas fa-play';
    }
  }

  function _onSeek(e) {
    if (!_audios.length) return;
    var tl   = _panel.querySelector('#sfp-timeline');
    if (!tl) return;
    var rect = tl.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var dur  = _audios[0].duration || 0;
    var t    = pct * dur;
    _audios.forEach(function (a) { try { a.currentTime = t; } catch(e){} });
    _updateTimeline(t, dur);
    _rafSeekBurst();
  }

  function _updateTimeline(cur, dur) {
    if (!_panel) return;
    var pct  = dur > 0 ? (cur / dur) * 100 : 0;
    var fill = _panel.querySelector('#sfp-tl-fill');
    var thumb= _panel.querySelector('#sfp-tl-thumb');
    var tc   = _panel.querySelector('#sfp-time-cur');
    if (fill)  fill.style.width  = pct + '%';
    if (thumb) thumb.style.left  = pct + '%';
    if (tc)    tc.textContent    = _fmtTime(cur);
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────
  var _rafBurst = 0;

  function _startRaf() {
    if (_rafId) return;
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
    if (a && !isNaN(a.duration) && a.duration > 0) {
      _updateTimeline(a.currentTime, a.duration);
    }
    if (_playing) {
      _rafId = requestAnimationFrame(_rafTick);
    } else if (_rafBurst > 0) {
      _rafBurst--;
      _rafId = requestAnimationFrame(_rafTick);
    }
  }

  function _rafSeekBurst() {
    _rafBurst = 10;
    _startRaf();
  }

  // ── Download button ───────────────────────────────────────────────────────
  function _buildDlBtn() {
    if (_plan === 'free') {
      return '<a href="/pricing" style="display:flex;align-items:center;gap:5px;padding:5px 12px;' +
        'border-radius:7px;border:1px solid rgba(250,204,21,.2);background:rgba(250,204,21,.05);' +
        'color:rgba(250,204,21,.55);font-size:.7rem;text-decoration:none;white-space:nowrap">' +
        '<i class="fas fa-lock" style="font-size:.6rem"></i>Download</a>';
    }
    return '<button id="sfp-dl-mix-btn" style="display:flex;align-items:center;gap:5px;padding:5px 12px;' +
      'border-radius:7px;border:1px solid rgba(99,102,241,.3);background:rgba(99,102,241,.08);' +
      'color:#818cf8;font-size:.7rem;cursor:pointer;white-space:nowrap;transition:background .15s"' +
      ' onmouseover="this.style.background=\'rgba(99,102,241,.18)\'"' +
      ' onmouseout="this.style.background=\'rgba(99,102,241,.08)\'">' +
      '<i class="fas fa-download" style="font-size:.6rem"></i>Download</button>';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _setBody(html) {
    var el = _panel && _panel.querySelector('#sfp-body');
    if (el) el.innerHTML = html;
    // Re-bind stem events after any DOM rebuild
    _bindStemEvents();
    // Re-bind download mix button
    var dlBtn = _panel && _panel.querySelector('#sfp-dl-mix-btn');
    if (dlBtn) dlBtn.addEventListener('click', _downloadMix);
  }

  function _downloadMix() {
    var a = document.createElement('a');
    a.href = '/api/stem-mix/' + _jobId + '?fmt=wav';
    a.download = 'stems_mix.wav';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); }, 400);
  }

  function _showSpinner(text) {
    _setBody([
      '<div style="display:flex;align-items:center;gap:12px;padding:4px 0">',
        '<div style="width:18px;height:18px;border:2.5px solid rgba(99,102,241,0.2);',
            'border-top-color:#818cf8;border-radius:50%;',
            'animation:sfp-spin 0.8s linear infinite;flex-shrink:0"></div>',
        '<style>@keyframes sfp-spin{to{transform:rotate(360deg)}}</style>',
        '<span style="color:rgba(255,255,255,0.45);font-size:.78rem">' + _esc(text) + '</span>',
      '</div>'
    ].join(''));
  }

  function _showError(html) {
    var retryFn = _mode ? 'window.__sfpRetry()' : '';
    _setBody([
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 0">',
        '<i class="fas fa-triangle-exclamation" style="color:#f59e0b;font-size:.95rem;flex-shrink:0"></i>',
        '<span style="color:rgba(255,255,255,0.55);font-size:.77rem;flex:1">' + html + '</span>',
        retryFn ? '<button onclick="window.__sfpRetry()" style="flex-shrink:0;padding:5px 12px;' +
          'border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);' +
          'color:rgba(255,255,255,.5);font-size:.7rem;cursor:pointer">Retry</button>' : '',
      '</div>'
    ].join(''));
    window.__sfpRetry = function () { _selectMode(_mode); };
  }

  function _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function _stopAudio() {
    _audios.forEach(function (a) { try { a.pause(); } catch(e){} });
    _stopRaf();
  }

  function _cleanup() {
    _stopPoll();
    _stopAudio();
    _stems  = [];
    _audios = [];
    _mode   = null;
    _taskId = null;
    _playing= false;
    document.removeEventListener('keydown', _onKey);
  }

  function _safeJson(res) {
    return res.text().then(function (text) {
      try {
        var d = JSON.parse(text);
        if (!res.ok) d._httpErr = true;
        return d;
      } catch(e) {
        return { _httpErr: true, error: 'Server error ' + res.status };
      }
    });
  }

  function _fmtTime(s) {
    if (!isFinite(s) || isNaN(s)) return '0:00';
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function _esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _capFirst(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

})();
