import { Navigate, Route, Routes } from "react-router-dom";
import AppHeader from "./components/AppHeader";
import CreatorDashboardPage from "./pages/CreatorDashboardPage";
import LoginPage from "./pages/LoginPage";
import StationManagerPage from "./pages/StationManagerPage";
import StationPreviewPage from "./pages/StationPreviewPage";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppHeader />
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
