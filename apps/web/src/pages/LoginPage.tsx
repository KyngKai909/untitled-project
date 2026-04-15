import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { connectWallet, disconnectWallet, formatWalletAddress, getStoredWalletAddress } from "../wallet";

export default function LoginPage() {
  const navigate = useNavigate();
  const [wallet, setWallet] = useState<string | null>(() => getStoredWalletAddress());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConnectWallet() {
    setConnecting(true);
    setError(null);

    try {
      const connected = await connectWallet();
      setWallet(connected);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed");
    } finally {
      setConnecting(false);
    }
  }

  function onDisconnectWallet() {
    disconnectWallet();
    setWallet(null);
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-56px)] w-full max-w-7xl items-center px-4 py-8">
      <div className="grid w-full gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Creator Login</CardTitle>
            <CardDescription>
              Connect your wallet to open the creator dashboard. Your wallet is used as the owner identity.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {error ? (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
                {error}
              </div>
            ) : null}
            {wallet ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Connected wallet: <span className="font-medium text-white">{formatWalletAddress(wallet)}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => navigate("/dashboard")}>Continue to Dashboard</Button>
                  <Button variant="outline" onClick={onDisconnectWallet}>
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={() => void onConnectWallet()} disabled={connecting}>
                {connecting ? "Connecting..." : "Connect Wallet"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Core Workflow</CardTitle>
            <CardDescription>OpenCast now focuses on the creator core flow.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
              <li>Upload into your global creator library.</li>
              <li>Create and configure stations.</li>
              <li>Build and reorder station playlists.</li>
              <li>Schedule runtime windows or run 24/7.</li>
              <li>Go live via Livepeer output.</li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
