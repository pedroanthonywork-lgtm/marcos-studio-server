// Layout livre (sem modelo fixo): cada peça é um desenho em camadas gerado na hora — pela IA (Opus) quando o modo IA
// está ligado, ou pelo gerador local, que combina composições, cores e tipografia da marca de forma diferente a cada vez.
// Toda peça passa por sanitizeDesign: paleta e fontes da Marcos Motos, foto protagonista, área segura do Instagram, preço só o informado.

export type Tok = 'bg' | 'ink' | 'cone' | 'ember' | 'filament' | 'white' | 'black';
export type Anim = 'none' | 'fade' | 'rise' | 'slide-l' | 'slide-r' | 'zoom' | 'wipe' | 'pop';
export type Layer =
  | { t: 'photo'; i: number; x: number; y: number; w: number; h: number; r?: number; rot?: number; focusY?: number; frame?: 'none' | 'thin' | 'led' | 'polaroid'; enter?: Anim; delay?: number }
  | { t: 'text'; text: string; x: number; y: number; w: number; size: number; font: 'sans' | 'serif' | 'script'; weight?: number; color: Tok; align?: 'left' | 'center' | 'right'; rot?: number; upper?: boolean; tracking?: number; plate?: boolean; gradient?: boolean; enter?: Anim; delay?: number }
  | { t: 'shape'; kind: 'rect' | 'circle' | 'line' | 'glow' | 'ring' | 'stripe'; x: number; y: number; w: number; h: number; color: Tok; opacity?: number; r?: number; rot?: number; enter?: Anim; delay?: number }
  | { t: 'price'; text: string; x: number; y: number; scale?: number; style: 'pill' | 'tag' | 'burst'; enter?: Anim; delay?: number }
  | { t: 'logo'; x: number; y: number; w: number; enter?: Anim; delay?: number }
  | { t: 'handles'; x: number; y: number; size?: number; align?: 'left' | 'center' | 'right'; color?: Tok };
export type Design = { size: 'story' | 'feed'; name?: string; bg: { kind: 'solid' | 'gradient' | 'photo-blur'; a: Tok; b?: Tok; angle?: number; photo?: number }; layers: Layer[] };

export type DesignInput = {
  size: 'story' | 'feed'; photos: number; kicker?: string; headline: string; subline?: string; price?: string | null; cta?: string;
  campaign?: Campaign | null; seed: number; slide?: 'capa' | 'foto' | 'look' | 'info' | 'cta'; index?: number; total?: number;
};
export type Campaign = { id: string; name: string; word: string; tone: 'dark' | 'warm' | 'light'; accent: Tok; idea: string };

export const CANVAS = { story: { w: 1080, h: 1920, top: 230, bottom: 300 }, feed: { w: 1080, h: 1350, top: 60, bottom: 60 } } as const;
const TOKS: Tok[] = ['bg', 'ink', 'cone', 'ember', 'filament', 'white', 'black'];
const ANIMS: Anim[] = ['none', 'fade', 'rise', 'slide-l', 'slide-r', 'zoom', 'wipe', 'pop'];

const clamp = (v: unknown, a: number, b: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
const pick = <T,>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const txt = (v: unknown, max = 80) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Garante as regras da marca em qualquer desenho (da IA ou local). */
export function sanitizeDesign(raw: any, ctx: { photos: number; prices: string[]; size: 'story' | 'feed' }): Design {
  const C = CANVAS[ctx.size];
  const W = C.w, H = C.h;
  const layers: Layer[] = [];
  for (const l of (Array.isArray(raw?.layers) ? raw.layers : []).slice(0, 28)) {
    const base = { x: clamp(l.x, -200, W, 0), y: clamp(l.y, -200, H, 0), enter: pick(l.enter, ANIMS, 'fade'), delay: clamp(l.delay, 0, 60, 0) };
    if (l.t === 'photo' && ctx.photos > 0) layers.push({ ...base, t: 'photo', i: Math.floor(clamp(l.i, 0, ctx.photos - 1, 0)), w: clamp(l.w, 120, W + 200, W), h: clamp(l.h, 120, H + 200, H), r: clamp(l.r, 0, 600, 0), rot: clamp(l.rot, -12, 12, 0), focusY: clamp(l.focusY, 0, 1, 0.5), frame: pick(l.frame, ['none', 'thin', 'led', 'polaroid'] as const, 'none') });
    else if (l.t === 'text' && txt(l.text)) layers.push({ ...base, t: 'text', text: txt(l.text), w: clamp(l.w, 120, W, W - 160), size: clamp(l.size, 18, 260, 60), font: pick(l.font, ['sans', 'serif', 'script'] as const, 'sans'), weight: clamp(l.weight, 300, 900, 800), color: pick(l.color, TOKS, 'white'), align: pick(l.align, ['left', 'center', 'right'] as const, 'left'), rot: clamp(l.rot, -90, 90, 0), upper: Boolean(l.upper), tracking: clamp(l.tracking, -0.08, 0.6, 0), plate: Boolean(l.plate), gradient: Boolean(l.gradient) });
    else if (l.t === 'shape') layers.push({ ...base, t: 'shape', kind: pick(l.kind, ['rect', 'circle', 'line', 'glow', 'ring', 'stripe'] as const, 'rect'), w: clamp(l.w, 2, W * 2, 100), h: clamp(l.h, 2, H * 2, 100), color: pick(l.color, TOKS, 'cone'), opacity: clamp(l.opacity, 0, 1, 1), r: clamp(l.r, 0, 999, 0), rot: clamp(l.rot, -90, 90, 0) });
    else if (l.t === 'price') { const p = txt(l.text, 20); if (p && ctx.prices.includes(p)) layers.push({ ...base, t: 'price', text: p, scale: clamp(l.scale, 0.5, 2, 1), style: pick(l.style, ['pill', 'tag', 'burst'] as const, 'pill') }); } // preço só o informado
    else if (l.t === 'logo') layers.push({ ...base, t: 'logo', w: clamp(l.w, 120, 700, 240) });
    else if (l.t === 'handles') layers.push({ t: 'handles', x: base.x, y: base.y, size: clamp(l.size, 18, 40, 26), align: pick(l.align, ['left', 'center', 'right'] as const, 'left'), color: pick(l.color, TOKS, 'white') });
  }
  // a roupa é protagonista: pelo menos uma foto grande (≥ 30% da tela)
  const photoArea = layers.filter((l) => l.t === 'photo').reduce((a, l: any) => Math.max(a, l.w * l.h), 0);
  /* produto em destaque (≈ 25%) não ganha cópia no fundo */ if (ctx.photos > 0 && photoArea < W * H * 0.2) layers.unshift({ t: 'photo', i: 0, x: 0, y: 0, w: W, h: H * 0.7, enter: 'fade' });
  if (!layers.some((l) => l.t === 'logo')) layers.push({ t: 'logo', x: W / 2 - 110, y: ctx.size === 'story' ? 80 : 40, w: 220, enter: 'fade' });
  const bg = raw?.bg ?? {};
  return { size: ctx.size, name: txt(raw?.name, 40) || undefined, bg: { kind: pick(bg.kind, ['solid', 'gradient', 'photo-blur'] as const, 'solid'), a: pick(bg.a, TOKS, 'bg'), b: pick(bg.b, TOKS, 'black'), angle: clamp(bg.angle, 0, 360, 160), photo: ctx.photos ? Math.floor(clamp(bg.photo, 0, ctx.photos - 1, 0)) : undefined }, layers };
}

// ───────── Gerador local (sem IA): composições diferentes a cada semente ─────────
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0; return s / 4294967296; }; }

export const COMPOSITIONS = ['produto3d', 'sangria', 'dividido', 'revista', 'polaroid', 'circulo', 'diagonal', 'mosaico', 'tipografia', 'painel', 'faixas'] as const;

export function localDesign(inp: DesignInput): Design {
  const R = rng(inp.seed);
  const r = (a: number, b: number) => a + R() * (b - a);
  const one = <T,>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)];
  const C = CANVAS[inp.size];
  const W = C.w, H = C.h, top = C.top, bot = C.bottom;
  const story = inp.size === 'story';
  const camp = inp.campaign;
  const accent: Tok = camp?.accent ?? one(['cone', 'cone', 'filament', 'ember'] as Tok[]);
  const dark = camp?.tone !== 'light';
  const ink: Tok = dark ? 'white' : 'ink';
  const emph = one(['serif', 'serif', 'sans', 'script'] as const);
  const anim = () => one(['rise', 'slide-l', 'slide-r', 'zoom', 'wipe', 'fade', 'pop'] as Anim[]);
  const L: Layer[] = [];
  const kicker = (inp.kicker ?? '').toUpperCase();
  const words = inp.headline.split(' ');
  const head1 = words.length > 2 ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : words[0];
  const head2 = words.length > 2 ? words.slice(Math.ceil(words.length / 2)).join(' ') : words.slice(1).join(' ');
  const comps: (typeof COMPOSITIONS)[number][] = inp.photos >= 3 ? [...COMPOSITIONS] : COMPOSITIONS.filter((c) => c !== 'mosaico' && c !== 'polaroid' || inp.photos >= 2);
  // Marcos Motos (tech): produto em destaque sai com mais frequência
  const comp = inp.slide === 'cta' ? 'cta' : inp.slide === 'info' ? 'info' : R() < 0.35 ? 'produto3d' : one(comps);
  // palavra gigante sempre cabe na largura (Inter 900 ≈ 0,62 em por letra)
  const fit = (word: string, want: number, width = W + 40) => Math.min(want, width / Math.max(1, word.length * 0.62));
  const textBlock = (x: number, y: number, w: number, align: 'left' | 'center' | 'right', size: number, plate = false) => {
    // o bloco inteiro (chamada, título, apoio, preço) termina acima da área segura de baixo; se subir sobre a foto, ganha placa escura
    // nomes longos de produto (ex.: CG 160 Titan 0km 2026 Vermelha) diminuem para caber em até 2 linhas
    if (inp.headline.length > 16) size = size * Math.max(0.5, 16 / inp.headline.length) * 1.25;
    const est = (kicker ? 50 : 0) + size * 0.98 + (head2 ? size * 1.12 : 0) + (inp.subline ? 82 : 0) + (inp.price ? 170 : 0);
    if (y + est > H - bot) { y = H - bot - est; plate = true; }
    let yy = y;
    if (kicker) { L.push({ t: 'text', text: kicker, x, y: yy, w, size: 26, font: 'sans', weight: 700, color: accent, align, upper: true, tracking: 0.32, enter: 'fade', delay: 6, plate }); yy += 50; }
    L.push({ t: 'text', text: head1, x, y: yy, w, size, font: 'sans', weight: 800, color: ink, align, tracking: -0.045, enter: anim(), delay: 10, plate });
    yy += size * 0.98;
    if (head2) { L.push({ t: 'text', text: head2, x, y: yy, w, size: size * r(0.95, 1.15), font: emph, weight: 500, color: accent, align, gradient: emph === 'serif', enter: anim(), delay: 16, plate }); yy += size * 1.12; }
    if (inp.subline) { L.push({ t: 'text', text: inp.subline, x, y: yy + 12, w, size: 36, font: 'sans', weight: 400, color: ink, align, enter: 'fade', delay: 24, plate }); yy += 70; }
    if (inp.price) L.push({ t: 'price', text: inp.price, x: align === 'center' ? x + w / 2 - 180 : align === 'right' ? x + w - 380 : x, y: yy + 26, scale: r(0.9, 1.15), style: one(['pill', 'tag', 'burst'] as const), enter: 'pop', delay: 30 });
    return yy;
  };
  const logo = (pos: 'top' | 'corner' | 'bottom') => L.push({ t: 'logo', x: pos === 'corner' ? 70 : W / 2 - 120, y: pos === 'bottom' ? (story ? H - bot + 30 : H - 105) : story ? 80 : 40, w: pos === 'corner' ? 190 : story ? 240 : 200, enter: 'fade' });
  const handles = (y: number) => L.push({ t: 'handles', x: W / 2, y, size: 26, align: 'center', color: ink });
  let bg: Design['bg'] = { kind: 'gradient', a: 'bg', b: 'black', angle: r(140, 220) };

  if (comp === 'produto3d') {
    // produto flutuando com anel de LED, leve inclinação 3D e preço grande (tech / iOS)
    const d = r(640, 760);
    L.push({ t: 'shape', kind: 'glow', x: W / 2 - d * 0.8, y: top + 40, w: d * 1.6, h: d * 1.6, color: accent, opacity: 0.45, enter: 'fade' });
    L.push({ t: 'shape', kind: 'ring', x: W / 2 - d / 2 - 30, y: top + 110, w: d + 60, h: d + 60, color: accent, r: 999, enter: 'zoom', delay: 4 });
    L.push({ t: 'photo', i: 0, x: W / 2 - d * 0.42, y: top + 150, w: d * 0.84, h: d * 1.05, r: 44, rot: r(-6, 6), focusY: 0.5, frame: 'led', enter: 'zoom', delay: 8 });
    L.push({ t: 'shape', kind: 'line', x: 90, y: top + 210 + d * 1.05, w: W - 180, h: 2, color: accent, opacity: 0.7, enter: 'wipe', delay: 14 });
    textBlock(90, top + 250 + d * 1.05, W - 180, one(['left', 'center'] as const), r(96, 120));
    logo('corner');
  } else if (comp === 'sangria') {
    L.push({ t: 'photo', i: 0, x: 0, y: 0, w: W, h: H, focusY: r(0.35, 0.6), enter: 'zoom' });
    L.push({ t: 'shape', kind: 'rect', x: 0, y: H * 0.5, w: W, h: H * 0.5, color: 'black', opacity: 0.62, enter: 'fade' });
    if (camp) L.push({ t: 'text', text: camp.word, x: -20, y: H * r(0.3, 0.4), w: W + 40, size: fit(camp.word, r(170, 230)), font: 'sans', weight: 900, color: accent, align: 'center', upper: true, tracking: -0.06, enter: 'wipe', delay: 4 });
    textBlock(80, H - bot - (inp.price ? 520 : 420), W - 160, one(['left', 'center'] as const), r(104, 128));
    logo(one(['top', 'corner'] as const));
  } else if (comp === 'dividido') {
    const cut = r(0.52, 0.64);
    const up = R() > 0.5;
    L.push({ t: 'photo', i: 0, x: 0, y: up ? 0 : H * (1 - cut), w: W, h: H * cut, r: 0, focusY: 0.45, enter: 'wipe' });
    L.push({ t: 'shape', kind: 'line', x: 80, y: up ? H * cut + 40 : H * (1 - cut) - 44, w: r(160, 320), h: 5, color: accent, enter: 'wipe', delay: 8 });
    textBlock(80, up ? H * cut + 80 : top + 40, W - 160, 'left', r(96, 116));
    logo(up ? 'corner' : 'bottom');
    bg = { kind: 'solid', a: dark ? 'bg' : 'white' };
  } else if (comp === 'revista') {
    const m = r(50, 90);
    const py = story ? top - 60 : 150;
    L.push({ t: 'photo', i: 0, x: m, y: py, w: W - m * 2, h: H * (story ? r(0.55, 0.62) : 0.52), frame: 'thin', focusY: 0.4, enter: 'rise' });
    const word = camp?.word ?? String((inp.index ?? 0) + 1).padStart(2, '0');
    L.push({ t: 'text', text: word, x: m - 10, y: Math.max(story ? top - 140 : 10, py - 150), w: W, size: fit(word, story ? r(180, 260) : 150, W - m), font: 'serif', weight: 500, color: accent, align: 'left', gradient: true, enter: 'slide-l', delay: 6 });
    L.push({ t: 'text', text: 'MARCOS MOTOS', x: W - 70, y: top + 200, w: 600, size: 22, font: 'sans', weight: 700, color: ink, rot: 90, tracking: 0.5, upper: true, enter: 'fade', delay: 12 });
    textBlock(m + 10, py + H * (story ? 0.6 : 0.52) + 40, W - m * 2, 'left', story ? r(92, 112) : r(70, 84));
    logo('bottom');
  } else if (comp === 'polaroid') {
    const n = Math.min(3, inp.photos);
    for (let k = 0; k < n; k++) L.push({ t: 'photo', i: k, x: r(70, 300) + k * r(-40, 60), y: top + k * r(170, 240), w: r(560, 680), h: r(640, 760), rot: r(-9, 9), frame: 'polaroid', enter: 'pop', delay: k * 7 });
    textBlock(80, H - bot - (inp.price ? 470 : 380), W - 160, 'left', r(96, 112), true);
    logo('corner');
    bg = { kind: 'gradient', a: 'bg', b: accent === 'cone' ? 'black' : 'bg', angle: r(0, 360) };
  } else if (comp === 'circulo') {
    const d = r(700, 860);
    L.push({ t: 'shape', kind: 'glow', x: W / 2 - d * 0.75, y: top + 60 - d * 0.25, w: d * 1.5, h: d * 1.5, color: accent, opacity: 0.35, enter: 'fade' });
    L.push({ t: 'photo', i: 0, x: W / 2 - d / 2, y: top + 120, w: d, h: d, r: d / 2, focusY: 0.45, enter: 'zoom' });
    L.push({ t: 'shape', kind: 'ring', x: W / 2 - d / 2 - 18, y: top + 102, w: d + 36, h: d + 36, color: accent, r: 999, enter: 'fade', delay: 8 });
    textBlock(80, top + 160 + d, W - 160, 'center', r(92, 110));
    logo('top');
  } else if (comp === 'diagonal') {
    L.push({ t: 'photo', i: 0, x: 0, y: 0, w: W, h: H, focusY: 0.4, enter: 'zoom' });
    L.push({ t: 'shape', kind: 'stripe', x: -300, y: H * r(0.56, 0.64), w: W + 600, h: r(380, 470), color: accent === 'filament' ? 'black' : 'black', opacity: 0.86, rot: r(-9, -5), enter: 'wipe', delay: 4 });
    L.push({ t: 'shape', kind: 'stripe', x: -300, y: H * 0.56 - 30, w: W + 600, h: 14, color: accent, rot: r(-9, -5), enter: 'wipe', delay: 8 });
    textBlock(90, H * 0.6, W - 180, 'left', r(96, 118));
    logo('corner');
  } else if (comp === 'mosaico') {
    const g = 14, y0 = top - 40, hh = H * 0.62;
    const big = R() > 0.5;
    L.push({ t: 'photo', i: 0, x: 40, y: y0, w: big ? W * 0.58 : W - 80, h: big ? hh : hh * 0.55, r: 22, enter: 'rise' });
    L.push({ t: 'photo', i: 1, x: big ? 40 + W * 0.58 + g : 40, y: big ? y0 : y0 + hh * 0.55 + g, w: big ? W - 80 - W * 0.58 - g : (W - 80 - g) / 2, h: big ? (hh - g) / 2 : hh * 0.45 - g, r: 22, enter: 'rise', delay: 5 });
    L.push({ t: 'photo', i: Math.min(2, inp.photos - 1), x: big ? 40 + W * 0.58 + g : 40 + (W - 80 - g) / 2 + g, y: big ? y0 + (hh + g) / 2 : y0 + hh * 0.55 + g, w: big ? W - 80 - W * 0.58 - g : (W - 80 - g) / 2, h: big ? (hh - g) / 2 : hh * 0.45 - g, r: 22, enter: 'rise', delay: 10 });
    textBlock(80, y0 + hh + 50, W - 160, 'left', r(92, 108));
    logo('top');
  } else if (comp === 'tipografia') {
    const big = (camp?.word ?? head1).toUpperCase();
    L.push({ t: 'text', text: big, x: -40, y: story ? top - 40 : 30, w: W + 80, size: fit(big, story ? r(220, 300) : 180), font: 'sans', weight: 900, color: accent, align: 'center', tracking: -0.07, enter: 'wipe' });
    L.push({ t: 'photo', i: 0, x: r(90, 160), y: story ? top + 200 : 230, w: W - r(180, 320), h: H * (story ? 0.42 : 0.5), r: r(24, 60), rot: r(-4, 4), enter: 'rise', delay: 6 });
    textBlock(80, (story ? top + 230 : 260) + H * (story ? 0.42 : 0.5), W - 160, 'center', story ? r(80, 98) : r(64, 76));
    if (story) logo('corner');
  } else if (comp === 'painel') {
    const pw = W * r(0.56, 0.64);
    const right = R() > 0.4;
    L.push({ t: 'photo', i: 0, x: right ? W - pw : 0, y: 0, w: pw, h: H, focusY: 0.45, enter: right ? 'slide-l' : 'slide-r' });
    L.push({ t: 'shape', kind: 'line', x: right ? W - pw - 6 : pw, y: 0, w: 6, h: H, color: accent, enter: 'wipe', delay: 6 });
    textBlock(right ? 60 : pw + 40, H * 0.4, W - pw - 100, 'left', r(64, 80));
    L.push({ t: 'logo', x: right ? 60 : pw + 40, y: story ? 100 : 50, w: 170, enter: 'fade' });
  } else if (comp === 'faixas') {
    L.push({ t: 'photo', i: 0, x: 0, y: 0, w: W, h: H, focusY: 0.45, enter: 'zoom' });
    const word = (camp?.word ?? inp.kicker ?? 'MOTOS').toUpperCase();
    for (const yy of [top - 20, H - bot - 40]) {
      L.push({ t: 'shape', kind: 'rect', x: -20, y: yy, w: W + 40, h: 84, color: accent, opacity: 0.95, rot: r(-3, 3), enter: 'wipe' });
      L.push({ t: 'text', text: `${word} · ${word} · ${word} · ${word}`, x: -20, y: yy + 16, w: W + 600, size: 46, font: 'sans', weight: 900, color: 'black', align: 'left', upper: true, tracking: 0.04, rot: r(-3, 3), enter: 'slide-l', delay: 4 });
    }
    textBlock(80, H * 0.52, W - 160, 'left', r(96, 116), true);
    L.push({ t: 'logo', x: W - 260, y: top + 100, w: 190, enter: 'fade' });
  } else if (comp === 'info') {
    bg = { kind: 'gradient', a: 'bg', b: 'black', angle: r(120, 240) };
    L.push({ t: 'shape', kind: 'glow', x: r(-300, 300), y: r(-300, 200), w: 900, h: 900, color: accent, opacity: 0.3 });
    L.push({ t: 'shape', kind: 'line', x: 90, y: H * 0.3, w: 140, h: 5, color: accent, enter: 'wipe' });
    textBlock(90, H * 0.3 + 50, W - 180, 'left', r(96, 120));
    logo('bottom');
  } else { // cta
    bg = { kind: 'gradient', a: 'bg', b: 'black', angle: 180 };
    L.push({ t: 'shape', kind: 'glow', x: W / 2 - 500, y: H * 0.18, w: 1000, h: 1000, color: accent, opacity: 0.35 });
    L.push({ t: 'logo', x: W / 2 - 260, y: H * 0.3, w: 520, enter: 'zoom' });
    L.push({ t: 'text', text: inp.headline || 'Motos de qualidade e melhor preço é aqui', x: 80, y: H * 0.3 + 300, w: W - 160, size: 76, font: 'serif', weight: 500, color: accent, align: 'center', gradient: true, enter: 'rise', delay: 8 });
    handles(H * 0.3 + 440);
  }
  if (comp !== 'cta' && story) handles(H - 150);
  return sanitizeDesign({ size: inp.size, name: comp, bg, layers: L }, { photos: inp.photos, prices: inp.price ? [inp.price] : [], size: inp.size });
}

// ───────── Datas comerciais (sugestões de campanha) ─────────
export type Season = Campaign & { month: number; day: number; lead: number };
export const SEASONS: Season[] = [
  { id: 'verao', name: 'Liquidação de verão', word: 'SALE', tone: 'warm', accent: 'cone', idea: 'Peças leves e cores claras com condição especial.', month: 1, day: 10, lead: 20 },
  { id: 'carnaval', name: 'Carnaval', word: 'CARNAVAL', tone: 'warm', accent: 'ember', idea: 'Looks para curtir: bonés, óculos, regatas.', month: 2, day: 14, lead: 21 },
  { id: 'mulher', name: 'Dia da Mulher', word: 'ELAS', tone: 'warm', accent: 'filament', idea: 'Coleção feminina e mensagem de valorização.', month: 3, day: 8, lead: 10 },
  { id: 'consumidor', name: 'Dia do Consumidor', word: '15/03', tone: 'dark', accent: 'cone', idea: 'Condições especiais para clientes fiéis.', month: 3, day: 15, lead: 10 },
  { id: 'maes', name: 'Dia das Mães', word: 'MÃE', tone: 'warm', accent: 'filament', idea: 'Sugestões de presente com preço informado.', month: 5, day: 10, lead: 21 },
  { id: 'namorados', name: 'Dia dos Namorados', word: 'AMOR', tone: 'warm', accent: 'ember', idea: 'Presentes para ele e para ela, perfumes e relógios.', month: 6, day: 12, lead: 18 },
  { id: 'inverno', name: 'Coleção de inverno', word: 'INVERNO', tone: 'dark', accent: 'filament', idea: 'Jaquetas, moletons e sobreposições.', month: 6, day: 21, lead: 25 },
  { id: 'pais', name: 'Dia dos Pais', word: 'PAI', tone: 'dark', accent: 'cone', idea: 'Camisas, relógios, perfumes e acessórios masculinos.', month: 8, day: 9, lead: 21 },
  { id: 'cliente', name: 'Dia do Cliente', word: 'VOCÊ', tone: 'dark', accent: 'cone', idea: 'Agradecimento e condição especial.', month: 9, day: 15, lead: 10 },
  { id: 'primavera', name: 'Primavera-Verão', word: 'NOVA ESTAÇÃO', tone: 'warm', accent: 'filament', idea: 'Lançamento da coleção primavera-verão.', month: 9, day: 22, lead: 14 },
  { id: 'criancas', name: 'Dia das Crianças', word: 'KIDS', tone: 'warm', accent: 'ember', idea: 'Linha infantil e presentes.', month: 10, day: 12, lead: 14 },
  { id: 'blackfriday', name: 'Black Friday', word: 'BLACK FRIDAY', tone: 'dark', accent: 'cone', idea: 'Contagem regressiva, ofertas por categoria; preço só o informado pela loja.', month: 11, day: 27, lead: 25 },
  { id: 'natal', name: 'Natal', word: 'NATAL', tone: 'warm', accent: 'filament', idea: 'Presentes por faixa de preço e horário estendido.', month: 12, day: 25, lead: 30 },
  { id: 'reveillon', name: 'Réveillon', word: '2027', tone: 'dark', accent: 'filament', idea: 'Looks brancos e dourados para a virada.', month: 12, day: 31, lead: 14 },
];

/** Próximas datas (até 75 dias), da mais próxima para a mais distante. */
export function upcomingSeasons(today = new Date(), horizonDays = 75) {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return SEASONS.map((s) => {
    let d = new Date(today.getFullYear(), s.month - 1, s.day);
    if (d.getTime() < t0) d = new Date(today.getFullYear() + 1, s.month - 1, s.day);
    const days = Math.round((d.getTime() - t0) / 86_400_000);
    return { ...s, date: d.toISOString().slice(0, 10), days, startPosting: Math.max(0, days - s.lead) };
  }).filter((s) => s.days <= horizonDays).sort((a, b) => a.days - b.days);
}
