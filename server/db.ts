// Banco SQLite nativo do Node 24 (node:sqlite). Toda tabela de negócio tem tenant_id: isolamento entre clientes.
// shortcut: SQLite local serve demo e cliente único; para multi-cliente hospedado migrar para Postgres (Supabase) — ver ARQUITETURA.md.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DATA_DIR = resolve(process.env.BDX_DATA_DIR ?? 'data');

const MIGRATIONS: string[] = [
  `CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('p7admin','owner','editor','viewer')), pass_hash TEXT, email_verified_at INTEGER, created_at INTEGER NOT NULL);
   CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE email_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
   CREATE TABLE rate_limits (key TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX rate_limits_key ON rate_limits(key, at);
   CREATE TABLE units (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL, city TEXT, state TEXT,
     instagram TEXT, address TEXT, phone TEXT, data TEXT NOT NULL DEFAULT '{}', UNIQUE (tenant_id, slug));
   CREATE TABLE media (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), unit_id TEXT REFERENCES units(id), kind TEXT NOT NULL,
     category TEXT, collection TEXT, campaign TEXT, product TEXT, status TEXT NOT NULL DEFAULT 'novo', tags TEXT NOT NULL DEFAULT '[]',
     filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER, duration REAL,
     path TEXT NOT NULL, thumb_path TEXT, origin TEXT NOT NULL DEFAULT 'upload', created_at INTEGER NOT NULL);
   CREATE INDEX media_tenant ON media(tenant_id, created_at);
   CREATE TABLE productions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), unit_id TEXT REFERENCES units(id), type TEXT NOT NULL,
     title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'rascunho', current_version_id TEXT, week_plan_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE versions (id TEXT PRIMARY KEY, production_id TEXT NOT NULL REFERENCES productions(id), n INTEGER NOT NULL, params TEXT NOT NULL,
     instruction TEXT, changes TEXT NOT NULL DEFAULT '[]', parent_id TEXT, status TEXT NOT NULL DEFAULT 'rascunho', outputs TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL, approved_at INTEGER, approved_by TEXT);
   CREATE TABLE engines (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, token_hash TEXT, pair_code_hash TEXT,
     pair_expires_at INTEGER, last_seen INTEGER, version TEXT, info TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE TABLE jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), version_id TEXT REFERENCES versions(id), op TEXT NOT NULL,
     payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'fila', progress REAL NOT NULL DEFAULT 0, message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
     lease_until INTEGER, engine_id TEXT, log TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
   CREATE INDEX jobs_status ON jobs(tenant_id, status, created_at);
   CREATE TABLE calendar_entries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), unit_id TEXT NOT NULL REFERENCES units(id),
     date TEXT NOT NULL, time TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, production_id TEXT REFERENCES productions(id), caption TEXT,
     status TEXT NOT NULL DEFAULT 'planejado', ig_media_id TEXT, error TEXT, week_plan_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE week_plans (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), request TEXT NOT NULL, campaign TEXT, unit_ids TEXT NOT NULL,
     days TEXT NOT NULL, media_ids TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sugerido', created_at INTEGER NOT NULL);
   CREATE TABLE ig_accounts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), unit_id TEXT NOT NULL REFERENCES units(id),
     ig_user_id TEXT, username TEXT, token_enc TEXT, token_expires_at INTEGER, scopes TEXT, status TEXT NOT NULL DEFAULT 'desconectado',
     connected_at INTEGER, last_error TEXT, UNIQUE (tenant_id, unit_id));
   CREATE TABLE oauth_states (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, unit_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE publish_log (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, calendar_id TEXT, account_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL,
     detail TEXT, at INTEGER NOT NULL);
   CREATE TABLE licenses (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), plan TEXT NOT NULL, issued_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL, status TEXT NOT NULL, max_devices INTEGER NOT NULL DEFAULT 3, limits TEXT NOT NULL DEFAULT '{}', history TEXT NOT NULL DEFAULT '[]');
   CREATE TABLE license_activations (id TEXT PRIMARY KEY, license_id TEXT NOT NULL REFERENCES licenses(id), device_id TEXT NOT NULL, label TEXT,
     first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, UNIQUE (license_id, device_id));
   CREATE TABLE usage (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, meta TEXT, at INTEGER NOT NULL);
   CREATE TABLE brand_memory (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, unit_id TEXT, text TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
     source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ativo', created_at INTEGER NOT NULL);
   CREATE TABLE products (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, unit_id TEXT, sku TEXT NOT NULL, name TEXT NOT NULL, category TEXT, brand TEXT,
     price_cents INTEGER, color TEXT, size TEXT, available INTEGER, images TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, updated_at INTEGER NOT NULL,
     UNIQUE (tenant_id, sku, unit_id));
   CREATE TABLE voice_consents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, person TEXT NOT NULL, status TEXT NOT NULL, scope TEXT, document_ref TEXT,
     granted_at INTEGER, revoked_at INTEGER, history TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
   CREATE TABLE audit_log (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, action TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);`,
  // v2: conexão pelo Login do Facebook (página + conta IG), DM automática com link, análises de métricas e preferências por cliente
  `ALTER TABLE ig_accounts ADD COLUMN page_id TEXT;
   ALTER TABLE ig_accounts ADD COLUMN login TEXT NOT NULL DEFAULT 'instagram';
   CREATE TABLE dm_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, unit_id TEXT, source TEXT NOT NULL, ig_media_id TEXT, from_id TEXT, text TEXT,
     status TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
   CREATE UNIQUE INDEX dm_once ON dm_events(ig_media_id, from_id, status) WHERE status = 'enviado';
   CREATE TABLE metrics_reports (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, unit_id TEXT, period_from TEXT NOT NULL, period_to TEXT NOT NULL, data TEXT NOT NULL,
     suggestions TEXT NOT NULL DEFAULT '[]', engine TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE tenant_settings (tenant_id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE ig_media_map (ig_media_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, calendar_id TEXT NOT NULL, unit_id TEXT NOT NULL, at INTEGER NOT NULL);`,
  // v3: sincronização automática do estoque (foto do site -> mídia; archived = arquivada porque o produto saiu)
  `CREATE TABLE stock_images (tenant_id TEXT NOT NULL, url TEXT NOT NULL, sku TEXT NOT NULL, media_id TEXT, archived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, url));
   CREATE INDEX stock_images_sku ON stock_images(tenant_id, sku);`,
  // v4: estratégia completa do negócio gerada pela IA (status 'gerando' → 'pronta' | 'erro')
  `CREATE TABLE strategies (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', error TEXT, model TEXT, created_by TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
   CREATE INDEX strategies_tenant ON strategies(tenant_id, created_at);`,
];

export type DB = DatabaseSync;

export function openDb(file = resolve(DATA_DIR, 'studio.db')): DB {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  repairMediaPaths(db);
  return db;
}

/** A mídia guarda o caminho absoluto da máquina onde foi salva; se a pasta mudou (outro PC, nuvem), reaponta para data/media. */
function repairMediaPaths(db: DB) {
  const base = resolve(DATA_DIR, 'media');
  const fix = (p: string | null) => {
    if (!p || existsSync(p)) return null;
    const parts = p.split(/[\\/]/), i = parts.lastIndexOf('media');
    if (i < 0) return null;
    const c = join(base, ...parts.slice(i + 1));
    return existsSync(c) ? c : null;
  };
  const up = db.prepare('UPDATE media SET path = COALESCE(?, path), thumb_path = COALESCE(?, thumb_path) WHERE id = ?');
  let n = 0;
  for (const r of db.prepare('SELECT id, path, thumb_path FROM media').all() as { id: string; path: string; thumb_path: string | null }[]) {
    const a = fix(r.path), b = fix(r.thumb_path);
    if (a || b) { up.run(a, b, r.id); n++; }
  }
  if (n) console.log(`[mídia] ${n} arquivos reapontados para ${base}`);
}

export const id = () => randomUUID();
export const now = () => Date.now();
export const j = (v: unknown) => JSON.stringify(v);
export const pj = <T = any>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function audit(db: DB, tenantId: string | null, userId: string | null, action: string, detail?: unknown) {
  db.prepare('INSERT INTO audit_log (id, tenant_id, user_id, action, detail, at) VALUES (?,?,?,?,?,?)').run(id(), tenantId, userId, action, detail === undefined ? null : j(detail), now());
}
