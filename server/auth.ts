// Autenticação: sessão em cookie httpOnly (token aleatório, guardado como hash), convite com verificação de e-mail
// (token de 32 bytes, SHA-256 no banco, 24 h, uso único), reenvio limitado por usuário e por IP, usuários não
// verificados bloqueados.
import type { NextFunction, Request, Response } from 'express';
import { type DB, audit, id, now } from './db.ts';
import { checkPassword, hashPassword, randomToken, sha256 } from './security.ts';
import { sendMail, verificationMail } from './mail.ts';
import { licenseState } from './license.ts';

// nome próprio por cliente: cookie vale por host (não por porta), e dois sistemas em localhost se derrubavam
export const SESSION_COOKIE = process.env.BDX_SESSION_COOKIE ?? 'marcos_session';
const SESSION_MS = 14 * 86_400_000;
const VERIFY_MS = 86_400_000;

export type Me = { id: string; tenant_id: string; email: string; name: string; role: 'p7admin' | 'owner' | 'editor' | 'viewer'; email_verified_at: number | null };
declare global { namespace Express { interface Request { me?: Me } } }

export function rateLimited(db: DB, key: string, max: number, windowMs: number): boolean {
  const t = now();
  db.prepare('DELETE FROM rate_limits WHERE at < ?').run(t - 86_400_000);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND at > ?').get(key, t - windowMs) as { n: number }).n;
  if (n >= max) return true;
  db.prepare('INSERT INTO rate_limits (key, at) VALUES (?, ?)').run(key, t);
  return false;
}

export function createSession(db: DB, userId: string): string {
  const raw = randomToken();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(sha256(raw), userId, now() + SESSION_MS, now());
  return raw;
}

function cookieValue(req: Request, name: string): string | undefined {
  const c = req.headers.cookie ?? '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export function setSessionCookie(res: Response, raw: string) {
  const secure = process.env.BDX_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(raw)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}

export const loadUser = (db: DB) => (req: Request, _res: Response, next: NextFunction) => {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (raw) {
    const row = db.prepare(`SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.email_verified_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`).get(sha256(raw), now()) as Me | undefined;
    if (row) req.me = row;
  }
  next();
};

/** Rotas protegidas: sessão válida + e-mail verificado + (para clientes) licença ativa. */
export const requireAuth = (db: DB, opts: { roles?: Me['role'][]; skipLicense?: boolean } = {}) => (req: Request, res: Response, next: NextFunction) => {
  const me = req.me;
  if (!me) return res.status(401).json({ error: 'Entre na sua conta.' });
  if (!me.email_verified_at) return res.status(403).json({ error: 'Confirme seu e-mail para continuar.', code: 'email-nao-verificado' });
  if (opts.roles && !opts.roles.includes(me.role)) return res.status(403).json({ error: 'Seu perfil não tem permissão para esta ação.' });
  if (!opts.skipLicense && me.role !== 'p7admin') {
    const st = licenseState(db, me.tenant_id);
    if (!st.ok) return res.status(402).json({ error: 'Licença inativa. Fale com a P7 Labs para renovar.', code: 'licenca-' + st.state });
  }
  next();
};

export function login(db: DB, email: string, password: string): { user?: Me; error?: string; code?: string } {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) as (Me & { pass_hash: string | null }) | undefined;
  if (!u || !checkPassword(String(password), u.pass_hash)) return { error: 'E-mail ou senha incorretos.' };
  if (!u.email_verified_at) return { error: 'Confirme seu e-mail antes de entrar. Use “reenviar confirmação”.', code: 'email-nao-verificado' };
  return { user: u };
}

async function issueVerification(db: DB, user: { id: string; name: string; email: string }, appUrl: string) {
  db.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = 'verify' AND used_at IS NULL").run(now(), user.id); // tokens antigos deixam de valer
  const raw = randomToken(32);
  db.prepare('INSERT INTO email_tokens (id, user_id, kind, expires_at, created_at) VALUES (?,?,?,?,?)').run(sha256(raw), user.id, 'verify', now() + VERIFY_MS, now());
  const link = `${appUrl}/verificar-email?token=${raw}`;
  await sendMail({ to: user.email, ...verificationMail(user.name, link) });
}

/** Convite (cadastro): cria usuário não verificado e envia o e-mail. Falha no envio fica registrada e o reenvio continua disponível. */
export async function invite(db: DB, by: Me, input: { email: string; name: string; role: Me['role']; tenantId?: string }, appUrl: string) {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  const name = String(input.name ?? '').trim().slice(0, 80) || email;
  const role = input.role;
  if (!['owner', 'editor', 'viewer'].includes(role) && !(by.role === 'p7admin' && role === 'p7admin')) throw new Error('Perfil inválido.');
  const tenantId = by.role === 'p7admin' && input.tenantId ? input.tenantId : by.tenant_id;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('Este e-mail já tem acesso.');
  const user = { id: id(), name, email };
  db.prepare('INSERT INTO users (id, tenant_id, email, name, role, created_at) VALUES (?,?,?,?,?,?)').run(user.id, tenantId, email, name, role, now());
  audit(db, tenantId, by.id, 'usuario.convidado', { email, role });
  try { await issueVerification(db, user, appUrl); return { userId: user.id, mailSent: true }; }
  catch (e) { console.error('[mail] falha ao enviar verificação', (e as Error).message); return { userId: user.id, mailSent: false }; }
}

export function verifyEmail(db: DB, rawToken: string, password: string): { ok: true; userId: string } | { ok: false; error: string } {
  if (String(password ?? '').length < 10) return { ok: false, error: 'A senha precisa de pelo menos 10 caracteres.' };
  const t = db.prepare("SELECT * FROM email_tokens WHERE id = ? AND kind = 'verify'").get(sha256(String(rawToken ?? ''))) as { user_id: string; expires_at: number; used_at: number | null } | undefined;
  if (!t) return { ok: false, error: 'Link inválido. Peça um novo e-mail de confirmação.' };
  if (t.used_at) return { ok: false, error: 'Este link já foi usado. Peça um novo e-mail de confirmação.' };
  if (t.expires_at < now()) return { ok: false, error: 'Link expirado. Peça um novo e-mail de confirmação.' };
  db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(now(), sha256(String(rawToken)));
  db.prepare('UPDATE users SET email_verified_at = ?, pass_hash = ? WHERE id = ?').run(now(), hashPassword(password), t.user_id);
  return { ok: true, userId: t.user_id };
}

/** Reenvio: 3/hora por e-mail e por IP; resposta idêntica exista ou não a conta. */
export async function resendVerification(db: DB, email: string, ip: string, appUrl: string): Promise<{ limited: boolean }> {
  const e = String(email ?? '').trim().toLowerCase();
  if (rateLimited(db, 'resend-ip:' + ip, 3, 3_600_000) || rateLimited(db, 'resend-email:' + e, 3, 3_600_000)) return { limited: true };
  const u = db.prepare('SELECT id, name, email, email_verified_at FROM users WHERE email = ?').get(e) as { id: string; name: string; email: string; email_verified_at: number | null } | undefined;
  if (u && !u.email_verified_at) {
    try { await issueVerification(db, u, appUrl); } catch (err) { console.error('[mail] reenvio falhou', (err as Error).message); }
  }
  return { limited: false };
}
