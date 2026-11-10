import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Action } from './profile-ui';
import type { AgeBand } from './quest-age';
import type { Mode } from './memory-spaces';
import { meetingSpots, nearbyTasks, miles, type Point, type Nearby, type Offer, type RestaurantListing, type RestaurantBudget, type Radius, type Spot } from './nearby';

// Show the original listing and its distance from the chosen public spot.
// Event dates use San Francisco time on every member's device.
export function ListingDetails({ item, restaurant }: { item: Nearby; restaurant?: RestaurantListing }) {
  const [failed,setFailed] = useState(false);
  if (item.origin === 'OpenStreetMap') {
    const url='https://www.openstreetmap.org/'+item.osmId.replace(':','/');
    return <View><Text style={s.venue}>{item.meeting}</Text><Text accessibilityRole="link" style={s.link}
      onPress={()=>Linking.openURL(url).catch(()=>setFailed(true))}>View meeting spot on OpenStreetMap ↗</Text>
      {failed && <Text selectable>{url}</Text>}</View>;
  }
  if (item.origin === 'Google Maps') {
    const url = 'https://www.google.com/maps/search/?api=1&query=restaurant&query_place_id=' + encodeURIComponent(item.placeId);
    return <View style={s.stack}>
      {restaurant && <><Text style={s.venue}>{restaurant.name}</Text>
        <Text style={s.meta}>{restaurant.rating.toFixed(1)} ★ ({restaurant.reviews.toLocaleString()} reviews) · {'$'.repeat(restaurant.tier)} · {restaurant.distance.toFixed(2)} mi</Text>
        {restaurant.attributions.map(a => <Text key={a.provider + a.providerUri} style={s.meta}
          onPress={a.providerUri?.startsWith('https://') ? () => Linking.openURL(a.providerUri!).catch(() => setFailed(true)) : undefined}>{a.provider}</Text>)}</>}
      <Text style={s.meta}>Purchase required · Budget up to {'$'.repeat(item.budget)}</Text>
      <Pressable accessibilityRole="link" onPress={() => Linking.openURL(url).catch(() => setFailed(true))}>
        <Text style={s.link}>View restaurant on Google Maps ↗</Text></Pressable>
      {failed && <Text selectable style={s.meta}>{url}</Text>}
    </View>;
  }
  const date = item.startsAt ? new Date(item.startsAt).toLocaleString('en-US',{
    month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles',timeZoneName:'short',
  }) : '';
  return <View style={s.stack}>
    <Text style={s.venue}>{item.listing}</Text>
    <Text style={s.meta}>{[item.startsAt && item.venue, item.address].filter(Boolean).join(' · ')}</Text>
    <Text style={s.meta}>{item.distance.toFixed(2)} mi from {item.meeting} · {item.radius} mi radius</Text>
    {!!date && <Text style={s.meta}>{date}</Text>}
    <Pressable accessibilityRole="link" onPress={() => { setFailed(false); Linking.openURL(item.source).catch(() => setFailed(true)); }}>
      <Text style={s.link}>{item.startsAt ? 'Organizer listing' : 'City park listing'} ↗</Text></Pressable>
    {failed && <Text selectable style={s.meta}>{item.source}</Text>}
  </View>;
}

// Select a public meeting point explicitly. Editing that point or the radius
// cancels the old request and clears any selected offer before creation.
export function MeetingPicker({ origin, selectLocal, preview,mode,ageBand,draftId,selected,choose,disabled }: {
  origin:Point; selectLocal:(spot:Spot)=>void; preview:boolean; mode:Mode; ageBand?:AgeBand; draftId:string; selected?:Offer; choose:(offer?:Offer)=>void; disabled:boolean;
}) {
  const [spots,setSpots] = useState<Spot[]>([]);
  const [spot,setSpot] = useState<Spot>();
  const [term,setTerm] = useState('');
  const [radius,setRadius] = useState<Radius>(5);
  const [budget,setBudget] = useState<RestaurantBudget | 0>(2);
  const [revision,setRevision] = useState(0);
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState('');
  const [searching,setSearching] = useState(false);
  const [offers,setOffers] = useState<Offer[]>();
  const [note,setNote] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort(); setLoading(false); setLoadError('The map lookup timed out. Retry or return to your current location.');
    }, 15000);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset the directory status when starting a new lookup.
    setLoading(true); setLoadError('');
    meetingSpots(preview,origin,abort.signal).then(rows => { if (!abort.signal.aborted) setSpots(rows); })
      .catch(e => { if (!abort.signal.aborted) setLoadError(e.message || 'The city directory is unavailable.'); })
      .finally(() => { clearTimeout(timer); if (!abort.signal.aborted) setLoading(false); });
    return () => { clearTimeout(timer); abort.abort(); controller.current?.abort(); };
  },[origin,preview,revision]);

  // Invalidate offers tied to the previous meeting spot or radius. A slow
  // response can never reselect a destination from an earlier search.
  function clearOffers() {
    controller.current?.abort(); setSearching(false); setOffers(undefined); choose(undefined); setNote('');
  }

  // Preview verified candidates before committing a room to one of them.
  // Empty results preserve the radius and leave the anywhere option available.
  async function find() {
    if (!spot || searching || disabled) return;
    clearOffers(); const abort = new AbortController(); controller.current = abort;
    setSearching(true);
    try {
      const result = await nearbyTasks(preview,{mode,ageBand,draftId,spotId:spot.id,radius,restaurantBudget:preview || !budget ? undefined : budget},abort.signal);
      if (abort.signal.aborted) return;
      setOffers(result.offers);
      const notes = [];
      if (result.restaurantStatus === 'empty') notes.push('No rated restaurants matched this budget and radius.');
      if (result.restaurantStatus === 'unavailable') notes.push('Restaurant search is unavailable. Try again later.');
      if (!result.calendarAvailable && !preview) notes.push('The event calendar is unavailable.');
      if (!result.offers.length) notes.push('Try another radius or use anywhere tasks.');
      setNote(notes.join(' '));
    } catch(e) { if (!abort.signal.aborted) setNote(e instanceof Error ? e.message : 'Search failed. Please try again.'); }
    finally { if (!abort.signal.aborted) setSearching(false); }
  }
  const matching = spots.filter(p => (p.name+' '+p.address).toLowerCase().includes(term.trim().toLowerCase())).slice(0,6);
  const visibleOffers = selected ? offers?.filter(o => o.id===selected.id) : offers;
  return <View style={s.stack}>
    <Text style={s.heading}>Meeting spots near you</Text>
    <Text style={s.meta}>Public places within 3 miles, closest first.</Text>
    {spots.some(p=>p.id.startsWith('osm:')) && <Text accessibilityRole="link" onPress={()=>Linking.openURL('https://www.openstreetmap.org/copyright')} style={s.link}>© OpenStreetMap contributors</Text>}
    {loading && <ActivityIndicator />}
    {!!loadError && <><Text accessibilityRole="alert">{loadError}</Text><Action label="Retry directory" onPress={() => setRevision(n=>n+1)} /></>}
    {!loading && !loadError && (!spot ? <>
      <TextInput style={s.input} value={term} editable={!disabled} accessibilityLabel="Search meeting spots"
        placeholderTextColor="#676D61" placeholder="Search a park, plaza, or street" onChangeText={setTerm} />
      {matching.map(p => <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={'Meet at '+p.name}
        style={s.row} onPress={() => { clearOffers(); if (p.id.startsWith('osm:')) selectLocal(p); else setSpot(p); }}><Ionicons name="location-outline" size={19} color="#536148"/>
        <View style={{flex:1}}><Text style={s.venue}>{p.name}</Text><Text style={s.meta}>{miles(origin,p).toFixed(1)} mi · {p.address || p.type}</Text></View></Pressable>)}
      {!matching.length && <Text style={s.meta}>No matching nearby places. Try a different name or use your current location.</Text>}
    </> : <>
      <Text style={s.venue}>Meet at {spot.name}</Text><Text style={s.meta}>{spot.address}</Text>
      <Action label="Change meeting spot" disabled={disabled} onPress={() => { clearOffers();setSpot(undefined); }} />
      <Text style={s.venue}>Search radius</Text><Text style={s.meta}>Straight-line miles between mapped places.</Text>
      <View style={s.wrap}>{([1,5,10] as const).map(n =>
        <Pressable key={n} accessibilityRole="radio" accessibilityState={{checked:radius===n}} disabled={disabled}
          style={[s.chip,radius===n && s.active]} onPress={() => { if (radius!==n) { clearOffers();setRadius(n); } }}>
          <Text style={s.venue}>{n} mi</Text></Pressable>)}</View>
      {!preview && <><Text style={s.venue}>Restaurant budget</Text>
        <Text style={s.meta}>Choose a maximum price tier. Menu prices vary.</Text>
        <View style={s.wrap}>{([0,1,2,3,4] as const).map(n =>
          <Pressable key={n} accessibilityRole="radio" accessibilityState={{checked:budget===n}} disabled={disabled}
            style={[s.chip,budget===n && s.active]} onPress={() => { if (budget!==n) { clearOffers(); setBudget(n); } }}>
            <Text style={s.venue}>{n ? '$'.repeat(n) : 'Free only'}</Text></Pressable>)}</View></>}
      <Action label={searching?'Finding suggestions…':'Find suggestions'} disabled={searching || disabled} onPress={find} />
      {!!note && <Text accessibilityRole="alert" style={s.meta}>{note}</Text>}
      {visibleOffers?.map(o => <View key={o.id} style={[s.card,selected?.id===o.id && s.active]}>
        <Text style={s.meta}>{o.nearby.origin === 'Google Maps' ? 'Restaurant outing' : (o.nearby.origin === 'OpenAI' ? 'OpenAI suggestion' : 'Curated suggestion') + ' · 10 min'}</Text>
        <Text style={s.heading}>{o.title}</Text><Text style={s.body}>{o.prompt}</Text>
        <ListingDetails item={o.nearby} restaurant={o.restaurant} /><Action primary={!selected}
          label={selected?'Change task':'Choose this task'} disabled={disabled} onPress={() => choose(selected ? undefined : o)} />
      </View>)}
    </>)}
  </View>;
}
const s=StyleSheet.create({
  stack:{gap:8},heading:{fontSize:18,fontWeight:'800',color:'#343D30'},venue:{fontSize:14,fontWeight:'700',color:'#394434'},
  body:{color:'#4E5849',lineHeight:21},meta:{fontSize:12,lineHeight:18,color:'#5E6958'},link:{color:'#40603A',textDecorationLine:'underline',paddingVertical:5},
  input:{borderWidth:1,borderColor:'#CDD1C5',backgroundColor:'#FFFDF9',borderRadius:10,padding:12},wrap:{flexDirection:'row',gap:8},
  row:{flexDirection:'row',gap:9,alignItems:'center',borderBottomWidth:1,borderColor:'#DEE2D5',paddingVertical:8},
  chip:{paddingHorizontal:15,paddingVertical:10,borderRadius:20,borderWidth:1,borderColor:'#CCD3C0'},active:{backgroundColor:'#E7EEDC',borderColor:'#6E865C'},
  card:{gap:7,padding:13,borderRadius:12,borderWidth:1,borderColor:'#DADFD2',backgroundColor:'#FAFAF4'},
});
