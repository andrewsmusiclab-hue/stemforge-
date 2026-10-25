/* StemForge skin-ext.js v6
   Each set_* skin has its OWN complete cube + hammer builder.
   Loaded BEFORE app.v2.70.js.
   Strategy: wrap _sfInitCube — for set_* skins, skip the original cube builder
   entirely and run our own builder after THREE.js loads dynamically.
*/
(function () {

  var BASE = '/static/skins/faces/';

  /* ── Merge photo skin configs into _CUBE_SKINS so skinId resolves ── */
  var PHOTO_SKIN_IDS = ['set_stemforge','set_inferno','set_neon','set_gold','set_diamond','set_stone'];
  var PHOTO_SKIN_CONFIGS = {
    set_stemforge: {
      cubeBody:0x070e1c,cubeEmissive:0x001a33,emissiveInt:0.12,
      edgeGlow:0x00e5ff,edgeOpacity:0.85,shellColor:0x00aaff,shellOpacity:0.05,
      fillLight:0x00d2ff,fillInt:2.0,rimLight:0xff8c20,rimInt:1.5,botLight:0x0040ff,botInt:0.8,
      waveformTiers:[
        {bg:'#001020',wc:'#00e5ff',wc2:'#0099cc',amp:52,density:160},
        {bg:'#001018',wc:'#00ccff',wc2:'#0077bb',amp:38,density:150},
        {bg:'#000e16',wc:'#00bbee',wc2:'#006699',amp:28,density:140},
        {bg:'#000c14',wc:'#00aadd',wc2:'#005588',amp:18,density:120}
      ]
    },
    set_inferno: {
      cubeBody:0x0a0404,cubeEmissive:0x1a0000,emissiveInt:0.22,
      edgeGlow:0xff2200,edgeOpacity:0.90,shellColor:0xff3300,shellOpacity:0.06,
      fillLight:0xcc1100,fillInt:2.2,rimLight:0xff6600,rimInt:1.8,botLight:0x660000,botInt:1.2,
      waveformTiers:[
        {bg:'#1a0000',wc:'#ff4400',wc2:'#ff2200',amp:52,density:160},
        {bg:'#180000',wc:'#ff6600',wc2:'#ff3300',amp:38,density:150},
        {bg:'#100000',wc:'#cc2200',wc2:'#881100',amp:28,density:140},
        {bg:'#0e0000',wc:'#ff5500',wc2:'#cc3300',amp:18,density:120}
      ]
    },
    set_neon: {
      cubeBody:0x020d18,cubeEmissive:0x001a1a,emissiveInt:0.20,
      edgeGlow:0x00ffff,edgeOpacity:0.95,shellColor:0x00ffee,shellOpacity:0.07,
      fillLight:0x00eeff,fillInt:2.4,rimLight:0x0088ff,rimInt:1.8,botLight:0x00aaff,botInt:1.0,
      waveformTiers:[
        {bg:'#001a1a',wc:'#00ffff',wc2:'#00eeff',amp:52,density:160},
        {bg:'#001218',wc:'#00ccff',wc2:'#0088ff',amp:38,density:150},
        {bg:'#001016',wc:'#00eedd',wc2:'#00bbcc',amp:28,density:140},
        {bg:'#000e14',wc:'#44ffff',wc2:'#00ddff',amp:18,density:120}
      ]
    },
    set_gold: {
      cubeBody:0x1a1000,cubeEmissive:0x1a0a00,emissiveInt:0.15,
      edgeGlow:0xffd700,edgeOpacity:0.88,shellColor:0xffcc00,shellOpacity:0.06,
      fillLight:0xffaa00,fillInt:2.0,rimLight:0xff8800,rimInt:1.6,botLight:0xcc7700,botInt:1.0,
      waveformTiers:[
        {bg:'#1a0e00',wc:'#ffd700',wc2:'#ffaa00',amp:52,density:160},
        {bg:'#160c00',wc:'#ffcc00',wc2:'#ff9900',amp:38,density:150},
        {bg:'#120a00',wc:'#eebb00',wc2:'#cc8800',amp:28,density:140},
        {bg:'#0e0800',wc:'#ffdd44',wc2:'#ffaa00',amp:18,density:120}
      ]
    },
    set_diamond: {
      cubeBody:0x1a0008,cubeEmissive:0x1a0010,emissiveInt:0.20,
      edgeGlow:0xff0055,edgeOpacity:0.92,shellColor:0xff0055,shellOpacity:0.07,
      fillLight:0xcc0044,fillInt:2.2,rimLight:0xff0077,rimInt:1.8,botLight:0x880033,botInt:1.0,
      waveformTiers:[
        {bg:'#1a0008',wc:'#ff0055',wc2:'#cc0033',amp:52,density:160},
        {bg:'#150006',wc:'#ff3366',wc2:'#dd0044',amp:38,density:150},
        {bg:'#100005',wc:'#ff0044',wc2:'#aa0033',amp:28,density:140},
        {bg:'#0c0004',wc:'#ff2255',wc2:'#cc0033',amp:18,density:120}
      ]
    },
    set_stone: {
      cubeBody:0x2a3a4a,cubeEmissive:0x001a33,emissiveInt:0.15,
      edgeGlow:0x4a9fff,edgeOpacity:0.85,shellColor:0x4a9fff,shellOpacity:0.05,
      fillLight:0x88aacc,fillInt:1.4,rimLight:0xffffff,rimInt:1.0,botLight:0x224466,botInt:0.6,
      waveformTiers:[
        {bg:'#1a2a3a',wc:'#4a9fff',wc2:'#2266aa',amp:52,density:160},
        {bg:'#162030',wc:'#3388ee',wc2:'#1a5599',amp:38,density:150},
        {bg:'#121a26',wc:'#2277dd',wc2:'#114488',amp:28,density:140},
        {bg:'#0e1620',wc:'#3399ff',wc2:'#1a4477',amp:18,density:120}
      ]
    }
  };

  try {
    Object.defineProperty(window, '_CUBE_SKINS', {
      configurable: true,
      get: function () { return this.__sfCubeSkins__; },
      set: function (val) {
        if (val && typeof val === 'object') {
          PHOTO_SKIN_IDS.forEach(function (k) {
            val[k] = PHOTO_SKIN_CONFIGS[k];
          });
        }
        this.__sfCubeSkins__ = val;
      }
    });
  } catch (e) {}

  /* ── Shared canvas waveform face builder (same logic as app.v2.70.js) ── */
  function makeWaveFace(SKIN, variant, isImpact) {
    var SZ = 512, c = document.createElement('canvas');
    c.width = c.height = SZ;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#060d1c'; ctx.fillRect(0, 0, SZ, SZ);
    var tiers = SKIN.waveformTiers;
    var tierH = Math.floor(SZ / 4), divH = 4, seed = variant * 7919 + 1234;
    tiers.forEach(function (td, ti) {
      var y0 = ti * tierH, y1 = y0 + tierH - divH, midY = (y0 + y1) / 2, halfH = (y1 - y0) / 2 - 4;
      var bg = ctx.createLinearGradient(0, y0, 0, y1);
      bg.addColorStop(0, td.bg); bg.addColorStop(0.5, '#0a1628'); bg.addColorStop(1, td.bg);
      ctx.fillStyle = bg; ctx.fillRect(0, y0, SZ, y1 - y0);
      if (ti === 0 && isImpact) {
        var ig = ctx.createRadialGradient(SZ * 0.6, y0, 0, SZ * 0.6, y0, SZ * 0.55);
        ig.addColorStop(0, 'rgba(255,180,60,0.45)'); ig.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = ig; ctx.fillRect(0, y0, SZ, y1 - y0);
      }
      var N = td.density || 150, barW = SZ / N, heights = [];
      function rng(i) { var x = Math.sin(seed + ti * 1000 + i * 17.3) * 43758.5453; return x - Math.floor(x); }
      for (var i = 0; i < N; i++) {
        var r1 = rng(i), r2 = rng(i + 500), r3 = rng(i + 1000);
        var env = Math.sin(i / N * Math.PI);
        var spike = r1 > 0.88 ? (0.7 + r2 * 0.3) : (r1 * 0.6 + r2 * 0.3);
        heights.push(Math.max(0.03, spike * env * 0.95 + r3 * 0.08));
      }
      var smoothH = heights.map(function (h, i) { return i === 0 ? h : (h * 0.7 + heights[i - 1] * 0.3); });
      ctx.save(); ctx.shadowColor = td.wc; ctx.shadowBlur = 10; ctx.globalAlpha = 0.35;
      for (var i = 0; i < N; i++) {
        var bh = smoothH[i] * halfH, bx = i * barW;
        ctx.fillStyle = td.wc;
        ctx.fillRect(bx, midY - bh - 1, Math.max(1, barW - 1), bh + 1);
        ctx.fillRect(bx, midY, Math.max(1, barW - 1), bh + 1);
      }
      ctx.restore();
      ctx.save(); ctx.shadowColor = td.wc; ctx.shadowBlur = 6; ctx.globalAlpha = 1.0;
      for (var i = 0; i < N; i++) {
        var bh = smoothH[i] * halfH, bx = i * barW;
        var gc = ctx.createLinearGradient(bx, midY - bh, bx, midY + bh);
        gc.addColorStop(0, td.wc2); gc.addColorStop(0.5, td.wc); gc.addColorStop(1, td.wc2);
        ctx.fillStyle = gc;
        ctx.fillRect(bx + 0.5, midY - bh, Math.max(0.8, barW - 1), bh);
        ctx.fillRect(bx + 0.5, midY, Math.max(0.8, barW - 1), bh);
      }
      ctx.restore();
      if (ti < 3) { ctx.fillStyle = 'rgba(0,0,0,0.9)'; ctx.fillRect(0, y1, SZ, divH); }
    });
    return c;
  }

  /* ── Shared PNG face loader ── */
  function loadFaceTex(T, url, cb) {
    var loader = new T.TextureLoader();
    loader.load(url, cb);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CUBE BUILDER FUNCTIONS — one per skin, completely independent
  ══════════════════════════════════════════════════════════════════════════ */

  /* ── buildInferno ── dark charcoal cube with lava cracks, Mjolnir dark iron + lava hammer */
  function buildInferno(T, scene, cubeGroup, envMap) {
    var SKIN = PHOTO_SKIN_CONFIGS.set_inferno;
    var SIZE = 1.2, RADIUS = 0.032;

    /* Cube body — dark charcoal/volcanic */
    var geo = new T.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, RADIUS);
    var cubeMat = new T.MeshPhysicalMaterial({
      metalness: 0.7, roughness: 0.55, color: new T.Color(0x1a0800),
      emissive: new T.Color(0x330800), emissiveIntensity: 0.4,
      envMap: envMap, envMapIntensity: 1.2
    });
    cubeGroup.add(new T.Mesh(geo, cubeMat));

    /* Edge glow — lava orange-red */
    cubeGroup.add(new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(SIZE, SIZE, SIZE)),
      new T.LineBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.9 })
    ));

    /* Shell bloom */
    cubeGroup.add(new T.Mesh(
      new T.RoundedBoxGeometry(SIZE + 0.18, SIZE + 0.18, SIZE + 0.18, 4, RADIUS + 0.04),
      new T.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.04, side: T.BackSide })
    ));

    /* Face planes with PNG textures */
    var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
    var faceDefs = [
      { pos: [0, 0, FO],  ry: 0,           url: BASE + 'inferno_front.png', fallbackVariant: 0, isImpact: true  },
      { pos: [0, 0, -FO], ry: Math.PI,     url: BASE + 'inferno_back.png',  fallbackVariant: 1, isImpact: false },
      { pos: [FO, 0, 0],  ry: -Math.PI/2,  url: BASE + 'inferno_right.png', fallbackVariant: 2, isImpact: false },
      { pos: [-FO, 0, 0], ry: Math.PI/2,   url: BASE + 'inferno_side.png',  fallbackVariant: 3, isImpact: false }
    ];
    faceDefs.forEach(function (fd) {
      var cvs = makeWaveFace(SKIN, fd.fallbackVariant, fd.isImpact);
      var tex = new T.CanvasTexture(cvs);
      tex.needsUpdate = true;
      var mat = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0xffffff), emissiveIntensity: 1.2, roughness: 0.55, metalness: 0.0, side: T.DoubleSide });
      var plane = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      plane.position.set(fd.pos[0], fd.pos[1], fd.pos[2]);
      plane.rotation.y = fd.ry;
      cubeGroup.add(plane);
      loadFaceTex(T, fd.url, function (pngTex) {
        pngTex.needsUpdate = true;
        mat.map = pngTex; mat.emissiveMap = pngTex; mat.emissiveIntensity = 1.5; mat.needsUpdate = true;
      });
    });

    /* Top face PNG */
    loadFaceTex(T, BASE + 'inferno_top.png', function (tex) {
      tex.needsUpdate = true;
      var m = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0xffffff), emissiveIntensity: 1.5, roughness: 0.55, metalness: 0.0, side: T.DoubleSide });
      var p = new T.Mesh(new T.PlaneGeometry(PS, PS), m);
      p.position.set(0, FO, 0); p.rotation.x = -Math.PI / 2;
      cubeGroup.add(p);
    });

    /* ── INFERNO HAMMER — dark iron Mjolnir with molten lava cracks ── */
    var hammerG = new T.Group();

    /* Head — dark charcoal iron */
    var ironMat = new T.MeshPhysicalMaterial({
      color: 0x1a0800, metalness: 0.85, roughness: 0.45,
      emissive: new T.Color(0xff2200), emissiveIntensity: 0.3,
      envMap: envMap, envMapIntensity: 1.5
    });
    /* Lava crack face — glowing orange */
    var lavaMat = new T.MeshStandardMaterial({
      color: 0xff3300, emissive: new T.Color(0xff4400), emissiveIntensity: 2.5,
      roughness: 0.9, metalness: 0.0
    });

    var HW = 0.50, HH = 0.28, HD = 0.22;
    /* Head body */
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW, HH, HD), ironMat));
    /* Chamfer strips */
    var chW = HW + 0.01, chT = 0.018, chD = 0.018;
    [[0, HH/2+chT/2, HD/2+chD/2],[0, HH/2+chT/2,-HD/2-chD/2],[0,-HH/2-chT/2, HD/2+chD/2],[0,-HH/2-chT/2,-HD/2-chD/2]].forEach(function(p){
      hammerG.add(new T.Mesh(new T.BoxGeometry(chW, chT, chD), ironMat));
      hammerG.children[hammerG.children.length-1].position.set(p[0],p[1],p[2]);
    });
    /* Lava crack glowing insets on front and rear face */
    [-0.04, 0.04].forEach(function (yo) {
      var crack = new T.Mesh(new T.BoxGeometry(HW + 0.002, 0.018, 0.008), lavaMat);
      crack.position.set(0, yo, HD / 2 + 0.001); hammerG.add(crack);
    });
    /* Glowing lava collar */
    var lavaColl = new T.Mesh(new T.CylinderGeometry(0.055, 0.05, 0.10, 20), lavaMat);
    lavaColl.position.set(0, HH/2 + 0.05, 0); hammerG.add(lavaColl);

    /* Handle — dark charcoal wood/leather */
    var HANG = 35 * Math.PI / 180;
    var hDir = new T.Vector3(Math.sin(HANG), Math.cos(HANG), 0);
    var handleLen = 1.05;
    var handleBase = new T.Vector3(0, HH/2 + 0.09, 0);
    var darkLeatherMat = new T.MeshPhysicalMaterial({ color: 0x2a1000, roughness: 0.88, metalness: 0.0 });
    var handle = new T.Mesh(new T.CylinderGeometry(0.036, 0.028, handleLen, 18), darkLeatherMat);
    handle.rotation.z = -HANG;
    handle.position.copy(handleBase.clone().add(hDir.clone().multiplyScalar(handleLen * 0.5)));
    hammerG.add(handle);
    /* Lava-glow rings along handle */
    for (var ri = 0; ri < 5; ri++) {
      var rp = handleBase.clone().add(hDir.clone().multiplyScalar(handleLen * (ri * 0.18 + 0.1)));
      var ring = new T.Mesh(new T.CylinderGeometry(0.042, 0.042, 0.018, 18), lavaMat);
      ring.rotation.z = -HANG; ring.position.copy(rp); hammerG.add(ring);
    }
    /* Pommel — glowing lava cap */
    var pomPos = handleBase.clone().add(hDir.clone().multiplyScalar(handleLen + 0.035));
    var pommel = new T.Mesh(new T.CylinderGeometry(0.038, 0.044, 0.055, 20), lavaMat);
    pommel.rotation.z = -HANG; pommel.position.copy(pomPos); hammerG.add(pommel);

    hammerG.position.set(0.04, SIZE/2 + HH/2 + 0.08, 0.02);
    hammerG.rotation.set(0.14, -0.28, -0.06);
    cubeGroup.add(hammerG);
  }

  /* ── buildNeon ── dark navy cube with cyan plasma, chrome + cyan plasma hammer ── */
  function buildNeon(T, scene, cubeGroup, envMap) {
    var SKIN = PHOTO_SKIN_CONFIGS.set_neon;
    var SIZE = 1.2, RADIUS = 0.032;

    var cubeMat = new T.MeshPhysicalMaterial({
      metalness: 0.8, roughness: 0.15, color: new T.Color(0x020d18),
      emissive: new T.Color(0x001a1a), emissiveIntensity: 0.25,
      envMap: envMap, envMapIntensity: 2.8
    });
    cubeGroup.add(new T.Mesh(new T.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, RADIUS), cubeMat));

    cubeGroup.add(new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(SIZE, SIZE, SIZE)),
      new T.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95 })
    ));
    cubeGroup.add(new T.Mesh(
      new T.RoundedBoxGeometry(SIZE + 0.18, SIZE + 0.18, SIZE + 0.18, 4, RADIUS + 0.04),
      new T.MeshBasicMaterial({ color: 0x00ffee, transparent: true, opacity: 0.06, side: T.BackSide })
    ));

    var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
    var faceDefs = [
      { pos: [0,0,FO],  ry: 0,          url: BASE+'neon_front.png', v:0, imp:true  },
      { pos: [0,0,-FO], ry: Math.PI,    url: BASE+'neon_back.png',  v:1, imp:false },
      { pos: [FO,0,0],  ry: -Math.PI/2, url: BASE+'neon_right.png', v:2, imp:false },
      { pos: [-FO,0,0], ry: Math.PI/2,  url: BASE+'neon_side.png',  v:3, imp:false }
    ];
    faceDefs.forEach(function (fd) {
      var cvs = makeWaveFace(SKIN, fd.v, fd.imp);
      var tex = new T.CanvasTexture(cvs); tex.needsUpdate = true;
      var mat = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0xffffff), emissiveIntensity: 1.2, roughness: 0.55, metalness: 0.0, side: T.DoubleSide });
      var plane = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      plane.position.set(fd.pos[0], fd.pos[1], fd.pos[2]); plane.rotation.y = fd.ry;
      cubeGroup.add(plane);
      loadFaceTex(T, fd.url, function (pngTex) {
        pngTex.needsUpdate = true; mat.map = pngTex; mat.emissiveMap = pngTex; mat.emissiveIntensity = 1.5; mat.needsUpdate = true;
      });
    });
    loadFaceTex(T, BASE+'neon_top.png', function (tex) {
      tex.needsUpdate = true;
      var m = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0xffffff), emissiveIntensity: 1.5, roughness: 0.55, metalness: 0.0, side: T.DoubleSide });
      var p = new T.Mesh(new T.PlaneGeometry(PS, PS), m); p.position.set(0, FO, 0); p.rotation.x = -Math.PI / 2; cubeGroup.add(p);
    });

    /* ── NEON HAMMER — chrome body + cyan plasma impact faces + dark rod handle ── */
    var hammerG = new T.Group();
    var chromeMat = new T.MeshPhysicalMaterial({
      color: 0x9ab8cc, metalness: 1.0, roughness: 0.04,
      clearcoat: 1.0, clearcoatRoughness: 0.02,
      envMap: envMap, envMapIntensity: 6.0
    });
    var plasmaMat = new T.MeshStandardMaterial({
      color: 0x00ffff, emissive: new T.Color(0x00ffff), emissiveIntensity: 3.0,
      roughness: 0.1, metalness: 0.0, transparent: true, opacity: 0.92
    });
    var darkRodMat = new T.MeshPhysicalMaterial({
      color: 0x101820, metalness: 0.95, roughness: 0.15,
      emissive: new T.Color(0x00ffff), emissiveIntensity: 0.12,
      envMap: envMap, envMapIntensity: 2.0
    });

    var HW = 0.50, HH = 0.28, HD = 0.22;
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW, HH, HD), chromeMat));
    /* Chamfers */
    var chT = 0.018, chD = 0.018;
    [[0,HH/2+chT/2,HD/2+chD/2],[0,HH/2+chT/2,-HD/2-chD/2],[0,-HH/2-chT/2,HD/2+chD/2],[0,-HH/2-chT/2,-HD/2-chD/2]].forEach(function(p){
      var m = new T.Mesh(new T.BoxGeometry(HW+0.01,chT,chD),chromeMat); m.position.set(p[0],p[1],p[2]); hammerG.add(m);
    });
    /* Plasma impact faces — front and rear glowing cyan */
    var frontFace = new T.Mesh(new T.PlaneGeometry(HW - 0.04, HH - 0.04), plasmaMat);
    frontFace.position.set(0, 0, HD / 2 + 0.002); hammerG.add(frontFace);
    var rearFace = new T.Mesh(new T.PlaneGeometry(HW - 0.04, HH - 0.04), plasmaMat);
    rearFace.position.set(0, 0, -HD / 2 - 0.002); rearFace.rotation.y = Math.PI; hammerG.add(rearFace);
    /* Cyan neon strip down the back of the handle socket */
    var stripMat = new T.MeshStandardMaterial({ color: 0x00ffff, emissive: new T.Color(0x00ffff), emissiveIntensity: 3.0, roughness: 0.0, metalness: 0.0 });
    var strip = new T.Mesh(new T.BoxGeometry(0.008, HH * 0.9, 0.005), stripMat);
    strip.position.set(-HW / 2 - 0.004, 0, 0); hammerG.add(strip);
    /* Collar */
    var neonColl = new T.Mesh(new T.CylinderGeometry(0.055, 0.05, 0.10, 20), chromeMat);
    neonColl.position.set(0, HH/2 + 0.05, 0);
    hammerG.add(neonColl);

    /* Dark metal handle — no leather, with cyan neon seam strip */
    var HANG = 35 * Math.PI / 180;
    var hDir = new T.Vector3(Math.sin(HANG), Math.cos(HANG), 0);
    var handleLen = 1.05;
    var handleBase = new T.Vector3(0, HH / 2 + 0.09, 0);
    var handle = new T.Mesh(new T.CylinderGeometry(0.036, 0.028, handleLen, 18), darkRodMat);
    handle.rotation.z = -HANG;
    handle.position.copy(handleBase.clone().add(hDir.clone().multiplyScalar(handleLen * 0.5)));
    hammerG.add(handle);
    /* Cyan neon rings */
    for (var ri = 0; ri < 4; ri++) {
      var rp = handleBase.clone().add(hDir.clone().multiplyScalar(handleLen * (ri * 0.22 + 0.08)));
      var ring = new T.Mesh(new T.CylinderGeometry(0.040, 0.040, 0.012, 18), plasmaMat);
      ring.rotation.z = -HANG; ring.position.copy(rp); hammerG.add(ring);
    }
    /* Pommel — dark with cyan face */
    var pomPos = handleBase.clone().add(hDir.clone().multiplyScalar(handleLen + 0.035));
    var neonPommel = new T.Mesh(new T.CylinderGeometry(0.038, 0.044, 0.055, 20), chromeMat);
    neonPommel.rotation.z = -HANG;
    neonPommel.position.copy(pomPos);
    hammerG.add(neonPommel);

    hammerG.position.set(0.04, SIZE/2 + HH/2 + 0.08, 0.02);
    hammerG.rotation.set(0.14, -0.28, -0.06);
    cubeGroup.add(hammerG);
  }

  /* ── buildGold ── dark cube with gold waveforms, solid polished gold Mjolnir ── */
  function buildGold(T, scene, cubeGroup, envMap) {
    var SKIN = PHOTO_SKIN_CONFIGS.set_gold;
    var SIZE = 1.2, RADIUS = 0.032;

    var cubeMat = new T.MeshPhysicalMaterial({
      metalness: 0.9, roughness: 0.12, color: new T.Color(0x1a1000),
      emissive: new T.Color(0x1a0a00), emissiveIntensity: 0.15,
      envMap: envMap, envMapIntensity: 2.2
    });
    cubeGroup.add(new T.Mesh(new T.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, RADIUS), cubeMat));
    cubeGroup.add(new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(SIZE, SIZE, SIZE)),
      new T.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.88 })
    ));
    cubeGroup.add(new T.Mesh(
      new T.RoundedBoxGeometry(SIZE+0.18,SIZE+0.18,SIZE+0.18,4,RADIUS+0.04),
      new T.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.04, side: T.BackSide })
    ));

    var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
    var faceDefs = [
      { pos:[0,0,FO],  ry:0,          url:BASE+'gold_front.png', v:0, imp:true  },
      { pos:[0,0,-FO], ry:Math.PI,    url:BASE+'gold_back.png',  v:1, imp:false },
      { pos:[FO,0,0],  ry:-Math.PI/2, url:BASE+'gold_right.png', v:2, imp:false },
      { pos:[-FO,0,0], ry:Math.PI/2,  url:BASE+'gold_side.png',  v:3, imp:false }
    ];
    faceDefs.forEach(function (fd) {
      var cvs = makeWaveFace(SKIN, fd.v, fd.imp);
      var tex = new T.CanvasTexture(cvs); tex.needsUpdate = true;
      var mat = new T.MeshStandardMaterial({ map:tex, emissiveMap:tex, emissive:new T.Color(0xffffff), emissiveIntensity:1.2, roughness:0.55, metalness:0.0, side:T.DoubleSide });
      var plane = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      plane.position.set(fd.pos[0],fd.pos[1],fd.pos[2]); plane.rotation.y = fd.ry; cubeGroup.add(plane);
      loadFaceTex(T, fd.url, function (pngTex) { pngTex.needsUpdate=true; mat.map=pngTex; mat.emissiveMap=pngTex; mat.emissiveIntensity=1.5; mat.needsUpdate=true; });
    });
    loadFaceTex(T, BASE+'gold_top.png', function (tex) {
      tex.needsUpdate=true;
      var m=new T.MeshStandardMaterial({map:tex,emissiveMap:tex,emissive:new T.Color(0xffffff),emissiveIntensity:1.5,roughness:0.55,metalness:0.0,side:T.DoubleSide});
      var p=new T.Mesh(new T.PlaneGeometry(PS,PS),m); p.position.set(0,FO,0); p.rotation.x=-Math.PI/2; cubeGroup.add(p);
    });

    /* ── GOLD HAMMER — solid polished gold Mjolnir, dark brown handle, gold collar+pommel ── */
    var hammerG = new T.Group();
    var goldMat = new T.MeshPhysicalMaterial({
      color: 0xffd700, metalness: 1.0, roughness: 0.05,
      clearcoat: 0.9, clearcoatRoughness: 0.03,
      emissive: new T.Color(0xcc8800), emissiveIntensity: 0.12,
      envMap: envMap, envMapIntensity: 8.0
    });
    var darkBrownMat = new T.MeshPhysicalMaterial({
      color: 0x3a1e00, roughness: 0.82, metalness: 0.0,
      clearcoat: 0.15, clearcoatRoughness: 0.6
    });

    var HW = 0.50, HH = 0.28, HD = 0.22;
    /* Fully gold head body */
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW, HH, HD), goldMat));
    /* Gold chamfers */
    var chT=0.018,chD=0.018,chW=HW+0.01;
    [[0,HH/2+chT/2,HD/2+chD/2],[0,HH/2+chT/2,-HD/2-chD/2],[0,-HH/2-chT/2,HD/2+chD/2],[0,-HH/2-chT/2,-HD/2-chD/2]].forEach(function(p){
      var m=new T.Mesh(new T.BoxGeometry(chW,chT,chD),goldMat); m.position.set(p[0],p[1],p[2]); hammerG.add(m);
    });
    [[HW/2+chD/2,0,HD/2+chD/2],[HW/2+chD/2,0,-HD/2-chD/2],[-HW/2-chD/2,0,HD/2+chD/2],[-HW/2-chD/2,0,-HD/2-chD/2]].forEach(function(p){
      var m=new T.Mesh(new T.BoxGeometry(chD,HH+0.01,chD),goldMat); m.position.set(p[0],p[1],p[2]); hammerG.add(m);
    });
    /* Gold collar */
    var coll=new T.Mesh(new T.CylinderGeometry(0.058,0.052,0.10,24),goldMat); coll.position.set(0,HH/2+0.05,0); hammerG.add(coll);

    /* Handle — dark brown, tapered */
    var HANG=35*Math.PI/180;
    var hDir=new T.Vector3(Math.sin(HANG),Math.cos(HANG),0);
    var handleLen=1.05;
    var handleBase=new T.Vector3(0,HH/2+0.09,0);
    var handle=new T.Mesh(new T.CylinderGeometry(0.036,0.028,handleLen,18),darkBrownMat);
    handle.rotation.z=-HANG; handle.position.copy(handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*0.5))); hammerG.add(handle);
    /* Gold ring accents on handle */
    [0.15,0.35,0.55,0.75].forEach(function(t){
      var rp=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*t));
      var ring=new T.Mesh(new T.CylinderGeometry(0.042,0.042,0.020,20),goldMat);
      ring.rotation.z=-HANG; ring.position.copy(rp); hammerG.add(ring);
    });
    /* Gold pommel — flared */
    var pomPos=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen+0.038));
    var pommel=new T.Mesh(new T.CylinderGeometry(0.042,0.050,0.060,24),goldMat);
    pommel.rotation.z=-HANG; pommel.position.copy(pomPos); hammerG.add(pommel);

    hammerG.position.set(0.04,SIZE/2+HH/2+0.08,0.02);
    hammerG.rotation.set(0.14,-0.28,-0.06);
    cubeGroup.add(hammerG);
  }

  /* ── buildDiamond ── dark smoky-magenta cube, crystal/ice translucent hammer ── */
  function buildDiamond(T, scene, cubeGroup, envMap) {
    var SKIN = PHOTO_SKIN_CONFIGS.set_diamond;
    var SIZE = 1.2, RADIUS = 0.032;

    /* Cube — dark smoky ruby/magenta */
    var cubeMat = new T.MeshPhysicalMaterial({
      metalness: 0.5, roughness: 0.08, color: new T.Color(0x1a0012),
      emissive: new T.Color(0x440022), emissiveIntensity: 0.35,
      envMap: envMap, envMapIntensity: 3.5,
      transparent: true, opacity: 0.92
    });
    cubeGroup.add(new T.Mesh(new T.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, RADIUS), cubeMat));
    cubeGroup.add(new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(SIZE, SIZE, SIZE)),
      new T.LineBasicMaterial({ color: 0xff0077, transparent: true, opacity: 0.95 })
    ));
    cubeGroup.add(new T.Mesh(
      new T.RoundedBoxGeometry(SIZE+0.18,SIZE+0.18,SIZE+0.18,4,RADIUS+0.04),
      new T.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.07, side: T.BackSide })
    ));

    var FO = SIZE/2+0.008, PS = SIZE-RADIUS*2;
    var faceDefs = [
      { pos:[0,0,FO],  ry:0,          url:BASE+'diamond_front.png', v:0, imp:true  },
      { pos:[0,0,-FO], ry:Math.PI,    url:BASE+'diamond_back.png',  v:1, imp:false },
      { pos:[FO,0,0],  ry:-Math.PI/2, url:BASE+'diamond_right.png', v:2, imp:false },
      { pos:[-FO,0,0], ry:Math.PI/2,  url:BASE+'diamond_side.png',  v:3, imp:false }
    ];
    faceDefs.forEach(function (fd) {
      var cvs = makeWaveFace(SKIN, fd.v, fd.imp);
      var tex = new T.CanvasTexture(cvs); tex.needsUpdate = true;
      var mat = new T.MeshStandardMaterial({ map:tex,emissiveMap:tex,emissive:new T.Color(0xffffff),emissiveIntensity:1.2,roughness:0.55,metalness:0.0,side:T.DoubleSide });
      var plane = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      plane.position.set(fd.pos[0],fd.pos[1],fd.pos[2]); plane.rotation.y=fd.ry; cubeGroup.add(plane);
      loadFaceTex(T, fd.url, function (pngTex) { pngTex.needsUpdate=true; mat.map=pngTex; mat.emissiveMap=pngTex; mat.emissiveIntensity=1.5; mat.needsUpdate=true; });
    });
    loadFaceTex(T, BASE+'diamond_top.png', function (tex) {
      tex.needsUpdate=true;
      var m=new T.MeshStandardMaterial({map:tex,emissiveMap:tex,emissive:new T.Color(0xffffff),emissiveIntensity:1.5,roughness:0.55,metalness:0.0,side:T.DoubleSide});
      var p=new T.Mesh(new T.PlaneGeometry(PS,PS),m); p.position.set(0,FO,0); p.rotation.x=-Math.PI/2; cubeGroup.add(p);
    });

    /* ── DIAMOND HAMMER — translucent crystal/ice head with pink magenta glow core ── */
    var hammerG = new T.Group();

    /* Crystal head — translucent clear with pink internal glow */
    var crystalMat = new T.MeshPhysicalMaterial({
      color: 0xffd0e8, metalness: 0.0, roughness: 0.0,
      transmission: 0.88, transparent: true, opacity: 0.72,
      ior: 2.4,
      emissive: new T.Color(0xff0077), emissiveIntensity: 0.6,
      envMap: envMap, envMapIntensity: 4.0,
      clearcoat: 1.0, clearcoatRoughness: 0.0
    });
    /* Inner magenta glow core */
    var glowCoreMat = new T.MeshStandardMaterial({
      color: 0xff0077, emissive: new T.Color(0xff0077), emissiveIntensity: 4.0,
      roughness: 0.0, metalness: 0.0, transparent: true, opacity: 0.7, side: T.BackSide
    });
    /* Dark metal for handle/collar */
    var darkMetalMat = new T.MeshPhysicalMaterial({
      color: 0x1a1a2a, metalness: 0.95, roughness: 0.15,
      emissive: new T.Color(0xff0077), emissiveIntensity: 0.15,
      envMap: envMap, envMapIntensity: 2.0
    });
    var leatherMat = new T.MeshPhysicalMaterial({ color: 0x2a1018, roughness: 0.82, metalness: 0.0 });
    var pinkRingMat = new T.MeshStandardMaterial({ color: 0xff0077, emissive: new T.Color(0xff0077), emissiveIntensity: 1.5, roughness: 0.1, metalness: 0.3 });

    var HW=0.50, HH=0.28, HD=0.22;
    /* Crystal outer shell */
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW,HH,HD), crystalMat));
    /* Inner glow core — slightly smaller */
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW*0.75,HH*0.75,HD*0.75), glowCoreMat));
    /* Facet chamfer slabs — angled crystal faces */
    var chT=0.022,chD=0.022,chW2=HW+0.012;
    [[0,HH/2+chT/2,HD/2+chD/2],[0,HH/2+chT/2,-HD/2-chD/2],[0,-HH/2-chT/2,HD/2+chD/2],[0,-HH/2-chT/2,-HD/2-chD/2]].forEach(function(p){
      var m=new T.Mesh(new T.BoxGeometry(chW2,chT,chD),crystalMat); m.position.set(p[0],p[1],p[2]); hammerG.add(m);
    });
    /* Pink glowing crystal collar */
    var coll=new T.Mesh(new T.CylinderGeometry(0.056,0.050,0.10,20),pinkRingMat); coll.position.set(0,HH/2+0.05,0); hammerG.add(coll);

    /* Handle — dark metal rod (not leather) */
    var HANG=35*Math.PI/180;
    var hDir=new T.Vector3(Math.sin(HANG),Math.cos(HANG),0);
    var handleLen=1.05;
    var handleBase=new T.Vector3(0,HH/2+0.09,0);
    var handle=new T.Mesh(new T.CylinderGeometry(0.034,0.026,handleLen,18),darkMetalMat);
    handle.rotation.z=-HANG; handle.position.copy(handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*0.5))); hammerG.add(handle);
    /* Brown leather grip in lower third */
    var gripLen=0.32;
    var gripPos=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*0.78));
    var grip=new T.Mesh(new T.CylinderGeometry(0.037,0.029,gripLen,18),leatherMat);
    grip.rotation.z=-HANG; grip.position.copy(gripPos); hammerG.add(grip);
    /* Pink crystal rings */
    [0.12,0.30,0.50,0.68].forEach(function(t){
      var rp=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*t));
      var ring=new T.Mesh(new T.CylinderGeometry(0.040,0.040,0.016,18),pinkRingMat);
      ring.rotation.z=-HANG; ring.position.copy(rp); hammerG.add(ring);
    });
    /* Pommel — dark metal */
    var pomPos=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen+0.036));
    var pommel=new T.Mesh(new T.CylinderGeometry(0.040,0.048,0.058,24),darkMetalMat);
    pommel.rotation.z=-HANG; pommel.position.copy(pomPos); hammerG.add(pommel);

    hammerG.position.set(0.04,SIZE/2+HH/2+0.08,0.02);
    hammerG.rotation.set(0.14,-0.28,-0.06);
    cubeGroup.add(hammerG);
  }

  /* ── buildStemForge ── original chrome+cyan cube with chrome Mjolnir (PNG faces) ── */
  function buildStemForge(T, scene, cubeGroup, envMap) {
    var SKIN = PHOTO_SKIN_CONFIGS.set_stemforge;
    var SIZE = 1.2, RADIUS = 0.032;

    var cubeMat = new T.MeshPhysicalMaterial({
      metalness: 0.9, roughness: 0.12, color: new T.Color(0x070e1c),
      emissive: new T.Color(0x001a33), emissiveIntensity: 0.12,
      envMap: envMap, envMapIntensity: 2.5
    });
    cubeGroup.add(new T.Mesh(new T.RoundedBoxGeometry(SIZE,SIZE,SIZE,4,RADIUS), cubeMat));
    cubeGroup.add(new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(SIZE,SIZE,SIZE)),
      new T.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.85 })
    ));
    cubeGroup.add(new T.Mesh(
      new T.RoundedBoxGeometry(SIZE+0.18,SIZE+0.18,SIZE+0.18,4,RADIUS+0.04),
      new T.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.04, side: T.BackSide })
    ));

    var FO=SIZE/2+0.008, PS=SIZE-RADIUS*2;
    var faceDefs=[
      {pos:[0,0,FO],  ry:0,          url:BASE+'stemforge_front.png', v:0, imp:true  },
      {pos:[0,0,-FO], ry:Math.PI,    url:BASE+'stemforge_back.png',  v:1, imp:false },
      {pos:[FO,0,0],  ry:-Math.PI/2, url:BASE+'stemforge_right.png', v:2, imp:false },
      {pos:[-FO,0,0], ry:Math.PI/2,  url:BASE+'stemforge_side.png',  v:3, imp:false }
    ];
    faceDefs.forEach(function (fd) {
      var cvs=makeWaveFace(SKIN,fd.v,fd.imp);
      var tex=new T.CanvasTexture(cvs); tex.needsUpdate=true;
      var mat=new T.MeshStandardMaterial({map:tex,emissiveMap:tex,emissive:new T.Color(0xffffff),emissiveIntensity:1.2,roughness:0.55,metalness:0.0,side:T.DoubleSide});
      var plane=new T.Mesh(new T.PlaneGeometry(PS,PS),mat);
      plane.position.set(fd.pos[0],fd.pos[1],fd.pos[2]); plane.rotation.y=fd.ry; cubeGroup.add(plane);
      loadFaceTex(T,fd.url,function(pngTex){pngTex.needsUpdate=true;mat.map=pngTex;mat.emissiveMap=pngTex;mat.emissiveIntensity=1.5;mat.needsUpdate=true;});
    });
    loadFaceTex(T,BASE+'stemforge_top.png',function(tex){
      tex.needsUpdate=true;
      var m=new T.MeshStandardMaterial({map:tex,emissiveMap:tex,emissive:new T.Color(0xffffff),emissiveIntensity:1.5,roughness:0.55,metalness:0.0,side:T.DoubleSide});
      var p=new T.Mesh(new T.PlaneGeometry(PS,PS),m); p.position.set(0,FO,0); p.rotation.x=-Math.PI/2; cubeGroup.add(p);
    });

    /* ── STEMFORGE HAMMER — chrome Mjolnir with cyan accent rings ── */
    var hammerG = new T.Group();
    var chromeMat = new T.MeshPhysicalMaterial({
      color: 0xd4e0ea, metalness: 1.0, roughness: 0.04,
      clearcoat: 1.0, clearcoatRoughness: 0.02,
      envMap: envMap, envMapIntensity: 6.0
    });
    var chamferMat = new T.MeshPhysicalMaterial({
      color: 0xa8bfc8, metalness: 1.0, roughness: 0.08,
      clearcoat: 0.9, envMap: envMap, envMapIntensity: 4.5
    });
    var cyanAccentMat = new T.MeshStandardMaterial({
      color: 0x00e5ff, emissive: new T.Color(0x00e5ff), emissiveIntensity: 1.5, roughness: 0.1, metalness: 0.2
    });
    var leatherMat = new T.MeshPhysicalMaterial({ color: 0x1a2a3a, roughness: 0.82, metalness: 0.0 });

    var HW=0.50,HH=0.28,HD=0.22;
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW,HH,HD),chromeMat));
    var chT=0.018,chD=0.018;
    [[0,HH/2+chT/2,HD/2+chD/2],[0,HH/2+chT/2,-HD/2-chD/2],[0,-HH/2-chT/2,HD/2+chD/2],[0,-HH/2-chT/2,-HD/2-chD/2]].forEach(function(p){
      var m=new T.Mesh(new T.BoxGeometry(HW+0.01,chT,chD),chamferMat); m.position.set(p[0],p[1],p[2]); hammerG.add(m);
    });
    /* Cyan groove insets */
    [-0.04,0.04].forEach(function(yo){
      var g=new T.Mesh(new T.BoxGeometry(HW+0.002,0.014,0.012),cyanAccentMat); g.position.set(0,yo,HD/2+0.001); hammerG.add(g);
    });
    var coll=new T.Mesh(new T.CylinderGeometry(0.055,0.050,0.10,20),chamferMat); coll.position.set(0,HH/2+0.05,0); hammerG.add(coll);

    var HANG=35*Math.PI/180;
    var hDir=new T.Vector3(Math.sin(HANG),Math.cos(HANG),0);
    var handleLen=1.05;
    var handleBase=new T.Vector3(0,HH/2+0.09,0);
    var handle=new T.Mesh(new T.CylinderGeometry(0.036,0.028,handleLen,18),leatherMat);
    handle.rotation.z=-HANG; handle.position.copy(handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*0.5))); hammerG.add(handle);
    for(var ri=0;ri<9;ri++){
      var rp=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen*(ri*0.09+0.05)));
      var isRing=(ri%2===1);
      var rm=isRing?cyanAccentMat:leatherMat;
      var mesh2=new T.Mesh(new T.CylinderGeometry(isRing?0.043:0.040,isRing?0.043:0.040,isRing?0.016:0.062,18),rm);
      mesh2.rotation.z=-HANG; mesh2.position.copy(rp); hammerG.add(mesh2);
    }
    var pomPos=handleBase.clone().add(hDir.clone().multiplyScalar(handleLen+0.035));
    var pommel=new T.Mesh(new T.CylinderGeometry(0.038,0.044,0.055,20),chromeMat);
    pommel.rotation.z=-HANG; pommel.position.copy(pomPos); hammerG.add(pommel);

    hammerG.position.set(0.04,SIZE/2+HH/2+0.08,0.02);
    hammerG.rotation.set(0.14,-0.28,-0.06);
    cubeGroup.add(hammerG);
  }

  /* ── buildStone ── procedural granite cube + iron Mjolnir with blue rune glow ── */
  /* Renders instantly; GLB (69MB) is too large to stream in-browser */
  function buildStone(T, scene, cubeGroup, envMap) {
    _buildStoneFallback(T, scene, cubeGroup, envMap);
  }

  /* Procedural stone fallback — granite cube + iron Mjolnir with blue rune glow */
  function _buildStoneFallback(T, scene, cubeGroup, envMap) {
    var SKIN = PHOTO_SKIN_CONFIGS.set_stone;
    var SIZE = 1.2, RADIUS = 0.028;

    /* Stone granite body — rough grey with subtle blue emissive */
    var stoneMat = new T.MeshPhysicalMaterial({
      color: new T.Color(0x3a4a58), metalness: 0.1, roughness: 0.85,
      emissive: new T.Color(0x001a33), emissiveIntensity: 0.15,
      envMap: envMap, envMapIntensity: 0.6
    });
    cubeGroup.add(new T.Mesh(new T.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, RADIUS), stoneMat));

    /* Blue rune edge glow */
    cubeGroup.add(new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(SIZE, SIZE, SIZE)),
      new T.LineBasicMaterial({ color: 0x4a9fff, transparent: true, opacity: 0.85 })
    ));

    /* Subtle blue shell bloom */
    cubeGroup.add(new T.Mesh(
      new T.RoundedBoxGeometry(SIZE + 0.18, SIZE + 0.18, SIZE + 0.18, 4, RADIUS + 0.04),
      new T.MeshBasicMaterial({ color: 0x4a9fff, transparent: true, opacity: 0.04, side: T.BackSide })
    ));

    /* Waveform faces using canvas */
    var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
    [0, 1, 2, 3].forEach(function (v) {
      var positions = [
        [0, 0, FO,  0],
        [0, 0, -FO, Math.PI],
        [FO, 0, 0,  -Math.PI / 2],
        [-FO, 0, 0,  Math.PI / 2]
      ];
      var pd = positions[v];
      var cvs = makeWaveFace(SKIN, v, v === 0);
      var tex = new T.CanvasTexture(cvs); tex.needsUpdate = true;
      var mat = new T.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new T.Color(0xffffff), emissiveIntensity: 1.0, roughness: 0.55, metalness: 0.0, side: T.DoubleSide });
      var plane = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      plane.position.set(pd[0], pd[1], pd[2]); plane.rotation.y = pd[3];
      cubeGroup.add(plane);
    });

    /* ── STONE HAMMER — dark iron Mjolnir with blue runic glow ── */
    var hammerG = new T.Group();
    var ironMat = new T.MeshPhysicalMaterial({
      color: 0x2a3540, metalness: 0.7, roughness: 0.6,
      emissive: new T.Color(0x001a33), emissiveIntensity: 0.2,
      envMap: envMap, envMapIntensity: 1.0
    });
    var runeMat = new T.MeshStandardMaterial({
      color: 0x4a9fff, emissive: new T.Color(0x4a9fff), emissiveIntensity: 2.5,
      roughness: 0.1, metalness: 0.0
    });
    var stonHandleMat = new T.MeshPhysicalMaterial({ color: 0x2a2a2a, roughness: 0.9, metalness: 0.0 });

    var HW = 0.50, HH = 0.28, HD = 0.22;
    hammerG.add(new T.Mesh(new T.BoxGeometry(HW, HH, HD), ironMat));
    /* Chamfers */
    var chT = 0.018, chD = 0.018, chW = HW + 0.01;
    [[0,HH/2+chT/2,HD/2+chD/2],[0,HH/2+chT/2,-HD/2-chD/2],[0,-HH/2-chT/2,HD/2+chD/2],[0,-HH/2-chT/2,-HD/2-chD/2]].forEach(function(p){
      var m = new T.Mesh(new T.BoxGeometry(chW, chT, chD), ironMat); m.position.set(p[0],p[1],p[2]); hammerG.add(m);
    });
    /* Blue runic insets */
    [-0.05, 0.05].forEach(function (yo) {
      var crack = new T.Mesh(new T.BoxGeometry(HW + 0.002, 0.016, 0.008), runeMat);
      crack.position.set(0, yo, HD / 2 + 0.001); hammerG.add(crack);
    });
    /* Blue rune collar */
    var coll = new T.Mesh(new T.CylinderGeometry(0.055, 0.050, 0.10, 20), runeMat);
    coll.position.set(0, HH/2 + 0.05, 0); hammerG.add(coll);

    /* Handle — dark stone/wrapped */
    var HANG = 35 * Math.PI / 180;
    var hDir = new T.Vector3(Math.sin(HANG), Math.cos(HANG), 0);
    var handleLen = 1.05;
    var handleBase = new T.Vector3(0, HH/2 + 0.09, 0);
    var handle = new T.Mesh(new T.CylinderGeometry(0.036, 0.028, handleLen, 18), stonHandleMat);
    handle.rotation.z = -HANG;
    handle.position.copy(handleBase.clone().add(hDir.clone().multiplyScalar(handleLen * 0.5)));
    hammerG.add(handle);
    /* Blue rune rings */
    for (var ri = 0; ri < 5; ri++) {
      var rp = handleBase.clone().add(hDir.clone().multiplyScalar(handleLen * (ri * 0.18 + 0.1)));
      var ring = new T.Mesh(new T.CylinderGeometry(0.042, 0.042, 0.016, 18), runeMat);
      ring.rotation.z = -HANG; ring.position.copy(rp); hammerG.add(ring);
    }
    /* Iron pommel */
    var pomPos = handleBase.clone().add(hDir.clone().multiplyScalar(handleLen + 0.035));
    var pommel = new T.Mesh(new T.CylinderGeometry(0.038, 0.044, 0.055, 20), ironMat);
    pommel.rotation.z = -HANG; pommel.position.copy(pomPos); hammerG.add(pommel);

    hammerG.position.set(0.04, SIZE/2 + HH/2 + 0.08, 0.02);
    hammerG.rotation.set(0.14, -0.28, -0.06);
    cubeGroup.add(hammerG);
  }

  /* ── Skin ID → builder map ── */
  var SKIN_BUILDERS = {
    set_inferno:   buildInferno,
    set_neon:      buildNeon,
    set_gold:      buildGold,
    set_diamond:   buildDiamond,
    set_stemforge: buildStemForge,
    set_stone:     buildStone
  };

  /* ══════════════════════════════════════════════════════════════════════════
     PATCH _sfInitCube
     For set_* skins: run our own complete cube builder instead of the original.
     For cube_* skins: pass through to original unchanged.
  ══════════════════════════════════════════════════════════════════════════ */
  function installPatch() {
    if (!window._sfInitCube || window._sfInitCube._sfExtPatched) return;
    var _orig = window._sfInitCube;

    window._sfInitCube = function (user) {
      var skinId = (user && user.active_cube_id) ? user.active_cube_id : 'cube_forge';
      var builder = SKIN_BUILDERS[skinId];

      /* Not a photo skin — use original unchanged */
      if (!builder) return _orig.call(this, user);

      /* Photo skin path:
         1. Check required DOM elements (same as original)
         2. Load THREE.js the same way original does
         3. Run OUR builder instead of _sfRunCube */
      var wrap   = document.getElementById('sf-cube-wrap');
      var canvas = document.getElementById('sf-cube-canvas');
      if (!wrap || !canvas) return;
      if (!user || !user.is_admin) { wrap.style.display = 'none'; return; }
      wrap.style.display = 'block';
      if (window._sfCubeActive) return;
      window._sfCubeActive = true;

      var BASE128 = 'https://cdn.jsdelivr.net/npm/three@0.128.0/';
      var scripts = [
        BASE128 + 'build/three.min.js',
        BASE128 + 'examples/js/geometries/RoundedBoxGeometry.js'
      ];

      function loadNext(i, done) {
        if (i >= scripts.length) { done(); return; }
        var s = document.createElement('script');
        s.src = scripts[i];
        s.onload = function () { loadNext(i + 1, done); };
        s.onerror = function () { loadNext(i + 1, done); };
        document.head.appendChild(s);
      }

      loadNext(0, function () {
        var T = window.THREE;
        if (!T) return;

        var stage = document.getElementById('sf-cube-stage');
        var W = (stage ? stage.clientWidth : wrap.clientWidth) || 420;
        var FIXED_H = window.innerWidth <= 768 ? 320 : 420;
        var H = FIXED_H;

        /* Renderer */
        var renderer;
        try {
          renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
          renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
          renderer.setSize(W, H, false);
          renderer.setClearColor(0x000000, 0);
          renderer.toneMapping = T.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.4;
          renderer.autoClear = false;
        } catch (e) { return; }

        /* Scene + Camera */
        var scene  = new T.Scene();
        var camera = new T.PerspectiveCamera(38, W / H, 0.1, 100);
        camera.position.set(0, 0.4, 5.8);

        /* IBL env */
        var envCvs = document.createElement('canvas'); envCvs.width=512; envCvs.height=256;
        var ec = envCvs.getContext('2d');
        ec.fillStyle='#000'; ec.fillRect(0,0,512,256);
        var kl=ec.createRadialGradient(400,25,0,400,25,200); kl.addColorStop(0,'rgba(255,255,255,0.9)'); kl.addColorStop(1,'rgba(0,0,0,0)'); ec.fillStyle=kl; ec.fillRect(0,0,512,256);
        var cl=ec.createRadialGradient(0,128,0,0,128,220); cl.addColorStop(0,'rgba(0,210,255,0.5)'); cl.addColorStop(1,'rgba(0,0,0,0)'); ec.fillStyle=cl; ec.fillRect(0,0,512,256);
        var rl=ec.createRadialGradient(256,256,0,256,256,220); rl.addColorStop(0,'rgba(255,120,20,0.4)'); rl.addColorStop(1,'rgba(0,0,0,0)'); ec.fillStyle=rl; ec.fillRect(0,0,512,256);
        var envTex=new T.CanvasTexture(envCvs); envTex.mapping=T.EquirectangularReflectionMapping;
        var pmrem=new T.PMREMGenerator(renderer); pmrem.compileEquirectangularShader();
        var envMap=pmrem.fromEquirectangular(envTex).texture;
        scene.environment=envMap;

        /* Lights */
        var SKIN = PHOTO_SKIN_CONFIGS[skinId];
        scene.add(new T.AmbientLight(0xffffff, 0.25));
        var dirLight = new T.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(4, 7, 5);
        scene.add(dirLight);
        var fill=new T.PointLight(SKIN.fillLight,SKIN.fillInt,30); fill.position.set(-4,3,4); scene.add(fill);
        var rim=new T.PointLight(SKIN.rimLight,SKIN.rimInt,22); rim.position.set(1,6,-4); scene.add(rim);
        var bot=new T.PointLight(SKIN.botLight,SKIN.botInt,14); bot.position.set(0,-5,3); scene.add(bot);

        /* Cube group */
        var cubeGroup = new T.Group();
        cubeGroup.position.y = -0.3;
        scene.add(cubeGroup);

        /* Call skin-specific builder — wrapped in try/catch so errors don't silently kill the cube */
        try {
          builder(T, scene, cubeGroup, envMap);
        } catch (builderErr) {
          console.error('[skin-ext] builder error:', builderErr);
          window._sfCubeActive = false;
          return;
        }

        /* Rotation animation loop */
        var clock = new T.Clock();
        function animate() {
          requestAnimationFrame(animate);
          var dt = clock.getDelta();
          cubeGroup.rotation.y += 0.004;
          renderer.clear();
          renderer.render(scene, camera);
        }
        animate();
      });
    };

    window._sfInitCube._sfExtPatched = true;
  }

  /* Poll for _sfInitCube */
  var patchIv = setInterval(function () {
    if (window._sfInitCube && !window._sfInitCube._sfExtPatched) {
      installPatch();
      clearInterval(patchIv);
    }
  }, 50);

  /* Runtime skin-switch */
  window._sfReloadCube = function (newSkinId) {
    window._sfCubeActive = false;
    /* Clear old canvas */
    var canvas = document.getElementById('sf-cube-canvas');
    if (canvas) { var ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); }
    if (window._sfUser) {
      window._sfUser.active_cube_id = newSkinId;
      if (window._sfInitCube) { delete window._sfInitCube._sfExtPatched; }
      installPatch();
      if (window._sfInitCube) window._sfInitCube(window._sfUser);
    }
  };

})();
