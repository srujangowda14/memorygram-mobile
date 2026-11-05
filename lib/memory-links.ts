import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const returnKey = 'memorygram:login-memory';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only accept an opaque memory ID from an external link. No arbitrary
// return URL or permission is carried through the sign-in flow.
export function validMemoryId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

// Use the Expo web deployment when configured, otherwise the installed
// app's scheme on mobile and the current origin on web. Share only the ID.
export function memoryLink(id: string, demo: boolean) {
  if (!validMemoryId(id)) throw new Error('Invalid memory');
  const configured = process.env.EXPO_PUBLIC_APP_ORIGIN?.trim();
  const origin = configured && /^https:\/\/[a-z\d.-]+(:\d+)?\/?$/i.test(configured)
    ? configured.replace(/\/$/, '') : Platform.OS === 'web' ? window.location.origin : 'memorygram://';
  return origin + '/?memory=' + id + (demo ? '&demo=1' : '');
}

// Remember the requested memory across the provider's browser redirect.
// An ordinary sign-in clears any abandoned previous destination.
export async function rememberMemory(id?: string) {
  if (validMemoryId(id)) await AsyncStorage.setItem(returnKey, JSON.stringify({ id, at: Date.now() }));
  else await AsyncStorage.removeItem(returnKey);
}

// Consume the destination once and bound how long an abandoned sign-in
// can affect a later callback. The memory route still checks its audience.
export async function consumeMemory(): Promise<string | undefined> {
  const saved = await AsyncStorage.getItem(returnKey);
  await AsyncStorage.removeItem(returnKey);
  if (!saved) return;
  try {
    const { id, at } = JSON.parse(saved);
    if (validMemoryId(id) && Date.now() - at < 30 * 60_000) return id;
  } catch { /* Ignore obsolete local state. */ }
}
