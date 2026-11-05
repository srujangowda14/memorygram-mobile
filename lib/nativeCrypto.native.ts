import { digest, getRandomValues } from 'expo-crypto';
import { fromByteArray } from 'base64-js';

// Supply the Web Crypto operations used by the Supabase SDK on Hermes.
// Expo performs the random-byte generation and SHA-256 digest on the device.
const cryptoAPI = globalThis.crypto ?? Object.defineProperty(globalThis, 'crypto', {
  value: {}, configurable: true,
}).crypto;
if (!cryptoAPI.getRandomValues) Object.assign(cryptoAPI, { getRandomValues });
if (!cryptoAPI.subtle) Object.assign(cryptoAPI, { subtle: { digest } });
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (raw) => fromByteArray(Uint8Array.from(raw, char => char.charCodeAt(0)));
}
