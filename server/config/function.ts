// Functional status vocabulary (Shared Lifecycle Object 261). The everyday activities SHIFT asks
// about and the levels of help, from least to most. These are SHIFT's own plain-language terms for
// the synthetic organisation (ORG-SYN-001), not a scored index. Standard tools such as the interRAI
// ADL scales used in NZ aged residential care are licensed and still being researched (RR-INSTR-001).

export interface Activity { id: string; label: string; aids: string[] }
export interface Level { id: string; label: string; rank: number | null; help: boolean }

export const ACTIVITIES: Activity[] = [
  { id: 'WALKING', label: 'Walking', aids: ['Stick', 'Crutches', 'Frame', 'Walker', 'Wheelchair'] },
  { id: 'TRANSFERS', label: 'Getting in and out of bed or chair', aids: ['Rail', 'Slide board', 'Standing hoist', 'Full hoist'] },
  { id: 'STAIRS', label: 'Stairs and steps', aids: ['Rail', 'Stick'] },
  { id: 'WASHING', label: 'Washing and showering', aids: ['Shower stool', 'Shower chair', 'Long-handled sponge'] },
  { id: 'DRESSING', label: 'Dressing', aids: ['Sock aid', 'Long-handled shoehorn'] },
  { id: 'TOILETING', label: 'Using the toilet', aids: ['Raised seat', 'Commode', 'Urinal', 'Bedpan'] },
  { id: 'EATING', label: 'Eating and drinking', aids: ['Adapted cutlery', 'Plate guard', 'Lidded cup'] },
];

export const LEVELS: Level[] = [
  { id: 'INDEPENDENT', label: 'Independent', rank: 0, help: false },
  { id: 'SUPERVISION', label: 'Needs someone nearby or set-up', rank: 1, help: true },
  { id: 'ASSIST_1', label: 'Help of one', rank: 2, help: true },
  { id: 'ASSIST_2', label: 'Help of two', rank: 3, help: true },
  { id: 'DEPENDENT', label: 'Fully done for them', rank: 4, help: true },
  { id: 'NOT_DOING', label: 'Not doing this at present', rank: null, help: false },
];

export const ACTIVITY_BY_ID = new Map(ACTIVITIES.map((a) => [a.id, a]));
export const LEVEL_BY_ID = new Map(LEVELS.map((l) => [l.id, l]));
