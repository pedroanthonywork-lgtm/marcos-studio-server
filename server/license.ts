// Licenciamento mensal P7 Labs. Modelo do WA Nitro: chave = JWT ES256 assinado no servidor; 30 dias;
// renovação soma ao vencimento; revogação; limite de dispositivos (o mais antigo sai). A validade real é
// sempre decidida no servidor — a chave guardada no cliente/motor é só cache verificável offline.
import { type DB, id, j, now, pj } from './db.ts';
import { signToken, verifyToken } from './security.ts';

export const DAY = 86_400_000;
export const PLANS: Record<string, { label: string; days: number; limits: { rendersPerMonth: number; aiCallsPerMonth: number; storageGb: number; units: number } }> = {
  essencial: { label: 'Essencial', days: 30, limits: { rendersPerMonth: 120, aiCallsPerMonth: 300, storageGb: 20, units: 1 } },
  profissional: { label: 'Profissional', days: 30, limits: { rendersPerMonth: 400, aiCallsPerMonth: 1500, storageGb: 80, units: 3 } },
  rede: { label: 'Rede', days: 30, limits: { rendersPerMonth: 1200, aiCallsPerMonth: 5000, storageGb: 250, units: 10 } },
};

type Lic = { id: string; tenant_id: string; plan: string; issued_at: number; expires_at: number; status: string; max_devices: number; limits: string; history: string };

const tokenFor = (l: Lic, tenantName: string) =>
  signToken({ iss: 'p7labs', sub: l.tenant_id, name: tenantName, lid: l.id, plan: l.plan, exp: Math.floor(l.expires_at / 1000), iat: Math.floor(now() / 1000) });

const tenantName = (db: DB, tid: string) => (db.prepare('SELECT name FROM tenants WHERE id = ?').get(tid) as { name: string } | undefined)?.name ?? tid;

function pushHistory(db: DB, l: Lic, what: string, at = now()) {
  const h = pj<any[]>(l.history, []);
  h.push({ at, what });
  db.prepare('UPDATE licenses SET history = ? WHERE id = ?').run(j(h), l.id);
}

export function issueLicense(db: DB, tenantId: string, plan = 'profissional', days?: number, at = now()) {
  const p = PLANS[plan];
  if (!p) throw new Error('Plano inválido');
  const d = days ?? p.days;
  if (!(d > 0 && d <= 400)) throw new Error('Dias inválidos');
  const l: Lic = { id: id(), tenant_id: tenantId, plan, issued_at: at, expires_at: at + d * DAY, status: 'ativa', max_devices: 3, limits: j(p.limits), history: j([{ at, what: `emitida por ${d} dias (${p.label})` }]) };
  db.prepare('INSERT INTO licenses (id, tenant_id, plan, issued_at, expires_at, status, max_devices, limits, history) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(l.id, l.tenant_id, l.plan, l.issued_at, l.expires_at, l.status, l.max_devices, l.limits, l.history);
  return { license: l, key: tokenFor(l, tenantName(db, tenantId)) };
}

export function renewLicense(db: DB, licenseId: string, days = 30, at = now()) {
  const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(licenseId) as Lic | undefined;
  if (!l) throw new Error('Licença não encontrada');
  l.expires_at = Math.max(l.expires_at, at) + days * DAY;
  l.status = 'ativa';
  db.prepare('UPDATE licenses SET expires_at = ?, status = ? WHERE id = ?').run(l.expires_at, l.status, l.id);
  pushHistory(db, l, `renovada por ${days} dias`, at);
  return { license: l, key: tokenFor(l, tenantName(db, l.tenant_id)) };
}

export function setLicenseStatus(db: DB, licenseId: string, status: 'ativa' | 'revogada', reason = '') {
  const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(licenseId) as Lic | undefined;
  if (!l) throw new Error('Licença não encontrada');
  db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run(status, licenseId);
  pushHistory(db, l, status === 'revogada' ? `revogada${reason ? ': ' + reason : ''}` : 'reativada');
}

export function currentLicense(db: DB, tenantId: string): Lic | undefined {
  return db.prepare('SELECT * FROM licenses WHERE tenant_id = ? ORDER BY expires_at DESC LIMIT 1').get(tenantId) as Lic | undefined;
}

export function licenseState(db: DB, tenantId: string, at = now()) {
  const l = currentLicense(db, tenantId);
  if (!l) return { state: 'sem-licenca' as const, ok: false };
  const daysLeft = Math.ceil((l.expires_at - at) / DAY);
  const state = l.status === 'revogada' ? 'revogada' : daysLeft <= 0 ? 'vencida' : daysLeft <= 7 ? 'vence-em-breve' : 'ativa';
  return { state, ok: state === 'ativa' || state === 'vence-em-breve', license: { id: l.id, plan: l.plan, planLabel: PLANS[l.plan]?.label, expiresAt: l.expires_at, daysLeft, limits: pj(l.limits, {} as (typeof PLANS)[string]['limits']), maxDevices: l.max_devices, history: pj(l.history, []) } };
}

/** Verificação feita pelo motor local / app: valida assinatura, consulta o servidor e registra o dispositivo. */
export function checkLicenseKey(db: DB, key: string, deviceId: string, label = '', at = now()) {
  const claims = verifyToken(key);
  if (!claims?.lid) return { status: 'invalida' as const };
  const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(claims.lid) as Lic | undefined;
  if (!l) return { status: 'desconhecida' as const };
  if (deviceId) {
    const dev = String(deviceId).slice(0, 64);
    const existing = db.prepare('SELECT id FROM license_activations WHERE license_id = ? AND device_id = ?').get(l.id, dev);
    if (!existing) {
      const all = db.prepare('SELECT id FROM license_activations WHERE license_id = ? ORDER BY last_seen ASC').all(l.id) as { id: string }[];
      // reinstalar não pode travar o cliente: o dispositivo mais antigo sai, e isso fica no histórico
      while (all.length >= l.max_devices) {
        const old = all.shift()!;
        db.prepare('DELETE FROM license_activations WHERE id = ?').run(old.id);
        pushHistory(db, l, 'dispositivo mais antigo desativado por limite', at);
      }
      db.prepare('INSERT INTO license_activations (id, license_id, device_id, label, first_seen, last_seen) VALUES (?,?,?,?,?,?)').run(id(), l.id, dev, label.slice(0, 80), at, at);
    } else db.prepare('UPDATE license_activations SET last_seen = ?, label = COALESCE(NULLIF(?, \'\'), label) WHERE license_id = ? AND device_id = ?').run(at, label.slice(0, 80), l.id, dev);
  }
  if (l.status === 'revogada') return { status: 'revogada' as const };
  if (l.expires_at <= at) return { status: 'vencida' as const, expiresAt: l.expires_at };
  return { status: 'ativa' as const, key: tokenFor(l, tenantName(db, l.tenant_id)), expiresAt: l.expires_at };
}

export function monthUsage(db: DB, tenantId: string, at = now()) {
  const d = new Date(at);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const rows = db.prepare('SELECT kind, SUM(amount) AS amount, SUM(cost_usd) AS cost FROM usage WHERE tenant_id = ? AND at >= ? GROUP BY kind').all(tenantId, start) as { kind: string; amount: number; cost: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, { amount: r.amount, costUsd: Math.round(r.cost * 10000) / 10000 }]));
}

export function recordUsage(db: DB, tenantId: string, kind: string, amount: number, costUsd = 0, meta?: unknown) {
  db.prepare('INSERT INTO usage (id, tenant_id, kind, amount, cost_usd, meta, at) VALUES (?,?,?,?,?,?,?)').run(id(), tenantId, kind, amount, costUsd, meta === undefined ? null : j(meta), now());
}

/** Bloqueia quando o consumo do mês atinge o limite do plano. */
export function withinLimit(db: DB, tenantId: string, kind: 'render' | 'ai_call'): boolean {
  const st = licenseState(db, tenantId);
  if (!st.ok || !st.license) return false;
  const used = monthUsage(db, tenantId)[kind]?.amount ?? 0;
  const lim = kind === 'render' ? st.license.limits.rendersPerMonth : st.license.limits.aiCallsPerMonth;
  return used < (lim ?? 0);
}
