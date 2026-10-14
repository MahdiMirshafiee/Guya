/*
 * The orb.
 *
 * One renderer, two homes: the floating overlay while recording, and the
 * recorder window while a transcript is being fetched. Colour is the state —
 * warm means the microphone is live, cool means busy, green done, amber failed —
 * and while it is listening every movement comes from the audio, never a timer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuyaOrb = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const REST = 0.18; // resting energy, so the orb never looks dead

  /* One colour cloud per band: orbit radius (fraction of the sphere radius),
   * angular speed (rad/ms), start phase and size. */
  const CLOUDS = [
    { orbit: 0.24, speed: 0.00021, phase: 0.0, size: 1.0, alpha: 0.66 },
    { orbit: 0.32, speed: -0.00015, phase: 2.4, size: 0.95, alpha: 0.5 },
    { orbit: 0.42, speed: 0.00028, phase: 4.4, size: 0.62, alpha: 0.62 },
    { orbit: 0.2, speed: -0.00011, phase: 1.2, size: 0.52, alpha: 0.5 }
  ];

  const PALETTES = {
    live: [[255, 108, 118], [255, 150, 92], [255, 86, 132], [255, 196, 112]],
    busy: [[128, 140, 248], [96, 222, 240], [116, 166, 255], [162, 200, 255]],
    done: [[64, 214, 150], [86, 226, 170], [52, 190, 140], [122, 234, 190]],
    failed: [[255, 168, 72], [255, 190, 110], [246, 148, 60], [255, 205, 140]]
  };

  function rgba(color, alpha) {
    return `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${alpha.toFixed(3)})`;
  }

  function create(canvas, options) {
    const config = options || {};
    const ctx = canvas.getContext('2d');
    const box = config.box || 96;
    const sphere = config.sphere || 27;
    const auraMax = config.auraMax || 1.65;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    let paletteName = config.palette || 'live';
    let palette = PALETTES[paletteName].map((c) => c.slice());
    let bands = [REST, REST, REST, REST];
    let driven = true; // true while the microphone is live
    let processing = false;
    let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    let handle = 0;
    let lastFrame = 0;

    function resize() {
      const width = canvas.clientWidth || box;
      const height = canvas.clientHeight || box;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
      reduced = event.matches;
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      dark = event.matches;
    });

    function draw(now) {
      const size = canvas.width / dpr;
      const half = size / 2;

      /* Palette changes blend instead of snapping: a hard cut reads as a glitch. */
      const target = PALETTES[paletteName];
      const step = reduced ? 1 : Math.min(1, Math.max(0, now - lastFrame) / 600 || 1);
      lastFrame = now;
      for (let i = 0; i < palette.length; i++) {
        for (let c = 0; c < 3; c++) palette[i][c] += (target[i][c] - palette[i][c]) * step;
      }

      const energy = driven ? bands[0] * 0.4 + bands[1] * 0.25 + bands[2] * 0.2 + bands[3] * 0.15 : REST;
      const bass = driven ? bands[0] : REST;
      const idleFlow = Math.sin(now / 1500);
      const auraSpread = driven
        ? 1.3 + (auraMax - 1.3) * Math.max(energy, bass * 0.9)
        : 1.36 + 0.05 * idleFlow;
      const auraAlpha = driven ? 0.26 + 0.42 * energy : 0.3 + 0.07 * idleFlow;
      const scale = driven ? 1 + 0.075 * bass + 0.03 * energy : 1 + 0.016 * idleFlow;

      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(half, half);

      /* Outer aura: the light the orb throws on its surroundings. */
      const auraRadius = sphere * auraSpread;
      const auraTint = palette[1];
      const aura = ctx.createRadialGradient(0, 0, sphere * 0.4, 0, 0, auraRadius);
      aura.addColorStop(0, rgba(auraTint, auraAlpha));
      aura.addColorStop(0.6, rgba(auraTint, auraAlpha * 0.55));
      aura.addColorStop(1, rgba(auraTint, 0));
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(0, 0, auraRadius, 0, TAU);
      ctx.fill();

      ctx.scale(scale, scale);

      const base = ctx.createRadialGradient(-sphere * 0.3, -sphere * 0.38, sphere * 0.1, 0, 0, sphere * 1.1);
      base.addColorStop(0, dark ? '#3d3760' : '#f8f5ff');
      base.addColorStop(0.55, dark ? '#2a2542' : '#e9e2f6');
      base.addColorStop(1, dark ? '#191627' : '#d3cbe6');
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(0, 0, sphere, 0, TAU);
      ctx.fill();

      /* Light clouds inside the glass, one per band. The softness comes from the
       * gradient stops themselves: a canvas blur is unpredictable in a
       * transparent window and costs more. */
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, sphere * 0.98, 0, TAU);
      ctx.clip();
      for (let i = 0; i < CLOUDS.length; i++) {
        const cloud = CLOUDS[i];
        const colour = palette[i];
        const level = driven
          ? bands[i]
          : REST + (reduced ? 0.12 : 0.42 * (0.5 + 0.5 * Math.sin(now / 700 + i * 1.9)));
        const angle = cloud.phase + (reduced ? 0 : now * cloud.speed * (processing ? 2.2 : 1));
        const x = Math.cos(angle) * sphere * cloud.orbit;
        const y = Math.sin(angle) * sphere * cloud.orbit * 0.92;
        const radius = sphere * cloud.size * (0.82 + 0.34 * level);
        const alpha = cloud.alpha * (0.72 + 0.45 * level);
        const blob = ctx.createRadialGradient(x, y, 0, x, y, radius);
        blob.addColorStop(0, rgba(colour, alpha));
        blob.addColorStop(0.45, rgba(colour, alpha * 0.68));
        blob.addColorStop(0.75, rgba(colour, alpha * 0.26));
        blob.addColorStop(1, rgba(colour, 0));
        ctx.fillStyle = blob;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      /* Glass: top-left specular, a soft shadow at the bottom and a rim light. */
      const spec = ctx.createRadialGradient(-sphere * 0.34, -sphere * 0.46, 0, -sphere * 0.34, -sphere * 0.46, sphere * 0.62);
      spec.addColorStop(0, 'rgba(255, 255, 255, 0.26)');
      spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = spec;
      ctx.beginPath();
      ctx.arc(0, 0, sphere, 0, TAU);
      ctx.fill();

      const shade = ctx.createRadialGradient(sphere * 0.2, sphere * 0.55, sphere * 0.2, sphere * 0.2, sphere * 0.55, sphere * 1.25);
      shade.addColorStop(0, 'rgba(10, 8, 20, 0.18)');
      shade.addColorStop(1, 'rgba(10, 8, 20, 0)');
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.arc(0, 0, sphere, 0, TAU);
      ctx.fill();

      ctx.lineWidth = 1;
      ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.75)';
      ctx.beginPath();
      ctx.arc(0, 0, sphere - 0.5, 0, TAU);
      ctx.stroke();

      /* Terminal states take over the whole sphere. */
      if (paletteName === 'done' || paletteName === 'failed') {
        const tone = palette[0];
        ctx.globalCompositeOperation = 'source-atop';
        const tint = ctx.createRadialGradient(-sphere * 0.3, -sphere * 0.3, 0, 0, 0, sphere * 1.15);
        tint.addColorStop(0, rgba(tone, 0.88));
        tint.addColorStop(1, rgba(tone, 0.62));
        ctx.fillStyle = tint;
        ctx.beginPath();
        ctx.arc(0, 0, sphere, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.restore();
    }

    function tick(now) {
      if (!driven) {
        for (let i = 0; i < bands.length; i++) bands[i] += (REST - bands[i]) * 0.06;
      }
      if (typeof config.onFrame === 'function') config.onFrame(now || performance.now());
      draw(now || performance.now());
      handle = requestAnimationFrame(tick);
    }

    resize();

    return {
      resize: resize,
      draw: draw,
      setPalette(name) {
        if (PALETTES[name]) paletteName = name;
      },
      setLevels(next) {
        if (Array.isArray(next) && next.length === bands.length) bands = next.slice();
      },
      setDriven(bool) {
        driven = !!bool;
      },
      setProcessing(bool) {
        processing = !!bool;
      },
      start() {
        if (!handle) handle = requestAnimationFrame(tick);
      },
      stop() {
        if (handle) cancelAnimationFrame(handle);
        handle = 0;
      },
      isRunning() {
        return !!handle;
      }
    };
  }

  return { create: create, PALETTES: PALETTES, REST: REST };
});
