export const ageBands = ['Under 30','30–49','50–64','65+'] as const;
export type AgeBand = typeof ageBands[number];

// Require one age per participant. Use all ages if the group spans
// three bands or the middle pair straddles a band boundary.
export function groupRange(text: string, count: number): AgeBand | 'All ages' | undefined {
  const parts = text.split(',').map(value => value.trim());
  if (parts.length !== count || parts.some(value => !/^\d{1,3}$/.test(value) || +value < 1 || +value > 120)) return;
  const sorted = parts.map(Number).sort((a,b) => a-b);
  const tier = (age: number) => age < 30 ? 0 : age < 50 ? 1 : age < 65 ? 2 : 3;
  const lo = sorted[Math.floor((count-1)/2)], hi = sorted[Math.floor(count/2)];
  if (tier(sorted[count-1])-tier(sorted[0]) >= 2 || tier(lo)!==tier(hi)) return 'All ages';
  return ageBands[tier((lo+hi)/2)];
}
