import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Apple from 'expo-apple-authentication';
import type { Session } from '@supabase/supabase-js';
import { signIn, type Provider } from '@/lib/auth';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '@/lib/supabase';

type Quest = { id: string; title: string; prompt: string; emoji: string; minutes: number; place: 'indoors'|'outdoors'; people: string; tag: string };
type Memory = { id: string; caption: string; quest: string; author: string; image?: string; votes: number };
const quests: Quest[] = [
  { id:'album', title:'The album cover nobody asked for', prompt:'Recreate an iconic album cover with whatever is nearby.', emoji:'💿', minutes:30, place:'indoors', people:'Friends', tag:'GROUP FAVORITE' },
  { id:'wrong-turn', title:'Take the scenic wrong turn', prompt:'Let a coin pick your turns. Photograph one new thing.', emoji:'🧭', minutes:15, place:'outdoors', people:'Solo or friends', tag:'LITTLE ADVENTURE' },
  { id:'museum', title:'A very serious tiny museum', prompt:'Curate three ordinary objects. Give them wild backstories.', emoji:'🏛️', minutes:5, place:'indoors', people:'Solo or friends', tag:'CREATIVE CHAOS' },
  { id:'clouds', title:'Clouds with questionable careers', prompt:'Find a cloud. Decide its profession. Defend it with a photo.', emoji:'☁️', minutes:5, place:'outdoors', people:'Solo or friends', tag:'HEAD IN CLOUDS' },
];
const starter: Memory[] = [
  { id:'1', caption:'We took the long way home.', quest:'Take the scenic wrong turn', author:'Alex & Sam', votes:5, image:'https://images.unsplash.com/photo-1472396961693-142e6e269027?w=700' },
  { id:'2', caption:'Michelin stars? Absolutely none.', quest:'Kitchen chaos', author:'The whole crew', votes:8, image:'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=700' },
];
// Restore the Supabase session before showing private UI.
// Preview runs in a separately keyed tree so its state cannot cross accounts.
export default function Home() {
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
  if (!session && !preview) return <Welcome onPreview={() => setPreview(true)} />;
  return <Hangout key={session?.user.id ?? 'preview'} session={session} exitPreview={() => setPreview(false)} />;
}

// Show the existing scrapbook experience for the current account or guest.
// The account menu exposes the signed-in identity and device-local sign-out.
function Hangout({ session, exitPreview }: { session: Session | null; exitPreview: () => void }) {
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
  const [tab, setTab] = useState<'home'|'quests'|'scrapbook'>('home'); const [memories, setMemories] = useState(starter);
  const [filters, setFilters] = useState({ inside:false, quick:false }); const [selected, setSelected] = useState<Quest | null>(null); const [caption,setCaption]=useState(''); const [photo,setPhoto]=useState<string|undefined>();
  const visible = quests.filter(q => (!filters.inside || q.place==='indoors') && (!filters.quick || q.minutes<=5));
  async function choosePhoto() { const p = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!p.granted) return Alert.alert('Photo permission needed', 'Memorygram needs a photo to make a memory.'); const result=await ImagePicker.launchImageLibraryAsync({ mediaTypes:['images'], quality:.75 }); if(!result.canceled) setPhoto(result.assets[0].uri); }
  function submit() { if(!caption.trim() || !photo) return Alert.alert('Almost there', 'Add a tiny caption and photo proof.'); setMemories([{ id:Date.now().toString(), caption, quest:selected!.title, author:'You', image:photo, votes:0 },...memories]); setSelected(null);setCaption('');setPhoto(undefined);setTab('scrapbook'); }
  return <SafeAreaView style={s.safe}><View style={s.app}>
    <View style={s.header}><View><Text style={s.wordmark}><Text style={s.mark}>✳</Text> memorygram<Text style={{color:'#ED7041'}}>.</Text></Text><Text style={s.group}>✌️ THE USUAL SUSPECTS · DEMO GROUP</Text></View>
      <Pressable accessibilityLabel="Account" accessibilityRole="button" style={s.avatar} onPress={() => setAccountOpen(true)}>
        <Ionicons name="person-outline" size={20} />
      </Pressable>
    </View>
    <Modal visible={accountOpen} transparent animationType="fade" onRequestClose={() => setAccountOpen(false)}>
      <View style={s.modalBg}><View style={s.modal}>
        <Text style={s.kicker}>ACCOUNT</Text><Text style={s.modalTitle}>{account}</Text>
        {!!accountError && <Text accessibilityRole="alert" style={s.sub}>{accountError}</Text>}
        <View style={s.modalActions}>
          <Pressable onPress={() => setAccountOpen(false)}><Text style={s.later}>Close</Text></Pressable>
          <Pressable style={s.submit} disabled={leaving} onPress={leave}>
            <Text style={s.submitText}>{session ? (leaving ? 'Signing out…' : 'Sign out') : 'Exit preview'}</Text>
          </Pressable>
        </View>
      </View></View>
    </Modal>
    {tab==='home' && <ScrollView contentContainerStyle={s.scroll}><Text style={s.kicker}>YOUR PEOPLE. YOUR STORIES.</Text><Text style={s.title}>Life’s better with a{`\n`}<Text style={s.script}>side quest.</Text></Text><Text style={s.sub}>A little less scrolling. A few more “you had to be there” moments.</Text>
      <View style={s.hero}><Text style={s.heroKicker}>✦ THIS WEEK’S GROUP QUEST</Text><Text style={s.heroTitle}>Make an ordinary Tuesday{`\n`}a story worth telling.</Text><Text style={s.heroText}>Recreate an iconic album cover. With your people.</Text><Pressable style={s.darkButton} onPress={()=>setSelected(quests[0])}><Text style={s.darkButtonText}>Make a memory  ↗</Text></Pressable><Text style={s.heroArt}>📸</Text></View>
      <View style={s.stats}><Stat icon="⚑" value={`${12+memories.length-2}`} label="QUESTS CONQUERED"/><Stat icon="▧" value={`${28+memories.length-2}`} label="MEMORIES MADE"/><Stat icon="✧" value="LEVEL 3" label="MEMORY MAKERS"/></View>
      <Section title="Your next “remember when”" action="See all" onAction={()=>setTab('quests')}/><QuestRow quest={visible[0]} onPress={setSelected}/><QuestRow quest={visible[1]} onPress={setSelected}/>
      <Section title="A few pages from our story" action="Scrapbook" onAction={()=>setTab('scrapbook')}/><MemoryCard memory={memories[0]} compact/></ScrollView>}
    {tab==='quests' && <View style={{flex:1}}><View style={s.pageHead}><Text style={s.pageTitle}>Quest board</Text><Text style={s.sub}>Tiny missions. Big evidence.</Text><View style={s.filterRow}><Filter label="Indoors" active={filters.inside} onPress={()=>setFilters({...filters,inside:!filters.inside})}/><Filter label="5 min" active={filters.quick} onPress={()=>setFilters({...filters,quick:!filters.quick})}/><View style={s.free}><Text style={s.freeText}>◉ Always $0</Text></View></View></View><FlatList data={visible} contentContainerStyle={s.list} renderItem={({item})=><QuestRow quest={item} onPress={setSelected}/>} keyExtractor={q=>q.id}/></View>}
    {tab==='scrapbook' && <FlatList data={memories} contentContainerStyle={s.list} ListHeaderComponent={<View style={s.pageHead}><Text style={s.pageTitle}>Our scrapbook</Text><Text style={s.sub}>Proof that the little things were the big things.</Text></View>} renderItem={({item})=><MemoryCard memory={item}/>} keyExtractor={m=>m.id}/>}
    <View style={s.nav}>{([['home','home-outline','The hangout'],['quests','flag-outline','Quests'],['scrapbook','images-outline','Scrapbook']] as const).map(([key,icon,label])=><Pressable key={key} style={s.navItem} onPress={()=>setTab(key)}><Ionicons name={icon as any} size={22} color={tab===key?'#D9683D':'#8C9086'}/><Text style={[s.navLabel,tab===key&&s.active]}>{label}</Text></Pressable>)}</View>
    <Modal visible={!!selected} animationType="slide" transparent><View style={s.modalBg}><View style={s.modal}><Text style={s.kicker}>YOUR NEXT LITTLE ADVENTURE</Text><Text style={s.modalTitle}>{selected?.title}</Text><Text style={s.sub}>{selected?.prompt}</Text><Text style={s.meta}>◷ {selected?.minutes} min   ◉ $0   ⌂ {selected?.place}</Text><TextInput style={s.input} multiline placeholder="The story behind the chaos…" value={caption} onChangeText={setCaption}/><Pressable style={s.photoButton} onPress={choosePhoto}>{photo?<Image source={{uri:photo}} style={s.preview}/>:<><Ionicons name="camera-outline" size={25} color="#69755B"/><Text style={s.photoText}>Add photo proof</Text></>}</Pressable><View style={s.modalActions}><Pressable onPress={()=>setSelected(null)}><Text style={s.later}>Maybe later</Text></Pressable><Pressable style={s.submit} onPress={submit}><Text style={s.submitText}>Submit memory ↗</Text></Pressable></View></View></View></Modal>
  </View></SafeAreaView>;
}
// Offer provider sign-in when configured and keep guest preview available.
// Wait for the session subscription to admit the user after provider success.
function Welcome({ onPreview }: { onPreview: () => void }) {
  const busy = useRef(false);
  const [pending, setPending] = useState<Provider | null>(null);
  const [message, setMessage] = useState('');
  const disabled = !supabase || pending !== null;

  // Serialize button presses so a second login cannot replace the first verifier.
  // Treat device cancellation as a normal return to the welcome screen.
  async function start(provider: Provider) {
    if (!supabase || busy.current) return;
    busy.current = true;
    setPending(provider);
    setMessage('');
    try {
      await signIn(provider);
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ERR_REQUEST_CANCELED') {
        setMessage('Sign-in could not be completed. Check your connection and try again.');
      }
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={{ flexGrow: 1 }}>
    <View style={s.welcome}>
      <Text style={s.welcomeMark}>✳</Text><Text style={s.welcomeName}>memorygram.</Text>
      <Text style={s.welcomeTitle}>Make a little mischief.</Text>
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
      <Pressable disabled={!!pending} onPress={onPreview}><Text style={s.previewLink}>Peek at the demo first</Text></Pressable>
    </View>
  </ScrollView></SafeAreaView>;
}
function Stat({icon,value,label}:{icon:string,value:string,label:string}){return <View style={s.stat}><Text style={s.statIcon}>{icon}</Text><View><Text style={s.statValue}>{value}</Text><Text style={s.statLabel}>{label}</Text></View></View>}
function Section({title,action,onAction}:{title:string;action:string;onAction:()=>void}){return <View style={s.section}><Text style={s.sectionTitle}>{title}</Text><Pressable onPress={onAction}><Text style={s.action}>{action} ↗</Text></Pressable></View>}
function Filter({label,active,onPress}:{label:string;active:boolean;onPress:()=>void}){return <Pressable onPress={onPress} style={[s.filter,active&&s.filterOn]}><Text style={[s.filterText,active&&s.filterTextOn]}>{label}</Text></Pressable>}
function QuestRow({quest,onPress}:{quest:Quest;onPress:(q:Quest)=>void}){if(!quest)return null;return <Pressable style={s.quest} onPress={()=>onPress(quest)}><View style={s.questArt}><Text style={s.badge}>{quest.tag}</Text><Text style={s.emoji}>{quest.emoji}</Text></View><View style={s.questBody}><Text style={s.questTitle}>{quest.title}</Text><Text numberOfLines={2} style={s.questPrompt}>{quest.prompt}</Text><Text style={s.meta}>◷ {quest.minutes} min  ·  {quest.people}  ·  $0</Text><Text style={s.doIt}>Let’s do this ↗</Text></View></Pressable>}
function MemoryCard({memory,compact=false}:{memory:Memory;compact?:boolean}){return <View style={[s.memory,compact&&{marginHorizontal:0}]}>{memory.image&&<Image source={{uri:memory.image}} style={s.memoryImg}/>}<Text style={s.memoryCaption}>{memory.caption}</Text><View style={s.memoryFoot}><Text style={s.memoryBy}>{memory.author} · just now</Text><Text style={s.heart}>♡ {memory.votes}</Text></View></View>}
const s=StyleSheet.create({ safe:{flex:1,backgroundColor:'#F9F7F1'},app:{flex:1,backgroundColor:'#F9F7F1'},welcome:{flex:1,padding:26,alignItems:'center',justifyContent:'center'},welcomeMark:{fontSize:48,color:'#ED7041'},welcomeName:{fontSize:27,fontWeight:'800',letterSpacing:-1.5,color:'#30352E',marginTop:4},welcomeTitle:{fontSize:35,lineHeight:39,fontWeight:'800',letterSpacing:-1.7,color:'#30352E',textAlign:'center',marginTop:30},welcomeText:{fontSize:14,lineHeight:21,color:'#85897E',textAlign:'center',marginTop:10,maxWidth:270},welcomeArt:{height:132,width:210,backgroundColor:'#E6EBD9',borderRadius:13,marginVertical:28,alignItems:'center',justifyContent:'center',transform:[{rotate:'-2deg'}]},tapeText:{fontSize:16,fontStyle:'italic',color:'#5A6749',marginTop:-10},oauth:{height:51,width:'100%',maxWidth:340,borderWidth:1,borderColor:'#DEDCD3',backgroundColor:'#FFFDF9',borderRadius:10,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10,marginBottom:10},oauthText:{fontSize:13,fontWeight:'700',color:'#343832'},previewLink:{fontSize:12,fontWeight:'700',color:'#C9623C',padding:12},privacy:{position:'absolute',bottom:24,fontSize:10,color:'#A0A398'},header:{padding:20,paddingBottom:12,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},wordmark:{fontSize:22,fontWeight:'800',letterSpacing:-1,color:'#30352E'},mark:{backgroundColor:'#ED7041',color:'white',borderRadius:8,overflow:'hidden',paddingHorizontal:6,paddingVertical:3},group:{fontSize:9,fontWeight:'700',color:'#7B8074',letterSpacing:1.1,marginTop:9},avatar:{height:38,width:38,borderRadius:19,backgroundColor:'#EAD9BE',alignItems:'center',justifyContent:'center'},scroll:{padding:20,paddingTop:6,paddingBottom:100},kicker:{fontSize:10,fontWeight:'800',letterSpacing:1.6,color:'#7B846B'},title:{fontSize:31,lineHeight:36,fontWeight:'800',letterSpacing:-1.4,color:'#30352E',marginTop:8},script:{color:'#ED7041',fontStyle:'italic',fontWeight:'600'},sub:{fontSize:13,lineHeight:20,color:'#85897E',marginTop:8},hero:{backgroundColor:'#E5EAD9',borderColor:'#D5DDC8',borderWidth:1,borderRadius:15,padding:22,marginTop:24,overflow:'hidden',minHeight:234},heroKicker:{fontWeight:'800',letterSpacing:1.2,fontSize:10,color:'#6E7A56'},heroTitle:{fontWeight:'800',fontSize:22,lineHeight:28,letterSpacing:-.7,color:'#35402D',marginTop:12},heroText:{fontSize:12,color:'#77806C',marginTop:8},darkButton:{alignSelf:'flex-start',backgroundColor:'#566C43',paddingHorizontal:16,paddingVertical:12,borderRadius:8,marginTop:19},darkButtonText:{color:'white',fontSize:12,fontWeight:'700'},heroArt:{position:'absolute',right:8,bottom:-7,fontSize:104,transform:[{rotate:'-12deg'}],opacity:.9},stats:{flexDirection:'row',paddingVertical:23,borderBottomWidth:1,borderColor:'#E6E5DC',justifyContent:'space-between'},stat:{flex:1,flexDirection:'row',gap:7,alignItems:'center'},statIcon:{fontSize:18},statValue:{fontSize:16,fontWeight:'800',color:'#30352E'},statLabel:{fontSize:7,fontWeight:'700',color:'#92968A',marginTop:3},section:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:25,marginBottom:12},sectionTitle:{fontSize:17,fontWeight:'800',letterSpacing:-.5,color:'#30352E'},action:{fontSize:11,color:'#C96038',fontWeight:'700'},quest:{flexDirection:'row',backgroundColor:'#FFFDF9',borderWidth:1,borderColor:'#E7E5DC',borderRadius:12,overflow:'hidden',marginBottom:13},questArt:{width:102,minHeight:145,backgroundColor:'#EFE5D5',justifyContent:'center',alignItems:'center'},badge:{position:'absolute',top:9,left:8,fontSize:7,fontWeight:'800',color:'#8B795A'},emoji:{fontSize:47},questBody:{flex:1,padding:13},questTitle:{fontSize:14,fontWeight:'800',letterSpacing:-.3,color:'#373B34'},questPrompt:{fontSize:11,lineHeight:16,color:'#85897F',marginTop:6},meta:{fontSize:9,color:'#909487',marginTop:10},doIt:{fontSize:11,color:'#CF653C',fontWeight:'800',marginTop:9},pageHead:{paddingHorizontal:20,paddingTop:8,paddingBottom:16},pageTitle:{fontSize:29,fontWeight:'800',letterSpacing:-1,color:'#30352E'},filterRow:{flexDirection:'row',gap:8,alignItems:'center',marginTop:17},filter:{borderWidth:1,borderColor:'#D9DDD2',paddingVertical:7,paddingHorizontal:10,borderRadius:18,backgroundColor:'#FEFDF9'},filterOn:{backgroundColor:'#E9EEDC',borderColor:'#829067'},filterText:{fontSize:11,color:'#6E7468'},filterTextOn:{fontWeight:'800',color:'#52633F'},free:{marginLeft:'auto'},freeText:{fontSize:10,color:'#71805D'},list:{padding:20,paddingTop:0,paddingBottom:100},memory:{backgroundColor:'white',padding:8,paddingBottom:13,borderWidth:1,borderColor:'#E7E4DB',marginBottom:17,transform:[{rotate:'-.5deg'}]},memoryImg:{width:'100%',height:205,borderRadius:2},memoryCaption:{fontSize:22,fontStyle:'italic',fontWeight:'600',color:'#4A4D43',paddingHorizontal:5,paddingTop:9},memoryFoot:{paddingHorizontal:5,paddingTop:5,flexDirection:'row',justifyContent:'space-between'},memoryBy:{fontSize:10,color:'#92968A'},heart:{fontSize:11,color:'#D46443'},nav:{height:70,backgroundColor:'#FEFDF9',borderTopWidth:1,borderColor:'#E7E5DC',flexDirection:'row',justifyContent:'space-around',paddingTop:10},navItem:{alignItems:'center',gap:3,minWidth:70},navLabel:{fontSize:9,color:'#8C9086'},active:{color:'#D9683D',fontWeight:'800'},modalBg:{flex:1,backgroundColor:'#20261C80',justifyContent:'flex-end'},modal:{backgroundColor:'#F9F7F1',padding:24,borderTopLeftRadius:24,borderTopRightRadius:24},modalTitle:{fontSize:25,fontWeight:'800',letterSpacing:-.8,color:'#30352E',marginTop:9},input:{height:85,backgroundColor:'white',borderWidth:1,borderColor:'#DBDED3',padding:12,borderRadius:9,marginTop:19,textAlignVertical:'top'},photoButton:{height:75,borderRadius:9,borderWidth:1,borderStyle:'dashed',borderColor:'#AAB49A',marginTop:11,alignItems:'center',justifyContent:'center',overflow:'hidden',gap:3},photoText:{fontSize:12,color:'#69755B',fontWeight:'700'},preview:{height:'100%',width:'100%'},modalActions:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:20},later:{fontSize:12,color:'#7F8479'},submit:{backgroundColor:'#ED7041',paddingHorizontal:16,paddingVertical:12,borderRadius:8},submitText:{color:'white',fontSize:12,fontWeight:'800'} });
