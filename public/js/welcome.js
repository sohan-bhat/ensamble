// Homepage choreography:
//   1. Tiny dots are placed at random scattered positions across the title
//      box, fade in, glide into the sampled letter-positions of "Ensemble",
//      then hand off to a clean italic <text> that fades in on top while the
//      dots dissolve. End state: just the text.
//   2. Three cursor-reactive sine waves drift behind the hero.
//   3. A scroll-progress driver maps scrollY within the runway to opacity +
//      transform values on each .scene so the page morphs in place instead
//      of scrolling content past the viewport (Apple-style pinning).

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// 1. Dot scatter → letter constellation → text handoff
// ---------------------------------------------------------------------------

function buildTitleDots() {
  const svg = document.getElementById('hero-title');
  const textEl = document.getElementById('hero-title-text');
  if (!svg || !textEl) return;

  const W = 800;
  const H = 200;

  // Sample target positions from an offscreen render of the actual title.
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const octx = off.getContext('2d');
  octx.fillStyle = '#000';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.font = 'italic 300 150px "Cormorant Garamond", Georgia, serif';
  octx.fillText('Ensemble', W / 2, H / 2);

  const img = octx.getImageData(0, 0, W, H);
  const targets = [];
  // Denser sampling so the dots themselves form the readable word.
  const STEP = 2;
  for (let y = 0; y < H; y += STEP) {
    for (let x = 0; x < W; x += STEP) {
      if (img.data[(y * W + x) * 4 + 3] > 128) targets.push([x, y]);
    }
  }

  // Sparkle, not sweep.
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }

  // For each target, create a circle starting at a random scattered position.
  // Under reduced motion the scattered start = the target so dots render in
  // their final positions immediately with no movement.
  const dots = [];
  const frag = document.createDocumentFragment();
  for (const [tx, ty] of targets) {
    const sx = REDUCED_MOTION ? tx : Math.random() * W;
    const sy = REDUCED_MOTION ? ty : Math.random() * H;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '0.5');
    c.setAttribute('cx', sx);
    c.setAttribute('cy', sy);
    c.style.opacity = REDUCED_MOTION ? '1' : '0';
    frag.appendChild(c);
    dots.push({ el: c, sx, sy, tx, ty });
  }
  svg.insertBefore(frag, textEl);

  if (REDUCED_MOTION) return;

  // Phase timings (ms). Tuned by feel.
  const FADE_IN = 600;   // per-dot fade-in window
  const STAGGER = 400;   // total time over which dot fade-ins are spread
  const MOVE    = 1500;  // dot travel from scatter to letter position
  const TOTAL   = STAGGER + Math.max(FADE_IN, MOVE);

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  // The real <text> stays invisible — dots are the final visual. Kept in the
  // DOM so screen readers still announce "Ensemble".
  textEl.style.opacity = '0';

  const start = performance.now();

  function tick(now) {
    const t = now - start;

    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const delay = (i / dots.length) * STAGGER;
      const local = t - delay;

      let alpha = 0;
      if (local > 0) alpha = Math.min(1, local / FADE_IN);

      const moveProgress = Math.max(0, Math.min(1, local / MOVE));
      const e = easeOut(moveProgress);
      const x = d.sx + (d.tx - d.sx) * e;
      const y = d.sy + (d.ty - d.sy) * e;
      d.el.setAttribute('cx', x);
      d.el.setAttribute('cy', y);
      d.el.style.opacity = String(alpha);
    }

    if (t < TOTAL + 100) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// 2. Cursor-reactive hero waves
// ---------------------------------------------------------------------------

function startHeroWaves() {
  if (REDUCED_MOTION) return;
  const canvas = document.getElementById('hero-waves');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let w = 0, h = 0, dpr = 1;
  let mouseX = -9999;
  let mouseY = -9999;
  let mouseInside = false;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  const stage = canvas.parentElement; // the sticky stage
  stage.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
    mouseInside = true;
  });
  stage.addEventListener('mouseleave', () => { mouseInside = false; });

  const waves = [
    { color: 'rgba(107, 140, 166, 0.45)', baseAmp: 18, freq: 0.0055, speed: 0.0008, phase: 0,   yOffset: 0.50 },
    { color: 'rgba(107, 140, 166, 0.28)', baseAmp: 28, freq: 0.0038, speed: 0.0011, phase: 1.2, yOffset: 0.58 },
    { color: 'rgba(154, 149, 144, 0.22)', baseAmp: 14, freq: 0.0072, speed: 0.0006, phase: 2.5, yOffset: 0.42 },
  ];

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    for (const wave of waves) {
      ctx.beginPath();
      ctx.strokeStyle = wave.color;
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      const yBase = h * wave.yOffset;
      for (let x = 0; x <= w; x += 4) {
        let bump = 0;
        if (mouseInside) {
          const dx = x - mouseX;
          const sigma = 160;
          const fall = Math.exp(-(dx * dx) / (2 * sigma * sigma));
          bump = fall * 22 + fall * (mouseY - yBase) * 0.18;
        }
        const y = yBase
          + Math.sin(x * wave.freq + wave.phase + t * wave.speed) * wave.baseAmp
          - bump;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// 3. Scroll-runway driver: scrollY → per-scene opacity + transform
// ---------------------------------------------------------------------------

function startRunway() {
  const runway = document.getElementById('runway');
  if (!runway) return;

  // Phase ranges in [0, 1]. Each scene fades in over the first 25% of its
  // range, holds 50%, then fades out over the last 25%. Adjacent scene
  // ranges overlap by ~4 pp so the crossfade reads as continuous.
  // Hero and CTA extend past the [0, 1] window so scroll=0 lands in hero's
  // hold phase (visible immediately) and scroll=max lands in CTA's.
  const scenes = [
    { sel: '[data-scene="hero"]',  start: -0.10, end: 0.22, el: null },
    { sel: '[data-scene="step1"]', start:  0.18, end: 0.42, el: null },
    { sel: '[data-scene="step2"]', start:  0.38, end: 0.62, el: null },
    { sel: '[data-scene="step3"]', start:  0.58, end: 0.82, el: null },
    { sel: '[data-scene="cta"]',   start:  0.78, end: 1.10, el: null },
  ];
  for (const s of scenes) s.el = document.querySelector(s.sel);

  let pending = false;
  function update() {
    pending = false;
    const rect = runway.getBoundingClientRect();
    const scrollable = Math.max(1, rect.height - window.innerHeight);
    const scrolled = Math.max(0, Math.min(-rect.top, scrollable));
    const progress = scrolled / scrollable;

    for (const s of scenes) {
      const span = s.end - s.start;
      const rel = (progress - s.start) / span;

      let opacity, ty, scale;
      if (rel <= 0) {
        opacity = 0; ty = 40; scale = 0.96;
      } else if (rel < 0.25) {
        const t = rel / 0.25;
        const e = 1 - Math.pow(1 - t, 2);
        opacity = e;
        ty = 40 * (1 - e);
        scale = 0.96 + 0.04 * e;
      } else if (rel < 0.75) {
        opacity = 1; ty = 0; scale = 1;
      } else if (rel < 1) {
        const t = (rel - 0.75) / 0.25;
        opacity = 1 - t;
        ty = -30 * t;
        scale = 1 + 0.04 * t;
      } else {
        opacity = 0; ty = -30; scale = 1.04;
      }

      if (REDUCED_MOTION) {
        // No transforms, just on/off.
        s.el.style.opacity = opacity > 0.4 ? '1' : '0';
        s.el.style.transform = 'none';
      } else {
        s.el.style.opacity = String(opacity);
        s.el.style.transform = `translateY(${ty}px) scale(${scale})`;
      }
      // Keep clicks ignored on faded scenes so they don't block the CTA.
      s.el.style.pointerEvents = opacity > 0.5 ? 'auto' : 'none';
    }
  }

  function onScroll() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ---------------------------------------------------------------------------

function init() {
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(buildTitleDots);
  } else {
    buildTitleDots();
  }
  startHeroWaves();
  startRunway();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
