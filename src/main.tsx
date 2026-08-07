import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { validateLocalEnvironment } from "@/lib/env";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Élément racine #root introuvable.");
}

type StartupBoundaryState = { error: Error | null };

class StartupBoundary extends Component<{ children: ReactNode }, StartupBoundaryState> {
  state: StartupBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StartupBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[startup-render]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <section className="w-full max-w-xl border border-destructive/30 bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">L’application n’a pas pu démarrer</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Rechargez la page. Si le problème persiste, relancez le déploiement depuis l’administration.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-destructive">
            {this.state.error.message}
          </pre>
        </section>
      </main>
    );
  }
}

try {
  validateLocalEnvironment();
  createRoot(rootElement).render(
    <StartupBoundary>
      <App />
    </StartupBoundary>,
  );
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
