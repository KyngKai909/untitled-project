import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
    <main className="page">
      <section className="pageHero">
        <div className="pageHero__meta">
          <span className="microTag" data-tone="accent">
            Creator Access
          </span>
          <span className="microTag">Wallet-gated dashboard</span>
        </div>
        <h1>Run your channel operations from one control surface.</h1>
        <p>
          Connect your wallet to manage global media library, station orchestration, runtime schedules, and live playout.
          The interface is designed for daily operations, not demos.
        </p>
        <div className="pageHero__actions">
          <button className="button" type="button" onClick={() => void onConnectWallet()} disabled={connecting || Boolean(wallet)}>
            {connecting ? "Connecting" : wallet ? "Wallet Connected" : "Connect Wallet"}
          </button>
          <button className="button" data-variant="secondary" type="button" onClick={() => navigate("/dashboard")}>
            Open Dashboard
          </button>
        </div>
      </section>

      {error ? (
        <div className="alert" data-tone="error">
          {error}
        </div>
      ) : null}

      <div className="grid2">
        <section className="section">
          <header className="section__head">
            <div>
              <h2>Access State</h2>
              <p>Session is tied to your wallet address. Disconnect at any time.</p>
            </div>
          </header>
          <div className="section__body">
            {wallet ? (
              <>
                <p className="metaLine">
                  <span className="badge" data-tone="live">
                    Authorized
                  </span>
                  <span>{formatWalletAddress(wallet)}</span>
                </p>
                <div className="pageHero__actions">
                  <button className="button" data-variant="accent" type="button" onClick={() => navigate("/dashboard")}>
                    Continue to Dashboard
                  </button>
                  <button className="button" data-variant="danger" type="button" onClick={onDisconnectWallet}>
                    Disconnect
                  </button>
                </div>
              </>
            ) : (
              <p className="empty">No wallet connected. Use the primary action above to authenticate.</p>
            )}
          </div>
        </section>

        <section className="section">
          <header className="section__head">
            <div>
              <h2>Operating Flow</h2>
              <p>Core production workflow for creators and ops teams.</p>
            </div>
          </header>
          <div className="section__body">
            <div className="list">
              <div className="row">
                <div>
                  <p className="row__title">1. Build global media library</p>
                  <p className="row__meta">Upload once and reuse across multiple stations.</p>
                </div>
              </div>
              <div className="row">
                <div>
                  <p className="row__title">2. Configure stations</p>
                  <p className="row__meta">Set stream mode, queue logic, ad injection rules, and branding metadata.</p>
                </div>
              </div>
              <div className="row">
                <div>
                  <p className="row__title">3. Control runtime and live state</p>
                  <p className="row__meta">Schedule windows, go live instantly, and monitor now/next timeline.</p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
