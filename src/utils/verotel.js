import crypto from "node:crypto";

const CAMPOS_FIRMABLES = [
  "version",
  "shopID",
  "saleID",
  "referenceID",
  "priceAmount",
  "priceCurrency",
  "paymentMethod",
  "description",
  "name",
  "custom1",
  "custom2",
  "custom3",
  "subscriptionType",
  "period",
  "trialAmount",
  "trialPeriod",
  "cancelDiscountPercentage",
  "type",
  "successURL",
  "declineURL",
  "precedingSaleID",
  "upgradeOption",
  "mcc",
  "subCreditorName",
  "subCreditorId",
  "subCreditorCountry",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function baseUrl() {
  return process.env.VEROTEL_CARDBILLING === "1"
    ? "https://secure.billing.creditcard"
    : "https://secure.verotel.com";
}

function firmar(secret, params, soloFirmables = true) {
  const claves = Object.keys(params)
    .filter((k) => k !== "signature" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .filter((k) => !soloFirmables || CAMPOS_FIRMABLES.includes(k))
    .sort();
  const partes = claves.map((k) => `${k}=${params[k]}`);
  const base = `${secret}:${partes.join(":")}`;
  return crypto.createHash("sha256").update(base).digest("hex");
}

export function crearCheckoutFanURL({ usuarioId, correo }) {
  const shopID = requireEnv("VEROTEL_SHOP_ID");
  const secret = requireEnv("VEROTEL_SIGNATURE_KEY");
  const version = process.env.VEROTEL_VERSION || "4";

  const params = {
    version,
    shopID,
    priceAmount: "8.50",
    priceCurrency: "USD",
    description: "KomiVerso Fan",
    subscriptionType: "recurring",
    period: "P1M",
    custom1: String(usuarioId),
    type: "subscription",
  };

  const signature = firmar(secret, params);
  const qs = new URLSearchParams({ ...params, signature });
  if (correo) qs.set("email", correo);

  return `${baseUrl()}/startorder?${qs.toString()}`;
}

export async function cancelarSuscripcion(saleID) {
  const shopID = requireEnv("VEROTEL_SHOP_ID");
  const secret = requireEnv("VEROTEL_SIGNATURE_KEY");
  const version = process.env.VEROTEL_VERSION || "4";

  const params = { shopID, saleID, version };
  const signature = firmar(secret, params);
  const qs = new URLSearchParams({ ...params, signature });

  const res = await fetch(`${baseUrl()}/cancel-subscription?${qs.toString()}`);
  const texto = await res.text();
  if (!res.ok) {
    throw new Error(texto || `Error ${res.status} cancelando la suscripción en Verotel`);
  }
  return texto;
}

export function verificarFirmaPostback(datos) {
  const secret = requireEnv("VEROTEL_SIGNATURE_KEY");
  const firmaRecibida = datos?.signature;
  if (!firmaRecibida) return false;

  const esperada = firmar(secret, datos, false);

  try {
    return crypto.timingSafeEqual(
      Buffer.from(esperada),
      Buffer.from(String(firmaRecibida).toLowerCase())
    );
  } catch {
    return false;
  }
    }

