// Envio de e-mail via API REST da Resend (sem SDK). Sem RESEND_API_KEY em desenvolvimento,
// o link é gravado no log do servidor para teste local — nunca em produção (BDX_ENV=production exige a chave).
export type Mail = { to: string; subject: string; html: string };
export type Sender = (m: Mail) => Promise<void>;

export const resendSender: Sender = async (m) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    if (process.env.BDX_ENV === 'production') throw new Error('RESEND_API_KEY/EMAIL_FROM ausentes');
    console.warn(`[mail:dev] Resend não configurado. Para: ${m.to} · ${m.subject}\n${m.html.replace(/<[^>]+>/g, ' ')}`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
};

let current: Sender = resendSender;
export const setSender = (s: Sender) => { current = s; };
export const sendMail = (m: Mail) => current(m);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function verificationMail(name: string, link: string): Pick<Mail, 'subject' | 'html'> {
  return {
    subject: 'Marcos Motos Digital Experience — confirme seu e-mail',
    html: `<div style="font-family:Helvetica,Arial,sans-serif;background:#0B0A09;color:#F7F2EA;padding:32px">
      <h2 style="font-weight:400;letter-spacing:.04em">Olá, ${esc(name)}</h2>
      <p>Você foi convidado(a) para o <b>Marcos Motos Digital Experience · Marketing Studio</b>.</p>
      <p>Confirme seu e-mail e crie sua senha (link válido por 24 horas, uso único):</p>
      <p><a href="${esc(link)}" style="display:inline-block;background:#C9A36A;color:#0B0A09;padding:12px 22px;border-radius:999px;text-decoration:none">Confirmar e-mail</a></p>
      <p style="color:#9b8f80;font-size:12px">Powered by P7 Labs. Se você não esperava este convite, ignore esta mensagem.</p></div>`,
  };
}
