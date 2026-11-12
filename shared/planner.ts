// "Criar Minha Semana": transforma um pedido em português num plano de produção por dia e unidade.
// Horários são SUGESTÕES editoriais, não derivados de métricas (não há dados de desempenho autorizados).
import { CAROUSEL_MODELS, STORY_KINDS, type CarouselModel, type StoryKind } from './templates.ts';

export type PlanItem = { day: string; time: string; unitId: string; kind: 'story' | 'carousel' | 'reel'; template: string; title: string; caption: string; mediaIds: string[]; warning?: string };
export type PlanInput = { request: string; campaign?: string; unitIds: string[]; days: string[]; media: { id: string; kind: string }[]; units: Record<string, { name: string; instagram: string; address?: string | null; phone?: string | null }> };

const NUM: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function parseCounts(request: string) {
  const t = norm(request);
  const count = (re: RegExp) => {
    const m = t.match(new RegExp(`(\\d+|${Object.keys(NUM).join('|')})\\s+(?:novos?\\s+|novas?\\s+)?${re.source}`));
    return m ? (NUM[m[1]] ?? parseInt(m[1], 10)) : 0;
  };
  return { story: count(/stor(?:y|ies|ys)/), carousel: count(/carross(?:el|eis)/), reel: count(/(?:reels?|videos?)/) };
}

const STORY_ROTATION: StoryKind[] = ['abertura', 'novidades', 'produto', 'bomdia', 'abertos', 'lancamento', 'evento'];
const CAROUSEL_ROTATION: CarouselModel[] = ['colecao-semana', 'cinco-looks', 'destaques', 'novidades', 'educativo'];
const WEEKDAY = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function caption(kind: PlanItem['kind'], unit: PlanInput['units'][string], campaign?: string): string {
  const where = unit.address ? `\n📍 ${unit.address}` : '';
  const phone = unit.phone ? `\n📲 ${unit.phone}` : '';
  const camp = campaign ? `${campaign} · ` : '';
  const body = kind === 'reel' ? `${camp}Moto 0km ou seminova na Marcos Motos. Garanta a sua.` :
    kind === 'carousel' ? `${camp}Arraste para o lado e escolha o seu favorito.` : `${camp}Hoje é dia de moto nova.`;
  return `${body}\nMotos de qualidade e melhor preço é aqui. ✨${where}${phone}\n@${unit.instagram}`;
}

export function buildPlan(input: PlanInput): { items: PlanItem[]; warnings: string[] } {
  const counts = parseCounts(input.request);
  const warnings: string[] = [];
  if (!counts.story && !counts.carousel && !counts.reel) warnings.push('Não identifiquei quantidades. Exemplo: “cinco Stories, dois carrosséis e três Reels”.');
  if (!input.days.length) warnings.push('Selecione pelo menos um dia.');
  if (!input.unitIds.length) warnings.push('Selecione pelo menos uma unidade.');
  const images = input.media.filter((m) => m.kind === 'image').map((m) => m.id);
  const videos = input.media.filter((m) => m.kind === 'video').map((m) => m.id);
  if ((counts.story || counts.carousel) && !images.length) warnings.push('Envie fotos para Stories e carrosséis.');
  if (counts.reel && !videos.length) warnings.push('Envie vídeos brutos para os Reels.');
  const items: PlanItem[] = [];
  const days = [...input.days].sort();
  let img = 0, vid = 0;
  const nextImgs = (n: number) => { const out: string[] = []; for (let i = 0; i < n && images.length; i++) out.push(images[img++ % images.length]); return out; };
  for (const unitId of input.unitIds) {
    const unit = input.units[unitId];
    if (!unit) continue;
    // cada formato começa em um ponto diferente da semana, para não concentrar tudo no mesmo dia
    const spread = (n: number, push: (i: number, day: string) => void, offset = 0) => {
      const D = Math.max(1, days.length);
      for (let i = 0; i < n; i++) push(i, days[(Math.floor((i * D) / Math.max(1, n)) + Math.round(offset * D)) % D]);
    };
    spread(counts.story, (i, day) => {
      const k = STORY_ROTATION[i % STORY_ROTATION.length];
      items.push({ day, time: '09:00', unitId, kind: 'story', template: k, title: `Story · ${STORY_KINDS.find((s) => s.id === k)!.name}`, caption: caption('story', unit, input.campaign), mediaIds: nextImgs(1), warning: images.length ? undefined : 'sem foto' });
    });
    spread(counts.carousel, (i, day) => {
      const m = CAROUSEL_ROTATION[i % CAROUSEL_ROTATION.length];
      items.push({ day, time: '12:00', unitId, kind: 'carousel', template: m, title: `Carrossel · ${CAROUSEL_MODELS.find((s) => s.id === m)!.name}`, caption: caption('carousel', unit, input.campaign), mediaIds: nextImgs(m === 'cinco-looks' ? 6 : 4), warning: images.length ? undefined : 'sem fotos' });
    }, 0.4);
    spread(counts.reel, (_i, day) => {
      const v = videos.length ? [videos[vid++ % videos.length]] : [];
      items.push({ day, time: '19:00', unitId, kind: 'reel', template: 'premium', title: 'Reel · Premium', caption: caption('reel', unit, input.campaign), mediaIds: v, warning: v.length ? undefined : 'sem vídeo' });
    }, 0.8);
  }
  items.sort((a, b) => (a.day + a.time + a.unitId).localeCompare(b.day + b.time + b.unitId));
  return { items, warnings };
}

export const weekdayName = (isoDate: string) => WEEKDAY[new Date(isoDate + 'T12:00:00').getDay()];
