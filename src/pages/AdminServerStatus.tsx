import { useCallback, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Activity, Cpu, MemoryStick, HardDrive, Server, Container, Database, RefreshCw, Loader2, Network, Wifi, Gauge, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

interface ServerData {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  load: string[];
  cpu: { model: string; cores: number; usage_pct: number };
  memory: { total: number; used: number; free: number; available: number };
  swap: { total: number; used: number };
  disk: { total: number; used: number; free: number; pct: string };
  disks: { device: string; size: number; used: number; avail: number; pct: string; mount: string }[];
  network: string[];
  docker: { version: string; containers: { name: string; image: string; status: string; ports: string }[] };
  top_processes: { pid: string; cpu: string; mem: string; cmd: string }[];
}

interface DbData {
  tables: Record<string, number>;
  recent_screens: { id: string; name: string; status: string; player_heartbeat_at: string | null }[];
  local?: {
    container: string;
    size_bytes: number;
    saturation_pct: number;
    disk_total_bytes: number;
    databases: { name: string; size: number }[];
  };
}

export default function AdminServerStatus() {
  const [loading, setLoading] = useState(false);
  const [server, setServer] = useState<ServerData | null>(null);
  const [database, setDatabase] = useState<DbData | null>(null);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [host, setHost] = useState("192.168.0.100");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");

  const fetchStats = useCallback(async (silent = false) => {
    const sshPort = Number(port);
    if (!host.trim() || !username.trim() || !password || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      toast.error("Renseignez une adresse IP locale, un port SSH valide et les identifiants du serveur.");
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("server-stats", {
        body: {
          mode: "ssh",
          host: host.trim(),
          port: sshPort,
          username: username.trim(),
          password,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Erreur inconnue");
      setServer(data.server);
      setDatabase(data.database);
      setLastFetch(new Date().toLocaleTimeString());
      if (!silent) toast.success("État du serveur actualisé");
    } catch (e: any) {
      toast.error("Erreur: " + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  }, [host, password, port, username]);

  // Compute alerts from results
  const alerts: { level: "warning" | "critical"; title: string; message: string }[] = [];
  if (server) {
    if (server.cpu.usage_pct >= 90) alerts.push({ level: "critical", title: "CPU saturé", message: `Utilisation CPU à ${server.cpu.usage_pct.toFixed(1)}%` });
    else if (server.cpu.usage_pct >= 75) alerts.push({ level: "warning", title: "CPU élevé", message: `Utilisation CPU à ${server.cpu.usage_pct.toFixed(1)}%` });

    const _memPct = (server.memory.used / server.memory.total) * 100;
    if (_memPct >= 90) alerts.push({ level: "critical", title: "Mémoire saturée", message: `RAM utilisée à ${_memPct.toFixed(0)}%` });
    else if (_memPct >= 80) alerts.push({ level: "warning", title: "Mémoire élevée", message: `RAM utilisée à ${_memPct.toFixed(0)}%` });

    const _diskPct = (server.disk.used / server.disk.total) * 100;
    if (_diskPct >= 90) alerts.push({ level: "critical", title: "Disque presque plein", message: `Partition / utilisée à ${_diskPct.toFixed(0)}%` });
    else if (_diskPct >= 80) alerts.push({ level: "warning", title: "Disque chargé", message: `Partition / utilisée à ${_diskPct.toFixed(0)}%` });

    if (server.swap.total > 0) {
      const _swapPct = (server.swap.used / server.swap.total) * 100;
      if (_swapPct >= 50) alerts.push({ level: "warning", title: "Swap actif", message: `Swap utilisé à ${_swapPct.toFixed(0)}% — la RAM est probablement insuffisante` });
    }

    server.disks?.forEach((d) => {
      const v = parseFloat(d.pct);
      if (v >= 90) alerts.push({ level: "critical", title: `Disque ${d.mount} presque plein`, message: `${d.pct} utilisés sur ${d.device}` });
      else if (v >= 80) alerts.push({ level: "warning", title: `Disque ${d.mount} chargé`, message: `${d.pct} utilisés sur ${d.device}` });
    });

    const stoppedDocker = server.docker?.containers?.filter((c) => !c.status.includes("Up")) || [];
    stoppedDocker.forEach((c) => alerts.push({ level: "critical", title: `Conteneur arrêté: ${c.name}`, message: c.status }));
  }
  if (database?.local) {
    if (database.local.saturation_pct >= 70) alerts.push({ level: "critical", title: "DB locale critique", message: `Saturation à ${database.local.saturation_pct.toFixed(1)}% du disque` });
    else if (database.local.saturation_pct >= 40) alerts.push({ level: "warning", title: "DB locale volumineuse", message: `Saturation à ${database.local.saturation_pct.toFixed(1)}% du disque` });
  }

  const memPct = server ? (server.memory.used / server.memory.total) * 100 : 0;
  const diskPct = server ? (server.disk.used / server.disk.total) * 100 : 0;
  const swapPct = server && server.swap.total ? (server.swap.used / server.swap.total) * 100 : 0;

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="h-8 w-8 text-primary" />État du Serveur Local
        </h1>
        <p className="text-muted-foreground mt-1">
          Monitoring temps réel du serveur Linux et de la base de données.
        </p>
      </div>

      {/* Manual SSH monitoring */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2"><Server className="h-5 w-5" />Connexion au serveur local</CardTitle>
          <CardDescription>Utilisez l'adresse IP LAN et les identifiants SSH du serveur où ScreenFlow est installé.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
            <div className="space-y-2 md:col-span-5">
              <Label htmlFor="server-host">Adresse IP locale</Label>
              <Input
                id="server-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="ex: 192.168.0.x"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="server-port">Port SSH</Label>
              <Input
                id="server-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="22"
              />
            </div>
            <div className="space-y-2 md:col-span-5">
              <Label htmlFor="server-username">Identifiant SSH</Label>
              <Input
                id="server-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="root"
                autoComplete="username"
              />
            </div>
            <div className="space-y-2 md:col-span-12">
              <Label htmlFor="server-password">Mot de passe SSH</Label>
              <Input
                id="server-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mot de passe du serveur"
                autoComplete="current-password"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => void fetchStats(false)} disabled={loading} className="gap-2">
              {loading ? <><Loader2 className="h-4 w-4 animate-spin" />Connexion…</> : <><RefreshCw className="h-4 w-4" />Tester et actualiser</>}
            </Button>
            {lastFetch && <span className="text-xs text-muted-foreground">Dernière mise à jour: {lastFetch}</span>}
          </div>
        </CardContent>
      </Card>

      {/* Alerts */}
      {(server || database) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className={`h-5 w-5 ${alerts.length ? "text-destructive" : "text-muted-foreground"}`} />
              Alertes
              {alerts.length > 0 && <Badge variant="destructive">{alerts.length}</Badge>}
            </CardTitle>
            <CardDescription>
              {alerts.length === 0 ? "Aucune alerte — tout fonctionne normalement." : "Anomalies détectées sur le serveur ou la base."}
            </CardDescription>
          </CardHeader>
          {alerts.length > 0 && (
            <CardContent className="space-y-2">
              {alerts.map((a, i) => (
                <Alert key={i} variant={a.level === "critical" ? "destructive" : "default"}>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{a.title}</AlertTitle>
                  <AlertDescription>{a.message}</AlertDescription>
                </Alert>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {server && (
        <>
          {/* System overview */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" />CPU</CardDescription>
                <CardTitle className="text-3xl">{server.cpu.usage_pct.toFixed(1)}%</CardTitle>
              </CardHeader>
              <CardContent>
                <Progress value={server.cpu.usage_pct} />
                <p className="text-xs text-muted-foreground mt-2">{server.cpu.cores} cœurs · Load {server.load.join(" ")}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5" />Mémoire</CardDescription>
                <CardTitle className="text-3xl">{memPct.toFixed(0)}%</CardTitle>
              </CardHeader>
              <CardContent>
                <Progress value={memPct} />
                <p className="text-xs text-muted-foreground mt-2">{formatBytes(server.memory.used)} / {formatBytes(server.memory.total)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" />Disque /</CardDescription>
                <CardTitle className="text-3xl">{server.disk.pct}</CardTitle>
              </CardHeader>
              <CardContent>
                <Progress value={diskPct} />
                <p className="text-xs text-muted-foreground mt-2">{formatBytes(server.disk.used)} / {formatBytes(server.disk.total)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" />Swap</CardDescription>
                <CardTitle className="text-3xl">{swapPct.toFixed(0)}%</CardTitle>
              </CardHeader>
              <CardContent>
                <Progress value={swapPct} />
                <p className="text-xs text-muted-foreground mt-2">{formatBytes(server.swap.used)} / {formatBytes(server.swap.total)}</p>
              </CardContent>
            </Card>
          </div>

          {/* System info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2"><Server className="h-5 w-5" />Informations système</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">Hostname</span><span className="font-medium">{server.hostname}</span></div>
              <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">OS</span><span className="font-medium">{server.os || "—"}</span></div>
              <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">Kernel</span><span className="font-medium">{server.kernel}</span></div>
              <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">Uptime</span><span className="font-medium">{server.uptime}</span></div>
              <div className="flex justify-between border-b pb-1 md:col-span-2"><span className="text-muted-foreground">CPU</span><span className="font-medium">{server.cpu.model}</span></div>
              <div className="flex justify-between border-b pb-1 md:col-span-2"><span className="text-muted-foreground flex items-center gap-1.5"><Network className="h-3.5 w-3.5" />Réseau</span><span className="font-medium">{server.network.join(", ") || "—"}</span></div>
            </CardContent>
          </Card>

          {/* Disks */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2"><HardDrive className="h-5 w-5" />Stockage</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {server.disks.map((d) => (
                <div key={d.device + d.mount} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-mono">{d.mount} <span className="text-muted-foreground">({d.device})</span></span>
                    <span className="text-muted-foreground">{formatBytes(d.used)} / {formatBytes(d.size)} · {d.pct}</span>
                  </div>
                  <Progress value={parseFloat(d.pct)} />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Docker */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2"><Container className="h-5 w-5" />Docker</CardTitle>
              <CardDescription>{server.docker.version || "Docker non installé"}</CardDescription>
            </CardHeader>
            <CardContent>
              {server.docker.containers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun conteneur en cours d'exécution.</p>
              ) : (
                <div className="space-y-2">
                  {server.docker.containers.map((c) => (
                    <div key={c.name} className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{c.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{c.image}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant={c.status.includes("Up") ? "default" : "destructive"}>{c.status}</Badge>
                        {c.ports && <span className="text-xs text-muted-foreground hidden md:inline">{c.ports}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top processes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2"><Activity className="h-5 w-5" />Top processus (CPU)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground border-b pb-2 mb-2">
                <div className="col-span-2">PID</div><div className="col-span-2">CPU%</div><div className="col-span-2">MEM%</div><div className="col-span-6">Commande</div>
              </div>
              {server.top_processes.map((p) => (
                <div key={p.pid} className="grid grid-cols-12 gap-2 text-sm py-1 border-b last:border-0">
                  <div className="col-span-2 font-mono">{p.pid}</div>
                  <div className="col-span-2">{p.cpu}</div>
                  <div className="col-span-2">{p.mem}</div>
                  <div className="col-span-6 font-mono truncate">{p.cmd}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      {database && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><Database className="h-5 w-5" />Base de données</CardTitle>
            <CardDescription>Nombre d'enregistrements par table</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {database.local && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="p-4 rounded-lg border bg-muted/30">
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />Taille DB locale</p>
                    <p className="text-2xl font-bold">{formatBytes(database.local.size_bytes)}</p>
                    {database.local.container && <p className="text-xs text-muted-foreground mt-1 font-mono truncate">{database.local.container}</p>}
                  </div>
                  <div className="p-4 rounded-lg border bg-muted/30">
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" />Taux de saturation</p>
                    <p className="text-2xl font-bold">{database.local.saturation_pct.toFixed(2)}%</p>
                    <Progress value={Math.min(100, database.local.saturation_pct)} className="mt-2" />
                  </div>
                  <div className="p-4 rounded-lg border bg-muted/30">
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" />Disque total</p>
                    <p className="text-2xl font-bold">{formatBytes(database.local.disk_total_bytes)}</p>
                    <p className="text-xs text-muted-foreground mt-1">DB / Disque /</p>
                  </div>
                </div>
                {database.local.databases.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Bases détectées</p>
                    {database.local.databases.map((d) => (
                      <div key={d.name} className="flex items-center justify-between text-sm p-2 rounded border bg-card">
                        <span className="font-mono">{d.name}</span>
                        <span className="text-muted-foreground">{formatBytes(d.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {!database.local.container && database.local.size_bytes === 0 && (
                  <p className="text-xs text-muted-foreground italic">Aucun PostgreSQL local détecté (Docker ou natif).</p>
                )}
                <Separator />
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {Object.entries(database.tables).map(([name, count]) => (
                <div key={name} className="p-3 rounded-lg border bg-muted/30">
                  <p className="text-xs text-muted-foreground capitalize">{name.replace(/_/g, " ")}</p>
                  <p className="text-2xl font-bold">{count.toLocaleString()}</p>
                </div>
              ))}
            </div>

            {database.recent_screens.length > 0 && (
              <>
                <Separator className="my-6" />
                <h3 className="font-medium mb-3 flex items-center gap-2"><Wifi className="h-4 w-4" />Écrans récents</h3>
                <div className="space-y-2">
                  {database.recent_screens.map((s) => {
                    const online = s.player_heartbeat_at && (Date.now() - new Date(s.player_heartbeat_at).getTime()) < 60000;
                    return (
                      <div key={s.id} className="flex items-center justify-between p-2 rounded border bg-card text-sm">
                        <span className="font-medium">{s.name}</span>
                        <Badge variant={online ? "default" : "secondary"}>{online ? "En ligne" : "Hors ligne"}</Badge>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
