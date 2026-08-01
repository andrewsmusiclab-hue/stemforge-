// stems.v4.js — DAW-style Mureka stem player (replaces stems.v3.js)
// Overrides window.openStemsPanel / closeStemsPanel from app.js.
// Two modes:
//   "AUTO SPLIT"        → audio-separation-1 (vocals, drums, bass, other + extras)
//   "VOCALS & INST."   → audio-separation-3 (vocals + instrumental)
// Waveform UI: Pro Tools–inspired multi-track lanes with per-track color, mute/solo/volume.
;(function () {
  'use strict';

  // ── Track colour palette (DAW / Pro Tools-style) ───────────────────────────
  var COLORS = {
    vocals:         { bg:'#0d1f35', wave:'#4fc3f7', border:'#29b6f6', label:'#7ed4fa' },
    vocal:          { bg:'#0d1f35', wave:'#4fc3f7', border:'#29b6f6', label:'#7ed4fa' }, // Mureka uses 'vocal'
    drums:          { bg:'#0d2010', wave:'#66bb6a', border:'#4caf50', label:'#91d994' },
    bass:           { bg:'#200d30', wave:'#ce93d8', border:'#ba68c8', label:'#dca8e8' },
    other:          { bg:'#251800', wave:'#ffb74d', border:'#ffa726', label:'#ffc870' },
    instrumental:   { bg:'#0d200d', wave:'#a5d6a7', border:'#81c784', label:'#bbdfbc' },
    synth:          { bg:'#1a0d25', wave:'#f48fb1', border:'#f06292', label:'#f8a8c8' },
    guitar:         { bg:'#1a1000', wave:'#ffcc80', border:'#ffa000', label:'#ffd9a0' },
    brass_and_winds:{ bg:'#001a1a', wave:'#80deea', border:'#26c6da', label:'#a0e8f0' },
    piano:          { bg:'#0d0d20', wave:'#b39ddb', border:'#9575cd', label:'#c8b4f0' },
    def:            { bg:'#0d0d25', wave:'#90caf9', border:'#64b5f6', label:'#a8d3fa' },
  };

  // Preferred display order (instrumental & song are filtered out — they are the full mix)
  var STEM_ORDER = ['vocals','vocal','drums','bass','other','synth','guitar','piano','brass_and_winds'];

  // Stems that are the full stereo mix — ALWAYS filter these out (not individual stems)
  var FULL_MIX_STEMS = ['song', 'instrumental', 'mix', 'full_mix', 'accompaniment'];

  var STEM_LABELS = {
    vocals:          'VOCALS',
    vocal:           'VOCALS',
    drums:           'DRUMS',
    bass:            'BASS',
    other:           'OTHER',
    synth:           'SYNTH',
    guitar:          'GUITAR',
    piano:           'PIANO',
    brass_and_winds: 'BRASS & WINDS',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  var _panel      = null;
  var _jobId      = null;
  var _mode       = 'auto';       // 'auto' | 'split_from_mix'
  var _taskId     = null;
  var _pollTimer  = null;
  var _pollSec    = 0;
  var _tracks     = [];           // [{name,url,muted,soloed,vol,gainNode,buffer,sourceNode,loaded}]
  var _audioCtx   = null;
  var _masterGain = null;
  var _playing    = false;
  var _playStart  = 0;            // audioCtx.currentTime at last play
  var _offset     = 0;            // playback offset in seconds
  var _duration   = 0;
  var _animFrame  = null;
  var _peakData   = {};           // name → Float32Array
  var _peakReady  = {};           // name → bool

  // ─────────────────────────────────────────────────────────────────────────
  //  PUBLIC API — overrides app.js openStemsPanel
  // ─────────────────────────────────────────────────────────────────────────
  window.openStemsPanel = function (jobId, stereoUrl, title) {
    _jobId = jobId;
    _mode  = 'auto';
    _taskId = null;

    // Remove any existing panel
    var old = document.getElementById('sf-stems-panel');
    if (old) old.remove();
    _cleanup();

    _injectStyles();
    _panel = document.createElement('div');
    _panel.id = 'sf-stems-panel';
    _panel.style.cssText = [
      'position:fixed;inset:0;z-index:99990',
      'display:flex;align-items:center;justify-content:center',
      'background:rgba(0,0,0,0.82)',
      'backdrop-filter:blur(10px)',
      '-webkit-backdrop-filter:blur(10px)',
      'padding:12px',
      'opacity:0',
      'transition:opacity .2s ease',
    ].join(';');

    _panel.innerHTML = _buildShell(title || 'Beat');
    document.body.appendChild(_panel);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { _panel.style.opacity = '1'; });
    });

    _bindShellEvents();
  };

  window.closeStemsPanel = function () {
    if (!_panel) return;
    _panel.style.opacity = '0';
    var p = _panel;
    setTimeout(function () { if (p && p.parentNode) p.parentNode.removeChild(p); }, 220);
    _panel = null;
    _cleanup();
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  SHELL HTML
  // ─────────────────────────────────────────────────────────────────────────
  function _buildShell (title) {
    return [
      '<div id="daw-card" style="',
        'background:#0a0c12;',
        'border:1px solid #1e2130;',
        'border-radius:12px;',
        'box-shadow:0 40px 120px rgba(0,0,0,.95);',
        'width:100%;max-width:820px;',
        'max-height:92vh;',
        'display:flex;flex-direction:column;',
        'overflow:hidden;',
        'font-family:Inter,system-ui,sans-serif;',
        'color:#e0e0e0;',
        'user-select:none;',
      '">',

        // ── Header ──────────────────────────────────────────────
        '<div style="',
          'background:linear-gradient(135deg,#12151e 0%,#0d0f16 100%);',
          'border-bottom:1px solid #1e2130;',
          'padding:12px 16px;',
          'display:flex;align-items:center;gap:10px;flex-shrink:0;',
        '">',
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="2" style="flex-shrink:0">',
            '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
          '</svg>',
          // Title — no MUREKA AI badge
          '<span style="font-weight:700;font-size:.9rem;letter-spacing:.5px;color:#fff">STEM STUDIO</span>',
          '<span style="color:#555;font-size:.75rem;font-weight:400;letter-spacing:0;flex:1">',
            '&nbsp;', _esc(title),
          '</span>',
          // Mode buttons
          '<div id="mode-btns" style="display:flex;gap:6px">',
            '<button class="daw-mode-btn" data-mode="auto" style="',
              'background:#0f2a3a;border:1px solid #29b6f6;color:#4fc3f7;',
              'padding:4px 11px;border-radius:5px;font-size:.7rem;font-weight:700;',
              'cursor:pointer;letter-spacing:.5px;white-space:nowrap;',
            '">AUTO SPLIT</button>',
            '<button class="daw-mode-btn" data-mode="split_from_mix" style="',
              'background:#141418;border:1px solid #2a2a35;color:#666;',
              'padding:4px 11px;border-radius:5px;font-size:.7rem;font-weight:700;',
              'cursor:pointer;letter-spacing:.5px;white-space:nowrap;',
            '">VOCALS & INST.</button>',
          '</div>',
          // Extract btn
          '<button id="daw-extract-btn" style="',
            'background:linear-gradient(135deg,#0e7490,#0284c7);',
            'color:#fff;border:none;padding:6px 16px;border-radius:6px;',
            'font-size:.75rem;font-weight:700;letter-spacing:.5px;',
            'cursor:pointer;white-space:nowrap;flex-shrink:0;',
          '">⚡ EXTRACT STEMS</button>',
          // Close button
          '<button onclick="closeStemsPanel()" style="',
            'background:none;border:1px solid #2a2a35;color:#666;',
            'width:28px;height:28px;border-radius:50%;',
            'cursor:pointer;font-size:1rem;line-height:1;flex-shrink:0;',
            'display:flex;align-items:center;justify-content:center;',
          '">×</button>',
        '</div>',

        // ── Timeline ruler (hidden until stems load) ──────────────
        '<div id="daw-ruler-wrap" style="',
          'background:#070910;border-bottom:1px solid #111318;',
          'height:22px;position:relative;overflow:hidden;display:none;flex-shrink:0;cursor:pointer;',
        '">',
          '<canvas id="daw-ruler" style="width:100%;height:22px;display:block"></canvas>',
          '<div id="daw-playhead" style="',
            'position:absolute;top:0;left:0;width:2px;height:100%;',
            'background:#f59e0b;pointer-events:none;z-index:5;',
            'box-shadow:0 0 6px rgba(245,158,11,.8);',
          '"></div>',
        '</div>',

        // ── Tracks area ───────────────────────────────────────────
        '<div id="daw-tracks" style="flex:1;overflow-y:auto;overflow-x:hidden;min-height:80px">',
          // Status / loading shown here
          '<div id="daw-status" style="',
            'padding:24px;text-align:center;color:#555;font-size:.82rem;',
            'display:flex;flex-direction:column;align-items:center;gap:12px;',
          '">',
            '<span>Choose a split mode, then click ⚡ EXTRACT STEMS</span>',
          '</div>',
        '</div>',

        // ── Transport bar (hidden until stems load) ──────────────
        '<div id="daw-transport" style="',
          'background:#070910;border-top:1px solid #111318;',
          'padding:8px 16px;display:none;flex-direction:column;gap:6px;flex-shrink:0;',
        '">',
          // Scrubber row
          '<div style="display:flex;align-items:center;gap:8px">',
            '<span style="font-size:.6rem;color:#444;font-family:monospace;min-width:40px;text-align:right" id="daw-tc-left">0:00</span>',
            '<input type="range" id="daw-scrubber" min="0" max="1000" value="0"',
              'style="flex:1;accent-color:#f59e0b;cursor:pointer;height:4px">',
            '<span style="font-size:.6rem;color:#444;font-family:monospace;min-width:40px" id="daw-tc-right">0:00</span>',
          '</div>',
          // Controls row
          '<div style="display:flex;align-items:center;gap:12px">',
            '<button id="daw-play-btn" style="',
              'width:34px;height:34px;border-radius:50%;',
              'background:linear-gradient(135deg,#166534,#15803d);',
              'border:none;cursor:pointer;',
              'display:flex;align-items:center;justify-content:center;flex-shrink:0;',
            '">',
              '<svg id="daw-play-icon" width="12" height="12" viewBox="0 0 24 24" fill="#fff">',
                '<polygon points="5,3 19,12 5,21"/>',
              '</svg>',
              '<svg id="daw-stop-icon" width="10" height="10" viewBox="0 0 24 24" fill="#fff" style="display:none">',
                '<rect x="4" y="4" width="16" height="16" rx="2"/>',
              '</svg>',
            '</button>',
            '<div id="daw-timecode" style="',
              'font-family:Courier New,monospace;font-size:.82rem;',
              'color:#f59e0b;letter-spacing:1px;font-weight:700;',
              'background:#070910;padding:4px 10px;border-radius:4px;',
              'border:1px solid #1f1200;min-width:75px;text-align:center;',
            '">0:00.0</div>',
            '<div style="display:flex;align-items:center;gap:6px;margin-left:auto">',
              '<span style="font-size:.65rem;color:#444;letter-spacing:.5px">MASTER</span>',
              '<input type="range" id="daw-master-vol" min="0" max="100" value="80"',
                'style="width:70px;accent-color:#4fc3f7;cursor:pointer">',
            '</div>',
            '<button id="daw-dl-all-btn" style="',
              'background:#111318;border:1px solid #1e2130;color:#666;',
              'padding:4px 10px;border-radius:5px;font-size:.7rem;cursor:pointer;',
            '">⬇ DL ALL</button>',
          '</div>',
        '</div>',
      '</div>',
    ].join('');
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  function _bindShellEvents () {
    // Mode buttons
    _panel.querySelectorAll('.daw-mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _mode = btn.dataset.mode;
        _panel.querySelectorAll('.daw-mode-btn').forEach(function (b) {
          var active = b.dataset.mode === _mode;
          b.style.background = active ? '#0f2a3a' : '#141418';
          b.style.borderColor = active ? '#29b6f6' : '#2a2a35';
          b.style.color       = active ? '#4fc3f7' : '#666';
        });
      });
    });

    // Extract
    var extractBtn = _panel.querySelector('#daw-extract-btn');
    if (extractBtn) extractBtn.addEventListener('click', _startExtraction);

    // Play/Stop
    var playBtn = _panel.querySelector('#daw-play-btn');
    if (playBtn) playBtn.addEventListener('click', _togglePlayback);

    // Master volume
    var masterVol = _panel.querySelector('#daw-master-vol');
    if (masterVol) masterVol.addEventListener('input', function (e) {
      if (_masterGain) _masterGain.gain.value = e.target.value / 100;
    });

    // Master scrubber
    var scrubber = _panel.querySelector('#daw-scrubber');
    if (scrubber) {
      scrubber.addEventListener('mousedown', function () {
        // Pause ticking while scrubbing but keep audio state
        if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
      });
      scrubber.addEventListener('input', function (e) {
        if (_duration <= 0) return;
        var frac = e.target.value / 1000;
        _offset = frac * _duration;
        _updateTC(_offset);
        _updateScrubber(frac);
        _redrawAll(Math.round(frac * _getTrackWidth()));
      });
      scrubber.addEventListener('change', function (e) {
        if (_duration <= 0) return;
        var frac = e.target.value / 1000;
        _offset = frac * _duration;
        if (_playing) { _stopAll(); _startPlay(); }
        else {
          _updateTC(_offset);
          _updateScrubber(frac);
          _redrawAll(Math.round(frac * _getTrackWidth()));
        }
      });
    }

    // Ruler click to seek
    var rulerWrap = _panel.querySelector('#daw-ruler-wrap');
    if (rulerWrap) rulerWrap.addEventListener('click', function (e) {
      if (_duration <= 0) return;
      var rect = rulerWrap.getBoundingClientRect();
      var frac = (e.clientX - rect.left) / rect.width;
      frac = Math.max(0, Math.min(1, frac));
      _offset = frac * _duration;
      if (_playing) { _stopAll(); _startPlay(); }
      else {
        _updateTC(_offset);
        _updateScrubber(frac);
        _redrawAll(Math.round(frac * _getTrackWidth()));
        var ph = _panel.querySelector('#daw-playhead');
        if (ph && rulerWrap) ph.style.left = (frac * rulerWrap.offsetWidth) + 'px';
      }
    });

    // DL All
    var dlAll = _panel.querySelector('#daw-dl-all-btn');
    if (dlAll) dlAll.addEventListener('click', _downloadAll);

    // Close on backdrop click
    _panel.addEventListener('click', function (e) {
      if (e.target === _panel) window.closeStemsPanel();
    });

    // Escape key
    document.addEventListener('keydown', _onKey);
  }

  function _onKey (e) {
    if (e.key === 'Escape' && _panel) window.closeStemsPanel();
    if (e.key === ' ' && _panel) { e.preventDefault(); _togglePlayback(); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  EXTRACTION
  // ─────────────────────────────────────────────────────────────────────────
  function _startExtraction () {
    if (!_jobId) return;
    _stopAll();
    _tracks = [];
    _peakData = {};
    _peakReady = {};
    _taskId = null;
    _duration = 0;
    _offset = 0;

    _setStatus('<div class="daw-spin"></div><span>Submitting to Mureka AI…</span>', true);
    _setExtractBtn('⏳ Submitting…', true);

    fetch('/api/job/stems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ job_id: _jobId, mode: _mode }),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        _setStatus('<span style="color:#f87171">❌ ' + _esc(data.error) + '</span>', false);
        _setExtractBtn('⚡ EXTRACT STEMS', false);
        return;
      }
      if (data.status === 'ready' || data.cached) {
        _renderTracks(data.stems || []);
        return;
      }
      _taskId = data.task_id;
      _pollSec = 0;
      _setStatus('<div class="daw-spin"></div><span>Mureka is separating your stems… (this takes 30–90 s)</span>', true);
      _startPolling();
    })
    .catch(function (err) {
      _setStatus('<span style="color:#f87171">❌ ' + _esc(err.message) + '</span>', false);
      _setExtractBtn('⚡ EXTRACT STEMS', false);
    });
  }

  function _startPolling () {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(function () {
      _pollSec += 3;
      _doPoll();
    }, 3000);
  }

  function _doPoll () {
    if (!_jobId || !_taskId) return;
    var url = '/api/job/stems/' + encodeURIComponent(_jobId) +
              '?mode=' + _mode +
              '&task_id=' + encodeURIComponent(_taskId);
    fetch(url, { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.status === 'ready') {
        clearInterval(_pollTimer); _pollTimer = null;
        _renderTracks(data.stems || []);
      } else if (data.status === 'error') {
        clearInterval(_pollTimer); _pollTimer = null;
        _setStatus('<span style="color:#f87171">❌ ' + _esc(data.error || 'Stem extraction failed') + '</span>', false);
        _setExtractBtn('⚡ RETRY', false);
      } else {
        var dots = '.'.repeat((_pollSec / 3 % 3) + 1);
        _setStatus('<div class="daw-spin"></div><span>Processing' + dots + ' (' + _pollSec + 's)</span>', true);
      }
    })
    .catch(function () {}); // ignore transient poll errors
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RENDER TRACKS
  // ─────────────────────────────────────────────────────────────────────────
  function _renderTracks (stems) {
    if (!_panel) return;
    _setExtractBtn('⚡ RE-EXTRACT', false);

    // Filter out full-mix stems (song, instrumental, etc.) — these are NOT individual stems
    var filtered = stems.filter(function (s) {
      return FULL_MIX_STEMS.indexOf(s.name.toLowerCase()) === -1;
    });

    // Sort stems by preferred order
    var ordered = filtered.slice().sort(function (a, b) {
      var ai = STEM_ORDER.indexOf(a.name), bi = STEM_ORDER.indexOf(b.name);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

    // Hide status
    var statusEl = _panel.querySelector('#daw-status');
    if (statusEl) statusEl.style.display = 'none';

    // Show ruler + transport
    var ruler = _panel.querySelector('#daw-ruler-wrap');
    if (ruler) ruler.style.display = 'block';
    var transport = _panel.querySelector('#daw-transport');
    if (transport) transport.style.display = 'flex';

    // Build track list
    _tracks = ordered.map(function (s) {
      return {
        name:       s.name,
        url:        '/api/stem-audio/' + encodeURIComponent(_jobId) + '/' + encodeURIComponent(s.name),
        muted:      false,
        soloed:     false,
        vol:        80,
        gainNode:   null,
        buffer:     null,
        sourceNode: null,
        loaded:     false,
      };
    });

    // Clear tracks area and render rows
    var tracksArea = _panel.querySelector('#daw-tracks');
    tracksArea.innerHTML = '';

    ordered.forEach(function (stem) {
      var col   = COLORS[stem.name] || COLORS.def;
      var label = STEM_LABELS[stem.name] || (stem.name.charAt(0).toUpperCase() + stem.name.slice(1));
      var row = document.createElement('div');
      row.className = 'daw-track-row';
      row.dataset.track = stem.name;
      row.style.cssText = [
        'display:flex;align-items:stretch;',
        'border-bottom:1px solid #0e1017;',
        'background:' + col.bg + ';',
        'min-height:72px;',
        'transition:background .1s;',
      ].join('');

      row.innerHTML = [
        // Left control panel
        '<div style="',
          'width:150px;min-width:150px;padding:8px 10px;',
          'background:rgba(0,0,0,.45);',
          'border-right:2px solid ' + col.border + ';',
          'display:flex;flex-direction:column;justify-content:space-between;gap:4px;',
        '">',
          // Track name + LED
          '<div style="display:flex;align-items:center;gap:6px">',
            '<div style="',
              'width:7px;height:7px;border-radius:50%;',
              'background:' + col.border + ';flex-shrink:0;',
              'box-shadow:0 0 5px ' + col.border + ';',
            '"></div>',
            '<span style="',
              'font-size:.72rem;font-weight:800;letter-spacing:.8px;',
              'color:#fff;text-transform:uppercase;',
            '">' + label + '</span>',
          '</div>',
          // M / S / vol row
          '<div style="display:flex;align-items:center;gap:5px">',
            '<button class="daw-m-btn" data-track="' + stem.name + '" title="Mute">M</button>',
            '<button class="daw-s-btn" data-track="' + stem.name + '" title="Solo">S</button>',
            '<input type="range" class="daw-v-sl" data-track="' + stem.name + '"',
              'min="0" max="100" value="80" style="flex:1;min-width:0;accent-color:' + col.border + ';cursor:pointer">',
          '</div>',
          // Download only (no dB readout)
          '<div style="display:flex;align-items:center;justify-content:flex-end">',
            '<button class="daw-dl-btn" data-track="' + stem.name + '"',
              'title="Download ' + label + '" style="',
              'background:none;border:1px solid #1e2130;color:#555;',
              'padding:2px 8px;border-radius:3px;font-size:.6rem;cursor:pointer;',
            '">⬇ DL</button>',
          '</div>',
        '</div>',

        // Waveform area
        '<div style="flex:1;position:relative;overflow:hidden;min-height:72px">',
          '<canvas class="daw-cv" data-track="' + stem.name + '"',
            'style="display:block;width:100%;height:72px"></canvas>',
          '<div class="daw-shimmer" data-track="' + stem.name + '" style="',
            'position:absolute;inset:0;',
            'background:linear-gradient(90deg,transparent 25%,rgba(255,255,255,.03) 50%,transparent 75%);',
            'background-size:200% 100%;animation:daw-shimmer 1.6s infinite;',
            'display:flex;align-items:center;justify-content:center;',
          '">',
            '<span style="font-size:.65rem;color:#333;letter-spacing:.5px">LOADING…</span>',
          '</div>',
        '</div>',
      ].join('');

      tracksArea.appendChild(row);
    });

    // Wire track-level controls
    tracksArea.querySelectorAll('.daw-m-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { _toggleMute(btn.dataset.track); });
    });
    tracksArea.querySelectorAll('.daw-s-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { _toggleSolo(btn.dataset.track); });
    });
    tracksArea.querySelectorAll('.daw-v-sl').forEach(function (sl) {
      sl.addEventListener('input', function (e) { _setVol(e.target.dataset.track, +e.target.value); });
    });
    tracksArea.querySelectorAll('.daw-dl-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { _dlStem(btn.dataset.track); });
    });
    tracksArea.querySelectorAll('.daw-cv').forEach(function (cv) {
      cv.addEventListener('click', function (e) { _seekFromCanvas(cv, e); });
    });

    // Init Web Audio + load stems
    _initAudio();
    _tracks.forEach(function (t) { _loadStem(t); });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  WEB AUDIO
  // ─────────────────────────────────────────────────────────────────────────
  function _initAudio () {
    if (_audioCtx) return;
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _masterGain = _audioCtx.createGain();
    _masterGain.gain.value = 0.8;
    _masterGain.connect(_audioCtx.destination);
  }

  function _loadStem (track) {
    fetch(track.url, { credentials: 'include' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then(function (buf) { return _audioCtx.decodeAudioData(buf); })
    .then(function (decoded) {
      track.buffer = decoded;
      track.loaded = true;
      if (decoded.duration > _duration) _duration = decoded.duration;

      track.gainNode = _audioCtx.createGain();
      track.gainNode.gain.value = track.vol / 100;
      track.gainNode.connect(_masterGain);

      _extractPeaks(track, decoded);

      if (_tracks.every(function (t) { return t.loaded; })) {
        _drawRuler();
        // Update scrubber end-time label
        var tc = _panel && _panel.querySelector('#daw-tc-right');
        if (tc) tc.textContent = _fmtTC(_duration);
      }
    })
    .catch(function (err) {
      console.warn('[StemV4] load error', track.name, err);
      _hideShimmer(track.name);
      _drawFallback(track.name);
    });
  }

  function _extractPeaks (track, buffer) {
    var cv = _panel && _panel.querySelector('.daw-cv[data-track="' + track.name + '"]');
    var W  = (cv && cv.offsetWidth) || 640;
    var ch = buffer.getChannelData(0);
    var spx = Math.max(1, Math.floor(ch.length / W));
    var peaks = new Float32Array(W);
    for (var i = 0; i < W; i++) {
      var max = 0;
      var start = i * spx;
      for (var j = 0; j < spx; j++) {
        var v = Math.abs(ch[start + j] || 0);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    _peakData[track.name] = peaks;
    _peakReady[track.name] = true;
    _drawWave(track.name, 0);
    _hideShimmer(track.name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DRAWING
  // ─────────────────────────────────────────────────────────────────────────
  function _drawWave (name, playPx) {
    if (!_panel) return;
    var cv = _panel.querySelector('.daw-cv[data-track="' + name + '"]');
    if (!cv) return;
    var W = cv.offsetWidth || 640;
    var H = cv.offsetHeight || 72;
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    var col    = COLORS[name] || COLORS.def;
    var peaks  = _peakData[name];
    var track  = _tracks.find(function (t) { return t.name === name; });
    var muted  = track ? track.muted : false;
    var soloed = track ? track.soloed : false;
    var hasSolo = _tracks.some(function (t) { return t.soloed; });
    // Track is effectively silenced if: muted, OR solo mode active and this track is not soloed
    var silenced = muted || (hasSolo && !soloed);

    // BG
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,.03)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx < W; gx += W / 16) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    if (!peaks) return;

    var mid = H / 2;
    var barW = Math.max(1, W / peaks.length);

    for (var i = 0; i < peaks.length; i++) {
      var amp = peaks[i] * mid * 0.92;
      var x = i * barW;
      var played = i < playPx;

      if (silenced) {
        ctx.fillStyle = 'rgba(60,60,60,.35)';
      } else if (played) {
        ctx.fillStyle = _hexRgba(col.wave, 1.0);
      } else {
        ctx.fillStyle = _hexRgba(col.wave, 0.65);
      }
      ctx.fillRect(x, mid - amp, barW - 0.5, amp * 2);
    }

    // Playhead line
    if (playPx > 0 && playPx < W) {
      ctx.fillStyle = 'rgba(245,158,11,.9)';
      ctx.fillRect(playPx - 1, 0, 2, H);
    }

    // Muted overlay — shown if track is explicitly muted OR silenced by solo
    if (muted) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 10px Inter,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('MUTED', W / 2, H / 2 + 4);
    } else if (hasSolo && !soloed) {
      // Silenced by solo — show dimmed state, no text (M button will be red)
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  function _drawFallback (name) {
    if (!_panel) return;
    var cv = _panel.querySelector('.daw-cv[data-track="' + name + '"]');
    if (!cv) return;
    var W = cv.offsetWidth || 640, H = cv.offsetHeight || 72;
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var col = COLORS[name] || COLORS.def;
    ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#555'; ctx.font = '11px Inter,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Audio unavailable', W / 2, H / 2 + 4);
  }

  function _hideShimmer (name) {
    if (!_panel) return;
    var sh = _panel.querySelector('.daw-shimmer[data-track="' + name + '"]');
    if (sh) sh.style.display = 'none';
  }

  function _drawRuler () {
    if (!_panel) return;
    var el = _panel.querySelector('#daw-ruler');
    if (!el) return;
    var W = (el.parentElement && el.parentElement.offsetWidth) || 640;
    var H = 22;
    el.width = W; el.height = H;
    var ctx = el.getContext('2d');
    ctx.fillStyle = '#070910'; ctx.fillRect(0, 0, W, H);
    if (_duration <= 0) return;
    var tickEvery = Math.ceil(_duration / (W / 60)); // ~60px between ticks
    for (var t = 0; t <= _duration; t += tickEvery) {
      var x = Math.round(t / _duration * W);
      var major = (t % (tickEvery * 4) < tickEvery);
      ctx.strokeStyle = major ? '#444' : '#2a2a35';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, major ? 4 : 12); ctx.stroke();
      if (major && t > 0) {
        var m = Math.floor(t / 60), s = Math.floor(t % 60);
        ctx.fillStyle = '#444';
        ctx.font = '9px monospace';
        ctx.fillText(m + ':' + (s < 10 ? '0' : '') + s, x + 2, 11);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PLAYBACK
  // ─────────────────────────────────────────────────────────────────────────
  function _togglePlayback () {
    if (_playing) _stopAll(); else _startPlay();
  }

  function _startPlay () {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    var ready = _tracks.filter(function (t) { return t.buffer && t.loaded; });
    if (!ready.length) return;

    _playing = true;
    _playStart = _audioCtx.currentTime - _offset;
    _setPlayIcon(true);

    ready.forEach(function (track) {
      var src = _audioCtx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(track.gainNode);
      src.start(0, _offset);
      track.sourceNode = src;
    });

    _animFrame = requestAnimationFrame(_tick);
  }

  function _stopAll () {
    if (_playing) {
      _offset = _audioCtx ? (_audioCtx.currentTime - _playStart) : 0;
      _tracks.forEach(function (t) {
        if (t.sourceNode) { try { t.sourceNode.stop(); } catch(e) {} t.sourceNode = null; }
      });
    }
    _playing = false;
    _setPlayIcon(false);
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
  }

  function _tick () {
    if (!_playing || !_panel) return;
    var elapsed = _audioCtx.currentTime - _playStart;
    if (elapsed >= _duration && _duration > 0) {
      _stopAll(); _offset = 0;
      _updateTC(0); _updateScrubber(0); _redrawAll(0);
      return;
    }
    _updateTC(elapsed);
    var frac = _duration > 0 ? elapsed / _duration : 0;
    _updateScrubber(frac);

    // Playhead bar on ruler
    var ph = _panel.querySelector('#daw-playhead');
    var rw = _panel.querySelector('#daw-ruler-wrap');
    if (ph && rw) ph.style.left = (frac * rw.offsetWidth) + 'px';

    // Per-track waveform redraw
    _tracks.forEach(function (t) {
      if (!_peakReady[t.name]) return;
      var cv = _panel.querySelector('.daw-cv[data-track="' + t.name + '"]');
      if (cv) _drawWave(t.name, Math.round(frac * cv.offsetWidth));
    });

    _animFrame = requestAnimationFrame(_tick);
  }

  function _seekFromCanvas (cv, e) {
    var rect = cv.getBoundingClientRect();
    var frac = (e.clientX - rect.left) / rect.width;
    _offset = frac * _duration;
    if (_playing) { _stopAll(); _startPlay(); }
    else {
      _updateTC(_offset);
      _updateScrubber(frac);
      var ph = _panel && _panel.querySelector('#daw-playhead');
      var rw = _panel && _panel.querySelector('#daw-ruler-wrap');
      if (ph && rw) ph.style.left = (frac * rw.offsetWidth) + 'px';
      _redrawAll(Math.round(frac * (cv.offsetWidth || 640)));
    }
  }

  function _redrawAll (px) {
    _tracks.forEach(function (t) {
      if (_peakReady[t.name]) _drawWave(t.name, px);
    });
  }

  function _setPlayIcon (playing) {
    if (!_panel) return;
    var pi = _panel.querySelector('#daw-play-icon');
    var si = _panel.querySelector('#daw-stop-icon');
    var pb = _panel.querySelector('#daw-play-btn');
    if (pi) pi.style.display = playing ? 'none' : 'block';
    if (si) si.style.display = playing ? 'block' : 'none';
    if (pb) pb.style.background = playing
      ? 'linear-gradient(135deg,#7f1d1d,#991b1b)'
      : 'linear-gradient(135deg,#166534,#15803d)';
  }

  function _updateTC (sec) {
    var el = _panel && _panel.querySelector('#daw-timecode');
    if (el) el.textContent = _fmtTC(sec);
    var left = _panel && _panel.querySelector('#daw-tc-left');
    if (left) left.textContent = _fmtTC(sec, true);
  }

  function _updateScrubber (frac) {
    var sc = _panel && _panel.querySelector('#daw-scrubber');
    if (sc) sc.value = Math.round(frac * 1000);
    var ph = _panel && _panel.querySelector('#daw-playhead');
    var rw = _panel && _panel.querySelector('#daw-ruler-wrap');
    if (ph && rw) ph.style.left = (frac * rw.offsetWidth) + 'px';
  }

  function _fmtTC (sec, short) {
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    if (short) return m + ':' + (s < 10 ? '0' : '') + s;
    var t = Math.floor((sec % 1) * 10);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + t;
  }

  function _getTrackWidth () {
    if (!_panel) return 640;
    var cv = _panel.querySelector('.daw-cv');
    return (cv && cv.offsetWidth) || 640;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  MUTE / SOLO / VOLUME
  // ─────────────────────────────────────────────────────────────────────────
  function _toggleMute (name) {
    var t = _tracks.find(function (x) { return x.name === name; });
    if (!t) return;
    t.muted = !t.muted;
    _applyGain(t);
    var btn = _panel && _panel.querySelector('.daw-m-btn[data-track="' + name + '"]');
    if (btn) {
      btn.style.background = t.muted ? '#dc2626' : '#0e1017';
      btn.style.borderColor = t.muted ? '#dc2626' : '#2a2a35';
      btn.style.color       = t.muted ? '#fff'    : '#666';
    }
    if (_peakReady[name]) _drawWave(name, _curPx(name));
  }

  function _toggleSolo (name) {
    var t = _tracks.find(function (x) { return x.name === name; });
    if (!t) return;
    t.soloed = !t.soloed;
    var hasSolo = _tracks.some(function (x) { return x.soloed; });

    _tracks.forEach(function (x) {
      _applyGain(x);

      // Solo button — amber when soloed
      var sBtn = _panel && _panel.querySelector('.daw-s-btn[data-track="' + x.name + '"]');
      if (sBtn) {
        sBtn.style.background = x.soloed ? '#d97706' : '#0e1017';
        sBtn.style.borderColor = x.soloed ? '#d97706' : '#2a2a35';
        sBtn.style.color       = x.soloed ? '#fff'    : '#666';
      }

      // Mute button — turns red when this track is silenced by solo (but not explicitly muted)
      var mBtn = _panel && _panel.querySelector('.daw-m-btn[data-track="' + x.name + '"]');
      if (mBtn) {
        var silencedBySolo = hasSolo && !x.soloed && !x.muted;
        if (x.muted) {
          // Explicitly muted — stays red
          mBtn.style.background = '#dc2626';
          mBtn.style.borderColor = '#dc2626';
          mBtn.style.color = '#fff';
        } else if (silencedBySolo) {
          // Silenced by solo — show red mute indicator
          mBtn.style.background = '#dc2626';
          mBtn.style.borderColor = '#dc2626';
          mBtn.style.color = '#fff';
        } else {
          // Active / normal
          mBtn.style.background = '#0e1017';
          mBtn.style.borderColor = '#2a2a35';
          mBtn.style.color = '#666';
        }
      }

      if (_peakReady[x.name]) _drawWave(x.name, _curPx(x.name));
    });
  }

  function _setVol (name, val) {
    var t = _tracks.find(function (x) { return x.name === name; });
    if (!t) return;
    t.vol = val;
    _applyGain(t);
  }

  function _applyGain (t) {
    if (!t.gainNode) return;
    var hasSolo = _tracks.some(function (x) { return x.soloed; });
    var on = !t.muted && (!hasSolo || t.soloed);
    t.gainNode.gain.value = on ? (t.vol / 100) : 0;
  }

  function _curPx (name) {
    if (!_playing || !_audioCtx || _duration <= 0) return 0;
    var frac = (_audioCtx.currentTime - _playStart) / _duration;
    var cv = _panel && _panel.querySelector('.daw-cv[data-track="' + name + '"]');
    return cv ? Math.round(frac * cv.offsetWidth) : 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DOWNLOAD
  // ─────────────────────────────────────────────────────────────────────────
  function _dlStem (name) {
    var a = document.createElement('a');
    a.href = '/api/stem-audio/' + encodeURIComponent(_jobId) + '/' + encodeURIComponent(name) + '?dl=1';
    a.download = name + '_stem.wav';
    a.click();
  }

  function _downloadAll () {
    _tracks.forEach(function (t, i) {
      setTimeout(function () { _dlStem(t.name); }, i * 350);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  STATUS + BUTTON HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  function _setStatus (html, showSpinner) {
    if (!_panel) return;
    var el = _panel.querySelector('#daw-status');
    if (!el) return;
    el.style.display = 'flex';
    el.innerHTML = html;
  }

  function _setExtractBtn (text, disabled) {
    if (!_panel) return;
    var btn = _panel.querySelector('#daw-extract-btn');
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = disabled;
    btn.style.opacity  = disabled ? '.55' : '1';
    btn.style.cursor   = disabled ? 'not-allowed' : 'pointer';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  CLEANUP
  // ─────────────────────────────────────────────────────────────────────────
  function _cleanup () {
    _stopAll();
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    document.removeEventListener('keydown', _onKey);
    _tracks = [];
    _peakData = {};
    _peakReady = {};
    _duration = 0;
    _offset = 0;
    _playing = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  UTILITIES
  // ─────────────────────────────────────────────────────────────────────────
  function _esc (s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function _hexRgba (hex, a) {
    var r = parseInt(hex.slice(1,3),16),
        g = parseInt(hex.slice(3,5),16),
        b = parseInt(hex.slice(5,7),16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  INJECT GLOBAL STYLES (once)
  // ─────────────────────────────────────────────────────────────────────────
  function _injectStyles () {
    if (document.getElementById('daw-v4-styles')) return;
    var s = document.createElement('style');
    s.id = 'daw-v4-styles';
    s.textContent = [
      '.daw-spin{width:16px;height:16px;border:2px solid #1e2130;border-top-color:#4fc3f7;',
        'border-radius:50%;animation:daw-s .65s linear infinite;flex-shrink:0}',
      '@keyframes daw-s{to{transform:rotate(360deg)}}',
      '@keyframes daw-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '#daw-tracks::-webkit-scrollbar{width:6px}',
      '#daw-tracks::-webkit-scrollbar-track{background:#0a0c12}',
      '#daw-tracks::-webkit-scrollbar-thumb{background:#1e2130;border-radius:3px}',
      '.daw-track-row:hover{filter:brightness(1.04)}',
      '.daw-m-btn,.daw-s-btn{',
        'font-size:.6rem;font-weight:800;padding:2px 6px;border-radius:3px;',
        'border:1px solid #2a2a35;background:#0e1017;color:#666;cursor:pointer;',
        'letter-spacing:.5px;transition:all .1s;flex-shrink:0',
      '}',
      '.daw-m-btn:hover{border-color:#dc2626;color:#dc2626}',
      '.daw-s-btn:hover{border-color:#d97706;color:#d97706}',
      '.daw-cv{cursor:pointer}',
      '.daw-cv:hover{opacity:.9}',
      '#daw-scrubber{',
        '-webkit-appearance:none;appearance:none;',
        'height:4px;border-radius:2px;',
        'background:linear-gradient(to right,#f59e0b 0%,#f59e0b 0%,#1e2130 0%);',
        'outline:none;cursor:pointer;',
      '}',
      '#daw-scrubber::-webkit-slider-thumb{',
        '-webkit-appearance:none;appearance:none;',
        'width:14px;height:14px;border-radius:50%;',
        'background:#f59e0b;cursor:pointer;',
        'box-shadow:0 0 4px rgba(245,158,11,.6);',
      '}',
      '#daw-scrubber::-moz-range-thumb{',
        'width:14px;height:14px;border-radius:50%;',
        'background:#f59e0b;cursor:pointer;border:none;',
      '}',
    ].join('');
    document.head.appendChild(s);

    // Update scrubber gradient on input (progress fill effect)
    document.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'daw-scrubber') {
        var pct = (e.target.value / 1000 * 100).toFixed(1);
        e.target.style.background = 'linear-gradient(to right,#f59e0b 0%,#f59e0b ' + pct + '%,#1e2130 ' + pct + '%)';
      }
    });
  }

})();
