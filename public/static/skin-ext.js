/* StemForge skin-ext.js v3
   Loaded BEFORE app.v2.70.js.
   Strategy: patch _sfInitCube WRAPPER that intercepts THREE.js script loading,
   waits for Three to load, hooks Group.prototype.add to capture face planes
   as they are created, then swaps their textures with PNG images.
*/
(function () {

  var BASE = '/static/skins/faces/';

  var PHOTO_SKINS = {
    set_stemforge: {
      faces: { front: BASE+'stemforge_front.png', back: BASE+'stemforge_back.png', left: BASE+'stemforge_side.png', right: BASE+'stemforge_right.png', top: BASE+'stemforge_top.png', bot: BASE+'stemforge_back.png' },
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

  /* Merge photo skins into _CUBE_SKINS whenever it is set */
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

  /* face plane rotation Y values from app.v2.70.js faceDefs:
     front=0, back=PI, right=-PI/2, left=+PI/2  */
  function faceKeyFromRotY(ry) {
    if (Math.abs(ry) < 0.1) return 'front';
    if (Math.abs(Math.abs(ry) - Math.PI) < 0.1) return 'back';
    if (Math.abs(ry + Math.PI / 2) < 0.1) return 'right';
    if (Math.abs(ry - Math.PI / 2) < 0.1) return 'left';
    return null;
  }

  /* Apply PNG textures to a set of captured face plane meshes */
  function applyFaceTextures(facePlanes, photoSkin, T) {
    var loader = new T.TextureLoader();
    facePlanes.forEach(function (plane) {
      var faceKey = faceKeyFromRotY(plane.rotation.y);
      if (!faceKey) return;
      var url = photoSkin.faces[faceKey];
      if (!url) return;
      loader.load(url, function (tex) {
        tex.needsUpdate = true;
        var mat = plane.material;
        mat.map = tex;
        mat.emissiveMap = tex;
        mat.emissive = new T.Color(0xffffff);
        mat.emissiveIntensity = 1.4;
        mat.needsUpdate = true;
      });
    });
  }

  /* Add a top-face plane overlay to cubeGroup */
  function applyTopFace(cubeGroup, photoSkin, T) {
    var topUrl = photoSkin.faces['top'];
    if (!topUrl) return;
    var SIZE = 1.2, RADIUS = 0.032;
    var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
    var loader = new T.TextureLoader();
    loader.load(topUrl, function (tex) {
      tex.needsUpdate = true;
      var existing = cubeGroup.getObjectByName('_sfExtTopPlane');
      if (existing) {
        existing.material.map = tex;
        existing.material.emissiveMap = tex;
        existing.material.needsUpdate = true;
        return;
      }
      var mat = new T.MeshStandardMaterial({
        map: tex, emissiveMap: tex,
        emissive: new T.Color(0xffffff), emissiveIntensity: 1.4,
        roughness: 0.55, metalness: 0.0, side: T.DoubleSide
      });
      var mesh = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
      mesh.name = '_sfExtTopPlane';
      mesh.position.set(0, FO, 0);
      mesh.rotation.x = -Math.PI / 2;
      cubeGroup.add(mesh);
    });
  }

  /* Main patch installer — runs once _sfInitCube exists */
  function installPatch() {
    if (!window._sfInitCube || window._sfInitCube._sfExtPatched) return;
    var _orig = window._sfInitCube;

    window._sfInitCube = function (user) {
      var skinId = (user && user.active_cube_id) ? user.active_cube_id : 'cube_forge';
      var photoSkin = PHOTO_SKINS[skinId];

      /* Not a photo skin — pass through unchanged */
      if (!photoSkin) {
        return _orig.call(this, user);
      }

      /* Photo skin path:
         1. Call original — it dynamically loads THREE.js then builds the cube.
         2. After THREE loads (poll window.THREE), hook Group.prototype.add
            to intercept the face planes as cubeGroup.add(plane) is called.
         3. Once we have 4 face planes + cubeGroup, apply PNG textures.
      */
      var facePlanes = [];
      var capturedCubeGroup = null;
      var addHookInstalled = false;
      var origGroupAdd = null;
      var T = null;

      function hookGroupAdd() {
        if (addHookInstalled) return;
        T = window.THREE;
        if (!T || !T.Group) return;
        addHookInstalled = true;
        origGroupAdd = T.Group.prototype.add;

        T.Group.prototype.add = function () {
          var result = origGroupAdd.apply(this, arguments);
          /* Detect face planes: PlaneGeometry + CanvasTexture map */
          for (var ai = 0; ai < arguments.length; ai++) {
            var obj = arguments[ai];
            if (obj && obj.isMesh && obj.geometry && obj.geometry.type === 'PlaneGeometry') {
              if (obj.material && obj.material.map && obj.material.map.isCanvasTexture) {
                facePlanes.push(obj);
                capturedCubeGroup = this;
              }
            }
          }
          return result;
        };
      }

      /* Poll for THREE to appear (it's loaded dynamically inside _sfInitCube) */
      var pollCount = 0;
      var pollIv = setInterval(function () {
        pollCount++;
        if (pollCount > 200) { clearInterval(pollIv); restoreGroupAdd(); return; }
        if (window.THREE && window.THREE.Group && !addHookInstalled) {
          hookGroupAdd();
        }
        /* Once we have 4 face planes, apply textures and clean up */
        if (facePlanes.length >= 4 && capturedCubeGroup) {
          clearInterval(pollIv);
          restoreGroupAdd();
          applyFaceTextures(facePlanes, photoSkin, T);
          applyTopFace(capturedCubeGroup, photoSkin, T);
        }
      }, 30);

      function restoreGroupAdd() {
        if (origGroupAdd && T && T.Group) {
          T.Group.prototype.add = origGroupAdd;
          origGroupAdd = null;
        }
      }

      /* Call original — this triggers THREE.js loading and cube construction */
      _orig.call(this, user);
    };

    window._sfInitCube._sfExtPatched = true;
  }

  /* Poll for _sfInitCube to be defined, then patch it */
  var patchIv = setInterval(function () {
    if (window._sfInitCube && !window._sfInitCube._sfExtPatched) {
      installPatch();
      clearInterval(patchIv);
    }
  }, 50);

  /* Runtime skin reload helper */
  window._sfReloadCube = function (newSkinId) {
    window._sfCubeActive = false;
    window._sfCubeScene = null;
    if (window._sfUser) {
      window._sfUser.active_cube_id = newSkinId;
      /* Remove patched flag so it re-installs for new skin */
      if (window._sfInitCube) delete window._sfInitCube._sfExtPatched;
      installPatch();
      window._sfInitCube(window._sfUser);
    }
  };

})();
