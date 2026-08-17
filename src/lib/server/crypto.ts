// AES-256-GCM helpers for at-rest encryption of small secrets.
// Layout: [12-byte nonce][16-byte tag][ciphertext]

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadConfig } from "./config";

function getKey(): Buffer {
  const cfg = loadConfig();
  if (!cfg.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY not configured");
  }
  const k = Buffer.from(cfg.ENCRYPTION_KEY, "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes");
  return k;
}

export function encrypt(plaintext: string | Buffer): Buffer {
  const key = getKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const pt = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(plaintext, "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]);
}

export function decrypt(blob: Buffer): Buffer {
  if (blob.length < 12 + 16) throw new Error("ciphertext too short");
  const key = getKey();
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptString(s: string): Buffer {
  return encrypt(s);
}

export function decryptString(blob: Buffer): string {
  return decrypt(blob).toString("utf8");
}
