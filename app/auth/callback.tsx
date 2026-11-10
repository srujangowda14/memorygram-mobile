import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Button, Text, View } from 'react-native';
import { completeOAuth } from '../../lib/auth';
import { consumeMemory } from '../../lib/memory-links';

// Handle a provider return on the web or when the OS reopens the native app.
// Replace the callback route once the session is stored, keeping codes out of history.
export default function Callback() {
  const { code, error, sb_flow_id: flowId } = useLocalSearchParams();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (error || typeof code !== 'string') return;
    completeOAuth(code, typeof flowId === 'string' ? flowId : undefined)
      .then(async () => {
        if (!active) return;
        const memory = await consumeMemory();
        if (active) router.replace(memory ? { pathname: '/', params: { memory } } : '/');
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [code, error, flowId]);
  return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
    {failed || error || typeof code !== 'string' ? <>
      <Text>Sign-in could not be completed.</Text>
      <Button title="Back to Memorygram" onPress={() => router.replace('/')} />
    </> : <ActivityIndicator accessibilityLabel="Finishing sign-in" />}
  </View>;
}
