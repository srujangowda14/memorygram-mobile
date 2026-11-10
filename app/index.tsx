import { ProfileSetup } from '@/lib/profile-setup';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { connectedSocial, previewSocial, SAMPLE_IDS } from '@/lib/social';
import { Action, HomeTimeline, MemoryFeed, Profile, SharedMemory } from '@/lib/profile-ui';
import { rememberMemory, validMemoryId } from '@/lib/memory-links';
import { SpaceList, SpaceRoom, StartMemory } from '@/lib/space-ui';
import { MemoryComposer } from '@/lib/memory-composer';
import * as Apple from 'expo-apple-authentication';
import type { Session } from '@supabase/supabase-js';
import { signIn, type Provider } from '@/lib/auth';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '@/lib/supabase';

import friendQuests from '@/lib/friend-quests.json';
import { ageBands, type AgeBand } from '@/lib/quest-age';

type Quest = { id: string; title: string; prompt: string; emoji: string; minutes: number; place: string; people: string; tag: string };
const quests: Quest[] = [
  { id:'album', title:'The album cover nobody asked for', prompt:'Recreate an iconic album cover with whatever is nearby.', emoji:'💿', minutes:30, place:'indoors', people:'Friends', tag:'GROUP FAVORITE' },
  { id:'wrong-turn', title:'Take the scenic wrong turn', prompt:'Let a coin pick your turns. Photograph one new thing.', emoji:'🧭', minutes:15, place:'outdoors', people:'Solo or friends', tag:'LITTLE ADVENTURE' },
  { id:'museum', title:'A very serious tiny museum', prompt:'Curate three ordinary objects. Give them wild backstories.', emoji:'🏛️', minutes:5, place:'indoors', people:'Solo or friends', tag:'CREATIVE CHAOS' },
  { id:'clouds', title:'Clouds with questionable careers', prompt:'Find a cloud. Decide its profession. Defend it with a photo.', emoji:'☁️', minutes:5, place:'outdoors', people:'Solo or friends', tag:'HEAD IN CLOUDS' },
];
// Restore the Supabase session before showing private UI.
// Preview runs in a separately keyed tree so its state cannot cross accounts.
export default function Home() {
  const params = useLocalSearchParams<{ memory?: string; demo?: string }>();
  const sharedId = validMemoryId(params.memory) ? params.memory : undefined;
  const sample = params.demo === '1' && !!sharedId && SAMPLE_IDS.includes(sharedId);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabase);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (next || event === 'SIGNED_OUT') setPreview(false);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!ready) return <SafeAreaView style={s.safe}><ActivityIndicator accessibilityLabel="Restoring session" /></SafeAreaView>;
  if (!session && !sample && (!preview || sharedId)) return <Welcome memory={sharedId} onPreview={() => setPreview(true)} />;
  const activeSession = sample ? null : session;
  const home = <Hangout key={activeSession?.user.id ?? 'preview'} session={activeSession} sharedId={sharedId}
    clearShared={() => { if (sample && !session) setPreview(true); router.replace('/'); }}
    exitPreview={() => { setPreview(false); if (sharedId) router.replace('/'); }} />;
  return activeSession ? <ProfileSetup key={activeSession.user.id} userId={activeSession.user.id}>{home}</ProfileSetup> : home;
}

// Show the existing scrapbook experience for the current account or guest.
// The account menu exposes the signed-in identity and device-local sign-out.
function Hangout({ session, exitPreview, sharedId, clearShared }: {
  session: Session | null; exitPreview: () => void; sharedId?: string; clearShared: () => void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [accountError, setAccountError] = useState('');
  const account = session?.user.email || (session ? 'Signed-in member' : 'Guest preview');

  // Sign out this device through Supabase, or leave the local preview.
  // Retain the account view on failure so the user can retry.
  async function leave() {
    if (!session) return exitPreview();
    if (!supabase || leaving) return;
    setLeaving(true);
    setAccountError('');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch {
      setAccountError('Could not sign out. Check your connection and try again.');
    } finally {
      setLeaving(false);
    }
  }
  const userId = session?.user.id;
  const social = useMemo(() => userId ? connectedSocial(userId) : previewSocial(), [userId]);
  const [tab, setTab] = useState<'home'|'quests'|'scrapbook'|'profile'>('home');
  const [starting, setStarting] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [owner, setOwner] = useState(social.me);
  const [revision, setRevision] = useState(0);
  const [filters, setFilters] = useState({ inside:false, quick:false });
  const [selected, setSelected] = useState<{ title: string; prompt?: string } | null>(null);
  const [privateProfile, setPrivateProfile] = useState<boolean | null>(null);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const privacyLock = useRef(false);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') setRevision(v => v + 1);
    });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!accountOpen) return;
    let current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear stale privacy controls while fetching the selected account.
    setPrivateProfile(null); setAccountError('');
    social.people('profile', social.me).then(rows => {
      if (!rows[0]) throw new Error();
      if (current) setPrivateProfile(rows[0].is_private);
    }).catch(() => { if (current) setAccountError('Privacy settings could not be loaded. Reopen settings to retry.'); });
    return () => { current = false; };
  }, [accountOpen, social]);

  // Save privacy on the account itself and refresh any visible profile/feed.
  // A failed write leaves the switch at the last confirmed setting.
  async function changePrivacy(value: boolean) {
    if (privacyLock.current) return;
    privacyLock.current = true; setSavingPrivacy(true); setAccountError('');
    try {
      await social.privacy(value); setPrivateProfile(value); setRevision(v => v + 1);
    } catch { setAccountError('Could not save privacy. Please try again.'); }
    finally { privacyLock.current = false; setSavingPrivacy(false); }
  }

  // Opening a byline or directory result changes the profile being viewed.
  // Tapping Profile in navigation always returns to the signed-in person's page.
  function visit(id: string) {
    if (sharedId) clearShared();
    setRoomId(''); setOwner(id); setTab('profile'); setRevision(v => v + 1);
  }
  // Move a newly created or reopened space onto the quest board. Returning
  // from a shared link clears that link before displaying member-only tasks.
  function openSpace(id: string) {
    if (sharedId) clearShared();
    setStarting(false); setRoomId(id); setTab('quests');
  }
  const [boardRange,setBoardRange] = useState<AgeBand | 'All ages'>('All ages');
  const board = friendQuests.filter(q => boardRange==='All ages' || q.band===boardRange).map(q => ({
    ...q,id:q.key,place:q.setting,people:'Friends',tag:q.band,emoji:q.family==='discovery'?'🧭':q.family==='place'?'📍':'📸',
  }));
  const visible = [...board,...(boardRange==='All ages'?quests:[])].filter(q => (!filters.inside || q.place!=='outdoors') && (!filters.quick || q.minutes<=5));
  return <SafeAreaView style={s.safe}><View style={s.app}>
    <View style={s.header}><View><Text style={s.wordmark}><Text style={s.mark}>✳</Text> memorygram<Text style={{color:'#ED7041'}}>.</Text></Text>
      <Text style={s.group}>{session ? (tab === 'profile' ? 'PROFILE' : 'YOUR MEMORIES') : 'GUEST PREVIEW'}</Text></View>
      <Pressable accessibilityLabel={tab === 'profile' ? 'Profile settings' : 'Account'} accessibilityRole="button" style={s.avatar} onPress={() => setAccountOpen(true)}>
        <Ionicons name={tab === 'profile' ? 'settings-outline' : 'person-outline'} size={20} />
      </Pressable>
    </View>
    <Modal visible={accountOpen} transparent animationType="fade" onRequestClose={() => setAccountOpen(false)}>
      <View style={s.modalBg}><View style={s.modal}>
        <Text style={s.kicker}>ACCOUNT</Text><Text style={s.modalTitle}>{account}</Text>
        <View style={s.modalActions}><Text style={s.sectionTitle}>Private profile</Text>
          {privateProfile === null ? <Text style={s.later}>Unavailable</Text> :
            <Switch accessibilityLabel="Private profile" value={privateProfile} disabled={savingPrivacy || leaving} onValueChange={changePrivacy} />}
        </View>
        <Text style={s.sub}>A private profile approves followers. Going public accepts pending requests and makes eligible memories visible to signed-in people.</Text>
        {!!accountError && <Text accessibilityRole="alert" style={s.sub}>{accountError}</Text>}
        <View style={s.modalActions}>
          <Pressable onPress={() => setAccountOpen(false)}><Text style={s.later}>Close</Text></Pressable>
          <Pressable style={s.submit} disabled={leaving} onPress={leave}>
            <Text style={s.submitText}>{session ? (leaving ? 'Signing out…' : 'Sign out') : 'Exit preview'}</Text>
          </Pressable>
        </View>
      </View></View>
    </Modal>
    {roomId && !sharedId && <SpaceRoom key={roomId} social={social} id={roomId} visit={visit} back={() => setRoomId('')} />}
    {sharedId && <SharedMemory key={sharedId + revision} id={sharedId} social={social} visit={visit}
      back={() => { clearShared(); setTab('home'); }} />}
    {!roomId && !sharedId && tab==='home' && <HomeTimeline key={revision} social={social} visit={visit}
      compose={() => setStarting(true)} footer={<>
      <View style={s.hero}><Text style={s.heroKicker}>✦ THIS WEEK’S GROUP QUEST</Text><Text style={s.heroTitle}>Make an ordinary Tuesday{`\n`}a story worth telling.</Text><Text style={s.heroText}>Recreate an iconic album cover. With your people.</Text><Pressable style={s.darkButton} onPress={()=>setSelected(quests[0])}><Text style={s.darkButtonText}>Make a memory  ↗</Text></Pressable><Text style={s.heroArt}>📸</Text></View>
      <Section title="Your next “remember when”" action="See all" onAction={()=>setTab('quests')}/><QuestRow quest={visible[0]} onPress={setSelected}/><QuestRow quest={visible[1]} onPress={setSelected}/>
    </>} />}
    {!roomId && !sharedId && tab==='quests' && <View style={{flex:1}}><View style={s.pageHead}><Text style={s.pageTitle}>Quest board</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:5}}>{(['All ages',...ageBands] as const).map(b =>
        <Filter key={b} label={b} active={boardRange===b} onPress={()=>setBoardRange(b)}/>)}</View><View style={s.filterRow}><Filter label="Indoors" active={filters.inside} onPress={()=>setFilters({...filters,inside:!filters.inside})}/><Filter label="5 min" active={filters.quick} onPress={()=>setFilters({...filters,quick:!filters.quick})}/><View style={s.free}><Text style={s.freeText}>◉ Always $0</Text></View></View></View><FlatList data={visible} ListHeaderComponent={<SpaceList social={social} open={openSpace} />} contentContainerStyle={s.list} renderItem={({item})=><QuestRow quest={item} onPress={setSelected}/>} keyExtractor={q=>q.id}/></View>}
    {!roomId && !sharedId && tab === 'scrapbook' && <ScrollView contentContainerStyle={s.list}>
      <Text style={s.pageTitle}>Our scrapbook</Text><Text style={s.sub}>The memories you were part of.</Text>
      <View style={s.filterRow}><Action primary label="Create memory" onPress={() => setStarting(true)} />
        <Action label="Refresh" onPress={() => setRevision(v => v + 1)} /></View>
      <MemoryFeed key={revision} social={social} owner={social.me} visit={visit} />
    </ScrollView>}
    {!roomId && !sharedId && tab === 'profile' && <Profile key={owner + revision} social={social} owner={owner} visit={visit}
      compose={() => setStarting(true)} />}
    <View style={s.nav}>{([['home','home-outline','The hangout'],['quests','flag-outline','Quests'],['scrapbook','images-outline','Scrapbook'],['profile','person-outline','Profile']] as const)
      .map(([key,icon,label]) => <Fragment key={key}>{key === 'scrapbook' && <Pressable style={s.createButton} accessibilityRole="button"
        accessibilityLabel="Start a memory" onPress={() => setStarting(true)}><Ionicons name="add" size={29} color="white" /></Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel={label} style={s.navItem}
        onPress={() => { if (key === 'profile') visit(social.me); else { if (sharedId) clearShared(); setRoomId(''); setTab(key); } }}>
        <Ionicons name={icon} size={22} color={tab === key ? '#D9683D' : '#8C9086'} />
        <Text style={[s.navLabel,tab === key && s.active]}>{label}</Text></Pressable></Fragment>)}</View>
    {starting && <StartMemory social={social} close={() => setStarting(false)} open={openSpace}
      photo={() => { setStarting(false); setSelected({ title: 'Everyday memory' }); }} />}
    {selected && <MemoryComposer social={social} title={selected.title} prompt={selected.prompt} onClose={() => setSelected(null)}
      onPosted={() => { setSelected(null); visit(social.me); }} />}
  </View></SafeAreaView>;
}
// Offer provider sign-in when configured and keep guest preview available.
// Wait for the session subscription to admit the user after provider success.
function Welcome({ onPreview, memory }: { onPreview: () => void; memory?: string }) {
  const busy = useRef(false);
  const [pending, setPending] = useState<Provider | null>(null);
  const [message, setMessage] = useState('');
  const disabled = pending !== null;

  // Serialize button presses so a second login cannot replace the first verifier.
  // Treat device cancellation as a normal return to the welcome screen.
  async function start(provider: Provider) {
    if (!supabase) { setMessage('Sign-in needs the Supabase project URL and public key. Add them to the mobile environment and restart Expo.'); return; }
    if (busy.current) return;
    busy.current = true;
    setPending(provider);
    setMessage('');
    try {
      await rememberMemory(memory);
      await signIn(provider);
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ERR_REQUEST_CANCELED') {
        setMessage(error instanceof Error ? error.message : 'Sign-in could not be completed. Check your connection and try again.');
      }
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={{ flexGrow: 1 }}>
    <View style={s.welcome}>
      <Text style={s.welcomeMark}>✳</Text><Text style={s.welcomeName}>memorygram.</Text>
      <Text style={s.welcomeTitle}>{memory ? 'Sign in to view this memory' : 'Make a little mischief.'}</Text>
      <Text style={s.welcomeText}>Side quests for your favorite people. Photo proof required.</Text>
      <View style={s.welcomeArt}><Text style={{fontSize:75}}>📸</Text></View>
      <Pressable accessibilityRole="button" disabled={disabled} style={s.oauth} onPress={() => start('google')}>
        <Ionicons name="logo-google" size={18}/><Text style={s.oauthText}>Continue with Google</Text>
      </Pressable>
      {Platform.OS === 'ios' && supabase ? <View pointerEvents={disabled ? 'none' : 'auto'} style={{width:'100%', maxWidth:340}}>
        <Apple.AppleAuthenticationButton
          buttonType={Apple.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={Apple.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={10} style={{ height: 51 }} onPress={() => start('apple')} />
      </View> : <Pressable accessibilityRole="button" disabled={disabled} style={s.oauth} onPress={() => start('apple')}>
        <Ionicons name="logo-apple" size={20}/><Text style={s.oauthText}>Continue with Apple</Text>
      </Pressable>}
      {pending && <ActivityIndicator accessibilityLabel="Signing in" />}
      {!!message && <Text accessibilityRole="alert" style={s.welcomeText}>{message}</Text>}
      {!supabase && <Text style={s.welcomeText}>Connect Supabase to enable sign-in. Guest preview is available.</Text>}
      {memory ? <Pressable onPress={() => router.replace('/')}><Text style={s.previewLink}>Back to Memorygram</Text></Pressable>
        : <Pressable disabled={!!pending} onPress={onPreview}><Text style={s.previewLink}>Peek at the demo first</Text></Pressable>}
    </View>
  </ScrollView></SafeAreaView>;
}
function Section({title,action,onAction}:{title:string;action:string;onAction:()=>void}){return <View style={s.section}><Text style={s.sectionTitle}>{title}</Text><Pressable onPress={onAction}><Text style={s.action}>{action} ↗</Text></Pressable></View>}
function Filter({label,active,onPress}:{label:string;active:boolean;onPress:()=>void}){return <Pressable onPress={onPress} style={[s.filter,active&&s.filterOn]}><Text style={[s.filterText,active&&s.filterTextOn]}>{label}</Text></Pressable>}
function QuestRow({quest,onPress}:{quest:Quest;onPress:(q:Quest)=>void}){if(!quest)return null;return <Pressable style={s.quest} onPress={()=>onPress(quest)}><View style={s.questArt}><Text style={s.badge}>{quest.tag}</Text><Text style={s.emoji}>{quest.emoji}</Text></View><View style={s.questBody}><Text style={s.questTitle}>{quest.title}</Text><Text numberOfLines={2} style={s.questPrompt}>{quest.prompt}</Text><Text style={s.meta}>◷ {quest.minutes} min  ·  {quest.people}  ·  $0</Text><Text style={s.doIt}>Let’s do this ↗</Text></View></Pressable>}
const s=StyleSheet.create({ createButton:{height:46,width:46,alignSelf:'center',alignItems:'center',justifyContent:'center',borderRadius:23,backgroundColor:'#B7512D'},safe:{flex:1,backgroundColor:'#F9F7F1'},app:{flex:1,backgroundColor:'#F9F7F1'},welcome:{flex:1,padding:26,alignItems:'center',justifyContent:'center'},welcomeMark:{fontSize:48,color:'#ED7041'},welcomeName:{fontSize:27,fontWeight:'800',letterSpacing:-1.5,color:'#30352E',marginTop:4},welcomeTitle:{fontSize:35,lineHeight:39,fontWeight:'800',letterSpacing:-1.7,color:'#30352E',textAlign:'center',marginTop:30},welcomeText:{fontSize:14,lineHeight:21,color:'#85897E',textAlign:'center',marginTop:10,maxWidth:270},welcomeArt:{height:132,width:210,backgroundColor:'#E6EBD9',borderRadius:13,marginVertical:28,alignItems:'center',justifyContent:'center',transform:[{rotate:'-2deg'}]},tapeText:{fontSize:16,fontStyle:'italic',color:'#5A6749',marginTop:-10},oauth:{height:51,width:'100%',maxWidth:340,borderWidth:1,borderColor:'#DEDCD3',backgroundColor:'#FFFDF9',borderRadius:10,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10,marginBottom:10},oauthText:{fontSize:13,fontWeight:'700',color:'#343832'},previewLink:{fontSize:12,fontWeight:'700',color:'#C9623C',padding:12},privacy:{position:'absolute',bottom:24,fontSize:10,color:'#A0A398'},header:{padding:20,paddingBottom:12,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},wordmark:{fontSize:22,fontWeight:'800',letterSpacing:-1,color:'#30352E'},mark:{backgroundColor:'#ED7041',color:'white',borderRadius:8,overflow:'hidden',paddingHorizontal:6,paddingVertical:3},group:{fontSize:9,fontWeight:'700',color:'#7B8074',letterSpacing:1.1,marginTop:9},avatar:{height:38,width:38,borderRadius:19,backgroundColor:'#EAD9BE',alignItems:'center',justifyContent:'center'},scroll:{padding:20,paddingTop:6,paddingBottom:100},kicker:{fontSize:10,fontWeight:'800',letterSpacing:1.6,color:'#7B846B'},title:{fontSize:31,lineHeight:36,fontWeight:'800',letterSpacing:-1.4,color:'#30352E',marginTop:8},script:{color:'#ED7041',fontStyle:'italic',fontWeight:'600'},sub:{fontSize:13,lineHeight:20,color:'#85897E',marginTop:8},hero:{backgroundColor:'#E5EAD9',borderColor:'#D5DDC8',borderWidth:1,borderRadius:15,padding:22,marginTop:24,overflow:'hidden',minHeight:234},heroKicker:{fontWeight:'800',letterSpacing:1.2,fontSize:10,color:'#6E7A56'},heroTitle:{fontWeight:'800',fontSize:22,lineHeight:28,letterSpacing:-.7,color:'#35402D',marginTop:12},heroText:{fontSize:12,color:'#77806C',marginTop:8},darkButton:{alignSelf:'flex-start',backgroundColor:'#566C43',paddingHorizontal:16,paddingVertical:12,borderRadius:8,marginTop:19},darkButtonText:{color:'white',fontSize:12,fontWeight:'700'},heroArt:{position:'absolute',right:8,bottom:-7,fontSize:104,transform:[{rotate:'-12deg'}],opacity:.9},stats:{flexDirection:'row',paddingVertical:23,borderBottomWidth:1,borderColor:'#E6E5DC',justifyContent:'space-between'},stat:{flex:1,flexDirection:'row',gap:7,alignItems:'center'},statIcon:{fontSize:18},statValue:{fontSize:16,fontWeight:'800',color:'#30352E'},statLabel:{fontSize:7,fontWeight:'700',color:'#92968A',marginTop:3},section:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:25,marginBottom:12},sectionTitle:{fontSize:17,fontWeight:'800',letterSpacing:-.5,color:'#30352E'},action:{fontSize:11,color:'#C96038',fontWeight:'700'},quest:{flexDirection:'row',backgroundColor:'#FFFDF9',borderWidth:1,borderColor:'#E7E5DC',borderRadius:12,overflow:'hidden',marginBottom:13},questArt:{width:102,minHeight:145,backgroundColor:'#EFE5D5',justifyContent:'center',alignItems:'center'},badge:{position:'absolute',top:9,left:8,fontSize:7,fontWeight:'800',color:'#8B795A'},emoji:{fontSize:47},questBody:{flex:1,padding:13},questTitle:{fontSize:14,fontWeight:'800',letterSpacing:-.3,color:'#373B34'},questPrompt:{fontSize:11,lineHeight:16,color:'#85897F',marginTop:6},meta:{fontSize:9,color:'#909487',marginTop:10},doIt:{fontSize:11,color:'#CF653C',fontWeight:'800',marginTop:9},pageHead:{paddingHorizontal:20,paddingTop:8,paddingBottom:16},pageTitle:{fontSize:29,fontWeight:'800',letterSpacing:-1,color:'#30352E'},filterRow:{flexDirection:'row',gap:8,alignItems:'center',marginTop:17},filter:{borderWidth:1,borderColor:'#D9DDD2',paddingVertical:7,paddingHorizontal:10,borderRadius:18,backgroundColor:'#FEFDF9'},filterOn:{backgroundColor:'#E9EEDC',borderColor:'#829067'},filterText:{fontSize:11,color:'#6E7468'},filterTextOn:{fontWeight:'800',color:'#52633F'},free:{marginLeft:'auto'},freeText:{fontSize:10,color:'#71805D'},list:{padding:20,paddingTop:0,paddingBottom:100},memory:{backgroundColor:'white',padding:8,paddingBottom:13,borderWidth:1,borderColor:'#E7E4DB',marginBottom:17,transform:[{rotate:'-.5deg'}]},memoryImg:{width:'100%',height:205,borderRadius:2},memoryCaption:{fontSize:22,fontStyle:'italic',fontWeight:'600',color:'#4A4D43',paddingHorizontal:5,paddingTop:9},memoryFoot:{paddingHorizontal:5,paddingTop:5,flexDirection:'row',justifyContent:'space-between'},memoryBy:{fontSize:10,color:'#92968A'},heart:{fontSize:11,color:'#D46443'},nav:{height:70,backgroundColor:'#FEFDF9',borderTopWidth:1,borderColor:'#E7E5DC',flexDirection:'row',justifyContent:'space-around',paddingTop:10},navItem:{alignItems:'center',gap:3,flex:1,minWidth:0},navLabel:{fontSize:9,color:'#8C9086'},active:{color:'#D9683D',fontWeight:'800'},modalBg:{flex:1,backgroundColor:'#20261C80',justifyContent:'flex-end'},modal:{backgroundColor:'#F9F7F1',padding:24,borderTopLeftRadius:24,borderTopRightRadius:24},modalTitle:{fontSize:25,fontWeight:'800',letterSpacing:-.8,color:'#30352E',marginTop:9},input:{height:85,backgroundColor:'white',borderWidth:1,borderColor:'#DBDED3',padding:12,borderRadius:9,marginTop:19,textAlignVertical:'top'},photoButton:{height:75,borderRadius:9,borderWidth:1,borderStyle:'dashed',borderColor:'#AAB49A',marginTop:11,alignItems:'center',justifyContent:'center',overflow:'hidden',gap:3},photoText:{fontSize:12,color:'#69755B',fontWeight:'700'},preview:{height:'100%',width:'100%'},modalActions:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:20},later:{fontSize:12,color:'#7F8479'},submit:{backgroundColor:'#ED7041',paddingHorizontal:16,paddingVertical:12,borderRadius:8},submitText:{color:'white',fontSize:12,fontWeight:'800'} });
