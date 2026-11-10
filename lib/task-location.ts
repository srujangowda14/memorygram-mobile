import * as Location from 'expo-location';
import { Platform } from 'react-native';
import settlements from './data/populated-places.json';

export const contexts = {
  anywhere: 'Anywhere', morning: 'Local morning', afternoon: 'Local afternoon', evening: 'Local evening or night',
  crissy: 'Crissy Field, San Francisco', mall: 'Reflecting Pool, Washington, DC', cubbon: 'Cubbon Park, Bengaluru',
};
export type PlaceContext = keyof typeof contexts;
export type TaskPlace = { key: PlaceContext } | { key: 'locality'; name: string };
const places = [
  { key: 'crissy', latitude: 37.8060, longitude: -122.4517 },
  { key: 'mall', latitude: 38.8893, longitude: -77.0502 },
  { key: 'cubbon', latitude: 12.97436, longitude: 77.59388 },
] as const;

// Prefer a landmark within 2.5 km, then the nearest mapped town within 8 km.
// Include reported uncertainty in both radii. No lookup leaves the device.
export function contextForLocation(latitude: number, longitude: number, accuracy: number | null, date = new Date()): TaskPlace {
  const eastScale = 111_320 * Math.cos(latitude * Math.PI / 180);
  const uncertainty = accuracy ?? Infinity;
  for (const place of places) {
    const north = (latitude - place.latitude) * 111_320;
    const east = (longitude - place.longitude) * eastScale;
    if (Math.hypot(north, east) + uncertainty <= 2500) return { key: place.key };
  }
  let nearest = '';
  let limit = 8000 - uncertainty;
  for (const [lat, lon, name] of settlements as [number, number, string][]) {
    const north = (latitude - lat) * 111_320;
    if (Math.abs(north) > limit) continue;
    const east = (((longitude - lon + 540) % 360) - 180) * eastScale;
    const distance = Math.hypot(north, east);
    if (distance <= limit) { nearest = name; limit = distance; }
  }
  if (nearest) return { key: 'locality', name: nearest };
  const hour = (date.getUTCHours() + date.getUTCMinutes() / 60 + longitude / 15 + 24) % 24;
  if (hour >= 5 && hour < 12) return { key: 'morning' };
  if (hour >= 12 && hour < 18) return { key: 'afternoon' };
  return { key: 'evening' };
}

// Ask only after the user taps the location control. A single foreground
// reading is reduced on the device before any data reaches the room store.
export async function suggestContext(): Promise<TaskPlace> {
  if (Platform.OS === 'web') {
    const coords = await new Promise<GeolocationCoordinates>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(p => resolve(p.coords), reject,
        { maximumAge: 0, timeout: 12000, enableHighAccuracy: false });
    });
    return contextForLocation(coords.latitude, coords.longitude, coords.accuracy);
  }
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) throw new Error('Location is unavailable. Enable location access for this app in Settings, then retry.');
  if (!await Location.hasServicesEnabledAsync()) throw new Error('Location Services are off. Turn them on in Settings, then retry.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Location timed out. Move near a window or try again.')), 16000);
    });
    const { coords } = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), timeout]);
    const place = contextForLocation(coords.latitude, coords.longitude, coords.accuracy);
    if (place.key === 'locality' || ['crissy','mall','cubbon'].includes(place.key)) return place;
    try {
      const [address] = await Promise.race([Location.reverseGeocodeAsync(coords), timeout]);
      const name = (address?.city || address?.district)?.trim();
      if (name && name.length<=80) return { key:'locality', name };
    } catch { /* The offline time cue remains available without a city lookup. */ }
    return place;
  } finally { clearTimeout(timer); }
}
