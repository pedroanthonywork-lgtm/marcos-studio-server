// Estratégia completa do negócio (o "social media" do sistema) e respostas de Direct sugeridas pela IA.
// Só usa dados reais: cadastro da loja, memória da marca, estoque e as métricas devolvidas pela Meta. Nada de número inventado.
import Anthropic from '@anthropic-ai/sdk';
import { type DB, id, j, now, pj } from './db.ts';
import { recordUsage, withinLimit } from './license.ts';
import { AI_MODEL, aiEnabled } from './agents.ts';

const COST = (inTok: number, outTok: number) => (inTok * 4 + outTok * 20) / 1e6; // mesma tabela do agents.ts
const brl = (c: number | null) => (c === null || c === undefined ? null : `R$ ${(c / 100).toFixed(2).replace('.', ',')}`);

/** Tudo o que a IA precisa saber do negócio, montado a partir do banco (nunca de texto fixo de outro cliente). */
export function businessContext(db: DB, tenantId: string) {
  const tenant = db.prepare('SELECT name FROM tenants WHERE id = ?').get(tenantId) as any;
  const units = db.prepare('SELECT name, city, state, instagram, address, phone, data FROM units WHERE tenant_id = ?').all(tenantId) as any[];
  const memory = (db.prepare("SELECT kind, text FROM brand_memory WHERE tenant_id = ? AND status = 'ativo' ORDER BY created_at DESC LIMIT 25").all(tenantId) as any[]).map((m) => `${m.kind}: ${m.text}`);
  const products = (db.prepare('SELECT name, category, brand, price_cents FROM products WHERE tenant_id = ? AND (available IS NULL OR available = 1) ORDER BY updated_at DESC LIMIT 60').all(tenantId) as any[])
    .map((p) => ({ nome: p.name, categoria: p.category, marca: p.brand, preco: brl(p.price_cents) }));
  const report = db.prepare('SELECT data, suggestions, period_from, period_to FROM metrics_reports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1').get(tenantId) as any;
  const m = report ? pj<any>(report.data, {}).metrics : null;
  return {
    negocio: tenant?.name ?? 'Loja',
    unidades: units.map((u) => ({ nome: u.name, cidade: [u.city, u.state].filter(Boolean).join(' - '), instagram: u.instagram ? `@${u.instagram}` : null, endereco: u.address, telefone: u.phone, ...pj<any>(u.data, {}) })),
    memoriaDaMarca: memory,
    estoqueDisponivel: { total: (db.prepare('SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND (available IS NULL OR available = 1)').get(tenantId) as any).n, amostra: products },
    metricasInstagram: m ? { periodo: `${report.period_from} a ${report.period_to}`, seguidores: m.followers, totais: m.totals, publicacoes: (m.posts ?? []).slice(0, 20) } : 'sem análise ainda',
  };
}

const S = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const A = (items: any, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
const O = (props: Record<string, any>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });

export const STRATEGY_SCHEMA = O({
  resumo: S('3 a 5 frases: onde o perfil está hoje e a grande aposta dos próximos 30 dias'),
  posicionamento: S('frase de posicionamento da loja no Instagram'),
  diferenciais: A(S(), 'diferenciais reais que devem aparecer no conteúdo'),
  publico: A(O({ perfil: S(), desejos: S(), objecoes: S(), comoFalar: S() }), '2 a 4 perfis de cliente'),
  pilares: A(O({ nome: S(), objetivo: S(), percentual: { type: 'integer', description: 'peso do pilar no mês, soma 100' }, exemplos: A(S()) }), '4 a 5 pilares de conteúdo'),
  rotinaSemanal: A(O({ dia: S('segunda a domingo'), formato: S('Story, Reel ou Post'), tema: S(), horario: S('HH:MM') }), 'calendário-base de uma semana, incluindo os Stories diários'),
  stories: A(S(), 'roteiro diário de Stories (sequência do dia, enquetes, caixinhas, provas sociais)'),
  reels: A(O({ ideia: S(), gancho: S('primeiros 2 segundos'), roteiro: S(), cta: S() }), '6 a 8 ideias de Reels prontas para gravar com o que a loja tem'),
  legendas: O({ tom: S(), ganchos: A(S()), ctas: A(S()), hashtags: A(S()) }),
  direct: O({ roteiro: A(S(), 'passo a passo do atendimento no Direct até fechar a venda'), respostasProntas: A(O({ pergunta: S(), resposta: S() })) }),
  campanhas: A(O({ nome: S(), quando: S(), mecanica: S(), oferta: S() }), 'campanhas e datas dos próximos 60 dias'),
  metas: A(O({ indicador: S(), meta: S(), comoMedir: S() }), 'metas de 30 dias; se não houver métrica de base, diga que a meta é inicial'),
  plano30dias: A(O({ semana: S(), foco: S(), acoes: A(S()) }), '4 semanas'),
  alertas: A(S(), 'o que evitar e riscos (inclui limites de dados quando faltarem métricas)'),
});

async function ask(db: DB, tenantId: string, agent: string, o: { system: string; user: unknown; schema: any; effort: 'low' | 'medium' | 'high'; maxTokens: number }) {
  const client = new Anthropic();
  const req: any = {
    model: AI_MODEL, max_tokens: o.maxTokens, thinking: { type: 'adaptive' },
    output_config: { effort: o.effort, format: { type: 'json_schema', schema: o.schema } },
    system: o.system, messages: [{ role: 'user', content: typeof o.user === 'string' ? o.user : JSON.stringify(o.user) }],
  };
  const res: any = await client.messages.stream(req).finalMessage();
  const inTok = res.usage?.input_tokens ?? 0, outTok = res.usage?.output_tokens ?? 0;
  recordUsage(db, tenantId, 'ai_call', 1, COST(inTok, outTok), { model: res.model, inTok, outTok, agent });
  if (res.stop_reason === 'refusal') throw new Error('A IA recusou o pedido.');
  if (res.stop_reason === 'max_tokens') throw new Error('Resposta da IA cortada (limite de tamanho). Tente de novo.');
  return JSON.parse((res.content ?? []).find((b: any) => b.type === 'text')?.text ?? '{}');
}

const running = new Set<string>();

/** Dispara a geração em segundo plano (Opus, esforço médio). A tela consulta o status. */
export function startStrategy(db: DB, tenantId: string, userId: string, focus: string) {
  if (!aiEnabled()) throw new Error('A estratégia usa a IA: falta a chave ANTHROPIC_API_KEY no servidor.');
  if (!withinLimit(db, tenantId, 'ai_call')) throw new Error('Limite mensal de uso da IA atingido.');
  if (running.has(tenantId)) throw new Error('Já existe uma estratégia sendo gerada.');
  const sid = id();
  db.prepare('INSERT INTO strategies (id, tenant_id, status, model, created_by, created_at) VALUES (?,?,?,?,?,?)').run(sid, tenantId, 'gerando', AI_MODEL, userId, now());
  running.add(tenantId);
  const ctx = businessContext(db, tenantId);
  // a API limita o tamanho do schema estruturado: a estratégia sai em duas partes geradas em paralelo
  const keys = Object.keys(STRATEGY_SCHEMA.properties);
  const parts = [keys.slice(0, 7), keys.slice(7)].map((ks) => ({ ...STRATEGY_SCHEMA, required: ks, properties: Object.fromEntries(ks.map((k) => [k, (STRATEGY_SCHEMA.properties as any)[k]])) }));
  const system = `Você é estrategista sênior de Instagram para comércio local no Brasil. Monte a estratégia completa de conteúdo e vendas do negócio descrito, em português do Brasil, prática e específica para ESTE negócio (produtos, cidade, público). Regras: use somente os dados fornecidos; cite números apenas quando vierem das métricas; nunca invente métricas, preços ou resultados; se faltar dado, diga isso nos alertas. O sistema publica Stories diários com fotos do estoque e Reels editados automaticamente, então aproveite isso. Pense no dono da loja executando sem social media. Nesta chamada, preencha só as seções pedidas no formato de saída.`;
  const user = { ...ctx, focoPedidoPeloDono: focus || 'estratégia completa de crescimento e vendas' };
  Promise.all(parts.map((schema) => ask(db, tenantId, 'estrategia', { effort: 'medium', maxTokens: 24000, schema, system, user })))
    .then(([a, b]) => ({ ...a, ...b }))
    .then((data) => db.prepare("UPDATE strategies SET status = 'pronta', data = ?, finished_at = ? WHERE id = ?").run(j(data), now(), sid))
    .catch((e) => db.prepare("UPDATE strategies SET status = 'erro', error = ?, finished_at = ? WHERE id = ?").run(String((e as Error).message).slice(0, 500), now(), sid))
    .finally(() => running.delete(tenantId));
  return sid;
}

export function latestStrategies(db: DB, tenantId: string) {
  return (db.prepare('SELECT * FROM strategies WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10').all(tenantId) as any[])
    .map((s) => ({ id: s.id, status: s.status, error: s.error, createdAt: s.created_at, finishedAt: s.finished_at, data: pj(s.data, {}) }));
}

/** Análise de métricas mais completa: diagnóstico + sugestões priorizadas. Usa só os números fornecidos. */
export async function metricsAnalysis(db: DB, tenantId: string, data: unknown) {
  return ask(db, tenantId, 'metricas', {
    effort: 'low', maxTokens: 6000,
    schema: O({ diagnostico: S('3 a 4 frases sobre o momento do perfil, citando os números'), pontosFortes: A(S()), suggestions: A(O({ title: S(), detail: S('o que fazer, por que (com o número que justifica) e como'), categoria: { type: 'string', enum: ['frequencia', 'formato', 'horario', 'legenda', 'stories', 'vendas', 'engajamento', 'dados'] }, prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] } }), '5 a 8 sugestões') }),
    system: `Você analisa as métricas do Instagram de ${businessContext(db, tenantId).negocio}. Escreva em português do Brasil. Use somente os números fornecidos e cite-os; nunca invente métricas. Se os dados forem poucos ou houver erro de permissão, diga isso e indique o que fazer. Seja específico para o negócio (produtos do estoque, cidade).`,
    user: { contexto: businessContext(db, tenantId), dados: data },
  });
}

/** Sugere a resposta de uma conversa do Direct com base no estoque real. O dono revisa antes de enviar. */
export async function suggestReply(db: DB, tenantId: string, history: { fromMe: boolean; text: string }[]) {
  if (!aiEnabled()) throw new Error('Sugestão automática precisa da IA ligada (ANTHROPIC_API_KEY).');
  if (!withinLimit(db, tenantId, 'ai_call')) throw new Error('Limite mensal de uso da IA atingido.');
  const ctx = businessContext(db, tenantId);
  const r = await ask(db, tenantId, 'direct', {
    effort: 'low', maxTokens: 3000, schema: O({ reply: S('mensagem pronta para enviar'), note: S('observação curta para o dono, ou vazio') }),
    system: `Você atende o Direct do Instagram de ${ctx.negocio} como vendedor simpático e objetivo, em português do Brasil, mensagens curtas de WhatsApp. Use somente preços e produtos do estoque fornecido; se o cliente pedir algo que não está na lista ou um dado que você não tem (parcelamento, troca, frete), diga que vai confirmar e peça o contato. Termine conduzindo para a venda (visita à loja, reserva ou WhatsApp). Nunca invente preço, prazo ou condição.`,
    user: { loja: ctx.unidades, estoque: ctx.estoqueDisponivel, memoriaDaMarca: ctx.memoriaDaMarca, conversa: history.slice(-20) },
  });
  return { reply: String(r.reply ?? ''), note: String(r.note ?? '') };
}
