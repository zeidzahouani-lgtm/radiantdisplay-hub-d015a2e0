// Collect Linux server stats via SSH + Supabase DB stats
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
const ssh2Mod: any = await import("npm:ssh2@1.15.0");
const Client: any = ssh2Mod.Client ?? ssh2Mod.default?.Client;
type Client = any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface StatsBody {
  mode?: "local" | "ssh";
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

function ssh(opts: { host: string; port: number; username: string; password?: string; privateKey?: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => resolve(conn))
      .on("keyboard-interactive", (_n: any, _i: any, _l: any, prompts: any, finish: any) => finish(prompts.map(() => opts.password || "")))
      .on("error", reject)
      .connect({ ...opts, readyTimeout: 15000, tryKeyboard: true });
  });
}

function exec(conn: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err: any, stream: any) => {
      if (err) return reject(err);
      let out = "";
      stream
        .on("close", () => resolve(out))
        .on("data", (d: Uint8Array) => (out += new TextDecoder().decode(d)))
        .stderr.on("data", (d: Uint8Array) => (out += new TextDecoder().decode(d)));
    });
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: userData.user.id, _role: "admin" });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden — admin only" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = (await req.json().catch(() => ({}))) as StatsBody;
    const localMode = body.mode === "local";
    let bundledLocalHost = "";
    if (localMode) {
      try { bundledLocalHost = (await Deno.readTextFile(new URL("./.local_host", import.meta.url))).trim(); } catch { /* optional */ }
    }
    const serverHost = (body.host && body.host.trim()) || Deno.env.get("SERVER_STATS_HOST") || bundledLocalHost || (localMode ? "host.docker.internal" : "");
    const username = (body.username && body.username.trim()) || Deno.env.get("SERVER_STATS_USERNAME") || (localMode ? "root" : "");
    const password = body.password || Deno.env.get("SERVER_STATS_PASSWORD") || "";
    let privateKey = Deno.env.get("SERVER_STATS_PRIVATE_KEY") || "";
    if (localMode && !privateKey) {
      try {
        privateKey = await Deno.readTextFile(new URL("./.local_id_ed25519", import.meta.url));
      } catch { /* local key is provisioned by the deployment repair */ }
    }
    if (!serverHost) {
      return new Response(JSON.stringify({ error: "Hôte serveur manquant (renseignez l'adresse de l'hôte)" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!username || (!password && !privateKey)) {
      return new Response(JSON.stringify({ error: localMode ? "Diagnostic local non initialisé. Lancez une mise à jour rapide depuis Backup pour installer l'accès automatique." : "Identifiants SSH manquants" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== Server stats via SSH =====
    const conn = await ssh({ host: serverHost, port: body.port ?? 22, username, password: password || undefined, privateKey: privateKey || undefined });

    const script = `
echo "===HOSTNAME===" && hostname
echo "===OS===" && (cat /etc/os-release 2>/dev/null | grep -E 'PRETTY_NAME|VERSION' | head -2)
echo "===KERNEL===" && uname -r
echo "===UPTIME===" && uptime -p
echo "===LOAD===" && cat /proc/loadavg
echo "===CPU_INFO===" && (grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs; nproc)
echo "===CPU_USAGE===" && top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | head -1
echo "===MEMORY===" && free -b | grep Mem | awk '{print $2,$3,$4,$7}'
echo "===SWAP===" && free -b | grep Swap | awk '{print $2,$3}'
echo "===DISK===" && df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'
echo "===DISK_ALL===" && df -B1 -x tmpfs -x devtmpfs -x squashfs --output=source,size,used,avail,pcent,target | tail -n +2
echo "===NET===" && (ip -4 addr show | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | grep -v '127.0.0.1' | head -3)
echo "===DOCKER===" && (docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null || echo "NONE")
echo "===DOCKER_VERSION===" && (docker --version 2>/dev/null || echo "NONE")
echo "===PG_CONTAINER===" && (docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'postgres|supabase.*db|supabase-db' | head -1)
echo "===PG_SIZE===" && (
  C=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'postgres|supabase.*db|supabase-db' | head -1);
  if [ -n "$C" ]; then
    docker exec $C psql -U postgres -tAc "SELECT COALESCE(SUM(pg_database_size(datname)),0) FROM pg_database WHERE datistemplate=false" 2>/dev/null;
  elif command -v psql >/dev/null 2>&1; then
    sudo -u postgres psql -tAc "SELECT COALESCE(SUM(pg_database_size(datname)),0) FROM pg_database WHERE datistemplate=false" 2>/dev/null;
  else
    du -sb /var/lib/postgresql 2>/dev/null | awk '{print $1}';
  fi
)
echo "===PG_DBS===" && (
  C=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'postgres|supabase.*db|supabase-db' | head -1);
  if [ -n "$C" ]; then
    docker exec $C psql -U postgres -tAF'|' -c "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate=false ORDER BY pg_database_size(datname) DESC" 2>/dev/null;
  elif command -v psql >/dev/null 2>&1; then
    sudo -u postgres psql -tAF'|' -c "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate=false ORDER BY pg_database_size(datname) DESC" 2>/dev/null;
  fi
)
echo "===PROCESSES===" && ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -6
`;
    const raw = await exec(conn, script);
    conn.end();

    // Parse sections
    const sections: Record<string, string> = {};
    let current = "";
    for (const line of raw.split("\n")) {
      const m = line.match(/^===(.+)===$/);
      if (m) { current = m[1]; sections[current] = ""; }
      else if (current) sections[current] += line + "\n";
    }
    const get = (k: string) => (sections[k] || "").trim();

    const memParts = get("MEMORY").split(/\s+/).map(Number);
    const swapParts = get("SWAP").split(/\s+/).map(Number);
    const diskParts = get("DISK").split(/\s+/);
    const cpuLines = get("CPU_INFO").split("\n");
    const cpuIdle = parseFloat(get("CPU_USAGE")) || 0;

    const server = {
      hostname: get("HOSTNAME"),
      os: get("OS").split("\n")[0]?.replace(/PRETTY_NAME=|"/g, "") || "",
      kernel: get("KERNEL"),
      uptime: get("UPTIME"),
      load: get("LOAD").split(" ").slice(0, 3),
      cpu: { model: cpuLines[0] || "", cores: parseInt(cpuLines[1] || "0"), usage_pct: Math.max(0, 100 - cpuIdle) },
      memory: { total: memParts[0] || 0, used: memParts[1] || 0, free: memParts[2] || 0, available: memParts[3] || 0 },
      swap: { total: swapParts[0] || 0, used: swapParts[1] || 0 },
      disk: { total: parseInt(diskParts[0] || "0"), used: parseInt(diskParts[1] || "0"), free: parseInt(diskParts[2] || "0"), pct: diskParts[3] || "0%" },
      disks: get("DISK_ALL").split("\n").filter(Boolean).map((l) => {
        const p = l.trim().split(/\s+/);
        return { device: p[0], size: parseInt(p[1] || "0"), used: parseInt(p[2] || "0"), avail: parseInt(p[3] || "0"), pct: p[4], mount: p[5] };
      }),
      network: get("NET").split("\n").filter(Boolean),
      docker: {
        version: get("DOCKER_VERSION"),
        containers: get("DOCKER") === "NONE" ? [] : get("DOCKER").split("\n").filter(Boolean).map((l) => {
          const [name, image, status, ports] = l.split("|");
          return { name, image, status, ports };
        }),
      },
      top_processes: get("PROCESSES").split("\n").slice(1).filter(Boolean).map((l) => {
        const p = l.trim().split(/\s+/);
        return { pid: p[0], cpu: p[1], mem: p[2], cmd: p.slice(3).join(" ") };
      }),
    };

    // ===== DB stats =====
    const tables = ["profiles", "establishments", "screens", "media", "playlists", "contents", "licenses", "schedules", "layouts", "video_walls", "user_roles", "notifications"];
    const counts: Record<string, number> = {};
    await Promise.all(tables.map(async (t) => {
      const { count } = await (supabase as any).from(t).select("*", { count: "exact", head: true });
      counts[t] = count || 0;
    }));

    // Storage size estimate (sum of media rows is not size; we just count)
    const { data: recentScreens } = await (supabase as any).from("screens").select("id,name,status,player_heartbeat_at").limit(20).order("updated_at", { ascending: false });

    // Local Postgres size from SSH
    const localPgSize = parseInt(get("PG_SIZE").trim()) || 0;
    const pgContainer = get("PG_CONTAINER");
    const pgDatabases = get("PG_DBS").split("\n").filter(Boolean).map((l) => {
      const [name, size] = l.split("|");
      return { name: name?.trim() || "", size: parseInt(size?.trim() || "0") };
    });
    const diskTotal = parseInt(diskParts[0] || "0");
    const dbSaturationPct = diskTotal > 0 ? (localPgSize / diskTotal) * 100 : 0;

    const database = {
      tables: counts,
      recent_screens: recentScreens || [],
      local: {
        container: pgContainer,
        size_bytes: localPgSize,
        saturation_pct: dbSaturationPct,
        disk_total_bytes: diskTotal,
        databases: pgDatabases,
      },
    };

    return new Response(JSON.stringify({ success: true, server, database, timestamp: new Date().toISOString() }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
