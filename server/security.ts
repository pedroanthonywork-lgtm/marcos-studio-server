// Segredos ficam só no servidor: chave de criptografia (tokens Meta) e chave privada de licença.
// Em produção vêm de variáveis de ambiente; em desenvolvimento são gerados em data/secrets (fora do git).
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, scryptSync, sign, timingSafeEqual, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './db.ts';

const SECRETS_DIR = resolve(DATA_DIR, 'secrets');

function loadOrCreate(name: string, make: () => string): string {
  const env = process.env[name];
  if (env) return env.replace(/\\n/g, '\n');
  const file = resolve(SECRETS_DIR, name);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  mkdirSync(SECRETS_DIR, { recursive: true });
  const v = make();
  writeFileSync(file, v, { mode: 0o600 });
  return v;
}

const ENC_KEY = Buffer.from(loadOrCreate('BDX_ENC_KEY', () => randomBytes(32).toString('base64')), 'base64');
const LICENSE_PRIVATE_PEM = loadOrCreate('BDX_LICENSE_PRIVATE_KEY', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
});
export const LICENSE_PUBLIC_PEM = createPublicKey(createPrivateKey(LICENSE_PRIVATE_PEM)).export({ type: 'spki', format: 'pem' }).toString();

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function checkPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, s, h] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const want = Buffer.from(h, 'base64');
  const got = scryptSync(pw, Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(want, got);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}
export function decrypt(enc: string): string {
  const [iv, tag, body] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
/** JWT ES256 assinado com a chave privada do servidor (mesmo formato do WA Nitro). */
export function signToken(claims: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claims));
  const sig = sign('sha256', Buffer.from(head), { key: LICENSE_PRIVATE_PEM, dsaEncoding: 'ieee-p1363' });
  return head + '.' + b64u(sig);
}
export function verifyToken(token: string, publicPem = LICENSE_PUBLIC_PEM): Record<string, any> | null {
  const p = String(token ?? '').split('.');
  if (p.length !== 3) return null;
  const ok = verify('sha256', Buffer.from(p[0] + '.' + p[1]), { key: publicPem, dsaEncoding: 'ieee-p1363' }, Buffer.from(p[2], 'base64url'));
  if (!ok) return null;
  try { return JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8')); } catch { return null; }
}
