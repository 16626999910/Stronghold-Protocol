// Lobby opening (main.js, after the boot splash): black, a CRT power-on line, signal static with two sliding data bars,
// a cold fog with corner reticles where the game's own dot-matrix watchtower (screens/title.js EMBLEM) assembles dot by
// dot under the title — then the backdrop dissolves and the big emblem glides into the title screen's emblem (same
// size, same place: a FLIP from the measured target), so the opening ends on the page itself. Without a visible target
// emblem (server picker, a straight jump to the lobby) the opening fades out instead.
// Self-contained: plain DOM + an injected <style>, no media file. Plays on every load (owner's request, 2026-10-13),
// never over a restored match; a tap / click / key skips to the landing; prefers-reduced-motion gets a short fade.

const LIFT_AT = 4300;   // ms: the backdrop starts to dissolve and the emblem flies home
const FLIGHT = 900;     // ms of the flight

// the title screen's emblem bitmap (keep in step with screens/title.js EMBLEM)
const EMBLEM = [
  'XXX..XXX..XXX', 'XXX..XXX..XXX', 'XXXXXXXXXXXXX', '.XXXXXXXXXXX.', '..XXXXXXXXX..', '..XXXXXXXXX..', '..XXXX.XXXX..',
  '..XXXX.XXXX..', '..XXXXXXXXX..', '..XXXXXXXXX..', '..XXXXXXXXX..', '.XXXXXXXXXXX.', 'XXXXXXXXXXXXX', 'XXXXXXXXXXXXX',
];

function emblemSvg() {
  const rows = EMBLEM.length, dots = [];
  EMBLEM.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch !== 'X') return;
    const rad = 0.2 + (r / (rows - 1)) * 0.2;
    const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
    // assembly order: bottom row first, a little scatter inside a row; the green eyes light last
    const delay = accent ? 1120 : (rows - 1 - r) * 62 + ((c * 37 + r * 11) % 9) * 14;
    dots.push(`<circle cx="${c + 0.5}" cy="${r + 0.5}" r="${rad.toFixed(3)}" class="${accent ? 'is-accent' : ''}" style="animation-delay:${2000 + delay}ms" />`);
  }));
  return `<svg class="lintro__svg" viewBox="-0.5 -0.5 14 15" aria-hidden="true">${dots.join('')}</svg>`;
}

const CSS = `
.lintro{position:fixed;inset:0;z-index:2147483647;overflow:hidden;background:transparent;color:#e8f4f0;cursor:pointer;
  font-family:inherit;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;outline:0}
.lintro::backdrop{background:transparent}
.lintro__bg{position:absolute;inset:0;background:#000;transition:opacity .75s ease}
.lintro.is-lift .lintro__bg{opacity:0}
.lintro.is-lift{pointer-events:none}
.lintro.is-fade{transition:opacity .5s ease;opacity:0}
.lintro__line{position:absolute;left:50%;top:50%;width:0;height:2px;background:#f2fffb;box-shadow:0 0 12px #bff;
  transform:translate(-50%,-50%);animation:lintro-line .5s .15s ease-out forwards}
@keyframes lintro-line{0%{width:0;opacity:1}70%{width:100%;height:2px;opacity:1}100%{width:100%;height:100%;opacity:0}}
.lintro__noise{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;opacity:0;
  animation:lintro-noise 1.4s .5s linear forwards}
@keyframes lintro-noise{0%{opacity:0}12%{opacity:.55}70%{opacity:.4}100%{opacity:0}}
.lintro__bar{position:absolute;left:0;right:0;height:9%;display:flex;align-items:center;gap:2%;padding:0 4%;
  background:linear-gradient(90deg,rgba(20,30,34,.92),rgba(60,78,84,.75) 60%,rgba(20,30,34,.3));
  font:600 clamp(11px,1.6vw,18px)/1 ui-monospace,Consolas,monospace;letter-spacing:.2em;color:#cfe;
  transform:translateX(-105%);animation:lintro-bar 1s cubic-bezier(.2,.7,.2,1) forwards}
.lintro__bar b{font-size:1.9em;color:#fff;opacity:.85}
.lintro__bar--a{top:30%;animation-delay:.65s}
.lintro__bar--b{top:58%;animation-delay:.8s;animation-name:lintro-bar-r;transform:translateX(105%)}
@keyframes lintro-bar{0%{transform:translateX(-105%)}45%,70%{transform:translateX(0);opacity:1}100%{transform:translateX(0);opacity:0}}
@keyframes lintro-bar-r{0%{transform:translateX(105%)}45%,70%{transform:translateX(0);opacity:1}100%{transform:translateX(0);opacity:0}}
.lintro__fog{position:absolute;inset:-10%;opacity:0;
  background:radial-gradient(60% 50% at 50% 45%,rgba(120,150,160,.55),rgba(30,44,52,.9) 60%,#05090b 100%),
    repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 3px);
  animation:lintro-fog 1.6s 1.5s ease-out forwards,lintro-drift 6s 1.5s linear infinite}
@keyframes lintro-fog{to{opacity:1}}
@keyframes lintro-drift{from{transform:translateX(0)}to{transform:translateX(-3%)}}
.lintro__reticle{position:absolute;width:26px;height:26px;opacity:0;animation:lintro-in .4s 1.7s forwards}
.lintro__reticle::before,.lintro__reticle::after{content:"";position:absolute;background:#d8eef0}
.lintro__reticle::before{left:12px;top:0;width:2px;height:26px}
.lintro__reticle::after{left:0;top:12px;width:26px;height:2px}
.lintro__reticle--tl{left:5%;top:7%}.lintro__reticle--tr{right:5%;top:7%}
.lintro__reticle--bl{left:5%;bottom:7%}.lintro__reticle--br{right:5%;bottom:7%}
@keyframes lintro-in{to{opacity:.8}}
.lintro__mark{position:fixed;display:flex;align-items:center;transform-origin:50% 50%;will-change:transform}
.lintro.is-lift .lintro__mark{transition:transform ${FLIGHT}ms cubic-bezier(.65,0,.3,1);transform:none!important}
.lintro__svg{display:block;overflow:visible;filter:drop-shadow(0 0 .12rem rgba(210,255,240,.3))}
.lintro__svg circle{fill:#dfe6e2;transform-box:fill-box;transform-origin:50% 50%;animation:lintro-dot .38s cubic-bezier(.2,.9,.3,1.4) backwards}
.lintro__svg circle.is-accent{fill:#3dffc0;filter:drop-shadow(0 0 .3px #3dffc0);animation:lintro-eye .6s ease-out backwards}
@keyframes lintro-dot{from{opacity:0;transform:scale(0)}60%{opacity:1}to{opacity:1;transform:scale(1)}}
@keyframes lintro-eye{0%{opacity:0;transform:scale(0)}50%{opacity:1;transform:scale(2.1)}100%{opacity:1;transform:scale(1)}}
.lintro__br{flex:none;box-sizing:border-box;border:2px solid rgba(223,230,226,.45);opacity:0;animation:lintro-br .45s 3.25s cubic-bezier(.2,.8,.2,1) forwards}
.lintro__br--l{border-right:0;--from:-28px}.lintro__br--r{border-left:0;--from:28px}
@keyframes lintro-br{from{opacity:0;transform:translateX(var(--from))}to{opacity:1;transform:none}}
.lintro__text{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:1.2vh;transition:opacity .4s ease}
/* gone before the page's own title shows through the dissolving backdrop */
.lintro.is-lift .lintro__text{opacity:0;transition-duration:.15s}
.lintro__title{position:relative;font-weight:800;font-size:clamp(20px,4.2vh,42px);letter-spacing:.18em;color:#f4fffb;
  opacity:0;animation:lintro-glitch .7s 3.05s steps(1) forwards}
.lintro__title::before,.lintro__title::after{content:attr(data-t);position:absolute;inset:0;opacity:.7}
.lintro__title::before{color:#5ff0c8;transform:translateX(-3px);clip-path:inset(0 0 55% 0);animation:lintro-split .7s 3.05s steps(2) forwards}
.lintro__title::after{color:#ff7a5c;transform:translateX(3px);clip-path:inset(55% 0 0 0);animation:lintro-split .7s 3.05s steps(2) forwards}
@keyframes lintro-glitch{0%{opacity:0}10%{opacity:1;transform:translateX(6px)}25%{opacity:.3}40%{opacity:1;transform:translateX(-4px)}
  60%{opacity:1;transform:none}100%{opacity:1;transform:none}}
@keyframes lintro-split{0%,60%{opacity:.7}100%{opacity:0;transform:none}}
.lintro__sub{font:600 clamp(10px,1.5vh,15px)/1 ui-monospace,Consolas,monospace;letter-spacing:.42em;color:#9fd8c8;
  white-space:nowrap;clip-path:inset(0 100% 0 0);animation:lintro-type .8s 3.45s steps(30) forwards}
@keyframes lintro-type{to{clip-path:inset(0 0 0 0)}}
.lintro__dawn{position:absolute;inset:0;pointer-events:none;opacity:0;mix-blend-mode:screen;
  background:linear-gradient(0deg,rgba(255,140,40,.5),rgba(255,170,80,.22) 35%,transparent 70%)}
.lintro.is-lift .lintro__dawn{animation:lintro-dawn 1.3s ease-out}
@keyframes lintro-dawn{0%{opacity:0}40%{opacity:1}100%{opacity:0}}
.lintro__skip{position:absolute;right:4%;bottom:4%;font-size:12px;letter-spacing:.2em;color:rgba(220,240,236,.55)}
.lintro.is-lift .lintro__skip{opacity:0}
@media (prefers-reduced-motion: reduce){
  .lintro *{animation-duration:.01s!important;animation-delay:0s!important}
  .lintro__noise,.lintro__bar,.lintro__line{display:none}
}`;

/** The title screen's emblem when it is on screen: its box, the SVG's and a bracket's size and the gap between them. */
function findTarget() {
  const el = document.querySelector('.title-screen .emblem');
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const svg = el.querySelector('.emblem__svg')?.getBoundingClientRect();
  const br = el.querySelector('.emblem__bracket')?.getBoundingClientRect();
  if (!svg || !(box.width > 4 && box.height > 4) || getComputedStyle(el).display === 'none') return null;
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  return { el, box, svg, br, gap };
}

const mq = (q) => { try { return !!matchMedia(q).matches; } catch { return false; } };
/** A phone / tablet: a coarse (touch) pointer and no mouse. */
const touchDevice = () => (mq('(pointer: coarse)') || mq('(any-pointer: coarse)')) && !mq('(any-pointer: fine)');
/**
 * Phones play the opening only once the game is in landscape and fullscreen (owner's request, 2026-10-13): in portrait
 * or with the browser bars still showing it would play to a squeezed screen under the fullscreen prompt. Where the
 * page cannot go fullscreen (iPhone Safari) or runs as an installed app, landscape is enough.
 */
function phoneReady() {
  let land = null;
  try { const t = screen.orientation?.type; if (typeof t === 'string' && t) land = t.startsWith('landscape'); } catch { /* ignore */ }
  if (land === null && window.orientation != null && Number.isFinite(Number(window.orientation))) land = Math.abs(Number(window.orientation)) === 90;
  if (land === null) land = innerWidth > innerHeight;
  if (!land || innerWidth <= innerHeight) return false;
  const fsActive = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const fsPossible = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const standalone = mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || navigator.standalone === true;
  return fsActive || standalone || !fsPossible;
}

/**
 * Play the opening over the page — every load (owner's request, 2026-10-13); a restored match never gets it. On a
 * phone it waits for landscape + fullscreen (phoneReady) and plays the moment both hold.
 * @param {{ skip?: () => boolean, host?: string }} opts  skip() → true when it must not play (e.g. a restored match)
 */
export function playLobbyIntro(opts = {}) {
  const { skip = () => false } = opts;
  if (skip()) return;
  if (!touchDevice() || phoneReady()) { runIntro(opts); return; }
  const EVENTS = [[window, 'resize'], [window, 'orientationchange'], [document, 'fullscreenchange'], [document, 'webkitfullscreenchange']];
  let waiting = true;
  const check = () => {
    if (!waiting || !phoneReady()) return;
    waiting = false;
    EVENTS.forEach(([t, e]) => t.removeEventListener(e, check));
    // let the rotation / fullscreen settle (device.js re-fires resize once the viewport has its final size)
    setTimeout(() => { if (!skip()) runIntro(opts); }, 400);
  };
  EVENTS.forEach(([t, e]) => t.addEventListener(e, check));
}

function runIntro({ skip = () => false, host = '' } = {}) {
  const reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  // a modal <dialog>: the top layer, so it also covers the fullscreen prompt (fullscreen-guide.js, itself a modal
  // dialog opened earlier); that prompt is still there once the opening closes
  const el = document.createElement('dialog');
  el.className = 'lintro';
  el.setAttribute('aria-label', '卫戍协议：盟约');
  el.innerHTML = `<div class="lintro__bg">
      <canvas class="lintro__noise" width="160" height="90"></canvas>
      <div class="lintro__line"></div>
      <div class="lintro__bar lintro__bar--a"><b>01</b><span>SIGNAL · 链路握手</span></div>
      <div class="lintro__bar lintro__bar--b"><b>02</b><span>NODE · ${host ? host.replace(/[<>&"]/g, '') : '同步中'}</span></div>
      <div class="lintro__fog"></div>
      <i class="lintro__reticle lintro__reticle--tl"></i><i class="lintro__reticle lintro__reticle--tr"></i>
      <i class="lintro__reticle lintro__reticle--bl"></i><i class="lintro__reticle lintro__reticle--br"></i>
    </div>
    <div class="lintro__mark"><i class="lintro__br lintro__br--l"></i>${emblemSvg()}<i class="lintro__br lintro__br--r"></i></div>
    <div class="lintro__text">
      <span class="lintro__title" data-t="卫戍协议：盟约">卫戍协议：盟约</span>
      <span class="lintro__sub">STRONGHOLD PROTOCOL · ALLIANCE</span>
    </div>
    <div class="lintro__dawn"></div>
    <span class="lintro__skip">点击跳过</span>`;
  document.body.append(el);
  try { el.showModal(); } catch { el.setAttribute('open', ''); }

  // the emblem: laid out at the title screen's emblem (its exact size), shown enlarged at the centre by a transform;
  // the landing only drops the transform. No target: a default size, and the opening fades out at the end.
  const mark = el.querySelector('.lintro__mark'), svg = mark.querySelector('svg'), brs = mark.querySelectorAll('.lintro__br');
  const text = el.querySelector('.lintro__text');
  let target = findTarget();
  const place = () => {
    const vw = innerWidth, vh = innerHeight;
    const svgW = target ? target.svg.width : Math.min(130, vh * 0.16), svgH = target ? target.svg.height : svgW * 15 / 14;
    const brW = target?.br ? target.br.width : svgW * 0.12, brH = target?.br ? target.br.height : svgH * 1.2;
    const gap = target ? target.gap : svgW * 0.2;
    svg.style.width = `${svgW}px`; svg.style.height = `${svgH}px`;
    brs.forEach((b) => { b.style.width = `${brW}px`; b.style.height = `${brH}px`; });
    mark.style.gap = `${gap}px`;
    const w = svgW + 2 * brW + 2 * gap, h = Math.max(svgH, brH);
    const left = target ? target.box.left : (vw - w) / 2, top = target ? target.box.top : vh * 0.4 - h / 2;
    mark.style.left = `${left}px`; mark.style.top = `${top}px`;
    // the centre stage: about a third of the screen's height, a little above the middle
    const s = target ? Math.max(1, Math.min(3, (vh * 0.3) / h, (vw * 0.5) / w)) : 1;
    const dx = vw / 2 - (left + w / 2), dy = vh * 0.4 - (top + h / 2);
    mark.style.transform = `translate(${dx}px,${dy}px) scale(${s})`;
    text.style.top = `${vh * 0.4 + (h * s) / 2 + vh * 0.04}px`;
  };
  place();
  // hide the real emblem while ours stands in for it (it is under the backdrop until the landing anyway)
  if (target) target.el.style.visibility = 'hidden';

  // signal static: a 160×90 grey noise canvas, redrawn every other frame while it shows
  const cv = el.querySelector('canvas'), cx = cv.getContext('2d');
  const img = cx.createImageData(160, 90);
  let raf = 0, frame = 0;
  const noise = () => {
    if ((frame++ & 1) === 0) {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 200) | 0; d[i] = v * 0.85; d[i + 1] = v; d[i + 2] = v * 1.05; d[i + 3] = 255; }
      cx.putImageData(img, 0, 0);
    }
    if (frame < 120) raf = requestAnimationFrame(noise);
  };
  if (!reduced) raf = requestAnimationFrame(noise);

  let done = false;
  const cleanup = () => {
    if (target) target.el.style.visibility = '';
    try { el.close(); } catch { /* ignore */ }
    el.remove(); style.remove();
  };
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', finish);
    removeEventListener('resize', onResize);
    // a skip before the emblem stood up: show every dot now so the flight carries the whole emblem
    el.querySelectorAll('.lintro__svg circle, .lintro__br').forEach((n) => { n.style.animation = 'none'; n.style.opacity = '1'; });
    const fresh = findTarget();
    if (fresh && !reduced) {
      if (target?.el !== fresh.el) { if (target) target.el.style.visibility = ''; target = fresh; target.el.style.visibility = 'hidden'; place(); }
      void mark.offsetWidth;
      el.classList.add('is-lift');
      setTimeout(cleanup, Math.max(FLIGHT, 800) + 80);
    } else {
      el.classList.add('is-lift', 'is-fade');
      setTimeout(cleanup, 560);
    }
  };
  const onResize = () => { target = findTarget(); place(); };
  addEventListener('resize', onResize);
  el.addEventListener('pointerdown', finish);
  el.addEventListener('cancel', (e) => { e.preventDefault(); finish(); }); // Esc skips like any other key
  addEventListener('keydown', finish);
  setTimeout(finish, reduced ? 1200 : LIFT_AT);
}
