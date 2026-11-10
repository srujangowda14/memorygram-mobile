import { randomUUID } from 'expo-crypto';
import { supabase } from './supabase';
import type { Mode } from './memory-spaces';
import type { AgeBand } from './quest-age';
import catalog from './friend-quests.json';
import settlements from './data/populated-places.json';
import demoSpots from './data/sf-demo-spots.json';

export type Radius = 1 | 5 | 10;
export type Spot = { id: string; name: string; address: string; lat: number; lon: number; type: string };
export type RestaurantBudget = 1 | 2 | 3 | 4;
export type RestaurantListing = { name:string; rating:number; reviews:number; tier:RestaurantBudget; distance:number;
  attributions:{provider:string; providerUri?:string}[] };
type Meeting = { meeting:string; meetingAddress:string; radius:Radius };
export type Nearby = {origin:'OpenStreetMap';meeting:string;osmId:string;meetingAddress?:undefined} | Meeting & ({ origin:'Google Maps'; placeId:string; budget:RestaurantBudget } | { venue: string; listing: string;
  address: string; distance: number; source: string; startsAt: string | null; origin: 'Curated' | 'OpenAI' | 'Demo' });
export type Offer = { id: string; title: string; prompt: string; nearby: Nearby; restaurant?:RestaurantListing };
type Search = { restaurantBudget?:RestaurantBudget; draftId: string; mode: Mode; ageBand?:AgeBand; spotId: string; radius: Radius };
const service = process.env.EXPO_PUBLIC_SERVICE_URL?.trim().replace(/\/+$/,'');

// Authenticate only against the configured Memorygram service. The mobile
// app never receives an OpenAI key or calls a paid provider directly.
async function request<T>(path: string, signal: AbortSignal, body?: Search): Promise<T> {
  if (!service || !supabase) throw new Error('Connect the Memorygram service to use live local listings.');
  const {data} = await supabase.auth.getSession();
  if (!data.session) throw new Error('Sign in again to find nearby suggestions.');
  const response = await fetch(service+'/v1/nearby/'+path, {method:body ? 'POST':'GET',signal,
    headers:{Authorization:'Bearer '+data.session.access_token, ...(body ? {'Content-Type':'application/json'} : {})},
    body:body ? JSON.stringify(body) : undefined});
  if (!response.ok) {
    const message = await response.json().catch(() => null);
    throw new Error(typeof message?.error === 'string' ? message.error : 'Could not reach the listings service. Try again.');
  }
  return response.json();
}

export type Point = { lat:number; lon:number };

// A great-circle distance keeps the search centered on the phone even
// near the date line. Values are in miles throughout the picker.
export function miles(a: Point,b: Point) {
  const rad = Math.PI/180;
  const h = Math.sin((b.lat-a.lat)*rad/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lon-a.lon)*rad/2)**2;
  return 7917.52*Math.asin(Math.min(1,Math.sqrt(h)));
}

// Search from a published town center. Only coordinates from the bundled
// gazetteer may reach the map service. Rank its candidates on the device.
export async function mappedSpots(origin:Point, signal:AbortSignal):Promise<Spot[]> {
  let nearest = Infinity;
  let center:Point | undefined;
  for (const [lat,lon] of settlements as [number,number,string][]) {
    const town = {lat,lon};
    const distance = miles(origin,town);
    if (distance<nearest) {nearest=distance;center=town;}
  }
  if (!center || nearest>35) return [];
  const params = new URLSearchParams({lat:String(center.lat),lon:String(center.lon),radius:String(Math.ceil(nearest*1.61)+5),limit:'50'});
  for (const tag of ['leisure:park','amenity:library','place:square','amenity:community_centre','amenity:cafe','tourism:museum']) params.append('osm_tag',tag);
  const response = await fetch('https://photon.komoot.io/reverse?'+params,{signal});
  if (!response.ok) throw new Error('Nearby maps are unavailable. Try again or use your current location.');
  const data = await response.json() as {features:{geometry:{coordinates:number[]};properties:{
    osm_type:string;osm_id:number;osm_value:string;name?:string;street?:string;district?:string}}[]};
  const types:Record<string,string> = {N:'node',W:'way',R:'relation'};
  return data.features.flatMap(row=>{
    const p=row.properties, [lon,lat]=row.geometry.coordinates;
    if (!p.name || !types[p.osm_type] || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{id:'osm:'+types[p.osm_type]+':'+p.osm_id,name:p.name,address:p.street || p.district || '',
      lat,lon,type:p.osm_value}];
  });
}

// Preserve curated SF outings where the directory has nearby coverage.
// Everywhere else search the same local radius using OpenStreetMap.
export async function meetingSpots(preview:boolean, origin:Point, signal:AbortSignal):Promise<Spot[]> {
  const rank = (rows:Spot[]) => rows.filter(p=>miles(origin,p)<=3).sort((a,b)=>miles(origin,a)-miles(origin,b));
  if (miles(origin,{lat:37.77,lon:-122.45})<8) {
    try {
      const rows=rank(preview ? demoSpots : (await request<{spots:Spot[]}>('spots',signal)).spots);
      if (rows.length) return rows;
    } catch (error) { if (signal.aborted) throw error; }
  }
  return rank(await mappedSpots(origin,signal));
}

// A live search receives redeemable offer IDs. Demo suggestions are labeled
// examples, derived locally without sending a query or using paid AI.
export async function nearbyTasks(preview: boolean, search: Search, signal: AbortSignal): Promise<{offers:Offer[]; calendarAvailable:boolean; restaurantStatus?:'found'|'empty'|'unavailable'}> {
  if (!preview) return request('suggestions',signal,search);
  const meeting = demoSpots.find(s => s.id === search.spotId);
  if (!meeting) throw new Error('Choose a meeting spot.');
  const places = demoSpots.filter(s => s.id !== meeting.id).map(s => ({s,distance:miles(s,meeting)}))
    .filter(p => p.distance <= search.radius).sort((a,b) => a.distance-b.distance).slice(0,3);
  const titles = ['A postcard from here','The tiny museum','Name this moment'];
  const prompts = search.mode === 'group' ? [
    'Each pick a detail to put on a postcard. Photograph one and write both impressions on the back.',
    'Choose two ordinary things worth exhibiting. Photograph one and write a museum label together.',
    'Choose a color for the outing. Photograph something in that shade and invent a name for it together.',
  ] : [
    'Choose one detail you would send to a friend. Photograph it and write one line for the back of the postcard.',
    'Find an ordinary object worthy of a small museum. Take its portrait and write its label.',
    'Frame a detail as a book cover. Give this moment a title in your caption.',
  ];
  const tailored = catalog.filter(q=>q.band===search.ageBand && q.family==='place');
  return {calendarAvailable:false,offers:places.map(({s,distance},i) => ({id:randomUUID(),title:tailored[i]?.title ?? titles[i],prompt:tailored[i]?.prompt ?? prompts[i],
    nearby:{meeting:meeting.name,meetingAddress:meeting.address,radius:search.radius,venue:s.name,listing:s.name,address:s.address,
      distance:Number(distance.toFixed(2)),source:'https://data.sf.gov/Culture-and-Recreation/Recreation-and-Parks-Properties/gtr9-ntp6',
      startsAt:null,origin:'Demo'}}))};
}
