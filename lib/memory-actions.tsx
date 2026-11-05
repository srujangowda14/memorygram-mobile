import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { memoryLink } from './memory-links';
import { PAGE_SIZE, SAMPLE_IDS, type Activity, type Cursor, type Memory, type Social } from './social';

// Read the first or next page and ignore late results after a refresh/unmount.
// A failed append keeps existing rows and retries from the last visible item.
export function useTimeline<T extends Cursor>(fetchPage: (cursor?: Cursor) => Promise<T[]>) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current += 1; }, []);
  const loadingNext = useRef(false);
  const load = useCallback(async (cursor?: Cursor) => {
    if (cursor && loadingNext.current) return;
    const ticket = ++generation.current;
    loadingNext.current = true;
    setLoading(true); setError('');
    try {
      const result = await fetchPage(cursor);
      if (generation.current !== ticket) return;
      setRows(old => cursor ? [...old, ...result] : result);
      setMore(result.length === PAGE_SIZE);
    } catch {
      if (generation.current === ticket) setError('Could not load memories or comments. Try again.');
    } finally {
      if (generation.current === ticket) { setLoading(false); loadingNext.current = false; }
    }
  }, [fetchPage]);
  useEffect(() => {
    setRows([]); setMore(false);
    void load();
    return invalidate;
  }, [load, invalidate]);
  return { rows, loading, error, more, refresh: () => load(), next: () => load(rows[rows.length - 1]),
    replace: (row: T) => setRows(current => current.map(other => other.id === row.id ? row : other)) };
}

// Open the thread with newest comments first. Keep a draft's request ID stable
// across retries so a lost network response cannot create a duplicate comment.
function Comments({ social, id, close, updated }: {
  social: Social; id: string; close: () => void; updated: (activity: Activity) => void;
}) {
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const request = useRef('');
  const busy = useRef(false);
  const fetchPage = useCallback((cursor?: Cursor) => social.replies(id, cursor), [social, id]);
  const thread = useTimeline(fetchPage);

  // Confirm the server write before clearing the draft and refreshing counts.
  // Database policies recheck access even if privacy changed with the sheet open.
  async function post() {
    if (busy.current || !draft.trim()) return;
    busy.current = true; setPosting(true); setError('');
    try {
      request.current ||= randomUUID();
      updated(await social.comment(id, draft.trim(), request.current));
      setDraft(''); request.current = ''; await thread.refresh();
    } catch { setError('Could not post your comment. Check access and try again.'); }
    finally { busy.current = false; setPosting(false); }
  }
  return <Modal visible animationType="slide" onRequestClose={() => { if (!busy.current) close(); }}>
    <SafeAreaView style={styles.sheet}><KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.toolbar}><Text style={styles.title}>Comments</Text>
        <Pressable accessibilityRole="button" disabled={posting} onPress={close}><Text style={styles.link}>Close</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
        {thread.rows.map(reply => <View key={reply.id} style={styles.reply}><Text style={styles.author}>{reply.author.name}</Text>
          <Text style={styles.body}>{reply.body}</Text></View>)}
        {!thread.loading && !thread.error && !thread.rows.length && <Text style={styles.note}>Be the first to comment.</Text>}
        {thread.loading && <ActivityIndicator />}
        {!!thread.error && <Text accessibilityRole="alert">{thread.error}</Text>}
        {!thread.loading && (thread.more || !!thread.error) && <Pressable accessibilityRole="button" onPress={thread.next}>
          <Text style={styles.link}>{thread.error ? 'Retry comments' : 'Older comments'}</Text></Pressable>}
      </ScrollView>
      <View style={styles.composer}>
        {!!error && <Text accessibilityRole="alert">{error}</Text>}
        <TextInput accessibilityLabel="Your comment" placeholder="Add a comment…" multiline maxLength={500}
          style={styles.input} editable={!posting} value={draft} onChangeText={value => { request.current = ''; setDraft(value); }} />
        <Pressable accessibilityRole="button" disabled={posting || !draft.trim()} onPress={post}
          style={[styles.send, (posting || !draft.trim()) && { opacity: .5 }]}>
          <Text style={styles.sendText}>{posting ? 'Posting…' : 'Post comment'}</Text></Pressable>
      </View>
    </KeyboardAvoidingView></SafeAreaView>
  </Modal>;
}

// Keep likes, the discussion and external sharing attached to the same memory
// ID on every surface. Never include a signed photo URL or caption in a share.
export function MemoryActions({ item, social, onActivity }: {
  item: Memory; social: Social; onActivity?: (activity: Activity) => void;
}) {
  const [activity, setActivity] = useState(item.activity);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [copy, setCopy] = useState('');
  const lock = useRef(false);
  useEffect(() => { setActivity(item.activity); }, [item.activity]);
  // Update both the on-screen card and the feed's cached row. Virtualized
  // cards then keep their confirmed counts when scrolled away and back.
  function confirmed(next: Activity) {
    setActivity(next);
    onActivity?.(next);
  }
  // Use the confirmed count returned by the database, so concurrent likes
  // and duplicate taps from this viewer cannot inflate the displayed total.
  async function like() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice('');
    try { confirmed(await social.like(item.id, !activity.liked)); }
    catch { setNotice('Could not update your like. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  // Use the device share sheet or browser sharing API. Browsers without a
  // share sheet can copy the same protected link into another app.
  async function share() {
    setNotice(''); setCopy('');
    if (social.preview && !SAMPLE_IDS.includes(item.id)) {
      setNotice('This guest memory is local. Sign in to publish a shareable memory.'); return;
    }
    const link = memoryLink(item.id, social.preview);
    try {
      if (Platform.OS !== 'web') {
        await Share.share(Platform.OS === 'ios' ? { url: link } : { message: link });
        return;
      }
      if (navigator.share) { await navigator.share({ title: 'Memorygram', url: link }); return; }
      await navigator.clipboard.writeText(link); setNotice('Memory link copied.');
    } catch (reason) {
      if ((reason as Error)?.name === 'AbortError') return;
      setCopy(link); setNotice('Copy this link to share the memory.');
    }
  }
  return <View>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={activity.liked ? 'Unlike memory' : 'Like memory'}
        accessibilityState={{ selected: activity.liked, disabled: busy }} disabled={busy} onPress={like} style={styles.iconButton}>
        <Ionicons name={activity.liked ? 'heart' : 'heart-outline'} color={activity.liked ? '#C85C37' : '#454A42'} size={21} />
        <Text>{activity.likes}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={'Comments (' + activity.comments + ')'} onPress={() => setOpened(true)} style={styles.iconButton}>
        <Ionicons name="chatbubble-outline" size={20} color="#454A42" /><Text>{activity.comments}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Share memory" style={[styles.iconButton, { marginLeft: 'auto' }]} onPress={share}>
        <Ionicons name="share-outline" size={21} color="#454A42" /><Text>Share</Text></Pressable>
    </View>
    {!!notice && <Text accessibilityLiveRegion="polite" style={styles.note}>{notice}</Text>}
    {!!copy && <Text selectable accessibilityLabel="Memory link">{copy}</Text>}
    {opened && <Comments social={social} id={item.id} close={() => setOpened(false)} updated={confirmed} />}
  </View>;
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderColor: '#EBE9E1', marginTop: 7 },
  iconButton: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 6, paddingHorizontal: 4 },
  sheet: { flex: 1, backgroundColor: '#F9F7F1' }, toolbar: { padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '800', color: '#30352E' }, link: { padding: 8, color: '#566C43', fontWeight: '700' },
  thread: { padding: 18, gap: 12 }, reply: { borderBottomWidth: 1, borderColor: '#E6E3D8', paddingBottom: 12 },
  author: { color: '#394534', fontWeight: '700' }, body: { marginTop: 4, fontSize: 16, lineHeight: 22 },
  composer: { padding: 16, gap: 8 }, note: { color: '#686F61', paddingVertical: 6 },
  input: { backgroundColor: 'white', borderWidth: 1, borderColor: '#DCDDD2', borderRadius: 8, padding: 10, maxHeight: 120 },
  send: { alignSelf: 'flex-end', padding: 12, borderRadius: 8, backgroundColor: '#566C43' }, sendText: { color: 'white', fontWeight: '700' },
});
