import type { ImagePickerAsset } from 'expo-image-picker';
import { toByteArray } from 'base64-js';
import { supabase } from './supabase';

export type Person = {
  id: string; display_name: string; is_private: boolean; followers: number;
  following: number; relation: 'none' | 'pending' | 'accepted'; follows_me: boolean;
};
export type PeopleList = 'profile' | 'discover' | 'friends' | 'requests' | 'followers' | 'following';
export type FollowAction = 'follow' | 'unfollow' | 'approve' | 'decline' | 'remove';
export type Byline = { id: string; name: string };
export type Activity = { likes: number; liked: boolean; comments: number };
export type Cursor = { id: string; created: string };
export type Memory = Cursor & { caption: string; quest: string; image: string; people: Byline[]; group?: string; activity: Activity };
export type Reply = Cursor & { author: Byline; body: string };
export const PAGE_SIZE = 24;
export const SAMPLE_IDS = [
  '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000002',
  '00000000-0000-4000-a000-000000000003',
];
export type Draft = {
  id: string; caption: string; quest: string; asset: ImagePickerAsset; group: string; people: Byline[];
};
export interface Social {
  me: string;
  preview: boolean;
  people(kind: PeopleList, owner: string, search?: string, offset?: number): Promise<Person[]>;
  follow(person: string, action: FollowAction): Promise<void>;
  privacy(privateProfile: boolean): Promise<void>;
  memories(owner: string, offset?: number): Promise<Memory[]>;
  feed(before?: Cursor): Promise<Memory[]>;
  memory(id: string): Promise<Memory | undefined>;
  like(id: string, wanted: boolean): Promise<Activity>;
  replies(id: string, before?: Cursor): Promise<Reply[]>;
  comment(id: string, body: string, requestId: string): Promise<Activity>;
  publish(draft: Draft): Promise<void>;
}

// All reads and writes use the signed-in user's Supabase client. The database
// checks membership, privacy and request ownership independently of the UI.
export function connectedSocial(me: string): Social {
  if (!supabase) throw new Error('Connect Supabase to use profiles.');
  const db = supabase;
  const photos = db.storage.from('memory-photos');
  // Page by timestamp and ID together so newer posts or identical timestamps
  // cannot shift items between pages. Both cursor fields come from stored rows.
  function olderThan(cursor: Cursor) {
    return 'created_at.lt.' + cursor.created + ',and(created_at.eq.' + cursor.created + ',id.lt.' + cursor.id + ')';
  }

  // Keep profile grids, the home feed and shared links on one read path.
  // Row policies decide visibility before fetching counts or signing images.
  async function readMemories(options: { owner?: string; id?: string; before?: Cursor; offset?: number }): Promise<Memory[]> {
    let query = db.from('memories').select(
      'id,caption,quest_title,image_path,created_at,groups(name),match:memory_people!inner(person_id),people:memory_people(person_id,profiles(display_name))'
    );
    if (options.owner) query = query.eq('match.person_id', options.owner);
    else if (options.id) query = query.eq('id', options.id);
    else query = query.eq('profile_post', true);
    if (options.before) query = query.or(olderThan(options.before));
    const offset = options.offset ?? 0;
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data.length) return [];
    const [signed, stats] = await Promise.all([
      photos.createSignedUrls(data.map(row => row.image_path), 300),
      db.rpc('memory_activity', { ids: data.map(row => row.id) }),
    ]);
    if (signed.error) throw signed.error;
    if (stats.error) throw stats.error;
    const urls = new Map(signed.data.map(entry => [entry.path, entry.signedUrl]));
    const activities = new Map((stats.data as (Activity & { memory_id: string })[]).map(a => [a.memory_id, a]));
    return data.flatMap(row => {
      const activity = activities.get(row.id);
      if (!activity) return [];
      return [{ id: row.id, caption: row.caption, quest: row.quest_title || 'Memory', created: row.created_at, activity,
        image: urls.get(row.image_path) || '', group: (row.groups as unknown as { name: string } | null)?.name,
        people: row.people.map(p => ({
          id: p.person_id, name: (p.profiles as unknown as { display_name: string } | null)?.display_name || 'Member',
        })),
      }];
    });
  }
  return {
    me, preview: false,
    async people(kind, owner, search = '', offset = 0) {
      const { data, error } = await db.rpc('profile_people', {
        kind, owner_id: owner, search_text: search, skip_rows: offset,
      });
      if (error) throw error;
      return data as Person[];
    },
    async follow(person, action) {
      const { error } = await db.rpc('change_follow', { person, action });
      if (error) throw error;
    },
    async privacy(privateProfile) {
      const { error } = await db.rpc('set_profile_privacy', { private_profile: privateProfile });
      if (error) throw error;
    },
    memories: (owner, offset = 0) => readMemories({ owner, offset }),
    feed: before => readMemories({ before }),
    memory: async id => (await readMemories({ id }))[0],
    async like(id, wanted) {
      const { data, error } = await db.rpc('set_memory_like', { mid: id, wanted }).single();
      if (error) throw error;
      return data as Activity;
    },
    async replies(id, before) {
      let query = db.from('memory_comments').select('id,body,created_at,author_id,profiles(display_name)').eq('memory_id', id);
      if (before) query = query.or(olderThan(before));
      const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE);
      if (error) throw error;
      return data.map(row => ({ id: row.id, created: row.created_at, body: row.body,
        author: { id: row.author_id, name: (row.profiles as unknown as { display_name: string } | null)?.display_name || 'Member' } }));
    },
    async comment(id, body, requestId) {
      const result = await db.from('memory_comments').upsert({ id: requestId, memory_id: id, body: body.trim() },
        { onConflict: 'id', ignoreDuplicates: true });
      if (result.error) throw result.error;
      const { data, error } = await db.rpc('memory_activity', { ids: [id] }).single();
      if (error) throw error;
      return data as Activity;
    },
    async publish(draft) {
      const file = draft.asset.file;
      const bytes = file ? await file.arrayBuffer() : draft.asset.base64 ? toByteArray(draft.asset.base64) : null;
      if (!bytes || !bytes.byteLength) throw new Error('Please choose the photo again.');
      if (bytes.byteLength > 12 * 1024 * 1024) throw new Error('Choose a photo smaller than 12 MB.');
      const path = me + '/' + draft.id;
      const uploaded = await photos.upload(path, bytes, { contentType: file?.type || 'image/jpeg' });
      // A retried draft can already own its object after an interrupted publish.
      // The object key is unique to both the current user and this specific photo.
      if (uploaded.error && !/already exists|duplicate/i.test(uploaded.error.message)
          && uploaded.error.statusCode !== '409') throw uploaded.error;
      const { error } = await db.rpc('publish_memory', {
        mid: draft.id, caption_text: draft.caption, quest_name: draft.quest,
        group_name: draft.group, companions: draft.people.map(p => p.id),
      });
      if (error) throw error;
    },
  };
}

// The guest has an isolated example network with mutual friends and one
// incoming request. Leaving preview discards changes and makes no network writes.
export function previewSocial(): Social {
  const me = 'jamie';
  const profiles = [
    { id: me, display_name: 'Jamie Davis', is_private: true },
    { id: 'alex', display_name: 'Alex Chen', is_private: false },
    { id: 'sam', display_name: 'Sam Rivera', is_private: true },
    { id: 'riley', display_name: 'Riley Park', is_private: false },
  ];
  const edges = new Map<string, 'accepted' | 'pending'>([
    ['jamie:alex', 'accepted'], ['alex:jamie', 'accepted'], ['jamie:sam', 'accepted'],
    ['sam:jamie', 'accepted'], ['riley:jamie', 'pending'],
  ]);
  const memories: Omit<Memory,'activity'>[] = [
    { id: SAMPLE_IDS[2], caption: 'The coin picked the bakery.', quest: 'Take the scenic wrong turn',
      people: [{ id: 'alex', name: 'Alex Chen' }, { id: 'riley', name: 'Riley Park' }],
      image: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=700', created: '2026-11-01' },
    { id: SAMPLE_IDS[0], caption: 'We took the long way home.', quest: 'Take the scenic wrong turn',
      people: [{ id: me, name: 'Jamie Davis' }, { id: 'alex', name: 'Alex Chen' }],
      image: 'https://images.unsplash.com/photo-1472396961693-142e6e269027?w=700', created: '2026-10-31' },
    { id: SAMPLE_IDS[1], caption: 'Michelin stars? Absolutely none.', quest: 'Kitchen chaos',
      people: [{ id: me, name: 'Jamie Davis' }, { id: 'sam', name: 'Sam Rivera' }],
      image: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=700', created: '2026-10-29' },
  ];
  const status = (a: string, b: string) => edges.get(a + ':' + b) || 'none';
  const hearts = new Set<string>();
  const threads = new Map<string, Reply[]>();
  const activity = (id: string): Activity => ({ liked: hearts.has(id), likes: Number(hearts.has(id)), comments: threads.get(id)?.length || 0 });
  // Resolve the preview audience on each read so changing a relationship
  // affects profile pages, the feed and direct memory links consistently.
  function visible() {
    return memories.filter(m => m.people.some(p => p.id === me) || m.people.every(p =>
      !profiles.find(profile => profile.id === p.id)?.is_private || status(me,p.id) === 'accepted'
    )).map(m => ({ ...m, activity: activity(m.id) }));
  }
  // Locate the last item by ID in the in-memory preview collection. New rows
  // can be inserted at the top between requests without repeating a page.
  function page<T extends Cursor>(rows: T[], before?: Cursor) {
    const start = before ? rows.findIndex(row => row.id === before.id) + 1 : 0;
    return rows.slice(start, start + PAGE_SIZE);
  }
  return {
    me, preview: true,
    async people(kind, owner, search = '', offset = 0) {
      const result = profiles.filter(p => {
        if (!p.display_name.toLowerCase().includes(search.toLowerCase())) return false;
        switch (kind) {
          case 'profile': return p.id === owner;
          case 'discover': return p.id !== me;
          case 'friends': return status(me,p.id) === 'accepted' && status(p.id,me) === 'accepted';
          case 'requests': return status(p.id,me) === 'pending';
          case 'followers': return status(p.id,owner) === 'accepted';
          case 'following': return status(owner,p.id) === 'accepted';
        }
      });
      return result.slice(offset, offset + 30).map(p => ({
        ...p, relation: status(me,p.id), follows_me: status(p.id,me) === 'accepted',
        followers: profiles.filter(other => status(other.id,p.id) === 'accepted').length,
        following: profiles.filter(other => status(p.id,other.id) === 'accepted').length,
      }));
    },
    async follow(person, action) {
      const pair = me + ':' + person;
      const reverse = person + ':' + me;
      if (action === 'follow') edges.set(pair, profiles.find(p => p.id === person)?.is_private ? 'pending' : 'accepted');
      if (action === 'unfollow') edges.delete(pair);
      if (action === 'approve') edges.set(reverse, 'accepted');
      if (action === 'decline' || action === 'remove') edges.delete(reverse);
    },
    async privacy(value) {
      profiles[0].is_private = value;
      if (!value) for (const [key, state] of edges) {
        if (key.endsWith(':' + me) && state === 'pending') edges.set(key, 'accepted');
      }
    },
    async memories(owner, offset = 0) {
      return visible().filter(m => m.people.some(p => p.id === owner)).slice(offset, offset + PAGE_SIZE);
    },
    async feed(before) { return page(visible(), before); },
    async memory(id) { return visible().find(m => m.id === id); },
    async like(id, wanted) {
      if (!visible().some(m => m.id === id)) throw new Error('Unavailable');
      if (wanted) hearts.add(id); else hearts.delete(id);
      return activity(id);
    },
    async replies(id, before) {
      if (!visible().some(m => m.id === id)) throw new Error('Unavailable');
      return page(threads.get(id) || [], before);
    },
    async comment(id, body, requestId) {
      if (!visible().some(m => m.id === id) || !body.trim() || body.length > 500) throw new Error('Unavailable');
      const rows = threads.get(id) || [];
      if (!rows.some(row => row.id === requestId)) threads.set(id, [{ id: requestId, body: body.trim(),
        author: { id: me, name: 'Jamie Davis' }, created: new Date().toISOString() }, ...rows]);
      return activity(id);
    },
    async publish(draft) {
      if (!memories.some(m => m.id === draft.id)) memories.unshift({
        id: draft.id, caption: draft.caption, image: draft.asset.uri, quest: draft.quest, group: draft.group, created: new Date().toISOString(),
        people: [{ id: me, name: 'Jamie Davis' }, ...draft.people],
      });
    },
  };
}
