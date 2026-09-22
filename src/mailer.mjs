import nodemailer from 'nodemailer';

// Outgoing email, used only to send password reset links.
//
// The mail account's own password is a secret and lives in the environment, never in this
// repository. If mail is not configured the system does not pretend to have sent anything:
// `send` reports that it was not sent, and the caller shows the administrator the reset link
// so they can hand it over in person. That keeps an unconfigured install usable instead of
// silently swallowing resets.
let cached = null;

export function mailSettings(env = process.env) {
  const from = (env.FR_MAIL_FROM || '').trim();
  const url = (env.FR_SMTP_URL || '').trim();
  const host = (env.FR_SMTP_HOST || '').trim();
  if (!from || (!url && !host)) return { configured: false, from, reason: !from ? 'FR_MAIL_FROM is not set' : 'neither FR_SMTP_URL nor FR_SMTP_HOST is set' };
  if (url) return { configured: true, from, url };
  const port = Number(env.FR_SMTP_PORT || 587);
  return {
    configured: true,
    from,
    options: {
      host,
      port,
      // Port 465 is TLS from the first byte; 587 upgrades with STARTTLS.
      secure: env.FR_SMTP_SECURE ? env.FR_SMTP_SECURE === '1' : port === 465,
      auth: env.FR_SMTP_USER ? { user: env.FR_SMTP_USER, pass: env.FR_SMTP_PASS || '' } : undefined,
    },
  };
}

function transport(settings) {
  if (!cached) cached = settings.url ? nodemailer.createTransport(settings.url) : nodemailer.createTransport(settings.options);
  return cached;
}
export const resetMailer = () => { cached = null; };

export async function send({ to, subject, text }, env = process.env) {
  const settings = mailSettings(env);
  if (!settings.configured) return { sent: false, reason: settings.reason };
  try {
    const info = await transport(settings).sendMail({ from: settings.from, to, subject, text });
    return { sent: true, id: info.messageId };
  } catch (error) {
    // A failed send is reported, never hidden: the caller falls back to handing the link over.
    console.error(`Could not send mail to ${to}: ${error.message}`);
    return { sent: false, reason: error.message };
  }
}

export function resetEmail({ companyName, fullName, link, minutes }) {
  return {
    subject: `${companyName} - password reset`,
    text: `Hello ${fullName},

A password reset was requested for your ${companyName} Financial Monitoring account.

Open this link to choose a new password:

${link}

The link works once and expires in ${minutes} minutes. Signing in again with a new password
ends every other session on your account.

If you did not ask for this, you can ignore this message: nothing changes until the link is
used, and whoever asked cannot see your existing password.
`,
  };
}
