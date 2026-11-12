// API do Marcos Motos Digital Experience. Cada consulta filtra por tenant_id da sessão (isolamento entre clientes).
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, renameSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { type DB, audit, id, j, now, pj, tx, DATA_DIR } from './db.ts';
import { createSession, invite, loadUser, login, requireAuth, resendVerification, setSessionCookie, verifyEmail, rateLimited, type Me, SESSION_COOKIE } from './auth.ts';
import { checkLicenseKey, issueLicense, licenseState, monthUsage, PLANS, recordUsage, renewLicense, setLicenseStatus, withinLimit } from './license.ts';
import { store, signMediaLink, checkMediaLink, MEDIA_DIR } from './media.ts';
import { interpretInstruction, review, aiEnabled, briefing, designs } from './agents.ts';
import { SEASONS, upcomingSeasons, type DesignInput } from '../shared/design.ts';
import { buildPlan } from '../shared/planner.ts';
import { defaultCarousel, defaultReel, defaultStory, type MediaRef, type Params, type StoryKind, type CarouselModel } from '../shared/templates.ts';
import { authorizeUrl, handleCallback, igConfigured, igConfig, publish, log as igLog, mediaInsights, acceptCollab, searchAudio, verifySignature, handleWebhook, dmConversations, dmMessages, dmSend } from './instagram.ts';
import { startStrategy, latestStrategies, suggestReply } from './strategy.ts';
import { randomToken, sha256 } from './security.ts';
import { syncStock } from './stock.ts';
import { analyze, applySuggestion, getSettings, saveSettings } from './metrics.ts';

export const ENGINE_OPS = ['render.story', 'render.carousel', 'render.reel', 'analyze.video'] as const;
const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 3;
const BRAND_DIR = resolve('brand-intelligence');

const appUrl = (req: Request) => process.env.APP_URL ?? `${req.protocol}://${req.get('host')}`;
const ah = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function createApp(db: DB) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // a prévia do card de moto é o próprio card.html num iframe da mesma origem
    res.setHeader('X-Frame-Options', req.path.startsWith('/moto/') ? 'SAMEORIGIN' : 'DENY');
    next();
  });
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } })); // corpo cru: assinatura do webhook da Meta
  app.use(loadUser(db));
  const tmpDir = join(DATA_DIR, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const upload = multer({ dest: tmpDir, limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 40 } });
  const auth = requireAuth(db);
  const editor = requireAuth(db, { roles: ['owner', 'editor', 'p7admin'] });
  const owner = requireAuth(db, { roles: ['owner', 'p7admin'] });
  const admin = requireAuth(db, { roles: ['p7admin'], skipLicense: true });

  const unitOf = (me: Me, unitId: unknown) => db.prepare('SELECT * FROM units WHERE id = ? AND tenant_id = ?').get(String(unitId ?? ''), me.tenant_id) as any;
  const mediaOf = (me: { tenant_id: string }, mid: unknown) => db.prepare('SELECT * FROM media WHERE id = ? AND tenant_id = ?').get(String(mid ?? ''), me.tenant_id) as any;
  const prodOf = (me: Me, pid: unknown) => db.prepare('SELECT * FROM productions WHERE id = ? AND tenant_id = ?').get(String(pid ?? ''), me.tenant_id) as any;
  const versionOf = (me: Me, vid: unknown) => db.prepare('SELECT v.*, p.tenant_id, p.type, p.unit_id FROM versions v JOIN productions p ON p.id = v.production_id WHERE v.id = ? AND p.tenant_id = ?').get(String(vid ?? ''), me.tenant_id) as any;
  const mediaJson = (m: any) => m && ({ id: m.id, unitId: m.unit_id, kind: m.kind, category: m.category, collection: m.collection, campaign: m.campaign, product: m.product, status: m.status,
    tags: pj(m.tags, []), filename: m.filename, mime: m.mime, size: m.size, sha256: m.sha256, width: m.width, height: m.height, duration: m.duration, origin: m.origin,
    createdAt: m.created_at, url: `/api/media/${m.id}/file`, thumb: m.thumb_path ? `/api/media/${m.id}/thumb` : null });
  const versionJson = (v: any) => v && ({ id: v.id, n: v.n, params: pj(v.params, {}), instruction: v.instruction, changes: pj(v.changes, []), parentId: v.parent_id,
    status: v.status, outputs: pj<any[]>(v.outputs, []).map((o) => ({ ...o, url: `/api/media/${o.mediaId}/file` })), createdAt: v.created_at, approvedAt: v.approved_at, review: review(pj(v.params, {}) as Params) });

  // ───────── Autenticação ─────────
  app.post('/api/auth/login', ah((req, res) => {
    if (rateLimited(db, 'login-ip:' + req.ip, 20, 15 * 60_000)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const r = login(db, req.body?.email, req.body?.password);
    if (!r.user) return res.status(r.code ? 403 : 401).json({ error: r.error, code: r.code });
    setSessionCookie(res, createSession(db, r.user.id));
    audit(db, r.user.tenant_id, r.user.id, 'login');
    res.json({ ok: true });
  }));
  app.post('/api/auth/logout', (req, res) => {
    const raw = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + '='))?.split('=')[1];
    if (raw) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(decodeURIComponent(raw)));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  app.post('/api/auth/verify-email', ah((req, res) => {
    const r = verifyEmail(db, req.body?.token, req.body?.password);
    if (!r.ok) return res.status(400).json({ error: r.error });
    setSessionCookie(res, createSession(db, r.userId));
    res.json({ ok: true });
  }));
  app.post('/api/auth/resend', ah(async (req, res) => {
    const r = await resendVerification(db, req.body?.email, req.ip ?? '', appUrl(req));
    if (r.limited) return res.status(429).json({ error: 'Limite de reenvios atingido. Tente novamente em 1 hora.' });
    res.json({ ok: true, message: 'Se o e-mail tiver um convite pendente, enviamos um novo link.' });
  }));
  app.get('/api/me', (req, res) => {
    if (!req.me) return res.status(401).json({ error: 'não autenticado' });
    const t = db.prepare('SELECT id, name, slug FROM tenants WHERE id = ?').get(req.me.tenant_id);
    res.json({ user: { id: req.me.id, name: req.me.name, email: req.me.email, role: req.me.role, verified: Boolean(req.me.email_verified_at) }, tenant: t, license: licenseState(db, req.me.tenant_id), aiEnabled: aiEnabled(), igConfigured: igConfigured() });
  });
  app.get('/api/users', owner, (req, res) => {
    res.json(db.prepare('SELECT id, name, email, role, email_verified_at, created_at FROM users WHERE tenant_id = ? ORDER BY created_at').all(req.me!.tenant_id));
  });
  app.post('/api/users/invite', owner, ah(async (req, res) => {
    try { res.json(await invite(db, req.me!, req.body ?? {}, appUrl(req))); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));

  // ───────── Unidades, marca ─────────
  app.get('/api/units', auth, (req, res) => {
    const units = (db.prepare('SELECT * FROM units WHERE tenant_id = ? ORDER BY name').all(req.me!.tenant_id) as any[]).map((u) => ({ ...u, data: pj(u.data, {}) }));
    const ig = db.prepare('SELECT unit_id, username, status, token_expires_at, last_error FROM ig_accounts WHERE tenant_id = ?').all(req.me!.tenant_id) as any[];
    res.json(units.map((u) => ({ ...u, ig: ig.find((a) => a.unit_id === u.id) ?? null })));
  });
  app.get('/api/brand', auth, (req, res) => {
    const brand = existsSync(join(BRAND_DIR, 'brand.json')) ? JSON.parse(readFileSync(join(BRAND_DIR, 'brand.json'), 'utf8')) : {};
    const memory = db.prepare("SELECT * FROM brand_memory WHERE tenant_id = ? AND status = 'ativo' ORDER BY created_at DESC LIMIT 200").all(req.me!.tenant_id);
    res.json({ brand, memory: (memory as any[]).map((m) => ({ ...m, data: pj(m.data, {}) })) });
  });
  app.post('/api/brand/memory', editor, (req, res) => {
    const kind = ['preferencia', 'aprovado', 'correcao', 'proibido'].includes(req.body?.kind) ? req.body.kind : 'preferencia';
    const text = str(req.body?.text, 600);
    if (!text) return res.status(400).json({ error: 'Descreva a preferência.' });
    const unit = req.body?.unitId ? unitOf(req.me!, req.body.unitId) : null;
    const mid = id();
    db.prepare('INSERT INTO brand_memory (id, tenant_id, kind, unit_id, text, source, created_at) VALUES (?,?,?,?,?,?,?)').run(mid, req.me!.tenant_id, kind, unit?.id ?? null, text, `manual:${req.me!.name}`, now());
    res.json({ id: mid });
  });
  app.delete('/api/brand/memory/:id', editor, (req, res) => {
    db.prepare("UPDATE brand_memory SET status = 'arquivado' WHERE id = ? AND tenant_id = ?").run(String(req.params.id), req.me!.tenant_id);
    res.json({ ok: true });
  });

  // ───────── Biblioteca de mídia ─────────
  app.get('/api/media', auth, (req, res) => {
    const q = req.query;
    const where = ['tenant_id = ?'];
    const args: any[] = [req.me!.tenant_id];
    for (const [k, col] of [['unit', 'unit_id'], ['kind', 'kind'], ['category', 'category'], ['collection', 'collection'], ['campaign', 'campaign'], ['status', 'status'], ['origin', 'origin']] as const) {
      if (q[k]) { where.push(`${col} = ?`); args.push(String(q[k])); }
    }
    if (q.q) { where.push('(filename LIKE ? OR tags LIKE ? OR product LIKE ? OR collection LIKE ? OR campaign LIKE ?)'); const s = `%${String(q.q).slice(0, 80)}%`; args.push(s, s, s, s, s); }
    if (q.from) { where.push('created_at >= ?'); args.push(Date.parse(String(q.from)) || 0); }
    if (!q.status) where.push("status != 'arquivado'"); // vendidos/arquivados só aparecem filtrando por "arquivado"
    const rows = db.prepare(`SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`).all(...args);
    res.json((rows as any[]).map(mediaJson));
  });
  app.post('/api/media', editor, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), ah(async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const f = files?.file?.[0];
    if (!f) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const st = await store(req.me!.tenant_id, f.path);
    if ('error' in st) return res.status(415).json({ error: st.error });
    let thumbPath: string | null = null;
    const t = files?.thumb?.[0];
    if (t) { const ts = await store(req.me!.tenant_id, t.path); if (!('error' in ts) && ts.kind === 'image') thumbPath = ts.path; }
    const dup = db.prepare('SELECT * FROM media WHERE tenant_id = ? AND sha256 = ? AND origin = ?').get(req.me!.tenant_id, st.sha, 'upload') as any;
    if (dup) return res.json({ ...mediaJson(dup), duplicate: true });
    const b = req.body ?? {};
    const unit = b.unitId ? unitOf(req.me!, b.unitId) : null;
    const mid = id();
    const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    db.prepare(`INSERT INTO media (id, tenant_id, unit_id, kind, category, collection, campaign, product, status, tags, filename, mime, size, sha256, width, height, duration, path, thumb_path, origin, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(mid, req.me!.tenant_id, unit?.id ?? null, st.kind, str(b.category, 60) || null, str(b.collection, 80) || null, str(b.campaign, 80) || null,
      str(b.product, 120) || null, 'novo', j(String(b.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30)), str(f.originalname, 200) || 'arquivo', st.mime, st.size, st.sha,
      num(b.width), num(b.height), num(b.duration), st.path, thumbPath, 'upload', now());
    audit(db, req.me!.tenant_id, req.me!.id, 'midia.upload', { id: mid, size: st.size });
    res.json(mediaJson(mediaOf(req.me!, mid)));
  }));
  /** Sincroniza agora o estoque do site da loja (o servidor também faz sozinho a cada 5 min: server/stock.ts). */
  app.post('/api/estoque/importar', owner, ah(async (req, res) => {
    const r = await syncStock(db, req.me!.tenant_id);
    audit(db, req.me!.tenant_id, req.me!.id, 'estoque.importado', r);
    res.json(r);
  }));
  app.patch('/api/media/batch', editor, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 500).map(String) : [];
    const set = req.body?.set ?? {};
    let n = 0;
    tx(db, () => {
      for (const mid of ids) {
        const m = mediaOf(req.me!, mid);
        if (!m) continue;
        const tags = Array.isArray(set.addTags) ? [...new Set([...pj<string[]>(m.tags, []), ...set.addTags.map((s: unknown) => str(s, 40)).filter(Boolean)])] : pj<string[]>(m.tags, []);
        const unit = set.unitId === null ? null : set.unitId ? unitOf(req.me!, set.unitId)?.id ?? m.unit_id : m.unit_id;
        db.prepare('UPDATE media SET unit_id = ?, category = ?, collection = ?, campaign = ?, product = ?, status = ?, tags = ? WHERE id = ?').run(unit,
          set.category !== undefined ? str(set.category, 60) || null : m.category, set.collection !== undefined ? str(set.collection, 80) || null : m.collection,
          set.campaign !== undefined ? str(set.campaign, 80) || null : m.campaign, set.product !== undefined ? str(set.product, 120) || null : m.product,
          set.status !== undefined ? str(set.status, 30) || m.status : m.status, j(tags), m.id);
        n++;
      }
    });
    res.json({ updated: n });
  });
  app.get('/api/media/:id/file', auth, (req, res) => {
    const m = mediaOf(req.me!, String(req.params.id));
    if (!m || !existsSync(m.path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type(m.mime).sendFile(m.path, { dotfiles: 'allow' });
  });
  app.get('/api/media/:id/download', auth, (req, res) => {
    const m = mediaOf(req.me!, String(req.params.id));
    if (!m || !existsSync(m.path)) return res.status(404).end();
    res.download(m.path, m.filename, { dotfiles: 'allow' });
  });
  app.get('/api/media/:id/thumb', auth, (req, res) => {
    const m = mediaOf(req.me!, String(req.params.id));
    if (!m?.thumb_path || !existsSync(m.thumb_path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(m.thumb_path, { dotfiles: 'allow' });
  });
  app.get('/public/media/:id/:exp/:sig', (req, res) => {
    if (!checkMediaLink(String(req.params.id), String(req.params.exp), String(req.params.sig))) return res.status(403).end();
    const m = db.prepare('SELECT * FROM media WHERE id = ?').get(String(req.params.id)) as any;
    if (!m || !existsSync(m.path)) return res.status(404).end();
    res.type(m.mime).sendFile(m.path, { dotfiles: 'allow' });
  });

  // ───────── Produções e versões ─────────
  function createProduction(me: Me, type: Params['type'], unit: any, params: Params, title: string, weekPlanId: string | null = null) {
    const pid = id(), vid = id();
    tx(db, () => {
      db.prepare('INSERT INTO productions (id, tenant_id, unit_id, type, title, status, current_version_id, week_plan_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(pid, me.tenant_id, unit?.id ?? null, type, title.slice(0, 140), 'rascunho', vid, weekPlanId, me.id, now(), now());
      db.prepare('INSERT INTO versions (id, production_id, n, params, changes, created_at) VALUES (?,?,?,?,?,?)').run(vid, pid, 1, j(params), j(['Versão inicial.']), now());
    });
    return { productionId: pid, versionId: vid };
  }
  function sanitizeParams(me: Me, p: any): Params {
    // referências de mídia só podem apontar para mídia do próprio cliente
    const fix = (r: MediaRef | null | undefined) => (r && mediaOf(me, r.id) ? { id: r.id } : null);
    const q = structuredClone(p ?? {});
    if (q.type === 'story') {
      const vid = (r: any) => (r ? { ...r, video: mediaOf(me, r.id)?.kind === 'video' } : r);
      q.photo = vid(fix(q.photo)); q.photos = (Array.isArray(q.photos) ? q.photos : []).map(fix).filter(Boolean).slice(0, 6).map(vid);
      const m = q.photo ? mediaOf(me, q.photo.id) : null;
      q.photoVideo = m?.kind === 'video'; q.videoDuration = q.photoVideo ? Math.min(60, Number(m.duration) || 15) : undefined;
    }
    q.allUnits = q.allUnits === true;
    q.handles = (db.prepare('SELECT instagram FROM units WHERE tenant_id = ? AND instagram IS NOT NULL ORDER BY name').all(me.tenant_id) as any[]).map((u) => u.instagram);
    if (q.type === 'reel' && !['calm', 'dynamic', 'max'].includes(q.motion)) q.motion = 'dynamic';
    q.variation = Math.min(1, Math.max(0, Number(q.variation) || 0)); q.seed = Number.isInteger(q.seed) ? q.seed : Math.floor(Math.random() * 1e9);
    q.dmLink = q.dmLink && /^https:\/\/\S+$/.test(String(q.dmLink.url)) ? { keyword: str(q.dmLink.keyword, 20).toUpperCase() || 'QUERO', url: str(q.dmLink.url, 400), message: str(q.dmLink.message, 300) || undefined } : null;
    if (q.type === 'carousel') q.slides = (q.slides ?? []).slice(0, 20).map((s: any) => ({ ...s, photo: fix(s.photo) }));
    if (q.type === 'reel') { q.clips = (q.clips ?? []).filter((c: any) => fix(c.media)).map((c: any) => ({ ...c, media: { id: c.media.id } })); q.music = fix(q.music); }
    q.moto = cleanMoto(q.moto);
    if (!['story', 'carousel', 'reel'].includes(q.type)) throw new Error('Tipo de produção inválido.');
    return q as Params;
  }
  function addVersion(me: Me, prod: any, params: Params, instruction: string | null, changes: string[], parentId: string | null) {
    const n = (db.prepare('SELECT MAX(n) AS n FROM versions WHERE production_id = ?').get(prod.id) as { n: number }).n + 1;
    const vid = id();
    db.prepare('INSERT INTO versions (id, production_id, n, params, instruction, changes, parent_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run(vid, prod.id, n, j(params), instruction, j(changes), parentId, now());
    db.prepare("UPDATE productions SET current_version_id = ?, status = 'rascunho', updated_at = ? WHERE id = ?").run(vid, now(), prod.id);
    return vid;
  }
  function enqueue(me: { tenant_id: string }, versionId: string, op: (typeof ENGINE_OPS)[number], payload: unknown) {
    const jid = id();
    db.prepare('INSERT INTO jobs (id, tenant_id, version_id, op, payload, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(jid, me.tenant_id, versionId, op, j(payload), 'fila', now(), now());
    db.prepare("UPDATE versions SET status = 'na-fila' WHERE id = ?").run(versionId);
    db.prepare("UPDATE productions SET status = 'produzindo', updated_at = ? WHERE id = (SELECT production_id FROM versions WHERE id = ?)").run(now(), versionId);
    return jid;
  }

  app.get('/api/productions', auth, (req, res) => {
    const where = ['p.tenant_id = ?']; const args: any[] = [req.me!.tenant_id];
    if (req.query.unit) { where.push('p.unit_id = ?'); args.push(String(req.query.unit)); }
    if (req.query.type) { where.push('p.type = ?'); args.push(String(req.query.type)); }
    if (req.query.status) { where.push('p.status = ?'); args.push(String(req.query.status)); } else where.push("p.status != 'arquivado'");
    const rows = db.prepare(`SELECT p.*, v.n AS vn, v.outputs, v.params FROM productions p LEFT JOIN versions v ON v.id = p.current_version_id WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC LIMIT 300`).all(...args) as any[];
    res.json(rows.map((r) => ({ id: r.id, unitId: r.unit_id, type: r.type, title: r.title, status: r.status, versionN: r.vn, updatedAt: r.updated_at, weekPlanId: r.week_plan_id,
      cover: pj<any[]>(r.outputs, [])[0] ? `/api/media/${pj<any[]>(r.outputs, [])[0].mediaId}/file` : null, outputs: pj<any[]>(r.outputs, []).map((o) => ({ ...o, url: `/api/media/${o.mediaId}/file` })) })));
  });
  app.post('/api/productions', editor, ah(async (req, res) => {
    const unit = unitOf(req.me!, req.body?.unitId);
    if (!unit) return res.status(400).json({ error: 'Escolha a unidade.' });
    try {
      let params = sanitizeParams(req.me!, req.body?.params) as any;
      let changes: string[] = [];
      // pedido livre de edição (conversa com a IA): vira parâmetros dentro da marca antes da 1ª versão
      const brief = str(params.brief, 600) || (params.type === 'reel' && params.review === 'briefing' && aiEnabled() ? 'Monte o melhor plano de edição para este Reel no padrão Marcos Motos.' : '');
      if (brief) { const r = await interpretInstruction(db, req.me!.tenant_id, params, brief); params = { ...r.params, brief }; changes = r.changes.length ? r.changes : [r.unrecognized ? 'Pedido registrado; nenhum ajuste automático reconhecido (ligue o modo IA para pedidos livres).' : '']; }
      const r = createProduction(req.me!, params.type, unit, params, str(req.body?.title, 140) || `${params.type} · ${unit.name}`);
      if (changes.filter(Boolean).length) db.prepare('UPDATE versions SET changes = ? WHERE id = ?').run(j(['Versão inicial.', ...changes.filter(Boolean)]), r.versionId);
      res.json(r);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));
  app.get('/api/productions/:id', auth, (req, res) => {
    const p = prodOf(req.me!, String(req.params.id));
    if (!p) return res.status(404).json({ error: 'Produção não encontrada.' });
    const versions = (db.prepare('SELECT * FROM versions WHERE production_id = ? ORDER BY n DESC').all(p.id) as any[]).map(versionJson);
    const jobs = (db.prepare('SELECT id, version_id, op, status, progress, message, attempts, created_at, updated_at, finished_at, log FROM jobs WHERE version_id IN (SELECT id FROM versions WHERE production_id = ?) ORDER BY created_at DESC').all(p.id) as any[]).map((x) => ({ ...x, log: pj(x.log, []) }));
    const cal = db.prepare('SELECT * FROM calendar_entries WHERE production_id = ?').all(p.id);
    const curParams = pj<any>((db.prepare('SELECT params FROM versions WHERE id = ?').get(p.current_version_id) as any)?.params, null);
    const names = Object.fromEntries(collectMedia(curParams ?? {}).map((m) => [m, mediaOf(req.me!, m)?.filename ?? 'mídia']));
    res.json({ id: p.id, unitId: p.unit_id, type: p.type, title: p.title, status: p.status, currentVersionId: p.current_version_id, versions, jobs, calendar: cal, briefing: curParams ? (curParams.aiBriefing?.length ? curParams.aiBriefing : briefing(curParams, names)) : [], briefingEngine: curParams?.aiBriefing?.length ? 'ia' : 'local' });
  });
  // Apagar produção (ex.: em revisão e não aprovada). Se já saiu no Instagram, só esconde (o histórico de publicação fica).
  app.delete('/api/productions/:id', editor, (req, res) => {
    const p = prodOf(req.me!, String(req.params.id));
    if (!p) return res.status(404).json({ error: 'Produção não encontrada.' });
    const published = db.prepare("SELECT 1 FROM calendar_entries WHERE production_id = ? AND status IN ('publicado','removido')").get(p.id);
    tx(db, () => {
      db.prepare("UPDATE jobs SET status = 'cancelado', updated_at = ? WHERE status IN ('fila','executando') AND version_id IN (SELECT id FROM versions WHERE production_id = ?)").run(now(), p.id);
      db.prepare("DELETE FROM calendar_entries WHERE production_id = ? AND status NOT IN ('publicado','removido')").run(p.id);
      if (published) db.prepare("UPDATE productions SET status = 'arquivado', updated_at = ? WHERE id = ?").run(now(), p.id);
      else {
        db.prepare('DELETE FROM jobs WHERE version_id IN (SELECT id FROM versions WHERE production_id = ?)').run(p.id);
        db.prepare('UPDATE productions SET current_version_id = NULL WHERE id = ?').run(p.id);
        db.prepare('DELETE FROM versions WHERE production_id = ?').run(p.id);
        db.prepare('DELETE FROM productions WHERE id = ?').run(p.id);
      }
    });
    audit(db, req.me!.tenant_id, req.me!.id, 'producao.apagada', { id: p.id, title: p.title, archived: Boolean(published) });
    res.json({ ok: true, archived: Boolean(published) });
  });
  app.post('/api/productions/:id/versions', editor, (req, res) => {
    const p = prodOf(req.me!, String(req.params.id));
    if (!p) return res.status(404).json({ error: 'Produção não encontrada.' });
    try {
      const params = sanitizeParams(req.me!, req.body?.params);
      const vid = addVersion(req.me!, p, params, null, [str(req.body?.note, 200) || 'Ajuste manual no editor.'], p.current_version_id);
      res.json({ versionId: vid });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.post('/api/productions/:id/instruct', editor, ah(async (req, res) => {
    const p = prodOf(req.me!, String(req.params.id));
    const instruction = str(req.body?.instruction, 600);
    if (!p || !instruction) return res.status(400).json({ error: 'Descreva a alteração.' });
    const base = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.body?.fromVersionId ? String(req.body.fromVersionId) : p.current_version_id) as any;
    if (!base || base.production_id !== p.id) return res.status(400).json({ error: 'Versão inválida.' });
    const r = await interpretInstruction(db, req.me!.tenant_id, pj(base.params, {}) as Params, instruction);
    if (r.unrecognized && !r.forkUnits.length) return res.status(422).json({ error: aiEnabled() ? 'A IA não conseguiu aplicar este pedido. Descreva o resultado que você quer ver.' : 'Pedido livre precisa do modo IA (Claude Opus), que está desligado: falta a chave ANTHROPIC_API_KEY no servidor. Sem ela, só pedidos comuns: “mais dinâmico”, “menos brilho”, “25 segundos”, “troque a fonte”, “mais variado”.', engine: r.engine });
    const out: any = { engine: r.engine, changes: r.changes };
    if (r.changes.length) out.versionId = addVersion(req.me!, p, r.params, instruction, r.changes, base.id);
    if (r.forkUnits.length) {
      out.forks = [];
      for (const slug of r.forkUnits) {
        const u = db.prepare('SELECT * FROM units WHERE tenant_id = ? AND slug = ?').get(req.me!.tenant_id, slug) as any;
        if (!u || u.id === p.unit_id) continue;
        const fp: any = { ...structuredClone(r.params), unitName: u.name, instagram: u.instagram };
        out.forks.push({ unit: u.name, ...createProduction(req.me!, p.type, u, fp, `${p.title} · ${u.name}`) });
      }
    }
    audit(db, req.me!.tenant_id, req.me!.id, 'producao.instrucao', { productionId: p.id, instruction, engine: r.engine });
    res.json(out);
  }));
  app.post('/api/versions/:id/render', editor, (req, res) => {
    const v = versionOf(req.me!, String(req.params.id));
    if (!v) return res.status(404).json({ error: 'Versão não encontrada.' });
    if (!withinLimit(db, req.me!.tenant_id, 'render') && req.me!.role !== 'p7admin') return res.status(402).json({ error: 'Limite mensal de renderizações do plano atingido.' });
    const active = db.prepare("SELECT id FROM jobs WHERE version_id = ? AND status IN ('fila','executando')").get(v.id) as any;
    if (active) return res.json({ jobId: active.id, already: true });
    const params = pj<any>(v.params, {});
    const refs = collectMedia(params).map((mid) => mediaOf(req.me!, mid)).filter(Boolean).map((m: any) => ({ id: m.id, kind: m.kind, sha256: m.sha256, mime: m.mime, size: m.size, filename: m.filename }));
    const jid = enqueue(req.me!, v.id, `render.${v.type}` as any, { versionId: v.id, productionId: v.production_id, type: v.type, params, media: refs });
    res.json({ jobId: jid });
  });
  app.post('/api/versions/:id/approve', editor, (req, res) => {
    const v = versionOf(req.me!, String(req.params.id));
    if (!v) return res.status(404).json({ error: 'Versão não encontrada.' });
    if (!pj<any[]>(v.outputs, []).length) return res.status(409).json({ error: 'Renderize a versão antes de aprovar.' });
    tx(db, () => {
      db.prepare("UPDATE versions SET status = 'aprovada', approved_at = ?, approved_by = ? WHERE id = ?").run(now(), req.me!.id, v.id);
      db.prepare("UPDATE productions SET status = 'aprovado', current_version_id = ?, updated_at = ? WHERE id = ?").run(v.id, now(), v.production_id);
      // correções aprovadas alimentam a memória de estilo
      if (v.instruction) db.prepare('INSERT INTO brand_memory (id, tenant_id, kind, unit_id, text, data, source, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id(), req.me!.tenant_id, 'correcao', v.unit_id, v.instruction, j({ changes: pj(v.changes, []), versionId: v.id }), `aprovado:${req.me!.name}`, now());
    });
    audit(db, req.me!.tenant_id, req.me!.id, 'versao.aprovada', { versionId: v.id });
    res.json({ ok: true });
  });
  app.post('/api/versions/:id/restore', editor, (req, res) => {
    const v = versionOf(req.me!, String(req.params.id));
    if (!v) return res.status(404).json({ error: 'Versão não encontrada.' });
    const p = prodOf(req.me!, v.production_id);
    const vid = addVersion(req.me!, p, pj(v.params, {}) as Params, null, [`Restaurada a partir da versão ${v.n}.`], v.id);
    // a restauração reaproveita os arquivos já renderizados da versão original
    db.prepare('UPDATE versions SET outputs = ?, status = ? WHERE id = ?').run(v.outputs, pj<any[]>(v.outputs, []).length ? 'pronta' : 'rascunho', vid);
    res.json({ versionId: vid });
  });

  // ───────── Fila ─────────
  app.get('/api/jobs', auth, (req, res) => {
    const rows = db.prepare(`SELECT j.id, j.op, j.status, j.progress, j.message, j.attempts, j.created_at, j.updated_at, j.finished_at, j.engine_id, p.title, p.id AS production_id, p.unit_id
      FROM jobs j LEFT JOIN versions v ON v.id = j.version_id LEFT JOIN productions p ON p.id = v.production_id WHERE j.tenant_id = ? ORDER BY j.created_at DESC LIMIT 200`).all(req.me!.tenant_id);
    const engines = db.prepare('SELECT id, name, last_seen, version, info, revoked_at FROM engines WHERE tenant_id = ? AND token_hash IS NOT NULL ORDER BY last_seen DESC').all(req.me!.tenant_id) as any[];
    res.json({ jobs: rows, engines: engines.map((e) => ({ ...e, info: pj(e.info, {}), online: e.last_seen > now() - 60_000 && !e.revoked_at })) });
  });
  app.post('/api/jobs/:id/cancel', editor, (req, res) => {
    const r = db.prepare("UPDATE jobs SET status = 'cancelado', updated_at = ?, finished_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('fila','executando')").run(now(), now(), String(req.params.id), req.me!.tenant_id);
    res.json({ ok: r.changes > 0 });
  });
  app.post('/api/jobs/:id/retry', editor, (req, res) => {
    const r = db.prepare("UPDATE jobs SET status = 'fila', attempts = 0, progress = 0, message = 'reenviado', lease_until = NULL, engine_id = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('falhou','cancelado')").run(now(), String(req.params.id), req.me!.tenant_id);
    res.json({ ok: r.changes > 0 });
  });
  app.post('/api/engines/pairing-code', owner, (req, res) => {
    const code = randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
    const eid = id();
    db.prepare('INSERT INTO engines (id, tenant_id, name, pair_code_hash, pair_expires_at, created_at) VALUES (?,?,?,?,?,?)').run(eid, req.me!.tenant_id, 'Motor local (aguardando)', sha256(code), now() + 15 * 60_000, now());
    res.json({ code, expiresInMin: 15 });
  });
  app.post('/api/engines/:id/revoke', owner, (req, res) => {
    db.prepare('UPDATE engines SET revoked_at = ?, token_hash = NULL WHERE id = ? AND tenant_id = ?').run(now(), String(req.params.id), req.me!.tenant_id);
    res.json({ ok: true });
  });

  // ───────── API do motor local (token próprio, lista fechada de operações) ─────────
  const engineAuth = (req: Request, res: Response, next: NextFunction) => {
    const tok = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const e = tok ? db.prepare('SELECT * FROM engines WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(tok)) as any : null;
    if (!e) return res.status(401).json({ error: 'motor não autorizado' });
    const st = licenseState(db, e.tenant_id);
    if (!st.ok) return res.status(402).json({ error: 'licença inativa', state: st.state });
    db.prepare('UPDATE engines SET last_seen = ? WHERE id = ?').run(now(), e.id);
    (req as any).engine = e;
    next();
  };
  app.post('/api/engine/pair', (req, res) => {
    if (rateLimited(db, 'pair-ip:' + req.ip, 10, 15 * 60_000)) return res.status(429).json({ error: 'Muitas tentativas.' });
    const code = str(req.body?.code, 20).toUpperCase();
    const e = db.prepare('SELECT * FROM engines WHERE pair_code_hash = ? AND pair_expires_at > ? AND token_hash IS NULL').get(sha256(code), now()) as any;
    if (!e) return res.status(400).json({ error: 'Código inválido ou expirado.' });
    const token = randomToken(32);
    db.prepare('UPDATE engines SET token_hash = ?, pair_code_hash = NULL, name = ?, info = ?, version = ?, last_seen = ? WHERE id = ?')
      .run(sha256(token), str(req.body?.name, 80) || 'Motor local', j(req.body?.info ?? {}), str(req.body?.version, 20), now(), e.id);
    audit(db, e.tenant_id, null, 'motor.pareado', { engineId: e.id });
    res.json({ engineId: e.id, token, tenantId: e.tenant_id });
  });
  app.post('/api/engine/heartbeat', engineAuth, (req, res) => {
    const e = (req as any).engine;
    db.prepare('UPDATE engines SET info = ?, version = ? WHERE id = ?').run(j(req.body?.info ?? {}), str(req.body?.version, 20), e.id);
    const lic = currentKey(db, e.tenant_id, str(req.body?.deviceId, 64) || e.id);
    res.json({ ok: true, license: lic });
  });
  app.post('/api/engine/claim', engineAuth, (req, res) => {
    const e = (req as any).engine;
    sweepLeases(db);
    const job = tx(db, () => {
      // retomada: o motor reassume primeiro os trabalhos que ele mesmo tinha (ex.: reiniciou no meio)
      const mine = db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND status = 'executando' AND engine_id = ? ORDER BY created_at LIMIT 1").get(e.tenant_id, e.id) as any;
      const next = mine ?? db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND status = 'fila' ORDER BY created_at LIMIT 1").get(e.tenant_id) as any;
      if (!next) return null;
      if (!ENGINE_OPS.includes(next.op)) { db.prepare("UPDATE jobs SET status = 'falhou', message = 'operação não permitida' WHERE id = ?").run(next.id); return null; }
      db.prepare("UPDATE jobs SET status = 'executando', engine_id = ?, lease_until = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?").run(e.id, now() + LEASE_MS, mine ? 0 : 1, now(), next.id);
      db.prepare("UPDATE versions SET status = 'renderizando' WHERE id = ?").run(next.version_id);
      return { ...next, resumed: Boolean(mine) };
    });
    if (!job) return res.json({ job: null });
    res.json({ job: { id: job.id, op: job.op, payload: pj(job.payload, {}), attempts: job.attempts + (job.resumed ? 0 : 1), resumed: job.resumed } });
  });
  const jobOfEngine = (req: Request) => db.prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND engine_id = ?').get(String(req.params.id), (req as any).engine.tenant_id, (req as any).engine.id) as any;
  app.post('/api/engine/jobs/:id/progress', engineAuth, (req, res) => {
    const jb = jobOfEngine(req);
    if (!jb) return res.status(404).json({ error: 'trabalho não encontrado' });
    if (jb.status === 'cancelado') return res.json({ cancel: true });
    const logArr = pj<any[]>(jb.log, []);
    if (req.body?.log) { logArr.push({ at: now(), msg: str(req.body.log, 300) }); if (logArr.length > 200) logArr.splice(0, logArr.length - 200); }
    db.prepare('UPDATE jobs SET progress = ?, message = ?, lease_until = ?, log = ?, updated_at = ? WHERE id = ?').run(Math.min(1, Math.max(0, Number(req.body?.progress) || 0)), str(req.body?.message, 200) || jb.message, now() + LEASE_MS, j(logArr), now(), jb.id);
    res.json({ cancel: false });
  });
  app.get('/api/engine/media/:id', engineAuth, (req, res) => {
    const m = mediaOf((req as any).engine, String(req.params.id));
    if (!m || !existsSync(m.path)) return res.status(404).end();
    res.type(m.mime).sendFile(m.path, { dotfiles: 'allow' });
  });
  app.post('/api/engine/jobs/:id/output', engineAuth, upload.single('file'), ah(async (req, res) => {
    const jb = jobOfEngine(req);
    const f = req.file;
    if (!jb || !f) return res.status(400).json({ error: 'trabalho ou arquivo ausente' });
    const tenant = (req as any).engine.tenant_id;
    const st = await store(tenant, f.path);
    if ('error' in st) return res.status(415).json({ error: st.error });
    const prod = db.prepare('SELECT p.* FROM productions p JOIN versions v ON v.production_id = p.id WHERE v.id = ?').get(jb.version_id) as any;
    const mid = id();
    db.prepare(`INSERT INTO media (id, tenant_id, unit_id, kind, category, status, tags, filename, mime, size, sha256, width, height, duration, path, origin, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(mid, tenant, prod?.unit_id ?? null, st.kind, 'producao', 'gerado', j([prod?.type ?? 'render']), str(req.body?.name, 120) || f.originalname,
      st.mime, st.size, st.sha, Number(req.body?.width) || null, Number(req.body?.height) || null, Number(req.body?.duration) || null, st.path, 'render', now());
    res.json({ mediaId: mid });
  }));
  app.post('/api/engine/jobs/:id/complete', engineAuth, (req, res) => {
    const jb = jobOfEngine(req);
    if (!jb) return res.status(404).json({ error: 'trabalho não encontrado' });
    const outputs = (Array.isArray(req.body?.outputs) ? req.body.outputs : []).filter((o: any) => mediaOf((req as any).engine, o.mediaId)).map((o: any) => ({ mediaId: String(o.mediaId), role: str(o.role, 30), index: Number(o.index) || 0, width: o.width, height: o.height, duration: o.duration }));
    tx(db, () => {
      db.prepare("UPDATE jobs SET status = 'concluido', progress = 1, message = 'concluído', finished_at = ?, updated_at = ?, lease_until = NULL WHERE id = ?").run(now(), now(), jb.id);
      if (outputs.length) {
        const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(jb.version_id) as any;
        const params = pj<any>(v.params, {});
        if (req.body?.timeline && params.type === 'reel') params.timeline = req.body.timeline; // timeline medida, para reprodutibilidade
        db.prepare("UPDATE versions SET outputs = ?, status = 'pronta', params = ? WHERE id = ?").run(j(outputs), j(params), jb.version_id);
        db.prepare("UPDATE productions SET status = 'revisao', updated_at = ? WHERE id = ?").run(now(), v.production_id);
      }
      recordUsage(db, jb.tenant_id, 'render', 1, 0, { op: jb.op, seconds: Number(req.body?.seconds) || null, engine: (req as any).engine.id });
    });
    res.json({ ok: true });
  });
  app.post('/api/engine/jobs/:id/fail', engineAuth, (req, res) => {
    const jb = jobOfEngine(req);
    if (!jb) return res.status(404).json({ error: 'trabalho não encontrado' });
    const retry = jb.attempts < MAX_ATTEMPTS && req.body?.retryable !== false;
    const logArr = pj<any[]>(jb.log, []); logArr.push({ at: now(), msg: 'ERRO: ' + str(req.body?.error, 500) });
    db.prepare('UPDATE jobs SET status = ?, message = ?, engine_id = ?, lease_until = NULL, log = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(retry ? 'fila' : 'falhou', str(req.body?.error, 200), retry ? null : jb.engine_id, j(logArr), now(), retry ? null : now(), jb.id);
    if (!retry) db.prepare("UPDATE versions SET status = 'falhou' WHERE id = ?").run(jb.version_id);
    res.json({ requeued: retry });
  });

  // ───────── Criar Minha Semana ─────────
  const unitsMap = (me: Me) => Object.fromEntries((db.prepare('SELECT * FROM units WHERE tenant_id = ?').all(me.tenant_id) as any[]).map((u) => [u.id, u]));
  app.post('/api/week/plan', editor, (req, res) => {
    const units = unitsMap(req.me!);
    const unitIds = (Array.isArray(req.body?.unitIds) ? req.body.unitIds : []).map(String).filter((u: string) => units[u]);
    const days = (Array.isArray(req.body?.days) ? req.body.days : []).map(String).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 14);
    const media = (Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : []).map((m: string) => mediaOf(req.me!, m)).filter(Boolean).map((m: any) => ({ id: m.id, kind: m.kind }));
    const request = str(req.body?.request, 600);
    const campaign = str(req.body?.campaign, 80) || undefined;
    const plan = buildPlan({ request, campaign, unitIds, days, media, units });
    const wid = id();
    db.prepare('INSERT INTO week_plans (id, tenant_id, request, campaign, unit_ids, days, media_ids, plan, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(wid, req.me!.tenant_id, request, campaign ?? null, j(unitIds), j(days), j(media.map((m: any) => m.id)), j(plan), now());
    res.json({ id: wid, ...plan });
  });
  app.post('/api/week/:id/approve', editor, (req, res) => {
    const w = db.prepare('SELECT * FROM week_plans WHERE id = ? AND tenant_id = ?').get(String(req.params.id), req.me!.tenant_id) as any;
    if (!w) return res.status(404).json({ error: 'Plano não encontrado.' });
    if (w.status !== 'sugerido') return res.status(409).json({ error: 'Este plano já foi aprovado.' });
    const units = unitsMap(req.me!);
    const items: any[] = Array.isArray(req.body?.items) ? req.body.items : pj<any>(w.plan, { items: [] }).items;
    const created: any[] = [];
    for (const it of items.slice(0, 120)) {
      const u = units[it.unitId];
      if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.day))) continue;
      const refs: MediaRef[] = (it.mediaIds ?? []).filter((m: string) => mediaOf(req.me!, m)).map((m: string) => ({ id: m }));
      const unitInfo = { name: u.name, instagram: u.instagram };
      const params: Params = it.kind === 'story' ? { ...defaultStory(unitInfo, it.template as StoryKind, refs[0] ?? null), ...(w.campaign && it.template === 'campanha' ? { headline: w.campaign } : {}) }
        : it.kind === 'carousel' ? defaultCarousel(unitInfo, it.template as CarouselModel, refs, w.campaign ?? 'Coleção da semana')
        : { ...defaultReel(unitInfo, refs.map((r) => ({ media: r }))), title: w.campaign ?? 'Nova coleção', collection: w.campaign ?? 'Coleção' };
      const r = createProduction(req.me!, it.kind, u, params, `${str(it.title, 80)} · ${u.name}`, w.id);
      const cid = id();
      db.prepare('INSERT INTO calendar_entries (id, tenant_id, unit_id, date, time, kind, title, production_id, caption, status, week_plan_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(cid, req.me!.tenant_id, u.id, it.day, str(it.time, 5) || null, it.kind, str(it.title, 120), r.productionId, str(it.caption, 2200), 'planejado', w.id, now(), now());
      if (req.body?.produce !== false && (refs.length || it.kind !== 'reel')) enqueue(req.me!, r.versionId, `render.${it.kind}` as any, { versionId: r.versionId, productionId: r.productionId, type: it.kind, params, media: refs.map((x) => { const m = mediaOf(req.me!, x.id); return { id: m.id, kind: m.kind, sha256: m.sha256, mime: m.mime, size: m.size, filename: m.filename }; }) });
      created.push({ calendarId: cid, ...r });
    }
    db.prepare("UPDATE week_plans SET status = 'aprovado' WHERE id = ?").run(w.id);
    audit(db, req.me!.tenant_id, req.me!.id, 'semana.aprovada', { weekPlanId: w.id, n: created.length });
    res.json({ created });
  });
  app.get('/api/week/:id', auth, (req, res) => {
    const w = db.prepare('SELECT * FROM week_plans WHERE id = ? AND tenant_id = ?').get(String(req.params.id), req.me!.tenant_id) as any;
    if (!w) return res.status(404).json({ error: 'Plano não encontrado.' });
    const prods = db.prepare('SELECT id, type, title, status, unit_id FROM productions WHERE week_plan_id = ?').all(w.id);
    res.json({ ...w, plan: pj(w.plan, {}), productions: prods });
  });

  // ───────── Calendário e publicação ─────────
  app.get('/api/calendar', auth, (req, res) => {
    const where = ['c.tenant_id = ?']; const args: any[] = [req.me!.tenant_id];
    if (req.query.from) { where.push('c.date >= ?'); args.push(String(req.query.from)); }
    if (req.query.to) { where.push('c.date <= ?'); args.push(String(req.query.to)); }
    if (req.query.unit) { where.push('c.unit_id = ?'); args.push(String(req.query.unit)); }
    const rows = db.prepare(`SELECT c.*, p.status AS production_status, v.outputs, v.params AS vparams FROM calendar_entries c LEFT JOIN productions p ON p.id = c.production_id LEFT JOIN versions v ON v.id = p.current_version_id
      WHERE ${where.join(' AND ')} ORDER BY c.date, c.time`).all(...args) as any[];
    res.json(rows.map(({ vparams, ...r }) => ({ ...r, params: pj(vparams, {}), outputs: pj<any[]>(r.outputs, []).map((o) => ({ ...o, url: `/api/media/${o.mediaId}/file` })) })));
  });
  app.post('/api/calendar', editor, (req, res) => {
    const u = unitOf(req.me!, req.body?.unitId);
    const p = req.body?.productionId ? prodOf(req.me!, req.body.productionId) : null;
    if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date))) return res.status(400).json({ error: 'Unidade e data são obrigatórias.' });
    const cid = id();
    db.prepare('INSERT INTO calendar_entries (id, tenant_id, unit_id, date, time, kind, title, production_id, caption, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cid, req.me!.tenant_id, u.id, req.body.date, str(req.body?.time, 5) || null, p?.type ?? str(req.body?.kind, 20) ?? 'story', str(req.body?.title, 120) || p?.title || 'Publicação', p?.id ?? null, str(req.body?.caption, 2200), 'planejado', now(), now());
    res.json({ id: cid });
  });
  app.patch('/api/calendar/:id', editor, (req, res) => {
    const c = db.prepare('SELECT * FROM calendar_entries WHERE id = ? AND tenant_id = ?').get(String(req.params.id), req.me!.tenant_id) as any;
    if (!c) return res.status(404).json({ error: 'Item não encontrado.' });
    if (c.status === 'publicado') return res.status(409).json({ error: 'Item já publicado não pode ser alterado.' });
    const b = req.body ?? {};
    const status = b.status && ['planejado', 'agendado', 'exportacao-manual', 'cancelado'].includes(b.status) ? b.status : c.status;
    if (status === 'agendado') {
      const p = c.production_id ? prodOf(req.me!, c.production_id) : null;
      if (!p || !['aprovado', 'publicado'].includes(p.status)) return res.status(409).json({ error: 'Aprove a produção antes de agendar.' });
    }
    db.prepare('UPDATE calendar_entries SET date = ?, time = ?, caption = ?, status = ?, updated_at = ? WHERE id = ?').run(/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? b.date : c.date,
      b.time !== undefined ? str(b.time, 5) : c.time, b.caption !== undefined ? str(b.caption, 2200) : c.caption, status, now(), c.id);
    res.json({ ok: true });
  });
  app.delete('/api/calendar/:id', editor, (req, res) => {
    const c = db.prepare('SELECT * FROM calendar_entries WHERE id = ? AND tenant_id = ?').get(String(req.params.id), req.me!.tenant_id) as any;
    if (!c) return res.status(404).json({ error: 'Item não encontrado.' });
    if (c.status === 'publicado') return res.status(409).json({ error: 'Já publicado: apague pelo Instagram.' });
    db.prepare('DELETE FROM calendar_entries WHERE id = ?').run(c.id); // a produção continua na biblioteca; só sai da agenda
    audit(db, req.me!.tenant_id, req.me!.id, 'calendario.removido', { id: c.id, title: c.title });
    res.json({ ok: true });
  });
  // Postar de novo a mesma peça em outro dia (ex.: Story de hoje repetido amanhã): cria um novo item agendado.
  app.post('/api/calendar/:id/repost', editor, (req, res) => {
    const c = db.prepare('SELECT * FROM calendar_entries WHERE id = ? AND tenant_id = ?').get(String(req.params.id), req.me!.tenant_id) as any;
    if (!c) return res.status(404).json({ error: 'Item não encontrado.' });
    const dates = (Array.isArray(req.body?.dates) ? req.body.dates : [req.body?.date]).map(String).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 31);
    if (!dates.length) return res.status(400).json({ error: 'Escolha o dia.' });
    const p = c.production_id ? prodOf(req.me!, c.production_id) : null;
    const ok = p && ['aprovado', 'publicado'].includes(p.status);
    const ids = dates.map((d: string) => {
      const cid = id();
      db.prepare('INSERT INTO calendar_entries (id, tenant_id, unit_id, date, time, kind, title, production_id, caption, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(cid, c.tenant_id, c.unit_id, d, str(req.body?.time, 5) || c.time, c.kind, c.title, c.production_id, c.caption, ok ? 'agendado' : 'planejado', now(), now());
      return cid;
    });
    audit(db, req.me!.tenant_id, req.me!.id, 'calendario.repostar', { from: c.id, dates });
    res.json({ ids, status: ok ? 'agendado' : 'planejado' });
  });
  app.post('/api/calendar/:id/publish', editor, ah(async (req, res) => {
    const c = db.prepare('SELECT * FROM calendar_entries WHERE id = ? AND tenant_id = ?').get(String(req.params.id), req.me!.tenant_id) as any;
    if (!c) return res.status(404).json({ error: 'Item não encontrado.' });
    const r = await publishEntry(db, c, appUrl(req));
    res.status(r.ok ? 200 : 409).json(r);
  }));

  // ───────── Instagram ─────────
  app.get('/api/instagram/accounts', auth, (req, res) => {
    const units = db.prepare('SELECT id, name, instagram FROM units WHERE tenant_id = ?').all(req.me!.tenant_id) as any[];
    const acc = db.prepare('SELECT unit_id, username, status, token_expires_at, connected_at, last_error, scopes FROM ig_accounts WHERE tenant_id = ?').all(req.me!.tenant_id) as any[];
    const logs = db.prepare('SELECT * FROM publish_log WHERE tenant_id = ? ORDER BY at DESC LIMIT 100').all(req.me!.tenant_id);
    res.json({ configured: igConfigured(), units: units.map((u) => ({ ...u, account: acc.find((a) => a.unit_id === u.id) ?? null })), log: logs });
  });
  app.get('/api/instagram/connect/:unitId', owner, (req, res) => {
    const u = unitOf(req.me!, String(req.params.unitId));
    if (!u) return res.status(404).json({ error: 'Unidade não encontrada.' });
    try { res.json({ url: authorizeUrl(db, req.me!.tenant_id, u.id, req.me!.id) }); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });
  app.get('/api/instagram/callback', ah(async (req, res) => {
    try {
      const r = await handleCallback(db, String(req.query.code ?? ''), String(req.query.state ?? ''));
      res.redirect(`/instagram?conectado=${encodeURIComponent(r.username)}`);
    } catch (e) { res.redirect(`/instagram?erro=${encodeURIComponent((e as Error).message)}`); }
  }));
  app.post('/api/instagram/disconnect/:unitId', owner, (req, res) => {
    db.prepare("UPDATE ig_accounts SET status = 'desconectado', token_enc = NULL WHERE tenant_id = ? AND unit_id = ?").run(req.me!.tenant_id, String(req.params.unitId));
    igLog(db, req.me!.tenant_id, null, String(req.params.unitId), 'desconectar', 'ok');
    res.json({ ok: true });
  });
  app.get('/api/instagram/audio', auth, ah(async (req, res) => {
    const u = unitOf(req.me!, req.query.unitId);
    if (!u) return res.status(404).json({ error: 'Unidade não encontrada.' });
    try { res.json({ items: await searchAudio(db, req.me!.tenant_id, u.id, str(req.query.q, 80)) }); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  }));
  // Webhook da Meta (comentários e respostas a Story → DM automática com link). Público, mas só aceita corpo assinado com o segredo do app.
  app.get('/api/instagram/webhook', (req, res) => {
    const vt = igConfig().verifyToken;
    if (vt && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === vt) return res.type('text').send(String(req.query['hub.challenge'] ?? ''));
    res.sendStatus(403);
  });
  app.post('/api/instagram/webhook', ah(async (req, res) => {
    if (!verifySignature((req as any).rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // a Meta exige resposta rápida; o envio da DM segue em seguida
    handleWebhook(db, req.body).catch((e) => console.error('[webhook]', (e as Error).message));
  }));
  app.get('/api/instagram/dm', auth, (req, res) => {
    res.json(db.prepare('SELECT source, ig_media_id, text, status, detail, at FROM dm_events WHERE tenant_id = ? ORDER BY at DESC LIMIT 100').all(req.me!.tenant_id));
  });
  app.get('/api/instagram/insights/:calendarId', auth, ah(async (req, res) => {
    const c = db.prepare('SELECT * FROM calendar_entries WHERE id = ? AND tenant_id = ?').get(String(req.params.calendarId), req.me!.tenant_id) as any;
    if (!c?.ig_media_id) return res.status(404).json({ error: 'Sem publicação confirmada pela Meta.' });
    try { res.json(await mediaInsights(db, req.me!.tenant_id, c.unit_id, c.ig_media_id)); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  }));

  // ───────── Direct ─────────
  const dmUnit = (req: Request) => unitOf(req.me!, req.query.unitId ?? req.body?.unitId) ?? db.prepare('SELECT * FROM units WHERE tenant_id = ? ORDER BY name LIMIT 1').get(req.me!.tenant_id) as any;
  const metaErr = (res: Response, e: unknown) => res.status(409).json({ error: (e as Error).message });
  app.get('/api/dm/conversations', editor, ah(async (req, res) => {
    try { res.json(await dmConversations(db, req.me!.tenant_id, dmUnit(req).id)); } catch (e) { metaErr(res, e); }
  }));
  app.get('/api/dm/conversations/:id', editor, ah(async (req, res) => {
    try { res.json(await dmMessages(db, req.me!.tenant_id, dmUnit(req).id, String(req.params.id))); } catch (e) { metaErr(res, e); }
  }));
  app.post('/api/dm/send', editor, ah(async (req, res) => {
    const text = str(req.body?.text, 1000), to = str(req.body?.to, 64);
    if (!text || !to) return res.status(400).json({ error: 'Escreva a mensagem.' });
    try { res.json(await dmSend(db, req.me!.tenant_id, dmUnit(req).id, to, text)); } catch (e) { metaErr(res, e); }
  }));
  app.post('/api/dm/suggest', editor, ah(async (req, res) => {
    const hist = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-20).map((m: any) => ({ fromMe: Boolean(m?.fromMe), text: str(m?.text, 1000) }));
    if (!hist.length) return res.status(400).json({ error: 'Conversa vazia.' });
    try { res.json(await suggestReply(db, req.me!.tenant_id, hist)); } catch (e) { metaErr(res, e); }
  }));

  // ───────── Estratégia ─────────
  app.get('/api/strategy', auth, (req, res) => res.json(latestStrategies(db, req.me!.tenant_id)));
  app.post('/api/strategy', owner, (req, res) => {
    try { res.json({ id: startStrategy(db, req.me!.tenant_id, req.me!.id, str(req.body?.focus, 500)) }); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });

  // ───────── Layout livre e campanhas ─────────
  app.post('/api/design', editor, ah(async (req, res) => {
    const b = req.body ?? {};
    const size = b.size === 'feed' ? 'feed' : 'story';
    const camp = SEASONS.find((s) => s.id === b.campaignId) ?? null;
    const items: DesignInput[] = (Array.isArray(b.items) && b.items.length ? b.items : [b]).slice(0, 20).map((x: any, i: number) => ({
      size, photos: Math.max(0, Math.min(6, Number(x.photos) || 0)), kicker: str(x.kicker, 30), headline: str(x.headline, 60) || 'Novidades', subline: str(x.subline, 80), price: str(x.price, 20) || null, cta: str(x.cta, 40),
      slide: ['capa', 'foto', 'look', 'info', 'cta'].includes(x.slide) ? x.slide : undefined, index: i, total: b.items?.length ?? 1, campaign: camp, seed: Number.isInteger(x.seed) ? x.seed : Math.floor(Math.random() * 1e9),
    }));
    res.json(await designs(db, req.me!.tenant_id, items, str(b.brief, 600)));
  }));
  app.get('/api/campaigns', auth, (req, res) => {
    const products = db.prepare('SELECT name, category, brand, price_cents, available, unit_id FROM products WHERE tenant_id = ? AND (available IS NULL OR available = 1) ORDER BY updated_at DESC LIMIT 60').all(req.me!.tenant_id) as any[];
    const cats: Record<string, number> = {};
    for (const p of products) if (p.category) cats[p.category] = (cats[p.category] ?? 0) + 1;
    const media = db.prepare("SELECT category, collection, COUNT(*) AS n FROM media WHERE tenant_id = ? AND origin = 'upload' AND status != 'arquivado' GROUP BY category, collection ORDER BY n DESC LIMIT 12").all(req.me!.tenant_id) as any[];
    res.json({ seasons: upcomingSeasons(), inventory: { connected: products.length > 0, categories: Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
      products: products.slice(0, 12).map((p) => ({ name: p.name, category: p.category, brand: p.brand, price: p.price_cents === null ? null : `R$ ${(p.price_cents / 100).toFixed(2).replace('.', ',')}` })) }, library: media });
  });
  // ───────── Métricas, preferências e custos ─────────
  app.get('/api/metrics', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM metrics_reports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 30').all(req.me!.tenant_id) as any[];
    res.json({ settings: getSettings(db, req.me!.tenant_id), reports: rows.map((r) => ({ id: r.id, unitId: r.unit_id, from: r.period_from, to: r.period_to, engine: r.engine, createdAt: r.created_at, ...pj<any>(r.data, {}), suggestions: pj(r.suggestions, []) })) });
  });
  app.post('/api/metrics/analyze', owner, ah(async (req, res) => {
    const days = [1, 7, 15, 30, 90].includes(Number(req.body?.days)) ? Number(req.body.days) : 7;
    res.json(await analyze(db, req.me!.tenant_id, days));
  }));
  app.post('/api/metrics/apply', owner, (req, res) => {
    const r = db.prepare('SELECT suggestions FROM metrics_reports WHERE id = ? AND tenant_id = ?').get(str(req.body?.reportId, 64), req.me!.tenant_id) as any;
    const s = pj<any[]>(r?.suggestions, [])[Number(req.body?.index)];
    if (!s?.apply) return res.status(400).json({ error: 'Sugestão sem ajuste automático.' });
    applySuggestion(db, req.me!.tenant_id, s); audit(db, req.me!.tenant_id, req.me!.id, 'metricas.sugestao-aplicada', s);
    res.json({ ok: true, settings: getSettings(db, req.me!.tenant_id) });
  });
  app.get('/api/settings', auth, (req, res) => res.json(getSettings(db, req.me!.tenant_id)));
  app.put('/api/settings', owner, (req, res) => {
    const b = req.body ?? {}, cur = getSettings(db, req.me!.tenant_id);
    const freq = ['manual', 'diaria', 'semanal', 'mensal'].includes(b.analysis?.frequency) ? b.analysis.frequency : cur.analysis?.frequency ?? 'manual';
    saveSettings(db, req.me!.tenant_id, { ...cur, analysis: { frequency: freq, autoApply: b.analysis?.autoApply === true, days: [1, 7, 15, 30, 90].includes(Number(b.analysis?.days)) ? Number(b.analysis.days) : 7 },
      defaults: { ...(cur.defaults ?? {}), ...(b.defaults && typeof b.defaults === 'object' ? { variation: Math.min(1, Math.max(0, Number(b.defaults.variation ?? cur.defaults?.variation ?? 0))) } : {}) } });
    res.json(getSettings(db, req.me!.tenant_id));
  });
  /** Só P7 Labs: consumo e custo por cliente para precificar o plano. */
  app.get('/api/admin/usage', admin, (req, res) => {
    const costs = pj<any>((db.prepare('SELECT data FROM tenant_settings WHERE tenant_id = ?').get('p7-costs') as any)?.data, { usdBrl: 5.4, renderMinBrl: 0, fixedBrl: 0, prices: {} });
    const since = Date.now() - 180 * 86_400_000;
    const tenants = (db.prepare('SELECT id, name FROM tenants ORDER BY name').all() as any[]).map((t) => {
      const rows = db.prepare(`SELECT strftime('%Y-%m', at / 1000, 'unixepoch', 'localtime') AS month, kind, COUNT(*) AS n, SUM(amount) AS amount, SUM(cost_usd) AS usd, SUM(CAST(json_extract(meta, '$.seconds') AS REAL)) AS secs FROM usage WHERE tenant_id = ? AND at > ? GROUP BY month, kind ORDER BY month DESC`).all(t.id, since) as any[];
      return { ...t, rows };
    });
    res.json({ costs, tenants });
  });
  app.put('/api/admin/costs', admin, (req, res) => {
    const b = req.body ?? {}, n = (v: unknown) => Math.max(0, Number(v) || 0);
    const data = { usdBrl: n(b.usdBrl) || 5.4, renderMinBrl: n(b.renderMinBrl), fixedBrl: n(b.fixedBrl), prices: Object.fromEntries(Object.entries(b.prices ?? {}).map(([k, v]) => [str(k, 64), n(v)])) };
    db.prepare('INSERT INTO tenant_settings (tenant_id, data) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET data = excluded.data').run('p7-costs', j(data));
    res.json(data);
  });

  // ───────── Licença, custos, estoque, voz ─────────
  app.get('/api/license', requireAuth(db, { skipLicense: true }), (req, res) => {
    res.json({ ...licenseState(db, req.me!.tenant_id), usage: monthUsage(db, req.me!.tenant_id), plans: PLANS });
  });
  app.post('/api/license/check', (req, res) => {
    if (rateLimited(db, 'lic-ip:' + req.ip, 60, 60 * 60_000)) return res.status(429).json({ error: 'limite' });
    res.json(checkLicenseKey(db, str(req.body?.key, 4000), str(req.body?.deviceId, 64), str(req.body?.label, 80)));
  });
  app.get('/api/admin/tenants', admin, (_req, res) => {
    const t = db.prepare('SELECT * FROM tenants ORDER BY name').all() as any[];
    res.json(t.map((x) => ({ ...x, license: licenseState(db, x.id), usage: monthUsage(db, x.id), devices: db.prepare('SELECT a.* FROM license_activations a JOIN licenses l ON l.id = a.license_id WHERE l.tenant_id = ?').all(x.id) })));
  });
  app.post('/api/admin/licenses', admin, (req, res) => {
    try { const r = issueLicense(db, str(req.body?.tenantId, 64), str(req.body?.plan, 30) || 'profissional', Number(req.body?.days) || undefined); audit(db, r.license.tenant_id, req.me!.id, 'licenca.emitida', { id: r.license.id }); res.json(r); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.post('/api/admin/licenses/:id/renew', admin, (req, res) => {
    try { res.json(renewLicense(db, String(req.params.id), Number(req.body?.days) || 30)); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.post('/api/admin/licenses/:id/status', admin, (req, res) => {
    try { setLicenseStatus(db, String(req.params.id), req.body?.status === 'revogada' ? 'revogada' : 'ativa', str(req.body?.reason, 200)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get('/api/inventory', auth, (req, res) => {
    res.json(db.prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 1000').all(req.me!.tenant_id));
  });
  /** Conector de estoque (contrato futuro): recebe produtos de um sistema externo. Não cria preço/quantidade: só grava o que vier. */
  app.post('/api/inventory/import', owner, (req, res) => {
    const items = Array.isArray(req.body?.products) ? req.body.products.slice(0, 5000) : [];
    const units = unitsMap(req.me!);
    let n = 0; const errors: string[] = [];
    tx(db, () => {
      items.forEach((p: any, i: number) => {
        const sku = str(p.sku, 60), name = str(p.name, 160);
        if (!sku || !name) { errors.push(`linha ${i + 1}: sku e nome obrigatórios`); return; }
        const unitId = p.unitId && units[p.unitId] ? p.unitId : null;
        const price = p.priceCents === undefined || p.priceCents === null ? null : Number.isInteger(p.priceCents) && p.priceCents >= 0 ? p.priceCents : (errors.push(`linha ${i + 1}: preço inválido`), null);
        db.prepare(`INSERT INTO products (id, tenant_id, unit_id, sku, name, category, brand, price_cents, color, size, available, images, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (tenant_id, sku, unit_id) DO UPDATE SET name = excluded.name, category = excluded.category, brand = excluded.brand, price_cents = excluded.price_cents, color = excluded.color,
          size = excluded.size, available = excluded.available, images = excluded.images, source = excluded.source, updated_at = excluded.updated_at`)
          .run(id(), req.me!.tenant_id, unitId, sku, name, str(p.category, 60) || null, str(p.brand, 60) || null, price, str(p.color, 40) || null, str(p.size, 40) || null,
            p.available === undefined ? null : p.available ? 1 : 0, j(Array.isArray(p.images) ? p.images.slice(0, 10).map((s: unknown) => str(s, 400)) : []), str(req.body?.source, 60) || 'api', now());
        n++;
      });
    });
    res.json({ imported: n, errors });
  });
  app.get('/api/voice', owner, (req, res) => {
    res.json(db.prepare('SELECT * FROM voice_consents WHERE tenant_id = ?').all(req.me!.tenant_id));
  });
  /** Módulo de voz sintética: só registro de consentimento nesta fase. Nenhuma clonagem é executada. */
  app.post('/api/voice/consent', owner, (req, res) => {
    const action = req.body?.action;
    const existing = db.prepare('SELECT * FROM voice_consents WHERE tenant_id = ? AND person = ?').get(req.me!.tenant_id, 'Dono da loja') as any;
    const hist = pj<any[]>(existing?.history, []);
    if (action === 'revogar') {
      if (!existing) return res.status(404).json({ error: 'Não há autorização registrada.' });
      hist.push({ at: now(), what: 'revogada', by: req.me!.name });
      db.prepare("UPDATE voice_consents SET status = 'revogada', revoked_at = ?, history = ? WHERE id = ?").run(now(), j(hist), existing.id);
      return res.json({ status: 'revogada' });
    }
    if (action === 'registrar-intencao') {
      hist.push({ at: now(), what: 'intenção registrada (aguarda verificação de identidade e termo assinado)', by: req.me!.name });
      if (existing) db.prepare("UPDATE voice_consents SET status = 'aguardando-verificacao', scope = ?, history = ? WHERE id = ?").run(str(req.body?.scope, 300), j(hist), existing.id);
      else db.prepare('INSERT INTO voice_consents (id, tenant_id, person, status, scope, history, created_at) VALUES (?,?,?,?,?,?,?)').run(id(), req.me!.tenant_id, 'Dono da loja', 'aguardando-verificacao', str(req.body?.scope, 300), j(hist), now());
      return res.json({ status: 'aguardando-verificacao' });
    }
    res.status(400).json({ error: 'Ação inválida.' });
  });
  app.get('/api/usage', owner, (req, res) => {
    res.json({ month: monthUsage(db, req.me!.tenant_id), recent: db.prepare('SELECT kind, amount, cost_usd, meta, at FROM usage WHERE tenant_id = ? ORDER BY at DESC LIMIT 100').all(req.me!.tenant_id) });
  });

  // ───────── Migração para a nuvem (só existe com BDX_IMPORT_TOKEN definido) ─────────
  // Recebe o pacote de dados em partes (?part=0,1,... &last=1), grava /data/import.tgz e reinicia:
  // o entrypoint do contêiner restaura banco + mídias + chaves e apaga o pacote.
  const importToken = process.env.BDX_IMPORT_TOKEN ?? '';
  if (importToken.length >= 32) {
    app.post('/api/admin/import', ah(async (req, res) => {
      const got = Buffer.from(sha256(String(req.headers['x-import-token'] ?? ''))), want = Buffer.from(sha256(importToken));
      if (!timingSafeEqual(got, want)) return res.status(403).json({ error: 'Token inválido.' });
      const part = Number(req.query.part ?? 0), tmp = join(DATA_DIR, 'import.tgz.partial');
      await pipeline(req, createWriteStream(tmp, { flags: part === 0 ? 'w' : 'a' }));
      if (req.query.last !== '1') return res.json({ ok: true, part, size: statSync(tmp).size });
      renameSync(tmp, join(DATA_DIR, 'import.tgz'));
      res.json({ ok: true, restarting: true, size: statSync(join(DATA_DIR, 'import.tgz')).size });
      console.log('[importação] pacote recebido; reiniciando para restaurar');
      setTimeout(() => process.exit(0), 1000);
    }));
  }

  // ───────── Front-end (build) ─────────
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|public\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[erro]', err?.message ?? err);
    if (res.headersSent) return;
    res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: err?.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais.' : 'Erro interno. Tente novamente.' });
  });
  return app;
}

/** Campos da peça de moto: só texto curto e opções da lista (vão para HTML do card e para argumentos do ffmpeg). */
export function cleanMoto(m: any) {
  if (!m || typeof m !== 'object') return null;
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => s(x, 40)).filter(Boolean).slice(0, 6) : undefined);
  const one = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return { peca: one(m.peca, ['card', 'entrega', 'video'] as const, 'card'), estilo: one(m.estilo, ['estudio', 'ripado'] as const, 'estudio'),
    foco: /^\d{1,3}% \d{1,3}%$/.test(String(m.foco ?? '')) ? m.foco : undefined, modelo: s(m.modelo, 40), ano: s(m.ano, 12), selo: s(m.selo, 24), preco: s(m.preco, 20),
    extras: list(m.extras) ?? [], direita: list(m.direita), semWhatsapp: m.semWhatsapp === true, nome: s(m.nome, 40), motoEntregue: s(m.motoEntregue, 40), etiqueta: s(m.etiqueta, 30),
    legenda: s(m.legenda, 600), estiloVideo: one(m.estiloVideo, ['pista', 'garagem', 'vitrine'] as const, 'pista'), musica: s(m.musica, 40) || undefined, semRonco: m.semRonco === true };
}

export function collectMedia(p: any): string[] {
  const ids: string[] = [];
  if (p.type === 'story') { if (p.photo?.id) ids.push(p.photo.id); for (const r of p.photos ?? []) if (r?.id) ids.push(r.id); }
  if (p.type === 'carousel') for (const s of p.slides ?? []) if (s.photo?.id) ids.push(s.photo.id);
  if (p.type === 'reel') { for (const c of p.clips ?? []) if (c.media?.id) ids.push(c.media.id); if (p.music?.id) ids.push(p.music.id); }
  return [...new Set(ids)];
}

function currentKey(db: DB, tenantId: string, deviceId: string) {
  const l = db.prepare("SELECT id FROM licenses WHERE tenant_id = ? ORDER BY expires_at DESC LIMIT 1").get(tenantId) as any;
  if (!l) return { status: 'sem-licenca' };
  const st = licenseState(db, tenantId);
  return { status: st.state, expiresAt: st.license?.expiresAt, daysLeft: st.license?.daysLeft };
}

/** Trabalhos com lease vencido (motor caiu) voltam para a fila; depois de 3 tentativas, falham. */
export function sweepLeases(db: DB) {
  const stale = db.prepare("SELECT * FROM jobs WHERE status = 'executando' AND lease_until < ?").all(now()) as any[];
  for (const jb of stale) {
    const fail = jb.attempts >= MAX_ATTEMPTS;
    const logArr = pj<any[]>(jb.log, []); logArr.push({ at: now(), msg: fail ? 'motor sem resposta: limite de tentativas atingido' : 'motor sem resposta: trabalho devolvido à fila' });
    db.prepare('UPDATE jobs SET status = ?, engine_id = NULL, lease_until = NULL, log = ?, message = ?, updated_at = ? WHERE id = ?').run(fail ? 'falhou' : 'fila', j(logArr), fail ? 'falhou após 3 tentativas' : 'recuperado da fila', now(), jb.id);
  }
  return stale.length;
}

/** Publica um item do calendário. Sem conexão/URL pública → exportação manual (nunca finge publicação). */
export async function publishEntry(db: DB, c: any, base: string) {
  const p = c.production_id ? db.prepare('SELECT * FROM productions WHERE id = ?').get(c.production_id) as any : null;
  if (!p || p.status !== 'aprovado' && p.status !== 'publicado') return { ok: false, status: c.status, error: 'Aprovação obrigatória: aprove a produção antes de publicar.' };
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(p.current_version_id) as any;
  const outs = pj<any[]>(v?.outputs, []).filter((o) => o.role !== 'preview').sort((a, b) => a.index - b.index);
  if (!outs.length) return { ok: false, status: c.status, error: 'Produção sem arquivos renderizados.' };
  const acc = db.prepare("SELECT * FROM ig_accounts WHERE tenant_id = ? AND unit_id = ? AND status = 'conectado'").get(c.tenant_id, c.unit_id) as any;
  const publicBase = process.env.PUBLIC_MEDIA_BASE_URL;
  if (!acc || !publicBase) {
    db.prepare("UPDATE calendar_entries SET status = 'exportacao-manual', error = ?, updated_at = ? WHERE id = ?").run(!acc ? 'Conta do Instagram da unidade não conectada.' : 'Servidor sem URL pública para a Meta buscar a mídia.', now(), c.id);
    igLog(db, c.tenant_id, c.id, acc?.id ?? null, 'publicar', 'exportacao-manual', { reason: !acc ? 'sem conta' : 'sem URL pública' });
    return { ok: false, status: 'exportacao-manual', error: !acc ? 'Instagram desta unidade não conectado: baixe os arquivos e publique manualmente.' : 'Publicação automática indisponível neste servidor (sem URL pública).', files: outs.map((o) => `/api/media/${o.mediaId}/download`) };
  }
  const media = outs.map((o) => db.prepare('SELECT * FROM media WHERE id = ?').get(o.mediaId) as any);
  const params = pj<any>(v.params, {});
  // "Todas as lojas": post/carrossel/Reel em collab (as outras contas aceitam sozinhas); Story sai em cada conta
  const others = params.allUnits ? (db.prepare("SELECT unit_id, username FROM ig_accounts WHERE tenant_id = ? AND unit_id != ? AND status = 'conectado'").all(c.tenant_id, c.unit_id) as any[]) : [];
  const pm = { kind: (p.type === 'carousel' ? 'carousel' : p.type) as any, urls: media.map((m) => publicBase + signMediaLink(m.id)), isVideo: media.map((m) => m.kind === 'video'), caption: c.caption ?? '',
    audioId: p.type === 'reel' ? params.audio?.id : undefined, collaborators: p.type !== 'story' ? others.map((o) => o.username) : undefined };
  const mapId = (mid: string, unitId: string) => db.prepare('INSERT OR REPLACE INTO ig_media_map (ig_media_id, tenant_id, calendar_id, unit_id, at) VALUES (?,?,?,?,?)').run(mid, c.tenant_id, c.id, unitId, now());
  try {
    const r = await publish(db, c.tenant_id, c.unit_id, pm);
    db.prepare("UPDATE calendar_entries SET status = 'publicado', ig_media_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(r.mediaId, now(), c.id);
    db.prepare("UPDATE productions SET status = 'publicado', updated_at = ? WHERE id = ?").run(now(), p.id);
    mapId(r.mediaId, c.unit_id);
    igLog(db, c.tenant_id, c.id, acc.id, 'publicar', 'ok', r);
    const extra: any[] = [];
    if (p.type === 'story') {
      for (const o of others) {
        try { const s = await publish(db, c.tenant_id, o.unit_id, pm); mapId(s.mediaId, o.unit_id); extra.push({ account: o.username, mediaId: s.mediaId }); }
        catch (e) { extra.push({ account: o.username, error: (e as Error).message }); }
      }
      if (extra.length) igLog(db, c.tenant_id, c.id, acc.id, 'publicar-outras-lojas', 'ok', extra);
    } else if (others.length) {
      // o convite leva alguns segundos para existir: aceite em segundo plano, com registro no log
      Promise.all(others.map(async (o) => ({ account: o.username, ...(await acceptCollab(db, c.tenant_id, o.unit_id, r.mediaId)) })))
        .then((x) => igLog(db, c.tenant_id, c.id, acc.id, 'collab', x.every((y) => y.ok) ? 'ok' : 'parcial', x)).catch(() => {});
    }
    return { ok: true, status: 'publicado', mediaId: r.mediaId, others: extra };
  } catch (e) {
    db.prepare("UPDATE calendar_entries SET status = 'falhou', error = ?, updated_at = ? WHERE id = ?").run((e as Error).message, now(), c.id);
    igLog(db, c.tenant_id, c.id, acc.id, 'publicar', 'erro', (e as Error).message);
    return { ok: false, status: 'falhou', error: (e as Error).message };
  }
}
