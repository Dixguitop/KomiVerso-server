// Envío de reportes y sugerencias por correo usando la API HTTP de Brevo
// (la misma que ya usa mailer.js para los códigos de acceso; funciona en
// Render free porque va por HTTPS, no por SMTP).
//
// Variables de entorno:
//   BREVO_API_KEY         (ya la tienes)
//   BREVO_SENDER_EMAIL    (ya la tienes; debe ser un remitente verificado en Brevo)
//   REPORT_TO_EMAIL       correo(s) donde llegan los REPORTES de problemas
//   SUGGESTION_TO_EMAIL   correo(s) donde llegan las SUGERENCIAS
//   FEEDBACK_TO_EMAIL     (opcional) correo de respaldo para ambos si no defines los de arriba
// Puedes poner varios correos separados por coma.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function getRecipients(kind) {
  const raw =
    (kind === "report" ? process.env.REPORT_TO_EMAIL : process.env.SUGGESTION_TO_EMAIL) ||
    process.env.FEEDBACK_TO_EMAIL ||
    "";
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

function buildHtml(title, fields) {
  const rows = fields
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 12px;font-weight:bold;vertical-align:top;color:#555;white-space:nowrap;">${esc(label)}</td>
          <td style="padding:8px 12px;vertical-align:top;">${esc(value).replace(/\n/g, "<br>")}</td>
        </tr>`
    )
    .join("");
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;">
      <h2 style="color:#E8543E;">${esc(title)}</h2>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">${rows}</table>
    </div>`;
}

/**
 * @param {{ kind: "report"|"suggestion", subject: string, title: string,
 *           fields: Array<[string, string]>, replyTo?: string }} opts
 */
export async function sendFeedbackMail({ kind, subject, title, fields, replyTo }) {
  const to = getRecipients(kind);
  if (!to.length) {
    const err = new Error(
      kind === "report"
        ? "Falta REPORT_TO_EMAIL (o FEEDBACK_TO_EMAIL) en las variables de entorno"
        : "Falta SUGGESTION_TO_EMAIL (o FEEDBACK_TO_EMAIL) en las variables de entorno"
    );
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    const err = new Error("Faltan BREVO_API_KEY / BREVO_SENDER_EMAIL");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const body = {
    sender: { name: "KomiVerso", email: process.env.BREVO_SENDER_EMAIL },
    to,
    subject,
    htmlContent: buildHtml(title, fields),
  };
  if (replyTo) body.replyTo = { email: replyTo };

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo respondió ${res.status}: ${detail}`);
  }
}
