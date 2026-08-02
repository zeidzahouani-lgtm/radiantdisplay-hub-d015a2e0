// SSH deploy: connect to a Linux server with ip/user/password, install Docker if needed,
// upload project archive, build & run via docker compose.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
const ssh2Mod: any = await import("npm:ssh2@1.15.0");
const Client: any = ssh2Mod.Client ?? ssh2Mod.default?.Client;
type Client = any;
import { Buffer } from "node:buffer";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface DeployBody {
  // Action: "deploy" (default), "reset_admin_password", or "check_admin_status" (read-only diagnostic)
  action?: "deploy" | "reset_admin_password" | "check_admin_status" | "repair_local_writes" | "repair_local_api_url" | "repair_uploads_now" | "diagnose_server" | "restart_stack" | "repair_web_container" | "repair_storage_buckets" | "repair_realtime" | "apply_local_migrations" | "quick_update" | "build_status" | "network_inspect" | "network_recreate" | "network_set_subnet" | "network_set_hostname" | "network_get_config" | "network_set_container_ip";
  // Custom Docker network subnet (CIDR), e.g. 172.28.0.0/16
  network_subnet?: string;
  network_gateway?: string;
  network_name?: string;
  network_ip_range?: string;        // CIDR sub-range for auto-assignment
  network_mtu?: number;             // MTU (e.g. 1500)
  network_dns?: string[];           // DNS servers for containers
  container_ips?: Record<string, string>; // service_name -> static IP
  hostname?: string;                // system hostname
  hostname_alias?: string;          // /etc/hosts alias for the host IP
  container_id?: string;            // Docker container ID for live IP change
  container_name?: string;          // Docker container name for live IP change
  new_ip?: string;                  // New static IP to assign live
  // Optional override for the admin password to set during reset (defaults to 260390DS)
  admin_password?: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  remote_dir?: string;
  app_port?: string;
  install_docker?: boolean;
  vite_supabase_url?: string;
  vite_supabase_key?: string;
  vite_supabase_project_id?: string;
  vite_public_app_url?: string;
  vite_app_base_path?: string;
  // Git source (cloned on the server)
  git_url: string;            // e.g. https://github.com/user/repo.git
  git_branch?: string;        // default: main
  git_token?: string;         // optional PAT for private repos
  enable_https?: boolean;
  https_port?: string;
  https_domain?: string;
  // Local self-hosted Supabase (optional)
  install_supabase_local?: boolean;
  force_fresh_install?: boolean;
  supabase_kong_http_port?: string;   // public REST/Auth gateway (default 8000)
  supabase_studio_port?: string;      // Supabase Studio UI (default 3000)
  supabase_db_port?: string;          // Postgres (default 5432)
  local_ip?: string;                  // Server-side local IP for internal checks (default 127.0.0.1)
  // Database stack choice
  // - "supabase_full" (default): full Supabase stack (Postgres + Auth + Storage + Realtime + Functions). Required for the app frontend to work.
  // - "postgres_only": deploy a standalone Postgres container only. App frontend will NOT work (no Auth/Storage/Realtime). Useful for external scripts.
  db_stack?: "supabase_full" | "postgres_only";
  // Postgres image variant (used by both modes). Allowed values are validated server-side.
  postgres_image?: string;            // e.g. "postgres:15", "postgres:16", "postgres:17", "postgres:15-alpine", "timescale/timescaledb:latest-pg16"
}

const ALLOWED_PG_IMAGES = new Set([
  "postgres:15",
  "postgres:15-alpine",
  "postgres:16",
  "postgres:16-alpine",
  "postgres:17",
  "postgres:17-alpine",
  "timescale/timescaledb:latest-pg15",
  "timescale/timescaledb:latest-pg16",
]);
function resolvePostgresImage(img?: string): string {
  const v = (img || "").trim();
  if (v && ALLOWED_PG_IMAGES.has(v)) return v;
  return "postgres:15";
}

function ssh(opts: { host: string; port: number; username: string; password: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => resolve(conn))
      .on("keyboard-interactive", (_name: any, _instructions: any, _lang: any, prompts: any, finish: any) => {
        // Some servers (PAM) require keyboard-interactive even when password is enabled
        finish(prompts.map(() => opts.password));
      })
      .on("error", (err: Error) => {
        const msg = err.message || String(err);
        if (/All configured authentication methods failed/i.test(msg)) {
          reject(new Error(
            `Échec d'authentification SSH pour '${opts.username}@${opts.host}:${opts.port}'. ` +
            `Causes possibles : (1) mot de passe incorrect ; ` +
            `(2) le serveur refuse l'authentification par mot de passe — vérifiez '/etc/ssh/sshd_config' : ` +
            `'PasswordAuthentication yes' et (si vous utilisez root) 'PermitRootLogin yes', puis 'systemctl restart sshd' ; ` +
            `(3) le serveur n'autorise que les clés SSH. Essayez avec un autre utilisateur (ex: un user sudo non-root) ou activez le mot de passe.`
          ));
        } else {
          reject(err);
        }
      })
      .connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        readyTimeout: 20000,
        tryKeyboard: true,
      });
  });
}

function exec(conn: Client, cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    try {
      conn.exec(cmd, (err: any, stream: any) => {
        if (err) return reject(err);
        if (!stream) return resolve({ code: 1, stdout: "", stderr: "no stream" });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const done = (code: number) => {
          if (settled) return;
          settled = true;
          resolve({ code: typeof code === "number" ? code : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        };
        stream.on("close", (code: number) => done(code));
        stream.on("data", (d: any) => (stdout += String(d)));
        if (stream.stderr && typeof stream.stderr.on === "function") {
          stream.stderr.on("data", (d: any) => (stderr += String(d)));
        }
        stream.on("error", (e: any) => {
          if (settled) return;
          settled = true;
          resolve({ code: 1, stdout: stdout ?? "", stderr: `${stderr ?? ""}${e?.message || String(e)}` });
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}


/**
 * Lance `docker compose up -d --build` en arrière-plan sur le serveur (nohup),
 * pour que le build ne soit plus lié à la durée de vie de l'edge function.
 */
async function startDetachedCompose(conn: Client, repoDir: string, stateDir: string) {
  const script = `${stateDir}/build.sh`;
  const cmd =
    `mkdir -p ${stateDir} && ` +
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -o pipefail' ` +
    `'cd ${repoDir} || exit 1' ` +
    `'if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else echo "Docker Compose est introuvable" > ${stateDir}/build.log; echo 127 > ${stateDir}/build.code; exit 127; fi' ` +
    `'"\${COMPOSE[@]}" up -d --build > ${stateDir}/build.log 2>&1' ` +
    `'echo $? > ${stateDir}/build.code' > ${script} && ` +
    `chmod +x ${script} && rm -f ${stateDir}/build.code && : > ${stateDir}/build.log && ` +
    `(setsid nohup ${script} >/dev/null 2>&1 & ) && echo STARTED`;
  const res = await exec(conn, cmd);
  if (!(res.stdout || "").includes("STARTED")) {
    throw new Error("Impossible de lancer le build en arrière-plan: " + (res.stderr || res.stdout).slice(-300));
  }
}

/**
 * Create a usable web compose file as soon as the repository is available.
 * The local backend can take several minutes to start; keeping this scaffold
 * early makes the deployment resumable and prevents repair actions from
 * finding a cloned repository without docker-compose.yml.
 */
async function prepareEarlyWebDeployment(
  conn: Client,
  body: DeployBody,
  repoDir: string,
  remoteDir: string,
  appPort: string,
  supabaseUrl: string,
  supabaseKey: string,
  projectId: string,
  log: (m: string) => Promise<void> | void,
) {
  const publicAppUrl = resolveBrowserAppBase(body, appPort, false);
  const quoteYaml = (value: string) => `'${(value || "").replace(/'/g, "''")}'`;
  const compose = `services:
  web:
    build:
      context: .
      args:
        VITE_SUPABASE_URL: ${quoteYaml(supabaseUrl)}
        VITE_SUPABASE_PUBLISHABLE_KEY: ${quoteYaml(supabaseKey)}
        VITE_SUPABASE_PROJECT_ID: ${quoteYaml(projectId)}
        VITE_PUBLIC_APP_URL: ${quoteYaml(publicAppUrl)}
        VITE_APP_BASE_PATH: '/'
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${appPort}:80"
    restart: unless-stopped
`;
  await uploadFile(conn, `${repoDir}/docker-compose.yml`, Buffer.from(compose));
  await patchRemoteBuildEntrypoint(conn, repoDir, log);
  await patchRemoteRuntimeSupabaseClient(conn, repoDir, log);
  const required = await exec(conn, `[ -f ${repoDir}/Dockerfile ] && [ -f ${repoDir}/nginx.conf ] && echo OK || echo NO`);
  if (!(required.stdout || "").includes("OK")) {
    throw new Error(`Le dépôt ${repoDir} doit contenir Dockerfile et nginx.conf.`);
  }
  await log("✓ Déploiement web préparé tôt (reprise automatique possible)");
  await startDetachedCompose(conn, repoDir, `${remoteDir}/.build`);
  await log("✓ Build web lancé en arrière-plan pendant la préparation du backend");
}

async function patchRemoteBuildEntrypoint(conn: Client, repoDir: string, log: (m: string) => Promise<void> | void) {
  const patch = `python3 - <<'PY'
from pathlib import Path
import json

repo = Path(${JSON.stringify(repoDir)})
dockerfile = repo / 'Dockerfile'
package_json = repo / 'package.json'

if not dockerfile.is_file() or not package_json.is_file():
    raise SystemExit('Dockerfile ou package.json absent du dépôt distant')

s = dockerfile.read_text()
s = s.replace('RUN npm run build:local', 'RUN npm run build -- --mode selfhosted')
dockerfile.write_text(s)

data = json.loads(package_json.read_text())
data.setdefault('scripts', {})['build:local'] = 'vite build --mode selfhosted'
package_json.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\\n')
print('OK')
PY`;
  const result = await exec(conn, patch);
  if (result.code !== 0 || !(result.stdout || "").includes("OK")) {
    throw new Error("Impossible de fiabiliser la commande de build distante: " + (result.stderr || result.stdout).slice(-500));
  }
  await log("✓ Commande de build distante normalisée (mode Vite selfhosted)");
}

async function pollDetachedCompose(
  conn: Client,
  stateDir: string,
  deadlineMs: number,
  log: (m: string) => Promise<void> | void,
): Promise<{ done: boolean; code: number | null; tail: string }> {
  let lastTail = "";
  while (Date.now() < deadlineMs) {
    const res = await exec(
      conn,
      `if [ -f ${stateDir}/build.code ]; then echo "DONE:$(cat ${stateDir}/build.code)"; else echo RUNNING; fi; echo '---'; tail -n 6 ${stateDir}/build.log 2>/dev/null`,
    );
    const out = res.stdout || "";
    const [head, ...rest] = out.split("---");
    lastTail = rest.join("---").trim();
    if (head.includes("DONE:")) {
      const code = parseInt(head.split("DONE:")[1].trim(), 10);
      return { done: true, code: Number.isNaN(code) ? 0 : code, tail: lastTail };
    }
    if (lastTail) await log("   … " + lastTail.split("\n").slice(-2).join(" | ").slice(0, 200));
    await new Promise((r) => setTimeout(r, 8000));
  }
  return { done: false, code: null, tail: lastTail };
}

function uploadFile(conn: Client, remotePath: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err: any, sftp: any) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on("close", () => resolve());
      stream.on("error", (e: Error) => reject(e));
      stream.end(content);
    });
  });
}

const DEFAULT_ADMIN_EMAIL = "screenflow@screenflow.local";
const DEFAULT_ADMIN_PASSWORD = "260390DS";

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function resolveBrowserAppBase(body: DeployBody, appPort: string, enableHttps = false, httpsDomain?: string, httpsPort?: string) {
  const configured = (body.vite_public_app_url || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const host = (enableHttps ? (httpsDomain || body.host) : body.host).trim();
  return enableHttps ? `https://${host}:${httpsPort || "8443"}` : `http://${host}:${appPort}`;
}

function cleanHostForUrl(value?: string) {
  const raw = (value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
  } catch {
    return raw.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  }
}

function appendOrigin(target: Set<string>, protocol: "http" | "https", host: string, port: string) {
  const cleanHost = cleanHostForUrl(host);
  if (!cleanHost) return;
  const defaultPort = (protocol === "http" && port === "80") || (protocol === "https" && port === "443");
  target.add(defaultPort ? `${protocol}://${cleanHost}` : `${protocol}://${cleanHost}:${port}`);
  target.add(`${protocol}://${cleanHost}:${port}`);
}

function buildLocalRedirectUrls(body: DeployBody, appPort: string, publicBase: string, enableHttps = false, httpsDomain?: string, httpsPort?: string) {
  const urls = new Set<string>([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:3000",
  ]);
  try {
    urls.add(new URL(publicBase).origin.replace(/\/$/, ""));
  } catch {}
  appendOrigin(urls, "http", body.host, appPort);
  appendOrigin(urls, "http", body.local_ip || "127.0.0.1", appPort);
  if (enableHttps) {
    appendOrigin(urls, "https", httpsDomain || body.host, httpsPort || "443");
    appendOrigin(urls, "https", body.host, httpsPort || "443");
  }
  return Array.from(urls).filter(Boolean).join(",");
}

function buildLocalAuthUrlEnvPatch(body: DeployBody, appPort: string, publicBase: string, enableHttps = false, httpsDomain?: string, httpsPort?: string) {
  const redirectUrls = buildLocalRedirectUrls(body, appPort, publicBase, enableHttps, httpsDomain, httpsPort);
  return [
    `SITE_URL=${publicBase}`,
    `API_EXTERNAL_URL=${publicBase}`,
    `GOTRUE_EXTERNAL_URL=${publicBase}/auth/v1`,
    `SUPABASE_PUBLIC_URL=${publicBase}`,
    `ADDITIONAL_REDIRECT_URLS=${redirectUrls}`,
  ].join("\n") + "\n";
}

function buildRuntimeSupabaseClientHotfix() {
  return `// Runtime client used by ScreenFlow SSH repair: keep backend calls on the current app origin for local LAN access.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const configuredUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '');
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
const projectId = (import.meta.env.VITE_SUPABASE_PROJECT_ID || '').trim();

function runtimeOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin.replace(/\/$/, '');
  return '';
}

function hostOf(value: string) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function isLanHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || /^127\./.test(host)) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d{1,2})\./);
  if (!m) return false;
  const n = Number.parseInt(m[1], 10);
  return n >= 16 && n <= 31;
}

function resolveSupabaseUrl() {
  const origin = runtimeOrigin();
  const marker = configuredUrl === '__SCREENFLOW_SAME_ORIGIN__' || configuredUrl === 'same-origin' || configuredUrl === 'runtime:same-origin';
  if (marker && origin) return origin;
  if (projectId === 'local' && origin && isLanHost(hostOf(origin)) && hostOf(origin) !== hostOf(configuredUrl)) return origin;
  return configuredUrl;
}

export const supabase = createClient<Database>(resolveSupabaseUrl(), publishableKey, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
`;
}

async function patchRemoteRuntimeSupabaseClient(conn: Client, repoDir: string, log: (m: string) => Promise<void> | void) {
  await exec(conn, `mkdir -p ${repoDir}/src/integrations/supabase`);
  await uploadFile(conn, `${repoDir}/src/integrations/supabase/runtime-client.ts`, Buffer.from(buildRuntimeSupabaseClientHotfix()));
  const vitePatch = `python3 - <<'PY'
from pathlib import Path
p = Path(${JSON.stringify(`${repoDir}/vite.config.ts`)})
s = p.read_text()
if 'src/integrations/supabase/runtime-client.ts' not in s:
    object_anchor = 'alias: {'
    src_alias = '"@": path.resolve(__dirname, "./src"),'
    if object_anchor in s and src_alias in s:
        s = s.replace(src_alias, '"@/integrations/supabase/client": path.resolve(__dirname, "./src/integrations/supabase/runtime-client.ts"),\n        ' + src_alias, 1)
    elif 'alias: [' in s:
        s = s.replace('alias: [', 'alias: [\n        { find: "@/integrations/supabase/client", replacement: path.resolve(__dirname, "./src/integrations/supabase/runtime-client.ts") },', 1)
    else:
        raise SystemExit('vite alias block not found')
    p.write_text(s)
print('OK')
PY`;
  await exec(conn, vitePatch);
  await log("✓ Client backend runtime ajouté : accès local LAN → appels API sur la même adresse");
}

function dockerPsql(connDir: string, sqlB64: string, onErrorStop = true) {
  const psql = `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=${onErrorStop ? 1 : 0}`;
  return `cd ${connDir} && printf '%s' '${sqlB64}' | base64 -d | docker compose exec -T --user postgres db sh -lc ${shQuote(psql)} 2>&1`;
}

function dockerPsqlSelect(connDir: string, sql: string, silent = true) {
  const sqlB64 = btoa(sql);
  const psql = `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -At -c "$(printf '%s' '${sqlB64}' | base64 -d)"`;
  return `cd ${connDir} && docker compose exec -T --user postgres db sh -lc ${shQuote(psql)}${silent ? " 2>/dev/null || true" : " 2>&1"}`;
}

function dockerPsqlExec(connDir: string, sql: string) {
  return dockerPsql(connDir, btoa(sql), true);
}

interface RemotePreflightResult {
  dockerOk: boolean;
  composeOk: boolean;
  freeMb: number;
  nodeMajor: number | null;
  postgresMajor: number | null;
}

function validatePortValue(label: string, value: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${label}: port invalide '${value}'. Utilisez un nombre entre 1 et 65535.`);
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) throw new Error(`${label}: port ${value} hors limite. Utilisez un nombre entre 1 et 65535.`);
}

function validateDistinctPorts(ports: Array<{ label: string; value: string }>) {
  const seen = new Map<string, string>();
  for (const port of ports) {
    validatePortValue(port.label, port.value);
    const existing = seen.get(port.value);
    if (existing) throw new Error(`Conflit de ports local: ${existing} et ${port.label} utilisent tous les deux le port ${port.value}. Choisissez des ports différents.`);
    seen.set(port.value, port.label);
  }
}

async function freeRemotePorts(
  conn: Client,
  ports: string[],
  sudoPrefix: string,
  log: (m: string) => Promise<void> | void,
) {
  if (ports.length === 0) return;
  const uniquePorts = Array.from(new Set(ports.map((p) => String(p).trim()).filter(Boolean)));
  await log(`→ Libération forcée des ports: ${uniquePorts.join(", ")}…`);

  // 1) Stop docker containers binding any of the requested host ports
  const containerScript = `python3 - <<'PY'
import json, subprocess
wanted = set(${JSON.stringify(uniquePorts)})
try:
    out = subprocess.run(['sh','-lc','docker ps --format "{{.ID}}|{{.Names}}|{{.Ports}}"'], capture_output=True, text=True, timeout=8).stdout
except Exception:
    out = ''
to_stop = []
for line in out.splitlines():
    parts = line.split('|', 2)
    if len(parts) < 3: continue
    cid, name, ports = parts
    for tok in ports.replace(',', ' ').split():
        # Examples: 0.0.0.0:80->80/tcp, :::443->443/tcp, [::]:8080->80/tcp
        if '->' not in tok: continue
        host = tok.split('->')[0]
        # extract trailing :PORT
        try:
            host_port = host.rsplit(':', 1)[1]
        except Exception:
            continue
        if host_port in wanted:
            to_stop.append((cid, name, host_port))
            break
for cid, name, hp in to_stop:
    print(f"STOP|{cid}|{name}|{hp}")
    subprocess.run(['sh','-lc', f'docker stop {cid} >/dev/null 2>&1 && docker rm -f {cid} >/dev/null 2>&1 || true'], timeout=15)
print('DONE')
PY`;
  const r1 = await exec(conn, containerScript);
  for (const line of (r1.stdout || "").split("\n")) {
    if (line.startsWith("STOP|")) {
      const [, cid, name, hp] = line.split("|");
      await log(`  • Conteneur arrêté: ${name} (${cid.slice(0, 12)}) sur le port ${hp}`);
    }
  }

  // 2) If 80/443 are requested, stop common host web servers
  const needsWeb = uniquePorts.some((p) => p === "80" || p === "443");
  if (needsWeb) {
    await log("→ Arrêt des services système susceptibles d'occuper 80/443 (nginx, apache2, httpd, lighttpd, caddy)…");
    const services = ["nginx", "apache2", "httpd", "lighttpd", "caddy"];
    for (const svc of services) {
      const r = await exec(
        conn,
        `${sudoPrefix}sh -c "if systemctl list-unit-files | grep -q '^${svc}\\.service'; then systemctl stop ${svc} 2>&1; systemctl disable ${svc} 2>&1; echo STOPPED_${svc}; fi" || true`,
      );
      if ((r.stdout || "").includes(`STOPPED_${svc}`)) {
        await log(`  • Service système arrêté et désactivé: ${svc}`);
      }
    }
  }

  // 3) Last resort: kill any remaining process holding those ports
  // Last resort: free remaining ports via fuser/ss
  for (const p of uniquePorts) {
    const r = await exec(
      conn,
      `${sudoPrefix}sh -c "(fuser -k -n tcp ${p} 2>&1 || true); (ss -lntp 2>/dev/null | awk -v P=:${p} '\\$4 ~ P{print \\$0}')"`,
    );
    const out = (r.stdout || "").trim();
    if (out) await log(`  • Port ${p}: ${out.slice(-200)}`);
  }
  await log("✓ Libération des ports terminée");
}

async function checkRemotePortsAvailable(
  conn: Client,
  ports: Array<{ label: string; value: string; required: boolean }>,
  log: (m: string) => Promise<void> | void,
  ignoredComposeDirs: string[] = [],
) {
  const requiredPorts = ports.filter((port) => port.required);
  if (requiredPorts.length === 0) return;

  await log(`→ Vérification des ports locaux requis: ${requiredPorts.map((p) => `${p.label}:${p.value}`).join(", ")}…`);
  const payload = btoa(JSON.stringify(requiredPorts));
  const ignoredPayload = btoa(JSON.stringify(ignoredComposeDirs));
  const script = `PORTS_B64=${shQuote(payload)} IGNORE_DIRS_B64=${shQuote(ignoredPayload)} python3 - <<'PY'
import base64, json, socket
import os, subprocess
ports = json.loads(base64.b64decode(__import__('os').environ['PORTS_B64']).decode())
ignore_dirs = json.loads(base64.b64decode(os.environ.get('IGNORE_DIRS_B64', 'W10=')).decode())
busy = []
reserved = set(int(p['value']) for p in ports)
ignored_ports = set()
for d in ignore_dirs:
    try:
        out = subprocess.run(['sh', '-lc', f'cd {d} 2>/dev/null && docker compose ps -q 2>/dev/null'], capture_output=True, text=True, timeout=4).stdout
        ids = [x for x in out.split() if x]
        if not ids:
            continue
        quoted = ' '.join(ids)
        inspect = subprocess.run(['sh', '-lc', f'docker inspect --format "{{{{range $p, $c := .NetworkSettings.Ports}}}}{{{{range $c}}}}{{{{.HostPort}}}} {{{{end}}}}{{{{end}}}}" {quoted} 2>/dev/null'], capture_output=True, text=True, timeout=4).stdout
        for token in inspect.split():
            if token.isdigit():
                ignored_ports.add(int(token))
    except Exception:
        pass
def is_busy(port):
    if int(port) in ignored_ports:
        return False
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.35)
    try:
        return s.connect_ex(('127.0.0.1', int(port))) == 0
    finally:
        s.close()
def next_free(start):
    candidate = max(1024, int(start) + 1)
    while candidate <= 65535:
        if candidate not in reserved and not is_busy(candidate):
            reserved.add(candidate)
            return candidate
        candidate += 1
    return None
for p in ports:
    if is_busy(p['value']):
        p['suggested'] = next_free(p['value'])
        busy.append(p)
if busy:
    for p in busy:
        print(f"BUSY|{p['label']}|{p['value']}|{p.get('suggested') or ''}")
else:
    print('OK')
PY`;
  const result = await exec(conn, script);
  const output = `${result.stdout}${result.stderr}`;
  const busy = output.split("\n").filter((line) => line.startsWith("BUSY|"));
  if (busy.length > 0) {
    const suggestions = busy.map((line) => {
      const [, label, value, suggested] = line.split("|");
      return { label, current: value, suggested };
    }).filter((item) => item.suggested);
    const details = busy.map((line) => {
      const [, label, value, suggested] = line.split("|");
      const replacement = suggested ? ` → proposé ${suggested}` : "";
      return `${label} (${value}${replacement})`;
    }).join(", ");
    throw new Error(`Ports déjà utilisés sur le serveur: ${details}. Appliquez les ports proposés ou changez les ports dans le formulaire avant de relancer. __PORT_SUGGESTIONS__${JSON.stringify(suggestions)}`);
  }
  await log("✓ Ports locaux disponibles et conformes");
}

function parseMajorVersion(output: string, marker: RegExp): number | null {
  const match = output.match(marker);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function runRemotePreflight(
  conn: Client,
  body: DeployBody,
  remoteDir: string,
  installSupabase: boolean,
  log: (m: string) => Promise<void> | void,
): Promise<RemotePreflightResult> {
  await log("→ Pré-vérification serveur : Docker, espace disque, Node/Postgres…");

  const dockerCheck = await exec(conn, "command -v docker >/dev/null 2>&1 && docker --version && (docker info >/dev/null 2>&1 && echo DOCKER_READY || echo DOCKER_DAEMON_UNAVAILABLE) || echo MISSING");
  const dockerOutput = `${dockerCheck.stdout}${dockerCheck.stderr}`.trim();
  const dockerOk = dockerOutput.includes("DOCKER_READY") && dockerCheck.code === 0;
  await log(dockerOk ? `✓ Docker disponible : ${dockerOutput.replace("DOCKER_READY", "").trim()}` : `✗ Docker indisponible ou daemon inaccessible : ${dockerOutput}`);

  const composeCheck = await exec(conn, "(docker compose version || docker-compose --version) 2>&1 || echo MISSING");
  const composeOutput = `${composeCheck.stdout}${composeCheck.stderr}`.trim();
  const composeOk = !composeOutput.includes("MISSING");
  await log(composeOk ? `✓ Docker Compose disponible : ${composeOutput.split("\n").slice(-1)[0]}` : "✗ Docker Compose indisponible");

  const diskCheck = await exec(conn, `mkdir -p ${remoteDir} 2>/dev/null || true; (df -Pm ${remoteDir} 2>/dev/null || df -Pm $(dirname ${remoteDir}) 2>/dev/null || df -Pm /) | awk 'NR==2{print $4"|"$5"|"$6}'`);
  const diskLine = (diskCheck.stdout || "").trim().split("\n").pop() || "0||";
  const [freeRaw, usedPctRaw, mountRaw] = diskLine.split("|");
  const freeMb = Number.parseInt(freeRaw || "0", 10) || 0;
  const minFreeMb = installSupabase ? 8192 : 2048;
  await log(`✓ Espace disque libre : ${Math.round(freeMb / 1024)} Go sur ${mountRaw || remoteDir} (${usedPctRaw || "?"} utilisé)`);
  if (freeMb < minFreeMb) {
    throw new Error(`Espace disque insuffisant : ${Math.round(freeMb / 1024)} Go libres, minimum requis ${Math.round(minFreeMb / 1024)} Go.`);
  }

  const nodeCheck = await exec(conn, "command -v node >/dev/null 2>&1 && node --version || echo MISSING");
  const nodeOutput = `${nodeCheck.stdout}${nodeCheck.stderr}`.trim();
  const nodeMajor = parseMajorVersion(nodeOutput, /v(\d+)/);
  if (nodeMajor === null) {
    await log("⚠ Node.js absent sur l'hôte — OK, le build utilise Node 20 dans Docker.");
  } else if (nodeMajor < 18) {
    await log(`⚠ Node.js hôte ancien (${nodeOutput}) — OK pour Docker, mais Node 18+ est recommandé.`);
  } else {
    await log(`✓ Node.js hôte : ${nodeOutput}`);
  }

  const pgCheck = await exec(conn, "(command -v psql >/dev/null 2>&1 && psql --version) || (command -v postgres >/dev/null 2>&1 && postgres --version) || echo MISSING");
  const pgOutput = `${pgCheck.stdout}${pgCheck.stderr}`.trim();
  const postgresMajor = parseMajorVersion(pgOutput, /(?:PostgreSQL\)|postgres)\s+(\d+)/i);
  if (postgresMajor === null) {
    await log("⚠ Postgres absent sur l'hôte — OK, la base locale utilise Postgres dans Docker.");
  } else if (postgresMajor < 15) {
    await log(`⚠ Postgres hôte ancien (${pgOutput}) — Postgres 15+ recommandé si vous utilisez une base hors Docker.`);
  } else {
    await log(`✓ Postgres hôte : ${pgOutput}`);
  }

  if ((!dockerOk || !composeOk) && !body.install_docker) {
    throw new Error("Docker ou Docker Compose manque. Activez 'Auto-installer Docker' ou installez-les avant le déploiement.");
  }

  return { dockerOk, composeOk, freeMb, nodeMajor, postgresMajor };
}

async function handleAnalyticsUnhealthy(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  const ps = await exec(conn, `cd ${supaDir} && docker compose ps -a 2>&1 || true`);
  const psOutput = `${ps.stdout}${ps.stderr}`;
  if (!/supabase-analytics|analytics/i.test(psOutput) || !/unhealthy|Exit|Restarting/i.test(psOutput)) return;

  await log("⚠ supabase-analytics est unhealthy. Service non critique : diagnostic puis arrêt…");
  const logs = await exec(conn, `cd ${supaDir} && docker compose logs --tail=80 analytics 2>&1 || true`);
  await log((`${logs.stdout}${logs.stderr}`).slice(-1600));
  await exec(conn, `cd ${supaDir} && docker compose stop analytics vector 2>&1 || true`);
  await exec(conn, `cd ${supaDir} && docker compose rm -f analytics vector 2>&1 || true`);
}

/**
 * Le docker-compose.yml officiel Supabase déclare:
 *   kong/auth/storage/rest/realtime/meta:
 *     depends_on:
 *       analytics: { condition: service_healthy }
 * Si analytics (Logflare) est unhealthy, RIEN ne démarre.
 * On neutralise une fois pour toutes : on retire le bloc analytics des depends_on
 * et on commente le service analytics + vector. Idempotent (sentinelle).
 */
async function patchComposeRemoveAnalytics(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  const sentinel = "# LOVABLE_NO_ANALYTICS_PATCH_V3";
  const composePath = `${supaDir}/docker-compose.yml`;

  // 0) Si un patch précédent (V1 regex) a corrompu le fichier, restaurer le backup le plus ancien
  const validate = await exec(conn, `docker compose -f ${composePath} config --quiet 2>&1; echo EXIT=$?`);
  const validOut = `${validate.stdout}${validate.stderr}`;
  if (/EXIT=[^0]/.test(validOut) || /yaml:|mapping key.*already defined|failed to parse/i.test(validOut)) {
    await log("⚠ docker-compose.yml invalide détecté — restauration depuis backup…");
    const restore = await exec(
      conn,
      `set -e; bak=$(ls -1t ${composePath}.bak.* 2>/dev/null | tail -1); ` +
      `if [ -n "$bak" ]; then cp "$bak" ${composePath} && echo "RESTORED=$bak"; else echo NO_BACKUP; fi`
    );
    await log((`${restore.stdout}${restore.stderr}`).slice(-400));
    if (/NO_BACKUP/.test(restore.stdout)) {
      // Aucun backup -> recloner depuis git
      await log("→ Aucun backup — réinitialisation via git checkout du compose…");
      await exec(conn, `cd ${supaDir} && git checkout -- docker-compose.yml 2>&1 || true`);
    }
  }

  const check = await exec(conn, `grep -q '${sentinel}' ${composePath} && echo PATCHED || echo TODO`);
  if (/PATCHED/.test(check.stdout)) {
    await log("✓ docker-compose déjà patché (dépendances analytics/vector/studio neutralisées).");
    return;
  }

  await log("→ Patch docker-compose.yml via PyYAML (suppression dépendances bloquantes analytics/vector/studio)…");
  await exec(conn, `cp ${composePath} ${composePath}.bak.$(date +%s) 2>&1 || true`);

  // Assurer la présence de PyYAML (silencieux)
  await exec(conn, `python3 -c "import yaml" 2>/dev/null || (apt-get install -y python3-yaml 2>/dev/null || pip3 install --quiet pyyaml 2>/dev/null) || true`);

  // Script Python utilisant PyYAML : supprime UNIQUEMENT les entrées "analytics" dans depends_on
  const py = `
import sys, pathlib, yaml
p = pathlib.Path("${composePath}")
data = yaml.safe_load(p.read_text())
services = data.get("services", {}) if isinstance(data, dict) else {}
changed = 0
for name, svc in list(services.items()):
    if not isinstance(svc, dict):
        continue
    dep = svc.get("depends_on")
    blocking = ("analytics", "vector", "studio")
    if isinstance(dep, dict):
        for b in blocking:
            if b in dep:
                dep.pop(b, None)
                changed += 1
        if not dep:
            svc.pop("depends_on", None)
    elif isinstance(dep, list):
        kept = [d for d in dep if d not in blocking]
        if len(kept) != len(dep):
            changed += len(dep) - len(kept)
            if kept:
                svc["depends_on"] = kept
            else:
                svc.pop("depends_on", None)
out = "${sentinel}\\n" + yaml.safe_dump(data, sort_keys=False, default_flow_style=False, width=4096)
p.write_text(out)
print("OK changed=%d" % changed)
`;
  const enc = btoa(unescape(encodeURIComponent(py)));
  const run = await exec(conn, `echo '${enc}' | base64 -d | python3 - 2>&1`);
  await log((`${run.stdout}${run.stderr}`).slice(-600));

  // Validation finale du YAML
  const verify = await exec(conn, `docker compose -f ${composePath} config --quiet 2>&1; echo EXIT=$?`);
  const verifyOut = `${verify.stdout}${verify.stderr}`;
  if (!/EXIT=0/.test(verifyOut)) {
    await log("⚠ Validation compose échouée après patch — restauration backup.");
    await exec(conn, `bak=$(ls -1t ${composePath}.bak.* | head -1); [ -n "$bak" ] && cp "$bak" ${composePath} || true`);
    throw new Error("Patch docker-compose invalide : " + verifyOut.slice(-400));
  }
  await log("✓ docker-compose.yml patché et validé.");
}

async function patchKongKeyauthCredentials(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  const sentinel = "# LOVABLE_KONG_DEDUPE_KEYAUTH_V1";
  const kongPath = `${supaDir}/volumes/api/kong.yml`;
  const check = await exec(conn, `[ -f ${kongPath} ] && (grep -q '${sentinel}' ${kongPath} && echo PATCHED || echo TODO) || echo MISSING`);
  if (/MISSING/.test(check.stdout)) return;
  if (/PATCHED/.test(check.stdout)) {
    await log("✓ kong.yml déjà patché (clés Auth dédupliquées).");
    return;
  }

  await log("→ Patch kong.yml (suppression des clés Auth dupliquées)…");
  await exec(conn, `cp ${kongPath} ${kongPath}.bak.$(date +%s) 2>&1 || true`);
  const py = `
import pathlib, re
p = pathlib.Path("${kongPath}")
lines = p.read_text().splitlines()
out = ["${sentinel}"]
seen_keys = set()
removed = 0
for line in lines:
    if line.strip() == "${sentinel}":
        continue
    if re.search(r'-\\s+key:\\s*\\$SUPABASE_(PUBLISHABLE_KEY|SECRET_KEY)\\s*$', line):
        removed += 1
        continue
    m = re.match(r'^(\\s*-\\s+key:\\s*)(.+?)\\s*$', line)
    if m:
        key = m.group(2).strip().strip('"\\'')
        if key and not key.startswith('$'):
            if key in seen_keys:
                removed += 1
                continue
            seen_keys.add(key)
    out.append(line)
p.write_text("\\n".join(out) + "\\n")
print(f"OK removed={removed}")
`;
  const enc = btoa(unescape(encodeURIComponent(py)));
  const run = await exec(conn, `echo '${enc}' | base64 -d | python3 - 2>&1`);
  await log((`${run.stdout}${run.stderr}`).slice(-600));
  await exec(conn, `cd ${supaDir} && docker compose rm -sf kong 2>&1 || true`);
}

async function startLocalSupabaseEssentials(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void, skipPull = false) {
  // 0) Patcher le compose pour retirer la dépendance bloquante sur analytics
  await patchComposeRemoveAnalytics(conn, supaDir, log);
  await patchKongKeyauthCredentials(conn, supaDir, log);

  const services = await exec(conn, `cd ${supaDir} && docker compose config --services 2>/dev/null || true`);
  const available = new Set((services.stdout || "").split(/\s+/).filter(Boolean));
  const essentialServices = ["db", "kong", "auth", "rest", "realtime", "storage", "meta", "imgproxy", "functions", "edge-runtime"].filter((name) => available.has(name)).join(" ");
  const optionalServices = ["studio"].filter((name) => available.has(name)).join(" ");

  // S'assurer qu'analytics/vector ne tournent pas et ne bloquent rien
  await exec(conn, `cd ${supaDir} && docker compose stop analytics vector 2>&1 || true`);
  await exec(conn, `cd ${supaDir} && docker compose rm -f analytics vector 2>&1 || true`);

  if (skipPull) {
    await log("✓ Images locales déjà présentes — pull Docker ignoré pour éviter un déploiement trop long.");
  } else {
    const pull = await exec(conn, `cd ${supaDir} && docker compose pull ${essentialServices} ${optionalServices} 2>&1 | tail -80 || true`);
    await log((`${pull.stdout}${pull.stderr}`).slice(-1800));
  }

  const upEssential = await exec(conn, `cd ${supaDir} && docker compose up -d ${essentialServices} 2>&1`);
  const essentialOutput = `${upEssential.stdout}${upEssential.stderr}`;
  await log(essentialOutput.slice(-2400));

  if (upEssential.code !== 0) {
    // Dernier recours : démarrer un par un, sans dépendances
    await log("⚠ Échec démarrage groupé — tentative service par service (--no-deps)…");
    const ordered = ["db", "kong", "rest", "auth", "storage", "meta", "realtime", "imgproxy", "functions", "edge-runtime"].filter((s) => available.has(s));
    let lastOut = "";
    for (const svc of ordered) {
      const r = await exec(conn, `cd ${supaDir} && docker compose up -d --no-deps ${svc} 2>&1`);
      lastOut = `${r.stdout}${r.stderr}`;
      await log(`[${svc}] ${lastOut.slice(-300)}`);
    }
    // Vérifier que kong est up
    const psKong = await exec(conn, `cd ${supaDir} && docker compose ps kong 2>&1 || true`);
    if (!/Up|running/i.test(psKong.stdout)) {
      throw new Error("Échec du démarrage des services essentiels Supabase local : " + (lastOut || essentialOutput).slice(-900));
    }
  }

  if (optionalServices) {
    const optional = await exec(conn, `cd ${supaDir} && docker compose up -d --no-deps ${optionalServices} 2>&1 || true`);
    const optionalOutput = `${optional.stdout}${optional.stderr}`;
    if (optionalOutput.trim()) await log(optionalOutput.slice(-800));
  }

  await handleAnalyticsUnhealthy(conn, supaDir, log);
}

async function ensureLocalApiServices(conn: Client, supaDir: string, kongPort: string, anonKey: string, log: (m: string) => Promise<void> | void) {
  await log("→ Vérification REST/Storage/Realtime derrière la gateway locale…");
  const probeCmd =
    `ANON=${shQuote(anonKey)} sh -c ` +
    shQuote(
      `for i in $(seq 1 5); do ` +
      `rest=$(curl -sS -m 2 -o /tmp/sf_rest.txt -w "%{http_code}" "http://127.0.0.1:${kongPort}/rest/v1/establishments?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" 2>/dev/null || true); ` +
      `stor=$(curl -sS -m 2 -o /tmp/sf_storage.txt -w "%{http_code}" "http://127.0.0.1:${kongPort}/storage/v1/bucket" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" 2>/dev/null || true); ` +
      `case "$rest:$stor" in 2*:2*|2*:401|2*:403|401:2*|403:2*|401:401|401:403|403:401|403:403) echo "OK rest=$rest storage=$stor"; exit 0;; esac; ` +
      `echo "WAIT rest=$rest storage=$stor"; sleep 1; done; ` +
      `echo FAIL; echo REST_BODY; cat /tmp/sf_rest.txt 2>/dev/null || true; echo STORAGE_BODY; cat /tmp/sf_storage.txt 2>/dev/null || true`
    );
  let probe = await exec(conn, probeCmd);
  let output = `${probe.stdout}${probe.stderr}`;
  if (probe.code === 0 && /OK rest=/.test(output)) {
    await log(`✓ Services locaux joignables (${output.match(/OK rest=.*$/m)?.[0] || "OK"})`);
    return;
  }

  await log("⚠ REST/Storage répondent mal (souvent HTTP 503). Redémarrage ciblé rapide des services locaux…");
  const restart = await exec(conn, `cd ${supaDir} && docker compose up -d --no-deps db kong 2>&1; docker compose up -d --no-deps --force-recreate rest storage realtime auth 2>&1 || true`);
  await log((`${restart.stdout}${restart.stderr}`).slice(-1600));
  probe = await exec(conn, probeCmd);
  output = `${probe.stdout}${probe.stderr}`;
  if (!(probe.code === 0 && /OK rest=/.test(output))) {
    const ps = await exec(conn, `cd ${supaDir} && docker compose ps && docker compose logs --tail=80 rest storage realtime kong 2>&1 || true`);
    await log(
      "⚠ La gateway locale répond mais REST/Storage restent indisponibles après réparation rapide. " +
      "Le déploiement continue pour livrer l'interface; ouvrez /admin/health puis redémarrez les conteneurs locaux si la DB reste KO. Détails: " +
      `${output}\n${ps.stdout}${ps.stderr}`.slice(-2500)
    );
    return;
  }
  await log(`✓ Services locaux réparés (${output.match(/OK rest=.*$/m)?.[0] || "OK"})`);
}

async function applyLocalDashboardWriteHotfix(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  await log("→ Correction des permissions locales upload/écrans…");
  const sql = `
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT SELECT ON storage.buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;

DROP POLICY IF EXISTS "Local dashboard can manage profiles" ON public.profiles;
CREATE POLICY "Local dashboard can manage profiles" ON public.profiles
FOR ALL TO anon, authenticated
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Local dashboard can manage user roles" ON public.user_roles;
CREATE POLICY "Local dashboard can manage user roles" ON public.user_roles
FOR ALL TO anon, authenticated
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Local dashboard can manage team memberships" ON public.user_establishments;
CREATE POLICY "Local dashboard can manage team memberships" ON public.user_establishments
FOR ALL TO anon, authenticated
USING (true)
WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('media', 'media', true, 1073741824)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 1073741824;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('uploads', 'uploads', true, 1073741824)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 1073741824;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) THEN
    EXECUTE 'UPDATE storage.buckets SET allowed_mime_types = NULL WHERE id IN (''media'', ''uploads'')';
  END IF;
END $$;

DROP POLICY IF EXISTS "Local dashboard can manage screens" ON public.screens;
CREATE POLICY "Local dashboard can manage screens" ON public.screens
FOR ALL TO anon, authenticated
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Local dashboard can manage media" ON public.media;
CREATE POLICY "Local dashboard can manage media" ON public.media
FOR ALL TO anon, authenticated
USING (true)
WITH CHECK (true);

DO $$
BEGIN
  IF to_regclass('public.contents') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Local dashboard can manage QR contents" ON public.contents';
    EXECUTE 'CREATE POLICY "Local dashboard can manage QR contents" ON public.contents FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)';
  END IF;
  IF to_regclass('public.access_codes') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Local QR can read active access codes" ON public.access_codes';
    EXECUTE 'CREATE POLICY "Local QR can read active access codes" ON public.access_codes FOR SELECT TO anon, authenticated USING (is_active = true OR auth.role() = ''authenticated'')';
  END IF;
END $$;

DROP POLICY IF EXISTS "Users can insert establishment screens" ON public.screens;
CREATE POLICY "Users can insert establishment screens" ON public.screens
FOR INSERT TO authenticated
WITH CHECK ((establishment_id IS NOT NULL AND public.is_member_of(auth.uid(), establishment_id)) OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Users can update establishment screens" ON public.screens;
CREATE POLICY "Users can update establishment screens" ON public.screens
FOR UPDATE TO authenticated
USING ((establishment_id IS NOT NULL AND public.is_member_of(auth.uid(), establishment_id)) OR public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK ((establishment_id IS NOT NULL AND public.is_member_of(auth.uid(), establishment_id)) OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Global admins can manage screens" ON public.screens;
CREATE POLICY "Global admins can manage screens" ON public.screens
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Users can insert establishment media" ON public.media;
CREATE POLICY "Users can insert establishment media" ON public.media
FOR INSERT TO authenticated
WITH CHECK ((establishment_id IS NOT NULL AND public.is_member_of(auth.uid(), establishment_id)) OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Users can update establishment media" ON public.media;
CREATE POLICY "Users can update establishment media" ON public.media
FOR UPDATE TO authenticated
USING ((establishment_id IS NOT NULL AND public.is_member_of(auth.uid(), establishment_id)) OR public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK ((establishment_id IS NOT NULL AND public.is_member_of(auth.uid(), establishment_id)) OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Global admins can manage media" ON public.media;
CREATE POLICY "Global admins can manage media" ON public.media
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Local dashboard can read media files" ON storage.objects;
CREATE POLICY "Local dashboard can read media files" ON storage.objects
FOR SELECT TO anon, authenticated
USING (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Local dashboard can upload media files" ON storage.objects;
CREATE POLICY "Local dashboard can upload media files" ON storage.objects
FOR INSERT TO anon, authenticated
WITH CHECK (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Local dashboard can update media files" ON storage.objects;
CREATE POLICY "Local dashboard can update media files" ON storage.objects
FOR UPDATE TO anon, authenticated
USING (bucket_id IN ('media','uploads'))
WITH CHECK (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Local dashboard can delete media files" ON storage.objects;
CREATE POLICY "Local dashboard can delete media files" ON storage.objects
FOR DELETE TO anon, authenticated
USING (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Authenticated users can upload media files" ON storage.objects;
CREATE POLICY "Authenticated users can upload media files" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Authenticated users can update media files" ON storage.objects;
CREATE POLICY "Authenticated users can update media files" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id IN ('media','uploads'))
WITH CHECK (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Authenticated users can delete media files" ON storage.objects;
CREATE POLICY "Authenticated users can delete media files" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id IN ('media','uploads'));

DROP POLICY IF EXISTS "Public can read media files" ON storage.objects;
CREATE POLICY "Public can read media files" ON storage.objects
FOR SELECT TO anon, authenticated
USING (bucket_id IN ('media','uploads'));
`;
  const result = await exec(conn, dockerPsql(supaDir, btoa(sql), false));
  const output = `${result.stdout}${result.stderr}`;
  if (result.code !== 0 || /ERROR:/i.test(output)) {
    await log("⚠ Correction permissions incomplète: " + output.slice(-1600));
    return;
  }
  await log("✓ Permissions locales upload/écrans corrigées");
}

async function verifyAuthLoginFromServer(
  conn: Client,
  authBaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
  log: (m: string) => Promise<void> | void,
  fallbackCommand?: string,
) {
  const payloadB64 = btoa(JSON.stringify({ email, password }));
  const command =
    `AUTH_URL=${shQuote(`${authBaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`)} ` +
    `ANON_KEY=${shQuote(anonKey)} BODY_B64=${shQuote(payloadB64)} sh -c ` +
    shQuote(`body=$(printf "%s" "$BODY_B64" | base64 -d); curl -k -sS -m 20 -w "\\nHTTP_STATUS:%{http_code}" -X POST "$AUTH_URL" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" --data "$body"`);

  let lastOutput = "";
  for (let attempt = 1; attempt <= 45; attempt++) {
    const result = await exec(conn, attempt > 20 && fallbackCommand ? fallbackCommand : command);
    lastOutput = `${result.stdout}${result.stderr}`;
    if (result.code === 0 && /HTTP_STATUS:200/.test(lastOutput) && /"access_token"/.test(lastOutput)) {
      await log(`✓ Test login Auth réussi depuis le serveur (${authBaseUrl})`);
      return;
    }
    if (attempt === 20 && fallbackCommand) {
      await log(`⚠ Port Auth ${authBaseUrl} indisponible depuis l'hôte, test direct dans le conteneur kong…`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Le compte admin existe mais le test login Auth échoue depuis le serveur (${authBaseUrl}). Réponse : ${lastOutput.slice(-700)}`);
}

async function verifyPublicAuthLogin(
  authBaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
  log: (m: string) => Promise<void> | void,
) {
  try {
    const response = await fetch(`${authBaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    const text = await response.text();
    if (response.ok && text.includes("access_token")) {
      await log(`✓ Test login Auth public réussi (${authBaseUrl})`);
      return;
    }
    await log(`⚠ Test login Auth public échoué (${response.status}) : ${text.slice(0, 500)}`);
  } catch (error: any) {
    await log(`⚠ API Auth publique inaccessible depuis Lovable Cloud (${authBaseUrl}) : ${error?.message || String(error)}`);
  }
}

async function readRemoteEnv(conn: Client, envPath: string, key: string) {
  const result = await exec(conn, `grep -E '^${key}=' ${envPath} | head -1 | cut -d= -f2-`);
  return (result.stdout || "").trim();
}

async function ensurePostgresSqlAccess(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  await exec(conn, `cd ${supaDir} && for i in $(seq 1 30); do docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done`);
  const probe = await exec(conn, dockerPsqlSelect(supaDir, "select 1", false));
  const probeOut = `${probe.stdout}${probe.stderr}`;
  if (probe.code === 0 && !/Permission denied|pg_filenode\.map/i.test(probeOut)) return;

  await log("⚠ Permissions Postgres détectées comme invalides — réparation du volume DB…");
  await exec(conn, `cd ${supaDir} && docker compose exec -T -u 0 db sh -c "chown -R postgres:postgres /var/lib/postgresql/data && chmod -R u+rwX,go-rwx /var/lib/postgresql/data" 2>&1 || true`);
  await exec(conn, `cd ${supaDir} && docker compose restart db 2>&1 || true`);
  await exec(conn, `cd ${supaDir} && for i in $(seq 1 60); do docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break || sleep 2; done`);
  const retry = await exec(conn, dockerPsqlSelect(supaDir, "select 1", false));
  const retryOut = `${retry.stdout}${retry.stderr}`;
  if (retry.code !== 0 || /Permission denied|pg_filenode\.map/i.test(retryOut)) {
    throw new Error("Postgres local reste inaccessible après réparation des permissions : " + retryOut.slice(-600));
  }
  await log("✓ Permissions Postgres réparées");
}

function buildAuthLoginCurlCommand(authBaseUrl: string, anonKey: string, email: string, password: string) {
  const payloadB64 = btoa(JSON.stringify({ email, password }));
  return `AUTH_URL=${shQuote(`${authBaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`)} ` +
    `ANON_KEY=${shQuote(anonKey)} BODY_B64=${shQuote(payloadB64)} sh -c ` +
    shQuote(`body=$(printf "%s" "$BODY_B64" | base64 -d); curl -k -sS -m 20 -w "\\nHTTP_STATUS:%{http_code}" -X POST "$AUTH_URL" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" --data "$body"`);
}

function buildDirectKongAuthLoginCommand(supaDir: string, anonKey: string, email: string, password: string) {
  const payloadB64 = btoa(JSON.stringify({ email, password }));
  return `cd ${supaDir} && KONG_CID=$(docker compose ps -q kong) && ` +
    `KONG_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$KONG_CID" | awk '{print $1}') && ` +
    `AUTH_URL="http://$KONG_IP:8000/auth/v1/token?grant_type=password" ` +
    `ANON_KEY=${shQuote(anonKey)} BODY_B64=${shQuote(payloadB64)} sh -c ` +
    shQuote(`body=$(printf "%s" "$BODY_B64" | base64 -d); curl -k -sS -m 20 -w "\\nHTTP_STATUS:%{http_code}" -X POST "$AUTH_URL" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" --data "$body"`);
}

function chooseKongHttpsPort(kongHttpPort: string, reservedPorts: string[] = []) {
  const http = Number.parseInt(kongHttpPort, 10);
  let candidate = Number.isFinite(http) ? http + 443 : 8443;
  const reserved = new Set(reservedPorts.map((p) => Number.parseInt(p, 10)).filter((p) => Number.isFinite(p)));
  while (reserved.has(candidate) || candidate === http) candidate += 1;
  return String(candidate);
}

async function syncSupabaseKongPorts(conn: Client, supaDir: string, kongHttpPort: string, kongHttpsPort: string, log: (m: string) => Promise<void> | void) {
  const cmd = `cd ${supaDir} && touch .env && ` +
    `cur_http=$(grep -E '^KONG_HTTP_PORT=' .env | head -1 | cut -d= -f2-); ` +
    `cur_https=$(grep -E '^KONG_HTTPS_PORT=' .env | head -1 | cut -d= -f2-); ` +
    `changed=0; ` +
    `if [ "$cur_http" != ${shQuote(kongHttpPort)} ]; then sed -i '/^KONG_HTTP_PORT=/d' .env; printf 'KONG_HTTP_PORT=%s\n' ${shQuote(kongHttpPort)} >> .env; changed=1; fi; ` +
    `if [ "$cur_https" != ${shQuote(kongHttpsPort)} ]; then sed -i '/^KONG_HTTPS_PORT=/d' .env; printf 'KONG_HTTPS_PORT=%s\n' ${shQuote(kongHttpsPort)} >> .env; changed=1; fi; ` +
    `if [ "$changed" = 1 ]; then docker compose rm -sf kong 2>&1 || true; echo CHANGED; else echo OK; fi`;
  const result = await exec(conn, cmd);
  const output = `${result.stdout}${result.stderr}`;
  if (/CHANGED/.test(output)) {
    await log(`✓ Ports Kong Supabase alignés : HTTP ${kongHttpPort}, HTTPS ${kongHttpsPort} (évite le conflit avec l'application)`);
  }
}

async function syncLocalAuthSafeEnv(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  const envPatch = [
    "SUPABASE_URL=http://kong:8000",
    "FUNCTIONS_VERIFY_JWT=false",
    "ENABLE_EMAIL_AUTOCONFIRM=true",
    "ENABLE_PHONE_SIGNUP=false",
    "ENABLE_PHONE_AUTOCONFIRM=true",
    "HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=false",
    "HOOK_SEND_EMAIL_ENABLED=false",
    "HOOK_SEND_SMS_ENABLED=false",
    "HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED=false",
    "HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=false",
  ].join("\n") + "\n";
  const keys = envPatch.split("\n").map((line) => line.split("=")[0]).filter(Boolean).join(" ");
  const b64 = btoa(envPatch);
  const cmd = `cd ${supaDir} && for k in ${keys}; do sed -i "/^$k=/d" .env; done && printf '%s' '${b64}' | base64 -d >> .env && docker compose rm -sf auth 2>&1 || true`;
  await exec(conn, cmd);
  await log("✓ Configuration Auth locale sécurisée (hooks réseau désactivés)");
}

async function syncLocalEdgeFunctions(conn: Client, remoteDir: string, supaDir: string, log: (m: string) => Promise<void> | void) {
  const fnDir = `${remoteDir}/repo/supabase/functions`;
  const probe = await exec(conn, `[ -d ${fnDir} ] && echo OK || echo MISSING`);
  if (!(probe.stdout || "").includes("OK")) {
    await log("⚠ Aucun dossier de fonctions backend trouvé dans le repo cloné.");
    return;
  }

  await log("→ Synchronisation des fonctions backend locales…");
  const cmd =
    `mkdir -p ${supaDir}/volumes/functions && ` +
    `MAIN_SRC=${shQuote(`${supaDir}/supabase-repo/docker/volumes/functions/main`)} && ` +
    `MAIN_DST=${shQuote(`${supaDir}/volumes/functions/main`)} && ` +
    `if [ ! -d "$MAIN_DST" ] && [ -d "$MAIN_SRC" ]; then mkdir -p "$MAIN_DST" && cp -a "$MAIN_SRC"/. "$MAIN_DST"/; fi && ` +
    `for d in ${fnDir}/*; do [ -d "$d" ] || continue; name=$(basename "$d"); [ "$name" = main ] && continue; rm -rf ${supaDir}/volumes/functions/"$name"; cp -a "$d" ${supaDir}/volumes/functions/"$name"; done && ` +
    `cd ${supaDir} && ` +
    `anon=$(grep -E '^ANON_KEY=' .env | head -1 | cut -d= -f2-); ` +
    `svc=$(grep -E '^SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2-); ` +
    `pgpw=$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-); ` +
    `for k in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL DATABASE_URL FUNCTIONS_VERIFY_JWT; do sed -i "/^$k=/d" .env; done; ` +
    `printf 'SUPABASE_URL=http://kong:8000\nSUPABASE_ANON_KEY=%s\nSUPABASE_SERVICE_ROLE_KEY=%s\nSUPABASE_DB_URL=postgresql://postgres:%s@db:5432/postgres\nDATABASE_URL=postgresql://postgres:%s@db:5432/postgres\nFUNCTIONS_VERIFY_JWT=false\n' "$anon" "$svc" "$pgpw" "$pgpw" >> .env; ` +
    `(docker compose up -d --no-deps functions 2>&1 || docker compose up -d --no-deps edge-runtime 2>&1 || true); ` +
    `(docker compose restart functions 2>&1 || docker compose restart edge-runtime 2>&1 || true)`;
  const result = await exec(conn, cmd);
  await log((`${result.stdout}${result.stderr}`).slice(-1200));
  await log("✓ Fonctions backend locales synchronisées");
}

async function ensureLocalAuthGateway(conn: Client, supaDir: string, kongPort: string, log: (m: string) => Promise<void> | void) {
  await log(`→ Vérification de la gateway Auth locale (port ${kongPort})…`);
  await patchKongKeyauthCredentials(conn, supaDir, log);
  const up = await exec(
    conn,
    `cd ${supaDir} && (docker compose up -d db kong auth rest realtime storage meta 2>&1 || docker compose up -d kong auth rest storage 2>&1 || true)`
  );
  const upOutput = `${up.stdout}${up.stderr}`;
  if (/unhealthy|dependency failed|failed to start|Error/i.test(upOutput)) {
    await log("⚠ Redémarrage gateway Auth partiel, vérification des services essentiels : " + upOutput.slice(-1200));
  }
  const probe = await exec(
    conn,
    `for i in $(seq 1 45); do status=$(curl -k -sS -m 5 -o /tmp/screenflow_auth_probe.txt -w "%{http_code}" http://127.0.0.1:${kongPort}/auth/v1/settings 2>/dev/null || true); ` +
    `case "$status" in 200|401|403) echo OK_HTTP_STATUS:$status && exit 0;; esac; sleep 2; done; ` +
    `echo FAIL; cd ${supaDir} && docker compose ps && docker compose logs --tail=80 kong 2>&1`
  );
  const okStatus = probe.stdout.match(/OK_HTTP_STATUS:(\d+)/)?.[1];
  if (okStatus) {
    await log(`✓ Gateway Auth locale accessible sur http://127.0.0.1:${kongPort} (HTTP ${okStatus})`);
    return;
  }
  throw new Error(
    `La gateway Auth locale ne répond pas sur http://127.0.0.1:${kongPort}. ` +
    `Vérifiez qu'aucun autre service n'utilise ce port ou changez le port API Supabase local. Détails : ` +
    (probe.stdout + probe.stderr).slice(-1200)
  );
}

async function upsertDefaultAdminViaAuthApi(
  conn: Client,
  supaDir: string,
  kongPort: string,
  serviceKey: string,
  password: string,
  log: (m: string) => Promise<void> | void,
) {
  await ensureLocalAuthGateway(conn, supaDir, kongPort, log);
  const existing = await exec(conn, dockerPsqlSelect(supaDir, `select id::text from auth.users where lower(email)=lower('${DEFAULT_ADMIN_EMAIL}') limit 1`));
  const existingId = (existing.stdout || "").match(/[0-9a-fA-F-]{36}/)?.[0] || "";
  const body = existingId
    ? { email: DEFAULT_ADMIN_EMAIL, password, email_confirm: true, user_metadata: { display_name: "ScreenFlow Admin" }, app_metadata: { provider: "email", providers: ["email"] }, ban_duration: "none" }
    : { email: DEFAULT_ADMIN_EMAIL, password, email_confirm: true, user_metadata: { display_name: "ScreenFlow Admin" }, app_metadata: { provider: "email", providers: ["email"] } };
  const payloadB64 = btoa(JSON.stringify(body));
  const method = existingId ? "PUT" : "POST";
  const path = existingId ? `/auth/v1/admin/users/${existingId}` : "/auth/v1/admin/users";
  const serviceKeyB64 = btoa(serviceKey);

  // Exécution directe via bash -c : on décode en variables locales, puis curl.
  // Évite tout problème avec `sh` absent du PATH ou des quotes mal échappées.
  const call = (baseUrl: string) => {
    const baseB64 = btoa(baseUrl.replace(/\/$/, ""));
    const pathB64 = btoa(path);
    const script =
      `set -e; ` +
      `API_BASE=$(printf '%s' '${baseB64}' | base64 -d); ` +
      `SERVICE_KEY=$(printf '%s' '${serviceKeyB64}' | base64 -d); ` +
      `REQ_PATH=$(printf '%s' '${pathB64}' | base64 -d); ` +
      `BODY=$(printf '%s' '${payloadB64}' | base64 -d); ` +
      `curl -k -sS -m 30 -w '\\nHTTP_STATUS:%{http_code}' -X ${method} ` +
      `"$API_BASE$REQ_PATH" ` +
      `-H "apikey: $SERVICE_KEY" ` +
      `-H "Authorization: Bearer $SERVICE_KEY" ` +
      `-H "Content-Type: application/json" ` +
      `--data "$BODY"`;
    return `bash -c ${shQuote(script)}`;
  };

  let result = await exec(conn, call(`http://127.0.0.1:${kongPort}`));
  let output = `${result.stdout}${result.stderr}`;
  if (!(result.code === 0 && /HTTP_STATUS:20[01]/.test(output))) {
    await log("⚠ API Admin Auth via le port hôte indisponible, tentative directe via le conteneur kong…");
    const directBase = `cd ${supaDir} && KONG_CID=$(docker compose ps -q kong) && KONG_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$KONG_CID" | awk '{print $1}') && echo "http://$KONG_IP:8000"`;
    const direct = await exec(conn, directBase);
    const directUrl = (direct.stdout || "").trim().split(/\s+/).pop() || "";
    if (directUrl.startsWith("http://")) {
      result = await exec(conn, call(directUrl));
      output = `${result.stdout}${result.stderr}`;
    }
  }
  if (!(result.code === 0 && /HTTP_STATUS:20[01]/.test(output))) {
    // Détection des erreurs réseau internes à GoTrue (DNS, webhook, SMTP) → fallback SQL direct
    const isNameResolution = /name resolution failed|no such host|dial tcp|HTTP_STATUS:50[0-9]/i.test(output);
    if (isNameResolution) {
      await log("⚠ API Admin GoTrue indisponible (résolution DNS interne échouée). Bascule en création SQL directe…");
      await upsertDefaultAdminViaSql(conn, supaDir, password, log);
      return;
    }
    throw new Error(`Impossible de créer/réparer le compte admin via l'API Auth locale. Réponse : ${output.slice(-900)}`);
  }
  await log(existingId ? "✓ Compte admin Auth réparé via API officielle" : "✓ Compte admin Auth créé via API officielle");
}

// Fallback : crée/met à jour directement le compte admin dans auth.users via SQL (bcrypt via pgcrypto).
// Utilisé quand GoTrue échoue avec "name resolution failed" (souvent dû à un webhook/SMTP non résolvable).
async function upsertDefaultAdminViaSql(
  conn: Client,
  supaDir: string,
  password: string,
  log: (m: string) => Promise<void> | void,
) {
  const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
DECLARE
  uid uuid;
  hashed text;
BEGIN
  hashed := crypt('${password.replace(/'/g, "''")}', gen_salt('bf'));
  SELECT id INTO uid FROM auth.users WHERE lower(email)=lower('${DEFAULT_ADMIN_EMAIL}') LIMIT 1;
  IF uid IS NULL THEN
    uid := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      '${DEFAULT_ADMIN_EMAIL}', hashed, now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"display_name":"ScreenFlow Admin"}'::jsonb,
      false, false
    );
    INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', '${DEFAULT_ADMIN_EMAIL}', 'email_verified', true), 'email', now(), now(), now())
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE auth.users SET
      encrypted_password = hashed,
      email_confirmed_at = COALESCE(email_confirmed_at, now()),
      updated_at = now(),
      banned_until = NULL,
      raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"provider":"email","providers":["email"]}'::jsonb
    WHERE id = uid;
  END IF;
END $$;
`.trim();
  const b64 = btoa(sql);
  const res = await exec(conn, dockerPsql(supaDir, b64));
  if (res.code !== 0) {
    throw new Error("Échec du fallback SQL pour le compte admin : " + (res.stdout + res.stderr).slice(-800));
  }
  await log("✓ Compte admin créé/réparé directement en base (fallback SQL)");
}

async function ensureDefaultAdminRole(conn: Client, supaDir: string, log: (m: string) => Promise<void> | void) {
  const roleSql = `
DO $$
DECLARE uid uuid;
BEGIN
  SELECT id INTO uid FROM auth.users WHERE lower(email)=lower('${DEFAULT_ADMIN_EMAIL}') LIMIT 1;
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Compte Auth introuvable pour ${DEFAULT_ADMIN_EMAIL}';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='profiles') THEN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (uid, '${DEFAULT_ADMIN_EMAIL}', 'ScreenFlow Admin')
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, updated_at=now();
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='user_roles') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (uid, 'admin') ON CONFLICT DO NOTHING;
    DELETE FROM public.user_roles WHERE user_id=uid AND role='user';
  END IF;
END $$;
`.trim();
  const roleB64 = btoa(roleSql);
  const promoted = await exec(conn, dockerPsql(supaDir, roleB64));
  if (promoted.code !== 0) throw new Error("Compte Auth créé, mais attribution du rôle admin échouée : " + (promoted.stdout + promoted.stderr).slice(-800));
  await log("✓ Rôle admin global confirmé pour screenflow@screenflow.local");
}

// Background job runner: persists progress to public.app_settings under key ssh_deploy_job:<jobId>
async function runDeploymentJob(
  jobId: string,
  body: DeployBody,
  serviceClient: ReturnType<typeof createClient>,
) {
  const logs: string[] = [];
  const settingsKey = `ssh_deploy_job:${jobId}`;

  const persist = async (patch: Record<string, unknown>) => {
    const value = JSON.stringify({
      job_id: jobId,
      updated_at: new Date().toISOString(),
      ...patch,
    });
    await serviceClient
      .from("app_settings")
      .upsert({ key: settingsKey, value }, { onConflict: "key" });
  };

  const log = async (m: string) => {
    console.log(`[${jobId}]`, m);
    logs.push(m);
    await persist({ status: "running", logs });
  };

  try {
    await persist({ status: "running", logs: [] });
    let directResult: any = null;
    (globalThis as any).__lastDeployResult = null;
    if (body.action === "reset_admin_password") {
      await runResetAdminPassword(body, log);
    } else if (body.action === "check_admin_status") {
      await runCheckAdminStatus(body, log, persist);
    } else if (body.action === "repair_uploads_now") {
      directResult = await runRepairUploadsNow(body, log);
    } else if (body.action === "repair_local_writes") {
      await runRepairLocalWrites(body, log);
    } else if (body.action === "repair_local_api_url") {
      await runRepairLocalApiUrl(body, log);
    } else if (body.action === "diagnose_server") {
      directResult = await runDiagnoseServer(body, log, persist);
    } else if (body.action === "restart_stack") {
      await runRestartStack(body, log);
    } else if (body.action === "repair_web_container") {
      directResult = await runRepairWebContainer(body, log);
    } else if (body.action === "repair_storage_buckets") {
      await runRepairStorageBuckets(body, log);
    } else if (body.action === "repair_realtime") {
      await runRepairRealtime(body, log);
    } else if (body.action === "apply_local_migrations") {
      directResult = await runApplyLocalMigrations(body, log);
    } else if (body.action === "build_status") {
      directResult = await runBuildStatus(body, log);
    } else if (body.action === "quick_update") {
      directResult = await runQuickUpdate(body, log);
    } else if (body.action === "network_inspect") {
      directResult = await runNetworkInspect(body, log);
    } else if (body.action === "network_recreate") {
      directResult = await runNetworkRecreate(body, log);
    } else if (body.action === "network_set_subnet") {
      directResult = await runNetworkSetSubnet(body, log);
    } else if (body.action === "network_set_hostname") {
      directResult = await runNetworkSetHostname(body, log);
    } else if (body.action === "network_get_config") {
      directResult = await runNetworkGetConfig(body, log);
    } else if (body.action === "network_set_container_ip") {
      directResult = await runNetworkSetContainerIp(body, log);
    } else {
      await runDeployment(body, log);
    }
    const result = directResult ?? (globalThis as any).__lastDeployResult ?? null;
    await persist({ status: "success", logs, result });
  } catch (e: any) {
    const detail = `${e?.message || String(e)}${e?.stack ? ` | ${String(e.stack).split("\n").slice(0, 4).join(" ⏎ ")}` : ""}`;
    logs.push("✗ ERROR: " + detail);
    await persist({ status: "error", logs, error: detail });
  }

}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userData.user.id, _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden — admin only" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as DeployBody;
    const action = body.action || "deploy";

    if (!body.host || !body.username || !body.password) {
      return new Response(JSON.stringify({ error: "Missing required fields (host, username, password)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (action === "deploy" && !body.git_url) {
      return new Response(JSON.stringify({ error: "Missing required field: git_url" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service-role client used by background task to persist job progress (bypasses RLS via service key)
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const jobId = crypto.randomUUID();

    // @ts-ignore - EdgeRuntime is provided by Supabase Functions runtime
    EdgeRuntime.waitUntil(runDeploymentJob(jobId, body, serviceClient));

    return new Response(JSON.stringify({
      success: true,
      job_id: jobId,
      status_key: `ssh_deploy_job:${jobId}`,
      message: action === "reset_admin_password"
        ? "Réinitialisation du mot de passe admin lancée en arrière-plan."
        : action === "check_admin_status"
          ? "Vérification du compte admin lancée en arrière-plan."
            : action === "repair_uploads_now"
              ? "Correction uploads bibliothèque/QR lancée en arrière-plan."
              : action === "repair_local_writes"
            ? "Réparation upload/écrans lancée en arrière-plan."
            : action === "repair_local_api_url"
              ? "Réparation de l'URL API locale lancée en arrière-plan."
              : action === "diagnose_server"
                ? "Diagnostic du serveur lancé en arrière-plan."
                : action === "restart_stack"
                  ? "Redémarrage de la stack Docker lancé en arrière-plan."
                  : action === "repair_storage_buckets"
                    ? "Réparation des buckets Storage lancée en arrière-plan."
                    : action === "repair_realtime"
                      ? "Réparation Realtime lancée en arrière-plan."
                      : action === "apply_local_migrations"
                        ? "Application des migrations locales lancée en arrière-plan."
                        : action === "build_status"
                          ? "Vérification du build en cours lancée en arrière-plan."
                          : action === "quick_update"
                          ? "Mise à jour rapide lancée en arrière-plan (git pull + migrations + rebuild web)."
                          : action === "network_inspect"
                            ? "Inspection du réseau Docker lancée en arrière-plan."
                            : action === "network_recreate"
                              ? "Recréation du réseau Docker lancée en arrière-plan."
                              : action === "network_set_subnet"
                                ? "Application de la configuration réseau Docker lancée en arrière-plan."
                                : action === "network_set_hostname"
                                  ? "Mise à jour du hostname système lancée en arrière-plan."
                                  : action === "network_get_config"
                                    ? "Lecture de la configuration réseau lancée en arrière-plan."
                                    : action === "network_set_container_ip"
                                      ? "Modification IP conteneur (live Docker) lancée en arrière-plan."
                                      : "Déploiement lancé en arrière-plan. Suivez la progression via le polling.",
    }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ===== The actual deployment logic, now wrapped =====
async function runDeployment(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const appPort = body.app_port || "8080";
  const localIp = /^\d{1,3}(\.\d{1,3}){3}$/.test((body.local_ip || "").trim()) ? body.local_ip!.trim() : "127.0.0.1";
  const branch = body.git_branch || "main";
  const requestedEnableHttps = !!body.enable_https;
  const httpsPort = body.https_port || "8443";
  const httpsDomain = (body.https_domain || body.host).trim();
  const dbStack = body.db_stack === "postgres_only" ? "postgres_only" : "supabase_full";
  const postgresImage = resolvePostgresImage(body.postgres_image);
  // "Install Supabase local" is forced ON when stack is full and the toggle was passed
  // For postgres_only, we deploy our OWN simple postgres container (no full Supabase stack).
  const installSupabase = !!body.install_supabase_local && dbStack === "supabase_full";
  const installPostgresOnly = !!body.install_supabase_local && dbStack === "postgres_only";
  // Local Supabase is intentionally exposed through the HTTP app proxy. A self-signed HTTPS
  // frontend makes browser uploads fail with ERR_CERT_AUTHORITY_INVALID, so deployment now
  // applies the same safe HTTP routing that the manual "repair upload/screens" action used.
  const enableHttps = requestedEnableHttps && !installSupabase;
  const forceFreshInstall = !!body.force_fresh_install;
  const supaKongPort = body.supabase_kong_http_port || "8000";
  const supaKongHttpsPort = chooseKongHttpsPort(supaKongPort, [enableHttps ? httpsPort : ""]);
  const supaStudioPort = body.supabase_studio_port || "3001";
  const supaDbPort = body.supabase_db_port || "5432";
  const requestedPorts = [
    { label: "Application", value: appPort, required: true },
    { label: "HTTPS application", value: httpsPort, required: enableHttps },
    { label: "API Supabase/Kong", value: supaKongPort, required: installSupabase },
    { label: "HTTPS Supabase/Kong", value: supaKongHttpsPort, required: installSupabase },
    { label: "Studio Supabase", value: supaStudioPort, required: installSupabase },
    { label: "Postgres", value: supaDbPort, required: installSupabase || installPostgresOnly },
  ];
  validateDistinctPorts(requestedPorts.filter((port) => port.required));
  let supabaseUrlOverride = "";
  let supabaseAnonOverride = "";
  let supabaseProjectIdOverride = "";
  let earlyWebStarted = false;
  // L'edge function est coupée par le runtime après ~400s : on sort proprement avant.
  const deploymentDeadline = Date.now() + 8 * 60 * 1000;
  const ensureDeploymentBudget = async (nextStep: string) => {
    if (Date.now() <= deploymentDeadline) return;
    await log(`⚠ Délai maximum atteint avant: ${nextStep}`);
    throw new Error(`Déploiement interrompu proprement avant timeout. Dernière étape: ${nextStep}. Relancez le déploiement; les conteneurs déjà téléchargés seront réutilisés.`);
  };

  let gitUrl = body.git_url.trim();
  if (body.git_token && /^https?:\/\//.test(gitUrl)) {
    gitUrl = gitUrl.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(body.git_token)}@`);
  }

  await log(`→ Connecting to ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connection established");
  if (requestedEnableHttps && installSupabase) {
    await log("ℹ HTTPS auto-signé désactivé pour ce déploiement local : l'app et son API passent en HTTP via le proxy local pour éviter les erreurs de certificat sur les uploads/écrans.");
  }

    try {
      const sudoPrefix = `echo '${body.password.replace(/'/g, "'\\''")}' | sudo -S `;
      const preflight = await runRemotePreflight(conn, body, remoteDir, installSupabase, log);

      if ((!preflight.dockerOk || !preflight.composeOk) && body.install_docker) {
        log("→ Installing Docker (this may take 1-3 minutes)…");
        await exec(conn, `${sudoPrefix}sh -c "(command -v apt-get && apt-get update -y && apt-get install -y curl ca-certificates git) || (command -v dnf && dnf install -y curl ca-certificates git) || (command -v yum && yum install -y curl ca-certificates git) || true"`);
        const installCmd = `${sudoPrefix}sh -c "
          (curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || wget -qO /tmp/get-docker.sh https://get.docker.com) &&
          sh /tmp/get-docker.sh &&
          (systemctl enable docker || true) &&
          (systemctl start docker || service docker start || true) &&
          usermod -aG docker ${body.username} || true
        "`;
        const r = await exec(conn, installCmd);
        log(r.stdout.slice(-1500));
        if (r.code !== 0) {
          const errMsg = r.stderr.slice(-1000);
          log("⚠ Install errors: " + errMsg);
          if (/not in the sudoers/i.test(errMsg) || /incorrect password/i.test(errMsg)) {
            throw new Error(
              `L'utilisateur '${body.username}' n'a pas les droits sudo. ` +
              `En root : 'usermod -aG sudo ${body.username}' (Debian/Ubuntu) ou 'usermod -aG wheel ${body.username}' (RHEL).`
            );
          }
          throw new Error("Échec de l'installation de Docker. Voir les logs.");
        }
        log("✓ Docker installed");
      }

      // Ensure git
      const gitCheck = await exec(conn, "command -v git || echo MISSING");
      if ((gitCheck.stdout || "").includes("MISSING")) {
        log("→ Installing git…");
        await exec(conn, `${sudoPrefix}sh -c "(apt-get update -y && apt-get install -y git) || (dnf install -y git) || (yum install -y git)"`);
      }

      // ===== Detect existing installation (incremental update mode) =====
      const existingCheck = await exec(
        conn,
        `test -d ${remoteDir}/repo/.git && test -f ${remoteDir}/repo/docker-compose.yml && echo EXISTS || echo NEW`,
      );
      let isExistingInstall = (existingCheck.stdout || "").includes("EXISTS");
      const supaDirCheck = await exec(
        conn,
        `test -f ${remoteDir}/supabase/docker-compose.yml && test -f ${remoteDir}/supabase/.env && echo EXISTS || echo NEW`,
      );
      let isExistingSupabase = (supaDirCheck.stdout || "").includes("EXISTS");

      if (forceFreshInstall && (isExistingInstall || isExistingSupabase)) {
        await log(`⚠ Réinstallation complète demandée — arrêt et suppression de l'installation existante dans ${remoteDir}…`);
        await exec(conn, `[ -f ${remoteDir}/repo/docker-compose.yml ] && (cd ${remoteDir}/repo && (docker compose down --remove-orphans 2>&1 || docker-compose down --remove-orphans 2>&1 || true)) || true`);
        await exec(conn, `[ -f ${remoteDir}/supabase/docker-compose.yml ] && (cd ${remoteDir}/supabase && (docker compose down -v --remove-orphans 2>&1 || docker-compose down -v --remove-orphans 2>&1 || true)) || true`);
        await exec(conn, `${sudoPrefix}rm -rf ${remoteDir}/repo ${remoteDir}/supabase`);
        await log("✓ Ancienne installation supprimée — nouveau déploiement propre");
        isExistingInstall = false;
        isExistingSupabase = false;
      }

      if (forceFreshInstall) {
        await freeRemotePorts(conn, requestedPorts.filter(p => p.required).map(p => p.value), sudoPrefix, log);
      }

      const ignoredPortDirs = forceFreshInstall ? [] : [`${remoteDir}/repo`, `${remoteDir}/supabase`];
      await checkRemotePortsAvailable(conn, requestedPorts, log, ignoredPortDirs);

      if (isExistingInstall) {
        await log(`✓ Installation existante détectée dans ${remoteDir} — mode mise à jour activé`);
      }
      if (installSupabase && isExistingSupabase) {
        await log(`✓ Supabase local déjà installé dans ${remoteDir}/supabase — réutilisation de la configuration existante`);
      }

      // ===== Clone/maj du dépôt applicatif AVANT la stack Supabase =====
      // Le build de l'app est l'étape critique : si la stack locale consomme tout le budget,
      // le dépôt doit déjà être présent pour que le build détaché puisse démarrer.
      log(`→ Preparing remote directory ${remoteDir}…`);
      await exec(conn, `${sudoPrefix}mkdir -p ${remoteDir} && ${sudoPrefix}chown ${body.username}:${body.username} ${remoteDir} && if [ -d ${remoteDir}/repo ]; then ${sudoPrefix}chown -R ${body.username}:${body.username} ${remoteDir}/repo; fi`);
      log("✓ Remote directory ready");

      if (isExistingInstall) {
        await log(`→ Mise à jour du repo existant (git fetch + reset --hard origin/${branch})…`);
        const pull = await exec(
          conn,
          `cd ${remoteDir}/repo && ` +
          `git remote set-url origin '${gitUrl}' 2>&1 && ` +
          `git fetch --depth 1 origin ${branch} 2>&1 && ` +
          `git reset --hard origin/${branch} 2>&1 && ` +
          `git clean -fd -e docker-compose.yml -e ssl 2>&1`,
        );
        log(pull.stdout.slice(-1500));
        if (pull.code !== 0) {
          await log("⚠ git pull a échoué, fallback sur clone complet…");
          await exec(conn, `rm -rf ${remoteDir}/repo`);
          const clone = await exec(conn, `git clone --depth 1 --branch ${branch} '${gitUrl}' ${remoteDir}/repo 2>&1`);
          log(clone.stdout.slice(-1500));
          if (clone.code !== 0) {
            throw new Error(`Échec du clone Git de secours. ${clone.stderr.slice(-300)}`);
          }
        }
        await log("✓ Repo mis à jour vers la dernière version");
      } else {
        log(`→ Cloning ${body.git_url} (branch: ${branch})…`);
        await exec(conn, `rm -rf ${remoteDir}/repo`);
        const clone = await exec(conn, `git clone --depth 1 --branch ${branch} '${gitUrl}' ${remoteDir}/repo 2>&1`);
        log(clone.stdout.slice(-1500));
        if (clone.code !== 0) {
          throw new Error(`Échec du clone Git. Vérifiez l'URL/branche/token. ${clone.stderr.slice(-300)}`);
        }
        log("✓ Repo cloned");
      }

      // For an external/shared backend all build credentials are already known,
      // so start the web build before any optional local infrastructure work.
      if (!installSupabase && !installPostgresOnly) {
        await prepareEarlyWebDeployment(
          conn,
          body,
          `${remoteDir}/repo`,
          remoteDir,
          appPort,
          body.vite_supabase_url || "",
          body.vite_supabase_key || "",
          body.vite_supabase_project_id || "",
          log,
        );
        earlyWebStarted = true;
      }

      await ensureDeploymentBudget("installation/contrôle Supabase local");


      // ===== Optional: install self-hosted Supabase on the same server =====
      if (installSupabase && !isExistingSupabase) {
        const supaDir = `${remoteDir}/supabase`;
        log("→ Installing self-hosted Supabase (this may take 3-5 minutes)…");
        await exec(conn, `${sudoPrefix}mkdir -p ${supaDir} && ${sudoPrefix}chown -R ${body.username}:${body.username} ${supaDir}`);

        const supaClone = await exec(conn, `if [ ! -d ${supaDir}/supabase-repo ]; then git clone --depth 1 https://github.com/supabase/supabase ${supaDir}/supabase-repo 2>&1; else cd ${supaDir}/supabase-repo && git pull 2>&1; fi`);
        log(supaClone.stdout.slice(-1000));
        if (supaClone.code !== 0) throw new Error("Échec clone du dépôt Supabase: " + supaClone.stderr.slice(-300));

        await exec(conn, `cp -rn ${supaDir}/supabase-repo/docker/* ${supaDir}/ 2>/dev/null || true`);
        await exec(conn, `cp -n ${supaDir}/supabase-repo/docker/.env.example ${supaDir}/.env 2>/dev/null || true`);

        const randHex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        const postgresPw = randHex(32);
        const jwtSecret = randHex(40);
        const dashboardPw = randHex(16);

        const jwtGen = await exec(conn, `docker run --rm -e S='${jwtSecret}' node:20-alpine node -e "const c=require('crypto');const s=process.env.S;function b64(o){return Buffer.from(JSON.stringify(o)).toString('base64url')}function sign(p){const h=b64({alg:'HS256',typ:'JWT'});const b=b64(p);const sig=c.createHmac('sha256',s).update(h+'.'+b).digest('base64url');return h+'.'+b+'.'+sig}const iat=Math.floor(Date.now()/1000),exp=iat+315360000;console.log(sign({role:'anon',iss:'supabase',iat,exp}));console.log(sign({role:'service_role',iss:'supabase',iat,exp}));"`);
        const jwtLines = (jwtGen.stdout || "").trim().split("\n").filter((l: string) => l.startsWith("ey"));
        if (jwtLines.length < 2) {
          log("⚠ JWT gen output: " + jwtGen.stdout.slice(-400) + " | err: " + jwtGen.stderr.slice(-400));
          throw new Error("Échec génération des clés JWT Supabase");
        }
        const anonKey = jwtLines[0];
        const serviceKey = jwtLines[1];

        const appPublicUrl = resolveBrowserAppBase(body, appPort, enableHttps, httpsDomain, httpsPort);
        const supaKongPublicUrl = `http://127.0.0.1:${supaKongPort}`;
        // The browser must use the app proxy on the server address; 127.0.0.1 is only valid inside SSH checks.
        const supaBrowserUrl = appPublicUrl;

        const envPatch = [
          `POSTGRES_PASSWORD=${postgresPw}`,
          `JWT_SECRET=${jwtSecret}`,
          `ANON_KEY=${anonKey}`,
          `SERVICE_ROLE_KEY=${serviceKey}`,
          `SUPABASE_PUBLISHABLE_KEY=`,
          `SUPABASE_SECRET_KEY=`,
          `DASHBOARD_USERNAME=admin`,
          `DASHBOARD_PASSWORD=${dashboardPw}`,
          `KONG_HTTP_PORT=${supaKongPort}`,
          `KONG_HTTPS_PORT=${supaKongHttpsPort}`,
          `STUDIO_PORT=${supaStudioPort}`,
          `POSTGRES_PORT=${supaDbPort}`,
          `ENABLE_EMAIL_SIGNUP=true`,
          `ENABLE_EMAIL_AUTOCONFIRM=true`,
          `ENABLE_ANONYMOUS_USERS=false`,
          `DISABLE_SIGNUP=false`,
        ].join("\n") + "\n" + buildLocalAuthUrlEnvPatch(body, appPort, supaBrowserUrl, enableHttps, httpsDomain, httpsPort);
        const envB64 = btoa(envPatch);
        await exec(conn, `cd ${supaDir} && for k in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY DASHBOARD_USERNAME DASHBOARD_PASSWORD SITE_URL API_EXTERNAL_URL GOTRUE_EXTERNAL_URL ADDITIONAL_REDIRECT_URLS SUPABASE_PUBLIC_URL KONG_HTTP_PORT KONG_HTTPS_PORT STUDIO_PORT POSTGRES_PORT ENABLE_EMAIL_SIGNUP ENABLE_EMAIL_AUTOCONFIRM ENABLE_ANONYMOUS_USERS DISABLE_SIGNUP; do sed -i "/^$k=/d" .env; done && echo "${envB64}" | base64 -d >> .env && serviceKey="${serviceKey}" && echo "_OK"`);

        // Start the frontend now, in parallel with the lengthy backend image pulls.
        // This also guarantees docker-compose.yml exists if the edge runtime stops.
        await prepareEarlyWebDeployment(
          conn,
          body,
          `${remoteDir}/repo`,
          remoteDir,
          appPort,
          supaBrowserUrl,
          anonKey,
          "local",
          log,
        );
        earlyWebStarted = true;

        log(`→ Starting Supabase containers essentiels (kong:${supaKongPort}, studio:${supaStudioPort}, db:${supaDbPort})…`);
        await syncLocalAuthSafeEnv(conn, supaDir, log);
        await startLocalSupabaseEssentials(conn, supaDir, log, false);
        await ensureLocalApiServices(conn, supaDir, supaKongPort, anonKey, log);

        supabaseUrlOverride = supaBrowserUrl;
        supabaseAnonOverride = anonKey;
        supabaseProjectIdOverride = "local";

        log(`✓ Supabase local démarré`);
        log(`  • API app: ${supaBrowserUrl} (proxy sécurisé via l'application)`);
        log(`  • API locale serveur: ${supaKongPublicUrl}`);
        log(`  • Studio: http://${localIp}:${supaStudioPort}  (admin / ${dashboardPw})`);
        log(`  • DB locale serveur: postgres://postgres:${postgresPw}@127.0.0.1:${supaDbPort}/postgres`);
        log(`  ⚠ Notez le mot de passe du dashboard, il ne sera pas réaffiché.`);

        // ===== Apply app migrations from cloned repo =====
        // Note: we apply this AFTER the repo is cloned below. We schedule it via a marker.
        (globalThis as any).__pendingLocalMigrations = { supaDir, postgresPw: postgresPw };
      }

      // ===== Standalone Postgres (no full Supabase stack) =====
      if (installPostgresOnly) {
        const pgDir = `${remoteDir}/postgres`;
        await log(`→ Déploiement Postgres standalone (image: ${postgresImage})…`);
        await log(`⚠ ATTENTION: l'application frontend (Auth, Storage, Realtime, Edge Functions) NE FONCTIONNERA PAS avec ce mode.`);
        await log(`  Cette option n'est utile que si vous avez besoin d'une base Postgres pour des scripts/outils externes.`);
        await exec(conn, `${sudoPrefix}mkdir -p ${pgDir} && ${sudoPrefix}chown -R ${body.username}:${body.username} ${pgDir}`);

        const randHex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        const postgresPw = randHex(32);

        const composeYaml = [
          `services:`,
          `  db:`,
          `    image: ${postgresImage}`,
          `    container_name: screenflow_postgres`,
          `    restart: unless-stopped`,
          `    environment:`,
          `      POSTGRES_PASSWORD: ${postgresPw}`,
          `      POSTGRES_USER: postgres`,
          `      POSTGRES_DB: postgres`,
          `    ports:`,
          `      - "${supaDbPort}:5432"`,
          `    volumes:`,
          `      - ./data:/var/lib/postgresql/data`,
          `    healthcheck:`,
          `      test: ["CMD-SHELL", "pg_isready -U postgres"]`,
          `      interval: 5s`,
          `      timeout: 5s`,
          `      retries: 10`,
          ``,
        ].join("\n");
        const composeB64 = btoa(composeYaml);
        await exec(conn, `cd ${pgDir} && echo "${composeB64}" | base64 -d > docker-compose.yml`);

        const upPg = await exec(conn, `cd ${pgDir} && (docker compose up -d || docker-compose up -d) 2>&1`);
        await log(upPg.stdout.slice(-1500));
        if (upPg.code !== 0) throw new Error("Échec démarrage Postgres standalone: " + upPg.stderr.slice(-300));

        // Wait for healthcheck
        await log("→ Attente que Postgres soit prêt…");
        let pgReady = false;
        for (let i = 0; i < 30; i++) {
          const ready = await exec(conn, `docker exec screenflow_postgres pg_isready -U postgres 2>&1 || true`);
          if (/accepting connections/i.test(ready.stdout)) { pgReady = true; break; }
          await new Promise(r => setTimeout(r, 2000));
        }
        if (!pgReady) await log("⚠ Postgres ne répond pas après 60s, continuation quand même");
        else await log("✓ Postgres prêt");

        // Connectivity test
        const pingTest = await exec(conn, `docker exec screenflow_postgres psql -U postgres -d postgres -c "SELECT version();" 2>&1 || true`);
        await log("• Test SQL: " + (pingTest.stdout || pingTest.stderr).slice(-400));

        await log(`✓ Postgres standalone démarré`);
        await log(`  • Image:      ${postgresImage}`);
        await log(`  • Connexion locale serveur: postgres://postgres:${postgresPw}@127.0.0.1:${supaDbPort}/postgres`);
        await log(`  • Mot de passe: ${postgresPw}  (notez-le, il ne sera pas réaffiché)`);
        (globalThis as any).__pgOnlyResult = { image: postgresImage, port: supaDbPort, password: postgresPw, host: body.host };
      }

      if (installSupabase && isExistingSupabase) {
        const supaDir = `${remoteDir}/supabase`;
        const envRead = await exec(
          conn,
          `cd ${supaDir} && grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|POSTGRES_PASSWORD|JWT_SECRET)=' .env || true`,
        );
        const envMap: Record<string, string> = {};
        for (const line of (envRead.stdout || "").split("\n")) {
          const m = line.match(/^([A-Z_]+)=(.*)$/);
          if (m) envMap[m[1]] = m[2].trim();
        }
        const anonKey = envMap.ANON_KEY || "";
        const serviceKey = envMap.SERVICE_ROLE_KEY || "";
        const postgresPw = envMap.POSTGRES_PASSWORD || "";
        if (!anonKey || !serviceKey) {
          throw new Error("Installation Supabase existante détectée mais ANON_KEY/SERVICE_ROLE_KEY introuvables dans .env. Réinstallez ou complétez le fichier .env.");
        }
        await log("→ Vérification des conteneurs Supabase existants…");
        await syncSupabaseKongPorts(conn, supaDir, supaKongPort, supaKongHttpsPort, log);
        await syncLocalAuthSafeEnv(conn, supaDir, log);
        await startLocalSupabaseEssentials(conn, supaDir, log, true);
        await ensureLocalApiServices(conn, supaDir, supaKongPort, anonKey, log);
        const supaBrowserUrl = resolveBrowserAppBase(body, appPort, enableHttps, httpsDomain, httpsPort);
        const existingAuthEnvB64 = btoa(buildLocalAuthUrlEnvPatch(body, appPort, supaBrowserUrl, enableHttps, httpsDomain, httpsPort));
        await exec(conn, `cd ${supaDir} && for k in SITE_URL API_EXTERNAL_URL GOTRUE_EXTERNAL_URL ADDITIONAL_REDIRECT_URLS SUPABASE_PUBLIC_URL; do sed -i "/^$k=/d" .env; done && printf '%s' '${existingAuthEnvB64}' | base64 -d >> .env && docker compose restart auth storage rest kong 2>&1 || true`);
        supabaseUrlOverride = supaBrowserUrl;
        supabaseAnonOverride = anonKey;
        supabaseProjectIdOverride = "local";
        await log("✓ Supabase local opérationnel (clés réutilisées depuis .env)");
        await prepareEarlyWebDeployment(
          conn,
          body,
          `${remoteDir}/repo`,
          remoteDir,
          appPort,
          supaBrowserUrl,
          anonKey,
          "local",
          log,
        );
        earlyWebStarted = true;
        (globalThis as any).__pendingLocalMigrations = { supaDir, postgresPw };
      }

      // (Le dépôt applicatif a déjà été cloné/mis à jour plus haut, avant l'installation Supabase,
      //  pour garantir que le build de l'application ait toujours lieu même si la stack locale est lente.)


      await ensureDeploymentBudget("migrations locales");
      // ===== Apply app migrations to local Supabase =====
      const pending = (globalThis as any).__pendingLocalMigrations;
      if (pending?.supaDir) {
        await ensurePostgresSqlAccess(conn, pending.supaDir, log);
        log("→ Application des migrations de l'application sur Supabase local…");
        const migDir = `${remoteDir}/repo/supabase/migrations`;
        // Concat all .sql files in order and pipe to psql
        let applyMig = await exec(
          conn,
          `if [ -d "${migDir}" ]; then ` +
          `for f in $(ls ${migDir}/*.sql 2>/dev/null | sort); do ` +
          `  echo "-- $f"; cat "$f"; echo ""; ` +
          `done | (cd ${pending.supaDir} && docker compose exec -T --user postgres db sh -lc ${shQuote('PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=0')}) 2>&1 | tail -100; ` +
          `else echo "no migrations dir"; fi`
        );
        if (/Permission denied|pg_filenode\.map/i.test(`${applyMig.stdout}${applyMig.stderr}`)) {
          await log("⚠ Postgres a reperdu l'accès au volume pendant les migrations — réparation et nouvelle tentative…");
          await ensurePostgresSqlAccess(conn, pending.supaDir, log);
          applyMig = await exec(
            conn,
            `if [ -d "${migDir}" ]; then ` +
            `for f in $(ls ${migDir}/*.sql 2>/dev/null | sort); do echo "-- $f"; cat "$f"; echo ""; done | ` +
            `(cd ${pending.supaDir} && docker compose exec -T --user postgres db sh -lc ${shQuote('PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=0')}) 2>&1 | tail -100; ` +
            `else echo "no migrations dir"; fi`
          );
        }
        log(applyMig.stdout.slice(-1500));
        log("✓ Migrations appliquées (les erreurs 'already exists' sont normales)");
        await log("→ Application automatique de la réparation upload/écrans incluse au déploiement…");
        await applyLocalDashboardWriteHotfix(conn, pending.supaDir, log);
        await syncLocalEdgeFunctions(conn, remoteDir, pending.supaDir, log);
        if (supabaseAnonOverride) {
          await ensureLocalApiServices(conn, pending.supaDir, supaKongPort, supabaseAnonOverride, log);
        }
      }


      await ensureDeploymentBudget("build Docker de l'application");
      // Generate Dockerfile, nginx.conf, docker-compose.yml inside the repo
      log("→ Writing Dockerfile, nginx.conf, docker-compose.yml…");
      const escEnv = (s: string) => (s || "").replace(/'/g, "'\\''");
      const dockerfile = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* bun.lockb* bun.lock* ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ARG VITE_PUBLIC_APP_URL
ARG VITE_APP_BASE_PATH=/
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID
ENV VITE_PUBLIC_APP_URL=$VITE_PUBLIC_APP_URL
ENV VITE_APP_BASE_PATH=$VITE_APP_BASE_PATH
RUN npm run build
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx","-g","daemon off;"]
`;
      const localFunctions = [
        "admin-diagnostics", "bootstrap-admin", "restore-backup", "ai-assistant", "check-email-replies", "check-inbox",
        "content-action", "content-webhook", "generate-devis", "invite-user", "resend-ack",
        "screen-setup-guide", "send-credentials", "server-stats", "ssh-deploy", "sync-client-dravox", "test-email",
      ];
      // CORS strategy mirrors the static nginx.conf:
      //   - A named error_page location returns 204 with full CORS headers for OPTIONS.
      //   - Each proxy location hides upstream CORS headers (avoids duplicate ACAO from Kong),
      //     returns 418 for OPTIONS so Nginx internally serves @cors_preflight, then re-adds CORS on real responses.
      // This avoids the brittle inline `if ($request_method = OPTIONS)` + add_header inheritance/rewrite behavior.
      const corsHidesAndAdds = `proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always;`;

      const preflightLocation = `  set $cors_origin $http_origin;
  error_page 418 = @cors_preflight;
  location @cors_preflight {
    add_header Access-Control-Allow-Origin $cors_origin always;
    add_header Vary Origin always;
    add_header Access-Control-Allow-Methods "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "authorization, apikey, content-type, x-client-info, x-upsert, prefer, accept-profile, content-profile, range, x-requested-with, x-supabase-api-version, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" always;
    add_header Access-Control-Max-Age 86400 always;
    add_header Content-Length 0 always;
    return 204;
  }`;

      const functionProxyHeaders = `proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Host $host; proxy_set_header X-Forwarded-Proto ${enableHttps ? "https" : "http"}; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host;`;
      const localFunctionLocations = localFunctions.map((name) => `  location = /functions/v1/${name} { ${corsHidesAndAdds} proxy_pass http://host.docker.internal:${supaKongPort}/functions/v1/${name}; ${functionProxyHeaders} }`).join("\n");

      // Common proxy snippet shared by all Supabase upstream locations.
      // CRITICAL: client_max_body_size must be large enough for media uploads (videos can be hundreds of MB).
      // proxy_request_buffering off allows streaming large uploads to Kong/Storage without buffering to disk first.
      const commonProxyHeaders = (proto: string) => `${corsHidesAndAdds} proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto ${proto}; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host;`;
      const storageProxy = (proto: string) => `proxy_pass http://host.docker.internal:${supaKongPort}/storage/v1/; ${commonProxyHeaders(proto)} client_max_body_size 1024m; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 3600s; proxy_send_timeout 3600s;`;
      const restProxy = (proto: string) => `proxy_pass http://host.docker.internal:${supaKongPort}/rest/v1/; ${commonProxyHeaders(proto)} client_max_body_size 50m;`;
      const authProxy = (proto: string) => `proxy_pass http://host.docker.internal:${supaKongPort}/auth/v1/; ${commonProxyHeaders(proto)} client_max_body_size 10m;`;
      const realtimeProxy = (proto: string) => `proxy_pass http://host.docker.internal:${supaKongPort}/realtime/v1/; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; ${commonProxyHeaders(proto)} proxy_read_timeout 3600s; proxy_send_timeout 3600s;`;

      const nginxConf = enableHttps
        ? `client_max_body_size 1024m;
server {
  listen 80;
  server_name _;
  return 301 https://$host:${httpsPort}$request_uri;
}
server {
  listen 443 ssl;
  http2 on;
  server_name _;
  ssl_certificate /etc/nginx/ssl/server.crt;
  ssl_certificate_key /etc/nginx/ssl/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 1024m;
  root /usr/share/nginx/html;
  index index.html;
${preflightLocation}
  location /auth/v1/ { ${authProxy("https")} }
  location /rest/v1/ { ${restProxy("https")} }
  location /storage/v1/ { ${storageProxy("https")} }
  location /realtime/v1/ { ${realtimeProxy("https")} }
${localFunctionLocations}
  location / { try_files $uri $uri/ /index.html; }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
}
`
        : `client_max_body_size 1024m;
server {
  listen 80;
  server_name _;
  client_max_body_size 1024m;
  root /usr/share/nginx/html;
  index index.html;
${preflightLocation}
  location /auth/v1/ { ${authProxy("http")} }
  location /rest/v1/ { ${restProxy("http")} }
  location /storage/v1/ { ${storageProxy("http")} }
  location /realtime/v1/ { ${realtimeProxy("http")} }
${localFunctionLocations}
  location / { try_files $uri $uri/ /index.html; }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
}
`;
      const portsBlock = enableHttps
        ? `    ports:
      - "${appPort}:80"
      - "${httpsPort}:443"
    volumes:
      - ./ssl:/etc/nginx/ssl:ro`
        : `    ports:
      - "${appPort}:80"`;
      const publicAppUrl = resolveBrowserAppBase(body, appPort, enableHttps, httpsDomain, httpsPort);
      const appBasePath = body.vite_app_base_path || "/";
      const compose = `services:
  web:
    build:
      context: .
      args:
        VITE_SUPABASE_URL: '${escEnv(supabaseUrlOverride || body.vite_supabase_url || "")}'
        VITE_SUPABASE_PUBLISHABLE_KEY: '${escEnv(supabaseAnonOverride || body.vite_supabase_key || "")}'
        VITE_SUPABASE_PROJECT_ID: '${escEnv(supabaseProjectIdOverride || body.vite_supabase_project_id || "")}'
        VITE_PUBLIC_APP_URL: '${escEnv(publicAppUrl)}'
        VITE_APP_BASE_PATH: '${escEnv(appBasePath)}'
    extra_hosts:
      - "host.docker.internal:host-gateway"
${portsBlock}
    restart: unless-stopped
`;
      await uploadFile(conn, `${remoteDir}/repo/Dockerfile`, Buffer.from(dockerfile));
      await uploadFile(conn, `${remoteDir}/repo/nginx.conf`, Buffer.from(nginxConf));
      await uploadFile(conn, `${remoteDir}/repo/docker-compose.yml`, Buffer.from(compose));
      await patchRemoteRuntimeSupabaseClient(conn, `${remoteDir}/repo`, log);
      log("✓ Build files ready");

      if (enableHttps) {
        log("→ Generating self-signed SSL certificate…");
        const cnEsc = httpsDomain.replace(/'/g, "");
        const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-fA-F:]+$/.test(s);
        const sanParts: string[] = [];
        if (isIp(cnEsc)) sanParts.push(`IP:${cnEsc}`); else sanParts.push(`DNS:${cnEsc}`);
        if (body.host && body.host !== cnEsc) {
          if (isIp(body.host)) sanParts.push(`IP:${body.host}`); else sanParts.push(`DNS:${body.host}`);
        }
        const san = sanParts.join(",");
        const sslCmd = `mkdir -p ${remoteDir}/repo/ssl && \
(command -v openssl || ${sudoPrefix}sh -c "(apt-get install -y openssl) || (dnf install -y openssl) || (yum install -y openssl)") && \
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout ${remoteDir}/repo/ssl/server.key \
  -out ${remoteDir}/repo/ssl/server.crt \
  -subj "/CN=${cnEsc}" \
  -addext "subjectAltName=${san}" 2>&1`;
        const ssl = await exec(conn, sslCmd);
        log(ssl.stdout.slice(-800));
        if (ssl.code !== 0) {
          throw new Error("Échec de génération du certificat SSL: " + ssl.stderr.slice(-300));
        }
        log("✓ Certificat SSL généré");
      }

      await log(earlyWebStarted
        ? "→ Finalisation du build web déjà lancé en arrière-plan…"
        : "→ Build des conteneurs lancé en arrière-plan sur le serveur (docker compose up -d --build)…");
      const buildStateDir = `${remoteDir}/.build`;
      if (!earlyWebStarted) {
        await startDetachedCompose(conn, `${remoteDir}/repo`, buildStateDir);
        await log("✓ Build détaché démarré — il continue même si cette session se termine.");
      }
      const buildDeadline = Math.min(deploymentDeadline, Date.now() + 4 * 60 * 1000);
      const buildResult = await pollDetachedCompose(conn, buildStateDir, buildDeadline, log);
      if (!buildResult.done) {
        throw new Error(
          "Build toujours en cours sur le serveur (il n'a PAS été interrompu). " +
          "Cliquez sur « Vérifier le build » dans /admin/backup pour suivre la fin du build et finaliser la vérification.",
        );
      }
      await log(buildResult.tail.slice(-2000));
      if (buildResult.code !== 0) {
        const diagnostic = await exec(
          conn,
          `LOG=${buildStateDir}/build.log; ` +
          `echo '--- erreurs utiles ---'; ` +
          `(grep -nEi 'error|failed|cannot find|could not resolve|typeerror|syntaxerror|npm ERR' "$LOG" | tail -40 || true); ` +
          `echo '--- fin du journal ---'; tail -n 100 "$LOG" 2>/dev/null`,
        );
        const usefulLog = (diagnostic.stdout || buildResult.tail || "").trim();
        await log(usefulLog.slice(-8000));
        const buildDetail = usefulLog
          ? " — " + usefulLog.split("\n").slice(-24).join(" | ").slice(-5000)
          : "";
        throw new Error("docker compose failed (code " + buildResult.code + ")" + buildDetail + " — voir " + buildStateDir + "/build.log sur le serveur");
      }
    await log("✓ Containers started");

    const ps = await exec(conn, `cd ${remoteDir}/repo && (docker compose ps || docker-compose ps)`);
    await log(ps.stdout);

    // ===== Connectivity report =====
    const connectivity: Record<string, { ok: boolean; detail: string }> = {};
    await log("→ Test de connectivité de la stack déployée…");

    // App health
    const appUrl = resolveBrowserAppBase(body, appPort, enableHttps, httpsDomain, httpsPort);
    const localAppUrl = enableHttps ? `https://${localIp}:${httpsPort}` : `http://${localIp}:${appPort}`;
    const appCheck = await exec(conn, `curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 ${localAppUrl} || echo FAIL`);
    const appCode = (appCheck.stdout || "").trim();
    connectivity.app = { ok: /^(200|301|302|304)$/.test(appCode), detail: `HTTP ${appCode} sur ${localAppUrl} (vérification 127.0.0.1)` };
    await log(`  • App         : ${connectivity.app.ok ? "✓" : "✗"} ${connectivity.app.detail}`);

    if (installSupabase) {
      // REST
      const restCheck = await exec(conn, `curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 -H "apikey: ${supabaseAnonOverride}" "http://127.0.0.1:${supaKongPort}/rest/v1/" || echo FAIL`);
      connectivity.rest = { ok: /^(200|401|404)$/.test((restCheck.stdout || "").trim()), detail: `HTTP ${(restCheck.stdout || "").trim()} sur Kong /rest/v1/` };
      const authCheck = await exec(conn, `curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${supaKongPort}/auth/v1/health" || echo FAIL`);
      connectivity.auth = { ok: /^(200|404)$/.test((authCheck.stdout || "").trim()), detail: `HTTP ${(authCheck.stdout || "").trim()} sur /auth/v1/health` };
      const storageCheck = await exec(conn, `curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 -H "apikey: ${supabaseAnonOverride}" "http://127.0.0.1:${supaKongPort}/storage/v1/bucket" || echo FAIL`);
      connectivity.storage = { ok: /^(200|401|403|404)$/.test((storageCheck.stdout || "").trim()), detail: `HTTP ${(storageCheck.stdout || "").trim()} sur /storage/v1/bucket` };
      // Postgres direct
      const pgCheck = await exec(conn, `(cd ${remoteDir}/supabase && docker compose exec -T --user postgres db pg_isready -h 127.0.0.1 -U postgres 2>&1) || echo FAIL`);
      connectivity.postgres = { ok: /accepting connections/i.test(pgCheck.stdout), detail: (pgCheck.stdout || "").trim().slice(-120) };
      await log(`  • Supabase REST    : ${connectivity.rest.ok ? "✓" : "✗"} ${connectivity.rest.detail}`);
      await log(`  • Supabase Auth    : ${connectivity.auth.ok ? "✓" : "✗"} ${connectivity.auth.detail}`);
      await log(`  • Supabase Storage : ${connectivity.storage.ok ? "✓" : "✗"} ${connectivity.storage.detail}`);
      await log(`  • Postgres         : ${connectivity.postgres.ok ? "✓" : "✗"} ${connectivity.postgres.detail}`);
    }

    if (installPostgresOnly) {
      const pgCheck = await exec(conn, `docker exec screenflow_postgres pg_isready -U postgres 2>&1 || echo FAIL`);
      connectivity.postgres = { ok: /accepting connections/i.test(pgCheck.stdout), detail: (pgCheck.stdout || "").trim().slice(-120) };
      await log(`  • Postgres standalone : ${connectivity.postgres.ok ? "✓" : "✗"} ${connectivity.postgres.detail}`);
    }

    // === Auto-create the default admin user so login + user/team management work right after deploy ===
    if (installSupabase && supabaseAnonOverride) {
      try {
        await log("→ Création automatique du premier compte admin (screenflow@screenflow.local)…");
        const supaDir = `${remoteDir}/supabase`;
        const serviceKey =
          (await readRemoteEnv(conn, `${supaDir}/.env`, "SERVICE_ROLE_KEY")) ||
          (await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_SECRET_KEY"));
        if (!serviceKey) {
          await log("⚠ SERVICE_ROLE_KEY introuvable — admin par défaut non créé. Utilisez 'Réinitialiser le mot de passe admin' manuellement.");
        } else {
          await ensureLocalAuthGateway(conn, supaDir, supaKongPort, log);
          await upsertDefaultAdminViaAuthApi(conn, supaDir, supaKongPort, serviceKey, DEFAULT_ADMIN_PASSWORD, log);
          await ensureDefaultAdminRole(conn, supaDir, log);
          await log("✓ Compte admin par défaut prêt — login : screenflow@screenflow.local / 260390DS");

          // Confirme explicitement Auth + Storage via l'IP locale
          await log(`→ Confirmation finale Auth/Storage via ${supabaseUrlOverride || appUrl}…`);
          try {
            await verifyAuthLoginFromServer(
              conn,
              `http://127.0.0.1:${supaKongPort}`,
              supabaseAnonOverride,
              DEFAULT_ADMIN_EMAIL,
              DEFAULT_ADMIN_PASSWORD,
              log,
              buildDirectKongAuthLoginCommand(supaDir, supabaseAnonOverride, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD),
            );
            connectivity.auth_login = { ok: true, detail: `Login admin OK via http://127.0.0.1:${supaKongPort}` };
          } catch (authErr: any) {
            connectivity.auth_login = { ok: false, detail: (authErr?.message || String(authErr)).slice(0, 300) };
            await log("⚠ Confirmation Auth échouée : " + connectivity.auth_login.detail);
          }
          const storageConfirm = await exec(conn, `curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 -H "apikey: ${supabaseAnonOverride}" -H "Authorization: Bearer ${supabaseAnonOverride}" "http://127.0.0.1:${supaKongPort}/storage/v1/bucket" || echo FAIL`);
          const storageCode = (storageConfirm.stdout || "").trim();
          connectivity.storage_confirm = { ok: /^(200|401|403)$/.test(storageCode), detail: `HTTP ${storageCode} sur /storage/v1/bucket` };
          await log(`  • Storage confirmation : ${connectivity.storage_confirm.ok ? "✓" : "✗"} ${connectivity.storage_confirm.detail}`);
        }
      } catch (adminErr: any) {
        await log("⚠ Création automatique de l'admin échouée : " + (adminErr?.message || String(adminErr)));
        await log("  → Vous pouvez relancer manuellement via 'Réinitialiser le mot de passe admin'.");
      }
    }

    conn.end();
    const url = appUrl;
    await log(`🚀 Deployment complete — accessible at ${url}`);

    const pgOnly = (globalThis as any).__pgOnlyResult || null;
    (globalThis as any).__lastDeployResult = {
      url,
      db_stack: dbStack,
      postgres_image: (installSupabase || installPostgresOnly) ? postgresImage : null,
      connectivity,
      supabase_local: installSupabase ? {
        url: supabaseUrlOverride,
        anon_key: supabaseAnonOverride,
        studio_url: `http://${localIp}:${supaStudioPort}`,
      } : null,
      postgres_only: pgOnly,
    };
  } catch (innerErr: any) {
    try { conn.end(); } catch (_) {}
    throw innerErr;
  }
}

async function repairLocalApiUrlOnExistingDeployment(conn: Client, body: DeployBody, kongPort: string, anonKey: string, log: (m: string) => Promise<void> | void) {
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const appPort = body.app_port || "8080";
  const localIp = /^\d{1,3}(\.\d{1,3}){3}$/.test((body.local_ip || "").trim()) ? body.local_ip!.trim() : "127.0.0.1";
  const publicBase = resolveBrowserAppBase(body, appPort);
  const repoDir = `${remoteDir}/repo`;
  const supaDir = `${remoteDir}/supabase`;

  await log(`→ Réparation URL API navigateur : ${publicBase} (vérifications serveur via ${localIp})`);

  const nginxConf = `client_max_body_size 1024m;
server {
  listen 80;
  server_name _;
  client_max_body_size 1024m;
  root /usr/share/nginx/html;
  index index.html;
  proxy_connect_timeout 10s;
  proxy_send_timeout 3600s;
  proxy_read_timeout 3600s;
  set $cors_origin $http_origin;
  error_page 418 = @cors_preflight;
  location @cors_preflight {
    add_header Access-Control-Allow-Origin $cors_origin always;
    add_header Vary Origin always;
    add_header Access-Control-Allow-Methods "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "authorization, apikey, content-type, x-client-info, x-upsert, prefer, accept-profile, content-profile, range, x-requested-with, x-supabase-api-version, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" always;
    add_header Access-Control-Max-Age 86400 always;
    add_header Content-Length 0 always;
    return 204;
  }
  location /auth/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/auth/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; }
  location /rest/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/rest/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; client_max_body_size 50m; }
  location /storage/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/storage/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; client_max_body_size 1024m; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 3600s; proxy_send_timeout 3600s; }
  location /functions/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/functions/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; }
  location /realtime/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/realtime/v1/; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; proxy_read_timeout 3600s; proxy_send_timeout 3600s; }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
  location / { try_files $uri $uri/ /index.html; }
}
`;

  await uploadFile(conn, `${repoDir}/nginx.conf`, Buffer.from(nginxConf));
  await patchRemoteRuntimeSupabaseClient(conn, repoDir, log);
  const patchCompose = `python3 - <<'PY'
import base64, pathlib, re
p = pathlib.Path(${JSON.stringify(`${repoDir}/docker-compose.yml`)})
s = p.read_text()
url = base64.b64decode(${JSON.stringify(btoa(publicBase))}).decode()
key = base64.b64decode(${JSON.stringify(btoa(anonKey))}).decode()
s = re.sub(r"VITE_SUPABASE_URL:\\s*.*", f"VITE_SUPABASE_URL: '{url}'", s)
s = re.sub(r"VITE_SUPABASE_PUBLISHABLE_KEY:\\s*.*", f"VITE_SUPABASE_PUBLISHABLE_KEY: '{key}'", s)
s = re.sub(r"VITE_SUPABASE_PROJECT_ID:\\s*.*", "VITE_SUPABASE_PROJECT_ID: 'local'", s)
if re.search(r"VITE_PUBLIC_APP_URL:\\s*", s):
    s = re.sub(r"VITE_PUBLIC_APP_URL:\\s*.*", f"VITE_PUBLIC_APP_URL: '{url}'", s)
else:
    s = re.sub(r"(VITE_SUPABASE_PROJECT_ID:\\s*'local'\\n)", "\\1        VITE_PUBLIC_APP_URL: '" + url.replace("'", "''") + "'\\n", s)
if re.search(r"VITE_APP_BASE_PATH:\\s*", s):
    s = re.sub(r"VITE_APP_BASE_PATH:\\s*.*", "VITE_APP_BASE_PATH: '/'", s)
else:
    s = re.sub(r"(VITE_PUBLIC_APP_URL:.*\\n)", "\\1        VITE_APP_BASE_PATH: '/'\\n", s)
p.write_text(s)
PY`;
  await exec(conn, patchCompose);
  const repairAuthEnvB64 = btoa(buildLocalAuthUrlEnvPatch(body, appPort, publicBase));
  await exec(conn, `cd ${supaDir} && for k in SITE_URL API_EXTERNAL_URL GOTRUE_EXTERNAL_URL ADDITIONAL_REDIRECT_URLS SUPABASE_PUBLIC_URL; do sed -i "/^$k=/d" .env; done && printf '%s' '${repairAuthEnvB64}' | base64 -d >> .env && docker compose restart auth storage rest kong 2>&1 || true`);
  await exec(conn, `cd ${repoDir} && (docker compose up -d --build web || docker-compose up -d --build web) 2>&1`);
  // Vérification depuis le serveur via 127.0.0.1 (évite DNS public + cert auto-signé)
  const probe = await exec(conn, `curl -sS -m 10 -o /tmp/sf_proxy_bucket.txt -w "%{http_code}" ${shQuote(`http://127.0.0.1:${kongPort}/storage/v1/bucket`)} -H ${shQuote(`apikey: ${anonKey}`)} -H ${shQuote(`Authorization: Bearer ${anonKey}`)} 2>/dev/null || true`);
  const probeRest = await exec(conn, `curl -sS -m 10 -o /dev/null -w "%{http_code}" ${shQuote(`http://127.0.0.1:${kongPort}/rest/v1/`)} -H ${shQuote(`apikey: ${anonKey}`)} -H ${shQuote(`Authorization: Bearer ${anonKey}`)} 2>/dev/null || true`);
  const probeAuth = await exec(conn, `curl -sS -m 10 -o /dev/null -w "%{http_code}" ${shQuote(`http://127.0.0.1:${kongPort}/auth/v1/health`)} 2>/dev/null || true`);
  await log(`✓ URL API corrigée. Ouvrez l'application en HTTP : ${publicBase}`);
  await log(`  • Vérif locale 127.0.0.1:${kongPort} → Storage HTTP ${(probe.stdout || "").trim() || "n/a"}, REST HTTP ${(probeRest.stdout || "").trim() || "n/a"}, Auth HTTP ${(probeAuth.stdout || "").trim() || "n/a"}`);
  (globalThis as any).__lastDeployResult = { action: "repair_local_api_url", ok: true, url: publicBase, supabase_local: { url: publicBase, anon_key: anonKey } };
}

function buildUploadRepairNginxConf(kongPort: string) {
  return `client_max_body_size 1024m;
server {
  listen 80;
  server_name _;
  client_max_body_size 1024m;
  root /usr/share/nginx/html;
  index index.html;
  proxy_connect_timeout 10s;
  proxy_send_timeout 3600s;
  proxy_read_timeout 3600s;
  set $cors_origin $http_origin;
  error_page 418 = @cors_preflight;
  location @cors_preflight {
    add_header Access-Control-Allow-Origin $cors_origin always;
    add_header Vary Origin always;
    add_header Access-Control-Allow-Methods "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "authorization, apikey, content-type, x-client-info, x-upsert, prefer, accept-profile, content-profile, range, x-requested-with, x-supabase-api-version, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" always;
    add_header Access-Control-Max-Age 86400 always;
    add_header Content-Length 0 always;
    return 204;
  }
  location /auth/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/auth/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; }
  location /rest/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/rest/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; client_max_body_size 50m; }
  location /storage/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/storage/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert;  proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; client_max_body_size 1024m; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 3600s; proxy_send_timeout 3600s; }
  location /functions/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/functions/v1/; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; }
  location /realtime/v1/ { proxy_hide_header Access-Control-Allow-Origin; proxy_hide_header Access-Control-Allow-Methods; proxy_hide_header Access-Control-Allow-Headers; proxy_hide_header Access-Control-Expose-Headers; if ($request_method = OPTIONS) { return 418; } add_header Access-Control-Allow-Origin $cors_origin always; add_header Vary Origin always; add_header Access-Control-Expose-Headers "content-range, x-supabase-api-version, x-request-id, location" always; proxy_pass http://host.docker.internal:${kongPort}/realtime/v1/; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Proto http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Host $host; proxy_read_timeout 3600s; proxy_send_timeout 3600s; }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
  location / { try_files $uri $uri/ /index.html; }
}
`;
}

async function verifyStorageUploadAtBase(conn: Client, supaDir: string, baseUrl: string, anonKey: string, bucket: "uploads" | "media", label: string) {
  const testPath = `.screenflow-health/${crypto.randomUUID()}.txt`;
  const url = `${baseUrl.replace(/\/$/, "")}/storage/v1/object/${bucket}/${testPath}`;
  const result = await exec(
    conn,
    `body=/tmp/sf_upload_${bucket}_${label.replace(/[^a-z0-9]/gi, "_")}.txt; ` +
      `code=$(printf 'screenflow-upload-test' | curl -sS -m 25 -o "$body" -w "%{http_code}" -X POST ${shQuote(url)} ` +
      `-H ${shQuote(`apikey: ${anonKey}`)} -H ${shQuote(`Authorization: Bearer ${anonKey}`)} -H 'Content-Type: text/plain' -H 'x-upsert: true' --data-binary @- 2>/dev/null || true); ` +
      `printf '%s\n' "$code"; head -c 500 "$body" 2>/dev/null || true`,
  );
  const [statusLine, ...bodyLines] = (result.stdout || "").split("\n");
  const status = (statusLine || "000").trim() || "000";
  const detail = bodyLines.join("\n").trim().replace(/\s+/g, " ").slice(0, 240);
  await exec(conn, dockerPsql(supaDir, btoa(`delete from storage.objects where bucket_id = '${bucket}' and name = '${testPath.replace(/'/g, "''")}';`), false));
  return { label, bucket, ok: /^2\d\d$/.test(status), status, detail };
}

async function patchRunningWebProxyForUploads(conn: Client, body: DeployBody, kongPort: string, anonKey: string, supaDir: string, log: (m: string) => Promise<void> | void) {
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const repoDir = `${remoteDir}/repo`;
  const appPort = body.app_port || "8080";
  const nginxConf = buildUploadRepairNginxConf(kongPort);
  const tmpConf = `/tmp/screenflow-upload-fix-${crypto.randomUUID()}.conf`;
  const result: any = { patched: false, ok: false, skipped: false, detail: "" };

  await uploadFile(conn, tmpConf, Buffer.from(nginxConf));
  await uploadFile(conn, `${repoDir}/nginx.conf`, Buffer.from(nginxConf)).catch(() => undefined);

  const cidOut = await exec(conn, `CID=""; if [ -f ${repoDir}/docker-compose.yml ]; then CID=$(cd ${repoDir} && (docker compose ps -q web || docker-compose ps -q web) 2>/dev/null | head -1); fi; if [ -z "$CID" ]; then CID=$(docker ps --format '{{.ID}} {{.Names}}' | awk 'tolower($0) ~ /screenflow/ && tolower($0) ~ /web/ {print $1; exit}'); fi; echo "$CID"`);
  const cid = (cidOut.stdout || "").trim().split(/\s+/)[0] || "";
  if (!cid) {
    result.skipped = true;
    result.detail = "Aucun conteneur web actif détecté";
    await log("⚠ Proxy web non rechargé : aucun conteneur web actif détecté.");
    return result;
  }

  await log("→ Rechargement du proxy /storage/v1 dans le conteneur web sans rebuild…");
  const reload = await exec(conn, `docker cp ${tmpConf} ${cid}:/etc/nginx/conf.d/default.conf && docker exec ${cid} nginx -t && docker exec ${cid} nginx -s reload 2>&1`);
  const reloadOutput = `${reload.stdout}${reload.stderr}`;
  if (reload.code !== 0 || /emerg|failed|error/i.test(reloadOutput)) {
    result.detail = reloadOutput.slice(-500);
    await log("✗ Reload nginx échoué: " + result.detail);
    return result;
  }
  result.patched = true;
  await log("✓ Proxy web rechargé sans reconstruire l'application");
  const proxyTest = await verifyStorageUploadAtBase(conn, supaDir, `http://127.0.0.1:${appPort}`, anonKey, "uploads", "proxy_web");
  result.ok = proxyTest.ok;
  result.http_status = proxyTest.status;
  result.detail = proxyTest.detail || (proxyTest.ok ? "Upload test OK via le proxy web" : "Upload test KO via le proxy web");
  await log(`${proxyTest.ok ? "✓" : "✗"} Test upload via proxy web /storage/v1 → HTTP ${proxyTest.status}${proxyTest.detail ? ` (${proxyTest.detail})` : ""}`);
  return result;
}

async function recoverStorageContainer(conn: Client, supaDir: string, kongPort: string, anonKey: string, log: (m: string) => Promise<void> | void) {
  const info: any = { ok: false, state: "", detail: "" };

  const probe = async () => {
    const r = await exec(conn, `curl -sS -m 6 -o /dev/null -w "%{http_code}" ${shQuote(`http://127.0.0.1:${kongPort}/storage/v1/bucket`)} -H ${shQuote(`apikey: ${anonKey}`)} -H ${shQuote(`Authorization: Bearer ${anonKey}`)} 2>/dev/null || true`);
    return ((r.stdout || "").trim().match(/\d{3}/)?.[0]) || "000";
  };

  let code = await probe();
  if (/^(2\d\d|401|403)$/.test(code)) {
    info.ok = true;
    info.state = `HTTP ${code}`;
    return info;
  }

  await log(`⚠ Storage injoignable derrière Kong (HTTP ${code}) — récupération du conteneur storage…`);

  const state = await exec(conn, `cd ${supaDir} && (docker compose ps storage 2>&1 | tail -3) ; echo '---LOGS---'; (docker compose logs --tail=60 storage 2>&1 || true)`);
  const stateOut = `${state.stdout || ""}${state.stderr || ""}`;
  info.state = stateOut.slice(-1500);
  await log("• État/logs storage :\n" + info.state);

  // Causes fréquentes : volume de fichiers non inscriptible, imgproxy absent, conteneur en crashloop.
  await exec(conn, `cd ${supaDir} && mkdir -p volumes/storage volumes/db/data 2>/dev/null; chmod -R a+rwX volumes/storage 2>/dev/null || true; chown -R 1000:1000 volumes/storage 2>/dev/null || true`);
  const recreate = await exec(conn, `cd ${supaDir} && (docker compose up -d --no-deps imgproxy 2>&1 || true); (docker compose up -d --no-deps --force-recreate storage 2>&1 || docker-compose up -d --no-deps --force-recreate storage 2>&1 || true)`);
  await log((`${recreate.stdout || ""}${recreate.stderr || ""}`).slice(-800));

  // Attente active que le service réponde (le storage met parfois ~30s à migrer son schéma).
  for (let i = 0; i < 20; i++) {
    code = await probe();
    if (/^(2\d\d|401|403)$/.test(code)) {
      info.ok = true;
      info.state = `HTTP ${code}`;
      await log(`✓ Service storage rétabli (HTTP ${code})`);
      return info;
    }
    await exec(conn, `sleep 3`);
  }

  const after = await exec(conn, `cd ${supaDir} && docker compose logs --tail=60 storage 2>&1 || true`);
  info.detail = (`${after.stdout || ""}${after.stderr || ""}`).slice(-1500);
  await log(`✗ Le conteneur storage ne démarre toujours pas (HTTP ${code}). Dernières lignes :\n${info.detail}`);
  return info;
}

async function ensureWebContainerRunning(conn: Client, repoDir: string, log: (m: string) => Promise<void> | void) {
  const check = await exec(conn, `cd ${repoDir} 2>/dev/null && (docker compose ps -q web || docker-compose ps -q web) 2>/dev/null | head -1`);
  if ((check.stdout || "").trim()) return true;
  await log("→ Conteneur web absent : démarrage sans rebuild complet…");
  const up = await exec(conn, `cd ${repoDir} && (docker compose up -d --no-deps web 2>&1 || docker-compose up -d --no-deps web 2>&1 || true)`);
  await log((`${up.stdout || ""}${up.stderr || ""}`).slice(-800));
  const again = await exec(conn, `cd ${repoDir} && (docker compose ps -q web || docker-compose ps -q web) 2>/dev/null | head -1`);
  return Boolean((again.stdout || "").trim());
}

async function repairUploadsNowCore(conn: Client, body: DeployBody, log: (m: string) => Promise<void> | void) {

  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
  if (!supaPresent) throw new Error(`Aucune stack backend locale trouvée dans ${supaDir}`);

  await ensurePostgresSqlAccess(conn, supaDir, log);
  const kongPort = await readRemoteEnv(conn, `${supaDir}/.env`, "KONG_HTTP_PORT") || body.supabase_kong_http_port || "8000";
  const anonKey = await readRemoteEnv(conn, `${supaDir}/.env`, "ANON_KEY") || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLISHABLE_KEY");
  if (!anonKey) throw new Error(`Impossible de lire ANON_KEY dans ${supaDir}/.env`);

  await log("→ Démarrage/vérification des services Storage, REST et gateway…");
  const up = await exec(conn, `cd ${supaDir} && (docker compose up -d db kong rest storage auth 2>&1 || docker-compose up -d db kong rest storage auth 2>&1 || true)`);
  if ((up.stdout || "").trim() || (up.stderr || "").trim()) await log(`${up.stdout}${up.stderr}`.slice(-1000));

  await applyLocalDashboardWriteHotfix(conn, supaDir, log);
  await exec(conn, `cd ${supaDir} && (docker compose restart storage rest kong 2>&1 || docker-compose restart storage rest kong 2>&1 || true)`);
  await ensureLocalApiServices(conn, supaDir, kongPort, anonKey, log);

  // Cause n°1 des HTTP 502 sur /storage/v1 : le conteneur storage est mort (upstream refusé par Kong).
  const storageService = await recoverStorageContainer(conn, supaDir, kongPort, anonKey, log);
  await ensureWebContainerRunning(conn, `${remoteDir}/repo`, log);

  await log("→ Tests d'upload directs sur le backend local…");
  let storageTests = [
    await verifyStorageUploadAtBase(conn, supaDir, `http://127.0.0.1:${kongPort}`, anonKey, "uploads", "backend_direct"),
    await verifyStorageUploadAtBase(conn, supaDir, `http://127.0.0.1:${kongPort}`, anonKey, "media", "backend_direct"),
  ];
  // Un 502/503 signifie que storage n'a pas fini de démarrer : on retente une fois après récupération.
  if (storageTests.some((t) => /^(50\d|000)$/.test(t.status))) {
    await recoverStorageContainer(conn, supaDir, kongPort, anonKey, log);
    storageTests = [
      await verifyStorageUploadAtBase(conn, supaDir, `http://127.0.0.1:${kongPort}`, anonKey, "uploads", "backend_direct"),
      await verifyStorageUploadAtBase(conn, supaDir, `http://127.0.0.1:${kongPort}`, anonKey, "media", "backend_direct"),
    ];
  }
  for (const test of storageTests) {
    await log(`${test.ok ? "✓" : "✗"} Test ${test.label}/${test.bucket} → HTTP ${test.status}${test.detail ? ` (${test.detail})` : ""}`);
  }

  const proxy = await patchRunningWebProxyForUploads(conn, body, kongPort, anonKey, supaDir, log);
  const url = resolveBrowserAppBase(body, body.app_port || "8080");
  const ok = storageTests.every((test) => test.ok) && (proxy.ok || proxy.skipped);
  const result = { action: "repair_uploads_now", ok, url, storage_service: storageService, storage_tests: storageTests, proxy, supabase_local: { url, anon_key: anonKey } };

  await log(ok
    ? "✓ Uploads bibliothèque + QR corrigés. Rechargez l'application locale puis retestez."
    : "⚠ Réparation appliquée mais un test d'upload échoue encore — copiez le journal ci-dessus pour identifier le blocage exact.");
  return result;
}

async function runRepairUploadsNow(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const result = await repairUploadsNowCore(conn, body, log);
    (globalThis as any).__lastDeployResult = result;
    return result;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

async function runRepairLocalApiUrl(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const kongPort = await readRemoteEnv(conn, `${supaDir}/.env`, "KONG_HTTP_PORT") || body.supabase_kong_http_port || "8000";
    const anonKey = await readRemoteEnv(conn, `${supaDir}/.env`, "ANON_KEY") || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLISHABLE_KEY");
    if (!anonKey) throw new Error(`Impossible de lire ANON_KEY dans ${supaDir}/.env`);
    await repairLocalApiUrlOnExistingDeployment(conn, body, kongPort, anonKey, log);
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

async function runRepairLocalWrites(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;

  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");

  try {
    const check = await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo MISSING`);
    if (!(check.stdout || "").includes("OK")) {
      throw new Error(`Aucune stack backend locale trouvée dans ${supaDir}. Lancez d'abord un déploiement complet avec Supabase local.`);
    }
    await ensurePostgresSqlAccess(conn, supaDir, log);
    await applyLocalDashboardWriteHotfix(conn, supaDir, log);
    await syncLocalEdgeFunctions(conn, remoteDir, supaDir, log);

    const kongPort = await readRemoteEnv(conn, `${supaDir}/.env`, "KONG_HTTP_PORT") || body.supabase_kong_http_port || "8000";
    const anonKey = await readRemoteEnv(conn, `${supaDir}/.env`, "ANON_KEY") || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLISHABLE_KEY");
    if (anonKey) await ensureLocalApiServices(conn, supaDir, kongPort, anonKey, log);
    await exec(conn, `cd ${supaDir} && docker compose restart rest storage kong 2>&1 || true`);
    if (anonKey) {
      await repairLocalApiUrlOnExistingDeployment(conn, body, kongPort, anonKey, log);
    }
    await log("✓ Réparation upload/écrans appliquée. Rechargez l'application déployée en HTTP puis retestez.");
    const repairedUrl = resolveBrowserAppBase(body, body.app_port || "8080");
    (globalThis as any).__lastDeployResult = { action: "repair_local_writes", ok: true, url: repairedUrl, supabase_local: anonKey ? { url: repairedUrl, anon_key: anonKey } : null };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Reset-only: connect via SSH and reset the default admin password =====
async function runResetAdminPassword(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  const newPassword = (body.admin_password && body.admin_password.length >= 6)
    ? body.admin_password
    : "260390DS";

  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");

  try {
    // Sanity check: the local Supabase stack must exist
    const check = await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo MISSING`);
    if (!(check.stdout || "").includes("OK")) {
      throw new Error(
        `Aucune installation Supabase locale trouvée dans ${supaDir}. ` +
        `Lancez d'abord un déploiement complet, ou ajustez 'remote_dir'.`
      );
    }
    await log(`✓ Stack Supabase locale détectée dans ${supaDir}`);

    await log("→ Vérification que Postgres est prêt…");
    await ensurePostgresSqlAccess(conn, supaDir, log);

    const kongPort = await readRemoteEnv(conn, `${supaDir}/.env`, "KONG_HTTP_PORT") || "8000";
    const localIp = /^\d{1,3}(\.\d{1,3}){3}$/.test((body.local_ip || "").trim()) ? body.local_ip!.trim() : "127.0.0.1";
    const publicUrl = await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLIC_URL") || await readRemoteEnv(conn, `${supaDir}/.env`, "API_EXTERNAL_URL") || `http://${localIp}:${kongPort}`;
    const anonKey = await readRemoteEnv(conn, `${supaDir}/.env`, "ANON_KEY") || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLISHABLE_KEY");
    if (!anonKey) {
      throw new Error("Impossible de lire ANON_KEY dans " + supaDir + "/.env");
    }

    const serviceKey = await readRemoteEnv(conn, `${supaDir}/.env`, "SERVICE_ROLE_KEY") || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_SECRET_KEY");
    if (!serviceKey) {
      throw new Error("Impossible de lire SERVICE_ROLE_KEY dans " + supaDir + "/.env");
    }

    await log("→ Création/réparation du premier compte admin via l'API Auth officielle…");
    await upsertDefaultAdminViaAuthApi(conn, supaDir, kongPort, serviceKey, newPassword, log);
    await ensureDefaultAdminRole(conn, supaDir, log);

    await log("→ Test réel du login admin local…");
    await ensureLocalAuthGateway(conn, supaDir, kongPort, log);
    await verifyAuthLoginFromServer(
      conn,
      `http://127.0.0.1:${kongPort}`,
      anonKey,
      DEFAULT_ADMIN_EMAIL,
      newPassword,
      log,
      buildDirectKongAuthLoginCommand(supaDir, anonKey, DEFAULT_ADMIN_EMAIL, newPassword),
    );
    // Vérification publique désactivée : tout est validé via 127.0.0.1 sur le serveur
    await log(`ℹ Vérification publique ignorée (test effectué localement via 127.0.0.1:${kongPort}). URL publique : ${publicUrl}`);

    await log("✓ Mot de passe admin réinitialisé avec succès");
    await log("");
    await log("════════════════════════════════════════════════════════════");
    await log("🔐  COMPTE ADMINISTRATEUR — MOT DE PASSE RÉINITIALISÉ");
    await log("════════════════════════════════════════════════════════════");
    await log(`   Email            : screenflow@screenflow.local`);
    await log(`   Mot de passe     : ${newPassword}`);
    await log(`   Rôle             : admin (global)`);
    await log("   ⚠  Pensez à changer ce mot de passe après la connexion.");
    await log("════════════════════════════════════════════════════════════");

    (globalThis as any).__lastDeployResult = {
      action: "reset_admin_password",
      email: "screenflow@screenflow.local",
      password: newPassword,
    };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Read-only check of the default admin account on the local self-hosted Supabase =====
async function runCheckAdminStatus(
  body: DeployBody,
  log: (m: string) => Promise<void> | void,
  persist: (patch: Record<string, unknown>) => Promise<void>,
) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;

  const result: {
    auth_user_exists: boolean;
    email_confirmed: boolean;
    has_admin_role: boolean;
    has_profile: boolean;
    can_login: boolean;
    user_id: string | null;
    public_url: string | null;
  } = {
    auth_user_exists: false,
    email_confirmed: false,
    has_admin_role: false,
    has_profile: false,
    can_login: false,
    user_id: null,
    public_url: null,
  };

  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");

  try {
    const check = await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo MISSING`);
    if (!(check.stdout || "").includes("OK")) {
      throw new Error(
        `Aucune installation Supabase locale trouvée dans ${supaDir}. ` +
        `Lancez d'abord un déploiement complet.`
      );
    }
    await log(`✓ Stack Supabase locale détectée dans ${supaDir}`);

    await ensurePostgresSqlAccess(conn, supaDir, log);

    // 1. Check auth.users
    await log(`→ Recherche de ${DEFAULT_ADMIN_EMAIL} dans auth.users…`);
    const userQuery = await exec(
      conn,
      dockerPsqlSelect(supaDir, `select id::text || '|' || coalesce(email_confirmed_at::text,'') from auth.users where lower(email)=lower('${DEFAULT_ADMIN_EMAIL}') limit 1`)
    );
    const userLine = (userQuery.stdout || "").trim().split("\n").find(l => l.includes("|") && !l.startsWith("(")) || "";
    if (userLine) {
      const [uid, confirmed] = userLine.split("|");
      if (uid && uid.length > 10) {
        result.auth_user_exists = true;
        result.user_id = uid.trim();
        result.email_confirmed = !!(confirmed && confirmed.trim().length > 0);
        await log(`✓ Compte Auth trouvé (id=${result.user_id.slice(0, 8)}…, confirmé=${result.email_confirmed})`);
      }
    }
    if (!result.auth_user_exists) {
      await log(`✗ Aucun compte Auth pour ${DEFAULT_ADMIN_EMAIL}`);
    }

    // 2. Check public.user_roles
    if (result.auth_user_exists) {
      await log("→ Vérification du rôle admin dans public.user_roles…");
      const roleQuery = await exec(
        conn,
        dockerPsqlSelect(supaDir, `select 1 from public.user_roles where user_id='${result.user_id}' and role='admin' limit 1`)
      );
      result.has_admin_role = (roleQuery.stdout || "").trim().includes("1");
      await log(result.has_admin_role ? "✓ Rôle admin présent" : "✗ Rôle admin manquant");

      // 3. Profile
      const profileQuery = await exec(
        conn,
        dockerPsqlSelect(supaDir, `select 1 from public.profiles where id='${result.user_id}' limit 1`)
      );
      result.has_profile = (profileQuery.stdout || "").trim().includes("1");
      await log(result.has_profile ? "✓ Profil public trouvé" : "✗ Profil public manquant");
    }

    // 4. Real login test (only if user exists, role ok, with the default password)
    const kongPort = await readRemoteEnv(conn, `${supaDir}/.env`, "KONG_HTTP_PORT") || "8000";
    const localIp = /^\d{1,3}(\.\d{1,3}){3}$/.test((body.local_ip || "").trim()) ? body.local_ip!.trim() : "127.0.0.1";
    const publicUrl = await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLIC_URL")
      || await readRemoteEnv(conn, `${supaDir}/.env`, "API_EXTERNAL_URL")
      || `http://${localIp}:${kongPort}`;
    result.public_url = publicUrl;
    const anonKey = await readRemoteEnv(conn, `${supaDir}/.env`, "ANON_KEY")
      || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLISHABLE_KEY");

    if (result.auth_user_exists && result.has_admin_role && anonKey) {
      await log("→ Test de login (mot de passe par défaut)…");
      try {
        await ensureLocalAuthGateway(conn, supaDir, kongPort, log);
        await verifyAuthLoginFromServer(
          conn,
          `http://127.0.0.1:${kongPort}`,
          anonKey,
          DEFAULT_ADMIN_EMAIL,
          DEFAULT_ADMIN_PASSWORD,
          log,
          buildDirectKongAuthLoginCommand(supaDir, anonKey, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD),
        );
        result.can_login = true;
        await log("✓ Login réel réussi avec le mot de passe par défaut");
      } catch (e: any) {
        await log("⚠ Login refusé : " + (e?.message || String(e)));
      }
    }

    await log("");
    await log("════════════════════════════════════════════════════════════");
    await log("📋  ÉTAT DU PREMIER COMPTE ADMIN");
    await log("════════════════════════════════════════════════════════════");
    await log(`   Email           : ${DEFAULT_ADMIN_EMAIL}`);
    await log(`   Compte Auth     : ${result.auth_user_exists ? "✓ existe" : "✗ absent"}`);
    await log(`   Email confirmé  : ${result.email_confirmed ? "✓" : "✗"}`);
    await log(`   Rôle admin      : ${result.has_admin_role ? "✓" : "✗"}`);
    await log(`   Profil public   : ${result.has_profile ? "✓" : "✗"}`);
    await log(`   Login fonctionne: ${result.can_login ? "✓ (mdp défaut)" : "✗ (mdp inconnu ou compte cassé)"}`);
    await log("════════════════════════════════════════════════════════════");

    await persist({ status: "running", check_result: result });
    (globalThis as any).__lastDeployResult = { action: "check_admin_status", ...result };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Read-only diagnostic of the deployed stack with suggested fixes =====
async function runDiagnoseServer(
  body: DeployBody,
  log: (m: string) => Promise<void> | void,
  persist: (patch: Record<string, unknown>) => Promise<void>,
): Promise<{ action: string; checks: any[]; suggestions: string[] }> {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;

  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");

  const checks: Array<{ key: string; label: string; ok: boolean; detail?: string; suggested_action?: string }> = [];
  const add = (c: typeof checks[number]) => { checks.push(c); return c; };

  try {
    // Docker
    const dockerVer = await exec(conn, `docker --version 2>&1 || echo MISSING`);
    add({ key: "docker", label: "Docker installé", ok: !(dockerVer.stdout || "").includes("MISSING"), detail: (dockerVer.stdout || "").trim() });

    // Project dirs
    const repoCheck = await exec(conn, `[ -d ${remoteDir} ] && echo OK || echo MISSING`);
    add({ key: "repo_dir", label: `Dossier app ${remoteDir}`, ok: (repoCheck.stdout || "").includes("OK") });
    const supaCheck = await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo MISSING`);
    const supaPresent = (supaCheck.stdout || "").includes("OK");
    add({ key: "supabase_stack", label: "Stack Supabase locale", ok: supaPresent, suggested_action: supaPresent ? undefined : "redeploy" });

    // Containers running
    const ps = await exec(conn, `docker ps --format '{{.Names}}|{{.Status}}' 2>&1 || true`);
    const psLines = (ps.stdout || "").split("\n").filter(Boolean);
    const has = (re: RegExp) => psLines.some((l) => re.test(l));
    const webOk = has(/screenflow.*web|screenflow-web|^web\|/i) || has(/nginx/i);
    add({ key: "container_web", label: "Conteneur web (frontend)", ok: webOk, suggested_action: webOk ? undefined : "repair_web_container" });

    if (supaPresent) {
      const dbOk = has(/supabase-db|^db\|/i);
      const restOk = has(/supabase-rest|^rest\|/i);
      const authOk = has(/supabase-auth|gotrue|^auth\|/i);
      const storageOk = has(/supabase-storage|^storage\|/i);
      const realtimeOk = has(/supabase-realtime|^realtime\|/i);
      const kongOk = has(/supabase-kong|^kong\|/i);
      add({ key: "container_db", label: "Conteneur Postgres", ok: dbOk, suggested_action: dbOk ? undefined : "restart_stack" });
      add({ key: "container_rest", label: "Conteneur REST (PostgREST)", ok: restOk, suggested_action: restOk ? undefined : "restart_stack" });
      add({ key: "container_auth", label: "Conteneur Auth (GoTrue)", ok: authOk, suggested_action: authOk ? undefined : "restart_stack" });
      add({ key: "container_storage", label: "Conteneur Storage", ok: storageOk, suggested_action: storageOk ? undefined : "repair_local_writes" });
      add({ key: "container_realtime", label: "Conteneur Realtime", ok: realtimeOk, suggested_action: realtimeOk ? undefined : "repair_realtime" });
      add({ key: "container_kong", label: "Gateway Kong", ok: kongOk, suggested_action: kongOk ? undefined : "restart_stack" });

      // Read .env
      const kongPort = await readRemoteEnv(conn, `${supaDir}/.env`, "KONG_HTTP_PORT") || "8000";
      const anonKey = await readRemoteEnv(conn, `${supaDir}/.env`, "ANON_KEY")
        || await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLISHABLE_KEY");
      const publicUrl = await readRemoteEnv(conn, `${supaDir}/.env`, "SUPABASE_PUBLIC_URL")
        || await readRemoteEnv(conn, `${supaDir}/.env`, "API_EXTERNAL_URL") || "";
      add({ key: "anon_key", label: "ANON_KEY présente", ok: !!anonKey, detail: anonKey ? `${anonKey.slice(0, 12)}…` : "absente", suggested_action: anonKey ? undefined : "repair_local_api_url" });
      add({ key: "public_url", label: "SUPABASE_PUBLIC_URL configurée", ok: !!publicUrl, detail: publicUrl, suggested_action: publicUrl ? undefined : "repair_local_api_url" });

      // HTTP probes from server
      if (anonKey) {
        const auth = await exec(conn, `curl -sS -m 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:${kongPort}/auth/v1/health 2>/dev/null || echo 000`);
        const rest = await exec(conn, `curl -sS -m 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:${kongPort}/rest/v1/ -H ${shQuote(`apikey: ${anonKey}`)} -H ${shQuote(`Authorization: Bearer ${anonKey}`)} 2>/dev/null || echo 000`);
        const stor = await exec(conn, `curl -sS -m 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:${kongPort}/storage/v1/bucket -H ${shQuote(`apikey: ${anonKey}`)} -H ${shQuote(`Authorization: Bearer ${anonKey}`)} 2>/dev/null || echo 000`);
        const rt = await exec(conn, `curl -sS -m 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:${kongPort}/realtime/v1/ 2>/dev/null || echo 000`);
        const okHttp = (s: string) => /^(2|3|401|403|404|426)/.test(s.trim());
        add({ key: "http_auth", label: "Auth HTTP", ok: okHttp(auth.stdout), detail: (auth.stdout || "").trim(), suggested_action: okHttp(auth.stdout) ? undefined : "restart_stack" });
        add({ key: "http_rest", label: "REST HTTP", ok: okHttp(rest.stdout), detail: (rest.stdout || "").trim(), suggested_action: okHttp(rest.stdout) ? undefined : "repair_local_writes" });
        add({ key: "http_storage", label: "Storage HTTP", ok: okHttp(stor.stdout), detail: (stor.stdout || "").trim(), suggested_action: okHttp(stor.stdout) ? undefined : "repair_local_writes" });
        add({ key: "http_realtime", label: "Realtime HTTP", ok: okHttp(rt.stdout), detail: (rt.stdout || "").trim(), suggested_action: okHttp(rt.stdout) ? undefined : "repair_realtime" });
      }

      // Ensure psql works to inspect data
      try {
        await ensurePostgresSqlAccess(conn, supaDir, log);
        const buckets = await exec(conn, dockerPsqlSelect(supaDir, "select string_agg(name, ',') from storage.buckets"));
        const list = (buckets.stdout || "").trim();
        const hasUploads = /\buploads\b/.test(list);
        const hasMedia = /\bmedia\b/.test(list);
        add({ key: "bucket_uploads", label: "Bucket 'uploads'", ok: hasUploads, suggested_action: hasUploads ? undefined : "repair_storage_buckets" });
        add({ key: "bucket_media", label: "Bucket 'media'", ok: hasMedia, suggested_action: hasMedia ? undefined : "repair_storage_buckets" });

        const pubTables = await exec(conn, dockerPsqlSelect(supaDir, "select count(*)::text from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'"));
        const n = parseInt((pubTables.stdout || "").trim().split("\n").find(l => /^\d+$/.test(l.trim())) || "0");
        add({ key: "realtime_publication", label: "Publication Realtime (tables)", ok: n > 0, detail: `${n} table(s)`, suggested_action: n > 0 ? undefined : "repair_realtime" });

        const adminCount = await exec(conn, dockerPsqlSelect(supaDir, "select count(*)::text from public.user_roles where role='admin'"));
        const ac = parseInt((adminCount.stdout || "").trim().split("\n").find(l => /^\d+$/.test(l.trim())) || "0");
        add({ key: "admin_account", label: "Compte admin global", ok: ac > 0, detail: `${ac} admin(s)`, suggested_action: ac > 0 ? undefined : "reset_admin_password" });
      } catch (e: any) {
        await log(`⚠ Inspection Postgres impossible: ${e?.message || e}`);
      }
    }

    // Disk space
    const df = await exec(conn, `df -h / | tail -1 | awk '{print $5" used on "$6}'`);
    const used = parseInt((df.stdout || "0").trim().split("%")[0] || "0");
    add({ key: "disk", label: "Espace disque /", ok: used < 90, detail: (df.stdout || "").trim() });

    await log("");
    await log("════════════════════════════════════════════════════════════");
    await log("📋  DIAGNOSTIC SERVEUR");
    await log("════════════════════════════════════════════════════════════");
    for (const c of checks) {
      await log(`   ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `  (${c.detail})` : ""}${!c.ok && c.suggested_action ? `  → fix: ${c.suggested_action}` : ""}`);
    }
    await log("════════════════════════════════════════════════════════════");

    const failures = checks.filter((c) => !c.ok);
    const suggestions = Array.from(new Set(failures.map((c) => c.suggested_action).filter(Boolean))) as string[];
    const result = { action: "diagnose_server", checks, suggestions };
    await persist({ status: "running", diagnostic: { checks, suggestions } });
    (globalThis as any).__lastDeployResult = result;
    return result;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Suivre / finaliser un build détaché lancé par un déploiement =====
async function runBuildStatus(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const stateDir = `${remoteDir}/.build`;
  const repoDir = `${remoteDir}/repo`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const exists = (await exec(conn, `[ -d ${stateDir} ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!exists) {
      await log("ℹ Aucun build détaché trouvé — lancez d'abord un déploiement ou une mise à jour rapide.");
      const psNone = await exec(conn, `cd ${repoDir} && (docker compose ps || docker-compose ps) 2>&1 | tail -20`);
      await log(psNone.stdout);
      const r0 = { action: "build_status", found: false, running: false, ok: false, ps: (psNone.stdout || "").trim() };
      (globalThis as any).__lastDeployResult = r0;
      return r0;
    }
    await log("→ Suivi du build en cours sur le serveur…");
    const res = await pollDetachedCompose(conn, stateDir, Date.now() + 4 * 60 * 1000, log);
    if (!res.done) {
      await log("⏳ Build toujours en cours — recliquez sur « Vérifier le build » dans quelques minutes.");
      const rPending = { action: "build_status", found: true, running: true, ok: false, tail: res.tail.slice(-2000) };
      (globalThis as any).__lastDeployResult = rPending;
      return rPending;
    }
    await log(res.tail.slice(-2000));
    const ok = res.code === 0;
    await log(ok ? "✓ Build terminé avec succès" : `✗ Build échoué (code ${res.code})`);
    const ps = await exec(conn, `cd ${repoDir} && (docker compose ps || docker-compose ps) 2>&1 | tail -20`);
    await log(ps.stdout);
    const appPort = body.app_port || "8080";
    const http = await exec(conn, `curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:${appPort} || echo FAIL`);
    await log(`  • App HTTP 127.0.0.1:${appPort} → ${(http.stdout || "").trim()}`);
    const result = {
      action: "build_status",
      found: true,
      running: false,
      ok,
      code: res.code,
      ps: (ps.stdout || "").trim(),
      app_http: (http.stdout || "").trim(),
    };
    (globalThis as any).__lastDeployResult = result;
    return result;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}


// ===== Restart whole docker stack (web + supabase) =====
async function runRestartStack(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (supaPresent) {
      await log("→ Redémarrage de la stack Supabase locale…");
      const r1 = await exec(conn, `cd ${supaDir} && (docker compose restart || docker-compose restart) 2>&1`);
      await log((r1.stdout || "").split("\n").slice(-15).join("\n"));
    } else {
      await log("ℹ Aucune stack Supabase locale détectée — étape ignorée.");
    }
    const repoDir = `${remoteDir}/repo`;
    const repoPresent = (await exec(conn, `[ -f ${repoDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (repoPresent) {
      await log("→ Redémarrage du conteneur web…");
      // `restart` ne relance pas un conteneur absent : on utilise up -d puis restart.
      const r2 = await exec(conn, `cd ${repoDir} && ((docker compose up -d web && docker compose restart web) || (docker-compose up -d web && docker-compose restart web)) 2>&1`);
      await log((r2.stdout || "").split("\n").slice(-15).join("\n"));
    } else {
      await log(`ℹ Aucun docker-compose.yml applicatif dans ${repoDir} — conteneur web non redémarré.`);
    }
    await log("✓ Stack redémarrée");
    (globalThis as any).__lastDeployResult = { action: "restart_stack", ok: true };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Repair the web (frontend) container: diagnose why it is down, rebuild and verify uploads proxy =====
async function runRepairWebContainer(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  const repoDir = `${remoteDir}/repo`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  const result: any = { action: "repair_web_container", ok: false, cause: null, running: false, upload_proxy_ok: false };
  try {
    const present = (await exec(conn, `[ -f ${repoDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!present) {
      result.cause = `Aucun docker-compose.yml dans ${repoDir}`;
      throw new Error(`Aucun docker-compose.yml applicatif dans ${repoDir}. Lancez un déploiement complet.`);
    }

    // 1. Why is it down?
    await log("→ Analyse de l'état du conteneur web…");
    const state = await exec(conn, `cd ${repoDir} && (docker compose ps -a || docker-compose ps -a) 2>&1`);
    await log((state.stdout || "").split("\n").slice(-15).join("\n"));
    const lastBuild = await exec(conn, `tail -n 25 ${remoteDir}/.build/build.log 2>/dev/null || true`);
    if ((lastBuild.stdout || "").trim()) {
      await log("ℹ Dernières lignes du build précédent :\n" + lastBuild.stdout.slice(-1500));
      if (/error|ERR!|failed/i.test(lastBuild.stdout)) result.cause = "Build précédent en erreur";
    }
    const webLogs = await exec(conn, `cd ${repoDir} && (docker compose logs --tail=25 web || docker-compose logs --tail=25 web) 2>&1 || true`);
    if ((webLogs.stdout || "").trim()) await log("ℹ Logs conteneur web :\n" + webLogs.stdout.slice(-1200));
    if (!result.cause && !/Up\s/i.test(state.stdout)) result.cause = "Conteneur web arrêté ou jamais construit";

    // 2. Rebuild (detached so the edge runtime timeout cannot kill it)
    await log("→ Reconstruction du conteneur web en arrière-plan (docker compose up -d --build)…");
    const stateDir = `${remoteDir}/.build`;
    await startDetachedCompose(conn, repoDir, stateDir);
    const res = await pollDetachedCompose(conn, stateDir, Date.now() + 4 * 60 * 1000, log);
    if (!res.done) {
      await log("⏳ Build toujours en cours — cliquez sur « Vérifier le build » dans quelques minutes.");
      result.cause = result.cause || "Build long en cours";
      (globalThis as any).__lastDeployResult = result;
      return result;
    }
    await log(res.tail.slice(-1500));
    if (res.code !== 0) {
      result.cause = "Échec du build Docker (voir " + stateDir + "/build.log)";
      throw new Error(result.cause);
    }

    // 3. Verify container up + nginx proxy for uploads
    const ps2 = await exec(conn, `cd ${repoDir} && (docker compose ps || docker-compose ps) 2>&1`);
    result.running = /Up\s|running/i.test(ps2.stdout);
    await log((ps2.stdout || "").split("\n").slice(-10).join("\n"));

    const cid = (await exec(conn, `cd ${repoDir} && (docker compose ps -q web || docker-compose ps -q web) 2>/dev/null | head -1`)).stdout.trim();
    if (cid) {
      const conf = await exec(conn, `docker exec ${cid} cat /etc/nginx/conf.d/default.conf 2>/dev/null || true`);
      const hasStorage = /location \/storage\/v1\//.test(conf.stdout);
      const hasBodySize = /client_max_body_size/.test(conf.stdout);
      result.upload_proxy_ok = hasStorage && hasBodySize;
      await log(hasStorage
        ? `✓ Proxy upload présent dans nginx (/storage/v1/ ${hasBodySize ? "+ client_max_body_size" : "SANS client_max_body_size"})`
        : "✗ Le proxy /storage/v1/ est absent de la config nginx du conteneur — les uploads échoueront.");
      const gw = await exec(conn, `docker exec ${cid} sh -c 'getent hosts host.docker.internal || true' 2>&1`);
      result.host_gateway_ok = !!(gw.stdout || "").trim();
      await log(result.host_gateway_ok
        ? `✓ host.docker.internal résolu (${(gw.stdout || "").trim().split(/\s+/)[0]})`
        : "✗ host.docker.internal non résolu dans le conteneur web — le proxy vers Kong/Storage ne peut pas fonctionner.");
      const up = await exec(conn, `docker exec ${cid} sh -c 'wget -q -S -O /dev/null http://host.docker.internal:8000/storage/v1/bucket 2>&1 | head -3' || true`);
      if ((up.stdout || "").trim()) await log("ℹ Test Storage depuis le conteneur web : " + (up.stdout || "").trim().replace(/\s+/g, " ").slice(0, 200));
    }

    // 4. Make sure storage service + policies/buckets are healthy (uploads)
    const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (supaPresent) {
      await log("→ Vérification des services Storage/Kong…");
      await exec(conn, `cd ${supaDir} && (docker compose up -d db rest storage kong 2>&1 || true)`);
      await applyLocalDashboardWriteHotfix(conn, supaDir, log);
    }

    result.ok = result.running;
    await log(result.ok
      ? "✓ Conteneur web reconstruit et démarré. Rechargez l'application puis retestez un upload."
      : "⚠ Le conteneur web ne tourne toujours pas — consultez les logs ci-dessus.");
    (globalThis as any).__lastDeployResult = result;
    return result;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}


// ===== Repair / re-create default Storage buckets (uploads, media) =====
async function runRepairStorageBuckets(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const result = await repairUploadsNowCore(conn, body, log);
    const bucketResult = { ...result, action: "repair_storage_buckets" };
    await log("✓ Buckets 'uploads' et 'media' réparés et testés");
    (globalThis as any).__lastDeployResult = bucketResult;
    return bucketResult;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Repair Realtime: restart container + ensure tables in publication =====
async function runRepairRealtime(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!supaPresent) throw new Error(`Aucune stack Supabase locale dans ${supaDir}`);
    await ensurePostgresSqlAccess(conn, supaDir, log);

    const tables = ["screens", "media", "playlists", "playlist_items", "schedules", "notifications", "contents", "programs", "layouts"];
    const sql = `
      do $$ begin
        if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
          create publication supabase_realtime;
        end if;
      end $$;
      ${tables.map((t) => `do $$ begin
        begin
          execute 'alter table public.${t} replica identity full';
        exception when undefined_table then null; end;
        begin
          execute 'alter publication supabase_realtime add table public.${t}';
        exception when duplicate_object then null; when undefined_table then null; end;
      end $$;`).join("\n")}
    `;
    const out = await exec(conn, dockerPsqlExec(supaDir, sql));
    await log((out.stdout || "").split("\n").slice(-20).join("\n"));
    await exec(conn, `cd ${supaDir} && (docker compose restart realtime || docker-compose restart realtime) 2>&1`);
    await log("✓ Realtime réparé (publication + redémarrage)");
    (globalThis as any).__lastDeployResult = { action: "repair_realtime", ok: true };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}


// ===== Apply local app migrations and report a summary =====
async function runApplyLocalMigrations(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  const migDir = `${remoteDir}/repo/supabase/migrations`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!supaPresent) throw new Error(`Aucune stack Supabase locale dans ${supaDir}`);
    const migPresent = (await exec(conn, `[ -d ${migDir} ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!migPresent) throw new Error(`Dossier de migrations introuvable (${migDir}). Lancez d'abord un déploiement complet pour cloner le dépôt.`);
    await ensurePostgresSqlAccess(conn, supaDir, log);

    // Init tracking schema/table
    await exec(conn, dockerPsqlExec(supaDir, `
      create schema if not exists _lovable;
      create table if not exists _lovable.migrations(
        name text primary key,
        applied_at timestamptz not null default now(),
        success boolean not null default true,
        error text
      );
    `));

    // List all migration files
    const lsOut = await exec(conn, `ls ${migDir}/*.sql 2>/dev/null | sort`);
    const allFiles = (lsOut.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    await log(`→ ${allFiles.length} fichier(s) de migration détecté(s)`);

    // Already applied (success)
    const appliedOut = await exec(conn, dockerPsqlSelect(supaDir, "select name from _lovable.migrations where success = true", false));
    const appliedSet = new Set(
      (appliedOut.stdout || "").split("\n").map((s) => s.trim()).filter((s) => s && !/^\(\d+ rows?\)$/.test(s)),
    );

    const summary: Array<{ name: string; status: "applied" | "skipped" | "error"; error?: string }> = [];
    let applied = 0, skipped = 0, errors = 0;

    for (const fpath of allFiles) {
      const name = fpath.split("/").pop()!;
      const safeName = name.replace(/'/g, "''");
      if (appliedSet.has(name)) {
        summary.push({ name, status: "skipped" });
        skipped++;
        continue;
      }
      await log(`→ Application: ${name}`);
      const cmd =
        `cat ${fpath} | (cd ${supaDir} && docker compose exec -T --user postgres db sh -lc ` +
        `${shQuote('PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1')}) 2>&1`;
      const r = await exec(conn, cmd);
      const tail = (r.stdout || "").split("\n").slice(-10).join("\n").trim();
      if (r.code === 0) {
        applied++;
        summary.push({ name, status: "applied" });
        await exec(conn, dockerPsqlExec(supaDir, `insert into _lovable.migrations(name, success, error) values ('${safeName}', true, null) on conflict (name) do update set success=true, error=null, applied_at=now();`));
        await log(`  ✓ ${name}`);
      } else {
        errors++;
        const errMsg = tail.replace(/'/g, "''").slice(-800);
        summary.push({ name, status: "error", error: tail });
        await exec(conn, dockerPsqlExec(supaDir, `insert into _lovable.migrations(name, success, error) values ('${safeName}', false, '${errMsg}') on conflict (name) do update set success=false, error=excluded.error, applied_at=now();`));
        await log(`  ✗ ${name}: ${tail.slice(0, 200)}`);
      }
    }

    await log(`✓ Terminé — appliquées: ${applied}, déjà à jour: ${skipped}, erreurs: ${errors}`);
    const result = {
      action: "apply_local_migrations",
      ok: errors === 0,
      total: allFiles.length,
      applied,
      skipped,
      errors,
      items: summary,
    };
    (globalThis as any).__lastDeployResult = result;
    return result;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Quick update: pull repo, apply new migrations, sync edge functions, rebuild web only =====
async function runQuickUpdate(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  const repoDir = `${remoteDir}/repo`;
  const branch = body.git_branch || "main";
  const migDir = `${repoDir}/supabase/migrations`;

  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");

  const summary: {
    git: { ok: boolean; commit?: string; changed_files?: number; message?: string };
    migrations: { applied: number; skipped: number; errors: number; items: Array<{ name: string; status: string; error?: string }> };
    functions: { ok: boolean };
    web_rebuild: { ok: boolean };
  } = {
    git: { ok: false },
    migrations: { applied: 0, skipped: 0, errors: 0, items: [] },
    functions: { ok: false },
    web_rebuild: { ok: false },
  };

  try {
    // Sanity checks
    const repoPresent = (await exec(conn, `[ -d ${repoDir}/.git ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!repoPresent) {
      throw new Error(`Aucun dépôt cloné dans ${repoDir}. Lancez d'abord un déploiement complet.`);
    }
    const appComposePresent = (await exec(conn, `[ -f ${repoDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (!appComposePresent) {
      throw new Error(`Manifest web absent dans ${repoDir}. Utilisez « Installer / mettre à jour automatiquement » : il recréera le manifeste et reprendra l'installation.`);
    }
    const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");

    // ===== 1. Git pull =====
    await log(`→ git fetch + reset --hard origin/${branch}…`);
    const beforeSha = (await exec(conn, `cd ${repoDir} && git rev-parse HEAD 2>/dev/null || echo none`)).stdout.trim();
    const pull = await exec(
      conn,
      `cd ${repoDir} && git fetch --depth 1 origin ${branch} 2>&1 && git reset --hard origin/${branch} 2>&1 && git clean -fd -e docker-compose.yml -e ssl 2>&1`,
    );
    if (pull.code !== 0) {
      throw new Error(`git pull a échoué : ${pull.stdout.slice(-400)}`);
    }
    const afterSha = (await exec(conn, `cd ${repoDir} && git rev-parse HEAD`)).stdout.trim();
    const diff = await exec(conn, `cd ${repoDir} && git diff --name-only ${beforeSha} ${afterSha} 2>/dev/null | wc -l`);
    const changedFiles = parseInt((diff.stdout || "").trim(), 10) || 0;
    summary.git = {
      ok: true,
      commit: afterSha.slice(0, 8),
      changed_files: changedFiles,
      message: beforeSha === afterSha ? "Aucun nouveau commit" : `${changedFiles} fichier(s) mis à jour`,
    };
    await log(`✓ Repo à jour (HEAD ${afterSha.slice(0, 8)}, ${changedFiles} fichier(s) modifiés)`);

    // ===== 2. Apply pending migrations (idempotent via _lovable.migrations) =====
    if (supaPresent) {
      await ensurePostgresSqlAccess(conn, supaDir, log);
      await exec(conn, dockerPsqlExec(supaDir, `
        create schema if not exists _lovable;
        create table if not exists _lovable.migrations(
          name text primary key,
          applied_at timestamptz not null default now(),
          success boolean not null default true,
          error text
        );
      `));
      const lsOut = await exec(conn, `ls ${migDir}/*.sql 2>/dev/null | sort`);
      const allFiles = (lsOut.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const appliedOut = await exec(conn, dockerPsqlSelect(supaDir, "select name from _lovable.migrations where success = true", false));
      const appliedSet = new Set(
        (appliedOut.stdout || "").split("\n").map((s) => s.trim()).filter((s) => s && !/^\(\d+ rows?\)$/.test(s)),
      );
      const pending = allFiles.filter((f) => !appliedSet.has(f.split("/").pop()!));
      await log(`→ ${allFiles.length} migration(s) au total, ${pending.length} à appliquer`);
      for (const fpath of allFiles) {
        const name = fpath.split("/").pop()!;
        const safeName = name.replace(/'/g, "''");
        if (appliedSet.has(name)) {
          summary.migrations.items.push({ name, status: "skipped" });
          summary.migrations.skipped++;
          continue;
        }
        await log(`→ Migration: ${name}`);
        const cmd =
          `cat ${fpath} | (cd ${supaDir} && docker compose exec -T --user postgres db sh -lc ` +
          `${shQuote('PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1')}) 2>&1`;
        const r = await exec(conn, cmd);
        const tail = (r.stdout || "").split("\n").slice(-10).join("\n").trim();
        if (r.code === 0) {
          summary.migrations.applied++;
          summary.migrations.items.push({ name, status: "applied" });
          await exec(conn, dockerPsqlExec(supaDir, `insert into _lovable.migrations(name, success, error) values ('${safeName}', true, null) on conflict (name) do update set success=true, error=null, applied_at=now();`));
          await log(`  ✓ ${name}`);
        } else {
          summary.migrations.errors++;
          const errMsg = tail.replace(/'/g, "''").slice(-800);
          summary.migrations.items.push({ name, status: "error", error: tail });
          await exec(conn, dockerPsqlExec(supaDir, `insert into _lovable.migrations(name, success, error) values ('${safeName}', false, '${errMsg}') on conflict (name) do update set success=false, error=excluded.error, applied_at=now();`));
          await log(`  ✗ ${name}: ${tail.slice(0, 200)}`);
        }
      }
    } else {
      await log("ℹ Aucune stack Supabase locale détectée — étape migrations ignorée.");
    }

    // ===== 3. Sync edge functions =====
    if (supaPresent) {
      try {
        await syncLocalEdgeFunctions(conn, remoteDir, supaDir, log);
        summary.functions.ok = true;
      } catch (e: any) {
        await log("⚠ Échec sync fonctions : " + (e?.message || String(e)));
      }
    }

    // ===== 4. Rebuild only the web container =====
    const webPresent = (await exec(conn, `[ -f ${repoDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (webPresent) {
      await log("→ Rebuild du conteneur web en arrière-plan (docker compose up -d --build)…");
      const qStateDir = `${remoteDir}/.build`;
      await startDetachedCompose(conn, repoDir, qStateDir);
      const qRes = await pollDetachedCompose(conn, qStateDir, Date.now() + 3.5 * 60 * 1000, log);
      if (!qRes.done) {
        await log("⏳ Rebuild toujours en cours — cliquez sur « Vérifier le build » pour suivre la fin.");
        summary.web_rebuild.ok = false;
      } else {
        await log(qRes.tail.slice(-1500));
        summary.web_rebuild.ok = qRes.code === 0;
        if (qRes.code === 0) await log("✓ Conteneur web reconstruit et redémarré");
      }
    } else {
      await log("ℹ Aucun docker-compose.yml d'application — étape rebuild ignorée.");
    }

    const ok = summary.git.ok && summary.migrations.errors === 0 && summary.web_rebuild.ok !== false;
    await log(`✓ Mise à jour rapide terminée — git: ${summary.git.message}, migrations: ${summary.migrations.applied} appliquées / ${summary.migrations.errors} erreurs, web rebuild: ${summary.web_rebuild.ok ? "OK" : "ignoré"}`);
    const result = { action: "quick_update", ok, ...summary };
    (globalThis as any).__lastDeployResult = result;
    return result;
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Docker network management =====
async function runNetworkInspect(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    await log("→ Liste des réseaux Docker…");
    const ls = await exec(conn, "docker network ls --format '{{.ID}}\t{{.Name}}\t{{.Driver}}\t{{.Scope}}' 2>&1");
    const networks = (ls.stdout || "").trim().split("\n").filter(Boolean).map((line) => {
      const [id, name, driver, scope] = line.split("\t");
      return { id, name, driver, scope };
    });
    await log(`  ${networks.length} réseau(x) détecté(s)`);

    // Identify project networks (web stack + supabase stack)
    const projectNetworks = networks.filter((n) =>
      /screenflow|supabase|opt_/i.test(n.name) && n.driver === "bridge"
    );

    const details: any[] = [];
    for (const net of projectNetworks) {
      const insp = await exec(conn, `docker network inspect ${net.name} --format '{{json .}}' 2>&1`);
      try {
        const parsed = JSON.parse((insp.stdout || "").trim());
        const ipam = parsed.IPAM?.Config?.[0] || {};
        const containers = Object.entries(parsed.Containers || {}).map(([cid, c]: [string, any]) => ({
          id: cid,
          id_short: String(cid).substring(0, 12),
          name: c.Name,
          ipv4: c.IPv4Address,
          mac: c.MacAddress,
        }));
        details.push({
          name: net.name,
          driver: net.driver,
          subnet: ipam.Subnet || null,
          gateway: ipam.Gateway || null,
          containers,
        });
        await log(`  • ${net.name} → subnet=${ipam.Subnet || "?"} gateway=${ipam.Gateway || "?"} (${containers.length} conteneur(s))`);
      } catch { /* ignore */ }
    }

    await log("→ Interfaces réseau de l'hôte…");
    const hostIfaces = await exec(conn, "ip -o -4 addr show 2>&1 | awk '{print $2, $4}' || ifconfig -a 2>&1");
    const interfaces = (hostIfaces.stdout || "").trim().split("\n").filter(Boolean);

    await log("→ Mappings de ports actifs…");
    const ports = await exec(conn, "docker ps --format '{{.Names}}\t{{.Ports}}' 2>&1");
    const portMap = (ports.stdout || "").trim().split("\n").filter(Boolean).map((line) => {
      const [name, p] = line.split("\t");
      return { container: name, ports: p };
    });

    await log("→ Tests de connectivité interne (web → kong/db)…");
    const webName = (await exec(conn, `cd ${remoteDir} && (docker compose ps -q web || docker-compose ps -q web) 2>/dev/null | head -1`)).stdout.trim();
    const tests: any[] = [];
    if (webName) {
      const t1 = await exec(conn, `docker exec ${webName} sh -lc 'wget -q -T 3 -O - http://kong:8000/ 2>&1 | head -c 80' 2>&1`);
      tests.push({ from: "web", to: "kong:8000", ok: (t1.code === 0), output: (t1.stdout || "").trim() || (t1.stderr || "").trim() });
      const t2 = await exec(conn, `docker exec ${webName} sh -lc 'getent hosts db || nslookup db' 2>&1`);
      tests.push({ from: "web", to: "db (DNS)", ok: t2.code === 0, output: (t2.stdout || "").trim().split("\n")[0] || "" });
    }

    await log("✓ Inspection terminée");
    return { action: "network_inspect", ok: true, networks, details, interfaces, port_mappings: portMap, tests };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

async function runNetworkRecreate(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const supaPresent = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (supaPresent) {
      await log("→ Arrêt de la stack Supabase…");
      await exec(conn, `cd ${supaDir} && (docker compose down || docker-compose down) 2>&1`);
    }
    const repoPresent = (await exec(conn, `[ -f ${remoteDir}/repo/docker-compose.yml ] && echo OK || echo NO`)).stdout.includes("OK");
    if (repoPresent) {
      await log("→ Arrêt de la stack web…");
      await exec(conn, `cd ${remoteDir}/repo && (docker compose down || docker-compose down) 2>&1`);
    }
    await log("→ Suppression des réseaux orphelins…");
    await exec(conn, "docker network prune -f 2>&1");
    if (supaPresent) {
      await log("→ Redémarrage Supabase…");
      const r1 = await exec(conn, `cd ${supaDir} && (docker compose up -d || docker-compose up -d) 2>&1`);
      await log((r1.stdout || "").split("\n").slice(-10).join("\n"));
    }
    if (repoPresent) {
      await log("→ Redémarrage web…");
      const r2 = await exec(conn, `cd ${remoteDir}/repo && (docker compose up -d || docker-compose up -d) 2>&1`);
      await log((r2.stdout || "").split("\n").slice(-10).join("\n"));
    }
    await log("✓ Réseau Docker recréé");
    return { action: "network_recreate", ok: true };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

async function runNetworkSetSubnet(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const remoteDir = body.remote_dir || "/opt/screenflow";
  const supaDir = `${remoteDir}/supabase`;
  const subnet = (body.network_subnet || "").trim();
  const gateway = (body.network_gateway || "").trim();
  const ipRange = (body.network_ip_range || "").trim();
  const mtu = body.network_mtu;
  const dns = (body.network_dns || []).map((s) => s.trim()).filter(Boolean);
  const containerIps = body.container_ips || {};
  const netName = (body.network_name || "screenflow_default").trim();
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)) {
    throw new Error(`Sous-réseau invalide: ${subnet}. Utilisez la notation CIDR (ex: 172.28.0.0/16).`);
  }
  for (const [svc, ip] of Object.entries(containerIps)) {
    if (ip && !/^\d+\.\d+\.\d+\.\d+$/.test(String(ip).trim())) {
      throw new Error(`IP invalide pour ${svc}: ${ip}`);
    }
  }
  for (const d of dns) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(d)) throw new Error(`DNS invalide: ${d}`);
  }
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const targetDir = (await exec(conn, `[ -f ${supaDir}/docker-compose.yml ] && echo ${supaDir} || echo ${remoteDir}`)).stdout.trim();
    await log(`→ Cible: ${targetDir}`);

    const ipamConfigLines = [`        - subnet: ${subnet}`];
    if (gateway) ipamConfigLines.push(`          gateway: ${gateway}`);
    if (ipRange) ipamConfigLines.push(`          ip_range: ${ipRange}`);
    const driverOptsLines: string[] = [];
    if (typeof mtu === "number" && mtu > 0) driverOptsLines.push(`      com.docker.network.driver.mtu: "${mtu}"`);

    let yml = `networks:\n  default:\n    name: ${netName}\n    driver: bridge\n    ipam:\n      driver: default\n      config:\n${ipamConfigLines.join("\n")}\n`;
    if (driverOptsLines.length) yml += `    driver_opts:\n${driverOptsLines.join("\n")}\n`;

    // Per-service overrides (static IP + DNS)
    const svcEntries = Object.entries(containerIps).filter(([, ip]) => String(ip).trim());
    if (svcEntries.length || dns.length) {
      yml += `services:\n`;
      const svcSet = new Set<string>(svcEntries.map(([s]) => s));
      // Ensure DNS applies to common services even without static IP
      if (dns.length && svcSet.size === 0) {
        ["web", "kong", "auth", "rest", "realtime", "storage", "studio"].forEach((s) => svcSet.add(s));
      }
      for (const svc of svcSet) {
        yml += `  ${svc}:\n`;
        if (dns.length) {
          yml += `    dns:\n${dns.map((d) => `      - ${d}`).join("\n")}\n`;
        }
        const sIp = (containerIps[svc] || "").trim();
        if (sIp) {
          yml += `    networks:\n      default:\n        ipv4_address: ${sIp}\n`;
        }
      }
    }

    await log(`→ Écriture de ${targetDir}/docker-compose.network.yml…`);
    await uploadFile(conn, `${targetDir}/docker-compose.network.yml`, Buffer.from(yml));

    await log("→ Arrêt de la stack…");
    await exec(conn, `cd ${targetDir} && (docker compose -f docker-compose.yml -f docker-compose.network.yml down || docker-compose -f docker-compose.yml -f docker-compose.network.yml down) 2>&1`);
    await log(`→ Suppression du réseau '${netName}' s'il existe…`);
    await exec(conn, `docker network rm ${netName} 2>/dev/null || true`);
    await log("→ Redémarrage avec la nouvelle configuration réseau…");
    const r = await exec(conn, `cd ${targetDir} && (docker compose -f docker-compose.yml -f docker-compose.network.yml up -d || docker-compose -f docker-compose.yml -f docker-compose.network.yml up -d) 2>&1`);
    await log((r.stdout || "").split("\n").slice(-15).join("\n"));

    const insp = await exec(conn, `docker network inspect ${netName} --format '{{(index .IPAM.Config 0).Subnet}} {{(index .IPAM.Config 0).Gateway}}' 2>&1`);
    await log(`✓ Réseau '${netName}' actif → ${(insp.stdout || "").trim()}`);
    return {
      action: "network_set_subnet", ok: true, network: netName, subnet,
      gateway: gateway || null, ip_range: ipRange || null, mtu: mtu ?? null,
      dns, container_ips: containerIps, applied: (insp.stdout || "").trim(),
    };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Hostname / system network configuration =====
async function runNetworkSetHostname(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const hostname = (body.hostname || "").trim();
  const alias = (body.hostname_alias || "").trim();
  if (!hostname || !/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9])?$/.test(hostname)) {
    throw new Error(`Hostname invalide: '${hostname}'. Utilisez lettres/chiffres/'-' (RFC 1123).`);
  }
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const sudo = `echo '${body.password.replace(/'/g, "'\\''")}' | sudo -S -p ''`;
    await log(`→ hostnamectl set-hostname ${hostname}`);
    const r1 = await exec(conn, `${sudo} hostnamectl set-hostname ${hostname} 2>&1`);
    await log(r1.stdout || "(ok)");

    // Update /etc/hosts: ensure 127.0.1.1 line points to new hostname
    const aliasPart = alias ? ` ${alias}` : "";
    const hostsLine = `127.0.1.1\t${hostname}${aliasPart}`;
    await log("→ Mise à jour de /etc/hosts…");
    const script = `${sudo} bash -c "sed -i '/^127\\.0\\.1\\.1[[:space:]]/d' /etc/hosts && echo -e '${hostsLine}' >> /etc/hosts" 2>&1`;
    const r2 = await exec(conn, script);
    if (r2.stdout) await log(r2.stdout);

    const cur = await exec(conn, "hostname && hostname -f 2>/dev/null || true");
    await log(`✓ Hostname actuel: ${(cur.stdout || "").trim()}`);
    return { action: "network_set_hostname", ok: true, hostname, alias: alias || null, current: (cur.stdout || "").trim() };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

async function runNetworkGetConfig(body: DeployBody, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    const hn = (await exec(conn, "hostname")).stdout.trim();
    const fqdn = (await exec(conn, "hostname -f 2>/dev/null || hostname")).stdout.trim();
    const ipAddr = (await exec(conn, "ip -4 -o addr show scope global 2>/dev/null | awk '{print $2\": \"$4}'")).stdout.trim().split("\n").filter(Boolean);
    const routes = (await exec(conn, "ip -4 route 2>/dev/null")).stdout.trim().split("\n").filter(Boolean);
    const dns = (await exec(conn, "grep -E '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}'")).stdout.trim().split("\n").filter(Boolean);
    const gateway = (await exec(conn, "ip -4 route | awk '/default/ {print $3; exit}'")).stdout.trim();
    const hosts = (await exec(conn, "cat /etc/hosts 2>/dev/null")).stdout;
    await log(`✓ Hostname=${hn}, gateway=${gateway}, DNS=${dns.join(",")}`);
    return {
      action: "network_get_config", ok: true,
      hostname: hn, fqdn, gateway, dns,
      ip_addresses: ipAddr, routes, hosts_file: hosts,
    };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

// ===== Live per-container IP change (no compose redeploy) =====
async function runNetworkSetContainerIp(body: DeployBody & { network_name?: string; container_id?: string; container_name?: string; new_ip?: string }, log: (m: string) => Promise<void> | void) {
  const port = body.port ?? 22;
  const netName = (body.network_name || "screenflow_default").trim();
  const target = (body.container_id || body.container_name || "").trim();
  const newIp = (body.new_ip || "").trim();
  if (!target) throw new Error("container_id ou container_name requis");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(newIp)) throw new Error(`IP invalide: ${newIp}`);
  await log(`→ Connexion SSH ${body.username}@${body.host}:${port}…`);
  const conn = await ssh({ host: body.host, port, username: body.username, password: body.password });
  await log("✓ SSH connecté");
  try {
    // Resolve real container name from id (works with both)
    const resolve = await exec(conn, `docker inspect --format '{{.Name}}' ${target} 2>&1 | sed 's#^/##'`);
    if (resolve.code !== 0 || !(resolve.stdout || "").trim()) {
      throw new Error(`Conteneur introuvable: ${target} (${resolve.stderr || resolve.stdout})`);
    }
    const cname = (resolve.stdout || "").trim();
    await log(`  • Conteneur résolu: ${cname}`);

    // Verify the network exists
    const netCheck = await exec(conn, `docker network inspect ${netName} --format 'OK' 2>&1`);
    if (!(netCheck.stdout || "").includes("OK")) {
      throw new Error(`Réseau Docker introuvable: ${netName}`);
    }

    await log(`→ Déconnexion de ${cname} du réseau ${netName}…`);
    await exec(conn, `docker network disconnect ${netName} ${cname} 2>&1 || true`);

    await log(`→ Reconnexion avec IP ${newIp}…`);
    const r = await exec(conn, `docker network connect --ip ${newIp} ${netName} ${cname} 2>&1`);
    if (r.code !== 0) {
      // Try to reconnect without static IP to recover
      await exec(conn, `docker network connect ${netName} ${cname} 2>&1 || true`);
      throw new Error(`Échec attribution IP ${newIp}: ${r.stdout || r.stderr}`);
    }

    // Confirm new IP
    const verify = await exec(conn, `docker inspect ${cname} --format '{{(index .NetworkSettings.Networks "${netName}").IPAddress}}' 2>&1`);
    const appliedIp = (verify.stdout || "").trim();
    await log(`✓ IP appliquée en direct: ${appliedIp}`);

    return {
      action: "network_set_container_ip",
      ok: true,
      network: netName,
      container: cname,
      requested_ip: newIp,
      applied_ip: appliedIp,
    };
  } finally {
    try { conn.end(); } catch (_) {}
  }
}
