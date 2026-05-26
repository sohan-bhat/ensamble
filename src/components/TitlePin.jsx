import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import DotsTitle from './DotsTitle.jsx';

// Mini-pin dimensions (CSS pixels) at scale=1.
const MINI_W = 160;
const MINI_H = 40;     // 800:200 ratio = 4:1
const MINI_LEFT = 24;
const MINI_TOP = 24;
const MORPH_END = 0.05; // morph completes by 5% scroll through the runway

export default function TitlePin({ morphOnScroll = false }) {
  const pinRef = useRef(null);
  const tagRef = useRef(null);

  useEffect(() => {
    const pin = pinRef.current;
    const tag = tagRef.current;
    if (!pin) return;

    const apply = (e) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Pin: scale + translate from centre to top-left.
      const bigW = Math.min(vw * 0.86, 760);
      const bigH = bigW * 0.25;
      const bigLeft = (vw - bigW) / 2;
      const bigTop  = (vh - bigH) / 2;

      const scale = (bigW / MINI_W) * (1 - e) + 1 * e;
      const left  = bigLeft * (1 - e) + MINI_LEFT * e;
      const top   = bigTop  * (1 - e) + MINI_TOP  * e;
      pin.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;

      // Once the pin reaches its corner, swap the ~2k SVG dots for real text.
      // CSS handles the fade — JS just toggles the class.
      pin.classList.toggle('pinned', e >= 0.97);

      if (!tag) return;
      // Tagline: only its POSITION morphs; font-size shrinks but stays readable.
      // translateX(-50%) is constant so it stays centred on the pin's centre
      // at both ends (big = viewport centre, mini = pin centre).
      const pinCentreBig  = vw / 2;
      const pinCentreMini = MINI_LEFT + MINI_W / 2;
      const tagBigTop  = bigTop + bigH + 24;     // 24px below big title
      const tagMiniTop = MINI_TOP + MINI_H + 4;  // tight gap under mini pin
      const tagLeft = pinCentreBig * (1 - e) + pinCentreMini * e;
      const tagTop  = tagBigTop    * (1 - e) + tagMiniTop    * e;
      tag.style.transform = `translate(${tagLeft}px, ${tagTop}px) translateX(-50%)`;
      tag.style.fontSize  = `${(1.2 * (1 - e) + 0.7 * e).toFixed(3)}rem`;
    };

    if (!morphOnScroll) { apply(1); return; }

    let pending = false;
    const update = () => {
      pending = false;
      const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const progress = window.scrollY / scrollable;
      const t = Math.min(1, Math.max(0, progress / MORPH_END));
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      apply(e);
    };
    const onScroll = () => { if (!pending) { pending = true; requestAnimationFrame(update); } };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
    };
  }, [morphOnScroll]);

  return (
    <>
      <Link ref={pinRef} to="/" className="title-pin" aria-label="Ensemble — home">
        <DotsTitle animate={morphOnScroll} />
        <span className="title-pin-text" aria-hidden="true">Ensemble</span>
      </Link>
      <span ref={tagRef} className="title-pin-tagline" aria-hidden="true">
        A shared score for the world.
      </span>
    </>
  );
}
