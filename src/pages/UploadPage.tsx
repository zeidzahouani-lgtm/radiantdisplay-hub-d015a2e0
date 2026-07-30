import { useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { explainSupabaseError } from "@/lib/env";
import { uploadMediaFile } from "@/lib/supabase-helpers";
import { toast } from "sonner";
import { Upload, Lock, CheckCircle, Loader2, Image as ImageIcon, Clock, CalendarDays, RotateCw, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function toLocalDatetime(date: Date): string {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

export default function UploadPage() {
  const { id: screenId } = useParams<{ id: string }>();
  const [step, setStep] = useState<"code" | "upload" | "done">("code");
  const [code, setCode] = useState("");
  const [userName, setUserName] = useState("");
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Schedule & orientation state
  const now = new Date();
  const defaultStart = toLocalDatetime(now);
  const defaultEnd = toLocalDatetime(new Date(now.getTime() + 60 * 60 * 1000));
  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [duration, setDuration] = useState("60"); // minutes shortcut
  const [orientation, setOrientation] = useState("landscape");

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setChecking(true);
    try {
      const { data, error } = await (supabase.from("access_codes") as any)
        .select("*")
        .eq("code", code.trim().toUpperCase())
        .eq("is_active", true)
        .single();
      if (error || !data) {
        toast.error("Code d'accès invalide ou désactivé");
      } else {
        setUserName(data.user_name);
        setStep("upload");
        toast.success(`Bienvenue ${data.user_name} !`);
      }
    } catch {
      toast.error("Erreur de vérification");
    } finally {
      setChecking(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const isImage = f.type.startsWith("image/");
    const isVideo = f.type.startsWith("video/");
    if (!isImage && !isVideo) {
      toast.error("Seules les images et vidéos sont acceptées");
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const isVideo = file?.type.startsWith("video/") ?? false;

  const handleDurationChange = (val: string) => {
    setDuration(val);
    if (val !== "custom") {
      const mins = parseInt(val);
      const start = new Date(startTime);
      const end = new Date(start.getTime() + mins * 60 * 1000);
      setEndTime(toLocalDatetime(end));
    }
  };

  const handleStartChange = (val: string) => {
    setStartTime(val);
    if (duration !== "custom") {
      const mins = parseInt(duration);
      const start = new Date(val);
      const end = new Date(start.getTime() + mins * 60 * 1000);
      setEndTime(toLocalDatetime(end));
    }
  };

  const handleUpload = async () => {
    if (!file || !screenId) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const publicUrl = await uploadMediaFile(file, setUploadProgress, "uploads");

      const start = new Date(startTime);
      const end = new Date(endTime);

      if (end <= start) {
        toast.error("La date de fin doit être après la date de début");
        setUploading(false);
        return;
      }

      const { error: contentError } = await (supabase.from("contents") as any).insert({
        image_url: publicUrl,
        title: `Upload de ${userName}`,
        status: "active",
        source: "qr_upload",
        screen_id: screenId,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        sender_email: null,
        metadata: { orientation, type: isVideo ? "video" : "image" },
      });

      if (contentError) throw contentError;

      const diffMs = end.getTime() - start.getTime();
      const diffMins = Math.round(diffMs / 60000);
      const label = diffMins >= 60 ? `${Math.round(diffMins / 60)}h${diffMins % 60 > 0 ? diffMins % 60 + "min" : ""}` : `${diffMins} minutes`;

      setStep("done");
      toast.success(`${isVideo ? "Vidéo" : "Image"} envoyée ! Elle sera diffusée pendant ${label}.`);
    } catch (err: any) {
      const diagnostic = explainSupabaseError(err, "Upload QR / storage uploads");
      toast.error(`Erreur: ${diagnostic.cause} — ${err.message || "Upload échoué"}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        {step === "code" && (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                <Lock className="h-8 w-8 text-primary" />
              </div>
              <CardTitle className="text-xl">Accès à l'écran</CardTitle>
              <CardDescription>Entrez votre code d'accès pour diffuser du contenu</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCodeSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label>Code d'accès</Label>
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="Entrez votre code"
                    className="text-center text-lg font-mono tracking-widest"
                    autoFocus
                    maxLength={20}
                  />
                </div>
                <Button type="submit" className="w-full gap-2" disabled={checking || !code.trim()}>
                  {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                  {checking ? "Vérification..." : "Valider"}
                </Button>
              </form>
            </CardContent>
          </>
        )}

        {step === "upload" && (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                <Upload className="h-8 w-8 text-primary" />
              </div>
              <CardTitle className="text-xl">Envoyer du contenu</CardTitle>
              <CardDescription>Bonjour {userName} ! Envoyez une image ou une vidéo.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Image picker */}
              <input ref={fileRef} type="file" accept="image/*,video/*" onChange={handleFileChange} className="hidden" />
              {preview ? (
                <div className="relative group">
                  {isVideo ? (
                    <video src={preview} className="w-full h-40 object-cover rounded-lg border border-border" muted playsInline />
                  ) : (
                    <img src={preview} alt="Preview" className="w-full h-40 object-cover rounded-lg border border-border" />
                  )}
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center"
                  >
                    <span className="text-white text-sm font-medium">Changer le fichier</span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-full h-40 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center gap-3 hover:border-primary/50 hover:bg-primary/5 transition-colors"
                >
                  <div className="flex gap-2">
                    <ImageIcon className="h-8 w-8 text-muted-foreground" />
                    <Video className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <span className="text-sm text-muted-foreground">Cliquez pour sélectionner une image ou vidéo</span>
                </button>
              )}

              {/* Orientation */}
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <RotateCw className="h-3.5 w-3.5" /> Orientation
                </Label>
                <Select value={orientation} onValueChange={setOrientation}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="landscape">Paysage (0°)</SelectItem>
                    <SelectItem value="portrait">Portrait (90°)</SelectItem>
                    <SelectItem value="landscape-flipped">Paysage inversé (180°)</SelectItem>
                    <SelectItem value="portrait-flipped">Portrait inversé (270°)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Duration shortcut */}
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <CalendarDays className="h-3.5 w-3.5" /> Durée de diffusion
                </Label>
                <Select value={duration} onValueChange={handleDurationChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 minutes</SelectItem>
                    <SelectItem value="30">30 minutes</SelectItem>
                    <SelectItem value="60">1 heure</SelectItem>
                    <SelectItem value="120">2 heures</SelectItem>
                    <SelectItem value="480">8 heures (journée)</SelectItem>
                    <SelectItem value="1440">24 heures</SelectItem>
                    <SelectItem value="custom">Personnalisé</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Start / End times */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5 text-xs">
                    <Clock className="h-3 w-3" /> Début
                  </Label>
                  <Input type="datetime-local" value={startTime} onChange={e => handleStartChange(e.target.value)} className="text-xs" />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5 text-xs">
                    <Clock className="h-3 w-3" /> Fin
                  </Label>
                  <Input
                    type="datetime-local"
                    value={endTime}
                    onChange={e => { setEndTime(e.target.value); setDuration("custom"); }}
                    className="text-xs"
                  />
                </div>
              </div>

              {uploading && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Upload en cours…</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              <Button onClick={handleUpload} className="w-full gap-2" disabled={!file || uploading}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? `Envoi ${uploadProgress}%` : `Diffuser ${isVideo ? "la vidéo" : "l'image"}`}
              </Button>
            </CardContent>
          </>
        )}

        {step === "done" && (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto h-16 w-16 rounded-2xl bg-green-500/10 flex items-center justify-center mb-3">
                <CheckCircle className="h-8 w-8 text-green-500" />
              </div>
              <CardTitle className="text-xl">Contenu envoyé !</CardTitle>
              <CardDescription>Votre contenu sera diffusé sur cet écran selon vos paramètres.</CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              {preview && (
                isVideo ? (
                  <video src={preview} className="w-full h-40 object-cover rounded-lg border border-border mb-4" muted playsInline />
                ) : (
                  <img src={preview} alt="Uploaded" className="w-full h-40 object-cover rounded-lg border border-border mb-4" />
                )
              )}
              <Button
                variant="outline"
                onClick={() => { setStep("upload"); setFile(null); setPreview(null); }}
                className="gap-2"
              >
                <Upload className="h-4 w-4" />
                Envoyer un autre contenu
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
