// Sincroniza o estoque da loja (webloja) com produtos + Biblioteca.
// Roda sozinho a cada 5 min no servidor (index.ts) e no botão "Importar fotos do estoque".
// Produto novo: entra com as fotos. Produto que saiu do feed ou ficou indisponível: fotos arquivadas (somem da Biblioteca).
// Voltou: fotos voltam. Preço e nome acompanham o feed. Nada é inventado: preço só o que o feed informa.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type DB, id, j, now, pj, DATA_DIR } from './db.ts';
import { store } from './media.ts';

// Fonte principal: a vitrine da webloja (sistema de estoque da loja), lida direto pela API pública da vitrine.
// Reserva: o feed do site da loja (que também lê a webloja a cada 5 min). Os dois usam o mesmo id de produto.
const WEBLOJA = () => (process.env.STOCK_WEBLOJA_URL ?? '').replace(/\/$/, '');
const EMPRESA = () => Number(process.env.STOCK_WEBLOJA_EMPRESA ?? 0);
const FEED = () => process.env.STOCK_FEED_URL ?? '';
const MAX_IMAGES = 5;

const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Lê todos os produtos da vitrine webloja (paginado) no formato do feed. */
async function readWebloja() {
  const produtos: any[] = [];
  for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
    const r = await fetch(`${WEBLOJA()}/ws/get/produtos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ empresas_id: EMPRESA(), grupos_id: null, pagina: page, busca: '', por_pagina: 100 }) });
    const j0 = await r.json() as any;
    if (!r.ok || j0.status !== 'ok' || !Array.isArray(j0.data?.data)) throw new Error(`webloja respondeu ${r.status}`);
    pages = Number(j0.data.pages) || 1;
    for (const p of j0.data.data) {
      const img = p.imagem_catalogo || p.imagem;
      const price = p.preco_sob_consulta_catalogo === 1 ? null : Number(p.preco_calculado ?? p.preco_catalogo);
      produtos.push({ sourceId: p.id, fullName: p.nome, brand: p.marcas_nome, category: null, price: Number.isFinite(price) && price! > 0 ? price : null,
        available: p.ativo === 1 && !(p.controlar_estoque === 1 && !(Number(p.estoque_atual) > 0)),
        images: img ? [`https://imagens.smbstore.com.br/empresa_${EMPRESA()}/${img}`] : [] });
    }
  }
  return { ok: true, produtos };
}

async function readFeed(feedUrl: string) {
  const r = await fetch(feedUrl, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`feed do estoque respondeu ${r.status}`);
  return await r.json() as any;
}

export async function syncStock(db: DB, tenantId: string, feedUrl?: string) {
  let feed: any;
  if (!feedUrl && !WEBLOJA() && !FEED()) throw new Error('Sem site de estoque configurado: cadastre as motos na Biblioteca (STOCK_WEBLOJA_URL ou STOCK_FEED_URL ligam a sincronização).');
  if (feedUrl) feed = await readFeed(feedUrl);
  else {
    try { feed = await readWebloja(); }
    catch (e) { console.error('[estoque] webloja falhou, usando o feed do site:', (e as Error).message); feed = await readFeed(FEED()); }
  }
  // feed com erro ou vazio não pode "vender" o estoque inteiro
  if (feed.ok === false || !Array.isArray(feed.produtos) || !feed.produtos.length) throw new Error('feed do estoque vazio ou com erro: nada alterado');
  const unit = db.prepare('SELECT id FROM units WHERE tenant_id = ? LIMIT 1').get(tenantId) as any;
  const unitId = unit?.id ?? null;
  const tmp = join(DATA_DIR, 'tmp'); mkdirSync(tmp, { recursive: true });
  const seen = new Set<string>();
  let novos = 0, jaTinha = 0, falhas = 0, atualizados = 0, voltaram = 0;

  for (const p of feed.produtos) {
    const sku = String(p.sourceId ?? p.id ?? '');
    if (!sku) continue;
    const available = p.available !== false && p.stock !== 0;
    const images: string[] = (Array.isArray(p.images) ? p.images : []).filter((u: unknown) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, MAX_IMAGES);
    let name = String(p.fullName ?? p.name ?? '').slice(0, 160);
    // webloja manda em MAIÚSCULAS: se só mudou a caixa, mantém o nome já escrito bonito
    const prev = db.prepare('SELECT name FROM products WHERE tenant_id = ? AND sku = ? AND unit_id IS ?').get(tenantId, sku, unitId) as any;
    if (prev?.name && prev.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR')) name = prev.name;
    const price = typeof p.price === 'number' ? p.price : null;
    if (available) seen.add(sku);
    db.prepare(`INSERT INTO products (id, tenant_id, unit_id, sku, name, category, brand, price_cents, available, images, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id, sku, unit_id) DO UPDATE SET name = excluded.name, category = COALESCE(excluded.category, products.category), brand = COALESCE(excluded.brand, products.brand), price_cents = excluded.price_cents,
      available = excluded.available, images = excluded.images, updated_at = excluded.updated_at`)
      .run(id(), tenantId, unitId, sku, name, String(p.category ?? '').slice(0, 60) || null, String(p.brand ?? '').slice(0, 60) || null,
        price === null ? null : Math.round(price * 100), available ? 1 : 0, j(images), 'site', now());
    if (!available) continue;

    const tags = price === null ? ['estoque'] : [`preco:${brl(price)}`, 'estoque'];
    for (const url of images) {
      const known = db.prepare('SELECT media_id FROM stock_images WHERE tenant_id = ? AND url = ?').get(tenantId, url) as any;
      if (known?.media_id) continue; // já baixada: não baixa de novo a cada 5 min
      try {
        const img = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!img.ok) { falhas++; continue; }
        const file = join(tmp, `est-${id()}`);
        writeFileSync(file, Buffer.from(await img.arrayBuffer()));
        const st = await store(tenantId, file);
        if ('error' in st) { falhas++; continue; }
        const dup = db.prepare('SELECT id FROM media WHERE tenant_id = ? AND sha256 = ?').get(tenantId, st.sha) as any;
        let mediaId = dup?.id as string | undefined;
        if (mediaId) jaTinha++;
        else {
          mediaId = id();
          db.prepare(`INSERT INTO media (id, tenant_id, unit_id, kind, category, product, status, tags, filename, mime, size, sha256, path, origin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(mediaId, tenantId, unitId, st.kind, 'produto', name.slice(0, 120), 'novo', j(tags), name.slice(0, 120) + '.' + st.ext, st.mime, st.size, st.sha, st.path, 'upload', now());
          novos++;
        }
        db.prepare('INSERT OR REPLACE INTO stock_images (tenant_id, url, sku, media_id, archived) VALUES (?,?,?,?,0)').run(tenantId, url, sku, mediaId);
      } catch { falhas++; }
    }
    // fotos atuais do produto visíveis; foto trocada/removida no site sai da Biblioteca
    const imgs = j(images);
    const back = db.prepare("UPDATE media SET status = 'novo' WHERE status = 'arquivado' AND id IN (SELECT media_id FROM stock_images WHERE tenant_id = ? AND sku = ? AND archived = 1 AND url IN (SELECT value FROM json_each(?)))").run(tenantId, sku, imgs);
    db.prepare('UPDATE stock_images SET archived = 0 WHERE tenant_id = ? AND sku = ? AND archived = 1 AND url IN (SELECT value FROM json_each(?))').run(tenantId, sku, imgs);
    db.prepare("UPDATE media SET status = 'arquivado' WHERE status != 'arquivado' AND id IN (SELECT media_id FROM stock_images WHERE tenant_id = ? AND sku = ? AND archived = 0 AND url NOT IN (SELECT value FROM json_each(?)))").run(tenantId, sku, imgs);
    db.prepare('UPDATE stock_images SET archived = 1 WHERE tenant_id = ? AND sku = ? AND archived = 0 AND url NOT IN (SELECT value FROM json_each(?))').run(tenantId, sku, imgs);
    if (back.changes) voltaram++;
    // preço/nome mudaram: atualiza as fotos já existentes desse produto (mantém as outras tags)
    // (foto idêntica usada em 2+ produtos fica com o nome/preço da 1ª: evita regravar a cada rodada)
    for (const m of db.prepare(`SELECT m.id, m.tags, m.product FROM media m JOIN stock_images s ON s.media_id = m.id WHERE s.tenant_id = ? AND s.sku = ?
      AND (SELECT count(DISTINCT sku) FROM stock_images x WHERE x.media_id = m.id) = 1`).all(tenantId, sku) as any[]) {
      const old = pj<string[]>(m.tags, []);
      const next = [...old.filter((t) => !t.startsWith('preco:') && t !== 'estoque'), ...tags];
      if (JSON.stringify(old) !== JSON.stringify(next) || m.product !== name.slice(0, 120)) {
        db.prepare('UPDATE media SET tags = ?, product = ? WHERE id = ?').run(j(next), name.slice(0, 120), m.id); atualizados++;
      }
    }
  }

  // vendidos / fora do feed: arquiva as fotos (só as que vieram do estoque)
  let vendidos = 0;
  for (const s of db.prepare('SELECT DISTINCT sku FROM stock_images WHERE tenant_id = ?').all(tenantId) as any[]) {
    if (!seen.has(s.sku)) {
      const gone = db.prepare("UPDATE media SET status = 'arquivado' WHERE status != 'arquivado' AND id IN (SELECT media_id FROM stock_images WHERE tenant_id = ? AND sku = ? AND archived = 0)").run(tenantId, s.sku);
      db.prepare('UPDATE stock_images SET archived = 1 WHERE tenant_id = ? AND sku = ? AND archived = 0').run(tenantId, s.sku);
      if (gone.changes) vendidos++;
    }
  }
  db.prepare("UPDATE products SET available = 0, updated_at = ? WHERE tenant_id = ? AND source = 'site' AND available = 1 AND sku NOT IN (SELECT value FROM json_each(?))").run(now(), tenantId, j([...seen]));
  return { total: feed.produtos.length, disponiveis: seen.size, novos, jaTinha, atualizados, vendidos, voltaram, falhas };
}

/** Cliente dono do estoque (nesta cópia: a Marcos Motos). */
export async function syncAllStock(db: DB) {
  // Marcos Motos não tem site de estoque: sem fonte configurada, o estoque é manual na Biblioteca
  if (!process.env.STOCK_WEBLOJA_URL && !process.env.STOCK_FEED_URL) return;
  for (const t of db.prepare('SELECT id FROM tenants WHERE slug = ?').all(process.env.STOCK_TENANT_SLUG ?? 'marcos-motos') as any[]) {
    try {
      const r = await syncStock(db, t.id);
      if (r.novos || r.vendidos || r.voltaram || r.atualizados || r.falhas) console.log('[estoque]', JSON.stringify(r));
    } catch (e) { console.error('[estoque]', (e as Error).message); }
  }
}
