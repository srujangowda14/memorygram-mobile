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
export type Memory = { id: string; caption: string; quest: string; image: string; people: Byline[]; created: string; group?: string };
export type Draft = {
  id: string; caption: string; quest: string; asset: ImagePickerAsset; group: string; people: Byline[];
};
export interface Social {
  me: string;
  people(kind: PeopleList, owner: string, search?: string, offset?: number): Promise<Person[]>;
  follow(person: string, action: FollowAction): Promise<void>;
  privacy(privateProfile: boolean): Promise<void>;
  memories(owner: string, offset?: number): Promise<Memory[]>;
  publish(draft: Draft): Promise<void>;
}

// All reads and writes use the signed-in user's Supabase client. The database
// checks membership, privacy and request ownership independently of the UI.
export function connectedSocial(me: string): Social {
  if (!supabase) throw new Error('Connect Supabase to use profiles.');
  const db = supabase;
  const photos = db.storage.from('memory-photos');
  return {
    me,
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
    async memories(owner, offset = 0) {
      const { data, error } = await db.from('memories').select(
        'id,caption,quest_title,image_path,created_at,groups(name),match:memory_people!inner(person_id),people:memory_people(person_id,profiles(display_name))'
      ).eq('match.person_id', owner).order('created_at', { ascending: false }).order('id')
        .range(offset, offset + 23);
      if (error) throw error;
      if (!data.length) return [];
      const signed = await photos.createSignedUrls(data.map(row => row.image_path), 300);
      if (signed.error) throw signed.error;
      const urls = new Map(signed.data.map(entry => [entry.path, entry.signedUrl]));
      return data.map(row => ({
        id: row.id, caption: row.caption, quest: row.quest_title || 'Memory', created: row.created_at,
        image: urls.get(row.image_path) || '', group: (row.groups as unknown as { name: string } | null)?.name,
        people: row.people.map(p => ({
          id: p.person_id, name: (p.profiles as unknown as { display_name: string } | null)?.display_name || 'Member',
        })),
      }));
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
  const memories: Memory[] = [
    { id: 'trail', caption: 'We took the long way home.', quest: 'Take the scenic wrong turn',
      people: [{ id: me, name: 'Jamie Davis' }, { id: 'alex', name: 'Alex Chen' }],
      image: 'https://images.unsplash.com/photo-1472396961693-142e6e269027?w=700', created: '2026-10-31' },
    { id: 'dinner', caption: 'Michelin stars? Absolutely none.', quest: 'Kitchen chaos',
      people: [{ id: me, name: 'Jamie Davis' }, { id: 'sam', name: 'Sam Rivera' }],
      image: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=700', created: '2026-10-29' },
  ];
  const status = (a: string, b: string) => edges.get(a + ':' + b) || 'none';
  return {
    me,
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
      return memories.filter(m => m.people.some(p => p.id === owner) && (
        m.people.some(p => p.id === me) || m.people.every(p =>
          !profiles.find(profile => profile.id === p.id)?.is_private || status(me,p.id) === 'accepted')
      )).slice(offset, offset + 24);
    },
    async publish(draft) {
      if (!memories.some(m => m.id === draft.id)) memories.unshift({
        id: draft.id, caption: draft.caption, image: draft.asset.uri, quest: draft.quest, group: draft.group, created: new Date().toISOString(),
        people: [{ id: me, name: 'Jamie Davis' }, ...draft.people],
      });
    },
  };
}
