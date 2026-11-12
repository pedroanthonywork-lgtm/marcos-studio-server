// Cria o cliente Marcos Motos, a unidade (dados públicos verificados em brand-intelligence/units.json),
// a conta da P7 Labs, o acesso do proprietário e uma licença de 30 dias.
// Senhas iniciais vêm de variáveis de ambiente ou são geradas e gravadas em data/secrets/initial-passwords.txt.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, id, j, now, DATA_DIR } from './db.ts';
import { hashPassword, randomToken } from './security.ts';
import { issueLicense } from './license.ts';

const db = openDb();
const units = JSON.parse(readFileSync(resolve('brand-intelligence/units.json'), 'utf8')).units as any[];

let tenant = db.prepare("SELECT * FROM tenants WHERE slug = 'marcos-motos'").get() as any;
if (!tenant) {
  tenant = { id: id(), name: 'Marcos Motos', slug: 'marcos-motos' };
  db.prepare('INSERT INTO tenants (id, name, slug, created_at) VALUES (?,?,?,?)').run(tenant.id, tenant.name, tenant.slug, now());
}
let p7 = db.prepare("SELECT * FROM tenants WHERE slug = 'p7labs'").get() as any;
if (!p7) {
  p7 = { id: id() };
  db.prepare('INSERT INTO tenants (id, name, slug, created_at) VALUES (?,?,?,?)').run(p7.id, 'P7 Labs', 'p7labs', now());
}
for (const u of units) {
  db.prepare(`INSERT INTO units (id, tenant_id, slug, name, city, state, instagram, address, phone, data) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (tenant_id, slug) DO UPDATE SET name = excluded.name, city = excluded.city, instagram = excluded.instagram, address = excluded.address, phone = excluded.phone, data = excluded.data`)
    .run(id(), tenant.id, u.id, u.name, u.city, u.state, u.instagram, u.address, u.phone, j({ highlights: u.highlights, bio: u.bio, hours: u.hours ?? null, followersAt20261108: u.followersAt20261108 }));
}
const lines: string[] = [];
function user(email: string, name: string, role: string, tenantId: string, envVar: string) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return;
  const pw = process.env[envVar] ?? randomToken(12);
  db.prepare('INSERT INTO users (id, tenant_id, email, name, role, pass_hash, email_verified_at, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id(), tenantId, email, name, role, hashPassword(pw), now(), now());
  if (!process.env[envVar]) lines.push(`${email}  ${pw}`);
}
user(process.env.BDX_ADMIN_EMAIL ?? 'admin@p7labs.local', 'P7 Labs', 'p7admin', p7.id, 'BDX_ADMIN_PASSWORD');
user(process.env.BDX_OWNER_EMAIL ?? 'dono@marcosmotos.local', 'Marcos Motos', 'owner', tenant.id, 'BDX_OWNER_PASSWORD');
// Marcos Motos: Stories do dia apagados sozinhos às 23h55 (opcional; desligado: a API nÃ£o apaga Story no login unificado)
db.prepare("INSERT OR IGNORE INTO tenant_settings (tenant_id, data) VALUES (?, ?)").run(tenant.id, j({ stories: { autoDelete: false, at: '23:55' } }));
if (!db.prepare('SELECT 1 FROM licenses WHERE tenant_id = ?').get(tenant.id)) issueLicense(db, tenant.id, 'profissional', 30);
if (lines.length) {
  mkdirSync(resolve(DATA_DIR, 'secrets'), { recursive: true });
  writeFileSync(resolve(DATA_DIR, 'secrets', 'initial-passwords.txt'), lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`Senhas iniciais gravadas em ${resolve(DATA_DIR, 'secrets', 'initial-passwords.txt')} (troque no primeiro acesso).`);
}
console.log('Seed concluído: cliente Marcos Motos, 1 unidade, licença 30 dias.');
