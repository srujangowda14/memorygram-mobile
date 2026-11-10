import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { suggestContext } from './task-location';
import { mappedSpots, miles, type Spot } from './nearby';
import { Action } from './profile-ui';
import type { Social } from './social';
import type { Task } from './memory-spaces';

// Fetch real destinations from a public town center and rank them locally.
// Cancel old searches when the room closes or the location is refreshed.
export function NearbyOutings({social,group,tasks,updated}:{social:Social;group:string;tasks:Task[];updated:()=>void}) {
  const [limit,setLimit]=useState(6);
  const [attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<{spots:(Spot & {distance:number})[];error:string}>();
  const [pending,setPending]=useState('');
  const [saveError,setSaveError]=useState('');
  useEffect(()=>{
    const abort=new AbortController();
    const timer=setTimeout(()=>{abort.abort();setResult({spots:[],error:'Nearby search timed out. Try again.'});},25000);
    void suggestContext().then(async fix=>{
      if(abort.signal.aborted) return;
      const places=await mappedSpots(fix.origin,abort.signal);
      if(abort.signal.aborted) return;
      const spots=places.map(spot=>({...spot,distance:miles(fix.origin,spot)}))
        .filter(spot=>spot.distance<=3).sort((a,b)=>a.distance-b.distance);
      setResult({spots,error:''});
    }).catch(()=>{if(!abort.signal.aborted) setResult({spots:[],error:'Could not find nearby outings. Check location access and try again.'});})
      .finally(()=>clearTimeout(timer));
    return ()=>{clearTimeout(timer);abort.abort();};
  },[attempt,group]);

  // Wait for the assignment to save before refreshing the room. Failed
  // requests keep the destination available for an idempotent retry.
  async function add(spot:Spot) {
    if(pending) return;
    setPending(spot.id);setSaveError('');
    try {await social.spaces.addOuting(group,spot);updated();}
    catch {setSaveError('Could not add the outing. Try again.');}
    finally {setPending('');}
  }
  return <View style={{gap:12}}>
    <Text style={{fontSize:20,fontWeight:'800',color:'#343D30'}}>Nearby outings</Text>
    <Text>Places within 3 miles of your current pin. Map search uses a public town center.</Text>
    <Action label="Refresh nearby outings" disabled={!result} onPress={()=>{setResult(undefined);setLimit(6);setAttempt(n=>n+1);}} />
    {!result && <ActivityIndicator accessibilityLabel="Finding nearby outings" />}
    {!!result?.error && <Text accessibilityRole="alert">{result.error}</Text>}
    {result && !result.error && !result.spots.length && <Text>No mapped outings were found within 3 miles.</Text>}
    {result?.spots.slice(0,limit).map(spot=>{
      const assigned=tasks.some(q=>q.nearby?.origin==='OpenStreetMap' && q.nearby.osmId===spot.id.slice(4));
      return <View key={spot.id} style={{gap:8,padding:16,borderWidth:1,borderColor:'#CDD1C5',borderRadius:12,backgroundColor:'#FFFDFA'}}>
        <Text style={{fontSize:17,fontWeight:'700'}}>{spot.name}</Text>
        <Text>{spot.type.replaceAll('_',' ')} · {spot.distance.toFixed(1)} mi</Text>
        {!!spot.address && <Text>{spot.address}</Text>}
        <Text accessibilityRole="link" onPress={()=>void Linking.openURL('https://www.openstreetmap.org/'+spot.id.slice(4).replace(':','/')).catch(()=>setSaveError('Could not open the map.'))}>View place on OpenStreetMap ↗</Text>
        <Action label={assigned?'Added to group':'Add outing · '+spot.name} disabled={assigned || !!pending} onPress={()=>void add(spot)} />
      </View>;
    })}
    {result && result.spots.length>limit && <Action label="More nearby places" onPress={()=>setLimit(n=>n+6)} />}
    {!!saveError && <Text accessibilityRole="alert">{saveError}</Text>}
    {!!result?.spots.length && <Text>© OpenStreetMap contributors · Check the venue’s opening hours and prices.</Text>}
  </View>;
}
