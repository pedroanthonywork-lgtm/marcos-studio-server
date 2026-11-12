// Orquestrador dos agentes. Um único ponto de entrada decide quem atende cada pedido:
//  - Direção/Revisão/Planejamento/Identidade: regras locais (custo zero) baseadas na Brand Intelligence;
//  - Modo IA (opcional): só quando ANTHROPIC_API_KEY está configurada no servidor E o modo local não entendeu.
// Todo uso de IA é registrado por cliente (tokens + custo estimado). A assinatura do Claude Code do
// desenvolvedor NUNCA é usada aqui: a chave é da conta comercial da P7 Labs.
import Anthropic from '@anthropic-ai/sdk';
import { applyInstruction, type InstructionResult } from '../shared/instruct.ts';
import type { Params } from '../shared/templates.ts';
import type { DB } from './db.ts';
import { recordUsage, withinLimit } from './license.ts';

export const AI_MODEL = 'claude-opus-5-5';
const PRICE = { inPerM: 4, outPerM: 20 }; // USD por milhão de tokens (tabela oficial em 2026-10)

// Campos que a IA pode mudar e o tipo de cada um (lista = valores aceitos).
const PATCH_FIELDS: Record<string, 'number' | 'string' | 'boolean' | string[]> = {
  style: ['essential', 'boutique', 'ios', 'led', 'motion'], font: ['cormorant', 'manrope', 'pinyon'], accent: ['ouro', 'cone', 'marfim'],
  glow: 'number', pace: 'number', headline: 'string', subline: 'string', kicker: 'string', cta: 'string', title: 'string',
  animated: 'boolean', priceAnimation: 'boolean', mode: ['rapido', 'premium', 'cinematic'], durationTarget: 'number', variation: 'number',
  keepOriginalAudio: 'boolean', collection: 'string', motion: ['calm', 'dynamic', 'max'],
};
/** Converte a lista {field, value} da IA em patch tipado; descarta campo desconhecido ou valor fora do tipo. */
export function toPatch(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const it of Array.isArray(list) ? list : []) {
    const spec = PATCH_FIELDS[(it as any)?.field]; const v = String((it as any)?.value ?? '').trim();
    if (!spec) continue;
    if (Array.isArray(spec)) { if (spec.includes(v)) out[(it as any).field] = v; }
    else if (spec === 'number') { const n = Number(v.replace(',', '.')); if (Number.isFinite(n)) out[(it as any).field] = n; }
    else if (spec === 'boolean') { if (v === 'true' || v === 'false') out[(it as any).field] = v === 'true'; }
    else out[(it as any).field] = v.slice(0, 200);
  }
  return out;
}

const EDITABLE_SCHEMA = {  type: 'object',
  additionalProperties: false,
  required: ['changes', 'patch', 'forkUnits', 'plan'],
  properties: {
    plan: { type: 'array', items: { type: 'string' }, description: 'Briefing da edição para o cliente aprovar antes do render: 6 a 10 passos em português, concretos (abertura, cortes, transições, motion graphics, textos e cartões, áudio, final), só com o que o motor faz.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Mudanças aplicadas, em português, uma frase cada.' },
    forkUnits: { type: 'array', items: { type: 'string', enum: ['luz', 'morada-nova', 'sao-gotardo'] } },
    // Lista {campo, valor}: um objeto com muitos campos opcionais é recusado pela API ("Schema is too complex").
    patch: { type: 'array', description: 'Campos alterados. value sempre texto: número com ponto (0.6), booleano true/false.', items: { type: 'object', additionalProperties: false, required: ['field', 'value'], properties: { field: { type: 'string', enum: Object.keys(PATCH_FIELDS) }, value: { type: 'string' } } } },
  },
};

const SYSTEM = `Você é o editor de vídeo e direção de arte do Marcos Motos Digital Experience (revenda de motos 0km e seminovas, com troca e financiamento, em São Gotardo, MG). Estilo: garagem de motos, vermelho e preto, madeira ripada, motion graphic forte.
Converta o pedido do cliente em um patch de parâmetros do template. Regras:
- Nunca invente preço, tamanho, quantidade ou dado comercial; só use o que o cliente escreveu.
- Preserve a identidade Marcos Motos: o produto é protagonista; preto profundo, vermelho (#E31B23), vidro escuro, HUD tech, títulos em caixa alta condensada.
- glow e pace ficam entre 0 e 1 (glow) e 0.5 e 2 (pace); variation entre 0 e 1; durationTarget entre 10 e 60 s.
- Em Reels, traduza pedidos de estilo de edição (ritmo, duração, intensidade, modo Rápido/Premium/Cinematic, variação) para esses campos.
- Se o pedido não puder ser atendido com os campos disponíveis, devolva patch vazio e explique em changes.
- O motor de vídeo tem: abertura com logo 3D e anel de LED; HUD com cantos de LED, scanner e partículas; transições flip 3D, glitch, zoom, whip, flash e wipe em todo corte; câmera em movimento; feixes de luz nos cortes; cartões de produto em vidro escuro com preço animado (só preço informado); legendas palavra a palavra; final com logo aceso, assinatura e @ da loja. motion: calm, dynamic ou max (max = motion graphic pesado).
- Temas (ex.: Black Friday, Natal) entram em collection/title e no plano; paleta pedida (ex.: preto) vira accent marfim + glow menor quando fizer sentido.
- Em 'plan', escreva o briefing que o cliente aprova, refletindo TODO o pedido dele.`;

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * Pedido de alteração em linguagem livre. Com o modo IA ligado, TODO pedido vai para o Opus (vídeo: esforço alto,
 * pedido do P7 em 2026-11-08); sem chave/limite, as regras locais atendem os pedidos comuns.
 */
export async function interpretInstruction(db: DB, tenantId: string, params: Params, instruction: string): Promise<InstructionResult & { engine: 'local' | 'ia' }> {
  const local = applyInstruction(params, instruction);
  if (!aiEnabled() || !withinLimit(db, tenantId, 'ai_call')) { delete (local.params as any).aiBriefing; return { ...local, engine: 'local' }; } // plano antigo da IA não vale para a versão nova

  const client = new Anthropic();
  let res: any;
  try {
    res = await (client.messages.create as any)({
      model: AI_MODEL,
      max_tokens: 8000,
      output_config: { effort: params.type === 'reel' ? 'high' : 'medium', format: { type: 'json_schema', schema: EDITABLE_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Parâmetros atuais (JSON):\n${JSON.stringify(params)}\n\nPedido do cliente: ${instruction}` }],
    });
  } catch (e: any) {
    // sem crédito, chave inválida ou sem internet: segue no modo local em vez de travar a produção
    console.error('[ia] falhou, usando modo local:', e?.status ?? '', e?.message ?? e);
    delete (local.params as any).aiBriefing;
    return { ...local, engine: 'local' };
  }
  const inTok = res.usage?.input_tokens ?? 0;
  const outTok = res.usage?.output_tokens ?? 0;
  recordUsage(db, tenantId, 'ai_call', 1, (inTok * PRICE.inPerM + outTok * PRICE.outPerM) / 1e6, { model: res.model, inTok, outTok, agent: 'edicao' });
  if (res.stop_reason === 'refusal') return { ...local, changes: ['O pedido não pôde ser atendido pelo modo IA.'], engine: 'ia' };
  const text = (res.content ?? []).find((b: any) => b.type === 'text')?.text ?? '{}';
  const out = JSON.parse(text) as { changes: string[]; patch: unknown; forkUnits: string[]; plan?: string[] };
  const patch = toPatch(out.patch);
  const p: any = structuredClone(params);
  for (const [k, v] of Object.entries(patch)) p[k] = v; // toPatch já limita campos e tipos
  if (typeof p.glow === 'number') p.glow = Math.min(1, Math.max(0, p.glow));
  if (typeof p.pace === 'number') p.pace = Math.min(2, Math.max(0.5, p.pace));
  if (typeof p.variation === 'number') p.variation = Math.min(1, Math.max(0, p.variation));
  if (typeof p.durationTarget === 'number') p.durationTarget = Math.min(60, Math.max(10, Math.round(p.durationTarget)));
  if (p.type === 'reel' && ('pace' in patch || 'mode' in patch || 'durationTarget' in patch)) p.timeline = undefined;
  if (out.plan?.length) p.aiBriefing = out.plan.slice(0, 12).map((s) => String(s).slice(0, 400));
  return { params: p, changes: out.changes ?? [], forkUnits: out.forkUnits ?? [], unrecognized: !(out.changes?.length || out.plan?.length), engine: 'ia' };
}

/** Agente de revisão: checagens objetivas antes de aprovar/publicar (texto, legibilidade, dados comerciais). */
export function review(params: Params): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const texts: string[] = [];
  if (params.type === 'story') {
    texts.push(params.headline, params.subline, params.kicker, params.cta);
    if (!params.photo) issues.push('Story sem fotografia: a peça deve ser protagonista.');
    if (params.headline.length > 42) issues.push('Título longo (>42 caracteres) pode quebrar em 3 linhas.');
    if (params.priceAnimation && !params.price) issues.push('Animação de preço ligada, mas nenhum preço foi informado (não inventamos preços).');
  } else if (params.type === 'carousel') {
    params.slides.forEach((s, i) => { texts.push(s.title ?? '', s.text ?? ''); if ((s.kind === 'foto' || s.kind === 'look' || s.kind === 'capa') && !s.photo) issues.push(`Slide ${i + 1} sem foto.`); });
    if (params.slides.length > 20) issues.push('Instagram aceita no máximo 20 itens por carrossel.');
  } else {
    texts.push(params.title);
    if (!params.clips.length) issues.push('Reel sem vídeos de origem.');
    if (params.priceAnimation && !params.products.some((p) => p.price)) issues.push('Animação de preço sem preço informado.');
  }
  for (const t of texts) {
    if (/\s{2,}/.test(t)) issues.push(`Espaço duplo em “${t}”.`);
    if (/\b(\w+) \1\b/i.test(t)) issues.push(`Palavra repetida em “${t}”.`);
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Briefing de edição: o que o motor vai fazer, em linguagem simples, ANTES de gastar render.
 * Determinístico (custo zero); quando o pedido livre passou pela IA, as mudanças dela aparecem em "changes" da versão.
 */
export function briefing(params: Params, mediaNames: Record<string, string> = {}): string[] {
  const s: string[] = [];
  const pct = (x?: number) => `${Math.round((x ?? 0) * 100)}%`;
  if (params.type === 'reel') {
    const shot = ({ rapido: 1.8, premium: 2.0, cinematic: 2.4 } as const)[params.mode] * params.pace;
    s.push(`Modo ${params.mode === 'rapido' ? 'Rápido' : params.mode === 'premium' ? 'Premium' : 'Cinematic'}, cerca de ${params.durationTarget} s, tomadas de ~${shot.toFixed(1)} s (ritmo Marcos Motos com variação natural).`);
    s.push(`Vídeos usados (${params.clips.length}): ${params.clips.map((c, i) => `${i + 1}) ${mediaNames[c.media.id] ?? 'vídeo'}${(c.zoom ?? 1) > 1.001 ? ` com zoom ${(c.zoom ?? 1).toFixed(2)}×` : ''}${c.captions ? ', com legenda da fala' : ''}`).join('; ')}. O motor escolhe os trechos mais nítidos e bem expostos e descarta flashes e tremidos.`);
    s.push(`Enquadramento vertical 9:16 em 1080×1920, centrado no assunto${params.clips.some((c) => (c.focusY ?? 0.5) !== 0.5) ? ' com foco vertical ajustado por vídeo' : ''}.`);
    s.push(`Abertura com o logo 3D e o título “${params.collection}”; assinatura discreta no canto durante o vídeo; cartão final com “Motos de qualidade e melhor preço é aqui”, ${params.unitName} e @${params.instagram}.`);
    if (params.mode !== 'rapido') s.push(params.products.length ? `Cartões de produto: ${params.products.map((p) => p.name + (p.price ? ` (${p.price})` : '')).join(', ')}. Preço só aparece onde foi informado.` : 'Sem cartões de produto (nenhum produto informado).');
    if (params.mode === 'premium' || params.motion === 'max') s.push('Motion graphic pesado: logo abrindo em 3D com anel de LED, HUD com cantos de LED e scanner, transições flip 3D e glitch, câmera em movimento e feixes de luz vermelha nos cortes.');
    if (params.mode === 'cinematic') s.push(`Título no meio do vídeo: “${params.title}”, vinheta e LED no cartão final.`);
    if (params.mode !== 'rapido') s.push(`flash curto (até 0,2 s) em alguns cortes; nunca cobre o produto.`);
    s.push(params.audio ? `Música do Instagram: “${params.audio.title}”${params.audio.artist ? ` — ${params.audio.artist}` : ''}. Ela é anexada na publicação e o nome aparece no Reel; o arquivo de vídeo sai sem essa música.`
      : params.music ? 'Áudio próprio enviado pela loja, normalizado para -14 LUFS.' : params.keepOriginalAudio ? 'Mantém o áudio original dos vídeos, normalizado para -14 LUFS.' : 'Sem áudio no arquivo (escolha a música no Instagram ao publicar).');
    if ((params.variation ?? 0) > 0) s.push(`Variação ${pct(params.variation)}: ritmo, entradas, posição dos cartões e legendas mudam em relação às últimas edições, sempre dentro da marca.`);
  } else if (params.type === 'story') {
    s.push(params.layout === 'colagem' ? `Colagem com ${(params.photos ?? []).length} fotos em grade.` : 'Story com 1 foto em destaque.');
    s.push(`Estilo ${params.style}, título “${params.headline}”${params.price ? `, preço ${params.price}` : ''}${params.animated ? ', animado (MP4)' : ''}.`);
    if ((params.variation ?? 0) > 0) s.push(`Variação ${pct(params.variation)} de layout dentro da marca.`);
  } else {
    s.push(`Carrossel com ${params.slides.length} slides, estilo ${params.style}, coleção “${params.collection}”.`);
  }
  if (params.dmLink) s.push(`Link por DM: quem ${params.type === 'story' ? 'responder o Story' : 'comentar'} “${params.dmLink.keyword}” recebe ${params.dmLink.url} por mensagem automática.`);
  if (params.allUnits) s.push(params.type === 'story' ? 'Publicado em todas as lojas (Story não aceita collab: sai em cada conta).' : 'Publicado em collab em todas as lojas: as outras contas aceitam o convite automaticamente.');
  return s;
}
// ───────── Layout livre por IA ─────────
import { CANVAS, localDesign, sanitizeDesign, type Design, type DesignInput } from '../shared/design.ts';

const LAYER_SCHEMA = { type: 'object', additionalProperties: false, required: ['t', 'x', 'y'], properties: {
  t: { type: 'string', enum: ['photo', 'text', 'shape', 'price', 'logo', 'handles'] }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
  i: { type: 'integer' }, r: { type: 'number' }, rot: { type: 'number' }, focusY: { type: 'number' }, frame: { type: 'string', enum: ['none', 'thin', 'led', 'polaroid'] },
  enter: { type: 'string', enum: ['none', 'fade', 'rise', 'slide-l', 'slide-r', 'zoom', 'wipe', 'pop'] }, delay: { type: 'number' },
  text: { type: 'string' }, size: { type: 'number' }, font: { type: 'string', enum: ['sans', 'serif', 'script'] }, weight: { type: 'number' },
  color: { type: 'string', enum: ['bg', 'ink', 'cone', 'ember', 'filament', 'white', 'black'] }, align: { type: 'string', enum: ['left', 'center', 'right'] },
  upper: { type: 'boolean' }, tracking: { type: 'number' }, plate: { type: 'boolean' }, gradient: { type: 'boolean' },
  kind: { type: 'string', enum: ['rect', 'circle', 'line', 'glow', 'ring', 'stripe'] }, opacity: { type: 'number' }, scale: { type: 'number' }, style: { type: 'string', enum: ['pill', 'tag', 'burst'] },
} };
const DESIGN_SCHEMA = { type: 'object', additionalProperties: false, required: ['designs'], properties: { designs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'bg', 'layers'], properties: {
  name: { type: 'string' }, bg: { type: 'object', additionalProperties: false, required: ['kind', 'a'], properties: { kind: { type: 'string', enum: ['solid', 'gradient', 'photo-blur'] }, a: { type: 'string', enum: ['bg', 'ink', 'cone', 'ember', 'filament', 'white', 'black'] }, b: { type: 'string', enum: ['bg', 'ink', 'cone', 'ember', 'filament', 'white', 'black'] }, angle: { type: 'number' }, photo: { type: 'integer' } } },
  layers: { type: 'array', items: LAYER_SCHEMA } } } } } };

const DESIGN_SYSTEM = `Você é diretor de arte da Marcos Motos (revenda de motos 0km e seminovas, São Gotardo MG). Crie layouts NOVOS para Instagram — nada de modelo repetido: varie composição, escala, recortes, rotação, ritmo tipográfico e animações a cada pedido, sempre dentro da identidade.
Identidade: fundo preto profundo (bg), texto claro (white), vermelho (cone/ember) e vermelho claro (filament) como luz, madeira ripada como textura da loja; fontes: sans = Big Shoulders Display 900 em caixa alta (títulos), serif = Onest 600 (palavra de destaque). Logo: MARCOS MOTOS com os M em vermelho. A moto é sempre a protagonista; nunca invente preço, ano, km ou item.
Regras: o produto é protagonista (pelo menos uma foto grande, ≥40% da área); texto claro só sobre área escura — use plate:true ou uma shape escura atrás quando o texto ficar sobre foto; preço SOMENTE o texto fornecido; nunca invente dados; área segura do Story: nada importante acima de y=220 nem abaixo de y=1620; feed 1080x1350.
Coordenadas em pixels da tela (story 1080x1920, feed 1080x1350). Camadas: photo (i = índice da foto), text, shape, price, logo, handles (@ das lojas). Use enter/delay para animar (delay em quadros, 30 fps). Devolva um design por item pedido.`;

/** Gera os layouts com o Opus; sem modo IA, ou se falhar, usa o gerador local (também diferente a cada semente). */
export async function designs(db: DB, tenantId: string, inputs: DesignInput[], brief = ''): Promise<{ designs: Design[]; engine: 'ia' | 'local' }> {
  const local = () => inputs.map((x) => localDesign(x));
  if (!aiEnabled() || !withinLimit(db, tenantId, 'ai_call')) return { designs: local(), engine: 'local' };
  try {
    const res: any = await (new Anthropic().messages.create as any)({
      model: AI_MODEL, max_tokens: 16000,
      // sem format estrito: camadas com muitos campos opcionais passam do limite da API ("Schema is too complex"); sanitizeDesign valida tudo
      output_config: { effort: 'medium' },
      system: DESIGN_SYSTEM + '\n\nResponda SOMENTE com um JSON válido, sem texto antes ou depois, neste formato (JSON Schema): ' + JSON.stringify(DESIGN_SCHEMA),
      messages: [{ role: 'user', content: JSON.stringify({ pedido: brief || undefined, itens: inputs.map((x) => ({ tamanho: x.size, canvas: CANVAS[x.size], fotos: x.photos, slide: x.slide, chamada: x.kicker, titulo: x.headline, apoio: x.subline, preco: x.price ?? null, campanha: x.campaign ? { nome: x.campaign.name, palavra: x.campaign.word, ideia: x.campaign.idea } : null })) }) }],
    });
    const inTok = res.usage?.input_tokens ?? 0, outTok = res.usage?.output_tokens ?? 0;
    recordUsage(db, tenantId, 'ai_call', 1, (inTok * PRICE.inPerM + outTok * PRICE.outPerM) / 1e6, { model: res.model, inTok, outTok, agent: 'design' });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return { designs: local(), engine: 'local' };
    const raw = (res.content ?? []).find((b: any) => b.type === 'text')?.text ?? '{}';
    const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) || '{}').designs ?? [];
    return { designs: inputs.map((x, i) => (out[i] ? sanitizeDesign({ ...out[i], size: x.size }, { photos: x.photos, prices: x.price ? [x.price] : [], size: x.size }) : localDesign(x))), engine: 'ia' };
  } catch (e: any) { console.error('[ia] layout falhou, usando local:', e?.status ?? '', e?.message ?? e); return { designs: local(), engine: 'local' }; }
}