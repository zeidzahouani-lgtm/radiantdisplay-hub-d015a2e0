import { useState, useMemo } from "react";
import ScreenDetailDialog from "@/components/dashboard/ScreenDetailDialog";
import { QuickPlaylistDialog } from "@/components/dashboard/QuickPlaylistDialog";
import { VideoWallDialog } from "@/components/dashboard/VideoWallDialog";
import { WallConfigDialog } from "@/components/dashboard/WallConfigDialog";
import { Monitor, Plus, Trash2, RotateCcw, Wifi, WifiOff, ExternalLink, LayoutGrid, ListMusic, Image, Smartphone, Laptop, Tablet, CalendarClock, RefreshCw, Tv, Power, Eye, ShieldAlert, ShieldOff, Bug, AlertTriangle, Sparkles, Grid3x3, Settings } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useScreens } from "@/hooks/useScreens";
import { useMedia } from "@/hooks/useMedia";
import { useLayouts } from "@/hooks/useLayouts";
import { usePlaylists } from "@/hooks/usePlaylists";
import { usePrograms } from "@/hooks/usePrograms";
import { useVideoWalls } from "@/hooks/useVideoWalls";
import { useEstablishmentContext } from "@/contexts/EstablishmentContext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { explainSupabaseError } from "@/lib/env";
import { toast } from "sonner";
import { useScreenLicenses } from "@/hooks/useScreenLicenses";

type OrientationPreview = {
  label: string;
  rotationClass: string;
};

const ORIENTATION_PREVIEWS: Record<string, OrientationPreview> = {
  landscape: { label: "0°", rotationClass: "rotate-0" },
  portrait: { label: "90°", rotationClass: "rotate-90" },
  "landscape-flipped": { label: "180°", rotationClass: "rotate-180" },
  "portrait-flipped": { label: "270°", rotationClass: "-rotate-90" },
};

const getOrientationPreview = (orientation: string): OrientationPreview =>
  ORIENTATION_PREVIEWS[orientation] ?? ORIENTATION_PREVIEWS.landscape;

import { isScreenReallyOnline } from "@/lib/screen-utils";

function parseUserAgent(ua: string | null): { device: string; icon: React.ReactNode } {
  if (!ua) return { device: "Inconnu", icon: <Monitor className="h-3 w-3" /> };
  const lower = ua.toLowerCase();
  // Smart TVs
  if (lower.includes("webos") || lower.includes("lgwebos") || lower.includes("lg netcast") || lower.includes("netcast") || lower.includes("smarttv"))
    return { device: "LG Smart TV", icon: <Tv className="h-3 w-3" /> };
  if (/\blg[- ]/.test(lower) || lower.includes("lg/") || lower.includes("lge") || lower.includes("colt/"))
    return { device: "LG Smart TV", icon: <Tv className="h-3 w-3" /> };
  if (lower.includes("tizen") || lower.includes("samsung"))
    return { device: "Samsung Tizen", icon: <Tv className="h-3 w-3" /> };
  if (lower.includes("philips") || lower.includes("nettv") || lower.includes("saphi"))
    return { device: "Philips", icon: <Tv className="h-3 w-3" /> };
  if (lower.includes("android tv") || lower.includes("androidtv") || lower.includes("googletv"))
    return { device: "Android TV", icon: <Tv className="h-3 w-3" /> };
  if (lower.includes("fully kiosk") || lower.includes("fullykiosk"))
    return { device: "Fully Kiosk", icon: <Tv className="h-3 w-3" /> };
  if (lower.includes("firetv") || lower.includes("fire tv") || (lower.includes("silk") && lower.includes("fire")))
    return { device: "Fire TV", icon: <Tv className="h-3 w-3" /> };
  if (lower.includes("chromecast") || lower.includes("crkey"))
    return { device: "Chromecast", icon: <Tv className="h-3 w-3" /> };
  // Mobile / Tablet
  if (/iphone|android.*mobile/.test(lower)) return { device: "Mobile", icon: <Smartphone className="h-3 w-3" /> };
  if (/ipad|android(?!.*mobile)|tablet/.test(lower)) return { device: "Tablette", icon: <Tablet className="h-3 w-3" /> };
  // Desktop browsers
  let browser = "Navigateur";
  if (lower.includes("chrome") && !lower.includes("edg")) browser = "Chrome";
  else if (lower.includes("firefox")) browser = "Firefox";
  else if (lower.includes("safari") && !lower.includes("chrome")) browser = "Safari";
  else if (lower.includes("edg")) browser = "Edge";
  let os = "";
  if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("mac os")) os = "Mac";
  else if (lower.includes("linux") && !lower.includes("android")) os = "Linux";
  return { device: os ? `${browser} / ${os}` : browser, icon: <Laptop className="h-3 w-3" /> };
}

export function ScreenManager() {
  const { screens, isLoading, addScreen, updateScreen, deleteScreen } = useScreens();
  const { media } = useMedia();
  const { layouts } = useLayouts();
  const { playlists } = usePlaylists();
  const { programs } = usePrograms();
  const { currentEstablishmentId } = useEstablishmentContext();
  const queryClient = useQueryClient();
  const screenIds = useMemo(() => screens.map((s: any) => s.id), [screens]);
  const { data: licenseStatuses } = useScreenLicenses(screenIds);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["screens"] });
    setTimeout(() => setIsRefreshing(false), 800);
  };

  const { data: maxScreens } = useQuery({
    queryKey: ["establishment-max-screens", currentEstablishmentId],
    enabled: !!currentEstablishmentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("establishments")
        .select("max_screens")
        .eq("id", currentEstablishmentId!)
        .single();
      return data?.max_screens ?? 0;
    },
  });

  const quotaReached = maxScreens != null && maxScreens > 0 && screens.length >= maxScreens;
  const [newName, setNewName] = useState("");
  const [wallDialogOpen, setWallDialogOpen] = useState(false);
  const [configWall, setConfigWall] = useState<{ id: string; name: string; rows: number; cols: number } | null>(null);
  const { walls, deleteWall, moveScreenInWall } = useVideoWalls();
  const [dragScreenId, setDragScreenId] = useState<string | null>(null);
  const [dragOverCell, setDragOverCell] = useState<string | null>(null);
  const [quickPlaylistScreen, setQuickPlaylistScreen] = useState<{ id: string; name: string } | null>(null);
  const [previewScreen, setPreviewScreen] = useState<{ id: string; slug: string | null; name: string } | null>(null);
  const [previewWall, setPreviewWall] = useState<{ id: string; name: string; rows: number; cols: number } | null>(null);
  const [detailScreenId, setDetailScreenId] = useState<string | null>(null);
  const detailScreen = useMemo(() => screens.find((s: any) => s.id === detailScreenId) ?? null, [screens, detailScreenId]);

  // Bulk action helpers for an entire wall
  const wallScreensFor = (wallId: string) => screens.filter((s: any) => s.wall_id === wallId);

  const setWallDebugMode = async (wallId: string, mode: number) => {
    const list = wallScreensFor(wallId);
    if (!list.length) return toast.info("Aucun écran dans ce mur");
    try {
      const { error } = await supabase.from("screens").update({ debug_mode: mode } as any).eq("wall_id", wallId);
      if (error) throw error;
      toast.success(`Mode debug appliqué à ${list.length} écran(s)`);
    } catch (e: any) {
      toast.error(e?.message || "Erreur");
    }
  };

  const refreshWall = async (wallId: string, wallName: string) => {
    const list = wallScreensFor(wallId);
    if (!list.length) return toast.info("Aucun écran dans ce mur");
    try {
      await Promise.all(list.map(async (s: any) => {
        const channel = supabase.channel(`screen-control-${s.id}`);
        await new Promise<void>((resolve) => {
          channel.subscribe((status) => { if (status === "SUBSCRIBED") resolve(); });
          setTimeout(resolve, 1500);
        });
        await channel.send({ type: "broadcast", event: "force_refresh", payload: { at: Date.now() } });
        setTimeout(() => supabase.removeChannel(channel), 1000);
      }));
      toast.success(`Signal envoyé au mur "${wallName}" (${list.length})`);
    } catch {
      toast.error("Erreur d'envoi du signal");
    }
  };

  const stopWallSessions = async (wallId: string) => {
    const list = wallScreensFor(wallId);
    if (!list.length) return toast.info("Aucun écran dans ce mur");
    if (!confirm(`Forcer l'arrêt des sessions sur ${list.length} écran(s) ?`)) return;
    try {
      const { error } = await supabase.from("screens").update({
        status: 'offline',
        player_session_id: null,
        player_heartbeat_at: null,
      } as any).eq("wall_id", wallId);
      if (error) throw error;
      toast.success("Sessions arrêtées");
    } catch (e: any) {
      toast.error(e?.message || "Erreur");
    }
  };

  const openAllPlayers = (wallId: string) => {
    const list = wallScreensFor(wallId);
    if (!list.length) return toast.info("Aucun écran dans ce mur");
    list.forEach((s: any) => window.open(`/player/${s.slug || s.id}`, '_blank'));
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await addScreen.mutateAsync(newName);
      toast.success("Écran ajouté");
      setNewName("");
    } catch (err: any) {
      const diagnostic = explainSupabaseError(err, "Création écran");
      toast.error(`Écran impossible: ${diagnostic.cause}`, { description: diagnostic.action });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg sm:text-xl font-semibold text-foreground">Gestion des Écrans</h2>
        <span className="text-sm text-muted-foreground">({screens.length})</span>
        <Button variant="outline" size="icon" onClick={handleRefresh} title="Actualiser les écrans" className="ml-auto">
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="Nom du nouvel écran"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          className="sm:max-w-xs"
        />
        <div className="flex gap-3 items-center flex-wrap">
          <Button onClick={handleAdd} disabled={quotaReached} className="gap-2">
            <Plus className="h-4 w-4" /> Ajouter
          </Button>
          <Button variant="outline" onClick={() => setWallDialogOpen(true)} disabled={quotaReached} className="gap-2">
            <Grid3x3 className="h-4 w-4" /> Créer un mur d'écrans
          </Button>
          {maxScreens != null && maxScreens > 0 && (
            <Badge variant={quotaReached ? "destructive" : "secondary"} className="text-sm px-3 py-1">
              {screens.length}/{maxScreens} écrans
            </Badge>
          )}
        </div>
      </div>

      {/* Video walls list */}
      {walls.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
            <Grid3x3 className="h-4 w-4" /> Murs d'écrans ({walls.length})
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {walls.map((w: any) => {
              const wallScreens = screens.filter((s: any) => s.wall_id === w.id);
              const debugActive = wallScreens.some((s: any) => (s.debug_mode ?? 0) > 0);
              const onlineCount = wallScreens.filter((s: any) => s.status === 'online').length;
              return (
                <Card
                  key={w.id}
                  className="glass-panel p-3 cursor-pointer hover:ring-1 hover:ring-primary/40 transition"
                  onClick={() => setConfigWall({ id: w.id, name: w.name, rows: w.rows, cols: w.cols })}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="border border-border rounded bg-muted/30 shrink-0"
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${w.cols}, 1fr)`,
                        gridTemplateRows: `repeat(${w.rows}, 1fr)`,
                        gap: 2,
                        padding: 2,
                        width: 60,
                        aspectRatio: `${w.cols * 16} / ${w.rows * 9}`,
                      }}
                    >
                      {Array.from({ length: w.rows * w.cols }).map((_, i) => (
                        <div key={i} className="bg-primary/30 rounded-sm" />
                      ))}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate text-sm">{w.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {w.rows}×{w.cols} • {wallScreens.length} écran(s) • {onlineCount} en ligne
                      </p>
                    </div>
                  </div>

                  {/* Bulk actions bar */}
                  <div className="flex items-center gap-1 mt-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      title="Aperçu mosaïque du mur"
                      onClick={() => setPreviewWall({ id: w.id, name: w.name, rows: w.rows, cols: w.cols })}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      title="Configurer le mur"
                      onClick={() => setConfigWall({ id: w.id, name: w.name, rows: w.rows, cols: w.cols })}
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                    {onlineCount > 0 && (
                      <Button
                        variant="outline"
                        size="icon"
                        title="Arrêter toutes les sessions du mur"
                        className="h-8 w-8 text-orange-500 border-orange-500/30 hover:bg-orange-500/10"
                        onClick={() => stopWallSessions(w.id)}
                      >
                        <Power className="h-4 w-4" />
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          title="Mode diagnostic (tout le mur)"
                          className={`h-8 w-8 ${debugActive ? "text-amber-500 border-amber-500/30 hover:bg-amber-500/10" : ""}`}
                        >
                          <Bug className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setWallDebugMode(w.id, 0)}>Désactivé</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setWallDebugMode(w.id, 2)}>HUD discret</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setWallDebugMode(w.id, 1)}>Complet</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-blue-500 border-blue-500/30 hover:bg-blue-500/10"
                      title="Forcer le rafraîchissement de tous les écrans"
                      onClick={() => refreshWall(w.id, w.name)}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      title="Ouvrir tous les players (un onglet par écran)"
                      onClick={() => openAllPlayers(w.id)}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive ml-auto"
                      title="Supprimer le mur"
                      onClick={async () => {
                        if (!confirm(`Supprimer le mur "${w.name}" ? Les écrans seront détachés mais conservés.`)) return;
                        try {
                          await deleteWall.mutateAsync(w.id);
                          toast.success("Mur supprimé");
                        } catch (e: any) {
                          toast.error(e?.message || "Erreur");
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <VideoWallDialog open={wallDialogOpen} onOpenChange={setWallDialogOpen} />
      <WallConfigDialog open={!!configWall} onOpenChange={(o) => !o && setConfigWall(null)} wall={configWall} />

      {isLoading ? (
        <p className="text-muted-foreground">Chargement...</p>
      ) : (
        <div className="space-y-3">
          {screens.filter((s: any) => !s.wall_id).map((screen) => {
            const assignedMedia = media.find((m) => m.id === screen.current_media_id);
            const assignedLayout = layouts.find((l) => l.id === (screen as any).layout_id);
            const assignedPlaylist = playlists.find((p) => p.id === (screen as any).playlist_id);
            const assignedProgram = programs.find((p) => p.id === (screen as any).program_id);
            const orientationPreview = getOrientationPreview(screen.orientation);

            return (
            <Card key={screen.id} className="glass-panel p-4 cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all" onClick={() => setDetailScreenId(screen.id)}>
              <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                {/* Thumbnail */}
                <div className="relative w-24 h-16 rounded-md border border-border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                  {assignedMedia && assignedMedia.type === "image" ? (
                    <img src={assignedMedia.url} alt={assignedMedia.name} className="w-full h-full object-cover" />
                  ) : assignedMedia && assignedMedia.type === "video" ? (
                    <video src={assignedMedia.url} className="w-full h-full object-cover" muted preload="metadata" />
                  ) : assignedLayout ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <LayoutGrid className="h-4 w-4 text-primary/60" />
                      <span className="text-[9px] text-muted-foreground truncate max-w-[80px]">{assignedLayout.name}</span>
                    </div>
                  ) : (
                    <Image className="h-5 w-5 text-muted-foreground/30" />
                  )}

                  <div className="absolute bottom-1 right-1 h-5 min-w-5 px-1 rounded border border-border bg-background/90 flex items-center justify-center gap-1">
                    <Monitor className={`h-3 w-3 text-foreground/70 transition-transform ${orientationPreview.rotationClass}`} />
                    <span className="text-[9px] leading-none text-muted-foreground">{orientationPreview.label}</span>
                  </div>
                </div>

                {/* Info */}
                <div className="flex items-center gap-3 min-w-[200px]">
                  <Monitor className="h-5 w-5 text-primary shrink-0" />
                  <div>
                    <p className="font-medium">{screen.name}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {isScreenReallyOnline(screen) ? (
                        <>
                          <Badge variant="outline" className="text-status-online border-status-online/30 gap-1 text-xs">
                            <Wifi className="h-3 w-3" /> En ligne
                          </Badge>
                          {(() => {
                            const parsed = parseUserAgent((screen as any).player_user_agent);
                            return (
                              <Badge variant="outline" className="text-muted-foreground border-border gap-1 text-xs">
                                {parsed.icon} {parsed.device}
                              </Badge>
                            );
                          })()}
                        </>
                      ) : (
                        <Badge variant="outline" className="text-status-offline border-status-offline/30 gap-1 text-xs">
                          <WifiOff className="h-3 w-3" /> Hors ligne
                        </Badge>
                      )}
                      {(screen as any).fallback_since &&
                        isScreenReallyOnline(screen) &&
                        !(screen as any).layout_id &&
                        !(screen as any).current_media_id && (
                        <Badge variant="outline" className="text-yellow-500 border-yellow-500/30 gap-1 text-xs animate-pulse">
                          <AlertTriangle className="h-3 w-3" /> En fallback
                        </Badge>
                      )}
                      {licenseStatuses && !licenseStatuses[screen.id]?.valid && (
                        <Badge variant="outline" className="text-destructive border-destructive/30 gap-1 text-xs">
                          {licenseStatuses[screen.id]?.expired ? (
                            <><ShieldOff className="h-3 w-3" /> Licence expirée</>
                          ) : licenseStatuses[screen.id]?.inactive ? (
                            <><ShieldAlert className="h-3 w-3" /> Licence désactivée</>
                          ) : (
                            <><ShieldAlert className="h-3 w-3" /> Sans licence</>
                          )}
                        </Badge>
                      )}
                      {assignedPlaylist && (
                        <Badge variant="outline" className="text-primary border-primary/30 gap-1 text-xs">
                          <ListMusic className="h-3 w-3" /> {assignedPlaylist.name}
                        </Badge>
                      )}
                      {assignedProgram && (
                        <Badge variant="outline" className="text-accent-foreground border-accent/30 gap-1 text-xs">
                          <CalendarClock className="h-3 w-3" /> {assignedProgram.name}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 sm:gap-3 flex-wrap w-full lg:w-auto">
                {/* Orientation */}
                <Select
                  value={screen.orientation}
                  onValueChange={(val) => updateScreen.mutate({ id: screen.id, orientation: val })}
                >
                  <SelectTrigger className="w-[130px] sm:w-[150px]">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="landscape">Paysage (0°)</SelectItem>
                    <SelectItem value="portrait">Portrait (90°)</SelectItem>
                    <SelectItem value="landscape-flipped">Paysage inversé (180°)</SelectItem>
                    <SelectItem value="portrait-flipped">Portrait inversé (270°)</SelectItem>
                  </SelectContent>
                </Select>

                {/* Media selector */}
                <Select
                  value={screen.current_media_id ?? "none"}
                  onValueChange={(val) => {
                    const isMedia = val !== "none";
                    // Assigning a single media clears playlist/program so it isn't
                    // overwritten by the rotation logic in useScreenRealtime.
                    updateScreen.mutate({
                      id: screen.id,
                      current_media_id: isMedia ? val : null,
                      ...(isMedia ? { playlist_id: null, program_id: null } : {}),
                    } as any);
                  }}
                >
                  <SelectTrigger className="w-[140px] sm:w-[200px]">
                    <SelectValue placeholder="Sélectionner un média" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Aucun média</SelectItem>
                    {media.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Layout selector */}
                <Select
                  value={(screen as any).layout_id ?? "none"}
                  onValueChange={(val) =>
                    updateScreen.mutate({ id: screen.id, layout_id: val === "none" ? null : val } as any)
                  }
                >
                  <SelectTrigger className="w-[140px] sm:w-[200px]">
                    <LayoutGrid className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Layout" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Aucun layout</SelectItem>
                    {layouts.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Resolution selector — works on Android, LG, Samsung, Philips */}
                <Select
                  value={(screen as any).resolution ?? "auto"}
                  onValueChange={(val) =>
                    updateScreen.mutate({ id: screen.id, resolution: val })
                  }
                >
                  <SelectTrigger className="w-[140px] sm:w-[170px]" title="Forcer une résolution de rendu sur l'écran">
                    <Tv className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Résolution" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (natif)</SelectItem>
                    <SelectItem value="3840x2160">4K UHD — 3840×2160</SelectItem>
                    <SelectItem value="2560x1440">QHD — 2560×1440</SelectItem>
                    <SelectItem value="1920x1080">Full HD — 1920×1080</SelectItem>
                    <SelectItem value="1366x768">HD — 1366×768</SelectItem>
                    <SelectItem value="1280x720">HD — 1280×720</SelectItem>
                    <SelectItem value="1024x768">XGA — 1024×768</SelectItem>
                    <SelectItem value="2160x3840">4K Portrait — 2160×3840</SelectItem>
                    <SelectItem value="1080x1920">FHD Portrait — 1080×1920</SelectItem>
                    <SelectItem value="720x1280">HD Portrait — 720×1280</SelectItem>
                  </SelectContent>
                </Select>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 ml-auto flex-wrap" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPreviewScreen({ id: screen.id, slug: (screen as any).slug || screen.id, name: screen.name })}
                    title="Aperçu en temps réel"
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setQuickPlaylistScreen({ id: screen.id, name: screen.name })}
                    title="Créer une playlist rapide pour cet écran"
                    className="text-primary border-primary/30 hover:bg-primary/10"
                  >
                    <Sparkles className="h-4 w-4" />
                  </Button>
                  {screen.status === 'online' && (
                    <Button
                      variant="outline"
                      size="icon"
                      title="Forcer l'arrêt de la session"
                      onClick={async () => {
                        try {
                          await updateScreen.mutateAsync({
                            id: screen.id,
                            status: 'offline',
                          } as any);
                          await supabase.from("screens").update({
                            player_session_id: null,
                            player_heartbeat_at: null,
                          }).eq("id", screen.id);
                          toast.success("Session arrêtée");
                        } catch {
                          toast.error("Erreur lors de l'arrêt");
                        }
                      }}
                      className="text-orange-500 border-orange-500/30 hover:bg-orange-500/10"
                    >
                      <Power className="h-4 w-4" />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        title="Mode diagnostic"
                        className={((screen as any).debug_mode ?? 0) > 0 ? "text-amber-500 border-amber-500/30 hover:bg-amber-500/10" : ""}
                      >
                        <Bug className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => updateScreen.mutate({ id: screen.id, debug_mode: 0 } as any)}>
                        {((screen as any).debug_mode ?? 0) === 0 && "✓ "}Désactivé
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => updateScreen.mutate({ id: screen.id, debug_mode: 2 } as any)}>
                        {(screen as any).debug_mode === 2 && "✓ "}HUD discret
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => updateScreen.mutate({ id: screen.id, debug_mode: 1 } as any)}>
                        {(screen as any).debug_mode === 1 && "✓ "}Complet
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="outline"
                    size="icon"
                    title="Forcer le rafraîchissement (recharge la page sur la TV)"
                    className="text-blue-500 border-blue-500/30 hover:bg-blue-500/10"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        const channel = supabase.channel(`screen-control-${screen.id}`);
                        await new Promise<void>((resolve) => {
                          channel.subscribe((status) => {
                            if (status === "SUBSCRIBED") resolve();
                          });
                          setTimeout(resolve, 1500);
                        });
                        await channel.send({
                          type: "broadcast",
                          event: "force_refresh",
                          payload: { at: Date.now() },
                        });
                        toast.success(`Signal envoyé à "${screen.name}"`);
                        setTimeout(() => supabase.removeChannel(channel), 1000);
                      } catch {
                        toast.error("Erreur d'envoi du signal");
                      }
                    }}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(`/player/${(screen as any).slug || screen.id}`, '_blank')}
                    title="Ouvrir le player"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="destructive"
                    size="icon"
                    onClick={() => deleteScreen.mutate(screen.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {/* Live preview dialog */}
      <Dialog open={!!previewScreen} onOpenChange={() => setPreviewScreen(null)}>
        <DialogContent className="max-w-5xl w-[95vw] h-[80vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2">
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" /> Aperçu en temps réel
            </DialogTitle>
            <DialogDescription>
              {previewScreen?.name} — Ce que l'écran affiche actuellement
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 px-6 pb-6 min-h-0">
            {previewScreen && (
              <iframe
                src={`/player/${previewScreen.slug || previewScreen.id}?preview=1`}
                className="w-full h-full rounded-lg border border-border bg-black"
                title={`Aperçu - ${previewScreen.name}`}
                allow="autoplay"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Wall mosaic preview dialog */}
      <Dialog open={!!previewWall} onOpenChange={() => setPreviewWall(null)}>
        <DialogContent className="max-w-6xl w-[95vw] h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2">
            <DialogTitle className="flex items-center gap-2">
              <Grid3x3 className="h-5 w-5" /> Aperçu mosaïque — {previewWall?.name}
            </DialogTitle>
            <DialogDescription>
              {previewWall && `${previewWall.rows}×${previewWall.cols} — temps réel · glissez‑déposez une tuile pour la déplacer ou la permuter`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 px-6 pb-6 min-h-0">
            {previewWall && (() => {
              const ws = screens
                .filter((s: any) => s.wall_id === previewWall.id)
                .sort((a: any, b: any) => (a.wall_row - b.wall_row) || (a.wall_col - b.wall_col));
              const cells = Array.from({ length: previewWall.rows * previewWall.cols }).map((_, i) => {
                const row = Math.floor(i / previewWall.cols);
                const col = i % previewWall.cols;
                return ws.find((s: any) => s.wall_row === row && s.wall_col === col) || null;
              });
              return (
                <div
                  className="w-full h-full grid gap-1 bg-black/50 rounded-lg p-1"
                  style={{
                    gridTemplateColumns: `repeat(${previewWall.cols}, 1fr)`,
                    gridTemplateRows: `repeat(${previewWall.rows}, 1fr)`,
                  }}
                >
                  {cells.map((s: any, i) => {
                    const orient = s?.orientation || "landscape";
                    const rot = orient === "portrait" ? 90 : orient === "landscape-flipped" ? 180 : orient === "portrait-flipped" ? 270 : 0;
                    const orientLabel = getOrientationPreview(orient).label;
                    const row = Math.floor(i / previewWall!.cols);
                    const col = i % previewWall!.cols;
                    const online = s ? isScreenReallyOnline(s) : false;
                    return (
                    <div
                      key={i}
                      onDragOver={(e) => {
                        if (!dragScreenId) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDragOverCell(`${row}-${col}`);
                      }}
                      onDragLeave={() => {
                        setDragOverCell((c) => (c === `${row}-${col}` ? null : c));
                      }}
                      onDrop={async (e) => {
                        e.preventDefault();
                        const screenId = e.dataTransfer.getData("text/screen-id") || dragScreenId;
                        setDragOverCell(null);
                        setDragScreenId(null);
                        if (!screenId || !previewWall) return;
                        // No-op if dropped on its own cell
                        if (s && s.id === screenId) return;
                        try {
                          await moveScreenInWall.mutateAsync({ wallId: previewWall.id, screenId, row, col });
                          toast.success(s ? "Écrans permutés" : "Écran déplacé");
                        } catch (err: any) {
                          toast.error(err?.message || "Erreur lors du déplacement");
                        }
                      }}
                      className={`group relative bg-black border rounded overflow-hidden transition-all duration-200 hover:border-primary hover:shadow-[0_0_0_2px_hsl(var(--primary)/0.4)] hover:z-10 ${
                        dragOverCell === `${row}-${col}`
                          ? "border-primary ring-2 ring-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.5)] scale-[1.02] z-20"
                          : "border-border/50"
                      } ${dragScreenId && s?.id === dragScreenId ? "opacity-40" : ""}`}
                      title={s ? `${s.name} — Ligne ${s.wall_row + 1}, Colonne ${s.wall_col + 1} — ${orientLabel} (glisser pour déplacer)` : `Cellule vide (Ligne ${row + 1}, Colonne ${col + 1}) — déposer un écran ici`}
                    >
                      {s ? (
                        <>
                          <iframe
                            key={`${s.id}-${orient}`}
                            src={`/player/${s.slug || s.id}?preview=1&orient=${orient}`}
                            className="w-full h-full pointer-events-none"
                            title={`Tuile ${i}`}
                            allow="autoplay"
                            style={{ transform: `rotate(${rot}deg)`, transformOrigin: "center center" }}
                          />
                          {/* Draggable handle layer (covers the tile so user can grab anywhere) */}
                          <div
                            draggable
                            onDragStart={(e) => {
                              setDragScreenId(s.id);
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/screen-id", s.id);
                            }}
                            onDragEnd={() => {
                              setDragScreenId(null);
                              setDragOverCell(null);
                            }}
                            className="absolute inset-0 cursor-grab active:cursor-grabbing"
                            aria-label={`Glisser ${s.name}`}
                          />
                          {/* Top-left coordinate badge (always visible) */}
                          <div className="absolute top-1 left-1 bg-background/85 backdrop-blur text-foreground text-[10px] px-1.5 py-0.5 rounded font-mono border border-border/50 flex items-center gap-1 pointer-events-none">
                            <span className="font-semibold">L{s.wall_row + 1}·C{s.wall_col + 1}</span>
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
                          </div>
                          {/* Top-right orientation badge */}
                          <div className="absolute top-1 right-1 bg-background/85 backdrop-blur text-foreground text-[10px] px-1.5 py-0.5 rounded font-mono border border-border/50 pointer-events-none">
                            {orientLabel}
                          </div>
                          {/* Hover overlay with full info + actions */}
                          <div className="absolute inset-x-0 bottom-0 bg-black/75 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-1 p-2 text-center pointer-events-none">
                            <div className="text-white font-semibold text-xs truncate max-w-full">{s.name}</div>
                            <div className="text-white/80 text-[10px] font-mono">L{s.wall_row + 1}·C{s.wall_col + 1} · {orientLabel}</div>
                            <div className="flex gap-1 mt-1 pointer-events-auto">
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => window.open(`/player/${s.slug || s.id}`, "_blank")}
                              >
                                <ExternalLink className="h-3 w-3 mr-1" /> Ouvrir
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => {
                                  setPreviewWall(null);
                                  setDetailScreenId(s.id);
                                }}
                              >
                                <Settings className="h-3 w-3 mr-1" /> Détails
                              </Button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className={`w-full h-full flex flex-col items-center justify-center text-muted-foreground text-xs gap-1 transition-colors ${dragScreenId ? "bg-primary/10" : "hover:bg-muted/10"}`}>
                          <span className="font-mono text-[10px]">L{row + 1}·C{col + 1}</span>
                          <span>{dragScreenId ? "Déposer ici" : "Vide"}</span>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* Screen detail dialog */}
      <ScreenDetailDialog
        screen={detailScreen}
        licenseStatus={detailScreen && licenseStatuses ? licenseStatuses[detailScreen.id] : null}
        assignedMedia={detailScreen ? media.find((m) => m.id === detailScreen.current_media_id) : null}
        assignedLayout={detailScreen ? layouts.find((l) => l.id === detailScreen.layout_id) : null}
        assignedPlaylist={detailScreen ? playlists.find((p) => p.id === detailScreen.playlist_id) : null}
        assignedProgram={detailScreen ? programs.find((p) => p.id === detailScreen.program_id) : null}
        onClose={() => setDetailScreenId(null)}
      />

      {/* Quick playlist creation dialog */}
      <QuickPlaylistDialog
        open={!!quickPlaylistScreen}
        onOpenChange={(o) => !o && setQuickPlaylistScreen(null)}
        screenId={quickPlaylistScreen?.id}
        screenName={quickPlaylistScreen?.name}
      />
    </div>
  );
}
