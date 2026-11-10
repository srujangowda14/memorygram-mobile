import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { Action, People, SharedMemory } from './profile-ui';
import { MemoryComposer } from './memory-composer';
import { useTimeline } from './memory-actions';
import { contexts, suggestContext, type TaskPlace } from './task-location';
import type { Byline, Reply, Social } from './social';
import type { Mode, Space, Task } from './memory-spaces';
import { ListingDetails, MeetingPicker } from './meeting-picker';
import catalog from './friend-quests.json';
import { ageBands, groupRange, type AgeBand } from './quest-age';
import type { Offer } from './nearby';

// Offer two kinds of space before asking for names, people or permissions.
// Keep the existing one-off photo composer reachable from the same entry point.
export function StartMemory({ social, close, open, photo }: {
  social: Social; close: () => void; open: (id: string) => void; photo: () => void;
}) {
  const [mode, setMode] = useState<Mode>();
  const [name, setName] = useState('');
  const [preference,setPreference] = useState<AgeBand | 'All ages' | 'Calculate'>('All ages');
  const [ages,setAges] = useState('');
  const [friends, setFriends] = useState<Byline[]>([]);
  const range = preference === 'Calculate' ? groupRange(ages,friends.length+1) : preference;
  const ageBand = mode === 'group' && range !== 'All ages' ? range : undefined;
  const missingAges = mode === 'group' && !range;
  const [place, setPlace] = useState<TaskPlace>({ key: 'anywhere' });
  const areaLabel = place.key === 'locality' ? place.name : contexts[place.key];
  const [locating, setLocating] = useState(false);
  const [choosingSpot, setChoosingSpot] = useState(false);
  const [offer, setOffer] = useState<Offer>();
  const [locationNote, setLocationNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const ticket = useRef(0);
  const request = useRef('');
  useEffect(() => () => { ticket.current++; }, []);

  // Invalidate late GPS callbacks when a user skips location or goes back.
  // Starting a space is available even if the device never supplies a fix.
  function clearLocation() {
    ticket.current++; setLocating(false); setPlace({ key: 'anywhere' }); setLocationNote('');
    setChoosingSpot(false); setOffer(undefined);
  }

  // Preview the place label before it is used for an assignment. Permission
  // denial, timeout and unavailable services all retain the anywhere option.
  async function locate() {
    const generation = ++ticket.current;
    setLocating(true); setLocationNote('');
    try {
      const place = await suggestContext();
      if (generation === ticket.current) setPlace(place);
    } catch {
      if (generation === ticket.current) setLocationNote('Location is unavailable. You can start with anywhere tasks or try again.');
    } finally { if (generation === ticket.current) setLocating(false); }
  }

  // Select only people returned by the mutual-friend directory. The creator
  // counts toward the twenty-member cap and is always included by the server.
  function toggle(person: Byline) {
    setAges(''); setOffer(undefined);
    if (friends.some(p => p.id === person.id)) setFriends(friends.filter(p => p.id !== person.id));
    else if (friends.length < 19) setFriends([...friends, person]);
    else setError('Choose up to 19 friends.');
  }

  // Reuse the request ID after a lost response so starting a space twice
  // cannot create two groups or assign a second set of prompts.
  async function start() {
    if (lock.current || missingAges || locating || !mode || (choosingSpot && !offer)) return;
    if (name.trim().length === 1) { setError('Use at least two characters for the name.'); return; }
    if (mode === 'group' && !friends.length) { setError('Choose at least one friend.'); return; }
    lock.current = true; setBusy(true); setError(''); ticket.current++; setLocating(false);
    try {
      request.current ||= randomUUID();
      const id = await social.spaces.start({ id: request.current, name: name.trim() || (mode === 'solo' ? 'My Pocket Chapter' : 'Our memory group'),
        mode, friends: mode === 'group' ? friends : [], place, offer, ageBand });
      open(id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('suggestion expired')) {
        setOffer(undefined); setError('This suggestion expired. Find suggestions again to choose a fresh one.');
      } else setError('Could not start this memory. Check your connection and friend selection, then retry.');
    }
    finally { lock.current = false; setBusy(false); }
  }
  return <Modal visible animationType="slide" onRequestClose={() => { if (!lock.current) close(); }}>
    <SafeAreaView style={st.screen}><KeyboardAvoidingView style={st.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={st.page}>
        <View style={st.top}><Text style={st.title}>{!mode ? 'Start a memory' : mode === 'solo' ? 'Pocket Chapter' : 'With others'}</Text>
          <Action label="Close" disabled={busy} onPress={close} /></View>
        {!mode ? <>
          <Text style={st.body}>Who are you making this memory with?</Text>
          <ModeCard mode="solo" onPress={() => setMode('solo')} />
          <ModeCard mode="group" onPress={() => setMode('group')} />
          <Action label="Post an existing photo" onPress={photo} />
        </> : <>
          <Text style={st.body}>{mode === 'solo' ? 'Three little tasks for your own private scrapbook.' :
            'Make a private group with three shared tasks and a chat. Anyone in the group can save a memory for a task.'}</Text>
          <Text style={st.label}>{mode === 'solo' ? 'Chapter name' : 'Group name'} (optional)</Text>
          <TextInput style={st.input} value={name} onChangeText={setName} maxLength={50} editable={!busy}
            accessibilityLabel="Space name" placeholder={mode === 'solo' ? 'My Pocket Chapter' : 'Our memory group'} />
          {mode === 'group' && <View style={st.panel}><Text style={st.heading}>Choose friends</Text>
            <Text style={st.body}>{friends.length ? friends.map(f => f.name).join(' · ') : 'Choose people who follow you back.'}</Text>
            <View pointerEvents={busy ? 'none' : 'auto'}><People kind="friends" social={social} owner={social.me} selected={friends} choose={toggle} /></View>
            <Text style={st.heading}>Group age range</Text>
            <View style={st.wrap}>{(['All ages',...ageBands,'Calculate'] as const).map(b =>
              <Action key={b} label={b} primary={preference===b} disabled={busy} onPress={() => { setPreference(b); setOffer(undefined); }} />)}</View>
            {preference==='Calculate' && <><Text style={st.body}>Enter one age for each person, including yourself. Only the group range is saved.</Text>
              <TextInput accessibilityLabel="Group ages" style={st.input} placeholder="For example, 68, 71" value={ages} onChangeText={v=>{setAges(v);setOffer(undefined);}} editable={!busy}/>
              <Text style={st.meta}>{range ? 'Quest selection · '+range : 'Enter '+(friends.length+1)+' ages separated by commas.'}</Text></>}
          </View>}
          <View style={st.panel}>
            {choosingSpot ? <><MeetingPicker key={ageBand || 'all'} ageBand={ageBand} preview={social.preview} mode={mode} draftId={request.current}
              selected={offer} choose={o => { setOffer(o); setError(''); }} disabled={busy} />
              <Action label="Use anywhere tasks" disabled={busy} onPress={clearLocation} /></> : <>
            <View style={st.inline}><Ionicons name="location-outline" size={19} color="#59694C" /><Text style={st.heading}>{mode==='solo' ? 'Where will you go?' : 'Where will you meet?'}</Text></View>
            <Action label="Choose a meeting spot" disabled={busy} onPress={() => {
              clearLocation(); request.current ||= randomUUID(); setChoosingSpot(true);
            }} />
            <Text style={st.body}>{place.key === 'anywhere' ? 'Or use your location once for a curated prompt. Your coordinates stay on this device.' :
              (mode === 'group' ? 'Your group’s task can mention ' : 'Your task will use ') + areaLabel + '.'}</Text>
            <View style={st.wrap}>{place.key === 'anywhere' && <Action label={locating ? 'Finding location…' : 'Use my location'}
              disabled={busy || locating} onPress={locate} />}
              {(locating || place.key !== 'anywhere') && <Action label="Use anywhere tasks" disabled={busy} onPress={clearLocation} />}</View>
            {!!locationNote && <Text accessibilityRole="alert" style={st.body}>{locationNote}</Text>}
            </>}
          </View>
          {!!error && <Text accessibilityRole="alert" style={st.error}>{error}</Text>}
          <Action primary label={busy ? 'Creating…' : mode === 'solo' ? 'Start Pocket Chapter' : 'Create group'}
            disabled={busy || missingAges || locating || (choosingSpot && !offer) || (mode === 'group' && !friends.length)} onPress={start} />
          <Action label="Back" disabled={busy} onPress={() => { clearLocation(); setMode(undefined); setName(''); setError(''); }} />
        </>}
      </ScrollView>
    </KeyboardAvoidingView></SafeAreaView>
  </Modal>;
}

// Use an icon and an explicit audience description for each creation mode.
// The entire tile is a labeled touch target for keyboard and screen readers.
function ModeCard({ mode, onPress }: { mode: Mode; onPress: () => void }) {
  const solo = mode === 'solo';
  const title = solo ? 'Pocket Chapter' : 'With others';
  return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={[st.tile, solo ? st.peach : st.sage]}>
    <Ionicons name={solo ? 'book-outline' : 'people-outline'} color={solo ? '#8A452D' : '#475B39'} size={29} />
    <View style={st.flex}><Text style={st.tileTitle}>{title}</Text>
      <Text style={st.body}>{solo ? 'A private collection of moments, just for you.' : 'A group chat and memory tasks for you and your people.'}</Text></View>
    <Ionicons name="chevron-forward" size={20} color="#545D50" />
  </Pressable>;
}

// List only spaces visible to this member, including those a friend started.
// The board can page older rooms and refresh independently of the home feed.
export function SpaceList({ social, open }: { social: Social; open: (id: string) => void }) {
  const page = useTimeline(social.spaces.list);
  return <View style={st.section}><View style={st.top}><Text style={st.heading}>Your memory spaces</Text>
    <Action label="Refresh spaces" onPress={page.refresh} /></View>
    {page.rows.map(space => <Pressable key={space.id} accessibilityRole="button" accessibilityLabel={'Open ' + space.name}
      style={st.roomLink} onPress={() => open(space.id)}>
      <Ionicons name={space.mode === 'solo' ? 'book-outline' : 'people-outline'} size={22} color="#59694C" />
      <View style={st.flex}><Text style={st.label}>{space.name}</Text><Text style={st.meta}>{space.mode === 'solo' ? 'Only you' : space.people.length + ' members'}</Text></View>
      <Ionicons name="chevron-forward" size={18} color="#56644B" />
    </Pressable>)}
    {page.loading && <ActivityIndicator />}
    {page.error ? <Text accessibilityRole="alert">Could not load spaces. Tap Refresh spaces to retry.</Text>
      : !page.loading && !page.rows.length && <Text style={st.body}>Tap + to start a Pocket Chapter or a group.</Text>}
    {page.more && !page.loading && <Action label="Older spaces" onPress={page.next} />}
  </View>;
}

// Reopen the same room for every member. A completed task opens its saved
// photo and caption. Returning to the room reloads the shared task state.
export function SpaceRoom({ social, id, back, visit }: { social: Social; id: string; back: () => void; visit: (id: string) => void }) {
  const [room, setRoom] = useState<{ space: Space; tasks: Task[] }>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [task, setTask] = useState<Task>();
  const [editingRange,setEditingRange] = useState(false);
  // Refresh the persisted collection after a member changes the group range.
  // A failed write leaves the previous preference and assignments available.
  async function changeRange(band?:AgeBand) {
    setAdding(true);setAddError('');
    try { await social.spaces.setRange(id,band);setEditingRange(false);setLimit(6);setRevision(n=>n+1); }
    catch {setAddError('Could not change the range. Try again.');}
    finally {setAdding(false);}
  }
  const [limit,setLimit] = useState(0);
  const [adding,setAdding] = useState(false);
  const [addError,setAddError] = useState('');
  // Add to the same group's task list and refresh from the confirmed store.
  // Keep the catalog open if membership or connectivity changes.
  async function addQuest(key:string) {
    if (adding) return;
    setAdding(true);setAddError('');
    try { await social.spaces.addQuest(id,key);setLimit(0);setRevision(n=>n+1); }
    catch {setAddError('Could not add this quest. Try again.');}
    finally {setAdding(false);}
  }
  const [reading, setReading] = useState('');
  const [chat, setChat] = useState(false);
  useEffect(() => {
    let current = true;
    social.spaces.room(id).then(r => { if (current) { setRoom(r); setError(''); } }).catch(() => {
      if (current) setError('Could not load the space. Check your connection and membership.');
    });
    return () => { current = false; };
  }, [id, social, revision]);
  const choices = limit && room ? catalog.filter(q=>(!room.space.ageBand || q.band===room.space.ageBand) &&
    !room.tasks.some(t=>t.title===q.title)) : [];
  const meeting = room?.tasks.find(q => q.nearby)?.nearby;
  if (reading) return <SharedMemory id={reading} social={social} visit={visit} backLabel="Back to space" back={() => setReading('')} />;
  return <KeyboardAvoidingView style={st.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={st.page}>
      <View style={st.top}><Action label="← Your spaces" onPress={back} /><Action label="Refresh" onPress={() => setRevision(n => n + 1)} /></View>
      {!!error && <Text accessibilityRole="alert" style={st.error}>{error}</Text>}
      {!room && !error && <ActivityIndicator />}
      {room && <>
        <Text style={st.title}>{room.space.name}</Text>
        <Text style={st.body}>{room.space.mode === 'solo' ? 'Private · Only you' : room.space.people.map(p => p.id === social.me ? 'You' : p.name).join(' · ')}</Text>
        {meeting && <View><Text style={st.label}>Meet at {meeting.meeting}</Text>
          {!!meeting.meetingAddress && <Text style={st.meta}>{meeting.meetingAddress}</Text>}</View>}
        <View style={st.wrap}><Action primary={!chat} label="Assigned tasks" onPress={() => { setChat(false); setRevision(n => n + 1); }} />
          {room.space.mode === 'group' && <Action primary={chat} label="Group chat" onPress={() => setChat(true)} />}</View>
        {chat ? <GroupChat social={social} group={id} /> : <>
          {room.space.mode==='group' && <Action label={limit?'Close quest library':'Browse quests · '+(room.space.ageBand || 'All ages')} onPress={()=>setLimit(limit?0:6)} />}
           {limit>0 && <View style={st.section}><Action label="Change group age range" disabled={adding} onPress={()=>setEditingRange(v=>!v)}/>
            {editingRange && <View style={st.wrap}>{(['All ages',...ageBands] as const).map(b=><Action key={b} label={b} disabled={adding}
              primary={b===(room.space.ageBand || 'All ages')} onPress={()=>changeRange(b==='All ages'?undefined:b)}/>)}</View>}
            {choices.slice(0,limit).map(q=><View key={q.key} style={st.panel}>
            <Text style={st.heading}>{q.title}</Text><Text style={st.body}>{q.prompt}</Text>
            <Action label={'Assign '+q.title} disabled={adding} onPress={()=>addQuest(q.key)}/></View>)}
            {choices.length>limit && <Action label="More quests" onPress={()=>setLimit(n=>n+6)}/>}
            {!choices.length && <Text>All quests in this collection are assigned.</Text>}
            {!!addError && <Text accessibilityRole="alert">{addError}</Text>}</View>}
          <Text style={st.meta}>{room.tasks.filter(q => q.result).length} of {room.tasks.length} memories saved</Text>
          {room.tasks.map(q => <View key={q.id} style={st.panel}><Text style={st.heading}>{q.title}</Text>
            <Text style={st.body}>{q.prompt}</Text>
            {q.nearby && <ListingDetails item={q.nearby} />}
            {q.nearby?.origin !== 'Google Maps' && <Text style={st.meta}>{q.minutes} min · {q.nearby ? 'Free activity' : q.setting + ' · Free'}</Text>}
            <Action label={q.result ? 'View memory' : 'Add a memory'} onPress={() => q.result ? setReading(q.result) : setTask(q)} /></View>)}
        </>}
        {task && <MemoryComposer social={social} title={task.title} prompt={task.prompt} assignment={{ space: room.space, taskId: task.id }}
          onClose={() => { setTask(undefined); setRevision(n => n + 1); }}
          onPosted={() => { setTask(undefined); setRevision(n => n + 1); }} />}
      </>}
    </ScrollView>
  </KeyboardAvoidingView>;
}

// Fetch recent messages when the chat is visible and the app is active.
// Paging uses a server cursor, and message IDs deduplicate send retries.
function GroupChat({ social, group }: { social: Social; group: string }) {
  const [{ messages, more }, setHistory] = useState<{ messages: Reply[]; more: boolean }>({ messages: [], more: false });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sendError, setSendError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const request = useRef('');
  const lock = useRef(false);
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const saved = useRef({ messages: [] as Reply[], more: false });
  const pendingRefresh = useRef(false);
  const fetching = useRef(false);
  const mounted = useRef(true);

  // Serialize reads so an insert received during paging always triggers a
  // follow-up refresh. Walk backward to the known history after a long outage.
  const read = useCallback(async (before?: Reply) => {
    if (!mounted.current) return;
    if (fetching.current) {
      if (!before) pendingRefresh.current = true;
      return;
    }
    fetching.current = true;
    try {
      do {
        pendingRefresh.current = false;
        const previous = saved.current;
        const known = new Set(previous.messages.map(message => message.id));
        const incoming: Reply[] = [];
        let cursor = before;
        let more: boolean;
        let overlaps: boolean;
        do {
          const page = await social.spaces.messages(group, cursor);
          if (!mounted.current) return;
          incoming.push(...page);
          overlaps = page.some(message => known.has(message.id));
          more = page.length === 24;
          cursor = page[page.length - 1];
        } while (!before && known.size && more && !overlaps);

        const ordered = before ? [...previous.messages, ...incoming]
          : overlaps ? [...incoming, ...previous.messages] : incoming;
        const unique = new Map(ordered.map(message => [message.id, message]));
        saved.current = { messages: [...unique.values()], more: !before && overlaps ? previous.more : more };
        setHistory(saved.current);
        setError('');
        before = undefined;
      } while (pendingRefresh.current);
    } catch { if (mounted.current) setError('Chat could not refresh. Try again.'); }
    finally { fetching.current = false; if (mounted.current) setLoading(false); }
  }, [social, group]);

  useEffect(() => {
    mounted.current = true;
    let stop: (() => void) | undefined;
    // Release the subscription while backgrounded. On resume, load saved
    // history immediately and sync again once the new subscription is ready.
    function activate(active: boolean) {
      stop?.();
      stop = undefined;
      if (!active) return;
      void read();
      stop = social.spaces.watchMessages?.(group, () => void read(), ready => setDisconnected(!ready));
    }
    activate(!AppState.currentState || AppState.currentState === 'active');
    const listener = AppState.addEventListener('change', state => activate(state === 'active'));
    return () => { mounted.current = false; listener.remove(); stop?.(); };
  }, [read, group, social, attempt]);

  // Persist a message before clearing the text box. Retrying an unchanged
  // message uses its original ID if the first response was lost.
  async function send() {
    if (lock.current || !draft.trim()) return;
    lock.current = true; setSending(true); setSendError('');
    try {
      request.current ||= randomUUID();
      await social.spaces.send(group, draft, request.current);
      setDraft(''); request.current = ''; await read();
    } catch { setSendError('Could not send your message. Try again.'); }
    finally { lock.current = false; setSending(false); }
  }
  return <View style={st.section}>
    <TextInput multiline accessibilityLabel="Group message" placeholder="Message your group…" style={st.input} maxLength={1000}
      editable={!sending} value={draft} onChangeText={v => { request.current = ''; setDraft(v); }} />
    <Action primary label={sending ? 'Sending…' : 'Send message'} disabled={!draft.trim() || sending} onPress={send} />
    {disconnected && <><Text style={st.meta}>Live updates disconnected.</Text>
      <Action label="Reconnect chat" onPress={() => setAttempt(n => n + 1)} /></>}
    {!!sendError && <Text accessibilityRole="alert" style={st.error}>{sendError}</Text>}
    {!!error && <><Text accessibilityRole="alert" style={st.error}>{error}</Text><Action label="Retry chat" onPress={() => void read()} /></>}
    {loading && <ActivityIndicator />}
    {!loading && !error && !messages.length && <Text style={st.body}>Start the conversation. Which task should you try first?</Text>}
    {messages.map(m => <View key={m.id} style={st.panel}><Text style={st.label}>{m.author.id === social.me ? 'You' : m.author.name}</Text>
      <Text style={st.body}>{m.body}</Text><Text style={st.meta}>{new Date(m.created).toLocaleString()}</Text></View>)}
    {more && <Action label="Earlier messages" onPress={() => void read(messages[messages.length - 1])} />}
  </View>;
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F9F7F1' }, flex: { flex: 1 },
  page: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 20, paddingBottom: 44, gap: 14 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { flexShrink: 1, fontWeight: '800', fontSize: 30, letterSpacing: -1, color: '#30352E' },
  heading: { flexShrink: 1, fontWeight: '800', fontSize: 18, color: '#343D30' }, label: { color: '#3D4939', fontWeight: '700', fontSize: 15 },
  meta: { color: '#697360', fontSize: 12 }, body: { color: '#4E5849', lineHeight: 21, fontSize: 14 }, error: { color: '#963A28' },
  input: { borderWidth: 1, borderColor: '#CDD1C5', backgroundColor: '#FFFDFA', borderRadius: 10, padding: 13, color: '#30352E' },
  panel: { gap: 9, padding: 17, borderRadius: 14, backgroundColor: '#FFFDF9', borderWidth: 1, borderColor: '#DFE1D6' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  section: { gap: 10, paddingBottom: 14 }, tile: { flexDirection: 'row', alignItems: 'center', gap: 15, padding: 20, borderRadius: 17 },
  peach: { backgroundColor: '#F3E3D8' }, sage: { backgroundColor: '#E5EAD9' }, tileTitle: { fontSize: 21, fontWeight: '800', color: '#333B2F', marginBottom: 4 },
  roomLink: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 11, backgroundColor: '#E9ECDG' },
});
