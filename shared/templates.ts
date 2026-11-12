// Catálogo de templates e parâmetros compartilhado por interface, servidor, composições Remotion e motor local.
// Os parâmetros de uma versão são a fonte da verdade: mesma entrada → mesma arte (prévia = render).

export type Style = 'essential' | 'boutique' | 'ios' | 'led' | 'motion';
export type FontKey = 'cormorant' | 'manrope' | 'pinyon';
export type Accent = 'ouro' | 'cone' | 'marfim';
import type { Design } from './design.ts';
export type MediaRef = { id: string; url?: string; w?: number; h?: number; video?: boolean };

/** Link entregue por DM automática: quem responder ao Story (ou comentar no post/Reel) a palavra-chave recebe o link por mensagem. */
export type DmLink = { keyword: string; url: string; message?: string };
/** Música do catálogo oficial do Instagram (Audio API): o nome aparece no Reel publicado, nada é embutido no arquivo. */
export type IgAudio = { id: string; title: string; artist?: string };
/** Comum a todas as peças: variação (0 = padrão fixo, 1 = máxima dentro da marca) e semente que fixa o sorteio da versão. */
export type Variety = { variation?: number; seed?: number; dmLink?: DmLink | null;
  /** publicar nas 3 lojas: post/carrossel/Reel em collab (a unidade da produção convida as outras); Story é publicado em cada conta */
  allUnits?: boolean;
  /** @ de todas as lojas (o servidor preenche) */
  handles?: string[];
  /** peça de moto (template sem IA da Marcos Motos): quando existe, o motor usa public/moto/* no lugar da composição Remotion */
  moto?: MotoInfo | null };

/** Templates sem IA da Marcos Motos. Campo vazio = não aparece. Nada é inventado: só o que o lojista preencher. */
export type MotoInfo = {
  peca: 'card' | 'entrega' | 'video';
  estilo?: 'estudio' | 'ripado'; foco?: string;
  modelo?: string; ano?: string; selo?: string; preco?: string; extras?: string[]; direita?: string[]; semWhatsapp?: boolean;
  nome?: string; motoEntregue?: string; etiqueta?: string; legenda?: string;
  estiloVideo?: 'pista' | 'garagem' | 'vitrine'; musica?: string; semRonco?: boolean;
};
export type MotoParams = Params & { moto: MotoInfo };
export const WHATSAPP = '(34) 99806-6037';
export const SELOS = ['PRONTA ENTREGA', 'OPORTUNIDADE', 'IMPERDÍVEL'];
export const MUSICAS = ['make-funk', 'make-money', 'hip-hop-driver', 'poor-but-happy', 'sleep', 'city-in-the-rearview', 'make-love', 'blue-skies', 'dream-pop', 'windows-down'];
/** "21500" → "R$ 21.500"; texto com R$ fica como está. */
export function fmtPreco(p?: string | null) {
  let s = (p ?? '').trim();
  if (!s) return '';
  const d = s.replace(/\./g, '');
  if (/^\d+(,\d+)?$/.test(d)) { const [i, c] = d.split(','); s = Number(i).toLocaleString('pt-BR') + (c ? ',' + c : ''); }
  return /^R\$/i.test(s) ? s : 'R$ ' + s;
}
export function legendaEntrega(nome?: string, moto?: string) {
  const n = (nome ?? '').trim(), m = (moto ?? '').trim();
  return (m ? `Parabéns pela linda ${m}${n ? ' ' + n : ''}! ` : n ? `Parabéns, ${n}! ` : '') + 'Deus abençoe sua conquista 🙏\n\n📍 Marcos Motos — Av. Brasil, 51, São Gotardo-MG\n💬 WhatsApp (34) 99806-6037';
}

export type StoryKind = 'abertura' | 'abertos' | 'bomdia' | 'novidades' | 'promocao' | 'lancamento' | 'campanha' | 'produto' | 'evento' | 'aviso';
export type StoryParams = {
  type: 'story'; style: Style; kind: StoryKind; photo: MediaRef | null; kicker: string; headline: string; subline: string;
  price: string | null; cta: string; unitName: string; instagram: string; font: FontKey; glow: number; accent: Accent; animated: boolean;
  priceAnimation: boolean;
  /** colagem: 2 a 6 fotos em grade estilo Instagram (photos[0] = photo) */
  layout?: 'foto' | 'colagem'; photos?: MediaRef[];
  /** a mídia principal é vídeo (o servidor confere pelo arquivo): Story sai em MP4 com a duração do vídeo */
  photoVideo?: boolean; videoDuration?: number;
  /** duração do Story em vídeo (10 ou 15 s); foto parada fica 5 s no Instagram */
  seconds?: number;
  /** layout livre gerado na hora (IA ou gerador local); quando existe, substitui o estilo de modelo */
  design?: Design | null;
} & Variety;

export type SlideKind = 'capa' | 'foto' | 'look' | 'info' | 'cta';
export type Slide = { kind: SlideKind; photo?: MediaRef | null; title?: string; text?: string; price?: string | null };
export type CarouselModel = 'colecao-semana' | 'novidades' | 'cinco-looks' | 'lancamentos' | 'destaques' | 'promocoes' | 'institucional' | 'educativo';
export type CarouselParams = {
  type: 'carousel'; model: CarouselModel; style: Style; title: string; collection: string; slides: Slide[]; unitName: string; instagram: string;
  font: FontKey; glow: number; accent: Accent;
  /** layout livre por slide (mesmo índice de slides) */
  designs?: (Design | null)[];
} & Variety;

export type ReelMode = 'rapido' | 'premium' | 'cinematic';
/** zoom ≥1 e focusY 0..1 reenquadram a origem (ex.: tirar uma faixa de texto já gravada no vídeo). */
export type ReelClip = { media: MediaRef; in?: number; out?: number; label?: string; zoom?: number; focusY?: number; captions?: boolean };
export type Caption = { from: number; to: number; text: string; emphasis?: boolean };
export type ReelParams = {
  type: 'reel'; mode: ReelMode; style: Style; clips: ReelClip[]; title: string; collection: string; products: { name: string; price?: string | null }[];
  pace: number; glow: number; font: FontKey; accent: Accent; priceAnimation: boolean; music: MediaRef | null; keepOriginalAudio: boolean;
  unitName: string; instagram: string; durationTarget: number;
  /** timeline calculada pelo motor (análise de segmentos); a prévia usa uma estimativa enquanto ela não existe */
  timeline?: { src: string; from: number; dur: number; label?: string; zoom?: number; focusY?: number; precut?: boolean }[];
  /** legendas palavra a palavra (transcrição local via editonny), em segundos da timeline final */
  captions?: Caption[];
  /** 'briefing': o motor só renderiza depois que o plano de edição for aprovado */
  review?: 'auto' | 'briefing';
  /** pedido livre de edição (conversa com a IA), sempre dentro da marca */
  brief?: string;
  audio?: IgAudio | null;
  /** intensidade de motion: calm (suave), dynamic (padrão), max (motion graphic forte) */
  motion?: 'calm' | 'dynamic' | 'max';
} & Variety;

export type Params = StoryParams | CarouselParams | ReelParams;

export const STYLES: { id: Style; name: string; desc: string }[] = [
  { id: 'essential', name: 'Essential', desc: 'Limpo e elegante. A foto fala.' },
  { id: 'boutique', name: 'Boutique', desc: 'Editorial, serifada, respiro de revista.' },
  { id: 'ios', name: 'iOS', desc: 'Vidro, profundidade, reflexos e ícones.' },
  { id: 'led', name: 'LED', desc: 'Contorno de luz quente, energia Marcos Motos.' },
  { id: 'motion', name: 'Motion', desc: 'Entradas e luz em movimento.' },
];

export const STORY_KINDS: { id: StoryKind; name: string; kicker: string; headline: string; subline: string; cta: string }[] = [
  { id: 'abertura', name: 'Abertura da loja', kicker: 'BOM DIA', headline: 'Portas abertas', subline: 'Venha conhecer as novidades', cta: 'Te esperamos' },
  { id: 'abertos', name: 'Estamos abertos', kicker: 'HOJE', headline: 'Estamos abertos', subline: 'Motos de qualidade e melhor preço é aqui', cta: 'Venha nos visitar' },
  { id: 'bomdia', name: 'Bom dia', kicker: 'BOM DIA', headline: 'Bom dia!', subline: 'Que hoje seja de autoestima', cta: '' },
  { id: 'novidades', name: 'Novidades', kicker: 'CHEGOU', headline: 'Novidades na loja', subline: 'Peças novas esta semana', cta: 'Confira na loja' },
  { id: 'promocao', name: 'Promoção', kicker: 'OFERTA', headline: 'Condição especial', subline: 'Por tempo limitado', cta: 'Chame no WhatsApp' },
  { id: 'lancamento', name: 'Lançamento', kicker: 'LANÇAMENTO', headline: 'Novo lançamento', subline: 'Já disponível na loja', cta: 'Venha ver de perto' },
  { id: 'campanha', name: 'Campanha', kicker: 'CAMPANHA', headline: 'Campanha Marcos Motos', subline: '', cta: 'Saiba mais na loja' },
  { id: 'produto', name: 'Produto', kicker: 'DESTAQUE', headline: 'Peça da semana', subline: '', cta: 'Reserve pelo WhatsApp' },
  { id: 'evento', name: 'Evento', kicker: 'EVENTO', headline: 'Um dia especial', subline: '', cta: 'Esperamos você' },
  { id: 'aviso', name: 'Aviso', kicker: 'AVISO', headline: 'Horário especial', subline: '', cta: '' },
];

export const CAROUSEL_MODELS: { id: CarouselModel; name: string; slides: SlideKind[] }[] = [
  { id: 'colecao-semana', name: 'Coleção da semana', slides: ['capa', 'foto', 'foto', 'foto', 'cta'] },
  { id: 'novidades', name: 'Novidades', slides: ['capa', 'foto', 'foto', 'foto', 'cta'] },
  { id: 'cinco-looks', name: 'Cinco looks', slides: ['capa', 'look', 'look', 'look', 'look', 'look', 'cta'] },
  { id: 'lancamentos', name: 'Lançamentos', slides: ['capa', 'foto', 'foto', 'info', 'cta'] },
  { id: 'destaques', name: 'Produtos em destaque', slides: ['capa', 'foto', 'foto', 'foto', 'cta'] },
  { id: 'promocoes', name: 'Promoções', slides: ['capa', 'foto', 'foto', 'info', 'cta'] },
  { id: 'institucional', name: 'Campanha institucional', slides: ['capa', 'info', 'foto', 'info', 'cta'] },
  { id: 'educativo', name: 'Moda: dicas', slides: ['capa', 'info', 'foto', 'info', 'cta'] },
];

export const REEL_MODES: { id: ReelMode; name: string; desc: string; shot: number; flashEvery: number }[] = [
  { id: 'rapido', name: 'Rápido', desc: 'Cortes limpos, assinatura e cartão final.', shot: 1.8, flashEvery: 0 },
  { id: 'premium', name: 'Premium', desc: 'Ritmo refinado, flash, cartões de produto.', shot: 2.0, flashEvery: 3 },
  { id: 'cinematic', name: 'Cinematic', desc: 'Luz, profundidade, títulos editoriais e LED.', shot: 2.4, flashEvery: 2 },
];

// Chaves mantidas por compatibilidade com versões já salvas; os valores seguem o site aprovado v3:
// manrope → Inter Tight (títulos 800), cormorant → Bodoni Moda itálico (palavra de destaque), pinyon → lockup caligráfico original.
export const FONT_FAMILY: Record<FontKey, string> = {
  cormorant: '"Onest", system-ui, sans-serif',
  manrope: '"Big Shoulders Display", "Onest", "Arial Narrow", sans-serif',
  pinyon: '"Onest", system-ui, sans-serif',
};
// ouro → filamento (luz quente), cone → laranja do cone, marfim → texto do site.
export const ACCENT: Record<Accent, string> = { ouro: '#FF5A4E', cone: '#E31B23', marfim: '#F7F3EE' };

export const STORY_SIZE = { width: 1080, height: 1920, fps: 30, frames: 180 } as const;
export const CAROUSEL_SIZE = { width: 1080, height: 1350 } as const;
export const REEL_SIZE = { width: 1080, height: 1920, fps: 30 } as const;

export function defaultStory(unit: { name: string; instagram: string }, kind: StoryKind = 'novidades', photo: MediaRef | null = null): StoryParams {
  const k = STORY_KINDS.find((s) => s.id === kind)!;
  return { type: 'story', style: 'boutique', kind, photo, kicker: k.kicker, headline: k.headline, subline: k.subline, price: null, cta: k.cta,
    unitName: unit.name, instagram: unit.instagram, font: 'manrope', glow: 0.5, accent: 'cone', animated: false, priceAnimation: false };
}

export function defaultCarousel(unit: { name: string; instagram: string }, model: CarouselModel = 'colecao-semana', photos: MediaRef[] = [], collection = 'Nova coleção'): CarouselParams {
  const m = CAROUSEL_MODELS.find((x) => x.id === model)!;
  let pi = 0;
  const slides: Slide[] = m.slides.map((kind, i) => {
    if (kind === 'capa') return { kind, photo: photos[pi++ % Math.max(1, photos.length)] ?? null, title: m.name, text: collection };
    if (kind === 'cta') return { kind, title: 'Motos de qualidade e melhor preço é aqui', text: `Visite a ${unit.name}` };
    if (kind === 'info') return { kind, title: model === 'educativo' ? 'Dica de estilo' : 'Na loja', text: '' };
    return { kind, photo: photos.length ? photos[pi++ % photos.length] : null, title: kind === 'look' ? `Look ${i}` : '', text: '', price: null };
  });
  return { type: 'carousel', model, style: 'boutique', title: m.name, collection, slides, unitName: unit.name, instagram: unit.instagram, font: 'manrope', glow: 0.45, accent: 'cone' };
}

export function defaultReel(unit: { name: string; instagram: string }, clips: ReelClip[] = [], mode: ReelMode = 'premium'): ReelParams {
  return { type: 'reel', mode, style: mode === 'cinematic' ? 'led' : 'boutique', clips, title: 'Novidades', collection: 'Novidades', products: [], pace: 1,
    glow: 0.5, font: 'manrope', accent: 'cone', priceAnimation: false, music: null, keepOriginalAudio: true, unitName: unit.name, instagram: unit.instagram,
    durationTarget: 20 };
}

/** Timeline estimada para a prévia (o motor substitui pela timeline medida nos arquivos). */
export function estimateTimeline(p: ReelParams, durations: Record<string, number> = {}): NonNullable<ReelParams['timeline']> {
  if (p.timeline?.length) return p.timeline;
  const mode = REEL_MODES.find((m) => m.id === p.mode)!;
  const shot = Math.max(0.8, mode.shot * p.pace);
  const out: NonNullable<ReelParams['timeline']> = [];
  if (!p.clips.length) return out;
  let t = 0, i = 0, guard = 0;
  const cursor: Record<string, number> = {};
  while (t < p.durationTarget - 3 && guard++ < 200) {
    const c = p.clips[i % p.clips.length];
    const key = c.media.id;
    const len = durations[key] ?? 10;
    const start = cursor[key] ?? (c.in ?? 0);
    const d = Math.min(shot, Math.max(0.5, (c.out ?? len) - start));
    out.push({ src: c.media.url ?? '', from: start, dur: d, label: c.label, zoom: c.zoom, focusY: c.focusY });
    cursor[key] = start + d >= (c.out ?? len) - 0.3 ? (c.in ?? 0) : start + d;
    t += d; i++;
  }
  return out;
}
