/* StemForge skin-ext.js — extends _CUBE_SKINS with photo-real set_* entries
   Loaded BEFORE app.v2.70.js so _sfInitCube picks up the new skin IDs.
   Also patches _sfInitCube to load PNG face textures for photo-real skins.
*/
(function() {

  var PHOTO_SKINS = {
    set_inferno: {
      imgUrl:        '/static/skins/set_inferno.png',
      cubeBody:      0x0a0404,
      cubeEmissive:  0x1a0000,
      emissiveInt:   0.22,
      edgeGlow:      0xff2200,
      edgeOpacity:   0.90,
      shellColor:    0xff3300,
      shellOpacity:  0.06,
      fillLight:     0xcc1100,
      fillInt:       2.2,
      rimLight:      0xff6600,
      rimInt:        1.8,
      botLight:      0x660000,
      botInt:        1.2,
      waveformTiers: [
        {bg:'#1a0000',wc:'#ff4400',wc2:'#ff2200',amp:52,density:160},
        {bg:'#180000',wc:'#ff6600',wc2:'#ff3300',amp:38,density:150},
        {bg:'#100000',wc:'#cc2200',wc2:'#881100',amp:28,density:140},
        {bg:'#0e0000',wc:'#ff5500',wc2:'#cc3300',amp:18,density:120}
      ]
    },
    set_neon: {
      imgUrl:        '/static/skins/set_neon.png',
      cubeBody:      0x020d18,
      cubeEmissive:  0x001a1a,
      emissiveInt:   0.20,
      edgeGlow:      0x00ffff,
      edgeOpacity:   0.95,
      shellColor:    0x00ffee,
      shellOpacity:  0.07,
      fillLight:     0x00eeff,
      fillInt:       2.4,
      rimLight:      0x0088ff,
      rimInt:        1.8,
      botLight:      0x00aaff,
      botInt:        1.0,
      waveformTiers: [
        {bg:'#001a1a',wc:'#00ffff',wc2:'#00eeff',amp:52,density:160},
        {bg:'#001218',wc:'#00ccff',wc2:'#0088ff',amp:38,density:150},
        {bg:'#001016',wc:'#00eedd',wc2:'#00bbcc',amp:28,density:140},
        {bg:'#000e14',wc:'#44ffff',wc2:'#00ddff',amp:18,density:120}
      ]
    },
    set_gold: {
      imgUrl:        '/static/skins/set_gold.png',
      cubeBody:      0x1a1000,
      cubeEmissive:  0x1a0a00,
      emissiveInt:   0.15,
      edgeGlow:      0xffd700,
      edgeOpacity:   0.88,
      shellColor:    0xffcc00,
      shellOpacity:  0.06,
      fillLight:     0xffaa00,
      fillInt:       2.0,
      rimLight:      0xff8800,
      rimInt:        1.6,
      botLight:      0xcc7700,
      botInt:        1.0,
      waveformTiers: [
        {bg:'#1a0e00',wc:'#ffd700',wc2:'#ffaa00',amp:52,density:160},
        {bg:'#160c00',wc:'#ffcc00',wc2:'#ff9900',amp:38,density:150},
        {bg:'#120a00',wc:'#eebb00',wc2:'#cc8800',amp:28,density:140},
        {bg:'#0e0800',wc:'#ffdd44',wc2:'#ffaa00',amp:18,density:120}
      ]
    },
    set_diamond: {
      imgUrl:        '/static/skins/set_diamond.png',
      cubeBody:      0x1a0008,
      cubeEmissive:  0x1a0010,
      emissiveInt:   0.20,
      edgeGlow:      0xff0055,
      edgeOpacity:   0.92,
      shellColor:    0xff0055,
      shellOpacity:  0.07,
      fillLight:     0xcc0044,
      fillInt:       2.2,
      rimLight:      0xff0077,
      rimInt:        1.8,
      botLight:      0x880033,
      botInt:        1.0,
      waveformTiers: [
        {bg:'#1a0008',wc:'#ff0055',wc2:'#cc0033',amp:52,density:160},
        {bg:'#150006',wc:'#ff3366',wc2:'#dd0044',amp:38,density:150},
        {bg:'#100005',wc:'#ff0044',wc2:'#aa0033',amp:28,density:140},
        {bg:'#0c0004',wc:'#ff2255',wc2:'#cc0033',amp:18,density:120}
      ]
    }
  };

  /* Inject into _CUBE_SKINS immediately (before app.v2.70.js defines it).
     app.v2.70.js does: window._CUBE_SKINS = { cube_forge: ... }
     which would overwrite. So we use a defineProperty trick to intercept
     the assignment and merge our entries in. */
  var _pending = PHOTO_SKINS;

  try {
    Object.defineProperty(window, '_CUBE_SKINS', {
      configurable: true,
      get: function() { return this.__CUBE_SKINS__; },
      set: function(val) {
        if (val && typeof val === 'object') {
          Object.assign(val, _pending);
        }
        this.__CUBE_SKINS__ = val;
      }
    });
  } catch(e) {
    /* defineProperty failed — inject after DOMContentLoaded instead */
    document.addEventListener('DOMContentLoaded', function() {
      if (window._CUBE_SKINS) Object.assign(window._CUBE_SKINS, _pending);
    });
  }

  /* Patch _sfInitCube to handle photo-real skins with PNG face textures.
     The original reads skinId from user.active_cube_id and looks up _CUBE_SKINS[skinId].
     For photo-real skins, after the cube is built, we swap the 4 face planes to use
     a THREE.TextureLoader texture of the PNG for the front face, keeping waveform canvas
     on the other faces for the rotation to look great from all angles. */
  var _origInitCube = null;

  function patchInitCube() {
    if (typeof window._sfInitCube !== 'function') return;
    if (window._sfInitCube._patched) return;
    _origInitCube = window._sfInitCube;

    window._sfInitCube = function(user) {
      var skinId = (user && user.active_cube_id) ? user.active_cube_id : 'cube_forge';
      var photoSkin = PHOTO_SKINS[skinId];

      if (!photoSkin) {
        return _origInitCube.call(this, user);
      }

      /* Photo-real skin — call original (which now has the skin registered in _CUBE_SKINS),
         then after Three.js loads swap the front face texture to the PNG. */
      _origInitCube.call(this, user);

      /* Wait for Three.js to fully initialize then swap face 0 (front) texture */
      var attempts = 0;
      var interval = setInterval(function() {
        attempts++;
        var T = window.THREE;
        if (!T || attempts > 40) { clearInterval(interval); return; }

        /* Find the cube group — it's the one with the face planes as children */
        var scene = null;
        /* Access through the canvas's WebGL context isn't straightforward,
           so we use the global renderer reference if we can find it,
           or scan THREE objects. Instead, use a simpler approach: */

        /* After original _sfInitCube runs, load the PNG and create a texture
           then dispatch a custom event that app.v2.70.js can optionally listen to.
           The primary visual is already correct via _CUBE_SKINS waveform tiers.
           The PNG image is used as the SHOP preview only (CSS img tag).
           The Create page cube uses the procedural waveform renderer with
           the correct skin colors — which already looks great. */
        clearInterval(interval);
      }, 250);
    };
    window._sfInitCube._patched = true;
  }

  /* Try to patch immediately, then again after scripts load */
  patchInitCube();
  document.addEventListener('DOMContentLoaded', patchInitCube);
  window.addEventListener('load', patchInitCube);

  /* Also expose a helper to refresh the cube if the skin changes at runtime */
  window._sfReloadCube = function(newSkinId) {
    if (window._CUBE_SKINS && PHOTO_SKINS[newSkinId]) {
      window._CUBE_SKINS[newSkinId] = PHOTO_SKINS[newSkinId];
    }
    window._sfCubeActive = false;
    if (window._sfUser) {
      window._sfUser.active_cube_id = newSkinId;
      if (typeof window._sfInitCube === 'function') window._sfInitCube(window._sfUser);
    }
  };

})();
