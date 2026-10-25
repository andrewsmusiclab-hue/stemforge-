/* StemForge skin-ext.js v4
   Intercepts THREE.js script loading via document.head.appendChild patch.
   When three.min.js finishes loading we immediately hook Group.prototype.add
   BEFORE _sfRunCube() fires — so every cubeGroup.add(plane) call is captured.
   Also recolors hammer materials per skin.
*/
(function () {

  var BASE = '/static/skins/faces/';

  /* Per-skin face PNG paths + Three.js skin properties */
  var PHOTO_SKINS = {
    set_stemforge: {
      faces: { front: BASE+'stemforge_front.png', back: BASE+'stemforge_back.png', left: BASE+'stemforge_side.png', right: BASE+'stemforge_right.png', top: BASE+'stemforge_top.png', bot: BASE+'stemforge_back.png' },
      hammerHead: 0x2a3a4a, hammerEdge: 0x00e5ff, hammerGlow: '#00e5ff',
      leatherColor: 0x1a2a3a, ringColor: 0x00ccff,
      cubeBody: 0x070e1c, cubeEmissive: 0x001a33, emissiveInt: 0.12,
      edgeGlow: 0x00e5ff, edgeOpacity: 0.85,
      shellColor: 0x00aaff, shellOpacity: 0.05,
      fillLight: 0x00d2ff, fillInt: 2.0,
      rimLight: 0xff8c20, rimInt: 1.5,
      botLight: 0x0040ff, botInt: 0.8,
      waveformTiers: [
        {bg:'#001020',wc:'#00e5ff',wc2:'#0099cc',amp:52,density:160},
        {bg:'#001018',wc:'#00ccff',wc2:'#0077bb',amp:38,density:150},
        {bg:'#000e16',wc:'#00bbee',wc2:'#006699',amp:28,density:140},
        {bg:'#000c14',wc:'#00aadd',wc2:'#005588',amp:18,density:120}
      ]
    },
    set_inferno: {
      faces: { front: BASE+'inferno_front.png', back: BASE+'inferno_back.png', left: BASE+'inferno_side.png', right: BASE+'inferno_right.png', top: BASE+'inferno_top.png', bot: BASE+'inferno_back.png' },
      hammerHead: 0x1a0800, hammerEdge: 0xff3300, hammerGlow: '#ff4400',
      leatherColor: 0x3a1000, ringColor: 0xff4400,
      cubeBody: 0x0a0404, cubeEmissive: 0x1a0000, emissiveInt: 0.22,
      edgeGlow: 0xff2200, edgeOpacity: 0.90,
      shellColor: 0xff3300, shellOpacity: 0.06,
      fillLight: 0xcc1100, fillInt: 2.2,
      rimLight: 0xff6600, rimInt: 1.8,
      botLight: 0x660000, botInt: 1.2,
      waveformTiers: [
        {bg:'#1a0000',wc:'#ff4400',wc2:'#ff2200',amp:52,density:160},
        {bg:'#180000',wc:'#ff6600',wc2:'#ff3300',amp:38,density:150},
        {bg:'#100000',wc:'#cc2200',wc2:'#881100',amp:28,density:140},
        {bg:'#0e0000',wc:'#ff5500',wc2:'#cc3300',amp:18,density:120}
      ]
    },
    set_neon: {
      faces: { front: BASE+'neon_front.png', back: BASE+'neon_back.png', left: BASE+'neon_side.png', right: BASE+'neon_right.png', top: BASE+'neon_top.png', bot: BASE+'neon_back.png' },
      hammerHead: 0x002a2a, hammerEdge: 0x00ffff, hammerGlow: '#00ffff',
      leatherColor: 0x001a2a, ringColor: 0x00eeff,
      cubeBody: 0x020d18, cubeEmissive: 0x001a1a, emissiveInt: 0.20,
      edgeGlow: 0x00ffff, edgeOpacity: 0.95,
      shellColor: 0x00ffee, shellOpacity: 0.07,
      fillLight: 0x00eeff, fillInt: 2.4,
      rimLight: 0x0088ff, rimInt: 1.8,
      botLight: 0x00aaff, botInt: 1.0,
      waveformTiers: [
        {bg:'#001a1a',wc:'#00ffff',wc2:'#00eeff',amp:52,density:160},
        {bg:'#001218',wc:'#00ccff',wc2:'#0088ff',amp:38,density:150},
        {bg:'#001016',wc:'#00eedd',wc2:'#00bbcc',amp:28,density:140},
        {bg:'#000e14',wc:'#44ffff',wc2:'#00ddff',amp:18,density:120}
      ]
    },
    set_gold: {
      faces: { front: BASE+'gold_front.png', back: BASE+'gold_back.png', left: BASE+'gold_side.png', right: BASE+'gold_right.png', top: BASE+'gold_top.png', bot: BASE+'gold_back.png' },
      hammerHead: 0x3a2a00, hammerEdge: 0xffd700, hammerGlow: '#ffd700',
      leatherColor: 0x2a1800, ringColor: 0xffcc00,
      cubeBody: 0x1a1000, cubeEmissive: 0x1a0a00, emissiveInt: 0.15,
      edgeGlow: 0xffd700, edgeOpacity: 0.88,
      shellColor: 0xffcc00, shellOpacity: 0.06,
      fillLight: 0xffaa00, fillInt: 2.0,
      rimLight: 0xff8800, rimInt: 1.6,
      botLight: 0xcc7700, botInt: 1.0,
      waveformTiers: [
        {bg:'#1a0e00',wc:'#ffd700',wc2:'#ffaa00',amp:52,density:160},
        {bg:'#160c00',wc:'#ffcc00',wc2:'#ff9900',amp:38,density:150},
        {bg:'#120a00',wc:'#eebb00',wc2:'#cc8800',amp:28,density:140},
        {bg:'#0e0800',wc:'#ffdd44',wc2:'#ffaa00',amp:18,density:120}
      ]
    },
    set_diamond: {
      faces: { front: BASE+'diamond_front.png', back: BASE+'diamond_back.png', left: BASE+'diamond_side.png', right: BASE+'diamond_right.png', top: BASE+'diamond_top.png', bot: BASE+'diamond_back.png' },
      hammerHead: 0x2a0018, hammerEdge: 0xff0055, hammerGlow: '#ff0077',
      leatherColor: 0x1a0010, ringColor: 0xff0055,
      cubeBody: 0x1a0008, cubeEmissive: 0x1a0010, emissiveInt: 0.20,
      edgeGlow: 0xff0055, edgeOpacity: 0.92,
      shellColor: 0xff0055, shellOpacity: 0.07,
      fillLight: 0xcc0044, fillInt: 2.2,
      rimLight: 0xff0077, rimInt: 1.8,
      botLight: 0x880033, botInt: 1.0,
      waveformTiers: [
        {bg:'#1a0008',wc:'#ff0055',wc2:'#cc0033',amp:52,density:160},
        {bg:'#150006',wc:'#ff3366',wc2:'#dd0044',amp:38,density:150},
        {bg:'#100005',wc:'#ff0044',wc2:'#aa0033',amp:28,density:140},
        {bg:'#0c0004',wc:'#ff2255',wc2:'#cc0033',amp:18,density:120}
      ]
    }
  };

  /* Merge photo skins into _CUBE_SKINS on assignment */
  try {
    Object.defineProperty(window, '_CUBE_SKINS', {
      configurable: true,
      get: function () { return this.__sfCubeSkins__; },
      set: function (val) {
        if (val && typeof val === 'object') {
          Object.keys(PHOTO_SKINS).forEach(function (k) { val[k] = PHOTO_SKINS[k]; });
        }
        this.__sfCubeSkins__ = val;
      }
    });
  } catch (e) { /* ignore */ }

  /* face key from rotation.y — matches app.v2.70.js faceDefs exactly */
  function faceKeyFromRotY(ry) {
    if (Math.abs(ry) < 0.1) return 'front';
    if (Math.abs(Math.abs(ry) - Math.PI) < 0.1) return 'back';
    if (Math.abs(ry + Math.PI / 2) < 0.1) return 'right';
    if (Math.abs(ry - Math.PI / 2) < 0.1) return 'left';
    return null;
  }

  /* State for current patch session */
  var facePlanes = [];
  var capturedGroup = null;
  var hammerMeshes = [];
  var hookActive = false;
  var origGroupAdd = null;
  var origHeadAppend = null;
  var activePhotoSkin = null;
  var T = null;

  /* Install Group.prototype.add hook — captures face planes AND hammer meshes */
  function hookGroupAdd() {
    if (hookActive || !window.THREE || !window.THREE.Group) return;
    T = window.THREE;
    hookActive = true;
    origGroupAdd = T.Group.prototype.add;

    T.Group.prototype.add = function () {
      var result = origGroupAdd.apply(this, arguments);
      for (var i = 0; i < arguments.length; i++) {
        var obj = arguments[i];
        if (!obj || !obj.isMesh) continue;

        /* Face planes: PlaneGeometry + CanvasTexture */
        if (obj.geometry && obj.geometry.type === 'PlaneGeometry') {
          if (obj.material && obj.material.map && obj.material.map.isCanvasTexture) {
            facePlanes.push(obj);
            capturedGroup = this;
          }
        }

        /* Hammer body meshes: BoxGeometry or CylinderGeometry with chrome/leather/ring materials */
        if (obj.geometry) {
          var gtype = obj.geometry.type;
          if (gtype === 'BoxGeometry' || gtype === 'CylinderGeometry' || gtype === 'TubeGeometry') {
            hammerMeshes.push(obj);
          }
        }
      }
      return result;
    };
  }

  /* Restore Group.prototype.add to original */
  function unhookGroupAdd() {
    if (!hookActive || !origGroupAdd || !T || !T.Group) return;
    T.Group.prototype.add = origGroupAdd;
    origGroupAdd = null;
    hookActive = false;
  }

  /* Swap face plane CanvasTextures for PNG textures */
  function applyFaceTextures(skin) {
    if (!T || !T.TextureLoader) return;
    var loader = new T.TextureLoader();
    facePlanes.forEach(function (plane) {
      var key = faceKeyFromRotY(plane.rotation.y);
      if (!key) return;
      var url = skin.faces[key];
      if (!url) return;
      loader.load(url, function (tex) {
        tex.needsUpdate = true;
        var mat = plane.material;
        mat.map = tex;
        mat.emissiveMap = tex;
        mat.emissive = new T.Color(0xffffff);
        mat.emissiveIntensity = 1.6;
        mat.needsUpdate = true;
      });
    });
  }

  /* Add PNG top-face plane to cubeGroup */
  function applyTopFace(skin) {
    if (!T || !capturedGroup) return;
    var url = skin.faces['top'];
    if (!url) return;
    var SIZE = 1.2, RADIUS = 0.032;
    var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
    var loader = new T.TextureLoader();
    loader.load(url, function (tex) {
      tex.needsUpdate = true;
      var existing = capturedGroup.getObjectByName('_sfExtTopPlane');
      if (existing) {
        existing.material.map = tex;
        existing.material.emissiveMap = tex;
        existing.material.needsUpdate = true;
        return;
      }
      var mat = new T.MeshStandardMaterial({
        map: tex, emissiveMap: tex,
        emissive: new T.Color(0xffffff), emissiveIntensity: 1.6,
        roughness: 0.55, metalness: 0.0, side: T.DoubleSide
      });
      var mesh = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      mesh.name = '_sfExtTopPlane';
      mesh.position.set(0, FO, 0);
      mesh.rotation.x = -Math.PI / 2;
      capturedGroup.add(mesh);
    });
  }

  /* Recolor hammer meshes based on skin — head, leather, rings all get skin color */
  function applyHammerColors(skin) {
    if (!T || !hammerMeshes.length) return;
    /* Hammer meshes captured in order from app.v2.70.js:
       0 = head (BoxGeometry, chromeMat)
       1-4 = top/bottom chamfers (BoxGeometry, chamferMat)
       5-8 = side vertical chamfers (BoxGeometry, chamferMat)
       9-10 = groove notches (BoxGeometry, grooveMat)
       11 = left side panel (PlaneGeometry, engraveMat) — skip
       12 = right side panel (PlaneGeometry, engraveMat) — skip
       13 = handle collar (CylinderGeometry, chamferMat)
       14 = handle core (CylinderGeometry, leatherMat)
       15-34 = leather strips + rings (CylinderGeometry, leatherMat/ringMat alternating)
       35 = pommel (CylinderGeometry, pommelMat)
       36 = wrist strap (TubeGeometry, leatherMat)
    */
    hammerMeshes.forEach(function (mesh, i) {
      var mat = mesh.material;
      if (!mat || !mat.color) return;
      var gtype = mesh.geometry ? mesh.geometry.type : '';

      /* Head + chamfers: tint to skin hammerHead dark base with edge glow */
      if (gtype === 'BoxGeometry') {
        var col = new T.Color(skin.hammerHead);
        mat.color.set(col);
        mat.emissive = new T.Color(skin.hammerEdge);
        mat.emissiveIntensity = 0.35;
        mat.needsUpdate = true;
      }

      /* Cylinder: distinguish leather (darker, matte) from rings (bright, metal) */
      if (gtype === 'CylinderGeometry') {
        var origMetalness = mat.metalness !== undefined ? mat.metalness : 0;
        if (origMetalness >= 0.9) {
          /* Metal ring or collar or pommel */
          mat.color.set(new T.Color(skin.ringColor));
          mat.emissive = new T.Color(skin.hammerEdge);
          mat.emissiveIntensity = 0.25;
          mat.needsUpdate = true;
        } else {
          /* Leather handle */
          mat.color.set(new T.Color(skin.leatherColor));
          mat.emissive = new T.Color(skin.hammerEdge);
          mat.emissiveIntensity = 0.08;
          mat.needsUpdate = true;
        }
      }

      /* Strap tube */
      if (gtype === 'TubeGeometry') {
        mat.color.set(new T.Color(skin.leatherColor));
        mat.emissive = new T.Color(skin.hammerEdge);
        mat.emissiveIntensity = 0.08;
        mat.needsUpdate = true;
      }
    });
  }

  /* Intercept document.head.appendChild to detect when three.min.js finishes loading.
     This runs SYNCHRONOUSLY on the script's onload — before _sfRunCube() fires — so
     Group.prototype.add is hooked before any cubeGroup.add(plane) call. */
  function patchHeadAppend() {
    if (origHeadAppend) return;
    origHeadAppend = document.head.appendChild.bind(document.head);
    document.head.appendChild = function (el) {
      var result = origHeadAppend(el);
      if (el && el.tagName === 'SCRIPT' && el.src && el.src.indexOf('three.min.js') !== -1) {
        var origOnload = el.onload;
        el.onload = function () {
          /* THREE just loaded — hook Group.add immediately */
          hookGroupAdd();
          if (typeof origOnload === 'function') origOnload.apply(this, arguments);
        };
      }
      return result;
    };
  }

  /* Main patch: wrap _sfInitCube to reset state and inject the head.appendChild hook */
  function installPatch() {
    if (!window._sfInitCube || window._sfInitCube._sfExtPatched) return;
    var _orig = window._sfInitCube;

    window._sfInitCube = function (user) {
      var skinId = (user && user.active_cube_id) ? user.active_cube_id : 'cube_forge';
      activePhotoSkin = PHOTO_SKINS[skinId];

      /* Non-photo skin: pass through */
      if (!activePhotoSkin) {
        unhookGroupAdd();
        return _orig.call(this, user);
      }

      /* Reset capture state for fresh cube build */
      facePlanes = [];
      capturedGroup = null;
      hammerMeshes = [];

      /* Install head.appendChild intercept so we hook Group.add the instant THREE loads */
      patchHeadAppend();

      /* Call original — loads THREE dynamically, builds cube, calls cubeGroup.add() */
      _orig.call(this, user);

      /* After original fires, poll until face planes are captured then apply textures.
         This handles cases where THREE was already loaded (cached script, second equip). */
      var waited = 0;
      var applyIv = setInterval(function () {
        waited++;

        /* If THREE is available but hook not yet installed, install it now */
        if (window.THREE && !hookActive) hookGroupAdd();

        /* Once we have face planes captured, apply everything */
        if (facePlanes.length >= 4 && capturedGroup) {
          clearInterval(applyIv);
          unhookGroupAdd();
          applyFaceTextures(activePhotoSkin);
          applyTopFace(activePhotoSkin);
          /* Give hammer meshes 300ms extra to all be added */
          setTimeout(function () { applyHammerColors(activePhotoSkin); }, 300);
          return;
        }

        /* Timeout after 15 seconds */
        if (waited > 500) {
          clearInterval(applyIv);
          unhookGroupAdd();
        }
      }, 30);
    };

    window._sfInitCube._sfExtPatched = true;
  }

  /* Poll for _sfInitCube to be defined */
  var patchIv = setInterval(function () {
    if (window._sfInitCube && !window._sfInitCube._sfExtPatched) {
      installPatch();
      clearInterval(patchIv);
    }
  }, 50);

  /* Runtime skin-switch helper */
  window._sfReloadCube = function (newSkinId) {
    window._sfCubeActive = false;
    if (window._sfUser) {
      window._sfUser.active_cube_id = newSkinId;
      if (window._sfInitCube) {
        delete window._sfInitCube._sfExtPatched;
        installPatch();
        window._sfInitCube(window._sfUser);
      }
    }
  };

})();
