import { randomUUID } from 'expo-crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import catalog from './friend-quests.json';
import type { AgeBand } from './quest-age';
import prompts from './memory-prompts.json';
import type { Byline, Cursor, Reply } from './social';
import type { TaskPlace } from './task-location';
import type { Nearby, Offer } from './nearby';

export type Mode = 'solo' | 'group';
export type Space = Cursor & { name: string; mode: Mode; ageBand?: AgeBand; people: Byline[] };
export type Task = { id: string; title: string; prompt: string; minutes: number; setting: string; result?: string; nearby?: Nearby };
export type StartSpace = { id: string; name: string; mode: Mode; friends: Byline[]; place: TaskPlace; offer?: Offer; ageBand?: AgeBand };
export interface Spaces {
  start(input: StartSpace): Promise<string>;
  setRange(group:string,band?:AgeBand):Promise<void>;
  addQuest(group:string,key:string):Promise<void>;
  list(before?: Cursor): Promise<Space[]>;
  room(id: string): Promise<{ space: Space; tasks: Task[] }>;
  messages(id: string, before?: Cursor): Promise<Reply[]>;
  watchMessages?(group: string, refresh: () => void, connection: (ready: boolean) => void): () => void;
  send(group: string, body: string, id: string): Promise<void>;
}
const projection = 'id,name,memory_mode,quest_age,created_at,group_members(user_id,profiles(display_name))';
type PersonJoin = { user_id: string; profiles: { display_name: string } | null };
type GroupRow = { id: string; name: string; memory_mode: Mode; quest_age?: AgeBand; created_at: string; group_members: PersonJoin[] };

// Normalize Supabase's nested rows once for both list and room views.
// A missing display name still leaves the member identifiable by ID.
function asSpace(row: GroupRow): Space {
  return { id: row.id, name: row.name, mode: row.memory_mode, ageBand:row.quest_age, created: row.created_at,
    people: row.group_members.map(m => ({ id: m.user_id, name: m.profiles?.display_name || 'Member' })) };
}

// Read rooms, tasks and messages as the signed-in member. Cursors refer to
// server timestamps plus IDs so equal timestamps have a consistent order.
export function connectedSpaces(db: SupabaseClient): Spaces {
  // Break timestamp ties with the UUID returned by the previous read.
  // Both room and message queries use that same descending order.
  const older = (c: Cursor) => 'created_at.lt.' + c.created + ',and(created_at.eq.' + c.created + ',id.lt.' + c.id + ')';
  return {
    // Send the accepted place label and participant IDs. The database checks
    // mutual follows and assigns all three tasks in the creation transaction.
    async start(input) {
      const common = { gid: input.id, mode: input.mode, space_name: input.name, companions: input.friends.map(f => f.id) };
      const { data, error } = input.mode === 'group' && input.ageBand ? await db.rpc('start_age_space', {
        gid:input.id, space_name:input.name, companions:common.companions, age_range:input.ageBand,
        place_context:input.place.key, locality_name:input.place.key==='locality'?input.place.name:null, offer_id:input.offer?.id ?? null,
      }) : input.offer ? await db.rpc('start_nearby_memory_space', { ...common, offer_id:input.offer.id })
        : await db.rpc('start_memory_space', { ...common, place_context: input.place.key,
        locality_name: input.place.key === 'locality' ? input.place.name : null });
      if (error) throw new Error(error.message);
      return data as string;
    },
    // Save the shared browsing preference without changing assigned tasks.
    // The database checks that the requesting user belongs to this group.
    async setRange(group,band) {
      const {error}=await db.rpc('set_group_quest_range',{gid:group,age_range:band ?? null});
      if (error) throw error;
    },
    // Assign a catalog entry to the existing room. The RPC rechecks
    // membership and the saved age range before accepting the entry.
    async addQuest(group,key) {
      const {error}=await db.rpc('add_friend_quest',{gid:group,prompt_key:key});
      if (error) throw error;
    },
    // Exclude legacy posting groups from the list. Membership policies
    // include spaces created by a friend as well as the current person's.
    async list(before) {
      let query = db.from('groups').select(projection).not('memory_mode', 'is', null);
      if (before) query = query.or(older(before));
      const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(24);
      if (error) throw error;
      return (data as unknown as GroupRow[]).map(asSpace);
    },
    // Read the room with its members and load the tasks and their resulting
    // memories using the same signed-in viewer's permissions.
    async room(id) {
      const [group, assignments] = await Promise.all([
        db.from('groups').select(projection).eq('id', id).not('memory_mode', 'is', null).single(),
        db.from('quests').select('id,title,prompt,minutes,setting,nearby,memories(id)').eq('group_id', id).order('id'),
      ]);
      if (group.error) throw group.error;
      if (assignments.error) throw assignments.error;
      return { space: asSpace(group.data as unknown as GroupRow),
        tasks: assignments.data.map(q => ({ ...q, result: q.memories[0]?.id })) };
    },
    // Subscribe only to durable inserts for this room. Joined history reads
    // supply author names and recheck access, including after a reconnect.
    watchMessages(group, refresh, connection) {
      let active = true;
      const channel = db.channel('chat-' + group + '-' + randomUUID(), {
        config: { postgres_changes_options: { wait: true } },
      }).on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'space_messages', filter: 'group_id=eq.' + group,
      }, () => { if (active) refresh(); }).subscribe(status => {
        if (!active) return;
        connection(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') refresh();
      });
      return () => { active = false; void db.removeChannel(channel); };
    },
    // Page through just this group's chat with each author's display name.
    // Returning the newest page also supplies incoming messages to open chats.
    async messages(id, before) {
      let query = db.from('space_messages').select('id,body,created_at,author_id,profiles(display_name)').eq('group_id', id);
      if (before) query = query.or(older(before));
      const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(24);
      if (error) throw error;
      return data.map(m => ({ id: m.id, body: m.body, created: m.created_at, author: { id: m.author_id,
        name: (m.profiles as unknown as { display_name: string } | null)?.display_name || 'Member' } }));
    },
    // Keep the caller's message ID on retry. The server supplies author and
    // creation time so clients can only speak for themselves.
    async send(group, body, id) {
      const { error } = await db.from('space_messages').upsert({ group_id: group, id, body: body.trim() },
        { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error;
    },
  };
}

// Give the guest an isolated room collection for this session. Each room
// has one keepsake, one discovery and one place prompt, as in the database.
export function previewSpaces(me: Byline) {
  const rooms = new Map<string, { space: Space; tasks: Task[]; messages: Reply[] }>();
  // Fail closed for an unknown room, just like the member-only server read.
  // All guest mutations look up the room in the current session's collection.
  function room(id: string) {
    const found = rooms.get(id);
    if (!found) throw new Error('Space unavailable.');
    return found;
  }
  // Page a newest-first guest collection from the last visible item.
  // Insertions at the top do not shift the next page.
  function page<T extends Cursor>(items: T[], before?: Cursor) {
    const start = before ? items.findIndex(row => row.id === before.id) + 1 : 0;
    return items.slice(start, start + 24);
  }
  return {
    // Mirror the three prompt families for the demo and retain its result
    // locally until the user leaves preview.
    async start(input: StartSpace) {
      if (rooms.has(input.id)) return input.id;
      const eligible = prompts.filter(p => p.mode === 'any' || p.mode === input.mode);
      const tasks = ['keepsake','discovery','place'].map(family => {
        if (family === 'place' && input.offer) return { id:randomUUID(), title:input.offer.title, prompt:input.offer.prompt,
          minutes:10, setting:'anywhere', nearby:input.offer.nearby };
        const context = family === 'place' ? input.place.key : 'anywhere';
        const pool = eligible.filter(p => p.family === family && p.context === context);
        const tailored = input.mode === 'group' && context === 'anywhere' ? catalog.filter(q => q.family===family && (!input.ageBand || q.band===input.ageBand)) : [];
        const options = input.ageBand && tailored.length ? tailored : [...pool,...tailored];
        const choice = options[Math.floor(Math.random() * options.length)];
        const prompt = input.place.key === 'locality' ? choice.prompt.replace('{place}', input.place.name) : choice.prompt;
        return { ...choice, prompt, id: randomUUID() };
      });
      rooms.set(input.id, { space: { id: input.id, mode: input.mode, ageBand:input.ageBand, name: input.name,
        people: [me,...input.friends], created: new Date().toISOString() }, tasks, messages: [] });
      return input.id;
    },
    // Update the preview group's preference for future assignments.
    // Its task list and saved photos stay attached to the room.
    async setRange(group:string,band?:AgeBand) {
      room(group).space.ageBand=band;
    },
    // Keep preview additions in the same room, once per quest title.
    // Only the catalog for the room's selected range is eligible.
    async addQuest(group:string,key:string) {
      const r=room(group);
      const q=catalog.find(item=>item.key===key && (!r.space.ageBand || item.band===r.space.ageBand));
      if (!q || r.space.mode!=='group') throw new Error('Quest unavailable');
      if (!r.tasks.some(t=>t.title===q.title)) r.tasks.push({...q,id:randomUUID()});
    },
    // Reopen guest-created rooms in reverse creation order.
    // The preview uses the same page boundaries as the connected board.
    async list(before?: Cursor) { return page([...rooms.values()].reverse().map(r => r.space), before); },
    // Resolve one room from this session and expose its assignments.
    // Using the same lookup for writes keeps preview rooms isolated.
    async room(id: string) { return room(id); },
    // Page the selected room's thread. A fresh read always starts at the
    // latest message, allowing the connected chat UI to run unchanged.
    async messages(id: string, before?: Cursor) { return page(room(id).messages, before); },
    // Accept one entry per send request in a group chat. Solo spaces do
    // not have a chat destination.
    async send(group: string, body: string, id: string) {
      const r = room(group);
      if (r.space.mode !== 'group' || !body.trim() || body.length > 1000) throw new Error('Message unavailable.');
      if (!r.messages.some(m => m.id === id)) r.messages.unshift({ id, author: me, body: body.trim(), created: new Date().toISOString() });
    },
    // Tie one photo memory to one assigned task. Return the room's own
    // membership so completion cannot attach an unrelated set of people.
    complete(group: string, taskId: string, memory: string) {
      const r = room(group);
      const task = r.tasks.find(q => q.id === taskId);
      if (!task || (task.result && task.result !== memory)) throw new Error('This task already has a memory.');
      task.result = memory;
      return r.space;
    },
  };
}
