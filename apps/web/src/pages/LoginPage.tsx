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
    <main className="routeFrame">
      <section className="pageBanner">
        <div className="pageBanner__meta">
          <span className="miniTag miniTag--accent">Creator Access</span>
          <span className="miniTag">Wallet-gated auth</span>
        </div>
        <h1>OpenCast runs as an operator workspace, not a prototype dashboard.</h1>
        <p>
          Authenticate with your wallet to open the production workspace for station management, runtime orchestration,
          and live output control.
        </p>
        <div className="pageBanner__actions">
          <button className="uiButton uiButton--accent" type="button" onClick={() => void onConnectWallet()} disabled={connecting || Boolean(wallet)}>
            {connecting ? "Connecting" : wallet ? "Connected" : "Connect Wallet"}
          </button>
          <button className="uiButton uiButton--secondary" type="button" onClick={() => navigate("/dashboard")}>
            Enter Workspace
          </button>
        </div>
      </section>

      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}

      <div className="previewGrid">
        <section className="previewMain">
          <header className="paneHead">
            <div>
              <h2>Operational Loop</h2>
              <p>From media ingestion to live playout, this flow is optimized for repeatable daily use.</p>
            </div>
          </header>
          <div className="paneBody">
            <div className="dataTable">
              <article className="dataRow">
                <div>
                  <p className="dataRow__title">1. Library ingestion</p>
                  <p className="dataRow__meta">Upload once to wallet scope and reuse assets across stations.</p>
                </div>
              </article>
              <article className="dataRow">
                <div>
                  <p className="dataRow__title">2. Station composition</p>
                  <p className="dataRow__meta">Assemble queues, import sponsor units, and define insertion cadence.</p>
                </div>
              </article>
              <article className="dataRow">
                <div>
                  <p className="dataRow__title">3. Runtime control</p>
                  <p className="dataRow__meta">Schedule windows, route output, and monitor now/next timeline.</p>
                </div>
              </article>
            </div>
          </div>
        </section>

        <aside className="previewRail">
          <header className="paneHead">
            <div>
              <h2>Session Status</h2>
              <p>Current wallet authorization state.</p>
            </div>
          </header>
          <div className="paneBody">
            {wallet ? (
              <>
                <p className="metaLine">
                  <span className="statusPill statusPill--live">Authorized</span>
                  <span>{formatWalletAddress(wallet)}</span>
                </p>
                <div className="pageBanner__actions">
                  <button className="uiButton uiButton--accent" type="button" onClick={() => navigate("/dashboard")}>
                    Continue
                  </button>
                  <button className="uiButton uiButton--danger" type="button" onClick={onDisconnectWallet}>
                    Disconnect
                  </button>
                </div>
              </>
            ) : (
              <p className="emptyState">No wallet connected. Authenticate to unlock station controls.</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
