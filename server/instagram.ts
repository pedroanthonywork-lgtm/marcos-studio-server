// Instagram Connection Manager — API oficial "Instagram API with Facebook Login" (graph.facebook.com).
// Motivo da troca (2026-11-08): música da Audio API, aceite automático de collab e mensagens (DM com link)
// só existem no Login do Facebook. Cada conta IG precisa ser Comercial/Criador e ligada a uma Página do Facebook.
// O dono autoriza na tela da Meta (nunca pedimos senha). O token da Página (derivado do token longo) não expira;
// fica criptografado (AES-256-GCM). Publicar exige: conta conectada + versão aprovada + mídia acessível publicamente.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type DB, id, j, now } from './db.ts';
import { decrypt, encrypt, randomToken } from './security.ts';

export const GRAPH = 'https://graph.facebook.com/v26.0';
export const IG_API = GRAPH;
export const IG_SCOPES = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'instagram_manage_comments', 'instagram_manage_messages', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'business_management'];
// Login do Instagram (Marcos Motos, 2026-11-11): o dono entra só com o Instagram profissional, sem Página do Facebook.
// Publica Story/Reel/post em graph.instagram.com; token de 60 dias renovado pelo agendador. Sem música/collab/DM (só no Login do Facebook).
export const IG_GRAPH = 'https://graph.instagram.com/v26.0';
export const IG_LOGIN_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'];
// Login unificado (apps Meta criados a partir de 2026): Login do Facebook para Empresas com config_id; a pessoa pode entrar
// com o Instagram, sem Página. Devolve token de usuário do sistema que não expira; as chamadas vão para graph.facebook.com
// com o ID explícito da conta IG (mesmo caminho do Login do Facebook: login = 'facebook').
const loginMode = () => (process.env.META_IG_CONFIG_ID ? 'unified' : process.env.META_IG_LOGIN === 'facebook' ? 'facebook' : 'instagram');
/** Host e "id do usuário" das chamadas, conforme o login com que a conta foi conectada. */
const via = (a: any) => (a.login === 'facebook' ? { host: GRAPH, me: String(a.ig_user_id) } : { host: IG_GRAPH, me: 'me' });

export const igConfig = () => ({
  appId: process.env.META_IG_APP_ID ?? '',
  appSecret: process.env.META_IG_APP_SECRET ?? '',
  redirectUri: process.env.META_IG_REDIRECT_URI ?? '',
  publicBase: process.env.PUBLIC_MEDIA_BASE_URL ?? '',
  verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? '',
});
export const igConfigured = () => { const c = igConfig(); return Boolean(c.appId && c.appSecret && c.redirectUri); };

type Fetch = typeof fetch;
let http: Fetch = (...a) => fetch(...a);
export const setHttp = (f: Fetch) => { http = f; };

async function call(url: string, init?: RequestInit) {
  const r = await http(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body as any).error) throw new Error((body as any).error?.message ?? `HTTP ${r.status}`);
  return body as any;
}
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const account = (db: DB, tenantId: string, unitId: string) => db.prepare("SELECT * FROM ig_accounts WHERE tenant_id = ? AND unit_id = ? AND status = 'conectado'").get(tenantId, unitId) as any;

export function authorizeUrl(db: DB, tenantId: string, unitId: string, userId: string): string {
  const c = igConfig();
  if (!igConfigured()) throw new Error('Integração Meta ainda não configurada (META_IG_APP_ID/SECRET/REDIRECT_URI).');
  const state = randomToken(24);
  db.prepare('INSERT INTO oauth_states (id, tenant_id, unit_id, user_id, expires_at) VALUES (?,?,?,?,?)').run(state, tenantId, unitId, userId, now() + 10 * 60_000);
  if (loginMode() === 'unified') return `https://www.facebook.com/v26.0/dialog/oauth?${q({ client_id: c.appId, config_id: process.env.META_IG_CONFIG_ID!, override_default_response_type: 'true', redirect_uri: c.redirectUri, response_type: 'code', state })}`;
  if (loginMode() === 'instagram') return `https://www.instagram.com/oauth/authorize?${q({ client_id: c.appId, redirect_uri: c.redirectUri, response_type: 'code', scope: IG_LOGIN_SCOPES.join(','), state, enable_fb_login: 'false' })}`;
  return `https://www.facebook.com/v26.0/dialog/oauth?${q({ client_id: c.appId, redirect_uri: c.redirectUri, response_type: 'code', scope: IG_SCOPES.join(','), state })}`;
}

export async function handleCallback(db: DB, code: string, state: string) {
  const st = db.prepare('SELECT * FROM oauth_states WHERE id = ?').get(state) as { tenant_id: string; unit_id: string; user_id: string; expires_at: number } | undefined;
  db.prepare('DELETE FROM oauth_states WHERE id = ?').run(state);
  if (!st || st.expires_at < now()) throw new Error('Autorização expirada. Tente conectar de novo.');
  const c = igConfig();
  if (loginMode() === 'unified') return unifiedCallback(db, st, c, code.replace(/#_$/, ''));
  if (loginMode() === 'instagram') return instagramCallback(db, st, c, code.replace(/#_$/, ''));
  const short = await call(`${GRAPH}/oauth/access_token?${q({ client_id: c.appId, client_secret: c.appSecret, redirect_uri: c.redirectUri, code })}`);
  const long = await call(`${GRAPH}/oauth/access_token?${q({ grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: short.access_token })}`);
  const pages = await call(`${GRAPH}/me/accounts?${q({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: long.access_token })}`);
  const unit = db.prepare('SELECT instagram FROM units WHERE id = ?').get(st.unit_id) as any;
  const withIg = (pages.data ?? []).filter((p: any) => p.instagram_business_account);
  // a conta escolhida é a do @ da unidade; se o dono autorizou só uma página com Instagram, usa essa
  const pg = withIg.find((p: any) => p.instagram_business_account.username?.toLowerCase() === String(unit?.instagram ?? '').toLowerCase()) ?? (withIg.length === 1 ? withIg[0] : null);
  if (!pg) throw new Error(withIg.length ? `Nenhuma página autorizada tem o Instagram @${unit?.instagram}. Autorize a página certa.` : 'Nenhuma Página do Facebook com Instagram Comercial foi autorizada.');
  const ig = pg.instagram_business_account;
  // recebe comentários e mensagens (DM automática com link)
  await call(`${GRAPH}/${pg.id}/subscribed_apps?${q({ subscribed_fields: 'feed,messages', access_token: pg.access_token })}`, { method: 'POST' }).catch(() => null);
  db.prepare(`INSERT INTO ig_accounts (id, tenant_id, unit_id, ig_user_id, username, token_enc, token_expires_at, scopes, status, connected_at, last_error, page_id, login)
    VALUES (?,?,?,?,?,?,?,?, 'conectado', ?, NULL, ?, 'facebook')
    ON CONFLICT (tenant_id, unit_id) DO UPDATE SET ig_user_id = excluded.ig_user_id, username = excluded.username, token_enc = excluded.token_enc,
      token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, status = 'conectado', connected_at = excluded.connected_at, last_error = NULL,
      page_id = excluded.page_id, login = 'facebook'`)
    .run(id(), st.tenant_id, st.unit_id, String(ig.id), ig.username, encrypt(pg.access_token), now() + 3650 * 86_400_000, IG_SCOPES.join(','), now(), String(pg.id));
  log(db, st.tenant_id, null, st.unit_id, 'conectar', 'ok', { username: ig.username, page: pg.name });
  return { tenantId: st.tenant_id, unitId: st.unit_id, username: ig.username as string };
}

/** Login unificado: código → token do usuário do sistema (não expira) → contas IG concedidas (debug_token; com reservas). */
async function unifiedCallback(db: DB, st: { tenant_id: string; unit_id: string }, c: ReturnType<typeof igConfig>, code: string) {
  const tok = (await call(`${GRAPH}/oauth/access_token?${q({ client_id: c.appId, client_secret: c.appSecret, redirect_uri: c.redirectUri, code })}`)).access_token as string;
  const ids = new Set<string>();
  // contas IG que a pessoa liberou na tela da Meta aparecem como alvo das permissões instagram_*
  const dbg = await call(`${GRAPH}/debug_token?${q({ input_token: tok, access_token: `${c.appId}|${c.appSecret}` })}`).catch(() => null);
  for (const g of dbg?.data?.granular_scopes ?? []) if (String(g.scope).startsWith('instagram_')) for (const t of g.target_ids ?? []) ids.add(String(t));
  for (const path of ['me/assigned_instagram_accounts?fields=id', 'me/instagram_accounts?fields=id', 'me/accounts?fields=instagram_business_account{id}']) {
    if (ids.size) break;
    const r = await call(`${GRAPH}/${path}&${q({ access_token: tok })}`).catch(() => null);
    for (const x of r?.data ?? []) { const v = x.instagram_business_account?.id ?? (path.startsWith('me/accounts') ? null : x.id); if (v) ids.add(String(v)); }
  }
  const accs = (await Promise.all([...ids].map((i) => call(`${GRAPH}/${i}?${q({ fields: 'id,username', access_token: tok })}`).catch(() => null)))).filter(Boolean) as any[];
  const unit = db.prepare('SELECT instagram FROM units WHERE id = ?').get(st.unit_id) as any;
  const ig = accs.find((a) => a.username?.toLowerCase() === String(unit?.instagram ?? '').toLowerCase()) ?? (accs.length === 1 ? accs[0] : null);
  if (!ig) throw new Error(accs.length ? `A conta liberada não é a @${unit?.instagram}. Conecte de novo e escolha @${unit?.instagram}.` : 'Nenhuma conta do Instagram foi liberada para o app. Conecte de novo e marque a conta da loja.');
  db.prepare(`INSERT INTO ig_accounts (id, tenant_id, unit_id, ig_user_id, username, token_enc, token_expires_at, scopes, status, connected_at, last_error, page_id, login)
    VALUES (?,?,?,?,?,?,?,?, 'conectado', ?, NULL, NULL, 'facebook')
    ON CONFLICT (tenant_id, unit_id) DO UPDATE SET ig_user_id = excluded.ig_user_id, username = excluded.username, token_enc = excluded.token_enc,
      token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, status = 'conectado', connected_at = excluded.connected_at, last_error = NULL,
      page_id = NULL, login = 'facebook'`)
    .run(id(), st.tenant_id, st.unit_id, String(ig.id), ig.username, encrypt(tok), now() + 3650 * 86_400_000, 'unificado:' + (process.env.META_IG_CONFIG_ID ?? ''), now());
  log(db, st.tenant_id, null, st.unit_id, 'conectar', 'ok', { username: ig.username, login: 'unificado' });
  return { tenantId: st.tenant_id, unitId: st.unit_id, username: ig.username as string };
}

/** Login do Instagram: código → token curto → token longo (60 dias) → conta (/me). */
async function instagramCallback(db: DB, st: { tenant_id: string; unit_id: string }, c: ReturnType<typeof igConfig>, code: string) {
  const short = await call('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: q({ client_id: c.appId, client_secret: c.appSecret, grant_type: 'authorization_code', redirect_uri: c.redirectUri, code }) });
  const long = await call(`https://graph.instagram.com/access_token?${q({ grant_type: 'ig_exchange_token', client_secret: c.appSecret, access_token: short.access_token })}`);
  const me = await call(`${IG_GRAPH}/me?${q({ fields: 'user_id,username,account_type', access_token: long.access_token })}`);
  const igId = String(me.user_id ?? me.id);
  db.prepare(`INSERT INTO ig_accounts (id, tenant_id, unit_id, ig_user_id, username, token_enc, token_expires_at, scopes, status, connected_at, last_error, page_id, login)
    VALUES (?,?,?,?,?,?,?,?, 'conectado', ?, NULL, NULL, 'instagram')
    ON CONFLICT (tenant_id, unit_id) DO UPDATE SET ig_user_id = excluded.ig_user_id, username = excluded.username, token_enc = excluded.token_enc,
      token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, status = 'conectado', connected_at = excluded.connected_at, last_error = NULL,
      page_id = NULL, login = 'instagram'`)
    .run(id(), st.tenant_id, st.unit_id, igId, me.username, encrypt(long.access_token), now() + Number(long.expires_in ?? 5_184_000) * 1000, String(short.permissions ?? IG_LOGIN_SCOPES.join(',')), now());
  log(db, st.tenant_id, null, st.unit_id, 'conectar', 'ok', { username: me.username, login: 'instagram', tipo: me.account_type });
  return { tenantId: st.tenant_id, unitId: st.unit_id, username: me.username as string };
}

/** Confere se o token ainda vale (senha trocada, permissão removida…). Login do Instagram: renova o token de 60 dias
 *  quando faltam menos de 30 (a Meta exige token com 24 h+ e ainda válido). Token de Página (Login do Facebook) não expira. */
export async function refreshTokens(db: DB) {
  const rows = db.prepare("SELECT * FROM ig_accounts WHERE status = 'conectado'").all() as any[];
  for (const a of rows) {
    try {
      if (a.login === 'facebook') { await call(`${GRAPH}/${a.ig_user_id}?${q({ fields: 'id', access_token: decrypt(a.token_enc) })}`); continue; }
      if (a.token_expires_at - now() < 30 * 86_400_000 && now() - (a.connected_at ?? 0) > 86_400_000) {
        const r = await call(`https://graph.instagram.com/refresh_access_token?${q({ grant_type: 'ig_refresh_token', access_token: decrypt(a.token_enc) })}`);
        db.prepare('UPDATE ig_accounts SET token_enc = ?, token_expires_at = ?, connected_at = ? WHERE id = ?').run(encrypt(r.access_token), now() + Number(r.expires_in ?? 5_184_000) * 1000, now(), a.id);
        log(db, a.tenant_id, null, a.id, 'renovar-token', 'ok');
      } else await call(`${IG_GRAPH}/me?${q({ fields: 'user_id', access_token: decrypt(a.token_enc) })}`);
    }
    catch (e) {
      db.prepare("UPDATE ig_accounts SET status = 'reconectar', last_error = ? WHERE id = ?").run((e as Error).message, a.id);
      log(db, a.tenant_id, null, a.id, 'verificar-token', 'erro', (e as Error).message);
    }
  }
}

export function log(db: DB, tenantId: string, calendarId: string | null, accountId: string | null, action: string, status: string, detail?: unknown) {
  db.prepare('INSERT INTO publish_log (id, tenant_id, calendar_id, account_id, action, status, detail, at) VALUES (?,?,?,?,?,?,?,?)').run(id(), tenantId, calendarId, accountId, action, status, detail === undefined ? null : j(detail), now());
}

export type PublishMedia = { kind: 'story' | 'carousel' | 'reel' | 'image'; urls: string[]; isVideo: boolean[]; caption: string;
  /** Audio API: música do catálogo do Instagram anexada ao Reel (nome aparece no post) */ audioId?: string;
  /** usernames convidados como colaboradores (post, carrossel, Reel; Story não aceita) */ collaborators?: string[] };

/** Publicação real: container(s) → aguarda FINISHED → media_publish. Retorna o ID da mídia confirmado pela Meta. */
export async function publish(db: DB, tenantId: string, unitId: string, m: PublishMedia, opts: { pollMs?: number; maxPolls?: number } = {}) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conta do Instagram desta unidade não está conectada.');
  const token = decrypt(a.token_enc);
  const v = via(a), base = `${v.host}/${v.me}`;
  const post = (path: string, params: Record<string, string>) => call(`${path}?${q({ ...params, access_token: token })}`, { method: 'POST' });
  const wait = async (cid: string) => {
    for (let i = 0; i < (opts.maxPolls ?? 10); i++) {
      const s = await call(`${v.host}/${cid}?${q({ fields: 'status_code', access_token: token })}`);
      if (s.status_code === 'FINISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Container ${s.status_code}`);
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 30_000));
    }
    throw new Error('Tempo esgotado aguardando processamento da Meta.');
  };
  const collab: Record<string, string> = m.collaborators?.length && m.kind !== 'story' ? { collaborators: JSON.stringify(m.collaborators.slice(0, 3)) } : {};
  let creation: string;
  if (m.kind === 'carousel' && m.urls.length !== 1) { // 1 item (ex.: card de moto 4:5) sai como post de foto, no último ramo
    if (m.urls.length < 2 || m.urls.length > 20) throw new Error('Carrossel precisa de 2 a 20 itens.');
    const children: string[] = [];
    for (let i = 0; i < m.urls.length; i++) {
      const c = await post(`${base}/media`, m.isVideo[i] ? { media_type: 'VIDEO', video_url: m.urls[i], is_carousel_item: 'true' } : { image_url: m.urls[i], is_carousel_item: 'true' });
      children.push(c.id);
    }
    for (const c of children) await wait(c);
    creation = (await post(`${base}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: m.caption, ...collab })).id;
  } else if (m.kind === 'reel') {
    const audio: Record<string, string> = m.audioId ? { audio_configuration: JSON.stringify({ audio_id: m.audioId }) } : {};
    creation = (await post(`${base}/media`, { media_type: 'REELS', video_url: m.urls[0], caption: m.caption, ...collab, ...audio })).id;
  } else if (m.kind === 'story') {
    creation = (await post(`${base}/media`, m.isVideo[0] ? { media_type: 'STORIES', video_url: m.urls[0] } : { media_type: 'STORIES', image_url: m.urls[0] })).id;
  } else {
    creation = (await post(`${base}/media`, { image_url: m.urls[0], caption: m.caption, ...collab })).id;
  }
  await wait(creation);
  const pub = await post(`${base}/media_publish`, { creation_id: creation });
  return { mediaId: String(pub.id), account: a.username as string };
}

/** Collab automática: as outras lojas aceitam o convite pela API (Collaboration Invites, Login do Facebook). */
export async function acceptCollab(db: DB, tenantId: string, unitId: string, mediaId: string, tries = 4, waitMs = 15_000) {
  const a = account(db, tenantId, unitId);
  if (!a || a.login !== 'facebook') return { ok: false, error: 'conta não conectada pelo Login do Facebook' };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await call(`${GRAPH}/${a.ig_user_id}/collaboration_invites?${q({ media_id: mediaId, accept: 'true', access_token: decrypt(a.token_enc) })}`, { method: 'POST' });
      if (r.success) return { ok: true };
    } catch (e) { if (i === tries - 1) return { ok: false, error: (e as Error).message }; }
    await new Promise((r) => setTimeout(r, waitMs)); // o convite pode levar alguns segundos para existir
  }
  return { ok: false, error: 'convite não encontrado' };
}

/** Audio API: músicas liberadas para uso por terceiros. Sem busca = em alta agora. */
export async function searchAudio(db: DB, tenantId: string, unitId: string, search: string) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conecte o Instagram desta loja (Login do Facebook) para buscar as músicas do Instagram.');
  if (a.login !== 'facebook') throw new Error('Reconecte esta loja: a música do Instagram exige o Login do Facebook.');
  const r = await call(`${GRAPH}/ig_audio?${q({ audio_type: 'music', user_id: a.ig_user_id, ...(search ? { search_query: search } : {}), access_token: decrypt(a.token_enc) })}`);
  return (r.data ?? []).slice(0, 40).map((x: any) => ({ id: String(x.audio_id ?? x.id), title: x.title ?? 'Sem título', artist: x.display_artist ?? x.ig_username ?? undefined, preview: x.on_platform_audio_preview_link ?? undefined }));
}

export async function mediaInsights(db: DB, tenantId: string, unitId: string, mediaId: string) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conta não conectada.');
  return call(`${via(a).host}/${mediaId}/insights?${q({ metric: 'reach,likes,comments,saved,shares', access_token: decrypt(a.token_enc) })}`);
}

/** Números reais da conta no período (somente o que a Meta devolve; nada é estimado). */
export async function accountMetrics(db: DB, tenantId: string, unitId: string, since: Date, until: Date) {
  const a = account(db, tenantId, unitId);
  if (!a) return null;
  const token = decrypt(a.token_enc), v = via(a);
  const s = String(Math.floor(since.getTime() / 1000)), u = String(Math.floor(until.getTime() / 1000));
  const profile = await call(`${v.host}/${v.me}?${q({ fields: 'followers_count,media_count,username', access_token: token })}`);
  const ins = await call(`${v.host}/${v.me}/insights?${q({ metric: 'reach,profile_views,accounts_engaged,total_interactions,follows_and_unfollows', metric_type: 'total_value', period: 'day', since: s, until: u, access_token: token })}`).catch((e) => ({ error: (e as Error).message }));
  const media = await call(`${v.host}/${v.me}/media?${q({ fields: 'id,media_type,media_product_type,timestamp,like_count,comments_count,caption,permalink', limit: '50', since: s, until: u, access_token: token })}`).catch(() => ({ data: [] }));
  const totals: Record<string, number> = {};
  for (const m of (ins as any).data ?? []) totals[m.name] = m.total_value?.value ?? (m.values ?? []).reduce((x: number, v: any) => x + (Number(v.value) || 0), 0);
  // séries por dia para os gráficos (a Meta só devolve até 30 dias por chamada; seguidores excluem o dia de hoje)
  const s30 = String(Math.max(Number(s), Math.floor(until.getTime() / 1000) - 30 * 86400));
  const series: Record<string, { date: string; value: number }[]> = {};
  for (const metric of ['reach', 'follower_count']) {
    const r = await call(`${v.host}/${v.me}/insights?${q({ metric, period: 'day', since: s30, until: u, access_token: token })}`).catch(() => null);
    const vals = r?.data?.[0]?.values;
    if (Array.isArray(vals)) series[metric] = vals.map((x: any) => ({ date: String(x.end_time ?? '').slice(0, 10), value: Number(x.value) || 0 }));
  }
  const posts = (media.data ?? []).map((m: any) => ({ id: m.id, type: m.media_product_type ?? m.media_type, at: m.timestamp, likes: m.like_count ?? 0, comments: m.comments_count ?? 0, caption: String(m.caption ?? '').slice(0, 80), link: m.permalink } as any));
  // alcance, salvamentos, compartilhamentos e visualizações por publicação (até 12, as mais recentes)
  for (const p of posts.slice(0, 12)) {
    const r = await call(`${v.host}/${p.id}/insights?${q({ metric: 'reach,saved,shares,views', access_token: token })}`)
      .catch(() => call(`${v.host}/${p.id}/insights?${q({ metric: 'reach,saved,shares', access_token: token })}`)).catch(() => null);
    for (const x of r?.data ?? []) p[x.name] = Number(x.values?.[0]?.value ?? x.total_value?.value) || 0;
  }
  return { username: profile.username, followers: profile.followers_count, mediaCount: profile.media_count, totals, series, insightsError: (ins as any).error ?? null, posts };
}

// ───────── Direct (caixa de entrada) ─────────
// Lê conversas e responde pela API oficial de mensagens. Regras da Meta: só responde até 24 h depois da última
// mensagem do cliente, e mensagens para quem não tem função no app exigem acesso avançado (análise do app).
const dmBase = (a: any) => { const v = via(a); return { host: v.host, owner: a.page_id ?? v.me, token: decrypt(a.token_enc) }; };

export async function dmConversations(db: DB, tenantId: string, unitId: string) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conecte o Instagram da loja para ver o Direct.');
  const b = dmBase(a);
  const r = await call(`${b.host}/${b.owner}/conversations?${q({ platform: 'instagram', fields: 'id,updated_time,participants,messages.limit(1){message,from,created_time}', limit: '40', access_token: b.token })}`);
  return (r.data ?? []).map((c: any) => {
    const other = (c.participants?.data ?? []).find((p: any) => String(p.id) !== String(a.ig_user_id) && p.username !== a.username) ?? {};
    const last = c.messages?.data?.[0];
    return { id: c.id, updatedAt: c.updated_time, with: { id: String(other.id ?? ''), username: other.username ?? 'cliente' },
      last: last ? { text: last.message ?? '(anexo)', fromMe: String(last.from?.id) === String(a.ig_user_id) || last.from?.username === a.username, at: last.created_time } : null };
  });
}

export async function dmMessages(db: DB, tenantId: string, unitId: string, conversationId: string) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conta não conectada.');
  const b = dmBase(a);
  const r = await call(`${b.host}/${encodeURIComponent(conversationId)}?${q({ fields: 'participants,messages.limit(40){id,message,from,created_time,attachments}', access_token: b.token })}`);
  const other = (r.participants?.data ?? []).find((p: any) => String(p.id) !== String(a.ig_user_id) && p.username !== a.username) ?? {};
  const msgs = (r.messages?.data ?? []).map((m: any) => ({ id: m.id, text: m.message || (m.attachments ? '(anexo)' : ''), at: m.created_time,
    fromMe: String(m.from?.id) === String(a.ig_user_id) || m.from?.username === a.username })).reverse();
  return { with: { id: String(other.id ?? ''), username: other.username ?? 'cliente' }, messages: msgs };
}

export async function dmSend(db: DB, tenantId: string, unitId: string, recipientId: string, text: string) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conta não conectada.');
  const b = dmBase(a);
  const r = await call(`${b.host}/${b.owner}/messages?${q({ access_token: b.token })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }) });
  log(db, tenantId, null, a.id, 'direct-resposta', 'ok', { to: recipientId });
  return { messageId: r.message_id ?? null };
}

// ───────── Webhook da Meta: DM automática com link ─────────

export function verifySignature(raw: Buffer | undefined, header: string | undefined) {
  const secret = igConfig().appSecret;
  if (!raw || !header?.startsWith('sha256=') || !secret) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Mensagem que vai na DM: texto do cliente (se houver) + link. */
const dmText = (dm: { url: string; message?: string }) => `${dm.message?.trim() || 'Aqui está o link que você pediu:'} ${dm.url}`;

/**
 * Processa eventos (comentários e respostas a Story). Só responde quando a palavra-chave da peça aparece no texto,
 * uma vez por pessoa por publicação. Respostas: comentário → resposta privada; Story → mensagem direta.
 */
export async function handleWebhook(db: DB, body: any) {
  const out: string[] = [];
  for (const entry of body?.entry ?? []) {
    const events: { source: 'comentario' | 'story'; mediaId?: string; from?: string; text: string; commentId?: string; igUserId: string }[] = [];
    for (const ch of entry.changes ?? []) if (ch.field === 'comments' && ch.value) events.push({ source: 'comentario', mediaId: ch.value.media?.id, from: ch.value.from?.id, text: ch.value.text ?? '', commentId: ch.value.id, igUserId: String(entry.id) });
    for (const m of entry.messaging ?? []) if (m.message?.reply_to?.story && !m.message.is_echo) events.push({ source: 'story', mediaId: m.message.reply_to.story.id, from: m.sender?.id, text: m.message.text ?? '', igUserId: String(entry.id) });
    for (const ev of events) {
      const acc = db.prepare("SELECT * FROM ig_accounts WHERE ig_user_id = ? AND status = 'conectado'").get(ev.igUserId) as any;
      if (!acc || !ev.mediaId || !ev.from || ev.from === acc.ig_user_id) continue;
      // a mesma peça pode ter sido publicada em várias contas (Story nas 3 lojas): o mapa liga cada ID da Meta ao item do calendário
      const cal = db.prepare('SELECT c.*, v.params FROM ig_media_map mm JOIN calendar_entries c ON c.id = mm.calendar_id JOIN productions p ON p.id = c.production_id JOIN versions v ON v.id = p.current_version_id WHERE mm.ig_media_id = ? AND c.tenant_id = ?').get(ev.mediaId, acc.tenant_id) as any;
      const dm = cal ? JSON.parse(cal.params ?? '{}').dmLink : null;
      if (!dm?.url || !new RegExp(`(^|\\W)${dm.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(ev.text.normalize('NFC'))) continue;
      const done = db.prepare("SELECT 1 FROM dm_events WHERE ig_media_id = ? AND from_id = ? AND status = 'enviado'").get(ev.mediaId, ev.from);
      if (done) continue;
      const recipient = ev.source === 'comentario' ? { comment_id: ev.commentId } : { id: ev.from };
      try {
        await call(`${GRAPH}/${acc.page_id ?? 'me'}/messages?${q({ access_token: decrypt(acc.token_enc) })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient, message: { text: dmText(dm) } }) });
        db.prepare('INSERT INTO dm_events (id, tenant_id, unit_id, source, ig_media_id, from_id, text, status, at) VALUES (?,?,?,?,?,?,?,?,?)').run(id(), acc.tenant_id, acc.unit_id, ev.source, ev.mediaId, ev.from, ev.text.slice(0, 300), 'enviado', now());
        out.push('enviado');
      } catch (e) {
        db.prepare('INSERT INTO dm_events (id, tenant_id, unit_id, source, ig_media_id, from_id, text, status, detail, at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id(), acc.tenant_id, acc.unit_id, ev.source, ev.mediaId, ev.from, ev.text.slice(0, 300), 'erro', (e as Error).message, now());
        out.push('erro');
      }
    }
  }
  return out;
}

/** Apaga uma publicação pela API oficial (usado para tirar os Stories do dia às 23h55). */
export async function deleteMedia(db: DB, tenantId: string, unitId: string, mediaId: string) {
  const a = account(db, tenantId, unitId);
  if (!a) throw new Error('Conta não conectada.');
  const r = await call(`${via(a).host}/${mediaId}?${q({ access_token: decrypt(a.token_enc) })}`, { method: 'DELETE' });
  if (r.success === false) throw new Error('A Meta recusou a exclusão.');
  return true;
}

/** 23h55: apaga os Stories publicados hoje (se o cliente ligou a opção). Se a Meta recusar, registra para apagar no celular. */
export async function dailyStoryCleanup(db: DB, at = new Date()) {
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const today = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  for (const row of db.prepare('SELECT tenant_id, data FROM tenant_settings').all() as any[]) {
    let st: any = {}; try { st = JSON.parse(row.data).stories ?? {}; } catch { /* sem preferência */ }
    if (!st.autoDelete || (st.at ?? '23:55') !== hhmm) continue;
    const items = db.prepare("SELECT mm.ig_media_id, mm.unit_id, c.id AS cid FROM ig_media_map mm JOIN calendar_entries c ON c.id = mm.calendar_id WHERE c.tenant_id = ? AND c.kind = 'story' AND c.status = 'publicado' AND c.date = ?").all(row.tenant_id, today) as any[];
    for (const it of items) {
      try { await deleteMedia(db, row.tenant_id, it.unit_id, it.ig_media_id); db.prepare("UPDATE calendar_entries SET status = 'removido', updated_at = ? WHERE id = ?").run(now(), it.cid); log(db, row.tenant_id, it.cid, null, 'apagar-story', 'ok', { mediaId: it.ig_media_id }); }
      catch (e) { log(db, row.tenant_id, it.cid, null, 'apagar-story', 'erro', `${(e as Error).message} · apague no celular`); }
    }
  }
}