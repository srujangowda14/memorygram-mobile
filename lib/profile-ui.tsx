import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Activity, Byline, FollowAction, Memory, PeopleList, Person, Social } from './social';
import { MemoryActions, useTimeline } from './memory-actions';

// Pages are fetched using the same viewer-scoped query on every refresh.
// Ignore late completions after navigating to a different person or filter.
function usePage<T>(load: (offset: number) => Promise<T[]>, size: number) {
  const [items, setItems] = useState<T[]>([]);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    load(offset).then(rows => {
      if (!current) return;
      setItems(old => offset ? [...old, ...rows] : rows);
      setMore(rows.length === size);
    }).catch(() => {
      if (current) setError('Could not load this page. Check your connection and try again.');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [load, offset, refresh, size]);
  return { items, loading, error, more, next: () => setOffset(offset + size),
    retry: () => setRefresh(refresh + 1) };
}

// Give text actions a consistent touch target, including selected and disabled
// states for following, people selection and paginated lists.
export function Action({ label, onPress, primary, disabled }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={[styles.action, primary && styles.primary, disabled && { opacity: .55 }]}>
    <Text style={[styles.actionText, primary && { color: 'white' }]}>{label}</Text>
  </Pressable>;
}

// Render the same caption and photo wherever a shared memory appears.
// Participant names link to their profiles, including from the scrapbook.
function MemoryPrint({ item, social, visit, onActivity }: {
  item: Memory; social: Social; visit: (id: string) => void; onActivity?: (activity: Activity) => void;
}) {
  return <View style={styles.print}>
    {item.image ? <Image accessibilityLabel={item.caption} source={{ uri: item.image }} style={styles.photo} />
      : <Text style={styles.note}>Photo unavailable</Text>}
    <Text style={styles.caption}>{item.caption}</Text>
    <Text style={styles.note}>{[item.group, item.quest, new Date(item.created).toLocaleDateString()].filter(Boolean).join(' · ')}</Text>
    <View style={styles.wrap}>{item.people.map(person => <Pressable key={person.id}
      accessibilityRole="button" onPress={() => visit(person.id)}>
      <Text style={styles.nameLink}>{person.name}</Text>
    </Pressable>)}</View>
    <MemoryActions item={item} social={social} onActivity={onActivity} />
  </View>;
}

// Display one person's visible memories in posting order. Profile and
// scrapbook pagination are separate from the cross-profile home timeline.
export function MemoryFeed({ social, owner, visit }: {
  social: Social; owner: string; visit: (id: string) => void;
}) {
  const load = useCallback((offset: number) => social.memories(owner, offset), [social, owner]);
  const page = usePage(load, 24);
  return <View>
    {page.items.map(m => <MemoryPrint key={m.id} item={m} social={social} visit={visit} />)}
    {page.loading && <ActivityIndicator />}
    {!!page.error && <><Text style={styles.note}>{page.error}</Text><Action label="Retry memories" onPress={page.retry} /></>}
    {!page.loading && !page.error && !page.items.length && <Text style={styles.note}>No memories to show yet.</Text>}
    {page.more && !page.loading && !page.error && <Action label="More memories" onPress={page.next} />}
  </View>;
}

// Render one chronological stream across profiles, with refresh and cursor
// pagination. Reuse the same card for posts from friends, groups and public users.
export function HomeTimeline({ social, visit, compose, footer }: {
  social: Social; visit: (id: string) => void; compose: () => void; footer: React.ReactElement;
}) {
  const page = useTimeline(social.feed);
  return <FlatList data={page.rows} contentContainerStyle={styles.page} keyExtractor={m => m.id}
    refreshing={page.loading && !page.rows.length} onRefresh={page.refresh}
    ListHeaderComponent={<View style={{ gap: 8 }}><Text style={styles.heading}>Memory feed</Text>
      <View style={styles.wrap}><Action primary label="Create memory" onPress={compose} />
        <Action label="Refresh feed" onPress={page.refresh} /></View></View>}
    renderItem={({ item }) => <MemoryPrint item={item} social={social} visit={visit}
      onActivity={activity => page.replace({ ...item, activity })} />}
    ListEmptyComponent={!page.loading && !page.error ? <Text style={styles.note}>Your feed is ready for its first memory. Post a photo or follow someone with a private profile.</Text> : null}
    ListFooterComponent={<View>
      {page.loading && <ActivityIndicator />}
      {!!page.error && <Text accessibilityRole="alert">{page.error}</Text>}
      {!page.loading && (page.more || !!page.error) && <Action label={page.error ? 'Retry feed' : 'More memories'}
        onPress={page.error ? page.refresh : page.next} />}
      {footer}
    </View>} />;
}

// Re-fetch a shared post under the recipient's own session. Hidden and missing
// posts receive the same response and expose no caption, image or byline.
export function SharedMemory({ social, id, visit, back, backLabel = 'Back to feed' }: {
  social: Social; id: string; visit: (id: string) => void; back: () => void; backLabel?: string;
}) {
  const [item, setItem] = useState<Memory | null>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setItem(undefined); setFailed(false);
    social.memory(id).then(m => { if (active) setItem(m ?? null); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [social, id, retry]);
  return <ScrollView contentContainerStyle={styles.page}><Action label={backLabel} onPress={back} />
    <Text style={styles.heading}>Shared memory</Text>
    {failed ? <><Text>Could not load this memory.</Text><Action label="Retry" onPress={() => setRetry(v => v + 1)} /></>
      : item === undefined ? <ActivityIndicator /> : item === null ? <Text>This memory is unavailable to this account.</Text>
      : <MemoryPrint item={item} social={social} visit={visit} />}
  </ScrollView>;
}

// Load one searchable list of people. Remounting the results on search resets
// pagination and prevents stale profiles from appearing under a new query.
export function People({ social, kind, owner, choose, selected, respond }: {
  social: Social; kind: PeopleList; owner: string; choose: (person: Byline) => void;
  selected?: Byline[]; respond?: (id: string, action: FollowAction) => void;
}) {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(term.trim()), 200);
    return () => clearTimeout(timer);
  }, [term]);
  return <View>
    {kind !== 'requests' && <TextInput accessibilityLabel="Search people" placeholder="Search by name"
      style={styles.input} value={term} onChangeText={setTerm} />}
    <PeopleRows key={kind + owner + query} {...{ social, kind, owner, choose, selected, respond, query }} />
  </View>;
}

// Present profiles or participant checkboxes from the same social directory.
// Only the incoming-request list provides approval and decline actions.
function PeopleRows({ social, kind, owner, choose, selected, respond, query }:
  Parameters<typeof People>[0] & { query: string }) {
  const load = useCallback((offset: number) => social.people(kind, owner, query, offset), [social, kind, owner, query]);
  const page = usePage(load, 30);
  return <View>
    {page.items.map(p => <View key={p.id} style={styles.row}>
      <Pressable accessibilityRole={selected ? 'checkbox' : 'button'}
        accessibilityState={selected ? { checked: selected.some(s => s.id === p.id) } : undefined}
        style={{ flex: 1, paddingVertical: 9 }} onPress={() => choose({ id: p.id, name: p.display_name })}>
        <Text style={styles.person}>{p.display_name}</Text>
        <Text style={styles.note}>{p.is_private ? 'Private' : 'Public'} · {p.id.slice(0,8)}</Text>
      </Pressable>
      {selected && <Text>{selected.some(s => s.id === p.id) ? '✓' : '○'}</Text>}
      {respond && kind === 'followers' && <Action label="Remove" onPress={() => respond(p.id,'remove')} />}
      {respond && kind === 'requests' && <><Action label="Approve" onPress={() => respond(p.id,'approve')} />
        <Action label="Decline" onPress={() => respond(p.id,'decline')} /></>}
    </View>)}
    {page.loading && <ActivityIndicator />}
    {!!page.error && <><Text style={styles.note}>{page.error}</Text><Action label="Retry" onPress={page.retry} /></>}
    {!page.loading && !page.error && !page.items.length && <Text style={styles.note}>
      {kind === 'friends' ? 'Follow each other to make a group memory together.' : 'No people found.'}</Text>}
    {page.more && !page.loading && !page.error && <Action label="More people" onPress={page.next} />}
  </View>;
}

// Show one profile with its approved follow counts, relationship controls and
// memories. Changes refresh the viewer-relative counts and permission checks.
export function Profile({ social, owner, visit, compose }: {
  social: Social; owner: string; visit: (id: string) => void; compose: () => void;
}) {
  const [list, setList] = useState<PeopleList | null>(null);
  const [revision, setRevision] = useState(0);
  const [profile, setProfile] = useState<Person | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let current = true;
    setError('');
    social.people('profile', owner).then(rows => {
      if (!rows[0]) throw new Error();
      if (current) setProfile(rows[0]);
    }).catch(() => { if (current) { setProfile(null); setError('Could not load this profile.'); } });
    return () => { current = false; };
  }, [social, owner, revision]);

  // Wait for the server's decision before changing the button or counts.
  // A failed request leaves the current relationship intact for a retry.
  async function change(id: string, action: FollowAction) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await social.follow(id, action);
      setRevision(value => value + 1);
    } catch { setError('Could not update the follow request. Please retry.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const own = owner === social.me;
  const allowed = own || !profile?.is_private || profile.relation === 'accepted';
  const toggle = (next: PeopleList) => setList(current => current === next ? null : next);
  return <ScrollView contentContainerStyle={styles.page}>
    {!own && <Action label="← My profile" onPress={() => visit(social.me)} />}
    {!!error && <><Text accessibilityRole="alert" style={styles.note}>{error}</Text>
      <Action label="Reload profile" onPress={() => setRevision(v => v + 1)} /></>}
    {!profile && !error && <ActivityIndicator />}
    {profile && <>
      <View style={styles.identity}>
        <View style={styles.monogram}><Text style={styles.initial}>{profile.display_name.slice(0,1).toUpperCase()}</Text></View>
        <Text style={styles.heading}>{profile.display_name}</Text>
        <Text style={styles.note}><Ionicons name={profile.is_private ? 'lock-closed-outline' : 'globe-outline'} /> {profile.is_private ? 'Private profile' : 'Public profile'}</Text>
      </View>
      <View style={styles.wrap}>
        <Action label={profile.followers + ' followers'} disabled={!allowed} onPress={() => toggle('followers')} />
        <Action label={profile.following + ' following'} disabled={!allowed} onPress={() => toggle('following')} />
      </View>
      <View style={styles.wrap}>
        {own ? <><Action primary label="Create memory" onPress={compose} />
          <Action label="Find people" onPress={() => toggle('discover')} />
          <Action label="Requests" onPress={() => toggle('requests')} /></>
          : <Action primary disabled={busy} label={profile.relation === 'accepted' ? 'Unfollow' :
            profile.relation === 'pending' ? 'Cancel request' : profile.is_private ? 'Request to follow' : 'Follow'}
            onPress={() => change(owner, profile.relation === 'none' ? 'follow' : 'unfollow')} />}
      </View>
      {list && allowed && <View style={styles.section}><Text style={styles.subhead}>{
        { discover: 'Find people', followers: 'Followers', following: 'Following', requests: 'Follow requests', profile: '', friends: '' }[list]
      }</Text><People key={revision + list} social={social} owner={owner} kind={list}
        choose={p => visit(p.id)} respond={own && (list === 'requests' || list === 'followers') ? change : undefined} /></View>}
      <Text style={styles.subhead}>Memories</Text>
      {allowed ? <MemoryFeed key={revision} social={social} owner={owner} visit={visit} /> :
        <Text style={styles.note}>Follow this private profile to see its memories.</Text>}
    </>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12, paddingBottom: 42 }, identity: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  heading: { fontSize: 28, fontWeight: '800', color: '#30352E', letterSpacing: -1 },
  monogram: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#E5EAD9', alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 30, color: '#566C43', fontWeight: '700' }, note: { fontSize: 12, lineHeight: 18, color: '#666D60', marginVertical: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, action: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#DCDDD2', alignSelf: 'flex-start' },
  actionText: { fontSize: 12, color: '#394334', fontWeight: '700' }, primary: { backgroundColor: '#566C43', borderColor: '#566C43' },
  section: { padding: 12, backgroundColor: '#FFFDF9', borderRadius: 12 }, subhead: { fontSize: 19, fontWeight: '800', color: '#30352E', marginVertical: 8 },
  input: { backgroundColor: 'white', padding: 10, borderColor: '#DBDED3', borderWidth: 1, borderRadius: 8, marginVertical: 8 },
  person: { fontWeight: '700', color: '#30352E' }, row: { flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomColor: '#E8E7DF', borderBottomWidth: 1 },
  print: { padding: 9, paddingBottom: 14, backgroundColor: 'white', borderColor: '#E5E2D9', borderWidth: 1, marginVertical: 8 },
  photo: { width: '100%', aspectRatio: 1.5, backgroundColor: '#EEEDE6' }, caption: { fontSize: 20, color: '#35402D', fontStyle: 'italic', marginTop: 9 },
  nameLink: { color: '#596D47', fontWeight: '700', paddingVertical: 5 },
});
