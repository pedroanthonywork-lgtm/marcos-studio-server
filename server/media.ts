// Armazenamento de mídia: originais preservados byte a byte (nome = SHA-256), tipo validado pelo conteúdo
// (assinatura do arquivo), nunca pela extensão enviada. Miniatura opcional gerada no navegador.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DATA_DIR } from './db.ts';

export const MEDIA_DIR = resolve(DATA_DIR, 'media');

const LIMITS = { image: 60 * 1024 * 1024, video: 4 * 1024 * 1024 * 1024, audio: 300 * 1024 * 1024 };

export async function sniff(path: string): Promise<{ kind: 'image' | 'video' | 'audio'; mime: string; ext: string } | null> {
  const fh = await open(path, 'r');
  const b = Buffer.alloc(16);
  await fh.read(b, 0, 16, 0);
  await fh.close();
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (/^(M4A |M4B )/.test(brand)) return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
    if (/^(heic|heix|mif1)/.test(brand)) return null; // HEIC: navegador não exibe; pedir JPEG
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

/** Move o upload temporário para o armazenamento definitivo do cliente. Retorna null se o tipo não for aceito. */
export async function store(tenantId: string, tmpPath: string) {
  const type = await sniff(tmpPath);
  if (!type) { unlinkSync(tmpPath); return { error: 'Formato não aceito. Use JPEG, PNG, WEBP, MP4, MOV, MP3, M4A ou WAV.' } as const; }
  const size = statSync(tmpPath).size;
  if (size > LIMITS[type.kind]) { unlinkSync(tmpPath); return { error: 'Arquivo acima do limite permitido.' } as const; }
  const sha = await sha256File(tmpPath);
  const dir = join(MEDIA_DIR, tenantId, sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const final = join(dir, `${sha}.${type.ext}`);
  if (existsSync(final)) unlinkSync(tmpPath); else renameSync(tmpPath, final);
  return { ...type, sha, size, path: final } as const;
}

// Links públicos temporários assinados (exigência da Meta: mídia acessível por URL pública no momento da publicação).
const SIGN_KEY = () => process.env.BDX_PUBLIC_LINK_KEY ?? 'dev-only-link-key-change-me';
export function signMediaLink(mediaId: string, ttlMs = 6 * 3_600_000) {
  const exp = Date.now() + ttlMs;
  const sig = createHmac('sha256', SIGN_KEY()).update(`${mediaId}.${exp}`).digest('base64url');
  return `/public/media/${mediaId}/${exp}/${sig}`;
}
export function checkMediaLink(mediaId: string, exp: string, sig: string) {
  if (Number(exp) < Date.now()) return false;
  const want = createHmac('sha256', SIGN_KEY()).update(`${mediaId}.${exp}`).digest('base64url');
  return want === sig;
}
