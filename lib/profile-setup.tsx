import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Action } from './profile-ui';
import { supabase } from './supabase';

// Ask once on the first signed-in visit, including profiles created before
// birthdays were collected. Keep children gated until this owner's date exists.
export function ProfileSetup({ userId, children }: { userId: string; children: ReactNode }) {
  const [stage, setStage] = useState<'reading'|'error'|'form'|'ready'>('reading');
  const [attempt, setAttempt] = useState(0);
  const [birthday, setBirthday] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void supabase!.from('profile_birthdays').select('birthday').eq('user_id', userId).maybeSingle()
      .then(({ data, error }) => { if (active) setStage(error ? 'error' : data ? 'ready' : 'form'); });
    return () => { active = false; };
  }, [userId, attempt]);

  // Reject invalid calendar dates before submitting. The database independently
  // validates the age and permits writes only to the signed-in owner's row.
  async function save() {
    const value = birthday.trim();
    const date = new Date(value + 'T00:00:00Z');
    const today = new Date();
    const oldest = new Date(today);
    oldest.setFullYear(oldest.getFullYear()-121);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0,10)!==value || date>today || date<=oldest) {
      setMessage('Enter a valid birthday in YYYY-MM-DD format.'); return;
    }
    setSaving(true);
    try {
      const { error } = await supabase!.from('profile_birthdays').upsert({user_id:userId,birthday:value});
      if (error) throw error;
      setStage('ready');
    } catch { setMessage('Could not save your birthday. Please try again.'); }
    finally { setSaving(false); }
  }
  if (stage==='ready') return <>{children}</>;
  return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    {stage==='reading' ? <ActivityIndicator accessibilityLabel="Loading profile" /> : stage==='error' ? <>
      <Text>Could not load your profile details.</Text>
      <Action label="Retry" onPress={()=>{setStage('reading');setAttempt(v=>v+1);}} />
    </> : <>
      <Text style={styles.title}>Finish your profile</Text>
      <Text>What’s your birthday? We use it to choose age-appropriate group quests. Only you can see your birthday.</Text>
      <TextInput accessibilityLabel="Birthday" value={birthday} onChangeText={setBirthday} placeholder="YYYY-MM-DD"
        maxLength={10} autoCapitalize="none" autoCorrect={false} style={styles.input} placeholderTextColor="#666A61" />
      {!!message && <Text accessibilityRole="alert">{message}</Text>}
      <Action primary label="Save profile" onPress={save} disabled={saving} />
    </>}
    {stage!=='reading' && <Action label="Sign out" onPress={()=>void supabase!.auth.signOut({scope:'local'})} />}
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  screen:{flex:1,backgroundColor:'#F9F7F1'}, page:{padding:24,gap:16},
  title:{fontSize:26,fontWeight:'700'},input:{color:'#343832',backgroundColor:'white',padding:14,borderRadius:8,borderWidth:1,borderColor:'#A4A49C'},
});
