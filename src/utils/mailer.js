export function generarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function enviarCodigoVerificacion(correo, codigo) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: { name: "KomiVerso", email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: correo }],
      subject: `Tu código de acceso: ${codigo}`,
      htmlContent: `
        <div style="font-family: sans-serif; max-width: 420px; margin: auto;">
          <h2 style="color:#E8543E;">KōmiVerso</h2>
          <p>Tu código de acceso es:</p>
          <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${codigo}</p>
          <p style="color: #888; font-size: 13px;">Expira en 10 minutos. Si no lo pediste tú, ignora este correo.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo respondió ${res.status}: ${detail}`);
  }
}
