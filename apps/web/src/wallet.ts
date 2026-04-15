const WALLET_STORAGE_KEY = "openchannel.creator.wallet.v1";

function normalizeWalletAddress(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function readStoredWallet(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return normalizeWalletAddress(window.localStorage.getItem(WALLET_STORAGE_KEY));
}

function writeStoredWallet(address: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!address) {
    window.localStorage.removeItem(WALLET_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(WALLET_STORAGE_KEY, address);
}

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
}

function getEthereumProvider(): EthereumProvider | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  if (!candidate || typeof candidate.request !== "function") {
    return null;
  }

  return candidate;
}

export function getStoredWalletAddress(): string | null {
  return readStoredWallet();
}

export function disconnectWallet(): void {
  writeStoredWallet(null);
}

export async function connectWallet(): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error("No injected wallet found. Install MetaMask or open in a wallet-enabled browser.");
  }

  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error("Wallet connection was canceled.");
  }

  const first = normalizeWalletAddress(String(accounts[0]));
  if (!first) {
    throw new Error("Connected wallet address is invalid.");
  }

  writeStoredWallet(first);
  return first;
}

export function formatWalletAddress(wallet: string): string {
  if (wallet.length < 10) {
    return wallet;
  }
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}
