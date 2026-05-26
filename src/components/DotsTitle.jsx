import { useEffect, useRef } from 'react';

const REDUCED_MOTION = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The dot constellation is deterministic given font + text; sample once and
// cache so re-mounts (route changes, StrictMode) don't re-run the canvas work.
let cachedTargetsPromise = null;
function getTargets() {
  if (cachedTargetsPromise) return cachedTargetsPromise;
  cachedTargetsPromise = (async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const W = 800, H = 200;
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
    // STEP=2 keeps the count around ~2k — dense enough to read as the word,
    // light enough to animate at 60fps. r=0.35 + pure black below give the
    // "bolder" look without bumping the count.
    const STEP = 2;
    for (let y = 0; y < H; y += STEP) {
      for (let x = 0; x < W; x += STEP) {
        if (img.data[(y * W + x) * 4 + 3] > 128) targets.push([x, y]);
      }
    }
    return targets;
  })();
  return cachedTargetsPromise;
}

export default function DotsTitle({ animate = false }) {
  const svgRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const svg = svgRef.current;
    if (!svg) return;

    (async () => {
      const targets = await getTargets();
      if (cancelled || !svgRef.current) return;
      svg.innerHTML = '';

      const W = 800, H = 200;
      const useAnim = animate && !REDUCED_MOTION;

      // Shuffle so the fade-in reads as a sparkle, not a sweep.
      const order = [...targets];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }

      const dots = [];
      const frag = document.createDocumentFragment();
      for (const [tx, ty] of order) {
        const sx = useAnim ? Math.random() * W : tx;
        const sy = useAnim ? Math.random() * H : ty;
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', '0.35');
        c.setAttribute('cx', sx);
        c.setAttribute('cy', sy);
        c.setAttribute('fill', '#000');
        c.style.opacity = useAnim ? '0' : '1';
        frag.appendChild(c);
        dots.push({ el: c, sx, sy, tx, ty });
      }
      svg.appendChild(frag);

      if (!useAnim) return;

      const FADE_IN = 600, STAGGER = 400, MOVE = 1500;
      const TOTAL = STAGGER + Math.max(FADE_IN, MOVE);
      const easeOut = (t) => 1 - Math.pow(1 - t, 3);
      const start = performance.now();
      const tick = (now) => {
        if (cancelled) return;
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
    })();

    return () => { cancelled = true; };
  }, [animate]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 800 200"
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block' }}
      aria-label="Ensemble"
    />
  );
}
