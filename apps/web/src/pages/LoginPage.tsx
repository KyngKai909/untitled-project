import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AppIcon from "../components/AppIcon";
import { connectWallet, disconnectWallet, formatWalletAddress, getStoredWalletAddress } from "../wallet";

type AuthMode = "login" | "signup";

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("login");
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

  const heading = mode === "login" ? "Sign in to OpenCast Core" : "Create your operator account";
  const subheading =
    mode === "login"
      ? "Use Reown wallet access to enter your workspace and resume station operations."
      : "Set up your creator identity with wallet-first access for station, runtime, and ad workflows.";

  return (
    <main className="authShell">
      <header className="authTopbar">
        <div className="authTopbar__inner">
          <div className="brandLockup authBrand" aria-label="OpenCast Core">
            <span className="brandLockup__glyph" aria-hidden />
            <span className="brandLockup__title">OpenCast Core</span>
            <span className="brandLockup__subtitle">Live Channel Operations</span>
          </div>
          <button className="uiButton uiButton--ghost" type="button" disabled>
            <AppIcon name="arrow-left" />
            Back
          </button>
        </div>
      </header>

      <section className="authLayout">
        <section className="authIntro">
          <div className="authIntro__top">
            <div className="pageBanner__meta">
              <span className="miniTag miniTag--accent">Wallet Auth</span>
              <span className="miniTag">Reown-ready</span>
            </div>
            <h1>Operator access with a traditional sign-in flow and wallet-native auth methods.</h1>
            <p>
              Start with Reown AppKit now, then expand to smart wallet onboarding and multi-wallet account linking.
            </p>
          </div>
          <div className="authSignal">
            <article>
              <h4>Primary Method</h4>
              <p>Reown AppKit</p>
            </article>
            <article>
              <h4>Session Type</h4>
              <p>{wallet ? "Authorized" : "Not Connected"}</p>
            </article>
            <article>
              <h4>Workspace Mode</h4>
              <p>Creator Operations</p>
            </article>
          </div>
        </section>

        <section className="authPanel">
          <div className="authModeSwitch" role="tablist" aria-label="Authentication Mode">
            <button type="button" data-active={mode === "login"} onClick={() => setMode("login")}>
              Log In
            </button>
            <button type="button" data-active={mode === "signup"} onClick={() => setMode("signup")}>
              Sign Up
            </button>
          </div>

          <header className="authPanel__head">
            <div>
              <h2>{heading}</h2>
              <p>{subheading}</p>
            </div>
          </header>

          {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}

          <div className="authMethods">
            <button className="authMethod authMethod--active" type="button" onClick={() => void onConnectWallet()} disabled={connecting || Boolean(wallet)}>
              <span className="authMethod__icon">
                <AppIcon name="wallet" />
              </span>
              <span className="authMethod__content">
                <span className="authMethod__label">{connecting ? "Connecting Wallet..." : wallet ? "Wallet Connected" : "Continue with Reown AppKit"}</span>
                <span className="authMethod__meta">Injected wallet · production ready</span>
              </span>
            </button>
            <button className="authMethod" type="button" disabled>
              <span className="authMethod__icon">
                <AppIcon name="zap" />
              </span>
              <span className="authMethod__content">
                <span className="authMethod__label">Continue with Smart Wallet</span>
                <span className="authMethod__meta">Email or passkey onboarding · coming soon</span>
              </span>
            </button>
            <button className="authMethod" type="button" disabled>
              <span className="authMethod__icon">
                <AppIcon name="monitor" />
              </span>
              <span className="authMethod__content">
                <span className="authMethod__label">Continue with External Wallet</span>
                <span className="authMethod__meta">WalletConnect + mobile deep links · coming soon</span>
              </span>
            </button>
          </div>

          <p className="authHint">No passwords stored. Wallet signature confirms access to your operator workspace.</p>

          <div className="authSession">
            {wallet ? (
              <>
                <p className="metaLine">
                  <span className="statusPill statusPill--live">Authorized</span>
                  <span>{formatWalletAddress(wallet)}</span>
                </p>
                <div className="pageBanner__actions">
                  <button className="uiButton uiButton--accent" type="button" onClick={() => navigate("/dashboard")}>
                    <AppIcon name="home" />
                    Enter Workspace
                  </button>
                  <button className="uiButton uiButton--danger" type="button" onClick={onDisconnectWallet}>
                    <AppIcon name="close" />
                    Disconnect Wallet
                  </button>
                </div>
              </>
            ) : (
              <p className="emptyState">Connect a wallet method above to unlock stations, playlist, and runtime controls.</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
