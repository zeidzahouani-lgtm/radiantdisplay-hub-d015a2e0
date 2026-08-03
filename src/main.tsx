import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { validateLocalEnvironment } from "@/lib/env";

validateLocalEnvironment();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Élément racine #root introuvable.");
}

createRoot(rootElement).render(<App />);
