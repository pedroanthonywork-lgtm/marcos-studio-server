// Agente de edição por instruções (modo local, sem custo de API): interpreta pedidos em português e devolve
// novos parâmetros + lista legível das mudanças. Pedidos não reconhecidos são sinalizados para o modo IA (se ligado).
import type { Accent, FontKey, Params, Style } from './templates.ts';

export type InstructionResult = { params: Params; changes: string[]; forkUnits: string[]; unrecognized: boolean };

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const FONT_CYCLE: FontKey[] = ['manrope', 'cormorant', 'pinyon'];
const FONT_NAME: Record<FontKey, string> = { cormorant: 'Bodoni itálico editorial', manrope: 'Inter Tight (padrão do site)', pinyon: 'caligráfica (Pinyon Script)' };
const STYLE_NAME: Record<Style, string> = { essential: 'Essential', boutique: 'Boutique', ios: 'iOS', led: 'LED', motion: 'Motion' };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export const UNIT_ALIASES: Record<string, string> = { luz: 'luz', 'morada nova': 'morada-nova', morada: 'morada-nova', 'sao gotardo': 'sao-gotardo', gotardo: 'sao-gotardo', sg: 'sao-gotardo' };

export function applyInstruction(input: Params, instruction: string): InstructionResult {
  const p: any = structuredClone(input);
  const t = norm(instruction);
  const changes: string[] = [];
  const forkUnits: string[] = [];
  const quoted = instruction.match(/["“”']([^"“”']{2,80})["“”']/)?.[1];

  const setStyle = (s: Style) => { if (p.style !== s) { p.style = s; changes.push(`Estilo alterado para ${STYLE_NAME[s]}.`); } };
  const setGlow = (v: number) => { const nv = round2(clamp(v, 0, 1)); if (nv !== p.glow) { changes.push(`Brilho/luz ${nv < p.glow ? 'reduzido' : 'aumentado'} de ${Math.round(p.glow * 100)}% para ${Math.round(nv * 100)}%.`); p.glow = nv; } };
  const setFont = (f: FontKey) => { if (p.font !== f) { p.font = f; changes.push(`Fonte de destaque trocada para ${FONT_NAME[f]}.`); } };
  const setAccent = (a: Accent, label: string) => { if (p.accent !== a) { p.accent = a; changes.push(`Cor de destaque: ${label}.`); } };

  if (/(troc|troq|mud|outra|nova|diferente|altera).{0,20}(fonte|letra|tipografia)|(fonte|letra|tipografia).{0,20}(diferente|outra)/.test(t)) {
    if (/manuscrit|cursiv|caligraf|script/.test(t)) setFont('pinyon');
    else if (/moderna|sem serifa|reta|simples/.test(t)) setFont('manrope');
    else if (/classic|serif|editorial|elegante|bodoni/.test(t)) setFont('cormorant');
    else setFont(FONT_CYCLE[(FONT_CYCLE.indexOf(p.font) + 1) % FONT_CYCLE.length]);
  }
  if (/menos (brilho|luz|neon|efeito|reflexo)|(brilho|luz|neon) (mais )?(fraco|suave|menor)|tira(r)? (o )?(brilho|neon)/.test(t)) setGlow(p.glow - 0.25);
  if (/mais (brilho|luz|neon|reflexo)|(brilho|luz|neon) (mais )?(forte|maior)/.test(t)) setGlow(p.glow + 0.25);

  if (p.type === 'reel') {
    if (/mais rapid|acelera|mais dinamic|ritmo mais (rapido|forte)|cortes? mais curt/.test(t)) { const v = round2(clamp(p.pace * 0.8, 0.5, 2)); changes.push(`Ritmo mais rápido: cada tomada ~${Math.round((1 - v / p.pace) * 100)}% mais curta.`); p.pace = v; p.timeline = undefined; }
    if (/mais lent|mais calm|ritmo mais (lento|suave)|cortes? mais long/.test(t)) { const v = round2(clamp(p.pace * 1.25, 0.5, 2)); changes.push('Ritmo mais calmo: tomadas mais longas.'); p.pace = v; p.timeline = undefined; }
    if (/black ?friday/.test(t) && p.collection !== 'Black Friday') { p.collection = 'Black Friday'; p.title = 'Black Friday'; p.motion = 'max'; changes.push('Tema Black Friday: abertura e título Black Friday, motion graphic forte.'); }
    if (/(paleta|elementos|tudo|fundo).{0,20}pret|preto e laranja/.test(t) && p.accent !== 'marfim') { p.accent = 'marfim'; p.glow = Math.min(p.glow, 0.4); changes.push('Paleta escura: elementos em preto e branco com o vermelho só no LED.'); }
    if (/dinamic|motion|transic|mais energia|mais movimento|mais efeito/.test(t) && p.motion !== 'max') { p.motion = 'max'; changes.push('Motion graphic forte: transições marcadas, câmera em movimento e feixes de luz nos cortes.'); }
    if (/(mais )?(calm|suave|sutil|leve)/.test(t) && /motion|movimento|edicao|video|transic/.test(t) && p.motion !== 'calm') { p.motion = 'calm'; changes.push('Motion suave.'); }
    if (/variad|diferente|menos padrao|fora da caixa|criativ/.test(t)) { const nv = Math.min(1, Math.max(0.6, (p.variation ?? 0) + 0.3)); if (nv !== p.variation) { p.variation = nv; p.seed = Math.floor(Math.random() * 1e9); changes.push(`Variação aumentada para ${Math.round(nv * 100)}%.`); } }
    if (/cinemat/.test(t) && p.mode !== 'cinematic') { p.mode = 'cinematic'; changes.push('Modo Cinematic.'); }
    if (/\bmodo rapido|versao rapida|edicao simples/.test(t) && p.mode !== 'rapido') { p.mode = 'rapido'; changes.push('Modo Rápido.'); }
    { const sec = t.match(/(\d{2}) ?(segundos|seg|s)\b/); if (sec) { const d = Math.min(60, Math.max(10, Number(sec[1]))); if (d !== p.durationTarget) { p.durationTarget = d; p.timeline = undefined; changes.push(`Duração alvo: ${d} s.`); } } }
    if (/sem (o )?audio original|tira(r)? (o )?(som|audio)/.test(t) && p.keepOriginalAudio) { p.keepOriginalAudio = false; changes.push('Áudio original removido.'); }
  }
  if (/anima\w* de preco|preco anima|animar (o )?preco|preco (com|em) anima/.test(t)) {
    if (!p.priceAnimation) { p.priceAnimation = true; changes.push('Animação de preço ativada (exibe somente preço informado; nenhum preço é inventado).'); }
    if (p.type === 'story' && !p.animated) { p.animated = true; changes.push('Story passa a ser animado (MP4).'); }
  } else if (/\b(anima|animad|movimento)/.test(t) && p.type === 'story' && !p.animated) { p.animated = true; changes.push('Story animado (MP4) com entradas em movimento.'); }

  if (/sofisticad|elegante|refinad|luxo|chique|premium/.test(t)) { setStyle('boutique'); setFont('cormorant'); if (p.glow > 0.35) setGlow(0.3); }
  if (/\bled\b|neon|mais energia|mais impacto|eletric/.test(t)) setStyle('led');
  if (/\bios\b|iphone|vidro|glass|apple/.test(t)) setStyle('ios');
  if (/mais simples|mais limp|clean|minimalista|essencial/.test(t)) setStyle('essential');
  if (/dourad|\bouro\b|filamento|luz quente/.test(t)) setAccent('ouro', 'luz quente (filamento)');
  if (/laranja|cor do cone/.test(t)) setAccent('cone', 'laranja do cone');
  if (/branc|marfim/.test(t) && /cor|destaque|detalhe/.test(t)) setAccent('marfim', 'marfim');

  if (quoted) {
    if (/titulo|chamada|frase|texto|escrev/.test(t)) {
      if (p.type === 'story') { p.headline = quoted; changes.push(`Título: “${quoted}”.`); }
      else if (p.type === 'carousel') { p.slides[0].title = quoted; p.title = quoted; changes.push(`Título da capa: “${quoted}”.`); }
      else { p.title = quoted; changes.push(`Título do Reel: “${quoted}”.`); }
    } else if (/preco|valor|r\$/.test(t)) {
      if (p.type === 'story') { p.price = quoted; changes.push(`Preço informado: ${quoted}.`); }
    }
  }
  const priceTyped = instruction.match(/R\$\s?\d{1,5}(?:[.,]\d{2})?/i)?.[0];
  if (priceTyped && p.type === 'story' && !quoted) { p.price = priceTyped.replace(/\s+/, ' '); changes.push(`Preço informado: ${p.price}.`); }

  const fork = t.match(/(versao|variacao|outra) (para|de|da|pra) (a )?(loja )?(unidade )?(luz|morada nova|morada|sao gotardo|gotardo|sg)\b/);
  if (fork) forkUnits.push(UNIT_ALIASES[fork[6]]);
  if (/(versao|versoes|variacao|variacoes) para (as )?(tres|3|todas)/.test(t)) forkUnits.push('luz', 'morada-nova', 'sao-gotardo');

  return { params: p, changes, forkUnits: [...new Set(forkUnits)], unrecognized: changes.length === 0 && forkUnits.length === 0 };
}
