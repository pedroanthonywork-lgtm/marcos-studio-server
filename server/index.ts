// Ponto de entrada do servidor: API + front-end + agendador (publicações agendadas, renovação de tokens, recuperação da fila).
import { openDb, now } from './db.ts';
import { createApp, publishEntry, sweepLeases } from './app.ts';
import { refreshTokens, dailyStoryCleanup } from './instagram.ts';
import { scheduledAnalyses } from './metrics.ts';
import { syncAllStock } from './stock.ts';

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Marcos Motos Digital Experience · API em http://localhost:${port}`));

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    sweepLeases(db);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const time = `${pad(today.getHours())}:${pad(today.getMinutes())}`;
    const due = db.prepare("SELECT * FROM calendar_entries WHERE status = 'agendado' AND (date < ? OR (date = ? AND COALESCE(time, '00:00') <= ?))").all(date, date, time) as any[];
    for (const c of due) await publishEntry(db, c, process.env.APP_URL ?? '');
    if (new Date(now()).getMinutes() === 0) await refreshTokens(db);
    await scheduledAnalyses(db);
    await dailyStoryCleanup(db);
  } catch (e) { console.error('[agendador]', (e as Error).message); }
  finally { busy = false; }
}
setInterval(tick, 60_000).unref();

// Estoque do site da loja a cada 5 min (loop próprio: a 1ª carga de fotos não atrasa as publicações)
let stockBusy = false;
const stock = async () => { if (stockBusy) return; stockBusy = true; try { await syncAllStock(db); } finally { stockBusy = false; } };
setTimeout(stock, 20_000).unref();
setInterval(stock, 5 * 60_000).unref();
