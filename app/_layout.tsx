import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { supabase } from '../lib/supabase';

// Keep native token refresh tied to the foreground lifecycle.
// The SDK manages web refresh through its browser visibility listener.
export default function Layout() {
  useEffect(() => {
    if (Platform.OS === 'web' || !supabase) return;
    const auth = supabase.auth;
    // Refresh sessions while the user is active and release the background timer
    // when the OS suspends the app or the root layout is removed.
    function update(state: AppStateStatus) {
      if (state === 'active') void auth.startAutoRefresh();
      else void auth.stopAutoRefresh();
    }
    update(AppState.currentState);
    const listener = AppState.addEventListener('change', update);
    return () => { listener.remove(); void auth.stopAutoRefresh(); };
  }, []);
  return <><StatusBar style="dark"/><Stack screenOptions={{ headerShown: false }}/></>;
}
