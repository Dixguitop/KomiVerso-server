import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BUCKET = "avatars";

export async function subirAvatar(usuarioId, dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("Formato de imagen inválido");
  }
  const [, mime, base64] = match;
  const ext = mime.split("/")[1] || "jpg";
  const buffer = Buffer.from(base64, "base64");

  if (buffer.length > 3 * 1024 * 1024) {
    throw new Error("La imagen es demasiado grande");
  }

  const path = `${usuarioId}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mime, upsert: true });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);

  return `${data.publicUrl}?t=${Date.now()}`;
}

export default supabaseAdmin;
