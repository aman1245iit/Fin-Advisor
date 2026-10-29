// Outgoing email (password-reset links) over SMTP, configured in .env:
//   SMTP_HOST, SMTP_PORT (465 = TLS, 587 = STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM.
// Without SMTP settings, emails are printed to the server console instead, so a local
// install still works; the startup message says which mode is active.
import nodemailer from 'nodemailer';

export const mailConfigured = () => Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim());

let transport;
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    console.log(`\n[email not sent: SMTP is not set up in .env]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return { delivered: false };
  }
  const port = +process.env.SMTP_PORT || 587;
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST.trim(),
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER.trim(), pass: process.env.SMTP_PASS.trim() },
  });
  await transport.sendMail({ from: process.env.MAIL_FROM?.trim() || `Fin Advisor <${process.env.SMTP_USER.trim()}>`, to, subject, text, html });
  return { delivered: true };
}
