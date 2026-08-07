import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Database, Download, Container, FileArchive, Loader2, Package, FileCode, Copy,
  Upload, CheckCircle2, XCircle, AlertCircle, ServerCog, Rocket, ShieldCheck,
  Server, Terminal, Wifi, KeyRound, Trash2, Stethoscope, RefreshCw, HardDrive, Radio, GitBranch,
  Network, Globe, MonitorSmartphone,
} from "lucide-react";
import JSZip from "jszip";
import { Textarea } from "@/components/ui/textarea";
import { getSupabaseUrl } from "@/lib/env";

const TABLES = [
  "profiles", "user_roles", "user_establishments", "establishments", "establishment_settings",
  "screens", "media", "playlists", "playlist_items", "programs", "schedules",
  "layouts", "layout_regions", "video_walls", "licenses", "contents",
  "notifications", "app_settings", "access_codes", "ai_requests",
  "registration_requests", "password_reset_requests", "inbox_emails", "email_actions",
];

const DOCKERFILE = `# ===== Build stage =====
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json bun.lockb* package-lock.json* ./
RUN if [ -f bun.lockb ]; then \\
      npm install -g bun && bun install --frozen-lockfile; \\
    else \\
      npm ci; \\
    fi

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

# ===== Runtime stage =====
FROM nginx:alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;

const NGINX_CONF = `server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  client_max_body_size 1024m;
  client_body_timeout 3600s;
  client_header_timeout 300s;
  send_timeout 3600s;

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Le conteneur web doit rejoindre le réseau Docker du backend. Le DNS Docker
  # résout alors kong:8000 sans dépendre du firewall ni de la passerelle hôte.
  set $cors_origin $http_origin; if ($request_method = OPTIONS) { return 204; } location /auth/v1/ { proxy_pass http://kong:8000/auth/v1/; proxy_set_header Host $http_host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto $scheme; add_header Access-Control-Allow-Origin $cors_origin always; }
  location /rest/v1/ { proxy_pass http://kong:8000/rest/v1/; proxy_set_header Host $http_host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto $scheme; add_header Access-Control-Allow-Origin $cors_origin always; }
  location /storage/v1/ { proxy_pass http://kong:8000/storage/v1/; proxy_set_header Host $http_host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Upsert $http_x_upsert; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto $scheme; add_header Access-Control-Allow-Origin $cors_origin always; client_max_body_size 1024m; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 3600s; proxy_send_timeout 3600s; }
  location /functions/v1/ { proxy_pass http://kong:8000/functions/v1/; proxy_set_header Host $http_host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Client-Info $http_x_client_info; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto $scheme; add_header Access-Control-Allow-Origin $cors_origin always; }
  location /realtime/v1/ { proxy_pass http://kong:8000/realtime/v1/; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $http_host; proxy_set_header Authorization $http_authorization; proxy_set_header apikey $http_apikey; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto $scheme; }

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
`;

const DOCKERIGNORE = `node_modules
dist
.git
.env
.env.local
*.log
.vscode
.idea
`;

function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildDockerCompose(env: "prod" | "staging", url: string, key: string, projectId: string, port: string, publicAppUrl: string, basePath = "/") {
  return `version: "3.9"
services:
  screenflow-${env}:
    build:
      context: .
      args:
        VITE_SUPABASE_URL: ${url || "<VITE_SUPABASE_URL>"}
        VITE_SUPABASE_PUBLISHABLE_KEY: ${key || "<VITE_SUPABASE_PUBLISHABLE_KEY>"}
        VITE_SUPABASE_PROJECT_ID: ${projectId || "<VITE_SUPABASE_PROJECT_ID>"}
        VITE_PUBLIC_APP_URL: ${publicAppUrl || `http://<IP_OU_DOMAINE>:${port}`}
        VITE_APP_BASE_PATH: ${basePath || "/"}
    image: screenflow:${env}
    container_name: screenflow-${env}
    restart: unless-stopped
    environment:
      NODE_ENV: ${env === "prod" ? "production" : "staging"}
    ports:
      - "${port}:80"
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost/"]
      interval: 30s
      timeout: 10s
      retries: 3
`;
}

export default function AdminBackup() {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [progressPct, setProgressPct] = useState(0);

  // Restore
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMode, setRestoreMode] = useState<"upsert" | "insert">("upsert");
  const [restoreResults, setRestoreResults] = useState<Record<string, { ok: boolean; count: number; error?: string }> | null>(null);

  // ZIP verification state
  type ManifestEntry = { name: string; size: number; path: string; bucket: string; sha256?: string };
  type ZipPreview = {
    zip: JSZip;
    manifest: { generated_at?: string; files_count: number; files: ManifestEntry[] } | null;
    tablesPayload: Record<string, any[]>;
    fileChecks: Array<{ entry: ManifestEntry; present: boolean; actualSize?: number; sizeMatch?: boolean; sha256Match?: boolean }>;
    totalRows: number;
    totalFiles: number;
    totalBytes: number;
  };
  const [zipPreview, setZipPreview] = useState<ZipPreview | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const [fileRestoreResults, setFileRestoreResults] = useState<{ ok: number; failed: number; errors: string[] } | null>(null);

  // Deployment guide
  const [envType, setEnvType] = useState<"prod" | "staging">("prod");
  const [envUrl, setEnvUrl] = useState(getSupabaseUrl());
  const [envKey, setEnvKey] = useState(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "");
  const [envProjectId, setEnvProjectId] = useState(import.meta.env.VITE_SUPABASE_PROJECT_ID || "");
  const [envPort, setEnvPort] = useState("8080");
  const [envPublicAppUrl, setEnvPublicAppUrl] = useState(import.meta.env.VITE_PUBLIC_APP_URL || "");

  // SSH Deploy state
  const [sshHost, setSshHost] = useState("");
  const [sshLocalIp, setSshLocalIp] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("root");
  const [sshPassword, setSshPassword] = useState("");
  const [sshRemoteDir, setSshRemoteDir] = useState("/opt/screenflow");
  const [sshAppPort, setSshAppPort] = useState("8080");
  const [sshAutoInstallDocker, setSshAutoInstallDocker] = useState(true);
  const [sshGitUrl, setSshGitUrl] = useState("");
  const [sshGitBranch, setSshGitBranch] = useState("main");
  const [sshGitToken, setSshGitToken] = useState("");
  const [sshEnableHttps, setSshEnableHttps] = useState(false);
  const [sshHttpsPort, setSshHttpsPort] = useState("8443");
  const [sshHttpsDomain, setSshHttpsDomain] = useState("");
  // Isolated backend (separate Supabase) for the local server
  const [sshIsolateBackend, setSshIsolateBackend] = useState(true);
  const [sshSupabaseUrl, setSshSupabaseUrl] = useState("");
  const [sshSupabaseKey, setSshSupabaseKey] = useState("");
  const [sshSupabaseProjectId, setSshSupabaseProjectId] = useState("");
  // Install local self-hosted Supabase on the same server
  const [sshInstallSupabaseLocal, setSshInstallSupabaseLocal] = useState(true);
  const [sshForceFreshInstall, setSshForceFreshInstall] = useState(false);
  const [sshDbStack, setSshDbStack] = useState<"supabase_full" | "postgres_only">("supabase_full");
  const [sshPostgresImage, setSshPostgresImage] = useState("postgres:15");
  const [sshSupaKongPort, setSshSupaKongPort] = useState("8000");
  const [sshSupaStudioPort, setSshSupaStudioPort] = useState("3001");
  const [sshSupaDbPort, setSshSupaDbPort] = useState("5432");
  const [sshLocalSupabaseInfo, setSshLocalSupabaseInfo] = useState<{ url: string; anon_key: string; studio_url: string } | null>(null);
  const [sshDeploying, setSshDeploying] = useState(false);
  const [sshLogs, setSshLogs] = useState<string[]>([]);
  const [sshDeployedUrl, setSshDeployedUrl] = useState<string | null>(null);
  const [sshPortSuggestions, setSshPortSuggestions] = useState<Array<{ label: string; current: string; suggested: string }>>([]);

  const isValidPort = (value: string) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  const validateSshPorts = () => {
    const ports = [
      { label: "Application", value: sshAppPort, active: true },
      { label: "HTTPS application", value: sshHttpsPort, active: sshEnableHttps },
      { label: "API Supabase/Kong", value: sshSupaKongPort, active: sshInstallSupabaseLocal },
      { label: "Studio Supabase", value: sshSupaStudioPort, active: sshInstallSupabaseLocal },
      { label: "Postgres", value: sshSupaDbPort, active: sshInstallSupabaseLocal },
    ].filter((port) => port.active);
    for (const port of ports) {
      if (!isValidPort(port.value)) return `${port.label}: port invalide (${port.value})`;
    }
    const seen = new Map<string, string>();
    for (const port of ports) {
      const existing = seen.get(port.value);
      if (existing) return `Conflit de ports: ${existing} et ${port.label} utilisent ${port.value}`;
      seen.set(port.value, port.label);
    }
    return null;
  };
  const applySshPortSuggestions = () => {
    sshPortSuggestions.forEach((item) => {
      if (item.label === "Application") setSshAppPort(item.suggested);
      if (item.label === "HTTPS application") setSshHttpsPort(item.suggested);
      if (item.label === "API Supabase/Kong") setSshSupaKongPort(item.suggested);
      if (item.label === "HTTPS Supabase/Kong") return;
      if (item.label === "Studio Supabase") setSshSupaStudioPort(item.suggested);
      if (item.label === "Postgres") setSshSupaDbPort(item.suggested);
    });
    toast.success("Ports de rechange appliqués");
  };
  const captureSshPortSuggestions = (message: string) => {
    const marker = "__PORT_SUGGESTIONS__";
    const index = message.indexOf(marker);
    if (index === -1) return message;
    try {
      const suggestions = JSON.parse(message.slice(index + marker.length));
      if (Array.isArray(suggestions)) setSshPortSuggestions(suggestions.filter((item) => item?.label && item?.suggested));
    } catch {
      // Ignore malformed diagnostic payloads and keep the readable error.
    }
    return message.slice(0, index).trim();
  };

  // ===== Persist SSH + local Supabase config in localStorage =====
  const SSH_CONFIG_KEY = "screenflow.ssh_deploy_config.v1";
  const hasLoadedConfigRef = useRef(false);

  useEffect(() => {
    if (hasLoadedConfigRef.current) return;
    hasLoadedConfigRef.current = true;
    try {
      const raw = localStorage.getItem(SSH_CONFIG_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      if (c.sshHost) setSshHost(c.sshHost);
      if (c.sshLocalIp) setSshLocalIp(c.sshLocalIp);
      if (c.sshPort) setSshPort(c.sshPort);
      if (c.sshUser) setSshUser(c.sshUser);
      if (c.sshRemoteDir) setSshRemoteDir(c.sshRemoteDir);
      if (c.sshAppPort) setSshAppPort(c.sshAppPort);
      if (typeof c.sshAutoInstallDocker === "boolean") setSshAutoInstallDocker(c.sshAutoInstallDocker);
      if (c.sshGitUrl) setSshGitUrl(c.sshGitUrl);
      if (c.sshGitBranch) setSshGitBranch(c.sshGitBranch);
      if (typeof c.sshEnableHttps === "boolean") setSshEnableHttps(c.sshEnableHttps);
      if (c.sshHttpsPort) setSshHttpsPort(c.sshHttpsPort);
      if (c.sshHttpsDomain) setSshHttpsDomain(c.sshHttpsDomain);
      if (typeof c.sshIsolateBackend === "boolean") setSshIsolateBackend(c.sshIsolateBackend);
      if (c.sshSupabaseUrl) setSshSupabaseUrl(c.sshSupabaseUrl);
      if (c.sshSupabaseKey) setSshSupabaseKey(c.sshSupabaseKey);
      if (c.sshSupabaseProjectId) setSshSupabaseProjectId(c.sshSupabaseProjectId);
      if (typeof c.sshInstallSupabaseLocal === "boolean") setSshInstallSupabaseLocal(c.sshInstallSupabaseLocal);
      if (c.sshSupaKongPort) setSshSupaKongPort(c.sshSupaKongPort);
      if (c.sshSupaStudioPort) setSshSupaStudioPort(c.sshSupaStudioPort);
      if (c.sshSupaDbPort) setSshSupaDbPort(c.sshSupaDbPort);
      if (c.sshLocalSupabaseInfo) setSshLocalSupabaseInfo(c.sshLocalSupabaseInfo);
      if (c.sshDeployedUrl) setSshDeployedUrl(c.sshDeployedUrl);
    } catch {}
  }, []);

  const persistSshConfig = (extra?: Record<string, any>) => {
    try {
      const payload = {
        sshHost, sshLocalIp, sshPort, sshUser, sshRemoteDir, sshAppPort, sshAutoInstallDocker,
        sshGitUrl, sshGitBranch,
        sshEnableHttps, sshHttpsPort, sshHttpsDomain,
        sshIsolateBackend, sshSupabaseUrl, sshSupabaseKey, sshSupabaseProjectId,
        sshInstallSupabaseLocal, sshSupaKongPort, sshSupaStudioPort, sshSupaDbPort,
        sshLocalSupabaseInfo, sshDeployedUrl,
        ...(extra || {}),
        _saved_at: new Date().toISOString(),
      };
      localStorage.setItem(SSH_CONFIG_KEY, JSON.stringify(payload));
    } catch {}
  };

  const clearSshConfig = () => {
    try { localStorage.removeItem(SSH_CONFIG_KEY); } catch {}
    toast.success("Configuration locale effacée");
  };

  // ============ EXPORTS ============

  const handleExportJSON = async () => {
    setExporting(true);
    const dump: Record<string, any> = {
      _meta: { exported_at: new Date().toISOString(), source: "ScreenFlow Backup", tables: TABLES },
    };
    try {
      let i = 0;
      for (const t of TABLES) {
        i++;
        setProgress(`Export ${t}...`);
        setProgressPct(Math.round((i / TABLES.length) * 100));
        const { data, error } = await (supabase as any).from(t).select("*");
        dump[t] = error ? { error: error.message } : (data || []);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadText(`screenflow-backup-${stamp}.json`, JSON.stringify(dump, null, 2), "application/json");
      toast.success("Sauvegarde JSON téléchargée");
    } catch (e: any) {
      toast.error("Erreur d'export: " + e.message);
    } finally {
      setExporting(false);
      setProgress("");
      setProgressPct(0);
    }
  };

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      let i = 0;
      for (const t of TABLES) {
        i++;
        setProgress(`Export CSV ${t}...`);
        setProgressPct(Math.round((i / TABLES.length) * 100));
        const { data, error } = await (supabase as any).from(t).select("*");
        if (error || !data || data.length === 0) continue;
        const cols = Object.keys(data[0]);
        const escape = (v: any) => {
          if (v === null || v === undefined) return "";
          const s = typeof v === "object" ? JSON.stringify(v) : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        };
        const csv = [cols.join(","), ...data.map((r: any) => cols.map(c => escape(r[c])).join(","))].join("\n");
        downloadText(`${t}.csv`, csv, "text/csv");
        await new Promise(r => setTimeout(r, 150));
      }
      toast.success("Export CSV terminé");
    } catch (e: any) {
      toast.error("Erreur: " + e.message);
    } finally {
      setExporting(false);
      setProgress("");
      setProgressPct(0);
    }
  };

  const handleFullArchive = async () => {
    setExporting(true);
    const zip = new JSZip();
    try {
      // 1. Tables
      const dump: Record<string, any> = {
        _meta: { exported_at: new Date().toISOString(), source: "ScreenFlow Full Backup" },
      };
      let i = 0;
      const total = TABLES.length + 2;
      for (const t of TABLES) {
        i++;
        setProgress(`Données: ${t}...`);
        setProgressPct(Math.round((i / total) * 100));
        const { data, error } = await (supabase as any).from(t).select("*");
        dump[t] = error ? { error: error.message } : (data || []);
      }
      zip.file("database.json", JSON.stringify(dump, null, 2));

      // 2. Media bucket
      i++;
      setProgress("Listing du bucket 'media'...");
      setProgressPct(Math.round((i / total) * 100));
      const mediaFolder = zip.folder("media")!;
      const manifest: Array<{ name: string; size: number; path: string; bucket: string; sha256: string }> = [];

      const sha256Hex = async (blob: Blob) => {
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
      };

      const listAll = async (bucket: string, prefix = ""): Promise<string[]> => {
        const out: string[] = [];
        const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
        if (error || !data) return out;
        for (const item of data) {
          const path = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.id === null) {
            const sub = await listAll(bucket, path);
            out.push(...sub);
          } else {
            out.push(path);
          }
        }
        return out;
      };

      for (const bucketName of ["media", "uploads"]) {
        const files = await listAll(bucketName);
        const bucketFolder = zip.folder(bucketName)!;
        let f = 0;
        for (const path of files) {
          f++;
          setProgress(`Téléchargement ${bucketName}: ${f}/${files.length} (${path})`);
          const { data: blob, error: dlErr } = await supabase.storage.from(bucketName).download(path);
          if (dlErr || !blob) {
            console.warn(`[backup] skip ${bucketName}/${path}:`, dlErr?.message);
            continue;
          }
          bucketFolder.file(path, blob);
          const sha256 = await sha256Hex(blob);
          manifest.push({ name: path, size: blob.size, path: `${bucketName}/${path}`, bucket: bucketName, sha256 });
        }
      }

      i++;
      setProgress("Génération de l'archive ZIP...");
      setProgressPct(Math.round((i / total) * 100));
      zip.file("manifest.json", JSON.stringify({
        generated_at: new Date().toISOString(),
        files_count: manifest.length,
        buckets: ["media", "uploads"],
        files: manifest,
      }, null, 2));
      zip.file("README.md", `# ScreenFlow Backup\n\nGénéré: ${new Date().toISOString()}\n\n- \`database.json\` : toutes les tables\n- \`media/\` : fichiers du bucket media\n- \`uploads/\` : fichiers du bucket uploads\n- \`manifest.json\` : index avec hashes SHA-256\n`);

      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadBlob(`screenflow-full-backup-${stamp}.zip`, blob);
      toast.success(`Archive complète créée (${manifest.length} fichiers médias)`);
    } catch (e: any) {
      toast.error("Erreur: " + e.message);
    } finally {
      setExporting(false);
      setProgress("");
      setProgressPct(0);
    }
  };

  // ============ IMPORT / RESTORE ============

  const sha256Hex = async (data: ArrayBuffer | Blob) => {
    const buf = data instanceof Blob ? await data.arrayBuffer() : data;
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  };

  const parseCSV = (text: string): any[] => {
    const lines = text.split(/\r?\n/).filter(l => l.length);
    if (lines.length < 2) return [];
    const parseLine = (line: string): string[] => {
      const out: string[] = [];
      let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else {
          if (c === '"') inQ = true;
          else if (c === ",") { out.push(cur); cur = ""; }
          else cur += c;
        }
      }
      out.push(cur);
      return out;
    };
    const headers = parseLine(lines[0]);
    return lines.slice(1).map(l => {
      const vals = parseLine(l);
      const obj: any = {};
      headers.forEach((h, idx) => {
        const v = vals[idx];
        if (v === "" || v === undefined) { obj[h] = null; return; }
        try { obj[h] = JSON.parse(v); } catch { obj[h] = v; }
      });
      return obj;
    });
  };

  const handleImportFile = async (file: File) => {
    setRestoreResults(null);
    setFileRestoreResults(null);
    setZipPreview(null);

    try {
      // ZIP archive (full backup)
      if (file.name.endsWith(".zip")) {
        setVerifying(true);
        setProgress("Lecture de l'archive...");
        const zip = await JSZip.loadAsync(file);

        // Parse database.json
        const dbFile = zip.file("database.json");
        const tablesPayload: Record<string, any[]> = {};
        if (dbFile) {
          const dbText = await dbFile.async("string");
          const parsed = JSON.parse(dbText);
          for (const [k, v] of Object.entries(parsed)) {
            if (k.startsWith("_")) continue;
            if (Array.isArray(v)) tablesPayload[k] = v;
          }
        }

        // Parse manifest.json
        const manifestFile = zip.file("manifest.json");
        let manifest: ZipPreview["manifest"] = null;
        if (manifestFile) {
          manifest = JSON.parse(await manifestFile.async("string"));
        }

        // Verify each manifest entry
        const fileChecks: ZipPreview["fileChecks"] = [];
        let totalBytes = 0;
        if (manifest?.files) {
          let i = 0;
          for (const entry of manifest.files) {
            i++;
            setProgress(`Vérification ${i}/${manifest.files.length}: ${entry.path}`);
            setProgressPct(Math.round((i / manifest.files.length) * 100));
            const zEntry = zip.file(entry.path);
            if (!zEntry) {
              fileChecks.push({ entry, present: false });
              continue;
            }
            const blob = await zEntry.async("blob");
            const sizeMatch = blob.size === entry.size;
            let sha256Match: boolean | undefined = undefined;
            if (entry.sha256) {
              const actualHash = await sha256Hex(blob);
              sha256Match = actualHash === entry.sha256;
            }
            totalBytes += blob.size;
            fileChecks.push({ entry, present: true, actualSize: blob.size, sizeMatch, sha256Match });
          }
        }

        const totalRows = Object.values(tablesPayload).reduce((s, r) => s + r.length, 0);
        setZipPreview({
          zip,
          manifest,
          tablesPayload,
          fileChecks,
          totalRows,
          totalFiles: fileChecks.length,
          totalBytes,
        });
        setProgress("");
        setProgressPct(0);
        toast.success("Archive vérifiée — vérifiez les détails avant de restaurer");
        return;
      }

      // JSON / CSV (legacy single-file imports)
      let tablesPayload: Record<string, any[]> = {};
      if (file.name.endsWith(".json")) {
        const text = await file.text();
        const parsed = JSON.parse(text);
        for (const [k, v] of Object.entries(parsed)) {
          if (k.startsWith("_")) continue;
          if (Array.isArray(v)) tablesPayload[k] = v;
        }
      } else if (file.name.endsWith(".csv")) {
        const tableName = file.name.replace(/\.csv$/, "");
        tablesPayload[tableName] = parseCSV(await file.text());
      } else {
        throw new Error("Format non supporté (.json, .csv ou .zip attendu)");
      }

      const totalRows = Object.values(tablesPayload).reduce((s, r) => s + r.length, 0);
      if (totalRows === 0) throw new Error("Aucune donnée à restaurer");

      // Show preview for non-zip too
      setZipPreview({
        zip: null as any,
        manifest: null,
        tablesPayload,
        fileChecks: [],
        totalRows,
        totalFiles: 0,
        totalBytes: 0,
      });
      toast.success("Fichier analysé — confirmez la restauration ci-dessous");
    } catch (e: any) {
      toast.error("Erreur d'analyse: " + e.message);
    } finally {
      setVerifying(false);
      setProgress("");
      setProgressPct(0);
    }
  };

  const launchRestore = async () => {
    if (!zipPreview) return;
    const { tablesPayload, zip, fileChecks } = zipPreview;
    setRestoring(true);
    setRestoreResults(null);
    setFileRestoreResults(null);

    try {
      // 1. Restore tables via edge function
      if (Object.keys(tablesPayload).length > 0) {
        setProgress("Restauration des tables...");
        const { data, error } = await supabase.functions.invoke("restore-backup", {
          body: { tables: tablesPayload, mode: restoreMode },
        });
        if (error) throw error;
        setRestoreResults(data.results);
      }

      // 2. Restore files to buckets
      if (restoreFiles && zip && fileChecks.length > 0) {
        const errors: string[] = [];
        let ok = 0, failed = 0;
        let i = 0;
        for (const check of fileChecks) {
          i++;
          if (!check.present) { failed++; continue; }
          const { entry } = check;
          setProgress(`Upload ${i}/${fileChecks.length}: ${entry.path}`);
          setProgressPct(Math.round((i / fileChecks.length) * 100));
          try {
            const zEntry = zip.file(entry.path);
            if (!zEntry) { failed++; errors.push(`${entry.path}: introuvable`); continue; }
            const blob = await zEntry.async("blob");
            const relativePath = entry.path.replace(`${entry.bucket}/`, "");
            const { error: upErr } = await supabase.storage
              .from(entry.bucket)
              .upload(relativePath, blob, { upsert: true, contentType: blob.type || undefined });
            if (upErr) { failed++; errors.push(`${entry.path}: ${upErr.message}`); }
            else ok++;
          } catch (e: any) {
            failed++;
            errors.push(`${entry.path}: ${e.message}`);
          }
        }
        setFileRestoreResults({ ok, failed, errors: errors.slice(0, 20) });
      }

      toast.success("Restauration terminée");
    } catch (e: any) {
      toast.error("Erreur de restauration: " + e.message);
    } finally {
      setRestoring(false);
      setProgress("");
      setProgressPct(0);
    }
  };

  const cancelRestore = () => {
    setZipPreview(null);
    setRestoreResults(null);
    setFileRestoreResults(null);
  };

  // ============ DOCKER ============

  const dockerCompose = buildDockerCompose(envType, envUrl, envKey, envProjectId, envPort, envPublicAppUrl);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copié`);
  };

  const downloadDockerBundle = () => {
    downloadText("Dockerfile", DOCKERFILE);
    setTimeout(() => downloadText("nginx.conf", NGINX_CONF), 200);
    setTimeout(() => downloadText("docker-compose.yml", dockerCompose, "text/yaml"), 400);
    setTimeout(() => downloadText(".dockerignore", DOCKERIGNORE), 600);
    toast.success("Fichiers Docker téléchargés");
  };

  // ============ ENV CHECK ============

  const envChecks = [
    { name: "VITE_SUPABASE_URL", value: envUrl, valid: /^https?:\/\/.+/.test(envUrl) },
    { name: "VITE_SUPABASE_PUBLISHABLE_KEY", value: envKey, valid: envKey.length > 40 },
    { name: "VITE_SUPABASE_PROJECT_ID", value: envProjectId, valid: envProjectId.length > 10 },
  ];
  const allValid = envChecks.every(c => c.valid);

  // ============ SSH DEPLOY ============

  // Detect if a host looks local/private (not reachable from a Supabase Edge Function on the public internet)
  const isLocalHost = (h: string) => {
    if (!h) return false;
    const v = h.trim().toLowerCase();
    if (v === "localhost" || v === "127.0.0.1") return true;
    // RFC1918 + link-local
    return /^10\./.test(v) || /^192\.168\./.test(v) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(v) || /^169\.254\./.test(v);
  };

  const buildProjectZip = async (): Promise<string> => {
    const zip = new JSZip();
    zip.file("Dockerfile", DOCKERFILE);
    zip.file("nginx.conf", NGINX_CONF);
    zip.file(".dockerignore", DOCKERIGNORE);
    zip.file(
      "docker-compose.yml",
      buildDockerCompose("prod", envUrl, envKey, envProjectId, sshAppPort, envPublicAppUrl || `http://${sshHost || "IP_SERVEUR"}:${sshAppPort}`),
    );
    zip.file(
      "README.txt",
      `ScreenFlow deployment package
Generated: ${new Date().toISOString()}
App will be exposed on port ${sshAppPort}
To rebuild manually: docker compose up -d --build
`,
    );
    // NOTE: source files are not bundled here (they're hosted on Lovable). 
    // The Dockerfile builds from a git source — we provide a minimal compose that pulls
    // the prebuilt image OR uses local sources if you copy them in.
    // For a fully self-contained build, also include a placeholder index.html:
    zip.file(
      "index.html",
      `<!doctype html><html><head><meta charset="utf-8"/><title>ScreenFlow</title></head><body>
<script>window.location.href="/";</script>
</body></html>`,
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const buf = await blob.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(bin);
  };

  const getFreshAccessToken = async () => {
    const refreshed = await supabase.auth.refreshSession();
    let session = refreshed.data.session;

    if (!session?.access_token) {
      const fallback = await supabase.auth.getSession();
      session = fallback.data.session;
    }

    if (session?.access_token) {
      const { data: userData, error: userError } = await supabase.auth.getUser(session.access_token);
      if (!userError && userData.user) return session.access_token;
    }

    await supabase.auth.signOut();
    toast.error("Session expirée. Reconnectez-vous puis relancez le déploiement.");
    window.location.href = "/login";
    return null;
  };

  const handleSshDeploy = async () => {
    if (!sshHost || !sshUser || !sshPassword) {
      toast.error("Renseignez l'IP, l'utilisateur et le mot de passe");
      return;
    }
    if (!sshGitUrl) {
      toast.error("Renseignez l'URL du dépôt Git");
      return;
    }
    // Validation: backend creds required only if isolating WITHOUT installing local Supabase
    if (sshIsolateBackend && !sshInstallSupabaseLocal && (!sshSupabaseUrl || !sshSupabaseKey || !sshSupabaseProjectId)) {
      toast.error("Backend isolé activé : renseignez l'URL, la clé et le project ID Supabase OU activez 'Installer Supabase local'");
      return;
    }
    // When installing local Supabase, the function will override the creds itself
    const backendUrl = sshInstallSupabaseLocal ? "" : (sshIsolateBackend ? sshSupabaseUrl.trim() : envUrl);
    const backendKey = sshInstallSupabaseLocal ? "" : (sshIsolateBackend ? sshSupabaseKey.trim() : envKey);
    const backendProjectId = sshInstallSupabaseLocal ? "" : (sshIsolateBackend ? sshSupabaseProjectId.trim() : envProjectId);
    if (sshIsolateBackend && !sshInstallSupabaseLocal && backendUrl === envUrl) {
      toast.error("L'URL Supabase du serveur local doit être DIFFÉRENTE de celle du projet en ligne");
      return;
    }
    const portError = validateSshPorts();
    if (portError) {
      toast.error(portError);
      return;
    }
    setSshDeploying(true);
    setSshLogs([]);
    setSshDeployedUrl(null);
    setSshLocalSupabaseInfo(null);
    setSshPortSuggestions([]);
    try {
      setSshLogs(["🔐 Vérification de la session admin…"]);
      const accessToken = await getFreshAccessToken();
      if (!accessToken) return;

      setSshLogs(prev => [...prev, "🔌 Connexion au serveur…"]);

      const { data, error } = await supabase.functions.invoke("ssh-deploy", {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          host: sshHost.trim(),
          local_ip: sshLocalIp.trim() || "127.0.0.1",
          port: parseInt(sshPort) || 22,
          username: sshUser.trim(),
          password: sshPassword,
          remote_dir: sshRemoteDir.trim() || "/opt/screenflow",
          app_port: sshAppPort,
          install_docker: sshAutoInstallDocker,
          vite_supabase_url: backendUrl,
          vite_supabase_key: backendKey,
          vite_supabase_project_id: backendProjectId,
          vite_public_app_url: `http://${sshHost.trim()}:${sshAppPort}`,
          vite_app_base_path: "/",
          git_url: sshGitUrl.trim(),
          git_branch: sshGitBranch.trim() || "main",
          git_token: sshGitToken.trim() || undefined,
          enable_https: sshEnableHttps,
          https_port: sshHttpsPort,
          https_domain: sshHttpsDomain.trim() || undefined,
          install_supabase_local: sshInstallSupabaseLocal,
          force_fresh_install: sshForceFreshInstall,
          supabase_kong_http_port: sshSupaKongPort,
          supabase_studio_port: sshSupaStudioPort,
          supabase_db_port: sshSupaDbPort,
          db_stack: sshDbStack,
          postgres_image: sshPostgresImage,
        },
      });
      if (error) throw error;

      // The function now returns 202 + job_id and runs the deployment in background.
      const jobId = data?.job_id as string | undefined;
      if (!jobId) {
        // Backwards compat: synchronous response
        const logs = (data?.logs as string[]) || [];
        setSshLogs(prev => [...prev, ...logs]);
        if (data?.success) handleDeploySuccess(data.url, data.supabase_local || null);
        else toast.error("Échec du déploiement: " + (data?.error || "inconnu"));
        return;
      }

      setSshLogs(prev => [...prev, `📋 Job ${jobId} démarré — suivi en arrière-plan…`]);
      // Poll app_settings every 4s for up to 30 min
      const settingsKey = `ssh_deploy_job:${jobId}`;
      const start = Date.now();
      const maxMs = 30 * 60 * 1000;
      let lastProgressAt = Date.now();
      let lastLogCount = 0;

      while (Date.now() - start < maxMs) {
        await new Promise(r => setTimeout(r, 4000));
        const { data: row } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", settingsKey)
          .maybeSingle();
        if (!row?.value) {
          if (Date.now() - lastProgressAt > 3 * 60 * 1000) {
            const msg = "✗ Aucun statut reçu depuis 3 min : le job distant n'a pas pu écrire son résultat. Vérifiez la connexion puis relancez le déploiement.";
            setSshLogs(prev => [...prev, msg]);
            toast.error("Aucun résultat reçu — relancez le déploiement.");
            return;
          }
          continue;
        }
        let parsed: any;
        try { parsed = JSON.parse(row.value as string); } catch { continue; }

        if (Array.isArray(parsed.logs)) {
          if (parsed.logs.length !== lastLogCount) {
            lastProgressAt = Date.now();
            lastLogCount = parsed.logs.length;
          }
          setSshLogs(parsed.logs);
        }

        if (parsed.status === "success") {
          handleDeploySuccess(parsed.result?.url, parsed.result?.supabase_local || null);
          return;
        }
        if (parsed.status === "error") {
          const cleanError = captureSshPortSuggestions(parsed.error || "inconnu");
          toast.error("Échec du déploiement: " + cleanError);
          return;
        }
        if (Date.now() - lastProgressAt > 3 * 60 * 1000) {
          const msg = "✗ Aucun nouveau retour depuis 3 min : le job distant a probablement été coupé par le timeout de la fonction. Relancez le déploiement, il reprendra en mode mise à jour avec les images déjà téléchargées.";
          setSshLogs(prev => [...prev, msg]);
          toast.error("Déploiement interrompu sans résultat — relancez une fois.");
          return;
        }
      }
      setSshLogs(prev => [...prev, "✗ Délai maximum dépassé sans résultat final."]);
      toast.warning("Le déploiement prend plus de 30 min — consultez les logs serveur.");
    } catch (e: any) {
      const cleanError = captureSshPortSuggestions(e?.message || String(e));
      setSshLogs(prev => [...prev, "✗ Erreur: " + cleanError]);
      toast.error("Erreur: " + cleanError);
    } finally {
      setSshDeploying(false);
    }
  };

  const handleDeploySuccess = (url: string, localInfo: any) => {
    setSshDeployedUrl(url);
    if (localInfo) setSshLocalSupabaseInfo(localInfo);
    const updates: Record<string, any> = { sshDeployedUrl: url, sshLocalSupabaseInfo: localInfo };
    if (localInfo?.url) { setSshSupabaseUrl(localInfo.url); updates.sshSupabaseUrl = localInfo.url; }
    if (localInfo?.anon_key) { setSshSupabaseKey(localInfo.anon_key); updates.sshSupabaseKey = localInfo.anon_key; }
    persistSshConfig(updates);
    toast.success("Déploiement réussi 🚀 Configuration sauvegardée");
  };

  const handleResetAdminPassword = async () => {
    if (!sshHost || !sshUser || !sshPassword) {
      toast.error("Renseignez l'IP, l'utilisateur et le mot de passe SSH");
      return;
    }
    const customPwd = window.prompt(
      "Créer/réparer le premier compte admin screenflow@screenflow.local\nMot de passe (laisser vide pour la valeur par défaut '260390DS') :",
      ""
    );
    if (customPwd === null) return; // user cancelled
    const newPwd = customPwd.trim();
    if (newPwd && newPwd.length < 6) {
      toast.error("Le mot de passe doit contenir au moins 6 caractères");
      return;
    }
    if (!window.confirm(
      `Confirmer la création/réparation du premier admin sur ${sshHost} ?\n\n` +
      `Email : screenflow@screenflow.local\n` +
      `Mot de passe : ${newPwd || "260390DS (défaut)"}`
    )) return;

    setSshDeploying(true);
    setSshLogs(["🔐 Création/réparation du premier compte admin…"]);
    try {
      const accessToken = await getFreshAccessToken();
      if (!accessToken) return;

      setSshLogs(prev => [...prev, "🔌 Connexion au serveur pour reset…"]);
      const { data, error } = await supabase.functions.invoke("ssh-deploy", {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          action: "reset_admin_password",
          host: sshHost.trim(),
          local_ip: sshLocalIp.trim() || "127.0.0.1",
          port: parseInt(sshPort) || 22,
          username: sshUser.trim(),
          password: sshPassword,
          remote_dir: sshRemoteDir.trim() || "/opt/screenflow",
          admin_password: newPwd || undefined,
        },
      });
      if (error) throw error;

      const jobId = data?.job_id as string | undefined;
      if (!jobId) {
        toast.error("Job non démarré");
        return;
      }
      setSshLogs(prev => [...prev, `📋 Job ${jobId} démarré…`]);
      const settingsKey = `ssh_deploy_job:${jobId}`;
      const start = Date.now();
      const maxMs = 5 * 60 * 1000;
      while (Date.now() - start < maxMs) {
        await new Promise(r => setTimeout(r, 3000));
        const { data: row } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", settingsKey)
          .maybeSingle();
        if (!row?.value) continue;
        let parsed: any;
        try { parsed = JSON.parse(row.value as string); } catch { continue; }
        if (Array.isArray(parsed.logs)) setSshLogs(parsed.logs);
        if (parsed.status === "success") {
          toast.success("Premier compte admin créé/réparé ✓");
          return;
        }
        if (parsed.status === "error") {
          toast.error("Échec : " + (parsed.error || "inconnu"));
          return;
        }
      }
      toast.warning("Délai dépassé — consultez les logs.");
    } catch (e: any) {
      setSshLogs(prev => [...prev, "✗ Erreur: " + (e?.message || String(e))]);
      toast.error("Erreur: " + (e?.message || String(e)));
    } finally {
      setSshDeploying(false);
    }
  };

  const handleRepairLocalWrites = async () => {
    if (!sshHost || !sshUser || !sshPassword) {
      toast.error("Renseignez l'IP, l'utilisateur et le mot de passe SSH");
      return;
    }

    setSshDeploying(true);
    setSshLogs(["🛠 Réparation upload médias / création écrans…"]);
    try {
      const accessToken = await getFreshAccessToken();
      if (!accessToken) return;

      const { data, error } = await supabase.functions.invoke("ssh-deploy", {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          action: "repair_local_writes",
          host: sshHost.trim(),
          local_ip: sshLocalIp.trim() || "127.0.0.1",
          port: parseInt(sshPort) || 22,
          username: sshUser.trim(),
          password: sshPassword,
          remote_dir: sshRemoteDir.trim() || "/opt/screenflow",
          app_port: sshAppPort,
          supabase_kong_http_port: sshSupaKongPort,
        },
      });
      if (error) throw error;
      const jobId = data?.job_id as string | undefined;
      if (!jobId) throw new Error("Job non démarré");

      const settingsKey = `ssh_deploy_job:${jobId}`;
      const start = Date.now();
      while (Date.now() - start < 5 * 60 * 1000) {
        await new Promise(r => setTimeout(r, 3000));
        const { data: row } = await supabase.from("app_settings").select("value").eq("key", settingsKey).maybeSingle();
        if (!row?.value) continue;
        let parsed: any;
        try { parsed = JSON.parse(row.value as string); } catch { continue; }
        if (Array.isArray(parsed.logs)) setSshLogs(parsed.logs);
        if (parsed.status === "success") {
          handleDeploySuccess(parsed.result?.url || `http://${sshHost.trim()}:${sshAppPort}`, parsed.result?.supabase_local || null);
          toast.success("Certificat/API + upload/écrans réparés ✓");
          return;
        }
        if (parsed.status === "error") { toast.error("Échec : " + (parsed.error || "inconnu")); return; }
      }
      toast.warning("Délai dépassé — consultez les logs.");
    } catch (e: any) {
      setSshLogs(prev => [...prev, "✗ Erreur: " + (e?.message || String(e))]);
      toast.error("Erreur: " + (e?.message || String(e)));
    } finally {
      setSshDeploying(false);
    }
  };

  // ===== Generic SSH action runner with polling =====
  type DiagCheck = { key: string; label: string; ok: boolean; detail?: string; suggested_action?: string };
  const [serverDiag, setServerDiag] = useState<{ checks: DiagCheck[]; suggestions: string[] } | null>(null);
  type MigItem = { name: string; status: "applied" | "skipped" | "error"; error?: string };
  const [migrationResult, setMigrationResult] = useState<{ total: number; applied: number; skipped: number; errors: number; items: MigItem[] } | null>(null);
  type UploadRepairResult = {
    ok?: boolean;
    url?: string;
    storage_tests?: Array<{ label: string; bucket: string; ok: boolean; status: string; detail?: string }>;
    proxy?: { ok?: boolean; patched?: boolean; skipped?: boolean; detail?: string; http_status?: string };
  };
  const [uploadRepairResult, setUploadRepairResult] = useState<UploadRepairResult | null>(null);

  const runSshAction = async (
    action: string,
    extra: Record<string, any> = {},
    opts: { successMessage?: string; onResult?: (r: any) => void; initialLog?: string } = {},
  ) => {
    if (!sshHost || !sshUser || !sshPassword) {
      toast.error("Renseignez l'IP, l'utilisateur et le mot de passe SSH");
      return;
    }
    setSshDeploying(true);
    setSshLogs([opts.initialLog || `▶ Action: ${action}`]);
    try {
      const accessToken = await getFreshAccessToken();
      if (!accessToken) return;
      const { data, error } = await supabase.functions.invoke("ssh-deploy", {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          action,
          host: sshHost.trim(),
          local_ip: sshLocalIp.trim() || "127.0.0.1",
          port: parseInt(sshPort) || 22,
          username: sshUser.trim(),
          password: sshPassword,
          remote_dir: sshRemoteDir.trim() || "/opt/screenflow",
          app_port: sshAppPort,
          supabase_kong_http_port: sshSupaKongPort,
          ...extra,
        },
      });
      if (error) throw error;
      const jobId = data?.job_id as string | undefined;
      if (!jobId) throw new Error("Job non démarré");
      const settingsKey = `ssh_deploy_job:${jobId}`;
      const start = Date.now();
      while (Date.now() - start < 5 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 3000));
        const { data: row } = await supabase.from("app_settings").select("value").eq("key", settingsKey).maybeSingle();
        if (!row?.value) continue;
        let parsed: any;
        try { parsed = JSON.parse(row.value as string); } catch { continue; }
        if (Array.isArray(parsed.logs)) setSshLogs(parsed.logs);
        if (parsed.status === "success") {
          if (opts.onResult) opts.onResult(parsed.result || null);
          toast.success(opts.successMessage || "Action terminée ✓");
          return;
        }
        if (parsed.status === "error") {
          toast.error("Échec : " + (parsed.error || "inconnu"));
          return;
        }
      }
      toast.warning("Délai dépassé — consultez les logs.");
    } catch (e: any) {
      setSshLogs((prev) => [...prev, "✗ Erreur: " + (e?.message || String(e))]);
      toast.error("Erreur: " + (e?.message || String(e)));
    } finally {
      setSshDeploying(false);
    }
  };

  const handleDiagnoseServer = () =>
    runSshAction("diagnose_server", {}, {
      initialLog: "🔎 Diagnostic du serveur en cours…",
      successMessage: "Diagnostic terminé",
      onResult: (r) => {
        if (r?.checks) setServerDiag({ checks: r.checks, suggestions: r.suggestions || [] });
      },
    });

  const handleRestartStack = () =>
    runSshAction("restart_stack", {}, {
      initialLog: "🔄 Redémarrage de la stack Docker…",
      successMessage: "Stack redémarrée ✓",
    });

  const handleRepairWebContainer = () =>
    runSshAction("repair_web_container", {}, {
      initialLog: "🛠 Réparation du conteneur web (diagnostic + rebuild)…",
      successMessage: "Conteneur web réparé ✓",
    });

  const handleRepairBuckets = () =>
    runSshAction("repair_storage_buckets", {}, {
      initialLog: "🪣 Réparation des buckets Storage…",
      successMessage: "Buckets réparés ✓",
      onResult: (r) => setUploadRepairResult(r),
    });

  const handleRepairUploadsNow = () => {
    setUploadRepairResult(null);
    runSshAction("repair_uploads_now", {}, {
      initialLog: "🛠 Correction uploads bibliothèque + QR sans redéploiement complet…",
      successMessage: "Uploads corrigés ✓",
      onResult: (r) => {
        if (r) setUploadRepairResult(r);
        if (r?.url) {
          setSshDeployedUrl(r.url);
          const updates: Record<string, any> = { sshDeployedUrl: r.url };
          if (r.supabase_local) {
            setSshLocalSupabaseInfo(r.supabase_local);
            updates.sshLocalSupabaseInfo = r.supabase_local;
            if (r.supabase_local.url) {
              setSshSupabaseUrl(r.supabase_local.url);
              updates.sshSupabaseUrl = r.supabase_local.url;
            }
            if (r.supabase_local.anon_key) {
              setSshSupabaseKey(r.supabase_local.anon_key);
              updates.sshSupabaseKey = r.supabase_local.anon_key;
            }
          }
          persistSshConfig(updates);
        }
      },
    });
  };

  const handleRepairRealtime = () =>
    runSshAction("repair_realtime", {}, {
      initialLog: "📡 Réparation Realtime…",
      successMessage: "Realtime réparé ✓",
    });

  const handleRepairLanLogin = () =>
    runSshAction("repair_lan_login", {}, {
      initialLog: "🌐 Correctif radical LAN : détection IP privée, rebuild propre et test du vrai login…",
      successMessage: "Correctif login LAN appliqué ✓",
      onResult: (r) => {
        if (!r?.url) return;
        const repairedUrl = new URL(r.url);
        setSshLocalIp(repairedUrl.hostname);
        setSshDeployedUrl(r.url);
        persistSshConfig({ sshLocalIp: repairedUrl.hostname, sshDeployedUrl: r.url });
      },
    });

  const handleRepairApiUrl = () =>
    runSshAction("repair_local_api_url", {}, {
      initialLog: "🌐 Correction de l'URL API locale…",
      successMessage: "URL API corrigée ✓",
      onResult: (r) => { if (r?.url) handleDeploySuccess(r.url, r.supabase_local || null); },
    });

  const handleApplyMigrations = () => {
    setMigrationResult(null);
    runSshAction("apply_local_migrations", {}, {
      initialLog: "🗃 Application des migrations manquantes…",
      successMessage: "Migrations appliquées ✓",
      onResult: (r) => {
        if (r && Array.isArray(r.items)) {
          setMigrationResult({
            total: r.total ?? r.items.length,
            applied: r.applied ?? 0,
            skipped: r.skipped ?? 0,
            errors: r.errors ?? 0,
            items: r.items,
          });
        }
      },
    });
  };

  const [quickUpdateResult, setQuickUpdateResult] = useState<{
    git?: { ok: boolean; commit?: string; changed_files?: number; message?: string };
    functions?: { ok: boolean };
    web_rebuild?: { ok: boolean };
  } | null>(null);
  const handleQuickUpdate = () => {
    setQuickUpdateResult(null);
    setMigrationResult(null);
    runSshAction("quick_update", {
      git_url: sshGitUrl.trim() || undefined,
      git_branch: sshGitBranch.trim() || "main",
      git_token: sshGitToken.trim() || undefined,
    }, {

      initialLog: "⚡ Mise à jour rapide (git pull + migrations + rebuild web)…",
      successMessage: "Mise à jour appliquée ✓",
      onResult: (r) => {
        if (!r) return;
        setQuickUpdateResult(r);
        if (r.migrations?.items) {
          setMigrationResult({
            total: r.migrations.items.length,
            applied: r.migrations.applied || 0,
            skipped: r.migrations.skipped || 0,
            errors: r.migrations.errors || 0,
            items: r.migrations.items,
          });
        }
      },
    });
  };

  const handleBuildStatus = () => {
    runSshAction("build_status", {}, {
      initialLog: "🔍 Vérification du build en cours sur le serveur…",
      successMessage: "Vérification du build terminée ✓",
    });
  };


  // ===== Network management =====
  const [networkInfo, setNetworkInfo] = useState<any>(null);
  const [networkConfig, setNetworkConfig] = useState<any>(null);
  const [netSubnet, setNetSubnet] = useState("172.28.0.0/16");
  const [netGateway, setNetGateway] = useState("");
  const [netName, setNetName] = useState("screenflow_default");
  const [netIpRange, setNetIpRange] = useState("");
  const [netMtu, setNetMtu] = useState<string>("");
  const [netDns, setNetDns] = useState<string>("8.8.8.8, 1.1.1.1");
  const [netContainerIps, setNetContainerIps] = useState<string>("web=172.28.0.10\nkong=172.28.0.20");
  const [sysHostname, setSysHostname] = useState<string>("");
  const [sysHostAlias, setSysHostAlias] = useState<string>("");

  const parseContainerIps = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    raw.split(/[\n,]/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
      const m = line.match(/^([a-zA-Z0-9_\-]+)\s*[=:]\s*(\d+\.\d+\.\d+\.\d+)$/);
      if (m) out[m[1]] = m[2];
    });
    return out;
  };

  const handleNetworkInspect = () => {
    setNetworkInfo(null);
    runSshAction("network_inspect", {}, {
      initialLog: "🔎 Inspection du réseau Docker…",
      successMessage: "Inspection terminée ✓",
      onResult: (r) => setNetworkInfo(r),
    });
  };
  const handleNetworkGetConfig = () => {
    setNetworkConfig(null);
    runSshAction("network_get_config", {}, {
      initialLog: "📡 Lecture de la configuration réseau du serveur…",
      successMessage: "Configuration réseau lue ✓",
      onResult: (r) => {
        setNetworkConfig(r);
        if (r?.hostname && !sysHostname) setSysHostname(r.hostname);
      },
    });
  };
  const handleNetworkRecreate = () => {
    runSshAction("network_recreate", {}, {
      initialLog: "♻ Recréation du réseau Docker…",
      successMessage: "Réseau recréé ✓",
    });
  };
  const handleNetworkSetSubnet = () => {
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(netSubnet.trim())) {
      toast.error("Sous-réseau invalide (utilisez la notation CIDR, ex: 172.28.0.0/16)");
      return;
    }
    const dnsList = netDns.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    for (const d of dnsList) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(d)) { toast.error(`DNS invalide: ${d}`); return; }
    }
    const cIps = parseContainerIps(netContainerIps);
    const mtuNum = netMtu.trim() ? Number(netMtu.trim()) : undefined;
    if (mtuNum !== undefined && (!Number.isFinite(mtuNum) || mtuNum < 576 || mtuNum > 9000)) {
      toast.error("MTU invalide (576-9000)"); return;
    }
    runSshAction("network_set_subnet", {
      network_subnet: netSubnet.trim(),
      network_gateway: netGateway.trim() || undefined,
      network_name: netName.trim() || "screenflow_default",
      network_ip_range: netIpRange.trim() || undefined,
      network_mtu: mtuNum,
      network_dns: dnsList,
      container_ips: cIps,
    }, {
      initialLog: `🌐 Application de la configuration réseau (${netSubnet} sur ${netName})…`,
      successMessage: "Configuration réseau appliquée ✓",
    });
  };
  const handleSetHostname = () => {
    const h = sysHostname.trim();
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9])?$/.test(h)) {
      toast.error("Hostname invalide (RFC 1123)"); return;
    }
    runSshAction("network_set_hostname", {
      hostname: h,
      hostname_alias: sysHostAlias.trim() || undefined,
    }, {
      initialLog: `🖥️ Application du hostname '${h}'…`,
      successMessage: "Hostname appliqué ✓",
    });
  };

  // Live container IP editing (no redeploy)
  const [containerIpEdits, setContainerIpEdits] = useState<Record<string, string>>({});
  const [manualCid, setManualCid] = useState("");
  const [manualNewIp, setManualNewIp] = useState("");
  const [manualNetName, setManualNetName] = useState("screenflow_default");

  const handleApplyLiveContainerIp = (network: string, containerIdOrName: string, label: string) => {
    const ip = (containerIpEdits[containerIdOrName] || "").trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { toast.error(`IP invalide pour ${label}: ${ip}`); return; }
    runSshAction("network_set_container_ip", {
      network_name: network,
      container_id: containerIdOrName,
      new_ip: ip,
    }, {
      initialLog: `🔧 Application live de l'IP ${ip} sur ${label} (réseau ${network})…`,
      successMessage: `IP ${ip} appliquée sur ${label} ✓`,
      onResult: () => { setTimeout(handleNetworkInspect, 800); },
    });
  };

  const handleManualContainerIp = () => {
    if (!manualCid.trim()) { toast.error("ID ou nom du conteneur requis"); return; }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(manualNewIp.trim())) { toast.error("IP invalide"); return; }
    runSshAction("network_set_container_ip", {
      network_name: manualNetName.trim() || "screenflow_default",
      container_id: manualCid.trim(),
      new_ip: manualNewIp.trim(),
    }, {
      initialLog: `🔧 Modification IP live: ${manualCid} → ${manualNewIp}…`,
      successMessage: "IP appliquée en direct ✓",
      onResult: () => { setTimeout(handleNetworkInspect, 800); },
    });
  };
  const fixActionMap: Record<string, { label: string; run: () => void }> = {
    quick_update: { label: "Mise à jour rapide", run: handleQuickUpdate },
    restart_stack: { label: "Redémarrer la stack", run: handleRestartStack },
    repair_web_container: { label: "Réparer le conteneur web", run: handleRepairWebContainer },
    repair_uploads_now: { label: "Corriger uploads sans redéploiement", run: handleRepairUploadsNow },
    repair_local_writes: { label: "Réparer upload/écrans", run: handleRepairLocalWrites },
    repair_local_api_url: { label: "Corriger l'URL API", run: handleRepairApiUrl },
    repair_lan_login: { label: "Corriger le login en LAN", run: handleRepairLanLogin },
    repair_storage_buckets: { label: "Réparer buckets Storage", run: handleRepairBuckets },
    repair_realtime: { label: "Réparer Realtime", run: handleRepairRealtime },
    reset_admin_password: { label: "Créer/réparer admin", run: handleResetAdminPassword },
    redeploy: { label: "Relancer un déploiement complet", run: () => toast.info("Lancez 'Déployer maintenant' ci-dessous.") },
  };

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Backup & Déploiement</h1>
        <p className="text-muted-foreground mt-1">
          Sauvegarde, restauration et configuration de déploiement Docker.
        </p>
      </div>

      <Tabs defaultValue="backup" className="space-y-4">
        <TabsList>
          <TabsTrigger value="backup" className="gap-2"><Database className="h-4 w-4" />Sauvegarde</TabsTrigger>
          <TabsTrigger value="restore" className="gap-2"><Upload className="h-4 w-4" />Restauration</TabsTrigger>
          <TabsTrigger value="env" className="gap-2"><ShieldCheck className="h-4 w-4" />Vérif. Env</TabsTrigger>
          <TabsTrigger value="docker" className="gap-2"><Container className="h-4 w-4" />Docker</TabsTrigger>
          
          <TabsTrigger value="ssh" className="gap-2"><Server className="h-4 w-4" />Déploiement SSH</TabsTrigger>
        </TabsList>

        {/* ============ BACKUP TAB ============ */}
        <TabsContent value="backup" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><FileArchive className="h-5 w-5" />Exporter les données</CardTitle>
              <CardDescription>Téléchargez toutes les tables au format JSON, CSV, ou une archive complète avec les médias.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {TABLES.map(t => <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>)}
              </div>
              <Separator />
              <div className="flex flex-wrap gap-3">
                <Button onClick={handleExportJSON} disabled={exporting} className="gap-2">
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Sauvegarde JSON
                </Button>
                <Button onClick={handleExportCSV} disabled={exporting} variant="outline" className="gap-2">
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Export CSV (par table)
                </Button>
                <Button onClick={handleFullArchive} disabled={exporting} variant="default" className="gap-2 bg-primary">
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
                  Archive complète (DB + médias)
                </Button>
              </div>
              {progress && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{progress}</p>
                  <Progress value={progressPct} className="h-2" />
                </div>
              )}
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  L'archive complète inclut les buckets <code>media</code> et <code>uploads</code>. Le téléchargement peut prendre plusieurs minutes selon le volume.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============ RESTORE TAB ============ */}
        <TabsContent value="restore" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" />Restaurer une sauvegarde</CardTitle>
              <CardDescription>Importez une archive ZIP complète, un JSON multi-tables, ou un CSV. Les ZIP sont vérifiés avant restauration.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Action critique</AlertTitle>
                <AlertDescription className="text-xs">
                  Le mode <strong>upsert</strong> remplace les enregistrements existants par ID. Les fichiers seront uploadés en mode upsert dans les buckets. Faites une sauvegarde au préalable.
                </AlertDescription>
              </Alert>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <Label className="text-xs">Mode d'import des tables</Label>
                  <Select value={restoreMode} onValueChange={(v: any) => setRestoreMode(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="upsert">Upsert (remplacer si existe)</SelectItem>
                      <SelectItem value="insert">Insert seulement</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Fichier (.zip, .json ou .csv)</Label>
                  <Input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.csv,.zip"
                    disabled={restoring || verifying}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleImportFile(f);
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>

              {(verifying || (restoring && progress)) && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {progress || (verifying ? "Vérification..." : "Restauration...")}
                  </div>
                  {progressPct > 0 && <Progress value={progressPct} className="h-2" />}
                </div>
              )}

              {/* ===== ZIP VERIFICATION SCREEN ===== */}
              {zipPreview && !restoreResults && !fileRestoreResults && (
                <div className="space-y-4 border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">Vérification de la sauvegarde</h3>
                  </div>

                  {zipPreview.manifest?.generated_at && (
                    <p className="text-xs text-muted-foreground">
                      Générée le : <code>{new Date(zipPreview.manifest.generated_at).toLocaleString()}</code>
                    </p>
                  )}

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-background p-3 rounded-lg border">
                      <div className="text-xs text-muted-foreground">Tables</div>
                      <div className="text-2xl font-bold">{Object.keys(zipPreview.tablesPayload).length}</div>
                    </div>
                    <div className="bg-background p-3 rounded-lg border">
                      <div className="text-xs text-muted-foreground">Lignes</div>
                      <div className="text-2xl font-bold">{zipPreview.totalRows.toLocaleString()}</div>
                    </div>
                    <div className="bg-background p-3 rounded-lg border">
                      <div className="text-xs text-muted-foreground">Fichiers</div>
                      <div className="text-2xl font-bold">{zipPreview.totalFiles}</div>
                    </div>
                    <div className="bg-background p-3 rounded-lg border">
                      <div className="text-xs text-muted-foreground">Taille totale</div>
                      <div className="text-2xl font-bold">{(zipPreview.totalBytes / 1024 / 1024).toFixed(1)} MB</div>
                    </div>
                  </div>

                  {/* Tables list */}
                  {Object.keys(zipPreview.tablesPayload).length > 0 && (
                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase">Tables détectées</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(zipPreview.tablesPayload).map(([t, rows]) => (
                          <Badge key={t} variant="secondary" className="text-xs">
                            {t} <span className="ml-1 opacity-70">({rows.length})</span>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* File integrity */}
                  {zipPreview.fileChecks.length > 0 && (() => {
                    const missing = zipPreview.fileChecks.filter(c => !c.present).length;
                    const sizeBad = zipPreview.fileChecks.filter(c => c.present && c.sizeMatch === false).length;
                    const hashBad = zipPreview.fileChecks.filter(c => c.present && c.sha256Match === false).length;
                    const valid = zipPreview.fileChecks.length - missing - sizeBad - hashBad;
                    return (
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase">Intégrité des fichiers</h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                          <div className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />{valid} valides</div>
                          <div className="flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-destructive" />{missing} manquants</div>
                          <div className="flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5 text-orange-500" />{sizeBad} taille KO</div>
                          <div className="flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5 text-orange-500" />{hashBad} hash KO</div>
                        </div>
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Voir le détail des fichiers</summary>
                          <div className="mt-2 border rounded-lg divide-y max-h-64 overflow-y-auto bg-background">
                            {zipPreview.fileChecks.map((c, idx) => {
                              const status = !c.present ? "missing" : (c.sizeMatch === false || c.sha256Match === false) ? "warn" : "ok";
                              return (
                                <div key={idx} className="flex items-center justify-between p-2 gap-2">
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    {status === "ok" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                                    {status === "warn" && <AlertCircle className="h-3.5 w-3.5 text-orange-500 shrink-0" />}
                                    {status === "missing" && <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                                    <code className="truncate">{c.entry.path}</code>
                                  </div>
                                  <div className="text-muted-foreground shrink-0 text-[10px]">
                                    {(c.entry.size / 1024).toFixed(1)} KB
                                    {c.sha256Match === false && <span className="ml-1 text-orange-500">hash≠</span>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      </div>
                    );
                  })()}

                  {zipPreview.fileChecks.length > 0 && (
                    <div className="flex items-center justify-between p-3 bg-background rounded-lg border">
                      <div>
                        <Label className="text-sm font-medium">Restaurer aussi les fichiers</Label>
                        <p className="text-xs text-muted-foreground">Re-upload des médias dans les buckets via le manifest</p>
                      </div>
                      <Switch checked={restoreFiles} onCheckedChange={setRestoreFiles} />
                    </div>
                  )}

                  <div className="flex gap-2 pt-2">
                    <Button onClick={launchRestore} disabled={restoring} className="gap-2">
                      {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                      Lancer la restauration
                    </Button>
                    <Button onClick={cancelRestore} disabled={restoring} variant="outline">Annuler</Button>
                  </div>
                </div>
              )}

              {/* ===== TABLE RESTORE RESULTS ===== */}
              {restoreResults && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Résultats — Tables</h3>
                  <div className="border rounded-lg divide-y max-h-80 overflow-y-auto">
                    {Object.entries(restoreResults).map(([table, r]) => (
                      <div key={table} className="flex items-center justify-between p-2.5 text-sm">
                        <div className="flex items-center gap-2">
                          {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
                          <code className="text-xs">{table}</code>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {r.ok ? `${r.count} ligne(s)` : <span className="text-destructive">{r.error}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ===== FILE RESTORE RESULTS ===== */}
              {fileRestoreResults && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Résultats — Fichiers</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-emerald-500/10 border border-emerald-500/30 p-3 rounded-lg">
                      <div className="flex items-center gap-2 text-emerald-600">
                        <CheckCircle2 className="h-4 w-4" />
                        <span className="text-sm font-semibold">{fileRestoreResults.ok}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">Fichiers uploadés</p>
                    </div>
                    <div className="bg-destructive/10 border border-destructive/30 p-3 rounded-lg">
                      <div className="flex items-center gap-2 text-destructive">
                        <XCircle className="h-4 w-4" />
                        <span className="text-sm font-semibold">{fileRestoreResults.failed}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">Échecs</p>
                    </div>
                  </div>
                  {fileRestoreResults.errors.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Voir les erreurs ({fileRestoreResults.errors.length})</summary>
                      <ul className="mt-2 space-y-1 bg-muted/50 p-3 rounded-lg max-h-40 overflow-y-auto">
                        {fileRestoreResults.errors.map((e, i) => <li key={i}><code>{e}</code></li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============ ENV CHECK TAB ============ */}
        <TabsContent value="env" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Vérification des variables d'environnement</CardTitle>
              <CardDescription>Validez vos variables Supabase et générez un guide de déploiement adapté.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3">
                <div>
                  <Label className="text-xs">Type d'environnement</Label>
                  <Select value={envType} onValueChange={(v: any) => setEnvType(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="prod">Production</SelectItem>
                      <SelectItem value="staging">Staging</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">VITE_SUPABASE_URL</Label>
                  <Input value={envUrl} onChange={e => setEnvUrl(e.target.value)} placeholder="http://IP_SERVEUR:8080 ou http://IP_SERVEUR:8000" className="font-mono text-xs" />
                </div>
                <div>
                  <Label className="text-xs">VITE_SUPABASE_PUBLISHABLE_KEY</Label>
                  <Input value={envKey} onChange={e => setEnvKey(e.target.value)} placeholder="eyJhbGc..." className="font-mono text-xs" />
                </div>
                <div>
                  <Label className="text-xs">VITE_SUPABASE_PROJECT_ID</Label>
                  <Input value={envProjectId} onChange={e => setEnvProjectId(e.target.value)} placeholder="abcdefgh..." className="font-mono text-xs" />
                </div>
                <div>
                  <Label className="text-xs">Port d'écoute Docker</Label>
                  <Input value={envPort} onChange={e => setEnvPort(e.target.value)} className="font-mono text-xs" />
                </div>
                <div>
                  <Label className="text-xs">VITE_PUBLIC_APP_URL</Label>
                  <Input value={envPublicAppUrl} onChange={e => setEnvPublicAppUrl(e.target.value)} placeholder={`http://IP_SERVEUR:${envPort}`} className="font-mono text-xs" />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Diagnostic</h3>
                <div className="border rounded-lg divide-y">
                  {envChecks.map(c => (
                    <div key={c.name} className="flex items-center justify-between p-2.5 text-sm">
                      <div className="flex items-center gap-2">
                        {c.valid ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
                        <code className="text-xs">{c.name}</code>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {c.valid ? "Valide" : c.value ? "Format invalide" : "Manquant"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {!allValid && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Corrigez les variables ci-dessus avant le déploiement.
                  </AlertDescription>
                </Alert>
              )}

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Rocket className="h-4 w-4" />Guide de déploiement {envType === "prod" ? "Production" : "Staging"}
                  </h3>
                </div>

                <div className="text-sm text-muted-foreground space-y-2 bg-muted/40 p-4 rounded-lg">
                  <p className="font-semibold text-foreground">Étapes recommandées :</p>
                  <ol className="list-decimal pl-5 space-y-1 text-xs">
                    <li>Téléchargez les fichiers Docker depuis l'onglet « Docker »</li>
                    <li>Placez-les à la racine de votre projet</li>
                    <li>Créez un fichier <code className="bg-background px-1 rounded">.env.{envType}</code> avec vos 3 variables</li>
                    {envType === "prod" && <li>Configurez un reverse-proxy (Nginx/Traefik) avec HTTPS (Let's Encrypt)</li>}
                    {envType === "prod" && <li>Activez les sauvegardes automatiques quotidiennes (cron + onglet « Sauvegarde »)</li>}
                    {envType === "staging" && <li>Restreignez l'accès via Basic Auth ou IP allowlist</li>}
                    <li>Lancez : <code className="bg-background px-1 rounded">docker compose up -d --build</code></li>
                    <li>Vérifiez : <code className="bg-background px-1 rounded">curl http://localhost:{envPort}</code></li>
                  </ol>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <code className="text-sm font-semibold">docker-compose.{envType}.yml</code>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => copyToClipboard(dockerCompose, "docker-compose")} className="gap-1.5 h-7" disabled={!allValid}>
                        <Copy className="h-3 w-3" />Copier
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => downloadText(`docker-compose.${envType}.yml`, dockerCompose, "text/yaml")} className="gap-1.5 h-7">
                        <Download className="h-3 w-3" />Télécharger
                      </Button>
                    </div>
                  </div>
                  <pre className="text-xs bg-muted/50 p-3 rounded-lg overflow-x-auto max-h-72 border">{dockerCompose}</pre>
                </div>

                <div className="space-y-2">
                  <code className="text-sm font-semibold">Commande prête à copier</code>
                  <div className="flex items-center gap-2 bg-muted/50 p-3 rounded-lg border">
                    <code className="flex-1 text-xs overflow-x-auto whitespace-nowrap">
                      docker compose -f docker-compose.{envType}.yml up -d --build
                    </code>
                    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(`docker compose -f docker-compose.${envType}.yml up -d --build`, "Commande")} className="gap-1.5 h-7">
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============ DOCKER TAB ============ */}
        <TabsContent value="docker" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ServerCog className="h-5 w-5" />Fichiers Docker</CardTitle>
              <CardDescription>Téléchargez les fichiers de configuration pour conteneuriser l'application.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={downloadDockerBundle} className="gap-2">
                <Download className="h-4 w-4" />Télécharger tout
              </Button>

              <Separator />

              {[
                { name: "Dockerfile", content: DOCKERFILE },
                { name: "nginx.conf", content: NGINX_CONF },
                { name: `docker-compose.${envType}.yml`, content: dockerCompose },
                { name: ".dockerignore", content: DOCKERIGNORE },
              ].map(f => (
                <div key={f.name} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <code className="text-sm font-semibold">{f.name}</code>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => copyToClipboard(f.content, f.name)} className="gap-1.5 h-7">
                        <Copy className="h-3 w-3" />Copier
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => downloadText(f.name, f.content)} className="gap-1.5 h-7">
                        <Download className="h-3 w-3" />Télécharger
                      </Button>
                    </div>
                  </div>
                  <pre className="text-xs bg-muted/50 p-3 rounded-lg overflow-x-auto max-h-60 border">{f.content}</pre>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============ NETWORK TAB ============ */}


        {/* ============ SSH DEPLOY TAB ============ */}
        <TabsContent value="ssh" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Rocket className="h-5 w-5" />Déployer sur un serveur Linux
              </CardTitle>
              <CardDescription>
                Connectez-vous en SSH avec IP/login/mot de passe — l'application est packagée puis lancée via Docker Compose sur votre serveur.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <Wifi className="h-4 w-4" />
                <AlertTitle>Pré-requis réseau</AlertTitle>
                <AlertDescription>
                  Le serveur doit être joignable depuis Internet (IP publique + port SSH ouvert) car la connexion part des serveurs Lovable Cloud.
                  Pour un serveur local (LAN/maison), utilisez plutôt l'onglet <strong>Docker</strong> et exécutez les commandes manuellement.
                </AlertDescription>
              </Alert>

              {isLocalHost(sshHost) && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>IP locale détectée</AlertTitle>
                  <AlertDescription>
                    L'adresse <code>{sshHost}</code> est privée et ne sera pas joignable depuis Internet.
                    Utilisez l'IP publique de votre serveur, un tunnel (ngrok, Tailscale, Cloudflare Tunnel),
                    ou téléchargez le bundle Docker pour le déployer manuellement.
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Server className="h-3.5 w-3.5" />Adresse IP / Hostname (publique)</Label>
                  <Input value={sshHost} onChange={e => setSshHost(e.target.value)} placeholder="123.45.67.89" disabled={sshDeploying} />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Server className="h-3.5 w-3.5" />Adresse IP locale du serveur</Label>
                  <Input value={sshLocalIp} onChange={e => setSshLocalIp(e.target.value)} placeholder="192.168.0.25 (vide = détection automatique)" disabled={sshDeploying} />
                  <p className="text-[11px] text-muted-foreground">Utilisée pour les vérifications internes et la connexion à la base de données depuis le serveur (par défaut <code>127.0.0.1</code>).</p>
                </div>
                <div className="space-y-2">
                  <Label>Port SSH</Label>
                  <Input value={sshPort} onChange={e => setSshPort(e.target.value)} placeholder="22" disabled={sshDeploying} />
                </div>
                <div className="space-y-2">
                  <Label>Utilisateur</Label>
                  <Input value={sshUser} onChange={e => setSshUser(e.target.value)} placeholder="root" disabled={sshDeploying} />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><KeyRound className="h-3.5 w-3.5" />Mot de passe</Label>
                  <Input type="password" value={sshPassword} onChange={e => setSshPassword(e.target.value)} placeholder="••••••••" disabled={sshDeploying} />
                </div>
                <div className="space-y-2">
                  <Label>Dossier distant</Label>
                  <Input value={sshRemoteDir} onChange={e => setSshRemoteDir(e.target.value)} placeholder="/opt/screenflow" disabled={sshDeploying} />
                </div>
                <div className="space-y-2">
                  <Label>Port d'exposition de l'app</Label>
                  <Input value={sshAppPort} onChange={e => setSshAppPort(e.target.value)} placeholder="8080" disabled={sshDeploying} />
                </div>
              </div>

              <Separator />
              <div>
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2"><FileCode className="h-4 w-4" />Source du code (Git)</h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Le serveur va cloner votre dépôt puis builder l'image Docker. Connectez votre projet à GitHub via Connectors si ce n'est pas déjà fait.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2 md:col-span-2">
                    <Label>URL du dépôt Git</Label>
                    <Input value={sshGitUrl} onChange={e => setSshGitUrl(e.target.value)} placeholder="https://github.com/user/repo.git" disabled={sshDeploying} />
                  </div>
                  <div className="space-y-2">
                    <Label>Branche</Label>
                    <Input value={sshGitBranch} onChange={e => setSshGitBranch(e.target.value)} placeholder="main" disabled={sshDeploying} />
                  </div>
                  <div className="space-y-2 md:col-span-3">
                    <Label className="flex items-center gap-2"><KeyRound className="h-3.5 w-3.5" />Token GitHub (optionnel, pour repo privé)</Label>
                    <Input type="password" value={sshGitToken} onChange={e => setSshGitToken(e.target.value)} placeholder="ghp_xxx…" disabled={sshDeploying} />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border">
                <Switch checked={sshAutoInstallDocker} onCheckedChange={setSshAutoInstallDocker} disabled={sshDeploying} />
                <div className="text-sm">
                  <p className="font-medium">Installer Docker automatiquement</p>
                  <p className="text-xs text-muted-foreground">
                    Si Docker / Docker Compose ne sont pas trouvés, le script lance <code>get.docker.com</code> via sudo.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
                <Switch checked={sshForceFreshInstall} onCheckedChange={setSshForceFreshInstall} disabled={sshDeploying} />
                <div className="text-sm">
                  <p className="font-medium flex items-center gap-1.5"><Trash2 className="h-3.5 w-3.5" />Réinstallation complète si un serveur existe</p>
                  <p className="text-xs text-muted-foreground">
                    Si activé : arrête et supprime l'app et Supabase local existants, puis libère automatiquement les ports demandés (arrêt des conteneurs Docker concurrents, désactivation de nginx/apache/httpd/lighttpd/caddy si vous utilisez 80/443, et <code>fuser -k</code> en dernier recours). Vous pouvez ainsi saisir directement <code>80</code> et <code>443</code> dans les ports application.
                  </p>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-muted/40 border space-y-3">
                <div className="flex items-center gap-2">
                  <Switch checked={sshEnableHttps} onCheckedChange={setSshEnableHttps} disabled={sshDeploying} />
                  <div className="text-sm">
                    <p className="font-medium flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />Activer HTTPS (certificat auto-signé)</p>
                    <p className="text-xs text-muted-foreground">
                      Génère un certificat SSL auto-signé via OpenSSL. Le navigateur affichera un avertissement (à accepter une fois).
                    </p>
                  </div>
                </div>
                {sshEnableHttps && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-12">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Port HTTPS</Label>
                      <Input value={sshHttpsPort} onChange={e => setSshHttpsPort(e.target.value)} placeholder="8443" disabled={sshDeploying} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Domaine / IP du certificat (CN)</Label>
                      <Input value={sshHttpsDomain} onChange={e => setSshHttpsDomain(e.target.value)} placeholder={sshHost || "exemple.local"} disabled={sshDeploying} />
                    </div>
                  </div>
                )}
              </div>

              <div className="p-3 rounded-lg bg-muted/40 border space-y-3">
                <div className="flex items-center gap-2">
                  <Switch checked={sshIsolateBackend} onCheckedChange={setSshIsolateBackend} disabled={sshDeploying} />
                  <div className="text-sm">
                    <p className="font-medium flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />Backend isolé (base de données séparée)</p>
                    <p className="text-xs text-muted-foreground">
                      Le serveur local utilisera sa <strong>propre instance Supabase</strong>. Sans isolation, il partagera la base du projet en ligne et toute modification sera répercutée.
                    </p>
                  </div>
                </div>
                {sshIsolateBackend ? (
                  <div className="space-y-3 pl-12">
                    <div className="flex items-center gap-2 p-2.5 rounded-md bg-primary/5 border border-primary/20">
                      <Switch checked={sshInstallSupabaseLocal} onCheckedChange={setSshInstallSupabaseLocal} disabled={sshDeploying} />
                      <div className="text-sm">
                        <p className="font-medium flex items-center gap-1.5"><Container className="h-3.5 w-3.5" />Installer Supabase self-hosted sur ce même serveur</p>
                        <p className="text-xs text-muted-foreground">
                          Déploie automatiquement une instance Supabase complète (Postgres, Auth, Storage, Studio) via Docker. L'app sera configurée pour l'utiliser. ~3-5 min.
                        </p>
                      </div>
                    </div>

                    {sshInstallSupabaseLocal ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-md border bg-background/50">
                          <div className="space-y-1.5">
                            <Label className="text-xs flex items-center gap-1.5"><Database className="h-3 w-3" />Type de stack base de données</Label>
                            <Select value={sshDbStack} onValueChange={(v) => setSshDbStack(v as "supabase_full" | "postgres_only")} disabled={sshDeploying}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="supabase_full">Supabase complet (recommandé) — Postgres + Auth + Storage + Realtime</SelectItem>
                                <SelectItem value="postgres_only">Postgres seul — utilitaires/scripts externes</SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">
                              {sshDbStack === "supabase_full"
                                ? "L'application sera 100% fonctionnelle (auth, médias, realtime, edge functions)."
                                : "⚠ L'app frontend NE FONCTIONNERA PAS sans Auth/Storage/Realtime."}
                            </p>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Image Postgres</Label>
                            <Select value={sshPostgresImage} onValueChange={setSshPostgresImage} disabled={sshDeploying || sshDbStack === "supabase_full"}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="postgres:15">postgres:15 (stable, défaut)</SelectItem>
                                <SelectItem value="postgres:15-alpine">postgres:15-alpine (léger)</SelectItem>
                                <SelectItem value="postgres:16">postgres:16</SelectItem>
                                <SelectItem value="postgres:16-alpine">postgres:16-alpine</SelectItem>
                                <SelectItem value="postgres:17">postgres:17</SelectItem>
                                <SelectItem value="postgres:17-alpine">postgres:17-alpine</SelectItem>
                                <SelectItem value="timescale/timescaledb:latest-pg15">TimescaleDB (PG15)</SelectItem>
                                <SelectItem value="timescale/timescaledb:latest-pg16">TimescaleDB (PG16)</SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">
                              {sshDbStack === "supabase_full"
                                ? "En mode Supabase complet, l'image Postgres officielle Supabase est utilisée (extensions requises)."
                                : "Image Docker du conteneur Postgres standalone."}
                            </p>
                          </div>
                        </div>

                        {sshDbStack === "postgres_only" && (
                          <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertTitle>Mode Postgres seul — application non fonctionnelle</AlertTitle>
                            <AlertDescription className="text-xs">
                              Ce mode déploie uniquement un conteneur Postgres. L'app ScreenFlow a besoin d'Auth, Storage, Realtime et Edge Functions — elle ne pourra pas fonctionner. Utilisez plutôt « Supabase complet ».
                            </AlertDescription>
                          </Alert>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Port API (Kong)</Label>
                          <Input value={sshSupaKongPort} onChange={e => setSshSupaKongPort(e.target.value)} placeholder="8000" disabled={sshDeploying} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Port Studio</Label>
                          <Input value={sshSupaStudioPort} onChange={e => setSshSupaStudioPort(e.target.value)} placeholder="3001" disabled={sshDeploying} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Port Postgres</Label>
                          <Input value={sshSupaDbPort} onChange={e => setSshSupaDbPort(e.target.value)} placeholder="5432" disabled={sshDeploying} />
                        </div>
                        <Alert className="md:col-span-3">
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription className="text-xs">
                            Avant l'installation, le déploiement vérifie automatiquement que les ports Application, API, Studio et Postgres sont valides, différents et libres sur le serveur.
                            Les identifiants de connexion (anon key, mot de passe Studio, mot de passe Postgres) seront affichés dans les logs après le déploiement. <strong>Sauvegardez-les</strong>.
                            La structure (tables, RLS, fonctions) doit ensuite être appliquée via l'onglet <strong>Sauvegarde / Restauration</strong>.
                          </AlertDescription>
                        </Alert>
                        {sshPortSuggestions.length > 0 && (
                          <Alert className="md:col-span-3 border-primary/30 bg-primary/5">
                            <Wifi className="h-4 w-4" />
                            <AlertTitle>Ports libres proposés</AlertTitle>
                            <AlertDescription className="space-y-2 text-xs">
                              <div className="flex flex-wrap gap-2">
                                {sshPortSuggestions.map((item) => (
                                  <Badge key={`${item.label}-${item.current}`} variant="outline">
                                    {item.label}: {item.current} → {item.suggested}
                                  </Badge>
                                ))}
                              </div>
                              <Button type="button" size="sm" variant="secondary" onClick={applySshPortSuggestions} disabled={sshDeploying} className="gap-2">
                                <CheckCircle2 className="h-3.5 w-3.5" />Appliquer tous les ports proposés
                              </Button>
                            </AlertDescription>
                          </Alert>
                        )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <Alert>
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Instance Supabase indépendante requise</AlertTitle>
                          <AlertDescription className="text-xs">
                            Renseignez ci-dessous les identifiants d'une instance Supabase existante (cloud ou self-hosted).
                          </AlertDescription>
                        </Alert>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1.5 md:col-span-2">
                            <Label className="text-xs">Supabase URL (serveur local)</Label>
                            <Input value={sshSupabaseUrl} onChange={e => setSshSupabaseUrl(e.target.value)} placeholder="https://xxxx.supabase.co" disabled={sshDeploying} />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Project ID</Label>
                            <Input value={sshSupabaseProjectId} onChange={e => setSshSupabaseProjectId(e.target.value)} placeholder="xxxx" disabled={sshDeploying} />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Anon / Publishable Key</Label>
                            <Input type="password" value={sshSupabaseKey} onChange={e => setSshSupabaseKey(e.target.value)} placeholder="eyJhbGciOi…" disabled={sshDeploying} />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <Alert variant="destructive" className="ml-12">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Backend partagé</AlertTitle>
                    <AlertDescription className="text-xs">
                      Le serveur local va utiliser la même base que le projet en ligne. Toute modification (écrans, médias, playlists, utilisateurs) sera <strong>partagée entre les deux environnements</strong>.
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              <Separator />

              <div className="flex flex-wrap gap-3 items-center">
                <Button
                  onClick={handleSshDeploy}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword || !sshGitUrl}
                  className="gap-2"
                >
                  {sshDeploying
                    ? <><Loader2 className="h-4 w-4 animate-spin" />Déploiement en cours…</>
                    : <><Rocket className="h-4 w-4" />Installer / mettre à jour automatiquement</>}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={() => { persistSshConfig(); toast.success("Configuration sauvegardée localement"); }}
                  disabled={sshDeploying}
                >
                  <Database className="h-4 w-4" />Sauvegarder la config
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="gap-2 text-muted-foreground"
                  onClick={clearSshConfig}
                  disabled={sshDeploying}
                >
                  Réinitialiser
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleResetAdminPassword}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Crée ou répare le premier compte admin screenflow@screenflow.local sur le serveur"
                >
                  <AlertCircle className="h-4 w-4" />Créer/réparer admin
                </Button>
                <Button
                  type="button"
                  variant="default"
                  className="gap-2"
                  onClick={handleRepairUploadsNow}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Répare les uploads bibliothèque et QR sans refaire un déploiement complet : buckets, permissions, restrictions MIME, Storage/Kong et proxy /storage/v1."
                >
                  <Upload className="h-4 w-4" />Corriger uploads sans redéploiement
                </Button>
                <Button
                  type="button"
                  variant="default"
                  className="gap-2"
                  onClick={handleRepairLanLogin}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Corrige le login impossible depuis l'IP LAN : les appels Auth/REST/Storage/Realtime restent sur l'origine du navigateur (proxy Nginx) au lieu de l'URL publique WAN, puis reconstruit le conteneur web."
                >
                  <Wifi className="h-4 w-4" />Corriger le login en LAN
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleRepairLocalWrites}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Corrige les permissions locales Storage/RLS sans réinstaller le serveur"
                >
                  <ShieldCheck className="h-4 w-4" />Réparer upload/écrans
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleRepairApiUrl}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Corrige SUPABASE_PUBLIC_URL / API_EXTERNAL_URL et le proxy Nginx"
                >
                  <Wifi className="h-4 w-4" />Corriger l'URL API
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleRepairBuckets}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Recrée les buckets Storage 'uploads' et 'media' et leurs policies"
                >
                  <HardDrive className="h-4 w-4" />Réparer buckets Storage
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleRepairRealtime}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Réajoute les tables à la publication supabase_realtime et redémarre le service"
                >
                  <Radio className="h-4 w-4" />Réparer Realtime
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleRestartStack}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Redémarre tous les conteneurs Docker (web + Supabase local)"
                >
                  <RefreshCw className="h-4 w-4" />Redémarrer la stack
                </Button>
                <Button
                  type="button"
                  className="gap-2 bg-primary"
                  onClick={handleQuickUpdate}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Tire les derniers commits, applique les migrations manquantes, synchronise les fonctions backend et reconstruit uniquement le conteneur web — sans toucher à Supabase ni reinstaller la stack."
                >
                  <Rocket className="h-4 w-4" />Mise à jour rapide
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={handleBuildStatus}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Le build Docker continue sur le serveur même après la fin de la session : ce bouton suit sa progression et finalise la vérification."
                >
                  <RefreshCw className="h-4 w-4" />Vérifier le build
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={handleRepairWebContainer}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Diagnostique pourquoi le conteneur web est arrêté, le reconstruit, puis vérifie le proxy /storage/v1 utilisé pour les uploads."
                >
                  <RefreshCw className="h-4 w-4" />Réparer le conteneur web
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="gap-2"
                  onClick={handleApplyMigrations}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Applique automatiquement toutes les migrations SQL manquantes sur le serveur local"
                >
                  <GitBranch className="h-4 w-4" />Appliquer les migrations
                </Button>
                <Button
                  type="button"
                  className="gap-2"
                  onClick={handleDiagnoseServer}
                  disabled={sshDeploying || !sshHost || !sshUser || !sshPassword}
                  title="Vérifie l'état complet du serveur et propose des correctifs"
                >
                  <Stethoscope className="h-4 w-4" />Diagnostiquer le serveur
                </Button>
                {sshDeployedUrl && (
                  <a href={sshDeployedUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" className="gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />Ouvrir {sshDeployedUrl}
                    </Button>
                  </a>
                )}
              </div>
              <p className="text-xs text-muted-foreground -mt-1">
                💾 La configuration (hôte, ports, instance Supabase locale) est mémorisée automatiquement après chaque déploiement réussi. Le mot de passe SSH n'est jamais stocké.
              </p>

              {sshLocalSupabaseInfo && (
                <Alert className="border-primary/40 bg-primary/5">
                  <Database className="h-4 w-4" />
                  <AlertTitle>Supabase local installé 🎉</AlertTitle>
                  <AlertDescription className="space-y-1 text-xs mt-2">
                    <div><strong>API URL :</strong> <code>{sshLocalSupabaseInfo.url}</code></div>
                    <div><strong>Studio :</strong> <a href={sshLocalSupabaseInfo.studio_url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{sshLocalSupabaseInfo.studio_url}</a></div>
                    <div className="break-all"><strong>Anon Key :</strong> <code className="text-[10px]">{sshLocalSupabaseInfo.anon_key}</code></div>
                    <p className="mt-2 text-muted-foreground">⚠ Le mot de passe Studio et le mot de passe Postgres sont dans le journal ci-dessous — sauvegardez-les.</p>
                  </AlertDescription>
                </Alert>
              )}

              {serverDiag && (
                <div className="space-y-3 rounded-xl border bg-card/50 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Stethoscope className="h-4 w-4" />Diagnostic serveur
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {serverDiag.checks.filter(c => c.ok).length}/{serverDiag.checks.length} vérifications OK
                    </span>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {serverDiag.checks.map((c) => (
                      <div key={c.key} className="flex items-start gap-2 text-xs p-2 rounded-lg bg-background border">
                        {c.ok
                          ? <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                          : <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{c.label}</div>
                          {c.detail && <div className="text-muted-foreground truncate">{c.detail}</div>}
                          {!c.ok && c.suggested_action && fixActionMap[c.suggested_action] && (
                            <Button size="sm" variant="outline" className="h-6 mt-1 text-[11px]" onClick={fixActionMap[c.suggested_action].run} disabled={sshDeploying}>
                              {fixActionMap[c.suggested_action].label}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {serverDiag.suggestions.length > 0 && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>Correctifs proposés</AlertTitle>
                      <AlertDescription>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {serverDiag.suggestions.filter(s => fixActionMap[s]).map((s) => (
                            <Button key={s} size="sm" variant="secondary" onClick={fixActionMap[s].run} disabled={sshDeploying}>
                              {fixActionMap[s].label}
                            </Button>
                          ))}
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}

              {uploadRepairResult && (
                <div className="space-y-3 rounded-xl border bg-card/50 p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Upload className="h-4 w-4" />Résumé réparation uploads
                    </h3>
                    <Badge variant={uploadRepairResult.ok ? "secondary" : "destructive"}>
                      {uploadRepairResult.ok ? "OK" : "À vérifier"}
                    </Badge>
                  </div>
                  <div className="grid sm:grid-cols-3 gap-2 text-xs">
                    {(uploadRepairResult.storage_tests || []).map((test) => (
                      <div key={`${test.label}-${test.bucket}`} className="p-2 rounded-lg bg-background border">
                        <div className="font-medium flex items-center gap-1">
                          {test.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                          {test.label} / {test.bucket}
                        </div>
                        <div className="text-muted-foreground mt-1 truncate">
                          HTTP {test.status || "n/a"}{test.detail ? ` · ${test.detail}` : ""}
                        </div>
                      </div>
                    ))}
                    {uploadRepairResult.proxy && (
                      <div className="p-2 rounded-lg bg-background border">
                        <div className="font-medium flex items-center gap-1">
                          {uploadRepairResult.proxy.ok || uploadRepairResult.proxy.skipped
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                            : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                          Proxy web /storage/v1
                        </div>
                        <div className="text-muted-foreground mt-1 truncate">
                          {uploadRepairResult.proxy.skipped ? "Conteneur web non détecté" : `HTTP ${uploadRepairResult.proxy.http_status || "n/a"}`} {uploadRepairResult.proxy.detail || ""}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {quickUpdateResult && (
                <div className="space-y-2 rounded-xl border bg-card/50 p-4">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Rocket className="h-4 w-4" />Résumé de la mise à jour rapide
                  </h3>
                  <div className="grid sm:grid-cols-3 gap-2 text-xs">
                    <div className="p-2 rounded-lg bg-background border">
                      <div className="font-medium flex items-center gap-1">
                        {quickUpdateResult.git?.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                        Code (git pull)
                      </div>
                      <div className="text-muted-foreground mt-1">
                        {quickUpdateResult.git?.message || "—"}
                        {quickUpdateResult.git?.commit && <> · <code>{quickUpdateResult.git.commit}</code></>}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-background border">
                      <div className="font-medium flex items-center gap-1">
                        {quickUpdateResult.functions?.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
                        Fonctions backend
                      </div>
                      <div className="text-muted-foreground mt-1">
                        {quickUpdateResult.functions?.ok ? "Synchronisées" : "Non synchronisées"}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-background border">
                      <div className="font-medium flex items-center gap-1">
                        {quickUpdateResult.web_rebuild?.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                        Conteneur web
                      </div>
                      <div className="text-muted-foreground mt-1">
                        {quickUpdateResult.web_rebuild?.ok ? "Reconstruit & redémarré" : "Non reconstruit"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {migrationResult && (
                <div className="space-y-3 rounded-xl border bg-card/50 p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <GitBranch className="h-4 w-4" />Résultat des migrations
                    </h3>
                    <div className="flex gap-2 text-xs flex-wrap">
                      <Badge variant="secondary">Total : {migrationResult.total}</Badge>
                      <Badge className="bg-primary/15 text-primary hover:bg-primary/20">Appliquées : {migrationResult.applied}</Badge>
                      <Badge variant="outline">Déjà à jour : {migrationResult.skipped}</Badge>
                      {migrationResult.errors > 0 && (
                        <Badge variant="destructive">Erreurs : {migrationResult.errors}</Badge>
                      )}
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {migrationResult.items.map((m) => (
                      <div key={m.name} className="flex items-start gap-2 text-xs p-2 rounded-lg bg-background border">
                        {m.status === "applied" && <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />}
                        {m.status === "skipped" && <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />}
                        {m.status === "error" && <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />}
                        <div className="flex-1 min-w-0">
                          <div className="font-mono truncate">{m.name}</div>
                          <div className="text-muted-foreground">
                            {m.status === "applied" && "Appliquée avec succès"}
                            {m.status === "skipped" && "Déjà appliquée"}
                            {m.status === "error" && (m.error?.slice(0, 240) || "Erreur inconnue")}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {migrationResult.errors === 0 ? (
                    <Alert className="border-primary/40 bg-primary/5">
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        Le serveur local est synchronisé avec les migrations du dépôt.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        Certaines migrations ont échoué — consultez les détails ci-dessus puis le journal pour le contexte SQL.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}

              {sshLogs.length > 0 && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2"><Terminal className="h-3.5 w-3.5" />Journal de déploiement</Label>
                  <pre className="text-xs bg-muted/50 p-3 rounded-lg overflow-x-auto max-h-96 border whitespace-pre-wrap">
                    {sshLogs.join("\n")}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
