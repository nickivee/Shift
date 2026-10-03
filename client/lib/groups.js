// Home cards and record screens, grouped by the kind of work. Each worker's own order is kept
// inside a group; anything not listed here goes under "More" so nothing is ever lost.
const CARDS = [
  ['Your shift', ['workstation', 'tasks', 'search', 'handover', 'received', 'allocation', 'team', 'delegation', 'caredue', 'checklists', 'arrivals', 'knowledge']],
  ['Watch closely', ['escalations', 'alerts', 'deterioration', 'acuity', 'monitoring', 'usual', 'priorities', 'function']],
  ['Care', ['wounds', 'careplans', 'meals', 'restrictions', 'preferences', 'communications', 'whanau', 'interpreters', 'equipment', 'instruments', 'problems', 'symptoms', 'interventions', 'treatmentplans', 'pathways', 'recommendations', 'requirements', 'infections', 'antimicrobials', 'sitechecks', 'readiness', 'variances', 'declined', 'capacity', 'reports', 'external']],
  ['Coming and going', ['transfers', 'flow', 'moves', 'discharges', 'absences', 'consults', 'referrals', 'appointments', 'visits', 'followups', 'recalls', 'surveillance', 'screening']],
  ['Roster', ['vacancies', 'swaps', 'leave']],
  ['Safety and records', ['incidents', 'deaths', 'duplicates', 'breakglass', 'downtime', 'cdbook', 'coding', 'codingqueries']],
];
const VIEWS = [
  ['Now', ['overview', 'handover', 'tasks', 'alerts', 'escalations', 'changes', 'deterioration', 'acuity', 'usual', 'notes', 'progress', 'routes', 'team']],
  ['Observations', ['obs', 'bgl', 'weight', 'pain', 'intake', 'falls', 'skin', 'behaviour', 'monitoring', 'triage', 'symptoms', 'reported']],
  ['Assessment and plans', ['assess', 'medical', 'history', 'problems', 'review', 'careplan', 'cares', 'nutrition', 'diet', 'restrictions', 'wounds', 'mobility', 'function', 'goals', 'treatment', 'outcomes', 'instruments', 'treatmentplans', 'pathways', 'checklists', 'caredue', 'recommendations', 'requirements', 'interventions', 'capacity', 'readiness', 'sitechecks', 'variances', 'declined', 'priorities']],
  ['Medicines and results', ['meds', 'allergies', 'results', 'procedures', 'infections', 'antimicrobials']],
  ['Person and whānau', ['family', 'support', 'access', 'communications', 'preferences', 'identity', 'external', 'equipment']],
  ['Coming and going', ['location', 'transfers', 'discharge', 'disposition', 'absence', 'consults', 'referrals', 'appointments', 'visits', 'followups', 'recalls', 'surveillance', 'screening']],
  ['Safety and records', ['incidents', 'death', 'coding']],
];

const grouper = (groups) => {
  const at = new Map(groups.flatMap(([, ids], i) => ids.map((id) => [id, i])));
  // items keep their given order within each group; empty groups are left out.
  return (items, idOf) => {
    const out = groups.map(([title]) => ({ title, items: [] }));
    const more = { title: 'More', items: [] };
    for (const it of items) (at.has(idOf(it)) ? out[at.get(idOf(it))] : more).items.push(it);
    return [...out, more].filter((g) => g.items.length);
  };
};
export const groupCards = grouper(CARDS);
export const groupViews = grouper(VIEWS);
