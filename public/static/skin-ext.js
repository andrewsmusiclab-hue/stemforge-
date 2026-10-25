/* StemForge skin-ext.js v2 — photo-real PNG face textures for all skins
   Loaded BEFORE app.v2.70.js. Intercepts _CUBE_SKINS assignment and
   patches _sfInitCube to use THREE.TextureLoader PNG faces.
*/
(function () {

  var BASE = '/static/skins/faces/';

  /* Per-skin config: face PNG paths + Three.js material properties */
  var PHOTO_SKINS = {
    set_stemforge: {
      faces: {
        front: BASE + 'stemforge_front.png',
        back:  BASE + 'stemforge_back.png',
        left:  BASE + 'stemforge_side.png',
        right: BASE + 'stemforge_right.png',
        top:   BASE + 'stemforge_top.png',
        bot:   BASE + 'stemforge_back.png'
      },
      cubeBody:     0x070e1c, cubeEmissive: 0x001a33, emissiveInt: 0.12,
      edgeGlow:     0x00e5ff, edgeOpacity:  0.85,
      shellColor:   0x00aaff, shellOpacity: 0.05,
      fillLight:    0x00d2ff, fillInt: 2.0,
      rimLight:     0xff8c20, rimInt:  1.5,
      botLight:     0x0040ff, botInt:  0.8,
      waveformTiers:[
        {bg:'#1a0e00',wc:'#ffaa00',wc2:'#ff4400',amp:52,density:160},
        {bg:'#001a0e',wc:'#00ff88',wc2:'#00ffcc',amp:38,density:150},
        {bg:'#12001a',wc:'#dd00ff',wc2:'#8800ff',amp:28,density:140},
        {bg:'#001020',wc:'#00d4ff',wc2:'#0066ff',amp:18,density:120}
      ]
    },
    set_inferno: {
      faces: {
        front: BASE + 'inferno_front.png',
        back:  BASE + 'inferno_back.png',
        left:  BASE + 'inferno_side.png',
        right: BASE + 'inferno_right.png',
        top:   BASE + 'inferno_top.png',
        bot:   BASE + 'inferno_back.png'
      },
      cubeBody:     0x0a0404, cubeEmissive: 0x1a0000, emissiveInt: 0.22,
      edgeGlow:     0xff2200, edgeOpacity:  0.90,
      shellColor:   0xff3300, shellOpacity: 0.06,
      fillLight:    0xcc1100, fillInt: 2.2,
      rimLight:     0xff6600, rimInt:  1.8,
      botLight:     0x660000, botInt:  1.2,
      waveformTiers:[
        {bg:'#1a0000',wc:'#ff4400',wc2:'#ff2200',amp:52,density:160},
        {bg:'#180000',wc:'#ff6600',wc2:'#ff3300',amp:38,density:150},
        {bg:'#100000',wc:'#cc2200',wc2:'#881100',amp:28,density:140},
        {bg:'#0e0000',wc:'#ff5500',wc2:'#cc3300',amp:18,density:120}
      ]
    },
    set_neon: {
      faces: {
        front: BASE + 'neon_front.png',
        back:  BASE + 'neon_back.png',
        left:  BASE + 'neon_side.png',
        right: BASE + 'neon_right.png',
        top:   BASE + 'neon_top.png',
        bot:   BASE + 'neon_back.png'
      },
      cubeBody:     0x020d18, cubeEmissive: 0x001a1a, emissiveInt: 0.20,
      edgeGlow:     0x00ffff, edgeOpacity:  0.95,
      shellColor:   0x00ffee, shellOpacity: 0.07,
      fillLight:    0x00eeff, fillInt: 2.4,
      rimLight:     0x0088ff, rimInt:  1.8,
      botLight:     0x00aaff, botInt:  1.0,
      waveformTiers:[
        {bg:'#001a1a',wc:'#00ffff',wc2:'#00eeff',amp:52,density:160},
        {bg:'#001218',wc:'#00ccff',wc2:'#0088ff',amp:38,density:150},
        {bg:'#001016',wc:'#00eedd',wc2:'#00bbcc',amp:28,density:140},
        {bg:'#000e14',wc:'#44ffff',wc2:'#00ddff',amp:18,density:120}
      ]
    },
    set_gold: {
      faces: {
        front: BASE + 'gold_front.png',
        back:  BASE + 'gold_back.png',
        left:  BASE + 'gold_side.png',
        right: BASE + 'gold_right.png',
        top:   BASE + 'gold_top.png',
        bot:   BASE + 'gold_back.png'
      },
      cubeBody:     0x1a1000, cubeEmissive: 0x1a0a00, emissiveInt: 0.15,
      edgeGlow:     0xffd700, edgeOpacity:  0.88,
      shellColor:   0xffcc00, shellOpacity: 0.06,
      fillLight:    0xffaa00, fillInt: 2.0,
      rimLight:     0xff8800, rimInt:  1.6,
      botLight:     0xcc7700, botInt:  1.0,
      waveformTiers:[
        {bg:'#1a0e00',wc:'#ffd700',wc2:'#ffaa00',amp:52,density:160},
        {bg:'#160c00',wc:'#ffcc00',wc2:'#ff9900',amp:38,density:150},
        {bg:'#120a00',wc:'#eebb00',wc2:'#cc8800',amp:28,density:140},
        {bg:'#0e0800',wc:'#ffdd44',wc2:'#ffaa00',amp:18,density:120}
      ]
    },
    set_diamond: {
      faces: {
        front: BASE + 'diamond_front.png',
        back:  BASE + 'diamond_back.png',
        left:  BASE + 'diamond_side.png',
        right: BASE + 'diamond_right.png',
        top:   BASE + 'diamond_top.png',
        bot:   BASE + 'diamond_back.png'
      },
      cubeBody:     0x1a0008, cubeEmissive: 0x1a0010, emissiveInt: 0.20,
      edgeGlow:     0xff0055, edgeOpacity:  0.92,
      shellColor:   0xff0055, shellOpacity: 0.07,
      fillLight:    0xcc0044, fillInt: 2.2,
      rimLight:     0xff0077, rimInt:  1.8,
      botLight:     0x880033, botInt:  1.0,
      waveformTiers:[
        {bg:'#1a0008',wc:'#ff0055',wc2:'#cc0033',amp:52,density:160},
        {bg:'#150006',wc:'#ff3366',wc2:'#dd0044',amp:38,density:150},
        {bg:'#100005',wc:'#ff0044',wc2:'#aa0033',amp:28,density:140},
        {bg:'#0c0004',wc:'#ff2255',wc2:'#cc0033',amp:18,density:120}
      ]
    }
  };

  /* Intercept window._CUBE_SKINS = {...} assignment from app.v2.70.js
     and merge our photo-real skins in at that moment */
  try {
    Object.defineProperty(window, '_CUBE_SKINS', {
      configurable: true,
      get: function () { return this.__sfCubeSkins__; },
      set: function (val) {
        if (val && typeof val === 'object') {
          Object.keys(PHOTO_SKINS).forEach(function (k) {
            val[k] = PHOTO_SKINS[k];
          });
        }
        this.__sfCubeSkins__ = val;
      }
    });
  } catch (e) {
    window.addEventListener('load', function () {
      if (window._CUBE_SKINS) {
        Object.keys(PHOTO_SKINS).forEach(function (k) {
          window._CUBE_SKINS[k] = PHOTO_SKINS[k];
        });
      }
    });
  }

  /* Patch _sfInitCube — called after app.v2.70.js defines it.
     For photo-real skins: after Three.js builds the cube using SKIN colors/lights,
     we load the PNG face textures via TextureLoader and replace the
     face plane materials. The cube geometry and lighting remain unchanged. */
  function installPatch() {
    if (!window._sfInitCube || window._sfInitCube._sfExtPatched) return;
    var _orig = window._sfInitCube;

    window._sfInitCube = function (user) {
      var skinId = (user && user.active_cube_id) ? user.active_cube_id : 'set_stemforge';
      var photoSkin = PHOTO_SKINS[skinId];

      /* For non-photo skins fall straight through */
      if (!photoSkin || !photoSkin.faces) {
        return _orig.call(this, user);
      }

      /* Call original — this builds the cube with correct colors/lights */
      _orig.call(this, user);

      /* After THREE loads and cube is built, swap face plane textures */
      var maxWait = 80; /* 80 * 250ms = 20s max */
      var waited = 0;
      var iv = setInterval(function () {
        waited++;
        if (waited > maxWait) { clearInterval(iv); return; }

        var T = window.THREE;
        if (!T || !T.TextureLoader) return;

        /* Find the cubeGroup by scanning the scene */
        /* The original code adds cubeGroup to scene; face planes are
           MeshStandardMaterial children with a map property */
        var scene = window._sfCubeScene;
        if (!scene) return;
        clearInterval(iv);

        var loader = new T.TextureLoader();
        loader.crossOrigin = '';

        /* face plane order in app.v2.70.js:
           [0] front  translateZ(+)   rotY=0
           [1] back   translateZ(-)   rotY=PI
           [2] right  translateX(+)   rotY=-PI/2
           [3] left   translateX(-)   rotY=+PI/2       */
        var faceOrder = ['front', 'back', 'right', 'left'];

        scene.traverse(function (obj) {
          if (!obj.isMesh) return;
          if (!obj.material || !obj.material.map) return;
          /* Face planes have a CanvasTexture as map */
          if (!(obj.material.map && obj.material.map.isCanvasTexture)) return;

          /* Determine which face this plane is by its Y rotation */
          var ry = obj.rotation.y;
          var faceKey = 'front';
          if (Math.abs(ry - Math.PI) < 0.1 || Math.abs(ry + Math.PI) < 0.1) faceKey = 'back';
          else if (Math.abs(ry + Math.PI / 2) < 0.1) faceKey = 'right';
          else if (Math.abs(ry - Math.PI / 2) < 0.1) faceKey = 'left';

          var url = photoSkin.faces[faceKey];
          if (!url) return;

          loader.load(url, function (tex) {
            tex.needsUpdate = true;
            obj.material.map = tex;
            obj.material.emissiveMap = tex;
            obj.material.emissive = new T.Color(0xffffff);
            obj.material.emissiveIntensity = 1.1;
            obj.material.needsUpdate = true;
          });
        });

        /* Also load top face — it's not a face plane in the original,
           so we need a different approach: find the cube mesh's top and
           add a plane overlay for it */
        var topUrl = photoSkin.faces['top'];
        if (topUrl) {
          loader.load(topUrl, function (tex) {
            tex.needsUpdate = true;
            /* Find the cubeGroup and add a top-face plane overlay */
            scene.traverse(function (grp) {
              if (!grp.isGroup) return;
              /* Check if this is the cubeGroup by looking for the cube mesh */
              var hasCube = false;
              grp.children.forEach(function (ch) {
                if (ch.isMesh && ch.geometry && ch.geometry.type === 'RoundedBoxGeometry') hasCube = true;
              });
              if (!hasCube) return;

              var SIZE = 1.2, RADIUS = 0.032;
              var FO = SIZE / 2 + 0.008, PS = SIZE - RADIUS * 2;
              var topPlane = grp.getObjectByName('_sfExtTopPlane');
              if (!topPlane) {
                var mat = new T.MeshStandardMaterial({
                  map: tex, emissiveMap: tex,
                  emissive: new T.Color(0xffffff),
                  emissiveIntensity: 1.1,
                  roughness: 0.55, metalness: 0.0,
                  side: T.DoubleSide
                });
                topPlane = new T.Mesh(new T.PlaneGeometry(PS, PS), mat);
                topPlane.name = '_sfExtTopPlane';
                topPlane.position.set(0, FO, 0);
                topPlane.rotation.x = -Math.PI / 2;
                grp.add(topPlane);
              } else {
                topPlane.material.map = tex;
                topPlane.material.emissiveMap = tex;
                topPlane.material.needsUpdate = true;
              }
            });
          });
        }
      }, 250);
    };

    window._sfInitCube._sfExtPatched = true;
  }

  /* Hook: expose scene ref from app.v2.70.js — we patch THREE.Scene constructor
     to capture the scene as it's created */
  var _origSceneCtor = null;
  function hookScene() {
    if (!window.THREE || !window.THREE.Scene) return;
    if (window.THREE.Scene._sfExtHooked) return;
    _origSceneCtor = window.THREE.Scene;
    var origProto = window.THREE.Scene.prototype;
    /* We can't easily patch the constructor without breaking inheritance,
       so instead we just poll for _sfCubeScene after _sfInitCube runs */
    window.THREE.Scene._sfExtHooked = true;
  }

  /* Alternative: patch THREE.WebGLRenderer.render to grab the scene */
  function hookRenderer() {
    if (!window.THREE || !window.THREE.WebGLRenderer) return;
    if (window.THREE.WebGLRenderer.prototype._sfExtHooked) return;
    var origRender = window.THREE.WebGLRenderer.prototype.render;
    window.THREE.WebGLRenderer.prototype.render = function (scene, camera) {
      if (!window._sfCubeScene && scene) {
        window._sfCubeScene = scene;
      }
      return origRender.call(this, scene, camera);
    };
    window.THREE.WebGLRenderer.prototype._sfExtHooked = true;
  }

  /* Poll for THREE to become available, then hook renderer */
  var hookIv = setInterval(function () {
    if (window.THREE) {
      hookRenderer();
      clearInterval(hookIv);
    }
  }, 100);

  /* Poll for _sfInitCube to be defined by app.v2.70.js, then patch it */
  var patchIv = setInterval(function () {
    if (window._sfInitCube && !window._sfInitCube._sfExtPatched) {
      installPatch();
      clearInterval(patchIv);
    }
  }, 50);

  /* Also expose runtime reload helper */
  window._sfReloadCube = function (newSkinId) {
    window._sfCubeActive = false;
    window._sfCubeScene = null;
    if (window._sfUser) {
      window._sfUser.active_cube_id = newSkinId;
      if (typeof window._sfInitCube === 'function') {
        window._sfInitCube(window._sfUser);
      }
    }
  };

})();
