import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppHeader from "./components/AppHeader";
import CreatorDashboardPage from "./pages/CreatorDashboardPage";
import LoginPage from "./pages/LoginPage";
import StationManagerPage from "./pages/StationManagerPage";
import StationPreviewPage from "./pages/StationPreviewPage";

const THEME_STORAGE_KEY = "opencast-core-theme";

function readInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") {
    return "dark";
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" ? "light" : "dark";
}

export default function App() {
  const location = useLocation();
  const [theme, setTheme] = useState<"light" | "dark">(() => readInitialTheme());
  const isAuthRoute = location.pathname === "/";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  return (
    <div className="appRoot">
      {!isAuthRoute ? (
        <AppHeader
          theme={theme}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />
      ) : null}
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/dashboard" element={<CreatorDashboardPage />} />
        <Route path="/studio" element={<Navigate to="/dashboard" replace />} />
        <Route path="/stations/:channelId" element={<StationManagerPage />} />
        <Route path="/stations/:channelId/preview" element={<StationPreviewPage />} />
        <Route path="/station/:channelId" element={<StationPreviewPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
