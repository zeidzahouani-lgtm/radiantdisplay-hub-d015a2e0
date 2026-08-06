import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import { explainSupabaseError, getAppBasePath } from "@/lib/env";
import { useAuth } from "@/hooks/useAuth";

import { DashboardLayout } from "@/components/DashboardLayout";
import { useAppSettings } from "@/hooks/useAppSettings";
import { EstablishmentProvider } from "@/contexts/EstablishmentContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";

const Player = lazy(() => import("./pages/Player"));
const Register = lazy(() => import("./pages/Register"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const PublicManual = lazy(() => import("./pages/PublicManual"));
const DashboardHome = lazy(() => import("./pages/DashboardHome"));
const Displays = lazy(() => import("./pages/Displays"));
const Library = lazy(() => import("./pages/Library"));
const Playlists = lazy(() => import("./pages/Playlists"));
const Schedules = lazy(() => import("./pages/Schedules"));
const Layouts = lazy(() => import("./pages/Layouts"));
const LayoutEditor = lazy(() => import("./pages/LayoutEditor"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));
const Establishments = lazy(() => import("./pages/Establishments"));
const ScreenSetup = lazy(() => import("./pages/ScreenSetup"));
const AdminCustomization = lazy(() => import("./pages/AdminCustomization"));
const AdminLicenses = lazy(() => import("./pages/AdminLicenses"));
const AIAssistant = lazy(() => import("./pages/AIAssistant"));
const AutoFlow = lazy(() => import("./pages/AutoFlow"));
const AdminEmail = lazy(() => import("./pages/AdminEmail"));
const AdminRequests = lazy(() => import("./pages/AdminRequests"));
const UploadPage = lazy(() => import("./pages/UploadPage"));
const EstablishmentSettings = lazy(() => import("./pages/EstablishmentSettings"));
const Resources = lazy(() => import("./pages/Resources"));
const AdminStats = lazy(() => import("./pages/AdminStats"));
const AssignLicense = lazy(() => import("./pages/AssignLicense"));
const Team = lazy(() => import("./pages/Team"));
const AdminBackup = lazy(() => import("./pages/AdminBackup"));
const AdminServerStatus = lazy(() => import("./pages/AdminServerStatus"));
const AdminHealth = lazy(() => import("./pages/AdminHealth"));
const AdminDockerNetwork = lazy(() => import("./pages/AdminDockerNetwork"));
const FirstAdminLogin = lazy(() => import("./pages/FirstAdminLogin"));

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => explainSupabaseError(error, `Query ${query.queryHash}`),
  }),
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-background flex items-center justify-center"><div className="animate-pulse text-muted-foreground">Chargement...</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-background flex items-center justify-center"><div className="animate-pulse text-muted-foreground">Chargement...</div></div>;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  useAppSettings();
  return <>{children}</>;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
    <TooltipProvider>
      <AppSettingsProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter basename={getAppBasePath()}>
          <Suspense fallback={<div className="min-h-screen bg-background flex items-center justify-center"><div className="animate-pulse text-muted-foreground">Chargement...</div></div>}>
            <Routes>
              <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
              <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
              <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
              <Route path="/manual" element={<PublicManual />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/player/:id" element={<Player />} />
              <Route path="/upload/:id" element={<UploadPage />} />
              <Route path="/assign-license/:screenId" element={<ProtectedRoute><AssignLicense /></ProtectedRoute>} />
              <Route path="/admin/first-login" element={<PublicRoute><FirstAdminLogin /></PublicRoute>} />

              <Route element={<ProtectedRoute><EstablishmentProvider><DashboardLayout /></EstablishmentProvider></ProtectedRoute>}>
                <Route path="/" element={<DashboardHome />} />
                <Route path="/displays" element={<Displays />} />
                <Route path="/library" element={<Library />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/schedules" element={<Schedules />} />
                <Route path="/layouts" element={<Layouts />} />
                <Route path="/layouts/:id" element={<LayoutEditor />} />
                <Route path="/admin/users" element={<AdminUsers />} />
                <Route path="/admin/establishments" element={<Establishments />} />
                <Route path="/admin/customization" element={<AdminCustomization />} />
                <Route path="/admin/licenses" element={<AdminLicenses />} />
                <Route path="/admin/email" element={<AdminEmail />} />
                <Route path="/admin/requests" element={<AdminRequests />} />
                <Route path="/admin/establishment-settings" element={<EstablishmentSettings />} />
                <Route path="/admin/resources" element={<Resources />} />
                <Route path="/admin/stats" element={<AdminStats />} />
                <Route path="/team" element={<Team />} />
                <Route path="/admin/backup" element={<AdminBackup />} />
                <Route path="/admin/server-status" element={<AdminServerStatus />} />
                <Route path="/admin/health" element={<AdminHealth />} />
                <Route path="/admin/docker-network" element={<AdminDockerNetwork />} />
                <Route path="/setup" element={<ScreenSetup />} />
                <Route path="/ai-assistant" element={<AIAssistant />} />
                <Route path="/auto-flow" element={<AutoFlow />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AppSettingsProvider>
    </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
