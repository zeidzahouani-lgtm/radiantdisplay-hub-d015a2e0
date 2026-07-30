import { supabase } from "@/integrations/supabase/client";
import { getSupabasePublishableKey, supabaseEndpoint } from "@/lib/env";

function safeUUID(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {}
  // RFC4122 v4 fallback for non-secure contexts (HTTP)
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizeExt(fileName: string): string {
  const raw = fileName.includes(".") ? fileName.split(".").pop() || "" : "";
  const clean = raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  return clean ? `.${clean}` : "";
}

function parseStorageError(responseText: string): { message: string; code: string } {
  try {
    const json = JSON.parse(responseText || "{}");
    return {
      message: json.message || json.error || json.msg || "",
      code: String(json.statusCode || json.error || json.code || ""),
    };
  } catch {
    return { message: (responseText || "").slice(0, 300), code: "" };
  }
}

type UploadResult = { ok: true } | { ok: false; status: number; message: string; code: string; raw: string };

async function putObject(
  bucket: string,
  fileName: string,
  file: File,
  upsert: boolean,
  sendContentType: boolean,
  onProgress?: (percent: number) => void
): Promise<UploadResult> {
  const url = supabaseEndpoint(`/storage/v1/object/${bucket}/${fileName}`);
  const apiKey = getSupabasePublishableKey();
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token || apiKey;

  return new Promise<UploadResult>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("apikey", apiKey);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("x-upsert", upsert ? "true" : "false");
    if (sendContentType && file.type) xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
        return;
      }
      const parsed = parseStorageError(xhr.responseText);
      console.error("[upload-media] Upload failed", { status: xhr.status, url, ...parsed });
      resolve({ ok: false, status: xhr.status, message: parsed.message, code: parsed.code, raw: xhr.responseText || "" });
    };
    xhr.onerror = () => {
      console.error("[upload-media] Network/CORS error", { url });
      resolve({ ok: false, status: 0, message: `Erreur réseau/CORS vers ${url}.`, code: "network", raw: "" });
    };

    xhr.send(file);
  });
}

export async function uploadMediaFile(
  file: File,
  onProgress?: (percent: number) => void,
  bucket = "media"
): Promise<string> {
  let fileName = `${safeUUID()}${sanitizeExt(file.name)}`;

  let res = await putObject(bucket, fileName, file, false, true, onProgress);

  if (!res.ok && res.status === 400) {
    const lower = `${res.message} ${res.code} ${res.raw}`.toLowerCase();

    // Object already exists → retry with a new key + upsert
    if (lower.includes("already exists") || lower.includes("duplicate") || lower.includes("resource already")) {
      fileName = `${safeUUID()}${sanitizeExt(file.name)}`;
      res = await putObject(bucket, fileName, file, true, true, onProgress);
    }
    // Bucket restricts mime types → retry letting Storage infer the type
    else if (lower.includes("mime") || lower.includes("content type")) {
      res = await putObject(bucket, fileName, file, true, false, onProgress);
    }
    // Bucket missing → fall back to the other public bucket
    else if (lower.includes("bucket not found") || lower.includes("bucket") && lower.includes("not found")) {
      const fallback = bucket === "media" ? "uploads" : "media";
      const alt = await putObject(fallback, fileName, file, true, true, onProgress);
      if (alt.ok) {
        const { data } = supabase.storage.from(fallback).getPublicUrl(fileName);
        return data.publicUrl;
      }
    }
    // Invalid key → sanitize aggressively
    else if (lower.includes("invalid key") || lower.includes("invalidkey")) {
      fileName = `${safeUUID()}`;
      res = await putObject(bucket, fileName, file, true, true, onProgress);
    }
  }

  if (!res.ok) {
    let detail = res.message || res.raw.slice(0, 300);
    if (res.status === 413) {
      detail = `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Le proxy nginx limite la taille — redéployez l'application pour appliquer la nouvelle limite (1 Go).`;
    } else if (res.status === 400) {
      detail = `${detail || "Requête refusée par Storage"} — bucket "${bucket}". Lancez « Réparer les buckets Storage » dans /admin/backup (création des buckets, limite 1 Go, policies anon/authenticated), puis réessayez.`;
    } else if (res.status === 401 || res.status === 403) {
      detail = `Storage refuse l'authentification (HTTP ${res.status}). Vérifiez que vous êtes connecté et que le bucket "${bucket}" autorise l'insertion. ${detail}`;
    } else if (res.status === 0) {
      detail = `Aucune réponse du serveur. Vérifiez que le service Storage tourne (docker compose ps storage) et que nginx proxie /storage/v1/.`;
    } else if (res.status === 502 || res.status === 503 || res.status === 504) {
      detail = `Service Storage indisponible (HTTP ${res.status}). Redémarrez : docker compose restart storage rest kong. ${detail}`;
    }
    throw new Error(`Upload échoué (HTTP ${res.status}) — ${detail}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}


export function getMediaType(file: File): 'image' | 'video' {
  return file.type.startsWith('video') ? 'video' : 'image';
}
