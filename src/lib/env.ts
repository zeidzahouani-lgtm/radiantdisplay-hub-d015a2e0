type EnvCheck = {
  name: string;
  value?: string;
  required: boolean;
  ok: boolean;
  hint: string;
};

const rawEnv = import.meta.env as Record<string, string | undefined>;
const SAME_ORIGIN_SUPABASE_MARKERS = new Set([
  "__SCREENFLOW_SAME_ORIGIN__",
  "same-origin",
  "runtime:same-origin",
]);

function clean(value?: string) {
  return (value || "").trim();
}

export const appEnv = {
  supabaseUrl: clean(import.meta.env.VITE_SUPABASE_URL),
  supabasePublishableKey: clean(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY),
  supabaseProjectId: clean(import.meta.env.VITE_SUPABASE_PROJECT_ID),
  databaseUrl: clean(import.meta.env.DATABASE_URL),
  publicAppUrl: clean(import.meta.env.VITE_PUBLIC_APP_URL),
  appBasePath: clean(import.meta.env.VITE_APP_BASE_PATH) || "/",
};

function getRuntimeOrigin() {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.replace(/\/$/, "");
  }
  return "";
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function isSameOriginSupabaseMarker(value: string) {
  return SAME_ORIGIN_SUPABASE_MARKERS.has(value.trim().toLowerCase()) || SAME_ORIGIN_SUPABASE_MARKERS.has(value.trim());
}

function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLocalNetworkHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return true;
  if (/^127\./.test(host) || /^169\.254\./.test(host) || host === "0.0.0.0") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (host === "::1" || /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,2})\./);
  if (match172) {
    const second = Number.parseInt(match172[1], 10);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * Hôte d'un projet Supabase managé (cloud). Dans ce cas seulement, l'URL
 * buildée doit être utilisée telle quelle : il n'existe pas de proxy same-origin.
 */
function isManagedSupabaseHost(hostname: string) {
  return /(^|\.)supabase\.(co|in|net)$/.test(hostname);
}

function shouldUseRuntimeOrigin(configuredUrl: string) {
  if (isSameOriginSupabaseMarker(configuredUrl)) return true;
  const runtimeOrigin = getRuntimeOrigin();
  if (!runtimeOrigin) return false;
  // A self-hosted build always exposes Auth/REST/Storage/Realtime through the
  // web app's same-origin Nginx proxy. Comparing hostnames is insufficient:
  // with NAT, the configured URL may contain the internal port while the WAN
  // browser reaches the same host on port 80/443. In that case direct XHR
  // uploads were sent to the unreachable internal port. Keep the complete
  // browser origin (scheme + host + effective port) for LAN, WAN and localhost.
  if (appEnv.supabaseProjectId === "local") return true;
  const runtimeHost = hostnameFromUrl(runtimeOrigin);
  const configuredHost = hostnameFromUrl(configuredUrl);
  if (!runtimeHost || runtimeHost === configuredHost) return false;
  // Déploiement auto-hébergé : l'app est servie par le proxy Nginx qui expose
  // /auth /rest /storage /realtime sur la MÊME origine. On ignore donc l'URL
  // buildée (LAN comme WAN : IP publique, DNS dynamique ou port différent),
  // sinon les appels partent vers un hôte injoignable depuis le navigateur.
  if (!isManagedSupabaseHost(configuredHost)) return true;
  return isLocalNetworkHostname(runtimeHost);
}



export function getSupabaseUrl() {
  const configured = appEnv.supabaseUrl;
  if (shouldUseRuntimeOrigin(configured)) {
    return getRuntimeOrigin() || "http://localhost:8000";
  }
  return normalizeUrl(configured) || getRuntimeOrigin() || "http://localhost:8000";
}

export function getSupabasePublishableKey() {
  return appEnv.supabasePublishableKey || "missing-publishable-key-please-check-env";
}

export function supabaseEndpoint(path: string) {
  const base = getSupabaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * Base path de l'application (utile si servie sous un sous-chemin, ex: /app).
 * Utilisé comme `basename` du BrowserRouter.
 */
export function getAppBasePath() {
  const raw = appEnv.appBasePath || "/";
  if (raw === "/") return "";
  return ("/" + raw.replace(/^\/+|\/+$/g, "")) || "";
}

/**
 * URL publique absolue de l'application (origin + base path).
 * Priorité :
 *   1. VITE_PUBLIC_APP_URL (build-time, recommandé en prod / déploiement distant)
 *   2. window.location.origin (runtime fallback navigateur)
 */
export function getPublicAppUrl() {
  const runtimeOrigin = getRuntimeOrigin();
  const runtimeHost = hostnameFromUrl(runtimeOrigin);
  const configuredHost = hostnameFromUrl(appEnv.publicAppUrl);

  // L'origine réellement utilisée par le navigateur est toujours joignable
  // (LAN, IP publique, DNS dynamique, port personnalisé). On la privilégie,
  // sauf sur l'aperçu Lovable où l'URL publique configurée reste la référence.
  const isLovablePreview = /(^|\.)lovable(project)?\.(app|dev)$/.test(runtimeHost);
  if (runtimeOrigin && !isLovablePreview && runtimeHost !== configuredHost) {
    return runtimeOrigin;
  }

  if (appEnv.publicAppUrl) {
    return normalizeUrl(appEnv.publicAppUrl);
  }
  if (runtimeOrigin) {
    return runtimeOrigin;
  }
  return "";
}


/**
 * Construit une URL absolue côté app (ex: pour QR codes, liens player).
 */
export function buildAppUrl(path: string) {
  const origin = getPublicAppUrl();
  const base = getAppBasePath();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  return `${origin}${prefix}${normalizedPath}`;
}

export function getLocalEnvChecks(): EnvCheck[] {
  const url = appEnv.supabaseUrl;
  const resolvedUrl = getSupabaseUrl();
  const key = appEnv.supabasePublishableKey;

  return [
    {
      name: "VITE_SUPABASE_URL",
      value: isSameOriginSupabaseMarker(url) ? `${url} → ${resolvedUrl || "origin navigateur"}` : url,
      required: true,
      ok: isSameOriginSupabaseMarker(url) || /^https?:\/\/.+/.test(resolvedUrl),
      hint: "Doit pointer vers l'API backend accessible par le navigateur local, ou utiliser __SCREENFLOW_SAME_ORIGIN__ pour le proxy local/distant.",
    },
    {
      name: "VITE_SUPABASE_PUBLISHABLE_KEY",
      value: key,
      required: true,
      ok: key.length > 40 && key.split(".").length === 3,
      hint: "Doit contenir la clé anon/publishable de l'instance Supabase locale.",
    },
    {
      name: "VITE_SUPABASE_PROJECT_ID",
      value: appEnv.supabaseProjectId,
      required: false,
      ok: !appEnv.supabaseProjectId || appEnv.supabaseProjectId.length >= 3,
      hint: "Optionnel en local; utilisez local ou l'identifiant du projet.",
    },
    {
      name: "DATABASE_URL",
      value: appEnv.databaseUrl,
      required: false,
      ok: !appEnv.databaseUrl || /^postgres(?:ql)?:\/\/.+/.test(appEnv.databaseUrl),
      hint: "Utilisé uniquement par les scripts/CLI serveur, jamais par le frontend Vite.",
    },
  ];
}

export function validateLocalEnvironment() {
  const failed = getLocalEnvChecks().filter((check) => check.required && !check.ok);
  if (failed.length === 0) return;

  const message = [
    "Configuration backend locale invalide.",
    ...failed.map((check) => `- ${check.name}: ${check.hint}`),
    "Créez .env.local depuis .env.example puis rebuild l'application.",
  ].join("\n");

  console.error("[local-env]", message, getLocalEnvChecks().map(({ name, ok, required, hint }) => ({ name, ok, required, hint })));
  throw new Error(message);
}

export function logLocalEnvironmentDiagnostics() {
  const checks = getLocalEnvChecks().map(({ name, value, ok, required, hint }) => ({
    name,
    present: Boolean(value),
    ok,
    required,
    hint,
  }));
  console.info("[local-env] Configuration frontend", checks);
  console.info("[local-env] Endpoints attendus", {
    rest: supabaseEndpoint("/rest/v1/"),
    storage: supabaseEndpoint("/storage/v1/"),
    functions: supabaseEndpoint("/functions/v1/"),
    realtime: supabaseEndpoint("/realtime/v1/"),
  });
}

export function explainSupabaseError(error: unknown, context = "Supabase") {
  const anyError = error as { message?: string; code?: string; details?: string; hint?: string; status?: number } | null;
  const message = anyError?.message || String(error || "Erreur inconnue");
  const lower = message.toLowerCase();

  // Try to extract HTTP status from messages like "Upload échoué (HTTP 413) — ..."
  const httpMatch = message.match(/HTTP\s+(\d{3})/i);
  const httpStatus = anyError?.status || (httpMatch ? parseInt(httpMatch[1], 10) : undefined);

  let cause = "Erreur backend non classée";
  let action = message.length > 0 ? message.slice(0, 400) : "Ouvrez la console réseau et vérifiez l'URL appelée, le statut HTTP et la réponse JSON.";

  // PGRST301 / "wrong key type" → JWT signé par une instance Supabase différente (token périmé après redéploiement local)
  if (anyError?.code === "PGRST301" || lower.includes("no suitable key") || lower.includes("wrong key type") || lower.includes("decode the jwt")) {
    cause = "Session expirée (clés JWT renouvelées par le serveur)";
    action = "Votre session a été émise par un ancien déploiement. Déconnexion automatique en cours, reconnectez-vous.";
    try {
      // Purge the stale Supabase session from localStorage and force a clean reload
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith("sb-") || k.includes("supabase.auth")) localStorage.removeItem(k);
      });
      setTimeout(() => { window.location.href = buildAppUrl("/login"); }, 1500);
    } catch {}
  }

  else if (lower.includes("err_cert_authority_invalid") || lower.includes("cert_authority_invalid") || lower.includes("certificate")) {
    cause = "Certificat HTTPS local non reconnu";
    action = "Le navigateur bloque l'API locale avant CORS/RLS. Relancez la réparation SSH : elle rebascule l'API navigateur en HTTP local et désactive la redirection HTTPS auto-signée.";
  } else if (httpStatus === 413 || lower.includes("trop volumineux") || lower.includes("payload too large")) {
    cause = "Fichier trop volumineux (limite proxy)";
    action = "Le proxy nginx limite la taille d'upload. Dans /admin/backup, lancez le bouton « Corriger uploads sans redéploiement », ou réduisez le fichier.";
  } else if (httpStatus === 400 && (lower.includes("storage") || lower.includes("bucket") || lower.includes("mime") || lower.includes("upload"))) {
    cause = "Configuration Storage locale invalide";
    action = "Dans /admin/backup, lancez « Corriger uploads sans redéploiement » pour recréer les buckets, retirer les restrictions MIME, réparer les policies et recharger le proxy.";
  } else if (httpStatus === 404 && (lower.includes("bucket") || lower.includes("media"))) {
    cause = "Bucket Storage 'media' introuvable";
    action = "Le bucket média n'existe pas sur l'instance locale. Dans /admin/backup, lancez « Corriger uploads sans redéploiement ».";
  } else if (httpStatus === 0 || lower.includes("réseau/cors") || lower.includes("aucune réponse")) {
    cause = "Backend Storage injoignable";
    action = "Le service Storage ne répond pas. Dans /admin/backup, lancez « Corriger uploads sans redéploiement » pour vérifier Storage/Kong et recharger /storage/v1/.";
  } else if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    cause = `Service Storage indisponible (HTTP ${httpStatus})`;
    action = "Redémarrez les conteneurs : docker compose restart storage rest kong.";
  } else if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("network error")) {
    cause = "Erreur réseau ou CORS";
    action = "Le pré-vol CORS ou le proxy backend bloque la requête. Dans /admin/backup, lancez « Corriger uploads sans redéploiement ».";
  } else if (lower.includes("invalid api key") || lower.includes("jwt") || httpStatus === 401 || httpStatus === 403) {
    cause = "Clé Supabase invalide ou permission/RLS refusée";
    action = "Vérifiez VITE_SUPABASE_PUBLISHABLE_KEY, ANON_KEY côté serveur et les politiques RLS appliquées par les migrations.";
  } else if (lower.includes("does not exist") || anyError?.code === "42P01" || anyError?.code === "42703") {
    cause = "Table ou colonne absente";
    action = "Appliquez toutes les migrations de supabase/migrations dans l'ordre chronologique sur la base locale.";
  } else if (lower.includes("row-level security") || lower.includes("violates row-level security")) {
    cause = "Erreur RLS / permission";
    action = "Vérifiez que les migrations du mode public local sont appliquées et que le rôle anon possède les politiques attendues.";
  } else if (lower.includes("cors")) {
    cause = "Erreur CORS";
    action = "Relancez le déploiement SSH pour appliquer les headers Access-Control-Allow-* sur /rest/v1 et /storage/v1.";
  }

  console.error(`[db-diagnostic] ${context}: ${cause}`, {
    message,
    code: anyError?.code,
    details: anyError?.details,
    hint: anyError?.hint,
    status: anyError?.status,
    action,
    supabaseUrl: getSupabaseUrl() || appEnv.supabaseUrl || "missing",
  });

  return { cause, action, message };
}
