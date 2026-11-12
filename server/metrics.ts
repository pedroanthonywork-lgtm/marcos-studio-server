// Análise de métricas: só números devolvidos pela Meta (nada estimado) + regras locais de sugestão (custo zero).
// Com o modo IA ligado, a IA escreve sugestões extras a partir dos MESMOS números; o custo é registrado por cliente.
import { type DB, id, j, now, pj } from './db.ts';
import { accountMetrics } from './instagram.ts';
import { withinLimit } from './license.ts';
import { aiEnabled } from './agents.ts';
import { metricsAnalysis } from './strategy.ts';

export type Suggestion = { title: string; detail: string; apply?: { defaults: Record<string, unknown> } };
export type Settings = { analysis?: { frequency: 'manual' | 'diaria' | 'semanal' | 'mensal'; autoApply: boolean; days: number }; defaults?: { variation?: number; reelMode?: string; bestTime?: string } };

export const getSettings = (db: DB, tenantId: string): Settings => pj((db.prepare('SELECT data FROM tenant_settings WHERE tenant_id = ?').get(tenantId) as any)?.data, {});
export function saveSettings(db: DB, tenantId: string, s: Settings) {
  db.prepare('INSERT INTO tenant_settings (tenant_id, data) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET data = excluded.data').run(tenantId, j(s));
}

const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Regras locais: cada sugestão cita os números de onde veio. Pouco dado → não sugere. */
export function localSuggestions(m: NonNullable<Awaited<ReturnType<typeof accountMetrics>>>, days: number, ownVariation: number): Suggestion[] {
  const out: Suggestion[] = [];
  const eng = (p: any) => p.likes + p.comments;
  const byType: Record<string, number[]> = {};
  for (const p of m.posts) (byType[p.type] ??= []).push(eng(p));
  const types = Object.entries(byType).filter(([, v]) => v.length >= 3).map(([k, v]) => ({ k, a: avg(v), n: v.length })).sort((x, y) => y.a - x.a);
  if (types.length >= 2 && types[0].a > types[1].a * 1.3) {
    const name = (k: string) => (k === 'REELS' ? 'Reels' : k === 'CAROUSEL_ALBUM' ? 'carrosséis' : k === 'FEED' || k === 'IMAGE' ? 'posts de foto' : k.toLowerCase());
    out.push({ title: `Priorizar ${name(types[0].k)}`, detail: `${name(types[0].k)} tiveram ${types[0].a.toFixed(1)} curtidas+comentários em média (${types[0].n} publicações) contra ${types[1].a.toFixed(1)} de ${name(types[1].k)} (${types[1].n}).`,
      ...(types[0].k === 'REELS' ? { apply: { defaults: { reelMode: 'premium' } } } : {}) });
  }
  const perWeek = (m.posts.length / Math.max(1, days)) * 7;
  if (perWeek < 3) out.push({ title: 'Publicar com mais frequência', detail: `Foram ${m.posts.length} publicações no feed em ${days} dias (≈${perWeek.toFixed(1)} por semana). Use “Criar Minha Semana” para manter pelo menos 3 por semana no feed, além dos Stories diários.` });
  if (m.posts.length >= 6) {
    const slot: Record<string, number[]> = {};
    for (const p of m.posts) { const d = new Date(p.at); (slot[`${d.getDay()}|${String(d.getHours()).padStart(2, '0')}:00`] ??= []).push(eng(p)); }
    const best = Object.entries(slot).filter(([, v]) => v.length >= 2).map(([k, v]) => ({ k, a: avg(v) })).sort((x, y) => y.a - x.a)[0];
    if (best) { const [wd, h] = best.k.split('|'); out.push({ title: `Melhor horário: ${WD[Number(wd)]} às ${h}`, detail: `Publicações nesse horário tiveram ${best.a.toFixed(1)} interações em média. O horário passa a ser o padrão dos lotes de Stories.`, apply: { defaults: { bestTime: h } } }); }
    const withQ = m.posts.filter((p: any) => p.caption.includes('?')).map(eng), noQ = m.posts.filter((p: any) => !p.caption.includes('?')).map(eng);
    if (withQ.length >= 3 && noQ.length >= 3 && avg(withQ) > avg(noQ) * 1.25) out.push({ title: 'Legendas com pergunta', detail: `Legendas com pergunta tiveram ${avg(withQ).toFixed(1)} interações em média contra ${avg(noQ).toFixed(1)} sem pergunta.` });
  }
  if (ownVariation < 0.2 && m.posts.length >= 4) out.push({ title: 'Variar mais as edições', detail: `As peças geradas usaram em média ${Math.round(ownVariation * 100)}% de variação. Subir para 40% evita que o feed fique repetitivo.`, apply: { defaults: { variation: 0.4 } } });
  return out;
}

/** Diagnóstico + sugestões da IA a partir dos MESMOS números (nada estimado). */
async function aiAnalysis(db: DB, tenantId: string, data: unknown): Promise<{ diagnostico: string; pontosFortes: string[]; suggestions: Suggestion[] } | null> {
  if (!aiEnabled() || !withinLimit(db, tenantId, 'ai_call')) return null;
  const r = await metricsAnalysis(db, tenantId, data);
  return { diagnostico: String(r.diagnostico ?? ''), pontosFortes: Array.isArray(r.pontosFortes) ? r.pontosFortes : [], suggestions: (r.suggestions ?? []).slice(0, 8) };
}

export async function analyze(db: DB, tenantId: string, days = 7) {
  const to = new Date(), from = new Date(Date.now() - days * 86_400_000);
  const units = db.prepare('SELECT id, name, instagram FROM units WHERE tenant_id = ?').all(tenantId) as any[];
  const variations = (db.prepare("SELECT v.params FROM versions v JOIN productions p ON p.id = v.production_id WHERE p.tenant_id = ? AND v.created_at > ?").all(tenantId, from.getTime()) as any[]).map((r) => Number(pj<any>(r.params, {}).variation) || 0);
  const ownVariation = avg(variations);
  const reports = [];
  for (const u of units) {
    let m: Awaited<ReturnType<typeof accountMetrics>> = null, error: string | null = null;
    try { m = await accountMetrics(db, tenantId, u.id, from, to); } catch (e) { error = (e as Error).message; }
    const internal = {
      producoes: (db.prepare('SELECT COUNT(*) AS n FROM productions WHERE tenant_id = ? AND unit_id = ? AND created_at > ?').get(tenantId, u.id, from.getTime()) as any).n,
      publicadasPeloApp: (db.prepare("SELECT COUNT(*) AS n FROM calendar_entries WHERE tenant_id = ? AND unit_id = ? AND status = 'publicado' AND updated_at > ?").get(tenantId, u.id, from.getTime()) as any).n,
      dmsEnviadas: (db.prepare("SELECT COUNT(*) AS n FROM dm_events WHERE tenant_id = ? AND unit_id = ? AND status = 'enviado' AND at > ?").get(tenantId, u.id, from.getTime()) as any).n,
    };
    const suggestions: Suggestion[] = m ? localSuggestions(m, days, ownVariation) : [];
    if (m?.insightsError) suggestions.unshift({ title: 'Reconectar o Instagram para liberar alcance e visitas', detail: `A Meta recusou os dados de alcance (${m.insightsError}). A permissão de métricas foi adicionada ao app: abra a aba Instagram, clique em Desconectar e depois em Conectar com a Meta, e confirme as permissões.` });
    let engine = 'local', ia: Awaited<ReturnType<typeof aiAnalysis>> = null;
    if (m) { try { ia = await aiAnalysis(db, tenantId, { loja: u.name, dias: days, ...m, internal }); if (ia?.suggestions.length) { suggestions.push(...ia.suggestions); engine = 'local+ia'; } } catch (e) { console.error('[metricas-ia]', (e as Error).message); } }
    const data = { unit: u.name, instagram: u.instagram, connected: Boolean(m), error, metrics: m, internal, diagnostico: ia?.diagnostico ?? null, pontosFortes: ia?.pontosFortes ?? [] };
    const rid = id();
    db.prepare('INSERT INTO metrics_reports (id, tenant_id, unit_id, period_from, period_to, data, suggestions, engine, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(rid, tenantId, u.id, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), j(data), j(suggestions), engine, now());
    reports.push({ id: rid, ...data, suggestions });
  }
  const st = getSettings(db, tenantId);
  if (st.analysis?.autoApply) for (const r of reports) for (const s of r.suggestions) if (s.apply) applySuggestion(db, tenantId, s);
  return reports;
}

export function applySuggestion(db: DB, tenantId: string, s: Suggestion) {
  if (!s.apply?.defaults) return false;
  const st = getSettings(db, tenantId);
  saveSettings(db, tenantId, { ...st, defaults: { ...(st.defaults ?? {}), ...s.apply.defaults } });
  return true;
}

/** Agendador: roda a análise conforme a frequência escolhida pelo dono (07h). */
export async function scheduledAnalyses(db: DB, at = new Date()) {
  if (at.getHours() !== 7 || at.getMinutes() !== 0) return;
  for (const row of db.prepare('SELECT tenant_id, data FROM tenant_settings').all() as any[]) {
    const a = pj<Settings>(row.data, {}).analysis;
    const due = a?.frequency === 'diaria' || (a?.frequency === 'semanal' && at.getDay() === 1) || (a?.frequency === 'mensal' && at.getDate() === 1);
    if (due) await analyze(db, row.tenant_id, a!.days || (a!.frequency === 'mensal' ? 30 : a!.frequency === 'semanal' ? 7 : 1)).catch((e) => console.error('[metricas]', (e as Error).message));
  }
}
