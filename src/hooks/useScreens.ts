import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect } from "react";
import { useEstablishmentContext } from "@/contexts/EstablishmentContext";
import { useAuth } from "@/hooks/useAuth";

export function useScreens() {
  const queryClient = useQueryClient();
  const { currentEstablishmentId, isGlobalAdmin } = useEstablishmentContext();
  const { user } = useAuth();

  const { data: screens = [], isLoading } = useQuery({
    queryKey: ["screens", currentEstablishmentId, isGlobalAdmin],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      let query = supabase
        .from("screens")
        .select("*, media:current_media_id(id, name, type, url)")
        .order("created_at", { ascending: false });
      if (currentEstablishmentId) {
        query = query.eq("establishment_id", currentEstablishmentId);
      } else if (!isGlobalAdmin) {
        return [];
      }
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  // Real-time subscription
  useEffect(() => {
    const channelName = `screens-realtime-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "screens" }, () => {
        queryClient.invalidateQueries({ queryKey: ["screens"] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const addScreen = useMutation({
    mutationFn: async (name: string) => {
      // Check screen quota if linked to an establishment
      if (currentEstablishmentId) {
        const { data: establishment } = await supabase
          .from("establishments")
          .select("max_screens")
          .eq("id", currentEstablishmentId)
          .single();

        const { count } = await supabase
          .from("screens")
          .select("id", { count: "exact", head: true })
          .eq("establishment_id", currentEstablishmentId);

        const maxScreens = establishment?.max_screens ?? 0;
        if (maxScreens > 0 && (count ?? 0) >= maxScreens) {
          throw new Error(`Quota atteint : cet établissement est limité à ${maxScreens} écran(s).`);
        }
      }

      const slug = name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
      const { error } = await supabase.from("screens").insert({
        name,
        slug,
        user_id: user?.id ?? null,
        establishment_id: currentEstablishmentId,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["screens"] }),
  });

  const updateScreen = useMutation({
    mutationFn: async ({ id, ...updates }: { id: string; name?: string; slug?: string; orientation?: string; current_media_id?: string | null; status?: string; layout_id?: string | null; playlist_id?: string | null; program_id?: string | null; debug_mode?: number; resolution?: string }) => {
      const { error } = await supabase.from("screens").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["screens"] }),
  });

  const deleteScreen = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("screens").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["screens"] }),
  });

  return { screens, isLoading, addScreen, updateScreen, deleteScreen };
}
