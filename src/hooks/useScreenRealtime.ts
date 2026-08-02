import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSupabasePublishableKey, supabaseEndpoint } from "@/lib/env";

interface MediaData {
  id: string;
  name: string;
  type: string;
  url: string;
  duration: number;
}

interface ScreenData {
  id: string;
  name: string;
  orientation: string;
  status: string;
  current_media_id: string | null;
  layout_id: string | null;
  playlist_id: string | null;
  program_id: string | null;
}

interface PlaylistItem {
  id: string;
  media_id: string;
  position: number;
  duration: number | null;
  media: MediaData;
}

interface ScheduleRow {
  id: string;
  media_id: string | null;
  playlist_id: string | null;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  active: boolean;
  media: MediaData | null;
  playlist_items?: PlaylistItem[];
}

/** Returns the currently active schedule (media or playlist) for the current day/time. */
function getActiveSchedule(schedules: ScheduleRow[]): ScheduleRow | null {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const currentDay = now.getDay();

  for (const sch of schedules) {
    if (!sch.active) continue;
    if (!sch.days_of_week.includes(currentDay)) continue;
    const start = sch.start_time.slice(0, 5);
    const end = sch.end_time.slice(0, 5);
    if (currentTime >= start && currentTime <= end) {
      if (sch.media) return sch;
      if (sch.playlist_id && sch.playlist_items && sch.playlist_items.length > 0) return sch;
    }
  }
  return null;
}

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const SESSION_ID = generateSessionId();
const HEARTBEAT_INTERVAL = 5000;
const SESSION_TIMEOUT = 15000;

export function useScreenRealtime(screenId: string | undefined, options?: { previewOnly?: boolean }) {
  const previewOnly = options?.previewOnly ?? false;
  const [screen, setScreen] = useState<ScreenData | null>(null);
  const [media, setMedia] = useState<MediaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [playlistVersion, setPlaylistVersion] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const schedulesRef = useRef<ScheduleRow[]>([]);
  const realScreenIdRef = useRef<string | undefined>(undefined);
  const heartbeatRef = useRef<ReturnType<typeof setInterval>>();
  const bootRetryRef = useRef<ReturnType<typeof setTimeout>>();

  const screenRef = useRef<ScreenData | null>(null);
  const playlistRef = useRef<PlaylistItem[]>([]);
  const currentIndexRef = useRef(0);

  // Keep currentIndexRef in sync
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);

  const fetchPlaylist = useCallback(async (screenData: ScreenData) => {
    if (screenData.playlist_id) {
      const { data } = await supabase
        .from("playlist_items")
        .select("*, media:media_id(id, name, type, url, duration)")
        .eq("playlist_id", screenData.playlist_id)
        .order("position", { ascending: true });
      return (data ?? []) as PlaylistItem[];
    }
    const { data } = await supabase
      .from("playlist_items")
      .select("*, media:media_id(id, name, type, url, duration)")
      .eq("screen_id", screenData.id)
      .order("position", { ascending: true });
    return (data ?? []) as PlaylistItem[];
  }, []);

  const fetchSchedules = useCallback(async (screenData: ScreenData) => {
    let rows: any[] = [];
    if (screenData.program_id) {
      const { data } = await supabase
        .from("schedules")
        .select("*, media:media_id(id, name, type, url, duration)")
        .eq("program_id", screenData.program_id)
        .eq("active", true);
      rows = data ?? [];
    } else {
      const { data } = await supabase
        .from("schedules")
        .select("*, media:media_id(id, name, type, url, duration)")
        .eq("screen_id", screenData.id)
        .eq("active", true);
      rows = data ?? [];
    }

    // Load playlist_items for any schedule that targets a playlist
    const playlistIds = Array.from(
      new Set(rows.filter((r) => r.playlist_id).map((r) => r.playlist_id as string))
    );
    if (playlistIds.length > 0) {
      const { data: items } = await supabase
        .from("playlist_items")
        .select("*, media:media_id(id, name, type, url, duration)")
        .in("playlist_id", playlistIds)
        .order("position", { ascending: true });
      const itemsByPlaylist: Record<string, PlaylistItem[]> = {};
      (items ?? []).forEach((it: any) => {
        const pid = it.playlist_id as string;
        if (!itemsByPlaylist[pid]) itemsByPlaylist[pid] = [];
        itemsByPlaylist[pid].push(it as PlaylistItem);
      });
      rows = rows.map((r) =>
        r.playlist_id ? { ...r, playlist_items: itemsByPlaylist[r.playlist_id] ?? [] } : r
      );
    }

    return rows as ScheduleRow[];
  }, []);

  // Track the active schedule's playlist (so we know when to swap rotation)
  const activeSchedulePlaylistRef = useRef<string | null>(null);

  const resolveMedia = useCallback(
    (screenData: ScreenData | null, pl: PlaylistItem[], idx: number, opts?: { skipDbUpdate?: boolean }) => {
      const activeSch = getActiveSchedule(schedulesRef.current);

      // Case 1: Schedule with single media — show it directly
      if (activeSch && activeSch.media && !activeSch.playlist_id) {
        if (activeSchedulePlaylistRef.current !== null) {
          activeSchedulePlaylistRef.current = null;
        }
        setMedia(activeSch.media);
        return;
      }

      // Case 2: Schedule with playlist — swap rotation to that playlist
      if (activeSch && activeSch.playlist_id && activeSch.playlist_items && activeSch.playlist_items.length > 0) {
        const schedPl = activeSch.playlist_items;
        // If we just entered this schedule's playlist, reset playlist + index
        if (activeSchedulePlaylistRef.current !== activeSch.playlist_id) {
          activeSchedulePlaylistRef.current = activeSch.playlist_id;
          playlistRef.current = schedPl;
          setPlaylistVersion((v) => v + 1);
          setCurrentIndex(0);
          const first = schedPl[0]?.media ?? null;
          setMedia(first);
          if (first && !previewOnly && !opts?.skipDbUpdate) {
            const realId = realScreenIdRef.current;
            if (realId) {
              supabase.from("screens").update({ current_media_id: first.id } as any)
                .eq("id", realId).then(() => {});
            }
          }
          return;
        }
        // Already in this playlist — continue rotation
        const item = schedPl[idx % schedPl.length];
        const mediaItem = item?.media ?? null;
        setMedia(mediaItem);
        if (mediaItem && !previewOnly && !opts?.skipDbUpdate) {
          const realId = realScreenIdRef.current;
          if (realId) {
            supabase.from("screens").update({ current_media_id: mediaItem.id } as any)
              .eq("id", realId).then(() => {});
          }
        }
        return;
      }

      // Case 3: No active schedule — fall back to screen's playlist
      if (activeSchedulePlaylistRef.current !== null) {
        // Just exited a schedule playlist — restore the screen's own playlist
        activeSchedulePlaylistRef.current = null;
        playlistRef.current = pl;
        setPlaylistVersion((v) => v + 1);
        setCurrentIndex(0);
        idx = 0;
      }
      if (pl.length > 0) {
        const item = pl[idx % pl.length];
        const mediaItem = item?.media ?? null;
        setMedia(mediaItem);
        if (mediaItem && !previewOnly && !opts?.skipDbUpdate) {
          const realId = realScreenIdRef.current;
          if (realId) {
            supabase.from("screens").update({ current_media_id: mediaItem.id } as any)
              .eq("id", realId).then(() => {});
          }
        }
        return;
      }
      if (screenData?.current_media_id) return;
      setMedia(null);
    },
    [previewOnly]
  );

  const getItemDuration = useCallback((pl: PlaylistItem[], idx: number): number => {
    if (pl.length === 0) return 0;
    const item = pl[idx % pl.length];
    if (!item) return 10;
    return item.duration ?? item.media?.duration ?? 10;
  }, []);

  // Helper to update playlist and bump version (avoids array-ref issues)
  const updatePlaylist = useCallback((pl: PlaylistItem[]) => {
    playlistRef.current = pl;
    setPlaylistVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!screenId) return;

    const init = async () => {
      let screenRes = await supabase.from("screens").select("*").eq("slug", screenId).maybeSingle();
      if (!screenRes.data) {
        screenRes = await supabase.from("screens").select("*").eq("id", screenId).maybeSingle();
      }
      const screenData = screenRes.data as any;
      if (!screenData) { setLoading(false); return; }
      realScreenIdRef.current = screenData.id;

      // ---- PREVIEW MODE: read-only, no session claim ----
      if (previewOnly) {
        setScreen(screenData as ScreenData);
        screenRef.current = screenData as ScreenData;
        setSessionBlocked(false);

        const [pl, sch] = await Promise.all([
          fetchPlaylist(screenData as ScreenData),
          fetchSchedules(screenData as ScreenData),
        ]);
        updatePlaylist(pl);
        schedulesRef.current = sch;

        if (screenData.current_media_id && pl.length === 0) {
          const { data: mediaData } = await supabase
            .from("media")
            .select("*")
            .eq("id", screenData.current_media_id)
            .single();
          if (mediaData) setMedia(mediaData as MediaData);
        }

        setCurrentIndex(0);
        resolveMedia(screenData as ScreenData, pl, 0);
        setLoading(false);
        return;
      }

      // ---- NORMAL MODE: claim session ----
      const userAgent = navigator.userAgent;
      const staleThreshold = new Date(Date.now() - SESSION_TIMEOUT).toISOString();

      let playerIp: string | null = null;
      let playerLanIp: string | null = null;

      const resolvePlayerIp = async (): Promise<string | null> => {
        const providers = [
          "https://api64.ipify.org?format=json",
          "https://api.ipify.org?format=json",
          "https://ifconfig.co/json",
          "https://ipapi.co/json/",
        ];

        for (const provider of providers) {
          try {
            const res = await fetch(provider);
            if (!res.ok) continue;
            const data = await res.json();
            const ip =
              data && typeof data.ip === "string" ? data.ip :
              data && typeof data.ip_address === "string" ? data.ip_address :
              null;
            if (ip) return ip;
          } catch (_) {
            // try next provider
          }
        }

        return null;
      };

      const resolveLanIp = async (): Promise<string | null> => {
        try {
          const RTC = (window as any).RTCPeerConnection || (window as any).webkitRTCPeerConnection || (window as any).mozRTCPeerConnection;
          if (!RTC) return null;

          const isPrivateIpv4 = (ip: string) =>
            ip.startsWith("10.") ||
            ip.startsWith("192.168.") ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);

          return await new Promise<string | null>((resolve) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const pc = new RTC({ iceServers: [] });

            const finish = (value: string | null) => {
              if (settled) return;
              settled = true;
              if (timeout) clearTimeout(timeout);
              try { pc.onicecandidate = null; pc.close(); } catch (_) {}
              resolve(value);
            };

            const parseCandidate = (candidate: string) => {
              const matches = candidate.match(/(?:\d{1,3}\.){3}\d{1,3}/g) || [];
              for (const ip of matches) {
                if (isPrivateIpv4(ip)) {
                  finish(ip);
                  return;
                }
              }
            };

            pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
              if (event.candidate?.candidate) {
                parseCandidate(event.candidate.candidate);
                return;
              }
              if (!event.candidate) finish(null);
            };

            timeout = setTimeout(() => finish(null), 1600);
            pc.createDataChannel("lan-ip");
            pc.createOffer()
              .then((offer: RTCSessionDescriptionInit) => pc.setLocalDescription(offer))
              .catch(() => finish(null));
          });
        } catch (_) {
          return null;
        }
      };

      const tryResolveIpData = async () => {
        if (playerIp && playerLanIp) return;
        const [publicIp, lanIp] = await Promise.all([
          playerIp ? Promise.resolve(playerIp) : resolvePlayerIp(),
          playerLanIp ? Promise.resolve(playerLanIp) : resolveLanIp(),
        ]);
        if (publicIp) playerIp = publicIp;
        if (lanIp) playerLanIp = lanIp;
      };

      await tryResolveIpData();

      const makeUpdatePayload = () => ({
        player_session_id: SESSION_ID,
        player_heartbeat_at: new Date().toISOString(),
        player_user_agent: userAgent,
        ...(playerIp ? { player_ip: playerIp } : {}),
        ...(playerLanIp ? { player_lan_ip: playerLanIp } : {}),
        status: "online",
      } as any);

      const claimSession = async (id: string) => {
        let claimRes = await supabase
          .from("screens")
          .update(makeUpdatePayload())
          .eq("id", id)
          .is("player_session_id", null)
          .select("id");

        if (!claimRes.data || claimRes.data.length === 0) {
          claimRes = await supabase
            .from("screens")
            .update(makeUpdatePayload())
            .eq("id", id)
            .eq("player_session_id", SESSION_ID)
            .select("id");
        }

        if (!claimRes.data || claimRes.data.length === 0) {
          claimRes = await supabase
            .from("screens")
            .update(makeUpdatePayload())
            .eq("id", id)
            .lt("player_heartbeat_at", staleThreshold)
            .select("id");
        }

        return !!(claimRes.data && claimRes.data.length > 0);
      };

      const activateSession = async (activeScreenData: ScreenData) => {
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(async () => {
          const realId = realScreenIdRef.current;
          if (!realId) return;
          try {
            if (!playerIp || !playerLanIp) await tryResolveIpData();
            const heartbeatPayload: any = {
              player_heartbeat_at: new Date().toISOString(),
              player_user_agent: userAgent,
              status: "online",
            };
            if (playerIp) heartbeatPayload.player_ip = playerIp;
            if (playerLanIp) heartbeatPayload.player_lan_ip = playerLanIp;

            const hbRes = await (supabase.from("screens").update(heartbeatPayload) as any)
              .eq("id", realId)
              .eq("player_session_id", SESSION_ID)
              .select("id");

            if (!hbRes?.data || hbRes.data.length === 0) {
              await claimSession(realId);
            }
          } catch (_) {}
        }, HEARTBEAT_INTERVAL);

        setSessionBlocked(false);
        setScreen(activeScreenData);
        screenRef.current = activeScreenData;

        const [pl, sch] = await Promise.all([
          fetchPlaylist(activeScreenData),
          fetchSchedules(activeScreenData),
        ]);
        updatePlaylist(pl);
        schedulesRef.current = sch;

        if (activeScreenData.current_media_id && pl.length === 0) {
          const { data: mediaData } = await supabase
            .from("media")
            .select("*")
            .eq("id", activeScreenData.current_media_id)
            .single();
          if (mediaData) setMedia(mediaData as MediaData);
        }

        setCurrentIndex(0);
        resolveMedia(activeScreenData, pl, 0);
        setLoading(false);
      };

      await claimSession(screenData.id);

      const { data: verifyData } = await supabase
        .from("screens")
        .select("player_session_id, player_heartbeat_at")
        .eq("id", screenData.id)
        .single();

      if (verifyData && (verifyData as any).player_session_id !== SESSION_ID) {
        setSessionBlocked(true);
        setScreen(screenData as ScreenData);
        screenRef.current = screenData as ScreenData;
        setLoading(false);

        let lastHeartbeat = (verifyData as any).player_heartbeat_at as string | null;
        let unchangedForMs = 0;

        // Auto-retry every 10s, then force-takeover if heartbeat stays unchanged
        const retryInterval = setInterval(async () => {
          try {
            const stale = new Date(Date.now() - SESSION_TIMEOUT).toISOString();
            const retry = await supabase.from("screens").update(makeUpdatePayload())
              .eq("id", screenData.id)
              .lt("player_heartbeat_at", stale)
              .select("id");

            if (retry.data && retry.data.length > 0) {
              clearInterval(retryInterval);
              await activateSession(screenData as ScreenData);
              return;
            }

            const { data: live } = await supabase
              .from("screens")
              .select("player_session_id, player_heartbeat_at")
              .eq("id", screenData.id)
              .single();

            if (!live) return;
            if ((live as any).player_session_id === SESSION_ID) {
              clearInterval(retryInterval);
              await activateSession(screenData as ScreenData);
              return;
            }

            const currentHeartbeat = (live as any).player_heartbeat_at as string | null;
            if (currentHeartbeat === lastHeartbeat) {
              unchangedForMs += 10000;
            } else {
              lastHeartbeat = currentHeartbeat;
              unchangedForMs = 0;
            }

            if (unchangedForMs >= SESSION_TIMEOUT) {
              const forced = await supabase.from("screens").update(makeUpdatePayload())
                .eq("id", screenData.id)
                .select("id");
              if (forced.data && forced.data.length > 0) {
                clearInterval(retryInterval);
                await activateSession(screenData as ScreenData);
              }
            }
          } catch (_) {}
        }, 10000);

        heartbeatRef.current = retryInterval as any;
        return;
      }

      await activateSession(screenData as ScreenData);
    };

    // Boot résilient : si /rest/v1 est injoignable, on ne reste jamais bloqué sur
    // l'écran de chargement — on libère le rendu (contenu en cache / QR de secours)
    // et on retente l'initialisation toutes les 10 s.
    const bootWithRetry = () => {
      init().catch((err) => {
        console.warn("[useScreenRealtime] init failed, retry in 10s", err);
        setLoading(false);
        if (bootRetryRef.current) clearTimeout(bootRetryRef.current);
        bootRetryRef.current = setTimeout(bootWithRetry, 10000);
      });
    };
    bootWithRetry();


    // Preview mode: no offline cleanup needed
    if (previewOnly) return;

    const setOffline = () => {
      const realId = realScreenIdRef.current;
      if (!realId) return;
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      const apiKey = getSupabasePublishableKey();
      const url = `${supabaseEndpoint("/rest/v1/screens")}?id=eq.${realId}&player_session_id=eq.${SESSION_ID}&apikey=${apiKey}`;
      const body = JSON.stringify({ status: "offline", player_session_id: null, player_heartbeat_at: null, player_user_agent: null, player_ip: null, player_lan_ip: null });
      try {
        fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'apikey': apiKey, 'Authorization': `Bearer ${apiKey}`, 'Prefer': 'return=minimal' },
          body, keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    };

    window.addEventListener("beforeunload", setOffline);
    return () => { setOffline(); window.removeEventListener("beforeunload", setOffline); };
  }, [screenId, previewOnly, resolveMedia]);

  useEffect(() => {
    if (!screenId || previewOnly) return;

    const syncScreenState = async () => {
      const realId = realScreenIdRef.current;
      if (!realId) return;

      const { data } = await supabase
        .from("screens")
        .select("*")
        .eq("id", realId)
        .maybeSingle();

      const nextScreen = data as ScreenData | null;
      if (!nextScreen) return;

      const previousScreen = screenRef.current;
      const relevantChange = !previousScreen ||
        nextScreen.current_media_id !== previousScreen.current_media_id ||
        nextScreen.layout_id !== previousScreen.layout_id ||
        nextScreen.playlist_id !== previousScreen.playlist_id ||
        nextScreen.program_id !== previousScreen.program_id ||
        nextScreen.orientation !== previousScreen.orientation;

      setScreen(nextScreen);
      screenRef.current = nextScreen;

      if (!relevantChange) return;

      if (nextScreen.current_media_id) {
        const { data: mediaData } = await supabase
          .from("media")
          .select("*")
          .eq("id", nextScreen.current_media_id)
          .maybeSingle();

        setMedia((mediaData as MediaData | null) ?? null);
      } else {
        setMedia(null);
      }

      const [pl, sch] = await Promise.all([fetchPlaylist(nextScreen), fetchSchedules(nextScreen)]);
      updatePlaylist(pl);
      schedulesRef.current = sch;
      setCurrentIndex(0);
      resolveMedia(nextScreen, pl, 0, { skipDbUpdate: true });
    };

    const interval = setInterval(() => {
      syncScreenState().catch(() => {});
    }, 10000);

    return () => clearInterval(interval);
  }, [screenId, previewOnly, fetchPlaylist, fetchSchedules, resolveMedia, updatePlaylist]);

  // Playlist advancement timer — only in NORMAL mode (not preview)
  useEffect(() => {
    if (previewOnly) return; // Preview follows DB state, no local timer
    const pl = playlistRef.current;
    if (pl.length <= 1) return;
    const duration = getItemDuration(pl, currentIndex) * 1000;
    timerRef.current = setTimeout(() => {
      const next = (currentIndexRef.current + 1) % pl.length;
      setCurrentIndex(next);
      resolveMedia(screenRef.current, pl, next);
    }, duration);
    return () => clearTimeout(timerRef.current);
  }, [currentIndex, playlistVersion, resolveMedia, getItemDuration, previewOnly]);

  // Periodic schedule check — only in normal mode
  useEffect(() => {
    if (!screenId || previewOnly) return;
    const interval = setInterval(() => {
      resolveMedia(screenRef.current, playlistRef.current, currentIndexRef.current);
    }, 60_000);
    return () => clearInterval(interval);
  }, [screenId, resolveMedia, previewOnly]);

  // Realtime subscriptions
  useEffect(() => {
    const realId = realScreenIdRef.current;
    if (!realId) return;

    const channel = supabase
      .channel(`screen-${realId}${previewOnly ? '-preview' : ''}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "screens", filter: `id=eq.${realId}` }, async (payload) => {
        const newData = payload.new as ScreenData;
        const prev = screenRef.current;

        const relevantChange = !prev ||
          newData.current_media_id !== prev.current_media_id ||
          newData.layout_id !== prev.layout_id ||
          newData.playlist_id !== prev.playlist_id ||
          newData.program_id !== prev.program_id ||
          newData.orientation !== prev.orientation;

        // Always keep screen state fresh
        setScreen(newData);
        screenRef.current = newData;

        if (!relevantChange) return;

        // In preview mode: just follow current_media_id from DB
        if (previewOnly && newData.current_media_id) {
          const { data: mediaData } = await supabase.from("media").select("*").eq("id", newData.current_media_id).single();
          if (mediaData) setMedia(mediaData as MediaData);
          // Find the index in playlist for progress indicator
          const pl = playlistRef.current;
          const foundIdx = pl.findIndex(item => item.media?.id === newData.current_media_id);
          if (foundIdx >= 0) setCurrentIndex(foundIdx);
          return;
        }

        // Normal mode: handle config changes
        if (newData.current_media_id) {
          const { data: mediaData } = await supabase.from("media").select("*").eq("id", newData.current_media_id).single();
          if (mediaData) setMedia(mediaData as MediaData);
        }
        const [pl, sch] = await Promise.all([fetchPlaylist(newData), fetchSchedules(newData)]);
        updatePlaylist(pl);
        schedulesRef.current = sch;
        setCurrentIndex(0);
        resolveMedia(newData, pl, 0, { skipDbUpdate: true });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "playlist_items" }, async () => {
        if (previewOnly) return; // Preview follows current_media_id
        const s = screenRef.current;
        if (!s) return;
        const pl = await fetchPlaylist(s);
        updatePlaylist(pl);
        setCurrentIndex(0);
        resolveMedia(s, pl, 0);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "schedules" }, async () => {
        if (previewOnly) return;
        const s = screenRef.current;
        if (!s) return;
        const sch = await fetchSchedules(s);
        schedulesRef.current = sch;
        resolveMedia(s, playlistRef.current, currentIndexRef.current);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [screen?.id, screen?.playlist_id, screen?.program_id, fetchPlaylist, fetchSchedules, resolveMedia, updatePlaylist, previewOnly]);

  const pl = playlistRef.current;
  const currentDuration = pl.length > 0
    ? getItemDuration(pl, currentIndex)
    : (media?.duration ?? 0);

  const forceTakeover = useCallback(async () => {
    const realId = realScreenIdRef.current;
    if (!realId) return;
    await supabase.from("screens").update({
      player_session_id: SESSION_ID,
      player_heartbeat_at: new Date().toISOString(),
      player_user_agent: navigator.userAgent,
      status: "online",
    } as any).eq("id", realId);
    setSessionBlocked(false);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(async () => {
      if (!realScreenIdRef.current) return;
      try {
        await (supabase.from("screens").update({
          player_heartbeat_at: new Date().toISOString(),
          player_user_agent: navigator.userAgent,
          status: "online",
        } as any) as any).eq("id", realScreenIdRef.current).eq("player_session_id", SESSION_ID);
      } catch (_) {}
    }, HEARTBEAT_INTERVAL);
    const s = screenRef.current;
    if (!s) return;
    const [newPl, sch] = await Promise.all([fetchPlaylist(s), fetchSchedules(s)]);
    updatePlaylist(newPl);
    schedulesRef.current = sch;
    if (s?.current_media_id && newPl.length === 0) {
      const { data: mediaData } = await supabase.from("media").select("*").eq("id", s.current_media_id).single();
      if (mediaData) setMedia(mediaData as MediaData);
    }
    setCurrentIndex(0);
    resolveMedia(s, newPl, 0);
  }, [fetchPlaylist, fetchSchedules, resolveMedia, updatePlaylist]);

  return {
    screen, media, loading, sessionBlocked, forceTakeover,
    playlistLength: playlistRef.current.length, currentIndex, currentDuration,
    layoutId: screen?.layout_id ?? null,
  };
}
