import { Navigate, Route, Routes, useParams } from "react-router-dom";
import AppHeader from "./components/AppHeader";
import HomePage from "./pages/HomePage";
import StudioDashboardPage from "./pages/StudioDashboardPage";
import StudioPage from "./pages/StudioPage";
import WatchPage from "./pages/WatchPage";

function LegacyWatchRedirect() {
  const { channelId } = useParams();
  return <Navigate to={channelId ? `/station/${channelId}` : "/"} replace />;
}

export default function App() {
  return (
    <div className="appShell">
      <AppHeader />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/explore" element={<Navigate to="/" replace />} />
        <Route path="/station/:channelId" element={<WatchPage />} />
        <Route path="/watch/:channelId" element={<LegacyWatchRedirect />} />
        <Route path="/studio" element={<StudioDashboardPage />} />
        <Route path="/studio/:channelId" element={<StudioPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
