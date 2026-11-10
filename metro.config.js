const { createHash } = require('node:crypto');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Expo inlines public config into release bundles. Keep cached transforms
// separate when switching between the guest demo, fixture and connected project.
const authConfig = [
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  process.env.EXPO_PUBLIC_APP_ORIGIN,
  process.env.EXPO_PUBLIC_SERVICE_URL,
];
config.cacheVersion += createHash('sha256').update(JSON.stringify(authConfig)).digest('hex');
module.exports = config;
