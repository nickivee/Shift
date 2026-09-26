// Loads the synthetic data set through the same store the application uses. Synthetic
// data is data: it is marked SYNTHETIC at source, and identifiers use the test NHI range.
import { resolve } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from '../db/database.ts';
import { hashPassword } from '../domain/identity.ts';
import { audit } from '../domain/audit.ts';
import { recordInitial } from '../domain/lifecycle.ts';
import { KEY_BY_CODE } from '../config/keys.ts';
import { render } from '../domain/commands.ts';
import { newId, now, todayLocal, addDays } from '../lib/util.ts';

const root = resolve(import.meta.dirname, '../..');
const dbFile = process.env.SHIFT_DB ?? resolve(root, 'var/shift.db');
const reset = process.argv.includes('--reset');

if (existsSync(dbFile)) {
  if (!reset) {
    console.error(`${dbFile} already exists. Use \`npm run seed -- --reset\` to replace it with a fresh synthetic data set.`);
    process.exit(1);
  }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
}

const store = new Store(dbFile);
const S = 'SYNTHETIC';
const today = todayLocal();
const password = process.env.SHIFT_SEED_PASSWORD ?? randomBytes(9).toString('base64url');
const pw = hashPassword(password);
// Synthetic history is placed relative to the moment of seeding so nothing lands in the
// future: "day 0, 06:00" is the most recent such slot, and ordering within a day is kept.
const anchor = Date.now() - 60 * 60 * 1000;
const iso = (daysAgo: number, hh = 9, mm = 0) =>
  new Date(anchor - daysAgo * 86_400_000 - ((23 - hh) * 60 + (59 - mm)) * 60_000).toISOString();

store.tx(() => {
  // Organisations, facilities, services ------------------------------------------------
  store.insert('organisation', { id: 'org-hosp', name: 'Te Awa District Hospital', kind: 'HOSPITAL', data_source: S });
  store.insert('organisation', { id: 'org-arc', name: 'Kōwhai Care Home', kind: 'AGED_RESIDENTIAL_CARE', data_source: S });
  store.insert('facility', { id: 'fac-hosp', organisation_id: 'org-hosp', name: 'Te Awa Hospital' });
  store.insert('facility', { id: 'fac-arc', organisation_id: 'org-arc', name: 'Kōwhai House' });
  store.insert('service', { id: 'svc-genmed', organisation_id: 'org-hosp', facility_id: 'fac-hosp', name: 'General Medicine', sector: 'Specialist medical', subject_label: 'Patient' });
  store.insert('service', { id: 'svc-arc', organisation_id: 'org-arc', facility_id: 'fac-arc', name: 'Residential Care', sector: 'Older people, palliative & disability support', subject_label: 'Resident' });
  store.insert('team', { id: 'team-k', service_id: 'svc-genmed', name: 'Ward K' });

  // Destination registry: aliases are shortcuts, the destination record is the identity.
  const dest = (org: string, alias: string, label: string, service: string, role: string | null, acceptance = 0) =>
    store.insert('destination', { id: newId(), organisation_id: org, alias, label, kind: role ? 'ROLE_IN_SERVICE' : 'SERVICE', service_id: service, role_key: role, requires_acceptance: acceptance });
  dest('org-hosp', 'rn', 'RN, General Medicine', 'svc-genmed', 'genmed-rn');
  dest('org-hosp', 'dr', 'Physician, General Medicine', 'svc-genmed', 'genmed-physician', 1);
  dest('org-hosp', 'genmed', 'General Medicine team', 'svc-genmed', null);
  dest('org-arc', 'rn', 'RN on duty, Residential Care', 'svc-arc', 'arc-rn');
  dest('org-arc', 'caregivers', 'Caregivers, Residential Care', 'svc-arc', 'arc-caregiver');
  dest('org-arc', 'care', 'Residential Care team', 'svc-arc', null);

  // Workforce ---------------------------------------------------------------------------
  const workers: Record<string, string> = {};
  const worker = (username: string, given: string, family: string, display: string) => {
    const pid = newId();
    store.insert('person', { id: pid, family_name: family, given_name: given, data_source: S, created_at: now() });
    const wid = newId();
    store.insert('workforce_person', { id: wid, person_id: pid, display_name: display, username, password_hash: pw, status: 'ACTIVE' });
    workers[username] = wid;
    return wid;
  };
  const authority = (wid: string, profession: string, regulator: string, reg: string, from: string, to: string, scope: string) =>
    store.insert('professional_authority', { id: newId(), workforce_person_id: wid, profession, regulator, registration_number: reg, scope, valid_from: from, valid_to: to, status: 'CURRENT', data_source: S });
  const position = (wid: string, org: string, service: string, title: string, role: string, type = 'PERMANENT') => {
    const eid = newId();
    store.insert('employment', { id: eid, workforce_person_id: wid, organisation_id: org, employment_type: type, start_date: '2024-02-01' });
    const pid = newId();
    store.insert('position', { id: pid, employment_id: eid, service_id: service, title, role_key: role, start_date: '2024-02-01' });
    return { eid, pid };
  };

  const nicki = worker('nicki', 'Nicki', 'V', 'Nicki V');
  authority(nicki, 'Registered Nurse', 'Nursing Council of New Zealand', 'SYN-RN-40117', '2026-04-01', '2027-03-31', 'Registered nurse');
  const nickiArc = position(nicki, 'org-arc', 'svc-arc', 'Registered Nurse', 'arc-rn');
  const nickiHosp = position(nicki, 'org-hosp', 'svc-genmed', 'Registered Nurse (casual pool)', 'genmed-rn', 'CASUAL');

  const tama = worker('tama', 'Tama', 'Walker', 'Tama Walker');
  const tamaArc = position(tama, 'org-arc', 'svc-arc', 'Caregiver', 'arc-caregiver');

  const hannah = worker('hannah', 'Hannah', 'Li', 'Dr Hannah Li');
  authority(hannah, 'Medical Practitioner', 'Medical Council of New Zealand', 'SYN-MC-77120', '2026-04-01', '2027-03-31', 'Vocational: internal medicine');
  const hannahHosp = position(hannah, 'org-hosp', 'svc-genmed', 'Consultant Physician', 'genmed-physician');

  const sam = worker('sam', 'Sam', 'Patel', 'Dr Sam Patel');
  authority(sam, 'Medical Practitioner', 'Medical Council of New Zealand', 'SYN-MC-81544', '2026-04-01', '2027-03-31', 'General');
  position(sam, 'org-hosp', 'svc-genmed', 'Medical Registrar', 'genmed-physician');

  const alex = worker('alex', 'Alex', 'Morgan', 'Alex Morgan');
  store.insert('professional_authority', { id: newId(), workforce_person_id: alex, profession: 'Registered Nurse', regulator: 'Nursing Council of New Zealand', registration_number: 'SYN-RN-39002', scope: 'Registered nurse', valid_from: '2025-04-01', valid_to: '2026-08-31', status: 'CURRENT', data_source: S });
  position(alex, 'org-hosp', 'svc-genmed', 'Registered Nurse', 'genmed-rn');

  // People receiving care -----------------------------------------------------------------
  let mrn = 0;
  const patient = (p: { given: string; family: string; preferred?: string; dob: string; gender: string; ethnicity: string; iwi?: string; nhi: string; service: string; location: string; kind: string; admittedDaysAgo: number }) => {
    const id = newId();
    store.insert('person', { id, family_name: p.family, given_name: p.given, preferred_name: p.preferred ?? null, date_of_birth: p.dob, gender: p.gender, ethnicity: p.ethnicity, iwi: p.iwi ?? null, data_source: S, created_at: now() });
    store.insert('external_identifier', { id: newId(), person_id: id, system: 'NHI', value: p.nhi, verification: S, created_at: now() });
    store.insert('external_identifier', { id: newId(), person_id: id, system: 'LOCAL_MRN', value: `TEST-${String(++mrn).padStart(5, '0')}`, verification: S, created_at: now() });
    store.insert('encounter', { id: newId(), person_id: id, service_id: p.service, location: p.location, kind: p.kind, started_at: iso(p.admittedDaysAgo, 14), state: 'ACTIVE' });
    return id;
  };

  const aroha = patient({ given: 'Aroha', family: 'Rangi', dob: '1964-03-14', gender: 'Female', ethnicity: 'Māori', iwi: 'Ngāi Tahu', nhi: 'ZZZ9999', service: 'svc-genmed', location: 'Ward K Bed 4', kind: 'INPATIENT', admittedDaysAgo: 2 });
  const wiremu = patient({ given: 'Wiremu', family: 'Te Whare', dob: '1951-11-02', gender: 'Male', ethnicity: 'Māori', iwi: 'Ngāti Porou', nhi: 'ZZZ0016', service: 'svc-genmed', location: 'Ward K Bed 5', kind: 'INPATIENT', admittedDaysAgo: 4 });
  const sione = patient({ given: 'Sione', family: 'Tuilagi', dob: '1972-06-21', gender: 'Male', ethnicity: 'Samoan', nhi: 'ZZZ0024', service: 'svc-genmed', location: 'Ward K Bed 6', kind: 'INPATIENT', admittedDaysAgo: 1 });
  const margaret = patient({ given: 'Margaret', family: 'Oliver', preferred: 'Peggy', dob: '1938-09-30', gender: 'Female', ethnicity: 'NZ European', nhi: 'ZZZ0032', service: 'svc-genmed', location: 'Ward K Bed 7', kind: 'INPATIENT', admittedDaysAgo: 6 });
  const james = patient({ given: 'James', family: 'Chen', dob: '1985-01-17', gender: 'Male', ethnicity: 'Chinese', nhi: 'ZZZ0040', service: 'svc-genmed', location: 'Ward K Bed 8', kind: 'INPATIENT', admittedDaysAgo: 0 });

  const rua = patient({ given: 'Rua', family: 'Hēnare', dob: '1939-02-08', gender: 'Female', ethnicity: 'Māori', iwi: 'Ngāpuhi', nhi: 'ZZZ0059', service: 'svc-arc', location: 'Room 3', kind: 'RESIDENTIAL', admittedDaysAgo: 420 });
  const elsie = patient({ given: 'Elsie', family: 'Morgan', dob: '1933-07-12', gender: 'Female', ethnicity: 'NZ European', nhi: 'ZZZ0067', service: 'svc-arc', location: 'Room 5', kind: 'RESIDENTIAL', admittedDaysAgo: 910 });
  const frank = patient({ given: 'Frank', family: 'Dawson', dob: '1941-12-01', gender: 'Male', ethnicity: 'NZ European', nhi: 'ZZZ0075', service: 'svc-arc', location: 'Room 8', kind: 'RESIDENTIAL', admittedDaysAgo: 150 });
  const losa = patient({ given: 'Losa', family: 'Faleolo', dob: '1946-04-19', gender: 'Female', ethnicity: 'Tongan', nhi: 'ZZZ0083', service: 'svc-arc', location: 'Room 11', kind: 'RESIDENTIAL', admittedDaysAgo: 60 });
  const bill = patient({ given: 'William', family: 'Grant', preferred: 'Bill', dob: '1936-10-25', gender: 'Male', ethnicity: 'NZ European', nhi: 'ZZZ0091', service: 'svc-arc', location: 'Room 14', kind: 'RESIDENTIAL', admittedDaysAgo: 1200 });

  // Safety-critical information: allergy recorded, no known allergies, or not recorded.
  const allergy = (pid: string, kind: string, substance: string | null, reaction: string | null, severity: string | null, by: string) =>
    store.insert('allergy', { id: newId(), person_id: pid, kind, substance, reaction, severity, certainty: kind === 'NO_KNOWN_ALLERGIES' ? null : 'CONFIRMED', state: 'ACTIVE', source: 'Patient report, confirmed with GP record', recorded_by: by, recorded_at: iso(2, 15), data_source: S });
  allergy(aroha, 'ALLERGY', 'Penicillin', 'Urticarial rash', 'Moderate', hannah);
  allergy(wiremu, 'ALLERGY', 'Codeine', 'Vomiting', 'Mild', hannah);
  allergy(sione, 'NO_KNOWN_ALLERGIES', null, null, null, hannah);
  allergy(margaret, 'INTOLERANCE', 'Morphine', 'Confusion', 'Moderate', hannah);
  allergy(rua, 'ALLERGY', 'Sulfonamides', 'Rash', 'Moderate', nicki);
  allergy(elsie, 'NO_KNOWN_ALLERGIES', null, null, null, nicki);
  allergy(frank, 'ALLERGY', 'Elastoplast', 'Skin blistering', 'Mild', nicki);
  allergy(bill, 'NO_KNOWN_ALLERGIES', null, null, null, nicki);
  // James Chen and Losa Faleolo: allergies not yet recorded.

  const med = (pid: string, medicine: string, dose: string, route: string, frequency: string, indication: string, prescriber: string, state = 'ACTIVE') =>
    store.insert('medication', { id: newId(), person_id: pid, medicine, dose, route, frequency, indication, state, prescriber, started_at: iso(3), source: 'Medication chart', data_source: S });
  med(aroha, 'Doxycycline', '100 mg', 'Oral', 'Twice daily', 'Community-acquired pneumonia', 'Dr Hannah Li');
  med(aroha, 'Paracetamol', '1 g', 'Oral', 'Four times daily', 'Pain / fever', 'Dr Hannah Li');
  med(aroha, 'Metformin', '500 mg', 'Oral', 'Twice daily', 'Type 2 diabetes', 'GP (admission reconciliation)');
  med(aroha, 'Enoxaparin', '40 mg', 'Subcutaneous', 'Daily', 'VTE prophylaxis', 'Dr Hannah Li');
  med(wiremu, 'Furosemide', '40 mg', 'Oral', 'Mane', 'Heart failure', 'Dr Hannah Li');
  med(wiremu, 'Bisoprolol', '2.5 mg', 'Oral', 'Daily', 'Heart failure', 'Dr Hannah Li');
  med(wiremu, 'Cilazapril', '2.5 mg', 'Oral', 'Daily', 'Heart failure', 'Dr Hannah Li', 'HELD');
  med(sione, 'Ceftriaxone', '2 g', 'IV', 'Daily', 'Cellulitis', 'Dr Sam Patel');
  med(margaret, 'Levothyroxine', '50 mcg', 'Oral', 'Daily', 'Hypothyroidism', 'GP (admission reconciliation)');
  med(rua, 'Donepezil', '5 mg', 'Oral', 'Nocte', 'Dementia', 'Visiting GP');
  med(rua, 'Paracetamol', '1 g', 'Oral', 'Twice daily', 'Osteoarthritis', 'Visiting GP');
  med(elsie, 'Quetiapine', '12.5 mg', 'Oral', 'Nocte', 'Distress in dementia (reviewed monthly)', 'Visiting GP');
  med(frank, 'Insulin glargine', '14 units', 'Subcutaneous', 'Nocte', 'Type 2 diabetes', 'Visiting GP');
  med(frank, 'Metformin', '1 g', 'Oral', 'Twice daily', 'Type 2 diabetes', 'Visiting GP');
  med(losa, 'Amlodipine', '5 mg', 'Oral', 'Daily', 'Hypertension', 'Visiting GP');
  med(bill, 'Tiotropium', '18 mcg', 'Inhaled', 'Daily', 'COPD', 'Visiting GP');

  const result = (pid: string, test: string, value: string, units: string, range: string, flag: string | null, daysAgo: number, state = 'AVAILABLE') => {
    const id = newId();
    store.insert('result', { id, person_id: pid, test, value, units, reference_range: range, flag, state, performed_at: iso(daysAgo, 6, 30), released_at: iso(daysAgo, 9), source: 'Te Awa Laboratory', reviewed_by: state === 'REVIEWED' ? hannah : null, reviewed_at: state === 'REVIEWED' ? iso(daysAgo, 11) : null, data_source: S });
    recordInitial(store, 'result', id, 'AVAILABLE', { actorId: null, workContextId: null }, 'Released by laboratory');
  };
  result(aroha, 'CRP', '148', 'mg/L', '<5', 'H', 2, 'REVIEWED');
  result(aroha, 'CRP', '92', 'mg/L', '<5', 'H', 0);
  result(aroha, 'White cell count', '13.8', '×10⁹/L', '4.0–11.0', 'H', 0);
  result(aroha, 'Sodium', '134', 'mmol/L', '135–145', 'L', 0);
  result(aroha, 'Creatinine', '88', 'µmol/L', '45–90', null, 0);
  result(wiremu, 'Potassium', '5.4', 'mmol/L', '3.5–5.2', 'H', 0);
  result(wiremu, 'Creatinine', '162', 'µmol/L', '60–105', 'H', 0);
  result(wiremu, 'NT-proBNP', '4200', 'ng/L', '<300', 'H', 3, 'REVIEWED');
  result(sione, 'CRP', '210', 'mg/L', '<5', 'H', 1);
  result(margaret, 'TSH', '3.1', 'mU/L', '0.4–4.0', null, 2);

  const care = (pid: string, need: string, goal: string, intervention: string, responsible: string, review: number) =>
    store.insert('care_plan_item', { id: newId(), person_id: pid, need, goal, intervention, responsible, review_date: addDays(today, review), state: 'ACTIVE', created_at: iso(30), data_source: S });
  care(rua, 'Mobility', 'Walks safely to dining room', 'Walker at all times; supervise transfers', 'Caregivers', 21);
  care(rua, 'Cognition', 'Feels settled and oriented', 'Calm reassurance; photo board of whānau; te reo greetings', 'All staff', 21);
  care(elsie, 'Distress in the late afternoon', 'Fewer distressed episodes', 'Quiet lounge after 3 pm; music she enjoys; avoid rushing cares', 'All staff', 14);
  care(elsie, 'Nutrition', 'Stable weight', 'Finger food; offer snacks between meals; weigh monthly', 'Caregivers', 28);
  care(frank, 'Diabetes', 'BGL within plan set by GP', 'BGL before breakfast and tea; report per GP plan', 'RN', 14);
  care(frank, 'Skin', 'Heel skin intact', 'Heel offloading in bed; check heels at each cares', 'Caregivers', 7);
  care(losa, 'Settling in', 'Feels at home', 'Family visits welcome anytime; Tongan-speaking staff where possible', 'All staff', 10);
  care(bill, 'Breathing', 'Manages daily activities', 'Pace activities; inhaler technique check weekly', 'RN', 14);
  care(aroha, 'Breathing', 'SpO2 as set by medical team', 'Observations 4-hourly; sit upright; deep breathing', 'RN', 2);
  care(wiremu, 'Fluid balance', 'Daily weight trending down', 'Daily weight before breakfast; fluid restriction 1.5 L', 'RN', 2);

  // Prior entries, recorded by the people who made them.
  const event = (pid: string, service: string, code: string, fields: Record<string, string | number>, author: string, positionId: string, roleLabel: string, daysAgo: number, hh: number) => {
    const t = KEY_BY_CODE.get(code)!;
    const id = newId();
    store.insert('clinical_event', {
      id, lineage_id: id, version: 1, person_id: pid, category: t.category, key_code: code, key_version: t.version,
      fields_json: JSON.stringify(fields), rendered_text: render(t, fields), author_id: author, author_position_id: positionId,
      author_role_label: roleLabel, service_id: service, recorded_at: iso(daysAgo, hh, 5), effective_at: iso(daysAgo, hh), state: 'CURRENT',
      urgent: 0, collection: 'DIRECT', data_source: S,
    });
    return id;
  };
  const rnHosp = 'Registered Nurse, General Medicine';
  const drHosp = 'Physician, General Medicine';
  const rnArc = 'Registered Nurse, Residential Care';
  const cgArc = 'Caregiver / Kaiāwhina, Residential Care';
  event(aroha, 'svc-genmed', '.obs', { bp: '118/72', hr: 104, spo2: 92, rr: 24, t: 38.4, o2: '2 L nasal prongs', loc: 'Alert' }, nicki, nickiHosp.pid, rnHosp, 1, 8);
  event(aroha, 'svc-genmed', '.obs', { bp: '122/76', hr: 96, spo2: 94, rr: 20, t: 37.9, o2: '2 L nasal prongs' }, nicki, nickiHosp.pid, rnHosp, 1, 14);
  event(aroha, 'svc-genmed', '.obs', { bp: '126/78', hr: 88, spo2: 95, rr: 18, t: 37.3 }, nicki, nickiHosp.pid, rnHosp, 0, 6);
  event(aroha, 'svc-genmed', '.review', { reviewed: 'Ward round', impression: 'Right lower lobe pneumonia, improving', plan: 'Continue doxycycline; wean oxygen; mobilise', next: 'Tomorrow ward round' }, hannah, hannahHosp.pid, drHosp, 1, 10);
  event(aroha, 'svc-genmed', '.problem', { problem: 'Community-acquired pneumonia', status: 'Active' }, hannah, hannahHosp.pid, drHosp, 2, 16);
  event(aroha, 'svc-genmed', '.problem', { problem: 'Type 2 diabetes', status: 'Active', note: 'Diet and metformin' }, hannah, hannahHosp.pid, drHosp, 2, 16);
  const arohaBgl = event(aroha, 'svc-genmed', '.bgl', { bgl: 11.2, timing: 'Pre-meal' }, nicki, nickiHosp.pid, rnHosp, 0, 7);
  event(wiremu, 'svc-genmed', '.weight', { weight: 84.6, method: 'Standing' }, nicki, nickiHosp.pid, rnHosp, 1, 7);
  event(wiremu, 'svc-genmed', '.weight', { weight: 83.9, method: 'Standing' }, nicki, nickiHosp.pid, rnHosp, 0, 7);
  event(wiremu, 'svc-genmed', '.intake', { oral: 1400, output: 2100 }, nicki, nickiHosp.pid, rnHosp, 1, 22);
  event(sione, 'svc-genmed', '.wound', { site: 'Left lower leg', type: 'Other', size: 'Erythema 12 x 8', dressing: 'Nil, marked border', next: 'Review border each shift' }, nicki, nickiHosp.pid, rnHosp, 0, 8);
  event(margaret, 'svc-genmed', '.progress', { note: 'Peggy settled overnight. Oriented to ward. Daughter visiting this afternoon to discuss discharge supports.' }, nicki, nickiHosp.pid, rnHosp, 0, 6);

  event(rua, 'svc-arc', '.cares', { hygiene: 'Assisted', mobility: 'Walker', comment: 'Enjoyed shower, chatted about her mokopuna' }, tama, tamaArc.pid, cgArc, 0, 8);
  event(rua, 'svc-arc', '.obs', { bp: '138/80', hr: 76, spo2: 96, rr: 16, t: 36.6 }, nicki, nickiArc.pid, rnArc, 3, 10);
  const elsieBeh = event(elsie, 'svc-arc', '.behaviour', { behaviour: 'Calling out and pacing corridor', trigger: 'Late afternoon, lounge noisy', response: 'Walked with her to quiet lounge, played her music', outcome: 'Settled after 20 minutes' }, tama, tamaArc.pid, cgArc, 1, 16);
  event(elsie, 'svc-arc', '.weight', { weight: 52.1, method: 'Chair' }, tama, tamaArc.pid, cgArc, 12, 10);
  event(frank, 'svc-arc', '.bgl', { bgl: 7.4, timing: 'Fasting' }, nicki, nickiArc.pid, rnArc, 0, 7);
  event(frank, 'svc-arc', '.skin', { area: 'Both heels', finding: 'Redness', care: 'Heels offloaded, RN informed' }, tama, tamaArc.pid, cgArc, 0, 9);
  event(losa, 'svc-arc', '.family', { who: 'Mele', relationship: 'Daughter', discussed: 'Settling in, favourite foods, church visits Sunday', outcome: 'Mele to bring photos and a tapa cloth for the room' }, nicki, nickiArc.pid, rnArc, 2, 15);
  const billFall = event(bill, 'svc-arc', '.fall', { where: 'Bathroom', witnessed: 'No', head: 'No', injury: 'Nil visible', action: 'Assisted up with hoist after RN check' }, nicki, nickiArc.pid, rnArc, 1, 5);

  // Handover marks on existing entries (references, not copies).
  const mark = (lineage: string, pid: string, service: string, by: string) =>
    store.insert('handover_mark', { id: newId(), event_lineage_id: lineage, person_id: pid, service_id: service, marked_by: by, marked_at: now() });
  mark(arohaBgl, aroha, 'svc-genmed', nicki);
  mark(elsieBeh, elsie, 'svc-arc', tama);
  mark(billFall, bill, 'svc-arc', nicki);

  // Tasks.
  const task = (pid: string, service: string, description: string, due: string | null, assigned: string | null, by: string) => {
    const id = newId();
    store.insert('task', { id, person_id: pid, description, due_at: due, service_id: service, assigned_to: assigned, state: assigned ? 'ASSIGNED' : 'CREATED', created_by: by, created_at: iso(0, 7) });
    recordInitial(store, 'task', id, 'CREATED', { actorId: by, workContextId: null });
    if (assigned) store.insert('state_transition', { id: newId(), object_type: 'task', object_id: id, from_state: 'CREATED', to_state: 'ASSIGNED', actor_id: by, at: iso(0, 7), reason: 'Assigned at creation' });
  };
  task(aroha, 'svc-genmed', 'Repeat CRP and FBC', 'Tomorrow 06:00', 'role:genmed-rn', hannah);
  task(wiremu, 'svc-genmed', 'Review potassium result and cilazapril hold', 'Today', 'role:genmed-physician', nicki);
  task(bill, 'svc-arc', 'Neuro observations follow-up after unwitnessed fall', 'Today 14:00', 'role:arc-rn', nicki);
  task(frank, 'svc-arc', 'Heel check at each cares', 'Each shift', 'role:arc-caregiver', nicki);

  // Allocations for the coming weeks.
  for (let d = -1; d < 30; d++) {
    const date = addDays(today, d);
    for (const pid of [rua, elsie, frank]) store.insert('allocation', { id: newId(), workforce_person_id: nicki, person_id: pid, service_id: 'svc-arc', shift_date: date, created_at: now() });
    for (const pid of [aroha, wiremu]) store.insert('allocation', { id: newId(), workforce_person_id: nicki, person_id: pid, service_id: 'svc-genmed', shift_date: date, created_at: now() });
    for (const pid of [rua, elsie, frank, losa, bill]) store.insert('allocation', { id: newId(), workforce_person_id: tama, person_id: pid, service_id: 'svc-arc', shift_date: date, created_at: now() });
  }

  // PERSONAL: roster, attendance, availability, open shifts, pay, leave, credentials, training.
  const shiftTimes = [['07:00', '15:30'], ['14:30', '23:00'], ['22:45', '07:15']];
  for (let d = -14; d < 28; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (dow === 0 || dow === 3) continue;
    const [start, end] = shiftTimes[(d + 14) % 5 === 4 ? 1 : 0];
    const onHosp = dow === 5;
    const rid = newId();
    store.insert('roster_shift', { id: rid, workforce_person_id: nicki, position_id: onHosp ? nickiHosp.pid : nickiArc.pid, service_id: onHosp ? 'svc-genmed' : 'svc-arc', shift_date: date, start_time: start, end_time: end, state: 'PLANNED', data_source: S });
    if (d < 0) {
      const late = d === -3;
      store.insert('actual_shift', { id: newId(), roster_shift_id: rid, workforce_person_id: nicki, started_at: `${date}T${start}`, ended_at: `${date}T${late ? '16:15' : end}`, variance: late ? 'Stayed 45 min past rostered finish (handover of deteriorating resident)' : null, data_source: S });
    }
    if (dow !== 6 && dow !== 1) store.insert('roster_shift', { id: newId(), workforce_person_id: tama, position_id: tamaArc.pid, service_id: 'svc-arc', shift_date: date, start_time: '07:00', end_time: '15:30', state: 'PLANNED', data_source: S });
  }
  store.insert('availability', { id: newId(), workforce_person_id: nicki, available_date: addDays(today, 10), period: 'PM', preference: 'AVAILABLE', recorded_at: now() });
  store.insert('availability', { id: newId(), workforce_person_id: nicki, available_date: addDays(today, 17), period: 'ALL_DAY', preference: 'UNAVAILABLE', private_note: 'Whānau event', recorded_at: now() });
  for (const [svc, role, d, s, e] of [
    ['svc-arc', 'arc-rn', 3, '14:30', '23:00'], ['svc-arc', 'arc-rn', 9, '22:45', '07:15'], ['svc-genmed', 'genmed-rn', 5, '07:00', '15:30'],
    ['svc-genmed', 'genmed-rn', 12, '14:30', '23:00'], ['svc-arc', 'arc-caregiver', 4, '07:00', '15:30'], ['svc-genmed', 'genmed-physician', 6, '08:00', '18:00'],
  ] as const) {
    store.insert('open_shift', { id: newId(), service_id: svc, role_key: role, shift_date: addDays(today, d), start_time: s, end_time: e, state: 'OPEN', created_at: now(), data_source: S });
  }
  const pay = (wid: string, eid: string, weeksAgo: number, hours: number, rateCents: number, extra: [string, number][]) => {
    const end = addDays(today, -7 * weeksAgo - 3);
    const start = addDays(end, -13);
    const ordinary = Math.round(hours * rateCents);
    const lines = [{ label: `Ordinary hours (${hours} h at $${(rateCents / 100).toFixed(2)})`, cents: ordinary }, ...extra.map(([label, cents]) => ({ label, cents }))];
    const gross = lines.reduce((a, l) => a + l.cents, 0);
    const deductions = [{ label: 'PAYE', cents: -Math.round(gross * 0.21) }, { label: 'KiwiSaver employee 3%', cents: -Math.round(gross * 0.03) }];
    const ded = deductions.reduce((a, l) => a - l.cents, 0);
    store.insert('payslip', { id: newId(), workforce_person_id: wid, employment_id: eid, period_start: start, period_end: end, pay_date: addDays(end, 4), lines_json: JSON.stringify([...lines, ...deductions]), gross_cents: gross, deductions_cents: ded, net_cents: gross - ded, data_source: S });
  };
  pay(nicki, nickiArc.eid, 0, 64, 4410, [['Weekend penal', 9240], ['Overtime', 4961]]);
  pay(nicki, nickiArc.eid, 2, 72, 4410, [['Night allowance', 6600]]);
  pay(nicki, nickiHosp.eid, 0, 8, 4695, []);
  pay(tama, tamaArc.eid, 0, 64, 2810, [['Weekend penal', 5620]]);
  for (const [wid, type, hours] of [[nicki, 'Annual leave', 96.5], [nicki, 'Sick leave', 56], [nicki, 'Alternative holiday', 8], [tama, 'Annual leave', 40], [tama, 'Sick leave', 80]] as const) {
    store.insert('leave_balance', { workforce_person_id: wid, leave_type: type, hours, as_at: today, data_source: S });
  }
  store.insert('leave_request', { id: newId(), workforce_person_id: nicki, leave_type: 'Annual leave', start_date: addDays(today, 40), end_date: addDays(today, 47), state: 'APPROVED', requested_at: iso(20) });
  for (const [kind, title, issuer, ref, from, to] of [
    ['Certificate', 'CPR and first aid', 'Synthetic Training Ltd', 'SYN-CPR-2211', '2026-02-10', '2027-02-10'],
    ['Competency', 'Medicine administration competency', 'Kōwhai Care Home', 'SYN-MAC-118', '2026-05-01', '2027-05-01'],
    ['Check', 'Safety check (Children’s Act 2014 workforce check)', 'Kōwhai Care Home', 'SYN-SC-3310', '2024-01-20', '2027-01-20'],
  ] as const) {
    store.insert('credential', { id: newId(), workforce_person_id: nicki, kind, title, issuer, reference: ref, valid_from: from, valid_to: to, data_source: S });
  }
  for (const [course, provider, done, expires, state] of [
    ['Fire and emergency evacuation', 'Kōwhai Care Home', '2026-03-12', '2027-03-12', 'COMPLETED'],
    ['Infection prevention and control', 'Kōwhai Care Home', '2025-10-02', addDays(today, 6), 'DUE'],
    ['Manual handling and hoist use', 'Kōwhai Care Home', '2026-06-18', '2028-06-18', 'COMPLETED'],
    ['Te Tiriti o Waitangi and cultural safety', 'Synthetic Training Ltd', null, null, 'ENROLLED'],
    ['Restraint minimisation and safe practice', 'Kōwhai Care Home', '2026-01-30', '2027-01-30', 'COMPLETED'],
  ] as const) {
    store.insert('training_record', { id: newId(), workforce_person_id: nicki, course, provider, completed_at: done, expires_at: expires, state, data_source: S });
  }
  store.insert('credential', { id: newId(), workforce_person_id: tama, kind: 'Qualification', title: 'NZ Certificate in Health and Wellbeing (Level 3)', issuer: 'Synthetic Training Ltd', reference: 'SYN-HW3-5521', valid_from: '2025-06-01', data_source: S });
  store.insert('training_record', { id: newId(), workforce_person_id: tama, course: 'Manual handling and hoist use', provider: 'Kōwhai Care Home', completed_at: '2026-06-18', expires_at: '2028-06-18', state: 'COMPLETED', data_source: S });

  // Doctors' shared knowledge.
  const q = newId();
  store.insert('knowledge_question', { id: q, author_id: sam, topic: 'Heart failure with rising potassium', body: 'Older adult with HFrEF, K 5.4 and creatinine up from baseline after diuretic increase. How are colleagues sequencing ACE inhibitor holds versus diuretic changes on the ward?', created_at: iso(1, 13), state: 'OPEN' });
  store.insert('knowledge_reply', { id: newId(), question_id: q, author_id: hannah, body: 'I hold the ACE inhibitor first while the diuretic effect settles, recheck electrolytes in 24 h, and document the restart criteria in the plan so it is not lost at discharge.', created_at: iso(1, 15), state: 'VISIBLE' });

  audit(store, { space: 'SYSTEM', operation: 'SEED_SYNTHETIC', outcome: 'COMMITTED', reason: 'Synthetic data set loaded' });
});

console.log(`Synthetic data loaded into ${dbFile}`);
console.log('Workforce usernames: nicki (RN, two positions), tama (caregiver), hannah and sam (physicians), alex (RN with expired practising authority)');
if (!process.env.SHIFT_SEED_PASSWORD) console.log(`Password for all synthetic workforce accounts (shown once): ${password}`);
