import { useParams } from "react-router-dom";
import { useScreenRealtime } from "@/hooks/useScreenRealtime";
import { MonitorPlay, ShieldOff, KeyRound, MonitorX } from "lucide-react";
import React, { useEffect, useState, useRef, useCallback, Component, type ErrorInfo, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import WidgetRenderer from "@/components/widgets/WidgetRenderer";
import { validateLicense, activateLicenseByKey } from "@/hooks/useLicenses";
import { QRCodeSVG } from "qrcode.react";
import FallbackScreen from "@/components/player/FallbackScreen";
import DiagnosticOverlay from "@/components/player/DiagnosticOverlay";
import { useLocalHealth } from "@/hooks/useLocalHealth";
import { toEmbedUrl } from "@/lib/iframe-url";

// Hook to fetch active contents for a screen filtered by current time
function useActiveContents(screenId: string | undefined) {
  const [contents, setContents] = useState<Array<{ id: string; image_url: string; title: string | null; metadata: Record<string, any> | null }>>([]);

  useEffect(() => {
    if (!screenId) return;

    const fetchContents = async () => {
      const now = new Date().toISOString();
      const { data } = await supabase
        .from("contents" as any)
        .select("id, image_url, title, metadata")
        .eq("screen_id", screenId)
        .eq("status", "active")
        .or(`start_time.is.null,start_time.lte.${now}`)
        .or(`end_time.is.null,end_time.gte.${now}`)
        .order("created_at", { ascending: false }) as any;
      setContents(data || []);
    };

    fetchContents();
    const interval = setInterval(fetchContents, 30000);

    const channel = supabase
      .channel(`contents-player-${screenId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "contents", filter: `screen_id=eq.${screenId}` }, () => fetchContents())
      .subscribe();

    return () => { clearInterval(interval); supabase.removeChannel(channel); };
  }, [screenId]);

  return contents;
}

interface LayoutRegionData {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  media_id: string | null;
  widget_type: string | null;
  widget_config: Record<string, any> | null;
  media: { id: string; name: string; type: string; url: string } | null;
}

interface LayoutData {
  id: string;
  width: number;
  height: number;
  background_color: string;
  bg_type?: string;
  bg_image_url?: string | null;
  bg_image_fit?: string;
  bg_overlay_darken?: number;
  bg_overlay_blur?: number;
}

interface PlayerBranding {
  logoUrl: string;
  showLogo: boolean;
  bgColor: string;
  watermark: string;
  showSignatureOnPlayer: boolean;
}

interface RegionErrorBoundaryProps {
  children: ReactNode;
  regionId: string;
}

interface RegionErrorBoundaryState {
  hasError: boolean;
}

/** Error boundary for FallbackScreen – minimal fallback if QRCodeSVG crashes on old browsers (LG webOS) */
class FallbackErrorBoundary extends React.Component<
  { screenName: string; screenId: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: any) { console.warn("[FallbackErrorBoundary]", err); }
  render() {
    if (this.state.hasError) {
      const uploadUrl = (typeof window !== "undefined" ? window.location.origin : "") + "/upload/" + this.props.screenId;
      return (
        <div style={{ width: "100%", height: "100%", backgroundColor: "#0a0e17", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#cbd5e1" }}>
          <p style={{ fontSize: 32, fontWeight: 200 }}>{this.props.screenName}</p>
          <p style={{ marginTop: 16, fontSize: 14, opacity: 0.5 }}>Scannez le QR ou visitez :</p>
          <p style={{ marginTop: 8, fontSize: 12, opacity: 0.4, wordBreak: "break-all", maxWidth: "80%" }}>{uploadUrl}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionErrorBoundaryState> {
  state: RegionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RegionErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn("[Player] Widget region render error", {
      regionId: this.props.regionId,
      error: error.message,
      componentStack: errorInfo.componentStack,
    });
  }

  componentDidUpdate(prevProps: RegionErrorBoundaryProps) {
    if (prevProps.regionId !== this.props.regionId && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "rgba(0,0,0,0.55)",
          color: "#fff",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}>
          Widget indisponible
        </div>
      );
    }

    return this.props.children;
  }
}

function getOrientationStyle(orientation: string): React.CSSProperties {
  const swappedBase: React.CSSProperties = {
    transformOrigin: "center center",
    width: "100vh",
    height: "100vw",
    position: "absolute",
    top: "50%",
    left: "50%",
    marginTop: "calc(-50vw)",
    marginLeft: "calc(-50vh)",
    overflow: "hidden",
  };
  switch (orientation) {
    case "portrait":
      return { ...swappedBase, transform: "rotate(90deg)" };
    case "landscape-flipped":
      return { transform: "rotate(180deg)", width: "100%", height: "100%", overflow: "hidden" };
    case "portrait-flipped":
      return { ...swappedBase, transform: "rotate(270deg)" };
    default:
      return { width: "100%", height: "100%", overflow: "hidden" };
  }
}

/**
 * Forces a virtual rendering resolution and scales it to fit the physical screen.
 * Works on Android, LG webOS, Samsung Tizen, Philips, and standard browsers.
 * `resolution` format: "WIDTHxHEIGHT" or "auto".
 */
function ResolutionFrame({ resolution, children }: { resolution?: string | null; children: React.ReactNode }) {
  const parsed = (() => {
    if (!resolution || resolution === "auto") return null;
    const m = /^(\d+)x(\d+)$/.exec(resolution);
    if (!m) return null;
    return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  })();

  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!parsed) return;
    const update = () => {
      setScale(Math.min(window.innerWidth / parsed.w, window.innerHeight / parsed.h));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [parsed?.w, parsed?.h]);

  if (!parsed) return <>{children}</>;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", backgroundColor: "#000" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: parsed.w,
          height: parsed.h,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center center",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MediaRenderer({ media, playlistLength }: { media: { id: string; name: string; type: string; url: string }; playlistLength?: number }) {
  const containerStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "#000",
    /* Ensure no sub-pixel gaps on LG WebOS */
    margin: 0,
    padding: 0,
  };

  const mediaStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "cover",
    objectPosition: "center center",
    backgroundColor: "#000",
  };

  if (media.type === "image") {
    return (
      <div style={containerStyle}>
        <img src={media.url} alt={media.name} style={mediaStyle} />
      </div>
    );
  }
  if (media.type === "video") {
    return (
      <div style={containerStyle}>
        <video
          key={media.id}
          src={media.url}
          style={mediaStyle}
          autoPlay
          muted
          loop={!playlistLength || playlistLength <= 1}
          playsInline
        />
      </div>
    );
  }
  return (
    <div style={containerStyle}>
      <iframe src={toEmbedUrl(media.url)} style={{ ...mediaStyle, border: "none" }} allowFullScreen title={media.name} />
    </div>
  );
}

/**
 * WallTile: when a screen is part of a video wall, scale the content by (cols, rows)
 * and translate it so this tile shows only its assigned portion.
 * Result: every screen in the wall plays the SAME source, but each shows a different slice.
 */
function WallTile({
  rows, cols, row, col, children,
}: { rows?: number | null; cols?: number | null; row?: number | null; col?: number | null; children: React.ReactNode }) {
  const r = Number(rows), c = Number(cols), rr = Number(row), cc = Number(col);
  const isWall = r > 0 && c > 0 && Number.isFinite(rr) && Number.isFinite(cc) && (r > 1 || c > 1);
  if (!isWall) return <>{children}</>;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: "#000" }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${c * 100}%`,
          height: `${r * 100}%`,
          transform: `translate(${-cc * (100 / c)}%, ${-rr * (100 / r)}%)`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function withCacheBust(url: string, version?: string | number | null): string {
  if (!url) return url;
  const v = version ? String(version) : Date.now().toString();
  const sep = url.includes("?") ? "&" : "?";
  // Strip any existing v= param to avoid stacking
  const clean = url.replace(/([?&])v=[^&]*(&|$)/, (_, p1, p2) => (p2 ? p1 : "")).replace(/[?&]$/, "");
  const sep2 = clean.includes("?") ? "&" : "?";
  return `${clean}${sep2}v=${encodeURIComponent(v)}`;
}

function usePlayerBranding(screenId?: string): PlayerBranding {
  const [branding, setBranding] = useState<PlayerBranding>({
    logoUrl: "",
    showLogo: true,
    bgColor: "#000000",
    watermark: "",
    showSignatureOnPlayer: false,
  });

  useEffect(() => {
    if (!screenId) return;
    let cancelled = false;
    let establishmentId: string | null = null;

    const fetchBranding = async () => {
      const { data: screenData } = await supabase
        .from("screens")
        .select("establishment_id")
        .eq("id", screenId)
        .single();

      let logoUrl = "";
      let logoVersion: string | null = null;
      let showLogo = true;
      let bgColor = "#000000";
      let watermark = "";
      let showSignatureOnPlayer = false;

      if (screenData?.establishment_id) {
        establishmentId = screenData.establishment_id;
        const { data: estData } = await supabase
          .from("establishments")
          .select("logo_url, updated_at")
          .eq("id", screenData.establishment_id)
          .single();

        const { data: estSettings } = await supabase
          .from("establishment_settings")
          .select("key, value, updated_at")
          .eq("establishment_id", screenData.establishment_id)
          .in("key", ["brand_show_logo_player", "brand_player_bg_color", "brand_player_watermark", "brand_logo_url"]);

        const settingsMap: Record<string, { value: string; updated_at?: string }> = {};
        if (estSettings) {
          estSettings.forEach((s: any) => {
            if (s.value) settingsMap[s.key] = { value: s.value, updated_at: s.updated_at };
          });
        }

        // PRIORITY: brand_logo_url (from BrandingTab) overrides establishments.logo_url
        if (settingsMap.brand_logo_url) {
          logoUrl = settingsMap.brand_logo_url.value;
          logoVersion = settingsMap.brand_logo_url.updated_at || Date.now().toString();
        } else if (estData?.logo_url) {
          logoUrl = estData.logo_url;
          logoVersion = estData.updated_at || Date.now().toString();
        }

        if (settingsMap.brand_show_logo_player?.value === "false") showLogo = false;
        if (settingsMap.brand_player_bg_color?.value) bgColor = settingsMap.brand_player_bg_color.value;
        if (settingsMap.brand_player_watermark?.value) watermark = settingsMap.brand_player_watermark.value;
      }

      // Check global setting for signature on player
      const { data: globalSettings } = await supabase
        .from("app_settings")
        .select("key, value, updated_at")
        .in("key", ["logo_url", "show_signature_on_player"]);

      if (globalSettings) {
        globalSettings.forEach((s: any) => {
          if (s.key === "logo_url" && s.value && !logoUrl) {
            logoUrl = s.value;
            if (s.updated_at) logoVersion = s.updated_at;
          }
          if (s.key === "show_signature_on_player" && s.value === "true") showSignatureOnPlayer = true;
        });
      }

      if (cancelled) return;
      setBranding({
        logoUrl: logoUrl ? withCacheBust(logoUrl, logoVersion) : "",
        showLogo,
        bgColor,
        watermark,
        showSignatureOnPlayer,
      });
    };

    fetchBranding();

    // Realtime: refresh branding when establishment or its settings change
    const estChannel = supabase
      .channel(`branding-${screenId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "establishments" }, (payload: any) => {
        if (!establishmentId || payload?.new?.id === establishmentId || payload?.old?.id === establishmentId) {
          fetchBranding();
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "establishment_settings" }, (payload: any) => {
        if (!establishmentId || payload?.new?.establishment_id === establishmentId || payload?.old?.establishment_id === establishmentId) {
          fetchBranding();
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
        fetchBranding();
      })
      .subscribe();

    // Safety net: also refetch every 60s
    const poll = setInterval(fetchBranding, 60000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      supabase.removeChannel(estChannel);
    };
  }, [screenId]);

  return branding;
}

function CompanyLogo({ logoUrl, show = true }: { logoUrl: string; show?: boolean }) {
  if (!logoUrl || !show) return null;
  return <img src={logoUrl} alt="Logo" style={{ height: 64, width: "auto", objectFit: "contain", marginBottom: 16 }} />;
}

function Watermark({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div style={{
      position: "absolute", bottom: 16, right: 16, zIndex: 50,
      color: "rgba(255,255,255,0.2)", fontSize: 12, fontWeight: 500,
      letterSpacing: "0.05em", pointerEvents: "none",
    }}>
      {text}
    </div>
  );
}

function PlayerSignature({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div style={{
      position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)",
      zIndex: 50, color: "rgba(255,255,255,0.15)", fontSize: 10,
      fontWeight: 400, letterSpacing: "0.1em", pointerEvents: "none",
      whiteSpace: "nowrap",
    }}>
      ScreenFlow by Dravox
    </div>
  );
}

function LayoutRenderer({
  layoutId,
  screenOrientation,
  screenName,
  screenId,
  logoUrl,
  showLogo,
}: {
  layoutId: string;
  screenOrientation: string;
  screenName: string;
  screenId: string;
  logoUrl: string;
  showLogo: boolean;
}) {
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [regions, setRegions] = useState<LayoutRegionData[]>([]);
  const [isLayoutLoading, setIsLayoutLoading] = useState(true);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  const fetchLayout = useCallback(async () => {
    try {
      const [layoutRes, regionsRes] = await Promise.all([
        supabase.from("layouts").select("id, width, height, background_color, bg_type, bg_image_url, bg_image_fit, bg_overlay_darken, bg_overlay_blur").eq("id", layoutId).single(),
        supabase.from("layout_regions").select("*, media:media_id(id, name, type, url)").eq("layout_id", layoutId).order("z_index", { ascending: true }),
      ]);

      if (layoutRes.error) throw layoutRes.error;
      if (regionsRes.error) throw regionsRes.error;

      if (layoutRes.data) setLayout(layoutRes.data as LayoutData);
      setRegions((regionsRes.data ?? []) as LayoutRegionData[]);
      setLayoutError(null);
    } catch (err: any) {
      setLayoutError(err?.message || "Erreur de chargement du layout");
    } finally {
      setIsLayoutLoading(false);
    }
  }, [layoutId]);

  useEffect(() => {
    let cancelled = false;

    const safeFetch = async () => {
      if (cancelled) return;
      await fetchLayout();
    };

    safeFetch();

    const pollInterval = setInterval(safeFetch, 30000);

    const channel = supabase
      .channel(`layout-regions-${layoutId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "layout_regions", filter: `layout_id=eq.${layoutId}` }, () => {
        safeFetch();
      })
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      supabase.removeChannel(channel);
    };
  }, [layoutId, fetchLayout]);

  if (!layout) {
    return (
      <div style={{ width: "100%", height: "100%", position: "relative" }}>
        <FallbackScreen
          screenName={screenName}
          screenId={screenId}
          logoUrl={logoUrl}
          showLogo={showLogo}
        />
        {(isLayoutLoading || layoutError) && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.2)",
            color: "#fff",
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            pointerEvents: "none",
          }}>
            {isLayoutLoading ? "Chargement du layout..." : "Reconnexion au layout..."}
          </div>
        )}
      </div>
    );
  }

  const rotationStyle = getOrientationStyle(screenOrientation);

  // If all regions are empty (no widget and no media), show fallback with a hint
  const allRegionsEmpty = regions.length === 0 || regions.every(r => !r.widget_type && !r.media);
  if (allRegionsEmpty) {
    return (
      <div style={{ width: "100%", height: "100%", position: "relative" }}>
        <FallbackErrorBoundary screenName={screenName} screenId={screenId}>
          <FallbackScreen
            screenName={screenName}
            screenId={screenId}
            logoUrl={logoUrl}
            showLogo={showLogo}
          />
        </FallbackErrorBoundary>
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
          backgroundColor: "rgba(245, 158, 11, 0.95)", color: "#1f2937",
          padding: "8px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600,
          fontFamily: "system-ui,-apple-system,sans-serif", letterSpacing: "0.02em",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)", zIndex: 10, pointerEvents: "none",
        }}>
          ⚠️ Layout vide — ajoutez un média ou un widget aux zones du layout
        </div>
      </div>
    );
  }

  return (
    <div style={{
      width: "100%", height: "100%", position: "relative",
      backgroundColor: layout.background_color,
      backgroundImage: layout.bg_type === "image" && layout.bg_image_url ? `url(${layout.bg_image_url})` : undefined,
      backgroundSize: layout.bg_image_fit === "contain" ? "contain" : layout.bg_image_fit === "repeat" ? "auto" : "cover",
      backgroundRepeat: layout.bg_image_fit === "repeat" ? "repeat" : "no-repeat",
      backgroundPosition: "center",
      ...rotationStyle,
    }}>
      {layout.bg_type === "image" && layout.bg_image_url && ((layout.bg_overlay_darken || 0) > 0) && (
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          backgroundColor: `rgba(0,0,0,${(layout.bg_overlay_darken || 0) / 100})`,
          zIndex: 0,
        }} />
      )}
      {regions.map((region) => {
        const style: React.CSSProperties = {
          position: "absolute",
          left: `${(region.x / layout.width) * 100}%`,
          top: `${(region.y / layout.height) * 100}%`,
          width: `${(region.width / layout.width) * 100}%`,
          height: `${(region.height / layout.height) * 100}%`,
          zIndex: region.z_index,
          overflow: "hidden",
        };
        return (
          <div key={region.id} style={style}>
            <RegionErrorBoundary regionId={region.id}>
              {region.widget_type ? (
                <WidgetRenderer widgetType={region.widget_type} widgetConfig={region.widget_config ?? undefined} />
              ) : region.media ? (
                <MediaRenderer media={region.media} />
              ) : null}
            </RegionErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}

function LicenseScreen({
  containerRef,
  requestFullscreen,
  message,
  screenId,
  screenName,
  onActivated,
  logoUrl,
  showLogo,
}: {
  containerRef: React.RefObject<HTMLDivElement>;
  requestFullscreen: () => void;
  message: string;
  screenId: string;
  screenName: string;
  onActivated: () => void;
  logoUrl: string;
  showLogo: boolean;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setChecking(true);
    setError("");
    const result = await activateLicenseByKey(key, screenId);
    if (result.valid) {
      onActivated();
    } else {
      setError(result.message || "Clé invalide");
    }
    setChecking(false);
  };

  return (
    <div ref={containerRef} style={{ position: "fixed", inset: 0, backgroundColor: "#000", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={requestFullscreen}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, textAlign: "center", padding: 32, maxWidth: 400, width: "100%" }} onClick={(e) => e.stopPropagation()}>
        <CompanyLogo logoUrl={logoUrl} show={showLogo} />
        <div style={{ height: 80, width: 80, borderRadius: 16, backgroundColor: "rgba(239,68,68,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ShieldOff style={{ height: 40, width: 40, color: "#ef4444" }} />
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.1em" }}>Licence invalide</h1>
        <p style={{ color: "#d1d5db", fontSize: 14, fontWeight: 500, marginTop: -8 }}>{screenName}</p>
        <p style={{ color: "#9ca3af" }}>{message}</p>

        <form onSubmit={handleSubmit} style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <KeyRound style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", height: 16, width: 16, color: "#6b7280" }} />
              <input
                type="text"
                value={key}
                onChange={(e) => { setKey(e.target.value.toUpperCase()); setError(""); }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                style={{
                  width: "100%", height: 44, paddingLeft: 40, paddingRight: 12,
                  borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.1)", color: "#fff",
                  fontFamily: "monospace", letterSpacing: "0.1em", fontSize: 14,
                }}
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={checking || !key.trim()}
              style={{
                height: 44, padding: "0 20px", borderRadius: 8,
                backgroundColor: "#3b82f6", color: "#000", fontWeight: 600,
                fontSize: 14, letterSpacing: "0.05em", textTransform: "uppercase",
                border: "none", cursor: checking || !key.trim() ? "not-allowed" : "pointer",
                opacity: checking || !key.trim() ? 0.4 : 1,
              }}
            >
              {checking ? "..." : "Activer"}
            </button>
          </div>
          {error && <p style={{ color: "#ef4444", fontSize: 14 }}>{error}</p>}
        </form>

        <div style={{ width: "100%", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 20, marginTop: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <p style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>ou scannez pour choisir une licence</p>
          <div style={{ backgroundColor: "#fff", padding: 12, borderRadius: 12 }}>
            <QRCodeSVG
              value={`${window.location.origin}/assign-license/${screenId}`}
              size={140}
              level="M"
            />
          </div>
        </div>

        <p style={{ fontSize: 11, color: "#4b5563", marginTop: 8 }}>
          Vérification automatique toutes les 5 secondes
        </p>
      </div>
    </div>
  );
}

function ActiveContentCarousel({ contents, screenOrientation }: { contents: Array<{ id: string; image_url: string; title: string | null; metadata: Record<string, any> | null }>; screenOrientation: string }) {
  const [index, setIndex] = useState(0);
  const current = contents[Math.min(index, contents.length - 1)];
  const contentType = (current?.metadata as any)?.type || "image";

  const advance = useCallback(() => {
    if (contents.length <= 1) return;
    setIndex(prev => (prev + 1) % contents.length);
  }, [contents.length]);

  useEffect(() => {
    if (contents.length <= 1 && contentType !== "video") return;
    if (contentType === "video") return;
    const timer = setInterval(advance, 10000);
    return () => clearInterval(timer);
  }, [contents.length, contentType, advance]);

  if (!current) return null;

  const contentOrientation = (current.metadata as any)?.orientation || screenOrientation;
  const rotationStyle = getOrientationStyle(contentOrientation);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", backgroundColor: "#000", ...rotationStyle }}>
      {contentType === "video" ? (
        <video
          key={current.id}
          src={current.image_url}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center center", display: "block", backgroundColor: "#000" }}
          autoPlay
          muted
          playsInline
          onEnded={contents.length > 1 ? advance : undefined}
          loop={contents.length <= 1}
        />
      ) : (
        <img src={current.image_url} alt={current.title || ""} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center center", display: "block", backgroundColor: "#000" }} />
      )}
    </div>
  );
}

export default function Player() {
  const { id } = useParams<{ id: string }>();
  const { data: health, refetch: refetchHealth } = useLocalHealth(10000);
  const restDown = health?.restOk === false;

  // Le player n'est jamais bloqué par la santé du backend : on rend toujours le
  // runtime (contenu déjà chargé / cache / QR de secours) et on signale l'incident
  // dans un bandeau discret non bloquant.
  return (
    <>
      <PlayerRuntime id={id} />
      {restDown && (
        <div
          style={{
            position: "fixed",
            left: 16,
            bottom: 16,
            zIndex: 2147483646,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderRadius: 10,
            backgroundColor: "rgba(5,7,13,0.82)",
            border: "1px solid rgba(239,68,68,0.45)",
            color: "#fca5a5",
            fontSize: 12,
            fontFamily: "system-ui,-apple-system,sans-serif",
            pointerEvents: "auto",
          }}
        >
          <MonitorX style={{ height: 14, width: 14, color: "#ef4444" }} />
          <span>Base locale injoignable (/rest/v1) — lecture en mode dégradé</span>
          <button
            onClick={() => refetchHealth()}
            style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#e5e7eb", borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}
          >
            Réessayer
          </button>
        </div>
      )}
    </>
  );
}


function PlayerRuntime({ id }: { id: string | undefined }) {
  const urlDebug1 = typeof window !== "undefined" && window.location.search.indexOf("debug=1") >= 0;
  const urlDebug2 = typeof window !== "undefined" && window.location.search.indexOf("debug=2") >= 0;
  const previewMode = typeof window !== "undefined" && window.location.search.indexOf("preview=1") >= 0;
  const { screen, media, loading, sessionBlocked, forceTakeover, playlistLength, currentIndex, currentDuration, layoutId } = useScreenRealtime(id, { previewOnly: previewMode });
  const remoteDebugMode = (screen as any)?.debug_mode ?? 0;
  const debugMode = urlDebug1 || remoteDebugMode === 1;
  const hudMode = urlDebug2 || remoteDebugMode === 2;
  const activeContents = useActiveContents(screen?.id);
  const branding = usePlayerBranding(screen?.id);
  const [visible, setVisible] = useState(true);
  const [hasContent, setHasContent] = useState(false);
  const [progress, setProgress] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>();

  // Wall info (if this screen is part of a video wall) — reactive to wall row/col changes
  const [wallInfo, setWallInfo] = useState<{ rows: number; cols: number } | null>(null);
  useEffect(() => {
    const wallId = (screen as any)?.wall_id;
    if (!wallId) { setWallInfo(null); return; }
    const fetchWall = () => {
      (supabase as any).from("video_walls").select("rows, cols").eq("id", wallId).maybeSingle().then(({ data }: any) => {
        if (data) setWallInfo({ rows: data.rows, cols: data.cols });
      });
    };
    fetchWall();
    const channel = supabase
      .channel(`video-wall-${wallId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "video_walls", filter: `id=eq.${wallId}` }, () => fetchWall())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [(screen as any)?.wall_id]);

  // License validation (also in preview mode so preview reflects real state)
  const [licenseValid, setLicenseValid] = useState<boolean | null>(null);
  const [licenseMessage, setLicenseMessage] = useState("");

  useEffect(() => {
    if (!screen?.id) return;

    const checkLicense = () => {
      validateLicense(screen.id).then((result) => {
        setLicenseValid(result.valid);
        if (!result.valid) setLicenseMessage(result.message || "Licence invalide");
      });
    };

    checkLicense();

    // Always poll every 10s, even when valid — catches deactivations
    const interval = setInterval(checkLicense, 10000);

    const channel = supabase
      .channel(`license-realtime-${screen.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "licenses", filter: `screen_id=eq.${screen.id}` },
        () => { checkLicense(); }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [screen?.id]);

  // Listen for remote refresh signal — forces full page reload (bypasses HTTP cache on Smart TVs)
  useEffect(() => {
    if (!screen?.id || previewMode) return;
    const channel = supabase
      .channel(`screen-control-${screen.id}`)
      .on("broadcast", { event: "force_refresh" }, () => {
        // On-screen toast overlay (DOM-injected so it shows over any render branch)
        try {
          const overlay = document.createElement("div");
          overlay.setAttribute("data-refresh-toast", "1");
          overlay.style.cssText = [
            "position:fixed",
            "top:50%",
            "left:50%",
            "transform:translate(-50%,-50%)",
            "z-index:2147483647",
            "background:rgba(0,0,0,0.85)",
            "color:#fff",
            "padding:24px 40px",
            "border-radius:16px",
            "font-family:system-ui,-apple-system,sans-serif",
            "font-size:28px",
            "font-weight:600",
            "letter-spacing:0.5px",
            "box-shadow:0 20px 60px rgba(0,0,0,0.6)",
            "border:1px solid rgba(255,255,255,0.15)",
            "display:flex",
            "align-items:center",
            "gap:16px",
            "pointer-events:none",
          ].join(";");
          overlay.innerHTML = `
            <div style="width:24px;height:24px;border:3px solid rgba(255,255,255,0.25);border-top-color:#3b82f6;border-radius:50%;animation:rt-spin 0.8s linear infinite"></div>
            <span>Mise à jour en cours...</span>
            <style>@keyframes rt-spin{to{transform:rotate(360deg)}}</style>
          `;
          document.body.appendChild(overlay);
        } catch {}
        try {
          if ("caches" in window) {
            caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
          }
        } catch {}
        setTimeout(() => {
          const url = new URL(window.location.href);
          url.searchParams.set("_r", Date.now().toString());
          window.location.replace(url.toString());
        }, 1000);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [screen?.id, previewMode]);

  const requestFullscreen = useCallback(() => {
    if (previewMode) return; // No fullscreen in preview
    const el = containerRef.current;
    if (!el || document.fullscreenElement) return;
    try { el.requestFullscreen?.().catch(() => {}); } catch (_) {}
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    // Try fullscreen immediately on load (works on LG webOS)
    requestFullscreen();
    // Fallback: also listen for first click
    const handler = () => {
      requestFullscreen();
      document.removeEventListener("click", handler);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [requestFullscreen, previewMode]);

  useEffect(() => {
    if (layoutId) return;
    setVisible(false);
    const timer = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(timer);
  }, [media?.id, currentIndex, layoutId]);

  useEffect(() => {
    const nowHasContent = !!(media || activeContents.length > 0 || layoutId);
    setHasContent(nowHasContent);
  }, [media, activeContents, layoutId]);

  // Track fallback state in DB for alerting
  useEffect(() => {
    if (!screen?.id || previewMode) return;
    const inFallback = !hasContent && licenseValid === true && !loading;
    
    if (inFallback) {
      supabase.from("screens").update({
        fallback_since: new Date().toISOString(),
        fallback_notified: false,
      } as any).eq("id", screen.id).then();
    } else {
      supabase.from("screens").update({
        fallback_since: null,
        fallback_notified: false,
      } as any).eq("id", screen.id).then();
    }
  }, [hasContent, screen?.id, licenseValid, loading, previewMode]);

  useEffect(() => {
    if (!currentDuration || currentDuration <= 0 || layoutId) {
      setProgress(0);
      return;
    }
    const durationMs = currentDuration * 1000;
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min((elapsed / durationMs) * 100, 100);
      setProgress(pct);
      if (pct < 100) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [media?.id, currentIndex, currentDuration, layoutId]);

  const playerBgStyle: React.CSSProperties = { backgroundColor: branding.bgColor || "#000" };

  // Build enriched diagnostic props
  const diagBaseProps = {
    screenId: screen?.id, screenName: screen?.name, screenStatus: screen?.status,
    mediaId: media ? media.id : null, mediaType: media ? media.type : null,
    mediaUrl: media ? media.url : null, layoutId: layoutId,
    playlistLength: playlistLength, currentIndex: currentIndex,
    sessionBlocked: sessionBlocked, licenseValid: licenseValid,
    orientation: screen?.orientation,
    activeContentsCount: activeContents.length,
    layoutRegionsEmpty: null as boolean | null,
    hasPlaylist: !!(screen as any)?.playlist_id,
    hasProgram: !!(screen as any)?.program_id,
    currentMediaId: (screen as any)?.current_media_id ?? null,
    playlistId: (screen as any)?.playlist_id ?? null,
    programId: (screen as any)?.program_id ?? null,
  };

  if (loading) {
    return (
      <div style={{ ...playerBgStyle, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {debugMode && <DiagnosticOverlay {...diagBaseProps} />}
        {hudMode && <DiagnosticOverlay {...diagBaseProps} mode="hud" />}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <CompanyLogo logoUrl={branding.logoUrl} show={branding.showLogo} />
          <MonitorPlay style={{ height: 48, width: 48, color: "#3b82f6" }} />
          <p style={{ color: "#9ca3af" }}>Connexion à l'écran...</p>
        </div>
      </div>
    );
  }

  if (!screen) {
    const askedId = id ?? "(inconnu)";
    const setupUrl = (typeof window !== "undefined" ? window.location.origin : "") + "/setup";
    return (
      <div style={{ position: "fixed", inset: 0, backgroundColor: "#0a0e17", color: "#e5e7eb", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", gap: 16 }}>
        <MonitorX style={{ height: 56, width: 56, color: "#ef4444" }} />
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#ef4444", letterSpacing: "0.05em" }}>Écran introuvable</h1>
        <p style={{ maxWidth: 520, color: "#9ca3af", fontSize: 14, lineHeight: 1.6 }}>
          Aucun écran ne correspond à <code style={{ color: "#fbbf24", background: "rgba(255,255,255,0.05)", padding: "2px 8px", borderRadius: 4 }}>{askedId}</code> dans la base de données.
          <br /><br />
          Cela arrive généralement après un nouveau déploiement (la base est vide) ou si l'écran a été supprimé.
          Connectez-vous au tableau de bord pour créer un nouvel écran, puis utilisez sa nouvelle URL.
        </p>
        <a
          href={setupUrl}
          style={{ marginTop: 8, padding: "10px 20px", backgroundColor: "#3b82f6", color: "#fff", borderRadius: 8, textDecoration: "none", fontSize: 14, fontWeight: 600 }}
        >
          Configurer un écran
        </a>
        <p style={{ fontSize: 11, color: "#6b7280", marginTop: 8 }}>
          {typeof window !== "undefined" ? window.location.host : ""}
        </p>
      </div>
    );
  }

  if (sessionBlocked && !previewMode) {
    return (
      <div ref={containerRef} style={{ ...playerBgStyle, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center", padding: 32 }}>
          <CompanyLogo logoUrl={branding.logoUrl} show={branding.showLogo} />
          <div style={{ height: 80, width: 80, borderRadius: 16, backgroundColor: "rgba(239,68,68,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <MonitorX style={{ height: 40, width: 40, color: "#ef4444" }} />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.1em" }}>Écran déjà actif</h1>
          <p style={{ color: "#9ca3af", maxWidth: 380 }}>
            Cet écran est déjà ouvert sur un autre appareil. Fermez l'autre session pour pouvoir l'utiliser ici.
          </p>
          <button
            onClick={forceTakeover}
            style={{
              marginTop: 16, padding: "12px 24px", borderRadius: 8,
              backgroundColor: "#3b82f6", color: "#fff", fontWeight: 600,
              border: "none", cursor: "pointer", fontSize: 14,
            }}
          >
            Forcer la prise de contrôle
          </button>
          <p style={{ fontSize: 11, color: "#6b7280", marginTop: 8 }}>
            Vérification automatique toutes les 15 secondes
          </p>
        </div>
        <Watermark text={branding.watermark} />
      </div>
    );
  }

  if (licenseValid === null) {
    return (
      <div style={{ ...playerBgStyle, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <CompanyLogo logoUrl={branding.logoUrl} show={branding.showLogo} />
          <MonitorPlay style={{ height: 48, width: 48, color: "#3b82f6" }} />
          <p style={{ color: "#9ca3af" }}>Vérification de la licence...</p>
        </div>
      </div>
    );
  }

  if (licenseValid === false) {
    return (
      <LicenseScreen
        containerRef={containerRef}
        requestFullscreen={requestFullscreen}
        message={licenseMessage}
        screenId={screen.id}
        screenName={screen.name}
        onActivated={() => setLicenseValid(true)}
        logoUrl={branding.logoUrl}
        showLogo={branding.showLogo}
      />
    );
  }

  const screenResolution = (screen as any)?.resolution as string | undefined;

  if (layoutId && !media && activeContents.length === 0) {
    return (
      <div ref={containerRef} style={{ ...playerBgStyle, position: "fixed", inset: 0, width: "100vw", height: "100vh", overflow: "hidden", cursor: "none" }} onClick={requestFullscreen}>
        {debugMode && <DiagnosticOverlay {...diagBaseProps} />}
        {hudMode && <DiagnosticOverlay {...diagBaseProps} mode="hud" />}
        <ResolutionFrame resolution={screenResolution}>
          <WallTile
            rows={wallInfo?.rows}
            cols={wallInfo?.cols}
            row={(screen as any).wall_row}
            col={(screen as any).wall_col}
          >
            <LayoutRenderer
              layoutId={layoutId}
              screenOrientation={screen.orientation}
              screenName={screen.name}
              screenId={screen.id}
              logoUrl={branding.logoUrl}
              showLogo={branding.showLogo}
            />
          </WallTile>
        </ResolutionFrame>
        <Watermark text={branding.watermark} />
        <PlayerSignature show={branding.showSignatureOnPlayer} />
      </div>
    );
  }

  const rotationStyle = getOrientationStyle(screen.orientation);

  return (
    <div ref={containerRef} style={{ ...playerBgStyle, position: "fixed", inset: 0, width: "100vw", height: "100vh", overflow: "hidden", cursor: "none" }} onClick={requestFullscreen}>
      {debugMode && <DiagnosticOverlay {...diagBaseProps} />}
      {hudMode && <DiagnosticOverlay {...diagBaseProps} mode="hud" />}
      <ResolutionFrame resolution={screenResolution}>
      <div style={{ width: "100%", height: "100%", transition: "transform 0.7s ease-in-out", ...rotationStyle }}>
        <div style={{ width: "100%", height: "100%", transition: "opacity 0.5s ease-in-out", opacity: visible ? 1 : 0 }}>
          {/* Fallback screen */}
          <div style={{
            position: "absolute", inset: 0,
            transition: "opacity 1s ease-in-out",
            opacity: hasContent ? 0 : 1,
            pointerEvents: hasContent ? "none" : "auto",
          }}>
            <FallbackErrorBoundary screenName={screen.name} screenId={screen.id}>
              <FallbackScreen
                screenName={screen.name}
                screenId={screen.id}
                logoUrl={branding.logoUrl}
                showLogo={branding.showLogo}
              />
            </FallbackErrorBoundary>
          </div>

          {/* Actual content */}
          <div style={{
            position: "absolute", inset: 0,
            transition: "opacity 1s ease-in-out",
            opacity: hasContent ? 1 : 0,
            pointerEvents: hasContent ? "auto" : "none",
          }}>
            <WallTile
              rows={wallInfo?.rows}
              cols={wallInfo?.cols}
              row={(screen as any).wall_row}
              col={(screen as any).wall_col}
            >
              {activeContents.length > 0 && !media ? (
                <ActiveContentCarousel contents={activeContents} screenOrientation={screen.orientation} />
              ) : media ? (
                <MediaRenderer media={media} playlistLength={playlistLength} />
              ) : null}
            </WallTile>
          </div>
        </div>

        {playlistLength > 1 && currentDuration > 0 && (
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 4, backgroundColor: "rgba(255,255,255,0.1)" }}>
            <div style={{ height: "100%", backgroundColor: "#3b82f6", width: `${progress}%` }} />
          </div>
        )}

        {playlistLength > 1 && (
          <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 6 }}>
            {Array.from({ length: playlistLength }).map((_, i) => (
              <div key={i} style={{
                height: 6, borderRadius: 3,
                transition: "all 0.3s",
                width: i === currentIndex ? 24 : 6,
                backgroundColor: i === currentIndex ? "#3b82f6" : "rgba(255,255,255,0.2)",
              }} />
            ))}
          </div>
        )}
      </div>
      </ResolutionFrame>
      <Watermark text={branding.watermark} />
      <PlayerSignature show={branding.showSignatureOnPlayer} />
    </div>
  );
}
