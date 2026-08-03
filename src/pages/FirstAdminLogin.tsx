import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { buildAppUrl } from "@/lib/env";
import { toast } from "sonner";
import {
  ShieldCheck, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff, Building2, DatabaseZap, RefreshCw,
} from "lucide-react";

type BackendStatus = "checking" | "ready" | "blocked";

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug || `ecran-${Date.now()}`;
}

export default function FirstAdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("Mon organisation");
  const [screenName, setScreenName] = useState("Écran principal");
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");
  const [backendMessage, setBackendMessage] = useState("");
  const [checking, setChecking] = useState(true);

  const canSubmit = useMemo(
    () => email.trim().length > 3 && password.length >= 8 && organizationName.trim().length > 1 && screenName.trim().length > 1 && backendStatus === "ready" && !submitting,
    [backendStatus, email, organizationName, password, screenName, submitting],
  );

  const checkBackend = async () => {
    setChecking(true);
    setBackendStatus("checking");
    setBackendMessage("");
    try {
      const adminCheck = await supabase.functions.invoke("bootstrap-admin", { body: { action: "check" } });
      if (adminCheck.error) throw adminCheck.error;
      const adminExists = Boolean(adminCheck.data?.has_admin);
      setHasAdmin(adminExists);
      if (!adminExists) {
        const restoreCheck = await supabase.functions.invoke("restore-backup", { body: { tables: {}, mode: "upsert" } });
        if (restoreCheck.error) throw restoreCheck.error;
      }
      setBackendStatus("ready");
    } catch (e: any) {
      console.error(e);
      setHasAdmin(null);
      setBackendStatus("blocked");
      setBackendMessage(e?.message || "Les fonctions bootstrap-admin/restore-backup ne répondent pas.");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    (async () => {
      await checkBackend();
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (backendStatus !== "ready") {
      toast.error("Backend non joignable : impossible de créer l'admin.");
      return;
    }
    if (!email.trim() || !password) {
      toast.error("Renseignez l'email et le mot de passe.");
      return;
    }
    if (password.length < 8) {
      toast.error("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }

    setSubmitting(true);
    try {
      // 1. Sign up the user
      const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: buildAppUrl("/") },
      });

      // If user already exists, try sign-in to get its id
      let userId = signUp?.user?.id;
      if (signUpErr && /already|exist/i.test(signUpErr.message)) {
        const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInErr) throw new Error("Cet email existe déjà avec un autre mot de passe.");
        userId = signIn.user?.id;
      } else if (signUpErr) {
        throw signUpErr;
      }

      // 2. Promote to admin via the bootstrap edge function
      const { data: promo, error: promoErr } = await supabase.functions.invoke("bootstrap-admin", {
        body: { action: "promote", email: email.trim() },
      });
      if (promoErr) throw promoErr;
      if (promo?.error) throw new Error(promo.error);
      userId = promo?.user_id || userId;
      if (!userId) throw new Error("Utilisateur administrateur introuvable.");

      const { error: finalSignInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (finalSignInErr) throw finalSignInErr;

      const organization = organizationName.trim();
      const display = screenName.trim();
      const { data: establishment, error: establishmentError } = await supabase
        .from("establishments")
        .insert({ name: organization, created_by: userId, max_screens: 0 } as any)
        .select("id, name")
        .single();
      if (establishmentError) throw establishmentError;

      const { error: membershipError } = await supabase
        .from("user_establishments")
        .insert({ user_id: userId, establishment_id: establishment.id, role: "admin" } as any);
      if (membershipError) throw membershipError;

      const { error: screenError } = await supabase
        .from("screens")
        .insert({ name: display, slug: slugify(display), user_id: userId, establishment_id: establishment.id } as any);
      if (screenError) throw screenError;

      toast.success("Premier lancement terminé ✓");
      setHasAdmin(true);
      setTimeout(() => navigate("/", { replace: true }), 600);
    } catch (e: any) {
      toast.error(e?.message || "Erreur lors de la création du compte admin.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <Badge variant="outline" className="mx-auto gap-1.5">
            <DatabaseZap className="h-3.5 w-3.5" /> Premier lancement
          </Badge>
          <CardTitle>Initialiser l'application</CardTitle>
          <CardDescription>
            Vérification backend, création du premier admin, puis création du premier établissement et écran.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {checking || backendStatus === "checking" ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Vérification de bootstrap-admin et restore-backup…
            </div>
          ) : backendStatus === "blocked" ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Backend non joignable</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>L'étape admin est bloquée car les fonctions bootstrap-admin/restore-backup ne répondent pas.</p>
                <p className="text-xs">Consigne : relancez le déploiement SSH ou vérifiez que la route /functions/v1/ est bien proxyfiée vers le backend local, puis réessayez.</p>
                {backendMessage && <p className="text-xs opacity-90">Détail : {backendMessage}</p>}
                <Button type="button" variant="secondary" onClick={() => void checkBackend()} className="w-full gap-2">
                  <RefreshCw className="h-4 w-4" /> Revérifier
                </Button>
              </AlertDescription>
            </Alert>
          ) : hasAdmin ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>Un administrateur existe déjà</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>Cette page n'est plus disponible. Connectez-vous depuis l'écran de login.</p>
                <Button onClick={() => navigate("/login")} className="w-full">
                  Aller au login
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  Ce wizard s'affiche uniquement au premier lancement et se désactive automatiquement dès qu'un admin existe.
                </AlertDescription>
              </Alert>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email administrateur</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      placeholder="admin@exemple.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={submitting}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">Mot de passe</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPwd ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder="Min. 8 caractères"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={submitting}
                        required
                        minLength={8}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPwd((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                      >
                        {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="organization">Premier établissement</Label>
                    <Input id="organization" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} disabled={submitting} required />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="screen">Premier écran</Label>
                    <Input id="screen" value={screenName} onChange={(e) => setScreenName(e.target.value)} disabled={submitting} required />
                  </div>
                </div>

                <Button type="submit" className="w-full gap-2" disabled={!canSubmit}>
                  {submitting ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Initialisation…</>
                  ) : (
                    <><Building2 className="h-4 w-4" /> Créer l'admin et le premier établissement</>
                  )}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
