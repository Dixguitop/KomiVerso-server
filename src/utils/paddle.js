import crypto from "node:crypto";

const PADDLE_ENV = process.env.PADDLE_ENV === "production" ? "production" : "sandbox";

const PADDLE_API_BASE =
  PADDLE_ENV === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

async function paddleFetch(path, options = {}) {
  const apiKey = requireEnv("PADDLE_API_KEY");
  const res = await fetch(`${PADDLE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.detail || `Paddle API error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function crearCheckoutFan({ usuarioId, correo }) {
  const priceId = requireEnv("PADDLE_PRICE_ID_FAN");

  const body = {
    items: [{ price_id: priceId, quantity: 1 }],
    customer: { email: correo },
    custom_data: { usuarioId },
    collection_mode: "automatic",
  };

  const data = await paddleFetch("/transactions", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const checkoutUrl = data?.data?.checkout?.url;
  if (!checkoutUrl) throw new Error("Paddle no devolvió una URL de checkout");
  return checkoutUrl;
}

export async function cancelarSuscripcion(paddleSubscriptionId) {
  return paddleFetch(`/subscriptions/${paddleSubscriptionId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ effective_from: "next_billing_period" }),
  });
}

export function verificarFirmaWebhook(signatureHeader, rawBody) {
  const secret = requireEnv("PADDLE_WEBHOOK_SECRET");
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(";").map((p) => p.split("="))
  );
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  const payload = `${ts}:${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(h1));
  } catch {
    return false;
  }
}
