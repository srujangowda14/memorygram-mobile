import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Linking from 'expo-linking';
import * as Apple from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { supabase } from './supabase';

export type Provider = 'apple' | 'google';
const mobileCallback = 'memorygram:///auth/callback';
let lastExchange: { code: string; result: Promise<void> } | undefined;

// The system browser and Expo Router may deliver the same one-time code.
// Share its result across both handlers, including a resumed or cold-started app.
export function completeOAuth(code: string, flowId?: string): Promise<void> {
  if (lastExchange?.code === code) return lastExchange.result;
  if (!supabase || !code) return Promise.reject(new Error('Start sign-in again.'));
  const result = supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)
    .then(({ data, error }) => {
      if (error || !data.session) throw new Error('This sign-in link expired. Please try again.');
    });
  lastExchange = { code, result };
  return result;
}

// Start native Apple sign-in on iOS and bind the returned identity token
// to this request with a random nonce. Other providers use a browser return link.
export async function signIn(provider: Provider) {
  if (!supabase) throw new Error('Connect Supabase to enable sign-in.');
  if (provider === 'apple' && Platform.OS === 'ios' && await Apple.isAvailableAsync()) {
    const nonce = Crypto.randomUUID();
    const credential = await Apple.signInAsync({
      nonce: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce),
      requestedScopes: [Apple.AppleAuthenticationScope.EMAIL],
    });
    if (!credential.identityToken) throw new Error('Apple did not return an identity token.');
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider, token: credential.identityToken, nonce,
    });
    if (error || !data.session) throw new Error('Apple sign-in failed. Please try again.');
    return;
  }

  const redirectTo = Platform.OS === 'web' ? window.location.origin + '/auth/callback' :
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient ? Linking.createURL('auth/callback') : mobileCallback;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider, options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw new Error('Could not start sign-in. Please try again.');
  if (new URL(data.url).searchParams.get('code_challenge_method')?.toLowerCase() !== 's256') {
    throw new Error('Open Memorygram in its installed app or a secure browser window.');
  }
  if (Platform.OS === 'web') {
    window.location.assign(data.url);
    return;
  }
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return;
  const returned = new URL(result.url);
  const code = returned.searchParams.get('code');
  if (result.url.split(/[?#]/)[0] !== redirectTo || returned.searchParams.has('error') || !code) {
    throw new Error('Sign-in was not completed. Please try again.');
  }
  await completeOAuth(code, returned.searchParams.get('sb_flow_id') ?? undefined);
}
