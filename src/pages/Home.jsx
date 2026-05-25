import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

const REDUCED_MOTION = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Scene ranges in [0, 1]. Each scene fades in over the first 25% of its range,
// holds 50%, then fades out over the last 25%. Hero/CTA extend past [0, 1] so
// scroll=0 and scroll=max land in their hold phases (visible immediately).
const SCENES = [
  { id: 'hero',  start: -0.10, end: 0.22 },
  { id: 'step1', start:  0.18, end: 0.42 },
  { id: 'step2', start:  0.38, end: 0.62 },
  { id: 'step3', start:  0.58, end: 0.82 },
  { id: 'cta',   start:  0.78, end: 1.10 },
];

export default function Home() {
  const runwayRef = useRef(null);
  const titleSvgRef = useRef(null);
  const titleTextRef = useRef(null);
  const wavesCanvasRef = useRef(null);
  const sceneRefs = useRef({});
  const setSceneRef = (id) => (el) => { sceneRefs.current[id] = el; };

  // ---- Dot constellation that forms the word "Ensemble" ----
  useEffect(() => {
    const svg = titleSvgRef.current;
    if (!svg) return;

    const W = 800, H = 200;
    const build = () => {
      // Sample target positions from an offscreen render of the actual title.
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const octx = off.getContext('2d');
      octx.fillStyle = '#000';
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      octx.font = 'italic 300 150px "Cormorant Garamond", Georgia, serif';
      octx.fillText('Ensemble', W / 2, H / 2);

      const img = octx.getImageData(0, 0, W, H);
      const targets = [];
      const STEP = 2; // dense enough that the dots themselves form the readable word
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
      svg.insertBefore(frag, titleTextRef.current);

      if (REDUCED_MOTION) return;

      const FADE_IN = 600;
      const STAGGER = 400;
      const MOVE    = 1500;
      const TOTAL   = STAGGER + Math.max(FADE_IN, MOVE);
      const easeOut = (t) => 1 - Math.pow(1 - t, 3);
      const start = performance.now();

      const tick = (now) => {
        const t = now - start;
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          const local = t - (i / dots.length) * STAGGER;
          const alpha = local > 0 ? Math.min(1, local / FADE_IN) : 0;
          const moveProgress = Math.max(0, Math.min(1, local / MOVE));
          const e = easeOut(moveProgress);
          d.el.setAttribute('cx', d.sx + (d.tx - d.sx) * e);
          d.el.setAttribute('cy', d.sy + (d.ty - d.sy) * e);
          d.el.style.opacity = String(alpha);
        }
        if (t < TOTAL + 100) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(build);
    else build();
  }, []);

  // ---- Cursor-reactive sine waves behind the hero ----
  useEffect(() => {
    if (REDUCED_MOTION) return;
    const canvas = wavesCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let w = 0, h = 0, dpr = 1;
    let mouseX = -9999, mouseY = -9999, mouseInside = false;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const stage = canvas.parentElement;
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; mouseInside = true;
    };
    const onLeave = () => { mouseInside = false; };
    stage.addEventListener('mousemove', onMove);
    stage.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', resize);

    const waves = [
      { color: 'rgba(107, 140, 166, 0.45)', baseAmp: 18, freq: 0.0055, speed: 0.0008, phase: 0,   yOffset: 0.50 },
      { color: 'rgba(107, 140, 166, 0.28)', baseAmp: 28, freq: 0.0038, speed: 0.0011, phase: 1.2, yOffset: 0.58 },
      { color: 'rgba(154, 149, 144, 0.22)', baseAmp: 14, freq: 0.0072, speed: 0.0006, phase: 2.5, yOffset: 0.42 },
    ];

    let rafId;
    const draw = (t) => {
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
          const y = yBase + Math.sin(x * wave.freq + wave.phase + t * wave.speed) * wave.baseAmp - bump;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      stage.removeEventListener('mousemove', onMove);
      stage.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', resize);
    };
  }, []);

  // ---- Scroll-runway driver: scrollY → per-scene opacity + transform ----
  useEffect(() => {
    const runway = runwayRef.current;
    if (!runway) return;

    let pending = false;
    const update = () => {
      pending = false;
      const rect = runway.getBoundingClientRect();
      const scrollable = Math.max(1, rect.height - window.innerHeight);
      const scrolled = Math.max(0, Math.min(-rect.top, scrollable));
      const progress = scrolled / scrollable;

      for (const s of SCENES) {
        const el = sceneRefs.current[s.id];
        if (!el) continue;
        const span = s.end - s.start;
        const rel = (progress - s.start) / span;

        let opacity, ty, scale;
        if (rel <= 0)        { opacity = 0; ty = 40;  scale = 0.96; }
        else if (rel < 0.25) { const t = rel / 0.25; const e = 1 - Math.pow(1 - t, 2);
                               opacity = e; ty = 40 * (1 - e); scale = 0.96 + 0.04 * e; }
        else if (rel < 0.75) { opacity = 1; ty = 0;   scale = 1; }
        else if (rel < 1)    { const t = (rel - 0.75) / 0.25;
                               opacity = 1 - t; ty = -30 * t; scale = 1 + 0.04 * t; }
        else                 { opacity = 0; ty = -30; scale = 1.04; }

        if (REDUCED_MOTION) {
          el.style.opacity = opacity > 0.4 ? '1' : '0';
          el.style.transform = 'none';
        } else {
          el.style.opacity = String(opacity);
          el.style.transform = `translateY(${ty}px) scale(${scale})`;
        }
        el.style.pointerEvents = opacity > 0.5 ? 'auto' : 'none';
      }
    };

    const onScroll = () => { if (!pending) { pending = true; requestAnimationFrame(update); } };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div className="welcome-body">
      <Link className="skip-link" to="/app">Skip intro &rarr;</Link>

      <div className="runway" ref={runwayRef}>
        <div className="stage">
          <canvas id="hero-waves" className="hero-waves" ref={wavesCanvasRef}></canvas>

          <section className="scene" ref={setSceneRef('hero')} data-scene="hero">
            <svg id="hero-title" className="hero-title" viewBox="0 0 800 200" preserveAspectRatio="xMidYMid meet" ref={titleSvgRef}>
              <text id="hero-title-text" x="400" y="100"
                    textAnchor="middle" dominantBaseline="middle"
                    fontFamily="'Cormorant Garamond', Georgia, serif"
                    fontSize="150" fontStyle="italic" fontWeight="300"
                    fill="#2C2C2C" style={{ opacity: 0 }} ref={titleTextRef}>Ensemble</text>
            </svg>
            <p className="hero-tagline">A shared score for the world.</p>
          </section>

          <section className="scene" ref={setSceneRef('step1')} data-scene="step1">
            <div className="scene-grid">
              <div className="scene-text">
                <span className="step-num">01</span>
                <h2 className="step-title">Pick a measure.</h2>
                <p className="step-body">Hover over any bar on any instrument. The highlighted box is where your note will go.</p>
              </div>
              <div className="scene-visual" aria-hidden="true">
                <svg viewBox="0 0 400 120">
                  <g stroke="var(--ink)" strokeWidth="1" fill="none">
                    <line x1="20" y1="40" x2="380" y2="40"/>
                    <line x1="20" y1="55" x2="380" y2="55"/>
                    <line x1="20" y1="70" x2="380" y2="70"/>
                    <line x1="20" y1="85" x2="380" y2="85"/>
                    <line x1="20" y1="100" x2="380" y2="100"/>
                    <line x1="20" y1="40" x2="20" y2="100"/>
                    <line x1="200" y1="40" x2="200" y2="100"/>
                    <line x1="380" y1="40" x2="380" y2="100"/>
                  </g>
                  <rect className="illus-hover" x="200" y="32" width="180" height="76" rx="2"
                        fill="var(--accent)" fillOpacity="0.14"/>
                </svg>
              </div>
            </div>
          </section>

          <section className="scene" ref={setSceneRef('step2')} data-scene="step2">
            <div className="scene-grid">
              <div className="scene-text">
                <span className="step-num">02</span>
                <h2 className="step-title">Place a note.</h2>
                <p className="step-body">Click on the staff to drop a note. Higher up means a higher pitch.
                  Press <kbd>1</kbd> through <kbd>5</kbd> to change the duration.
                  Press <kbd>R</kbd> for a rest, <kbd>V</kbd> for vibrato.</p>
              </div>
              <div className="scene-visual" aria-hidden="true">
                <svg viewBox="0 0 400 120">
                  <g stroke="var(--ink)" strokeWidth="1" fill="none">
                    <line x1="20" y1="40" x2="380" y2="40"/>
                    <line x1="20" y1="55" x2="380" y2="55"/>
                    <line x1="20" y1="70" x2="380" y2="70"/>
                    <line x1="20" y1="85" x2="380" y2="85"/>
                    <line x1="20" y1="100" x2="380" y2="100"/>
                    <line x1="20" y1="40" x2="20" y2="100"/>
                    <line x1="380" y1="40" x2="380" y2="100"/>
                  </g>
                  <ellipse cx="80"  cy="62" rx="7" ry="5" fill="var(--ink)" transform="rotate(-15 80 62)"/>
                  <line    x1="86"  y1="62" x2="86"  y2="32" stroke="var(--ink)" strokeWidth="1.4"/>
                  <ellipse cx="170" cy="55" rx="7" ry="5" fill="var(--ink)" transform="rotate(-15 170 55)"/>
                  <line    x1="176" y1="55" x2="176" y2="25" stroke="var(--ink)" strokeWidth="1.4"/>
                  <ellipse cx="260" cy="70" rx="7" ry="5" fill="var(--ink)" transform="rotate(-15 260 70)"/>
                  <line    x1="266" y1="70" x2="266" y2="40" stroke="var(--ink)" strokeWidth="1.4"/>
                </svg>
              </div>
            </div>
          </section>

          <section className="scene" ref={setSceneRef('step3')} data-scene="step3">
            <div className="scene-grid">
              <div className="scene-text">
                <span className="step-num">03</span>
                <h2 className="step-title">Hear it back.</h2>
                <p className="step-body">Press <kbd>space</kbd> or click play. Your notes play together with everyone else's, like one shared orchestra.</p>
              </div>
              <div className="scene-visual" aria-hidden="true">
                <svg viewBox="0 0 400 120">
                  <g stroke="var(--accent)" fill="none" strokeLinecap="round" strokeWidth="1.5">
                    <path d="M 20 60 Q 65 30, 110 60 T 200 60 T 290 60 T 380 60"/>
                    <path d="M 20 75 Q 65 45, 110 75 T 200 75 T 290 75 T 380 75" opacity="0.55"/>
                    <path d="M 20 45 Q 65 15, 110 45 T 200 45 T 290 45 T 380 45" opacity="0.35"/>
                  </g>
                </svg>
              </div>
            </div>
          </section>

          <section className="scene" ref={setSceneRef('cta')} data-scene="cta">
            <h2 className="cta-title">Add your voice to the score.</h2>
            <p className="cta-sub">The orchestra is waiting.</p>
            <Link className="cta-btn" to="/app">Open the score &rarr;</Link>
          </section>
        </div>
      </div>
    </div>
  );
}
