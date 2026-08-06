import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { validateLocalEnvironment } from "@/lib/env";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Élément racine #root introuvable.");
}

try {
  validateLocalEnvironment();
  createRoot(rootElement).render(<App />);
} catch (error) {
  const message = error instanceof Error ? error.message : "Erreur de démarrage inconnue.";
  console.error("[startup]", error);
  createRoot(rootElement).render(
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <section className="w-full max-w-xl border border-destructive/30 bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Configuration du serveur incomplète</h1>
        <p className="mt-2 text-sm text-muted-foreground whitespace-pre-line">{message}</p>
        <p className="mt-4 text-sm">Relancez le déploiement complet afin de reconstruire l’application avec les paramètres du backend local.</p>
      </section>
    </main>,
  );
}
