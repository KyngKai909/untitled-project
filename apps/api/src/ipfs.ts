import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { PINATA_GATEWAY_BASE, PINATA_JWT, PINATA_NETWORK, PINATA_UPLOAD_URL } from "./config.js";

export interface IpfsPinResult {
  cid: string;
  url: string;
}

interface PinataUploadResponse {
  data?: {
    cid?: string;
  };
  [key: string]: unknown;
}

export function hasPinataJwt(): boolean {
  return Boolean(PINATA_JWT.trim());
}

export async function uploadFileToIpfs(filePath: string, name: string): Promise<IpfsPinResult> {
  const jwt = PINATA_JWT.trim();
  if (!jwt) {
    throw new Error("PINATA_JWT is not configured.");
  }

  const fileName = path.basename(filePath);
  const fileBlob = await openFileBlob(filePath);
  const form = new FormData();

  form.set("network", PINATA_NETWORK);
  form.set("name", name || fileName);
  form.set("file", fileBlob, fileName);

  const response = await fetch(PINATA_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`
    },
    body: form
  });

  const payload = (await response.json().catch(() => ({}))) as PinataUploadResponse;
  if (!response.ok) {
    throw new Error(`Pinata upload failed (${response.status}): ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const cid = payload?.data?.cid;
  if (!cid) {
    throw new Error("Pinata upload did not return a CID.");
  }

  const gatewayBase = PINATA_GATEWAY_BASE.replace(/\/+$/, "");
  const url = gatewayBase.endsWith("/ipfs") ? `${gatewayBase}/${cid}` : `${gatewayBase}/ipfs/${cid}`;

  return { cid, url };
}

async function openFileBlob(filePath: string): Promise<Blob> {
  const fsWithBlob = fs as typeof fs & {
    openAsBlob?: (path: string, options?: { type?: string }) => Promise<Blob>;
  };

  if (typeof fsWithBlob.openAsBlob === "function") {
    return fsWithBlob.openAsBlob(filePath);
  }

  const buffer = await fsPromises.readFile(filePath);
  return new Blob([buffer]);
}
