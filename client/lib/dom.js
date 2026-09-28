// Minimal DOM builder. Text is always set as text, never parsed as HTML.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const PATHS = {
  home: 'M3 11.5 12 4l9 7.5M5.5 9.5V20h5v-5.5h3V20h5V9.5',
  notes: 'M6 4h12a1 1 0 0 1 1 1v15H5V5a1 1 0 0 1 1-1Zm2-2v4m4-4v4m4-4v4M8 10h8M8 14h8M8 18h5',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0Z',
  signout: 'M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h11m-3-3 3 3-3 3',
  workstation: 'M4 6h16M4 12h16M4 18h16',
  tasks: 'M5 5h14v15H5zM8 3v4m8-4v4M8.5 13l2.5 2.5 5-5',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.6-1.9L20 20',
  handover: 'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 19a5.5 5.5 0 0 1 11 0Zm11.5-5.5A4.5 4.5 0 0 1 21 18',
  received: 'M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6Z',
  knowledge: 'M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3Z',
  alert: 'M12 3 2 20h20Zm0 6v5m0 3v.5',
  pulse: 'M3 12h4l2-5 4 10 2-5h6',
  overview: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0Z',
  history: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6m-6 4h6',
  problems: 'M12 3 2 20h20Zm0 6v5m0 3v.5',
  assess: 'M6 4h12v17H6zM9 2v4h6V2M9 11h6m-6 4h6',
  careplan: 'M6 4h12v17H6zM9 9l1.5 1.5L13 8m-4 7h6',
  obs: 'M3 12h4l2-5 4 10 2-5h6',
  meds: 'm9.5 4.5 10 10a3.5 3.5 0 0 1-5 5l-10-10a3.5 3.5 0 0 1 5-5ZM7 12l5-5',
  results: 'M9 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L15 9V3M8 3h8M7 15h10',
  wounds: 'M4 12 12 4l8 8-8 8Zm5-3 6 6m0-6-6 6',
  skin: 'M4 12 12 4l8 8-8 8Zm5-3 6 6m0-6-6 6',
  falls: 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 3 3 1 2 4 4 2M11 9l-2 5-4 2m7-3-1 8',
  nutrition: 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-2 0-3 3-3 7h3v11',
  intake: 'M7 3h10l-1 18H8ZM7.5 9h9',
  cares: 'M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11Z',
  behaviour: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-11h.01M15 10h.01M8.5 15c2 2 5 2 7 0',
  changes: 'M12 3 2 20h20Zm0 6v5m0 3v.5',
  family: 'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 19a5.5 5.5 0 0 1 11 0Zm11.5-5.5A4.5 4.5 0 0 1 21 18',
  review: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
  progress: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6m-6 4h6',
  notesv: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6m-6 4h6',
  list: 'M4 6h16M4 12h16M4 18h16',
  roster: 'M5 5h14v15H5zM8 3v4m8-4v4M8 12h8m-8 4h5',
  availability: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0Z',
  exchange: 'M4 8h14l-3-3m5 11H6l3 3',
  payslips: 'M7 3h7l5 5v13H7zM12 11v7m2-6h-3a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3h-3',
  leave: 'M5 4h10l4 4v12H5zm4 9h6m-6 4h4M14 3v5h5',
  credentials: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Zm-3 9 2 2 4-4',
  training: 'M2 9l10-5 10 5-10 5Zm4 2v5c3 2 9 2 12 0v-5',
  vacancies: 'M5 5h14v15H5zM8 3v4m8-4v4M12 10v6m-3-3h6',
  swaps: 'M4 8h14l-3-3m5 11H6l3 3',
  triage: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Zm0 5v6m-3-3h6',
  medical: 'M6 4h12v17H6zM9 2v4h6V2M12 10v6m-3-3h6',
  procedures: 'M4 20 14 10m2-6 4 4-6 6-4-4Zm-8 12 2 2',
  disposition: 'M4 12h13m-4-5 5 5-5 5M20 4v16',
  mobility: 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-2 16 2-7 3 3v4m-5-10 2-3 3 2 3 1M9 11l-2 3',
  goals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  treatment: 'M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11Zm-3-10h6m-3-3v6',
  outcomes: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  tasksv: 'M5 5h14v15H5zM8 3v4m8-4v4M8.5 13l2.5 2.5 5-5',
  routes: 'M4 12h13m-4-5 5 5-5 5',
  handoverv: 'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 19a5.5 5.5 0 0 1 11 0Zm11.5-5.5A4.5 4.5 0 0 1 21 18',
  allergies: 'M12 3 2 20h20Zm0 6v5m0 3v.5',
  bgl: 'M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11Z',
  weight: 'M5 7h14l2 13H3Zm7 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  transfers: 'M3 17h12m-3-3 3 3-3 3M21 7H9m3-3-3 3 3 3',
  flow: 'M3 18v-7h18v7M3 14h18M6 11V8h5v3m-8 7v2m18-2v2',
  discharges: 'M4 20V4h9v16M13 12h8m-3-3 3 3-3 3M10 12h.01',
  escalations: 'M12 3 2 20h20Zm0 5v6m0 3v.5M12 3v0',
  consults: 'M4 5h11v8H9l-4 3v-3H4Zm11 4h5v8h-1v3l-4-3h-5v-3',
  careplans: 'M6 4h12v17H6zM9 9l1.5 1.5L13 8m-4 7h6',
  referrals: 'M4 6h9v12H4zM13 12h7m-3-3 3 3-3 3',
  appointments: 'M4 6h16v14H4zM4 10h16M8 3v5m8-5v5m-6 7 2 2 4-4',
  monitoring: 'M3 12h4l2-6 4 12 2-6h6',
  whanau: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20v-1a5 5 0 0 1 10 0v1m0 0v-1a5 5 0 0 1 10 0v1',
  reports: 'M7 8h10M7 12h6M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4V5Z',
  incidents: 'M12 3 2 20h20L12 3ZM12 10v4M12 17h.01M8 3h8',
  deterioration: 'M3 6l6 6 4-4 8 8M21 10v6h-6',
  interventions: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  followups: 'M5 12h14M13 6l6 6-6 6M5 5v14',
  screening: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  antimicrobials: 'M10.5 3.5a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7-7l7-7ZM7 10l7 7',
  sitechecks: 'M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11ZM9.5 10l2 2 3.5-3.5',
  readiness: 'M4 20h16M6 20V9l6-5 6 5v11M9.5 13.5l2 2 3.5-3.5',
  variances: 'M4 12h5l3-7 3 14 3-7h2',
  infections: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3',
  surveillance: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  recalls: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 8v4l2 2',
  caredue: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  requirements: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2ZM9 12l2 2 4-4',
  recommendations: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3Z',
  checklists: 'M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2',
  pathways: 'M5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM7 6h7a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h7',
  treatmentplans: 'M9 3h6v3H9zM6 5H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-1M8 12h8M8 16h5M12 10v4',
  symptoms: 'M4 18h3l2-6 3 9 3-12 2 9h3',
  death: 'M12 2c-2 3-2 5 0 7 2-2 2-4 0-7ZM12 9v13M8 22h8M6 13h12',
  deaths: 'M12 2c-2 3-2 5 0 7 2-2 2-4 0-7ZM12 9v13M8 22h8M6 13h12',
  acuity: 'M12 3v4M5.6 5.6l2.8 2.8M3 12h4M18.4 5.6l-2.8 2.8M21 12h-4M12 21a5 5 0 0 0 5-5c0-3-5-8-5-8s-5 5-5 8a5 5 0 0 0 5 5Z',
  allocation: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM15 16l2 2 4-4',
  team: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM3 21v-1a6 6 0 0 1 12 0v1M16 3.1a4 4 0 0 1 0 7.8M21 21v-1a6 6 0 0 0-4-5.6',
  usual: 'M3 12h4l3-8 4 16 3-8h4',
  function: 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 22l2-7-3-2 1-5 4 1 3 3M13 13l2 3v6M8 8l-3 3',
  instruments: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M8 11h1M11 11h5M8 15h1M11 15h5',
  reported: 'M7 8h10M7 12h6M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4V5Z',
  coding: 'M4 7V5h16v2M9 20h6M12 5v15M5 12l-2 3 2 3m14-6 2 3-2 3',
  codingqueries: 'M12 21a9 9 0 1 0-8.1-5.1L3 21l5.1-.9A9 9 0 0 0 12 21Zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2M12 16.5v.01',
  external: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 14h5m0 0-2-2m2 2-2 2',
  interpreters: 'M3 5h8M7 3v2m-2.5 0c.5 3 2.5 6 6 7M9.5 5c-.5 3-3 6-6.5 7M13 21l4-10 4 10m-6.5-3.5h5',
  access: 'M3 5h8M7 3v2m-2.5 0c.5 3 2.5 6 6 7M9.5 5c-.5 3-3 6-6.5 7M13 21l4-10 4 10m-6.5-3.5h5',
  support: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20v-1a5 5 0 0 1 10 0v1m0 0v-1a5 5 0 0 1 10 0v1',
  capacity: 'M9 4a5 5 0 0 0-5 5c0 2 1 3 2 4v5h7v-3h2a2 2 0 0 0 2-2v-2l2-1-2-3a7 7 0 0 0-8-3Zm1 5h3m-3 3h2',
  preferences: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  absences: 'M14 4a2 2 0 1 1 0 .01M10 21l2-6 3 3v3M9 11l3-3 4 3 3 1M12 8l-2 7-4 2',
  absence: 'M14 4a2 2 0 1 1 0 .01M10 21l2-6 3 3v3M9 11l3-3 4 3 3 1M12 8l-2 7-4 2',
  moves: 'M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 14h18M7 10V7h4v3M16 4l3 3-3 3',
  location: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  equipment: 'M4 7h16v10H4zM8 17v3m8-3v3M8 11h3m2 0h3',
  meals: 'M7 3v8m-2-8v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 1-3 4-3 7h3v11',
  diet: 'M7 3v8m-2-8v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 1-3 4-3 7h3v11',
  restrictions: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8',
  communications: 'M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  alerts: 'M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6Zm-2 16a2 2 0 0 0 4 0',
  pain: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-11h.01M15 10h.01M8.5 16c2-2 5-2 7 0',
};

const NS = 'http://www.w3.org/2000/svg';
export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'grip' ? '3.2' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', PATHS[name] ?? PATHS.list);
  svg.append(p);
  return svg;
}

export function viewIcon(code) {
  return icon({ tasks: 'tasksv', handover: 'handoverv', notes: 'notesv' }[code] ?? code);
}
