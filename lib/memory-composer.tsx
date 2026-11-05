import { useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import { Action, People } from './profile-ui';
import type { Byline, Social } from './social';

// Build one photo-backed memory for the author and the friends selected here.
// Keep the draft and photo ID on failure so retrying cannot duplicate the post.
export function MemoryComposer({ social, title, prompt, onClose, onPosted }: {
  social: Social; title: string; prompt?: string; onClose: () => void; onPosted: () => void;
}) {
  const [caption, setCaption] = useState('');
  const [group, setGroup] = useState('');
  const [people, setPeople] = useState<Byline[]>([]);
  const [picking, setPicking] = useState(false);
  const [photo, setPhoto] = useState<{ id: string; asset: ImagePicker.ImagePickerAsset }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);

  // Ask the device for a photo. Native pickers provide JPEG bytes and the web
  // picker provides a File, both of which can be sent to private storage.
  async function choosePhoto() {
    setError('');
    try {
      if (Platform.OS !== 'web' && !(await ImagePicker.requestMediaLibraryPermissionsAsync()).granted) {
        setError('Allow photo access to add your memory.'); return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], quality: .75, base64: Platform.OS !== 'web',
      });
      if (!result.canceled) setPhoto({ id: Crypto.randomUUID(), asset: result.assets[0] });
    } catch { setError('Could not open that photo. Try choosing another.'); }
  }

  // The author is included automatically. Additional participants must be
  // mutual followers and remain selected while searching the directory.
  function toggle(person: Byline) {
    if (people.some(p => p.id === person.id)) setPeople(people.filter(p => p.id !== person.id));
    else if (people.length < 19) setPeople([...people, person]);
    else setError('Choose up to 19 friends for this memory.');
  }

  // Submit only a complete draft and close after the server confirms it.
  // Disable editing during upload to keep the preview and posted data identical.
  async function post() {
    if (lock.current) return;
    if (!photo || !caption.trim()) { setError('Add a photo and a caption first.'); return; }
    if (people.length && group.trim().length === 1) { setError('Use at least two letters for the group name.'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      await social.publish({ id: photo.id, asset: photo.asset, caption: caption.trim(), people,
        group: people.length ? group.trim() || 'Memory group' : 'Solo memory', quest: title });
      onPosted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not publish. Check your connection and selected friends, then retry.');
    } finally { lock.current = false; setBusy(false); }
  }
  return <Modal visible animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.top}><Text style={styles.title}>{title}</Text><Action label="Close" disabled={busy} onPress={onClose} /></View>
        {!!prompt && <Text style={styles.note}>{prompt}</Text>}
        {photo && <Image source={{ uri: photo.asset.uri }} style={styles.photo} />}
        <Action label={photo ? 'Change photo' : 'Add photo proof'} onPress={choosePhoto} disabled={busy} />
        <Text style={styles.label}>Caption</Text><TextInput multiline accessibilityLabel="Memory caption" editable={!busy}
          style={styles.input} maxLength={220} placeholder="What happened?" value={caption} onChangeText={setCaption} />
        <Text style={styles.label}>Who was there?</Text>
        <Text style={styles.note}>{['You', ...people.map(p => p.name)].join(' · ')}</Text>
        <Action label={picking ? 'Done choosing' : 'Choose friends'} disabled={busy} onPress={() => setPicking(!picking)} />
        {picking && !busy && <People social={social} kind="friends" owner={social.me} choose={toggle} selected={people} />}
        {people.length > 0 && <>
          <Text style={styles.label}>Group name (optional)</Text>
          <TextInput style={styles.input} maxLength={50} editable={!busy} accessibilityLabel="Group name" placeholder="Friday crew"
            value={group} onChangeText={setGroup} />
          <Text style={styles.note}>This memory will appear on all {people.length + 1} profiles. Outside the group, viewers need access to every private profile involved.</Text>
        </>}
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Action primary label={busy ? 'Posting…' : 'Post memory'} disabled={busy} onPress={post} />
      </ScrollView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F9F7F1', paddingTop: Platform.OS === 'ios' ? 48 : 24 },
  page: { padding: 22, paddingBottom: 48, gap: 12 }, top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontSize: 25, fontWeight: '800', color: '#30352E' }, label: { fontWeight: '700', color: '#3B4335' },
  note: { color: '#686F61', lineHeight: 20 }, error: { color: '#9B3924' },
  input: { padding: 12, borderWidth: 1, borderColor: '#DBDED3', backgroundColor: 'white', borderRadius: 9 },
  photo: { width: '100%', aspectRatio: 1.65, borderRadius: 8, backgroundColor: '#EEEDE6' },
});
