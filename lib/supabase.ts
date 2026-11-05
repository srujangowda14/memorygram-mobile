import 'react-native-url-polyfill/auto';
import './nativeCrypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const key = (process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY)?.trim();

// A fresh checkout can open the demo before its owner connects Supabase.
// The SDK otherwise throws during application startup if the URL is absent.
export const supabase = url && /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(url) && key
  ? createClient(url, key, {
      auth: {
        flowType: 'pkce',
        storage: Platform.OS === 'web' ? undefined : AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;
