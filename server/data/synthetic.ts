// The synthetic data set, loaded through the same store the application uses. Synthetic
// data is data: it is marked SYNTHETIC at source, and identifiers use the test NHI range.
import type { Store } from '../db/database.ts';
import { hashPassword } from '../domain/identity.ts';
import { audit } from '../domain/audit.ts';
import { recordInitial } from '../domain/lifecycle.ts';
import { KEY_BY_CODE } from '../config/keys.ts';
import { INSTRUMENT_BY_CODE } from '../config/instruments.ts';
import { render } from '../domain/commands.ts';
import { currentPeriod, nextPeriod } from '../config/allocation.ts';
import { LEVEL_BY_ID } from '../config/acuity.ts';
import { evidence as acuityEvidence } from '../domain/acuity.ts';
import { OUTCOMES as DETERIORATION_OUTCOMES } from '../domain/deterioration.ts';
import { newId, now, todayLocal, addDays, sha256 } from '../lib/util.ts';

export const SYNTHETIC_USERS = [
  { username: 'nicki', label: 'Nicki V, Registered Nurse (Residential Care and General Medicine)' },
  { username: 'tama', label: 'Tama Walker, Caregiver (Residential Care)' },
  { username: 'hannah', label: 'Dr Hannah Li, Consultant Physician (General Medicine)' },
  { username: 'sam', label: 'Dr Sam Patel, Medical Registrar (General Medicine)' },
  { username: 'alex', label: 'Alex Morgan, Registered Nurse whose practising certificate has expired' },
  { username: 'kate', label: 'Kate Rowe, Registered Nurse (Residential Care)' },
  { username: 'jo', label: 'Jo Tipene, Rostering (Residential Care)' },
  { username: 'mere', label: 'Mere Parata, Registered Nurse (Emergency Department)' },
  { username: 'ravi', label: 'Dr Ravi Singh, Emergency Physician (Emergency Department)' },
  { username: 'lena', label: 'Lena Fox, Physiotherapist (General Medicine caseload)' },
  { username: 'pita', label: 'Pita Hohaia, Patient Flow Coordinator (Te Awa Hospital)' },
  { username: 'grace', label: 'Grace Tupou, Registered Nurse (General Medicine)' },
  { username: 'lee', label: 'Lee Wong, Clinical Coder (Te Awa Hospital)' },
];

const SET = 58;

export function loadSynthetic(store: Store, password: string): void {
  const S = 'SYNTHETIC';
  const today = todayLocal();
  const pw = hashPassword(password);
  // Synthetic history is placed relative to the moment of loading so nothing lands in the
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
  extendSynthetic(store, password);
}

// Later additions to the synthetic data set. A device holding an earlier synthetic set
// receives each missing set once; a database without the synthetic organisations is never touched.
export function extendSynthetic(store: Store, password: string): void {
  if (!store.get("SELECT 1 FROM organisation WHERE id = 'org-hosp' AND data_source = 'SYNTHETIC'")) return;
  const at = Number(store.get<{ value: string }>("SELECT value FROM meta WHERE key = 'synthetic_set'")?.value ?? 1);
  if (at >= SET) return;
  store.tx(() => {
    if (at < 2) set2(store, password);
    if (at < 3) set3(store, password);
    if (at < 4) set4(store);
    if (at < 5) set5(store);
    if (at < 6) set6(store);
    if (at < 7) set7(store);
    if (at < 8) set8(store);
    if (at < 9) set9(store);
    if (at < 10) set10(store);
    if (at < 11) set11(store);
    if (at < 12) set12(store);
    if (at < 13) set13(store);
    if (at < 14) set14(store);
    if (at < 15) set15(store);
    if (at < 16) set16(store);
    if (at < 17) set17(store);
    if (at < 18) set18(store);
    if (at < 19) set19(store);
    if (at < 20) set20(store);
    if (at < 21) set21(store);
    if (at < 22) set22(store);
    if (at < 23) set23(store);
    if (at < 24) set24(store, password);
    if (at < 25) set25(store);
    if (at < 26) set26(store);
    if (at < 27) set27(store);
    if (at < 28) set28(store);
    if (at < 29) set29(store);
    if (at < 30) set30(store, password);
    if (at < 31) set31(store);
    if (at < 32) set32(store);
    if (at < 33) set33(store);
    if (at < 34) set34(store);
    if (at < 35) set35(store);
    if (at < 36) set36(store);
    if (at < 37) set37(store);
    if (at < 38) set38(store);
    if (at < 39) set39(store);
    if (at < 40) set40(store);
    if (at < 41) set41(store);
    if (at < 42) set42(store);
    if (at < 43) set43(store);
    if (at < 44) set44(store);
    if (at < 45) set45(store);
    if (at < 46) set46(store);
    if (at < 47) set47(store);
    if (at < 48) set48(store);
    if (at < 49) set49(store);
    if (at < 50) set50(store);
    if (at < 51) set51(store);
    if (at < 52) set52(store);
    if (at < 53) set53(store);
    if (at < 54) set54(store);
    if (at < 55) set55(store);
    if (at < 56) set56(store);
    if (at < 57) set57(store);
    if (at < 58) set58(store);
    store.run("INSERT INTO meta (key, value) VALUES ('synthetic_set', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(SET));
    audit(store, { space: 'SYSTEM', operation: 'SEED_SYNTHETIC', outcome: 'COMMITTED', reason: `Synthetic data set ${SET} added` });
  });
}

const newWorker = (store: Store, pw: string, username: string, given: string, family: string, display: string) => {
  const pid = newId();
  store.insert('person', { id: pid, family_name: family, given_name: given, data_source: 'SYNTHETIC', created_at: now() });
  const wid = newId();
  store.insert('workforce_person', { id: wid, person_id: pid, display_name: display, username, password_hash: pw, status: 'ACTIVE' });
  return wid;
};

// Set 2: the Emergency Department, a physiotherapy caseload and rostering for Residential Care.
function set2(store: Store, password: string): void {
  const S = 'SYNTHETIC';
  const today = todayLocal();
  const pw = hashPassword(password);
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const byUser = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const hannah = byUser('hannah');
  const nicki = byUser('nicki');

  store.tx(() => {
    store.insert('service', { id: 'svc-ed', organisation_id: 'org-hosp', facility_id: 'fac-hosp', name: 'Emergency Department', sector: 'Emergency & acute', subject_label: 'Patient' });
    store.insert('service', { id: 'svc-physio', organisation_id: 'org-hosp', facility_id: 'fac-hosp', name: 'Physiotherapy', sector: 'Allied health', subject_label: 'Patient' });
    const dest = (alias: string, label: string, service: string, role: string | null, acceptance = 0) =>
      store.insert('destination', { id: newId(), organisation_id: 'org-hosp', alias, label, kind: role ? 'ROLE_IN_SERVICE' : 'SERVICE', service_id: service, role_key: role, requires_acceptance: acceptance });
    dest('ed', 'Emergency Department team', 'svc-ed', null);
    dest('edrn', 'RN, Emergency Department', 'svc-ed', 'ed-rn');
    dest('eddr', 'Emergency doctor', 'svc-ed', 'ed-doctor', 1);
    dest('physio', 'Physiotherapy referral', 'svc-physio', 'physio', 1);

    const worker = (username: string, given: string, family: string, display: string) => newWorker(store, pw, username, given, family, display);
    const authority = (wid: string, profession: string, regulator: string, reg: string, scope: string) =>
      store.insert('professional_authority', { id: newId(), workforce_person_id: wid, profession, regulator, registration_number: reg, scope, valid_from: '2026-04-01', valid_to: '2027-03-31', status: 'CURRENT', data_source: S });
    const position = (wid: string, org: string, service: string, title: string, role: string) => {
      const eid = newId();
      store.insert('employment', { id: eid, workforce_person_id: wid, organisation_id: org, employment_type: 'PERMANENT', start_date: '2024-02-01' });
      const pid = newId();
      store.insert('position', { id: pid, employment_id: eid, service_id: service, title, role_key: role, start_date: '2024-02-01' });
      return { eid, pid };
    };
    const roster = (wid: string, positionId: string, service: string, start: string, end: string, skip: number[]) => {
      for (let d = -7; d < 28; d++) {
        const date = addDays(today, d);
        if (skip.includes(new Date(`${date}T00:00:00`).getDay())) continue;
        store.insert('roster_shift', { id: newId(), workforce_person_id: wid, position_id: positionId, service_id: service, shift_date: date, start_time: start, end_time: end, state: 'PLANNED', data_source: S });
      }
    };
    const leave = (wid: string, annual: number, sick: number) => {
      store.insert('leave_balance', { workforce_person_id: wid, leave_type: 'Annual leave', hours: annual, as_at: today, data_source: S });
      store.insert('leave_balance', { workforce_person_id: wid, leave_type: 'Sick leave', hours: sick, as_at: today, data_source: S });
    };

    const kate = worker('kate', 'Kate', 'Rowe', 'Kate Rowe');
    authority(kate, 'Registered Nurse', 'Nursing Council of New Zealand', 'SYN-RN-42290', 'Registered nurse');
    const kateArc = position(kate, 'org-arc', 'svc-arc', 'Registered Nurse', 'arc-rn');
    roster(kate, kateArc.pid, 'svc-arc', '14:30', '23:00', [1, 2]);
    leave(kate, 64, 40);

    const jo = worker('jo', 'Jo', 'Tipene', 'Jo Tipene');
    const joArc = position(jo, 'org-arc', 'svc-arc', 'Rostering Coordinator', 'arc-rostering');
    roster(jo, joArc.pid, 'svc-arc', '08:30', '17:00', [0, 6]);
    leave(jo, 120, 80);

    const mere = worker('mere', 'Mere', 'Parata', 'Mere Parata');
    authority(mere, 'Registered Nurse', 'Nursing Council of New Zealand', 'SYN-RN-38811', 'Registered nurse');
    const mereEd = position(mere, 'org-hosp', 'svc-ed', 'Registered Nurse', 'ed-rn');
    roster(mere, mereEd.pid, 'svc-ed', '07:00', '17:30', [3, 4, 5]);
    leave(mere, 88, 56);

    const ravi = worker('ravi', 'Ravi', 'Singh', 'Dr Ravi Singh');
    authority(ravi, 'Medical Practitioner', 'Medical Council of New Zealand', 'SYN-MC-70561', 'Vocational: emergency medicine');
    const raviEd = position(ravi, 'org-hosp', 'svc-ed', 'Emergency Physician', 'ed-doctor');
    roster(ravi, raviEd.pid, 'svc-ed', '08:00', '18:00', [1, 2, 3]);
    leave(ravi, 140, 80);

    const lena = worker('lena', 'Lena', 'Fox', 'Lena Fox');
    authority(lena, 'Physiotherapist', 'Physiotherapy Board of New Zealand', 'SYN-PT-11873', 'Physiotherapist');
    const lenaPt = position(lena, 'org-hosp', 'svc-physio', 'Physiotherapist', 'physio');
    roster(lena, lenaPt.pid, 'svc-physio', '08:00', '16:30', [0, 6]);
    leave(lena, 72, 40);

    // Emergency Department presentations.
    let mrn = store.get<{ n: number }>("SELECT count(*) AS n FROM external_identifier WHERE system = 'LOCAL_MRN'")!.n;
    const patient = (p: { given: string; family: string; dob: string; gender: string; ethnicity: string; iwi?: string; nhi: string; location: string; arrivedMinsAgo: number }) => {
      const id = newId();
      store.insert('person', { id, family_name: p.family, given_name: p.given, date_of_birth: p.dob, gender: p.gender, ethnicity: p.ethnicity, iwi: p.iwi ?? null, data_source: S, created_at: now() });
      store.insert('external_identifier', { id: newId(), person_id: id, system: 'NHI', value: p.nhi, verification: S, created_at: now() });
      store.insert('external_identifier', { id: newId(), person_id: id, system: 'LOCAL_MRN', value: `TEST-${String(++mrn).padStart(5, '0')}`, verification: S, created_at: now() });
      store.insert('encounter', { id: newId(), person_id: id, service_id: 'svc-ed', location: p.location, kind: 'EMERGENCY', started_at: minsAgo(p.arrivedMinsAgo), state: 'ACTIVE' });
      return id;
    };
    const kiri = patient({ given: 'Kiri', family: 'Moana', dob: '1978-05-09', gender: 'Female', ethnicity: 'Māori', iwi: 'Tainui', nhi: 'ZZZ0105', location: 'Resus 2', arrivedMinsAgo: 95 });
    const daniel = patient({ given: 'Daniel', family: 'Brooks', dob: '1967-08-14', gender: 'Male', ethnicity: 'NZ European', nhi: 'ZZZ0113', location: 'Waiting room', arrivedMinsAgo: 12 });
    const ana = patient({ given: 'Ana', family: 'Lemalu', dob: '2003-02-27', gender: 'Female', ethnicity: 'Samoan', nhi: 'ZZZ0121', location: 'Minors 3', arrivedMinsAgo: 140 });
    const tom = patient({ given: 'Tom', family: 'Harris', dob: '1949-12-03', gender: 'Male', ethnicity: 'NZ European', nhi: 'ZZZ0148', location: 'Acute 5', arrivedMinsAgo: 55 });

    const allergy = (pid: string, kind: string, substance: string | null, reaction: string | null, severity: string | null, by: string) =>
      store.insert('allergy', { id: newId(), person_id: pid, kind, substance, reaction, severity, certainty: kind === 'NO_KNOWN_ALLERGIES' ? null : 'CONFIRMED', state: 'ACTIVE', source: 'Patient report at triage', recorded_by: by, recorded_at: minsAgo(80), data_source: S });
    allergy(kiri, 'NO_KNOWN_ALLERGIES', null, null, null, mere);
    allergy(ana, 'ALLERGY', 'Ibuprofen', 'Wheeze', 'Moderate', mere);
    allergy(tom, 'ALLERGY', 'Trimethoprim', 'Rash', 'Mild', mere);
    // Daniel Brooks: waiting for triage, allergies not yet recorded.

    store.insert('medication', { id: newId(), person_id: tom, medicine: 'Apixaban', dose: '5 mg', route: 'Oral', frequency: 'Twice daily', indication: 'Atrial fibrillation', state: 'ACTIVE', prescriber: 'GP (reported at triage)', started_at: minsAgo(50), source: 'Patient report', data_source: S });
    const result = (pid: string, test: string, value: string, units: string, range: string, flag: string | null, mins: number) => {
      const id = newId();
      store.insert('result', { id, person_id: pid, test, value, units, reference_range: range, flag, state: 'AVAILABLE', performed_at: minsAgo(mins + 40), released_at: minsAgo(mins), source: 'Te Awa Laboratory', reviewed_by: null, reviewed_at: null, data_source: S });
      recordInitial(store, 'result', id, 'AVAILABLE', { actorId: null, workContextId: null }, 'Released by laboratory');
    };
    result(kiri, 'hs-Troponin T', '9', 'ng/L', '<15', null, 30);
    result(tom, 'Haemoglobin', '128', 'g/L', '130–175', 'L', 10);

    const event = (pid: string, service: string, code: string, fields: Record<string, string | number>, author: string, positionId: string, roleLabel: string, mins: number) => {
      const t = KEY_BY_CODE.get(code)!;
      const id = newId();
      store.insert('clinical_event', {
        id, lineage_id: id, version: 1, person_id: pid, category: t.category, key_code: code, key_version: t.version,
        fields_json: JSON.stringify(fields), rendered_text: render(t, fields), author_id: author, author_position_id: positionId,
        author_role_label: roleLabel, service_id: service, recorded_at: minsAgo(mins - 2), effective_at: minsAgo(mins), state: 'CURRENT',
        urgent: 0, collection: 'DIRECT', data_source: S,
      });
      return id;
    };
    const rnEd = 'Registered Nurse, Emergency Department';
    const drEd = 'Emergency Doctor, Emergency Department';
    event(kiri, 'svc-ed', '.triage', { complaint: 'Central chest pain for 2 hours, radiating to left arm', category: 'ATS 2', area: 'Resus' }, mere, mereEd.pid, rnEd, 90);
    event(kiri, 'svc-ed', '.obs', { bp: '148/92', hr: 98, spo2: 97, rr: 20, t: 36.8, loc: 'Alert' }, mere, mereEd.pid, rnEd, 85);
    event(kiri, 'svc-ed', '.medical', { history: 'Pressure-like central chest pain at rest, 2 h. Smoker. Father had MI at 55.', examination: 'Comfortable at rest, HS dual no added, chest clear', impression: 'Possible acute coronary syndrome', plan: 'Serial ECG and troponin at 0 and 2 h; review with results' }, ravi, raviEd.pid, drEd, 60);
    event(ana, 'svc-ed', '.triage', { complaint: 'Right ankle inversion injury playing netball', category: 'ATS 4', area: 'Minors' }, mere, mereEd.pid, rnEd, 135);
    event(ana, 'svc-ed', '.pain', { site: 'Right lateral ankle', score: 6, action: 'Ice and elevation; ibuprofen avoided (allergy)' }, mere, mereEd.pid, rnEd, 130);
    event(tom, 'svc-ed', '.triage', { complaint: 'Fall at home, on apixaban, small scalp laceration', category: 'ATS 3', area: 'Acute' }, mere, mereEd.pid, rnEd, 50);
    event(tom, 'svc-ed', '.obs', { bp: '136/80', hr: 88, spo2: 96, rr: 16, t: 36.5, loc: 'Alert' }, mere, mereEd.pid, rnEd, 45);

    // Physiotherapy caseload: ward patients referred to the service.
    const ward = (nhi: string) => store.get<{ person_id: string }>("SELECT person_id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.person_id ?? null;
    const aroha = ward('ZZZ9999');
    const peggy = ward('ZZZ0032');
    for (const pid of [aroha, peggy]) {
      if (pid) store.insert('care_relationship', { id: newId(), person_id: pid, service_id: 'svc-physio', kind: 'SHARED_CARE', started_at: minsAgo(60 * 24) });
    }
    const ptLabel = 'Physiotherapist, Physiotherapy';
    if (peggy) {
      event(peggy, 'svc-physio', '.mobility', { transfers: 'Supervision', aid: 'Frame', distance: '20', note: 'Slow, steady; one loss of balance on turning' }, lena, lenaPt.pid, ptLabel, 60 * 20);
      event(peggy, 'svc-physio', '.goals', { goal: 'Walk to bathroom with frame independently', by: 'Before discharge', agreed: 'Peggy and her daughter' }, lena, lenaPt.pid, ptLabel, 60 * 20 - 5);
    }
    if (aroha) event(aroha, 'svc-physio', '.treatment', { intervention: 'Active cycle of breathing, supported cough, walked 30 m', response: 'SpO2 held 94% on 2 L, tolerated well', next: 'Twice daily until off oxygen' }, lena, lenaPt.pid, ptLabel, 60 * 5);

    // Rostering in Residential Care: requests waiting on Jo's decision.
    const vacancy = store.get<{ id: string; shift_date: string }>("SELECT id, shift_date FROM open_shift WHERE service_id = 'svc-arc' AND role_key = 'arc-rn' AND state = 'OPEN' ORDER BY shift_date LIMIT 1");
    if (vacancy) {
      store.run("DELETE FROM roster_shift WHERE workforce_person_id = ? AND shift_date = ?", kate, vacancy.shift_date);
      store.insert('open_shift_interest', { id: newId(), open_shift_id: vacancy.id, workforce_person_id: kate, state: 'INTERESTED', at: minsAgo(300) });
    }
    const tama = byUser('tama');
    const cgVacancy = store.get<{ id: string }>("SELECT id FROM open_shift WHERE service_id = 'svc-arc' AND role_key = 'arc-caregiver' AND state = 'OPEN' ORDER BY shift_date LIMIT 1");
    if (tama && cgVacancy) store.insert('open_shift_interest', { id: newId(), open_shift_id: cgVacancy.id, workforce_person_id: tama, state: 'INTERESTED', at: minsAgo(200) });
    if (nicki) {
      const offered = store.get<{ id: string; shift_date: string }>(
        "SELECT id, shift_date FROM roster_shift WHERE workforce_person_id = ? AND service_id = 'svc-arc' AND state = 'PLANNED' AND shift_date > ? ORDER BY shift_date LIMIT 1 OFFSET 4", nicki, addDays(today, 1),
      );
      if (offered) {
        const oid = newId();
        store.insert('shift_offer', { id: oid, roster_shift_id: offered.id, offered_by: nicki, state: 'OFFERED', created_at: minsAgo(600) });
        store.run('DELETE FROM roster_shift WHERE workforce_person_id = ? AND shift_date = ?', kate, offered.shift_date);
        store.insert('shift_offer_take', { id: newId(), offer_id: oid, workforce_person_id: kate, state: 'INTERESTED', at: minsAgo(240) });
      }
    }
    store.insert('leave_request', { id: newId(), workforce_person_id: kate, leave_type: 'Annual leave', start_date: addDays(today, 21), end_date: addDays(today, 23), private_reason: 'Tangihanga for whānau', state: 'REQUESTED', requested_at: minsAgo(1440) });
    if (hannah) {
      store.insert('knowledge_question', { id: newId(), author_id: hannah, topic: 'Low-risk chest pain pathways', body: 'For ED colleagues: when a 2-hour high-sensitivity troponin pathway is negative, what follow-up are you arranging for patients with ongoing risk factors?', created_at: minsAgo(60 * 30), state: 'OPEN' });
    }
  });
}

// Set 3: beds on Ward K, a patient flow coordinator, and Tom Harris waiting for admission
// from the Emergency Department to General Medicine.
function set3(store: Store, password: string): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  store.insert('service', { id: 'svc-flow', organisation_id: 'org-hosp', facility_id: 'fac-hosp', name: 'Patient Flow', sector: 'Hospital operations', subject_label: 'Patient' });
  const pita = newWorker(store, hashPassword(password), 'pita', 'Pita', 'Hohaia', 'Pita Hohaia');
  const eid = newId();
  store.insert('employment', { id: eid, workforce_person_id: pita, organisation_id: 'org-hosp', employment_type: 'PERMANENT', start_date: '2023-07-01' });
  const pos = newId();
  store.insert('position', { id: pos, employment_id: eid, service_id: 'svc-flow', title: 'Patient Flow Coordinator', role_key: 'flow-coordinator', start_date: '2023-07-01' });
  const today = todayLocal();
  for (let d = -7; d < 28; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (dow === 0 || dow === 6) continue;
    store.insert('roster_shift', { id: newId(), workforce_person_id: pita, position_id: pos, service_id: 'svc-flow', shift_date: date, start_time: '07:30', end_time: '16:00', state: 'PLANNED', data_source: 'SYNTHETIC' });
  }

  // Ward K beds. Beds already holding a General Medicine inpatient are occupied by them.
  const inpatients = store.all<{ person_id: string; location: string }>("SELECT person_id, location FROM encounter WHERE service_id = 'svc-genmed' AND state = 'ACTIVE'");
  for (let n = 1; n <= 12; n++) {
    const label = `Ward K Bed ${n}`;
    const who = inpatients.find((e) => e.location === label);
    store.insert('bed', { id: newId(), service_id: 'svc-genmed', label, state: who ? 'OCCUPIED' : n === 2 || n === 10 ? 'CLEANING' : 'AVAILABLE', person_id: who?.person_id ?? null, updated_at: minsAgo(30 + n * 7) });
  }

  const tom = store.get<{ person_id: string; id: string }>("SELECT e.person_id, e.id FROM encounter e JOIN external_identifier x ON x.person_id = e.person_id AND x.system = 'NHI' AND x.value = 'ZZZ0148' WHERE e.service_id = 'svc-ed' AND e.state = 'ACTIVE'");
  const ravi = store.get<{ id: string }>("SELECT id FROM workforce_person WHERE username = 'ravi'")?.id;
  if (tom && ravi) {
    const id = newId();
    const reason = 'Fall on apixaban with scalp laceration; needs observation overnight and a falls and medicines review';
    store.insert('transfer', {
      id, person_id: tom.person_id, kind: 'ADMISSION', from_service_id: 'svc-ed', from_encounter_id: tom.id, to_service_id: 'svc-genmed',
      reason, priority: 'ROUTINE', state: 'REQUESTED', requested_by: ravi, requested_at: minsAgo(20),
    });
    recordInitial(store, 'transfer', id, 'REQUESTED', { actorId: ravi, workContextId: null }, reason);
  }
}

// Set 4: discharge planning on Ward K. Peggy Oliver is being considered for discharge home
// with support; Wiremu Te Whare has a decision to discharge with one requirement left.
function set4(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const today = todayLocal();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const hannah = who('hannah');
  const nicki = who('nicki');
  if (!hannah || !nicki) return;
  const admitted = (nhi: string) => store.get<{ person_id: string; id: string }>(
    "SELECT e.person_id, e.id FROM encounter e JOIN external_identifier x ON x.person_id = e.person_id AND x.system = 'NHI' AND x.value = ? WHERE e.service_id = 'svc-genmed' AND e.state = 'ACTIVE'", nhi,
  );
  const plan = (enc: { person_id: string; id: string }, destination: string, expected: string, mins: number, note: string) => {
    const id = newId();
    store.insert('discharge', { id, person_id: enc.person_id, service_id: 'svc-genmed', encounter_id: enc.id, destination, expected_date: expected, state: 'CONSIDERED', considered_by: hannah, considered_at: minsAgo(mins), note });
    recordInitial(store, 'discharge', id, 'CONSIDERED', { actorId: hannah, workContextId: null }, note);
    return id;
  };
  const met = (id: string, code: string, by: string, note: string, mins: number) =>
    store.insert('discharge_requirement', { id: newId(), discharge_id: id, code, status: 'DONE', note, recorded_by: by, recorded_at: minsAgo(mins) });

  const peggy = admitted('ZZZ0032');
  if (peggy) {
    const id = plan(peggy, 'Home with support', addDays(today, 2), 60 * 5, 'Aim for home with increased home support once walking to the bathroom with her frame');
    met(id, 'whanau', nicki, 'Daughter Sarah told of the plan; wants to be there on the day', 60 * 3);
  }
  const wiremu = admitted('ZZZ0016');
  if (wiremu) {
    const id = plan(wiremu, 'Home', addDays(today, 1), 60 * 26, 'Heart failure improving; weight back to dry weight');
    met(id, 'readiness', hannah, 'Euvolaemic, weight stable 2 days, walking independently', 60 * 25);
    store.run("UPDATE discharge SET state = 'DECIDED', decided_by = ? WHERE id = ?", hannah, id);
    store.insert('state_transition', { id: newId(), object_type: 'discharge', object_id: id, from_state: 'CONSIDERED', to_state: 'DECIDED', actor_id: hannah, work_context_id: null, at: minsAgo(60 * 24), reason: 'Decision to discharge tomorrow', transaction_id: null });
    met(id, 'medicines', hannah, 'Furosemide 40 mg mane (was 80 mg); cilazapril restarted at 2.5 mg; no other changes', 60 * 4);
    met(id, 'summary', hannah, 'Admitted with decompensated heart failure. Diuresed 3.1 kg to dry weight 83.9 kg. Potassium 5.4 on admission, cilazapril held and restarted at lower dose. GP to check electrolytes in one week.', 60 * 4);
    met(id, 'whanau', nicki, 'Wiremu and his wife Ana understand the new doses and daily weights', 60 * 3);
    met(id, 'followup', hannah, 'GP bloods in 1 week; heart failure nurse clinic in 2 weeks', 60 * 3);
  }
}

// Set 5: escalations waiting to be received. Nicki is worried about Sione's leg on Ward K;
// Tama has escalated Frank's heels to the RN on duty in Residential Care.
function set5(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const raise = (personId: string | null, by: string | null, fromService: string, toService: string, role: string, urgency: string, concern: string, trigger: string, mins: number) => {
    if (!personId || !by) return;
    const id = newId();
    store.insert('escalation', {
      id, person_id: personId, service_id: toService, recipient_role_key: role, urgency, concern, trigger_text: trigger, state: 'RAISED',
      raised_by: by, raised_service_id: fromService, raised_at: minsAgo(mins), level: 1,
    });
    store.insert('state_transition', { id: newId(), object_type: 'escalation', object_id: id, from_state: null, to_state: 'RAISED', actor_id: by, work_context_id: null, at: minsAgo(mins), reason: `${urgency.toLowerCase()} · ${concern}`, transaction_id: null });
  };
  raise(person('ZZZ0024'), who('nicki'), 'svc-genmed', 'svc-genmed', 'genmed-physician', 'URGENT', 'Deterioration',
    'Redness has spread about 3 cm past the marked border since 08:00. T 38.3, HR 108, more pain walking. Worried the cellulitis is not responding.', 25);
  raise(person('ZZZ0075'), who('tama'), 'svc-arc', 'svc-arc', 'arc-rn', 'URGENT', 'Wound or skin',
    'Both heels redder than yesterday and there is a blister on the left heel. Frank says it hurts when his feet touch the bed.', 40);
}

// Set 6: consultations. Ravi in ED wants General Medicine's advice about Kiri; Hannah has
// asked Physiotherapy about James before he goes home, and Lena has accepted.
function set6(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, mins: number, reason: string | null = null) =>
    store.insert('state_transition', { id: newId(), object_type: 'consultation', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const ravi = who('ravi');
  const hannah = who('hannah');
  const lena = who('lena');
  const kiri = person('ZZZ0105');
  const james = person('ZZZ0040');
  if (ravi && kiri) {
    const id = newId();
    store.insert('consultation', {
      id, person_id: kiri, from_service_id: 'svc-ed', requested_by: ravi, requested_at: minsAgo(30), to_service_id: 'svc-genmed', to_role_key: 'genmed-physician',
      question: 'Kiri Moana, 48, 2 h central chest pain, first troponin 9. If the 2-hour troponin is also normal, would General Medicine prefer to see her as an outpatient, or admit for observation given her strong family history?',
      urgency: 'URGENT', state: 'REQUESTED',
    });
    step(id, null, 'REQUESTED', ravi, 30, 'To Physician, General Medicine');
  }
  if (hannah && lena && james) {
    const id = newId();
    store.insert('consultation', {
      id, person_id: james, from_service_id: 'svc-genmed', requested_by: hannah, requested_at: minsAgo(180), to_service_id: 'svc-physio', to_role_key: 'physio',
      question: 'James lives alone up a flight of stairs. Please assess mobility and stairs before discharge with his leg cellulitis.',
      urgency: 'ROUTINE', state: 'ACCEPTED', received_by: lena, accepted_by: lena,
    });
    step(id, null, 'REQUESTED', hannah, 180, 'To Physiotherapist, Physiotherapy');
    step(id, 'REQUESTED', 'RECEIVED', lena, 120);
    step(id, 'RECEIVED', 'ACCEPTED', lena, 119, 'Will see him this afternoon');
  }
}

// Set 7: wounds in Residential Care. Rua's skin tear is being reviewed every two days and is
// due today; Tama has reported a blister on Frank's left heel that no RN has assessed yet.
function set7(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const today = todayLocal();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, mins: number, reason: string | null = null) =>
    store.insert('state_transition', { id: newId(), object_type: 'wound', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const nicki = who('nicki');
  const tama = who('tama');
  const kate = who('kate');
  const rua = person('ZZZ0059');
  const frank = person('ZZZ0075');
  if (nicki && tama && kate && rua) {
    const id = newId();
    store.insert('wound', {
      id, person_id: rua, service_id: 'svc-arc', site: 'Left forearm', kind: 'Skin tear', state: 'PLANNED', identified_by: tama, identified_at: minsAgo(60 * 24 * 5),
      description: 'Caught arm on wheelchair brake during transfer', plan: 'Clean with saline, silicone contact layer and light retention bandage. Pad wheelchair brakes. Long sleeves.',
      review_days: 2, plan_by: nicki, plan_at: minsAgo(60 * 24 * 5 - 60), next_review: today,
    });
    step(id, null, 'IDENTIFIED', tama, 60 * 24 * 5, 'Caught arm on wheelchair brake during transfer');
    step(id, 'IDENTIFIED', 'ASSESSED', nicki, 60 * 24 * 5 - 50, 'Initial assessment');
    step(id, 'ASSESSED', 'PLANNED', nicki, 60 * 24 * 5 - 45, 'Silicone contact layer, review every 2 days');
    const a = (by: string, mins: number, l: number, w: number, bed: string, ex: string, trend: string, note: string) =>
      store.insert('wound_assessment', { id: newId(), wound_id: id, assessed_by: by, assessed_at: minsAgo(mins), length_mm: l, width_mm: w, depth_mm: null, stage: 'Not applicable', bed, exudate: ex, surrounding: 'Healthy', pain: 2, trend, complication: 'None', dressing: 'Silicone contact layer', note });
    a(nicki, 60 * 24 * 5 - 50, 40, 25, 'Granulating', 'Low', 'FIRST', 'Flap approximated, category 2 skin tear');
    a(kate, 60 * 24 * 3, 36, 20, 'Granulating', 'Low', 'IMPROVING', 'Edges adherent');
    a(nicki, 60 * 24 * 1, 30, 15, 'Epithelialising', 'Nil', 'IMPROVING', 'Healing well');
  }
  if (tama && frank) {
    const id = newId();
    store.insert('wound', { id, person_id: frank, service_id: 'svc-arc', site: 'Left heel', kind: 'Pressure injury', state: 'IDENTIFIED', identified_by: tama, identified_at: minsAgo(38), description: 'Blister about the size of a 50c coin, heel red and sore' });
    step(id, null, 'IDENTIFIED', tama, 38, 'Blister about the size of a 50c coin, heel red and sore');
  }
}

// Set 8: care plan reviews. Existing items gain their author and service; Elsie's distress
// plan is overdue for review, Rua's mobility plan is due today, and Aroha has a ward plan.
function set8(store: Store): void {
  const today = todayLocal();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const nicki = who('nicki');
  store.run("UPDATE care_plan_item SET author_id = ? WHERE author_id IS NULL AND data_source = 'SYNTHETIC'", nicki);
  store.run(`UPDATE care_plan_item SET service_id = (SELECT e.service_id FROM encounter e WHERE e.person_id = care_plan_item.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) WHERE service_id IS NULL`);
  const elsie = person('ZZZ0067');
  const rua = person('ZZZ0059');
  const aroha = person('ZZZ9999');
  if (elsie) store.run("UPDATE care_plan_item SET review_date = ? WHERE person_id = ? AND need LIKE 'Distress%' AND state = 'ACTIVE'", addDays(today, -1), elsie);
  if (rua) store.run("UPDATE care_plan_item SET review_date = ? WHERE person_id = ? AND need = 'Mobility' AND state = 'ACTIVE'", today, rua);
  const created = new Date(Date.now() - 2 * 86_400_000).toISOString();
  if (aroha && nicki) {
    for (const [need, goal, intervention, responsible, days] of [
      ['Breathing', 'Off oxygen, SpO2 at least 94% on air', 'Wean oxygen by 1 L each shift when SpO2 at least 94%; breathing exercises with physio', 'Registered nurses', 1],
      ['Blood glucose', 'Pre-meal glucose 6 to 10', 'Check before meals and at bedtime; tell the doctor if over 15 twice', 'Registered nurses', 2],
    ] as const) {
      const id = newId();
      store.insert('care_plan_item', { id, person_id: aroha, need, goal, intervention, responsible, review_date: addDays(today, days), state: 'ACTIVE', created_at: created, data_source: 'SYNTHETIC', service_id: 'svc-genmed', author_id: nicki });
    }
  }
}

// Set 9: referrals to Physiotherapy. Ravi's referral for Tom has just arrived and Ana's has
// been triaged; Peggy's is the referral that put her on the caseload yesterday; Alex has
// drafted one for Wiremu that a physician still has to authorise.
function set9(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, mins: number, reason: string | null = null) =>
    store.insert('state_transition', { id: newId(), object_type: 'referral', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const attach = (id: string, pid: string, categories: string[]) => {
    for (const c of categories) {
      const e = store.get<{ lineage_id: string }>("SELECT lineage_id FROM clinical_event WHERE person_id = ? AND category = ? AND state = 'CURRENT' ORDER BY effective_at DESC LIMIT 1", pid, c);
      if (e) store.run('INSERT OR IGNORE INTO referral_evidence (referral_id, event_lineage_id) VALUES (?, ?)', id, e.lineage_id);
    }
  };
  const hannah = who('hannah');
  const ravi = who('ravi');
  const lena = who('lena');
  const alex = who('alex');
  const tom = person('ZZZ0148');
  const ana = person('ZZZ0121');
  const peggy = person('ZZZ0032');
  const lenaCr = (pid: string) => store.get<{ id: string }>("SELECT id FROM care_relationship WHERE person_id = ? AND service_id = 'svc-physio' AND ended_at IS NULL", pid)?.id ?? null;
  const wiremu = person('ZZZ0016');
  if (ravi && tom) {
    const id = newId();
    store.insert('referral', {
      id, person_id: tom, from_service_id: 'svc-ed', to_service_id: 'svc-physio', priority: 'SEMI_URGENT', patient_aware: 1, state: 'SENT',
      reason: 'Fall at home on apixaban, second this year. Scalp laceration closed, CT head clear. Being admitted under General Medicine.',
      request: 'Falls and mobility assessment on the ward, and advice on aids before he goes home.',
      drafted_by: ravi, drafted_at: minsAgo(25), authorised_by: ravi, sent_at: minsAgo(24),
    });
    attach(id, tom, ['TRIAGE', 'OBS']);
    step(id, null, 'DRAFT', ravi, 25, 'To Physiotherapy');
    step(id, 'DRAFT', 'AUTHORISED', ravi, 24);
    step(id, 'AUTHORISED', 'SENT', ravi, 24);
  }
  if (ravi && lena && ana) {
    const id = newId();
    store.insert('referral', {
      id, person_id: ana, from_service_id: 'svc-ed', to_service_id: 'svc-physio', priority: 'ROUTINE', patient_aware: 1, state: 'TRIAGED',
      reason: 'Right ankle inversion injury playing netball. X-ray shows no fracture. Lateral ligament sprain, can weight bear with pain.',
      request: 'Outpatient physiotherapy for ankle rehabilitation and return to netball.',
      drafted_by: ravi, drafted_at: minsAgo(70), authorised_by: ravi, sent_at: minsAgo(69),
      received_by: lena, triaged_by: lena, triage_priority: 'SEMI_URGENT', triage_note: 'Competitive netballer, season starts in 3 weeks',
    });
    attach(id, ana, ['TRIAGE', 'PAIN']);
    step(id, null, 'DRAFT', ravi, 70, 'To Physiotherapy');
    step(id, 'DRAFT', 'AUTHORISED', ravi, 69);
    step(id, 'AUTHORISED', 'SENT', ravi, 69);
    step(id, 'SENT', 'RECEIVED', lena, 30);
    step(id, 'RECEIVED', 'TRIAGED', lena, 28, 'semi-urgent: Competitive netballer, season starts in 3 weeks');
  }
  if (hannah && lena && peggy) {
    const id = newId();
    store.insert('referral', {
      id, person_id: peggy, from_service_id: 'svc-genmed', to_service_id: 'svc-physio', priority: 'ROUTINE', patient_aware: 1, state: 'RESPONSIBILITY_ACCEPTED',
      reason: 'Two falls at home in the last month. Lives alone, daughter nearby.',
      request: 'Falls and mobility assessment before discharge, and advice on a walking aid.',
      drafted_by: hannah, drafted_at: minsAgo(60 * 28), authorised_by: hannah, sent_at: minsAgo(60 * 28),
      received_by: lena, triaged_by: lena, triage_priority: 'ROUTINE', decided_by: lena,
      seen_by: lena, seen_at: minsAgo(60 * 20), seen_note: 'Assessed on the ward with her frame', responsibility_by: lena, care_relationship_id: lenaCr(peggy),
    });
    step(id, null, 'DRAFT', hannah, 60 * 28, 'To Physiotherapy');
    step(id, 'DRAFT', 'AUTHORISED', hannah, 60 * 28);
    step(id, 'AUTHORISED', 'SENT', hannah, 60 * 28);
    step(id, 'SENT', 'RECEIVED', lena, 60 * 25);
    step(id, 'RECEIVED', 'TRIAGED', lena, 60 * 25, 'routine');
    step(id, 'TRIAGED', 'ACCEPTED', lena, 60 * 25);
    step(id, 'ACCEPTED', 'SEEN', lena, 60 * 20, 'Assessed on the ward with her frame');
    step(id, 'SEEN', 'RESPONSIBILITY_ACCEPTED', lena, 60 * 20, 'Shared care');
  }
  if (alex && wiremu) {
    const id = newId();
    store.insert('referral', {
      id, person_id: wiremu, from_service_id: 'svc-genmed', to_service_id: 'svc-physio', priority: 'ROUTINE', patient_aware: 1, state: 'DRAFT',
      reason: 'Heart failure, weight down 0.7 kg since yesterday on furosemide. Unsteady on his feet this morning and holding furniture to walk.',
      request: 'Mobility check and walking frame before he goes home.',
      drafted_by: alex, drafted_at: minsAgo(20),
    });
    attach(id, wiremu, ['WEIGHT']);
    step(id, null, 'DRAFT', alex, 20, 'To Physiotherapy');
  }
}

// Set 10: Physiotherapy's diary. Aroha had chest physio this morning and is booked again
// this afternoon; Peggy's stairs practice is confirmed for 2 pm; Peggy also waits for a
// home visit after discharge.
function set10(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const today = todayLocal();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, mins: number, reason: string | null = null) =>
    store.insert('state_transition', { id: newId(), object_type: 'appointment', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const lena = who('lena');
  const aroha = person('ZZZ9999');
  const peggy = person('ZZZ0032');
  if (!lena) return;
  const base = { service_id: 'svc-physio', mode: 'IN_PERSON', requested_by: lena, clinician_id: lena };
  if (aroha) {
    const first = newId();
    const second = newId();
    store.insert('appointment', {
      ...base, id: first, person_id: aroha, reason: 'Chest physiotherapy', priority: 'SEMI_URGENT', state: 'COMPLETED', requested_at: minsAgo(60 * 20),
      start_at: `${today}T09:00`, duration_min: 30, place: 'Ward K Bed 4', booked_by: lena, arrived_by: lena, arrived_at: minsAgo(60 * 5 + 5),
      commenced_by: lena, commenced_at: minsAgo(60 * 5), ended_by: lena, ended_at: minsAgo(60 * 4 - 30), end_note: 'Active cycle of breathing, walked 30 m', follow_up: 'ANOTHER',
    });
    step(first, null, 'REQUESTED', lena, 60 * 20);
    step(first, 'REQUESTED', 'BOOKED', lena, 60 * 20, `${today} 09:00`);
    step(first, 'BOOKED', 'ARRIVED', lena, 60 * 5 + 5, 'Arrived');
    step(first, 'ARRIVED', 'COMMENCED', lena, 60 * 5);
    step(first, 'COMMENCED', 'COMPLETED', lena, 60 * 4 - 30, 'Active cycle of breathing, walked 30 m');
    store.insert('appointment', {
      ...base, id: second, person_id: aroha, previous_id: first, reason: 'Chest physiotherapy', priority: 'SEMI_URGENT', state: 'BOOKED', requested_at: minsAgo(60 * 4 - 30),
      start_at: `${today}T16:00`, duration_min: 30, place: 'Ward K Bed 4', booked_by: lena,
    });
    step(second, null, 'REQUESTED', lena, 60 * 4 - 30, 'Follow-up');
    step(second, 'REQUESTED', 'BOOKED', lena, 60 * 4 - 29, `${today} 16:00`);
  }
  if (peggy) {
    const referral = store.get<{ id: string }>("SELECT id FROM referral WHERE person_id = ? AND to_service_id = 'svc-physio'", peggy)?.id ?? null;
    const stairs = newId();
    store.insert('appointment', {
      ...base, id: stairs, person_id: peggy, referral_id: referral, reason: 'Stairs practice with her daughter', priority: 'ROUTINE', state: 'CONFIRMED', requested_at: minsAgo(60 * 19),
      start_at: `${today}T14:00`, duration_min: 45, place: 'Physiotherapy gym, level 1', booked_by: lena, confirmed_by: lena,
    });
    step(stairs, null, 'REQUESTED', lena, 60 * 19);
    step(stairs, 'REQUESTED', 'BOOKED', lena, 60 * 19, `${today} 14:00`);
    step(stairs, 'BOOKED', 'CONFIRMED', lena, 60 * 3, 'Daughter confirmed by phone');
    const visit = newId();
    store.insert('appointment', {
      id: visit, person_id: peggy, service_id: 'svc-physio', referral_id: referral, reason: 'Home visit in the first week after discharge: stairs, bathroom and rails', priority: 'ROUTINE',
      mode: 'IN_PERSON', state: 'REQUESTED', requested_by: lena, requested_at: minsAgo(60 * 3),
    });
    step(visit, null, 'REQUESTED', lena, 60 * 3);
  }
}

// Set 11: alerts staff have raised. Frank needs two staff for cares, Losa's daughter
// interprets for important conversations, and Tom is on a blood thinner after a head
// injury. Alerts generated from the record (flagged results, overdue reviews) follow
// from the data already here.
function set11(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string | null, mins: number, reason: string | null = null) =>
    store.insert('state_transition', { id: newId(), object_type: 'alert', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const raised = (pid: string | null, service: string, by: string | null, category: string, title: string, detail: string, mins: number, ackBy: string | null = null) => {
    if (!pid || !by) return;
    const id = newId();
    store.insert('alert', {
      id, person_id: pid, service_id: service, capability: 'record.view', rule: 'RAISED', category, title, detail,
      state: ackBy ? 'ACKNOWLEDGED' : 'VISIBLE', generated_at: minsAgo(mins), raised_by: by, visible_at: minsAgo(mins), visible_to: by,
      acknowledged_by: ackBy, acknowledged_at: ackBy ? minsAgo(mins - 60) : null,
    });
    step(id, null, 'GENERATED', by, mins, title);
    step(id, 'GENERATED', 'VISIBLE', by, mins, 'Raised');
    if (ackBy) step(id, 'VISIBLE', 'ACKNOWLEDGED', ackBy, mins - 60);
  };
  raised(person('ZZZ0075'), 'svc-arc', who('kate'), 'SAFETY', 'Two staff for personal cares',
    'Frank has hit out during showering and dressing when rushed. Explain each step before you do it and use two staff.', 60 * 24 * 10, who('tama'));
  raised(person('ZZZ0083'), 'svc-arc', who('nicki'), 'COMMUNICATION', 'Tongan first language',
    'Losa understands everyday English. For consent and care planning, her daughter Mele interprets or book an interpreter.', 60 * 24 * 30);
  raised(person('ZZZ0148'), 'svc-ed', who('mere'), 'CLINICAL', 'On apixaban with a head injury',
    'Takes apixaban for atrial fibrillation. Fell and hit his head at home.', 45);
}

// Set 12: communications. Ward K has tried Peggy's daughter twice about the discharge plan;
// Wiremu's GP practice needs to hear about his held cilazapril; Residential Care has told
// Losa's daughter about the care plan meeting and is waiting to confirm a time.
function set12(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const today = todayLocal();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, mins: number, reason: string | null = null) =>
    store.insert('state_transition', { id: newId(), object_type: 'communication', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const attempt = (id: string, by: string, mins: number, method: string, outcome: string, note: string | null = null) =>
    store.insert('communication_attempt', { id: newId(), communication_id: id, attempted_by: by, attempted_at: minsAgo(mins), method, outcome, note });
  const nicki = who('nicki');
  const alex = who('alex');
  const hannah = who('hannah');
  const peggy = person('ZZZ0032');
  const wiremu = person('ZZZ0016');
  const losa = person('ZZZ0083');
  if (alex && nicki && peggy) {
    const id = newId();
    store.insert('communication', {
      id, person_id: peggy, service_id: 'svc-genmed', purpose: 'Tell her daughter the discharge plan and ask if she can be here for the home visit',
      recipient_kind: 'WHANAU', recipient: 'Sarah Oliver (daughter)', contact: '021 555 0182', method: 'PHONE', sharing: 'AGREED', due_at: `${today}T15:00`,
      state: 'ATTEMPTED', created_by: nicki, created_at: minsAgo(60 * 5),
    });
    step(id, null, 'REQUIRED', nicki, 60 * 5, 'Whānau: Sarah Oliver (daughter)');
    attempt(id, nicki, 60 * 4, 'PHONE', 'NO_ANSWER');
    step(id, 'REQUIRED', 'ATTEMPTED', nicki, 60 * 4, 'No answer');
    attempt(id, alex, 60, 'PHONE', 'LEFT_MESSAGE', 'Asked her to call Ward K');
    step(id, 'ATTEMPTED', 'ATTEMPTED', alex, 60, 'Left a message: Asked her to call Ward K');
  }
  if (hannah && wiremu) {
    const id = newId();
    store.insert('communication', {
      id, person_id: wiremu, service_id: 'svc-genmed', purpose: 'Cilazapril held for high potassium. Ask the practice to recheck potassium and creatinine in one week before restarting.',
      recipient_kind: 'EXTERNAL_PROVIDER', recipient: 'Te Awa Health Centre (GP practice)', contact: '07 555 0140', method: 'PHONE', sharing: 'AGREED',
      state: 'REQUIRED', created_by: hannah, created_at: minsAgo(40),
    });
    step(id, null, 'REQUIRED', hannah, 40, 'Another provider: Te Awa Health Centre (GP practice)');
  }
  if (nicki && losa) {
    const id = newId();
    store.insert('communication', {
      id, person_id: losa, service_id: 'svc-arc', purpose: 'Invite her daughter to the care plan meeting and agree a time',
      recipient_kind: 'WHANAU', recipient: 'Mele Faleolo (daughter)', contact: '022 555 0917', method: 'PHONE', language: 'Tongan', sharing: 'AGREED',
      state: 'FOLLOW_UP', created_by: nicki, created_at: minsAgo(60 * 26), conveyed: 'Care plan meeting is due this month. Explained what we will talk about.',
      response: 'Happy to come. Will check her work roster and call back with a day.', follow_up: 'Confirm the meeting day with Mele',
    });
    step(id, null, 'REQUIRED', nicki, 60 * 26, 'Whānau: Mele Faleolo (daughter)');
    attempt(id, nicki, 60 * 25, 'PHONE', 'CONVEYED');
    step(id, 'REQUIRED', 'CONVEYED', nicki, 60 * 25, 'Phone');
    step(id, 'CONVEYED', 'FOLLOW_UP', nicki, 60 * 25, 'Confirm the meeting day with Mele');
  }
}

// Set 13: monitoring plans. Aroha's observations and glucose on Ward K, Wiremu's daily
// weight and fluid balance, Tom's hourly observations in ED after his head injury, and
// Frank's pain in Residential Care. The limits are what each clinician wrote.
function set13(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const today = todayLocal();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const plan = (pid: string | null, service: string, by: string | null, mins: number, v: { parameter: string; reason: string; method?: string; frequency: number; limits?: string; target?: string; responsible: string; review?: string }) => {
    if (!pid || !by) return;
    const id = newId();
    store.insert('monitoring_plan', {
      id, person_id: pid, service_id: service, parameter: v.parameter, reason: v.reason, method: v.method ?? null, frequency_hours: v.frequency,
      limits: v.limits ?? null, target: v.target ?? null, responsible: v.responsible, review_date: v.review ?? null, state: 'ACTIVE', started_by: by, started_at: minsAgo(mins),
    });
    store.insert('state_transition', { id: newId(), object_type: 'monitoring', object_id: id, from_state: null, to_state: 'ACTIVE', actor_id: by, work_context_id: null, at: minsAgo(mins), reason: `Every ${v.frequency} h`, transaction_id: null });
  };
  const aroha = person('ZZZ9999');
  const wiremu = person('ZZZ0016');
  const tom = person('ZZZ0148');
  const frank = person('ZZZ0075');
  plan(aroha, 'svc-genmed', who('hannah'), 60 * 48, { parameter: 'OBS', reason: 'Pneumonia on oxygen', frequency: 4, responsible: 'Registered nurses',
    limits: 'Tell the doctor if SpO2 below 92% on 2 L, breathing rate over 24, or new confusion', target: 'SpO2 94% or more on air', review: today });
  plan(aroha, 'svc-genmed', who('nicki'), 60 * 48, { parameter: 'BGL', reason: 'Type 2 diabetes with infection', method: 'Finger prick before meals and at bedtime', frequency: 6,
    responsible: 'Registered nurses', limits: 'Tell the doctor if over 15 twice in a row, or under 4', target: '6 to 10 before meals' });
  plan(wiremu, 'svc-genmed', who('hannah'), 60 * 72, { parameter: 'WEIGHT', reason: 'Heart failure on furosemide', method: 'Standing, before breakfast, same scales', frequency: 24,
    responsible: 'Registered nurses', limits: 'Tell the doctor if up 1 kg or more in a day', target: 'Dry weight about 82 kg' });
  plan(wiremu, 'svc-genmed', who('hannah'), 60 * 72, { parameter: 'INTAKE', reason: 'Fluid restriction', method: 'All drinks and urine output charted', frequency: 24,
    responsible: 'Registered nurses', limits: 'Tell the doctor if urine output under 500 mL in a day', target: 'Intake no more than 1.5 L a day' });
  plan(tom, 'svc-ed', who('mere'), 50, { parameter: 'OBS', reason: 'Head injury on apixaban', frequency: 1, responsible: 'Registered nurses',
    limits: 'Tell the ED doctor straight away if he is less alert, has a new headache, or vomits' });
  plan(frank, 'svc-arc', who('kate'), 60 * 24 * 3, { parameter: 'PAIN', reason: 'Painful heels', method: 'Ask Frank; if he cannot say, watch his face during cares', frequency: 8,
    responsible: 'All staff', limits: 'Tell the RN on duty if 5 or more, or if he winces with every touch' });
}

// Set 14: restrictions and precautions. James is nil by mouth from midnight for his
// endoscopy; Wiremu is on a fluid restriction whose review is overdue; Nicki has proposed a
// fluid restriction for Sione that waits for a doctor; Lena has limited Peggy's weight-bearing;
// Kate has set a limb precaution for Elsie that Tama has not read yet; Tom is on bed rest in ED.
function set14(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const today = todayLocal();
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return todayLocal(d); };
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
  const tomorrow10 = new Date(midnight.getTime() + 10 * 3_600_000);
  const add = (pid: string | null, service: string, by: string | null, mins: number, v: {
    kind: string; side?: string; detail: string; instructions?: string; reason: string; view: string; from?: string; until?: string; review?: string; authorisedBy?: string | null;
  }) => {
    if (!pid || !by) return null;
    const id = newId();
    const authorised = v.authorisedBy !== undefined ? v.authorisedBy : by;
    store.insert('restriction', {
      id, person_id: pid, service_id: service, kind: v.kind, side: v.side ?? null, detail: v.detail, instructions: v.instructions ?? null, reason: v.reason,
      patient_view: v.view, effective_from: v.from ?? minsAgo(mins), effective_until: v.until ?? null, review_date: v.review ?? null,
      state: authorised ? 'ACTIVE' : 'PROPOSED', proposed_by: by, proposed_at: minsAgo(mins), authorised_by: authorised, authorised_at: authorised ? minsAgo(mins) : null,
    });
    store.insert('state_transition', { id: newId(), object_type: 'restriction', object_id: id, from_state: null, to_state: authorised ? 'ACTIVE' : 'PROPOSED', actor_id: by, work_context_id: null, at: minsAgo(mins), reason: v.detail, transaction_id: null });
    if (authorised) store.insert('restriction_ack', { restriction_id: id, worker_id: authorised, at: minsAgo(mins) });
    return id;
  };
  const read = (id: string | null, u: string, mins: number) => { const w = who(u); if (id && w) store.insert('restriction_ack', { restriction_id: id, worker_id: w, at: minsAgo(mins) }); };
  const check = (id: string | null, u: string, mins: number, note: string) => {
    const w = who(u);
    if (id && w) store.insert('restriction_check', { id: newId(), restriction_id: id, checked_by: w, checked_at: minsAgo(mins), followed: 1, note });
  };
  store.tx(() => {
    const james = add(person('ZZZ0040'), 'svc-genmed', who('hannah'), 90, {
      kind: 'NBM', detail: 'Nil by mouth from midnight, including water', instructions: 'Sign above the bed. Sips of water for tablets are allowed until 6 am.',
      reason: 'Gastroscopy tomorrow morning', view: 'AGREED', from: midnight.toISOString(), until: tomorrow10.toISOString(),
    });
    read(james, 'nicki', 60);
    const wiremu = add(person('ZZZ0016'), 'svc-genmed', who('hannah'), 60 * 72, {
      kind: 'FLUIDS', detail: 'No more than 1.5 L a day, all drinks', instructions: 'Jug at the bedside marked. Count soup and jelly as fluid.',
      reason: 'Heart failure with fluid overload', view: 'AGREED', review: day(-1),
    });
    read(wiremu, 'nicki', 60 * 20);
    check(wiremu, 'nicki', 60 * 3, '1.1 L so far today, whānau know not to bring drinks');
    add(person('ZZZ0024'), 'svc-genmed', who('nicki'), 40, {
      kind: 'FLUIDS', detail: 'Limit to 1 L a day', instructions: 'Chart all drinks.', reason: 'Sodium 126 and falling', view: 'NOT_YET', authorisedBy: null,
    });
    const peggy = add(person('ZZZ0032'), 'svc-physio', who('lena'), 60 * 20, {
      kind: 'WEIGHT_BEARING', side: 'LEFT', detail: 'Partial weight-bearing on the left leg with her frame', instructions: 'Walk with a physio or nurse until reviewed. No stairs.',
      reason: 'Pain in the left hip after the fall; X-ray showed no fracture', view: 'AGREED', review: day(2),
    });
    read(peggy, 'nicki', 60 * 18);
    add(person('ZZZ0067'), 'svc-arc', who('kate'), 60 * 30, {
      kind: 'LIMB', side: 'RIGHT', detail: 'No blood pressure, blood tests or injections in the right arm', instructions: 'Use the left arm. Tell the RN if the right arm is swollen.',
      reason: 'Lymphoedema after breast cancer surgery', view: 'AGREED', review: day(90),
    });
    const tom = add(person('ZZZ0148'), 'svc-ed', who('ravi'), 45, {
      kind: 'ACTIVITY', detail: 'Bed rest, head of the bed up 30 degrees', instructions: 'Help to the toilet. Call the doctor if he tries to get up confused.',
      reason: 'Head injury on apixaban, CT pending', view: 'AGREED', review: today,
    });
    read(tom, 'mere', 40);
  });
}

// Set 15: diets and meals. Elsie is on minced and moist food with mildly thick drinks and
// coughed at dinner last night; Losa has a diabetic diet with her own food preferences; Frank
// has a high-energy diet with supplements; Wiremu, Aroha and James have ward diets.
function set15(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return todayLocal(d); })();
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return todayLocal(d); };
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const diet = (pid: string | null, service: string, by: string | null, mins: number, v: {
    diets: string; texture: string; drinks: string; assistance: string; supplements?: string; preferences?: string; assessment?: string; reason: string; review?: string;
  }) => {
    if (!pid || !by) return null;
    const id = newId();
    store.insert('diet_order', {
      id, person_id: pid, service_id: service, diets: v.diets, texture: v.texture, drinks: v.drinks, assistance: v.assistance, supplements: v.supplements ?? null,
      preferences: v.preferences ?? null, assessment: v.assessment ?? null, reason: v.reason, review_date: v.review ?? null, state: 'ACTIVE', ordered_by: by, ordered_at: minsAgo(mins),
    });
    store.insert('state_transition', { id: newId(), object_type: 'diet', object_id: id, from_state: null, to_state: 'ACTIVE', actor_id: by, work_context_id: null, at: minsAgo(mins), reason: v.reason, transaction_id: null });
    return { id, pid };
  };
  const meal = (d: { id: string; pid: string } | null, u: string, meal: string, time: string, intake: string, tolerance = 'FINE', note: string | null = null) => {
    const w = who(u);
    if (!d || !w) return;
    store.insert('meal_record', {
      id: newId(), diet_order_id: d.id, person_id: d.pid, meal_date: yesterday, meal, outcome: 'GIVEN', intake, tolerance, note, recorded_by: w, recorded_at: at(yesterday, time),
    });
  };
  store.tx(() => {
    const elsie = diet(person('ZZZ0067'), 'svc-arc', who('kate'), 60 * 24 * 14, {
      diets: 'STANDARD', texture: '5', drinks: '2', assistance: 'SUPERVISION',
      assessment: 'Speech-language therapist, 12 Sept: delayed swallow, coughs on thin drinks; safe on minced and moist with mildly thick drinks',
      reason: 'Swallowing difficulty after a stroke', preferences: 'Likes porridge and custard; sits fully upright to eat', review: day(14),
    });
    meal(elsie, 'tama', 'BREAKFAST', '07:50', 'ALL');
    meal(elsie, 'tama', 'LUNCH', '12:20', 'MOST');
    meal(elsie, 'tama', 'DINNER', '17:25', 'HALF', 'COUGHING', 'Coughed on the mince twice; settled when sat more upright');
    const losa = diet(person('ZZZ0083'), 'svc-arc', who('kate'), 60 * 24 * 30, {
      diets: 'DIABETIC,CULTURAL', texture: '7', drinks: '0', assistance: 'SET_UP',
      reason: 'Type 2 diabetes', preferences: 'Likes taro, fish and coconut; her family bring food on Sundays. Tongan is her first language.', review: day(30),
    });
    meal(losa, 'tama', 'BREAKFAST', '08:00', 'ALL');
    meal(losa, 'tama', 'LUNCH', '12:15', 'HALF');
    meal(losa, 'tama', 'DINNER', '17:20', 'MOST');
    const frank = diet(person('ZZZ0075'), 'svc-arc', who('kate'), 60 * 24 * 3, {
      diets: 'HIGH_ENERGY', texture: '7EC', drinks: '0', assistance: 'SET_UP', supplements: 'Two nutritional supplement drinks a day, mid-morning and mid-afternoon',
      assessment: 'RN assessment: loose lower denture, tires chewing tough meat', reason: 'Weight loss and pressure injuries on both heels', review: day(7),
    });
    meal(frank, 'tama', 'BREAKFAST', '08:10', 'MOST');
    meal(frank, 'tama', 'LUNCH', '12:30', 'LITTLE', 'OTHER', 'Said his heels hurt too much to sit up for long');
    meal(frank, 'tama', 'DINNER', '17:30', 'HALF');
    diet(person('ZZZ0016'), 'svc-genmed', who('hannah'), 60 * 72, {
      diets: 'LOW_SALT', texture: '7', drinks: '0', assistance: 'INDEPENDENT', reason: 'Heart failure; fluid restriction as set in restrictions', preferences: 'No mushrooms',
    });
    diet(person('ZZZ9999'), 'svc-genmed', who('nicki'), 60 * 48, {
      diets: 'DIABETIC', texture: '7', drinks: '0', assistance: 'INDEPENDENT', reason: 'Type 2 diabetes',
    });
    diet(person('ZZZ0040'), 'svc-genmed', who('hannah'), 60 * 30, {
      diets: 'STANDARD,VEGETARIAN', texture: '7', drinks: '0', assistance: 'INDEPENDENT', reason: 'Ward diet; nil by mouth from midnight for his gastroscopy',
    });
  });
}

// Set 16: clinical equipment. Ward K has pumps (one in use for Aroha, one taken out of use for
// a false occlusion alarm) and monitors; Kōwhai has Frank's pressure mattress, now past its
// service date, a hoist due for service soon and one away for repair; ED has a monitor on Tom.
function set16(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return todayLocal(d); };
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const org = (service: string) => store.get<{ o: string }>('SELECT organisation_id AS o FROM service WHERE id = ?', service)?.o ?? 'org-hosp';
  const item = (service: string, tag: string, kind: string, description: string, due: number | null, state = 'AVAILABLE') => {
    const id = newId();
    store.insert('equipment', { id, organisation_id: org(service), service_id: service, asset_tag: tag, kind, description, service_due: due === null ? null : day(due), state, added_by: null, added_at: minsAgo(60 * 24 * 400) });
    store.insert('state_transition', { id: newId(), object_type: 'equipment', object_id: id, from_state: null, to_state: 'AVAILABLE', actor_id: null, work_context_id: null, at: minsAgo(60 * 24 * 400), reason: 'Added to the register', transaction_id: null });
    return id;
  };
  const move = (id: string, from: string, to: string, by: string | null, mins: number, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'equipment', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
  const use = (id: string, pid: string | null, service: string, u: string, mins: number, purpose: string, settings: string, checked: string) => {
    const by = who(u);
    if (!pid || !by) return;
    store.insert('equipment_use', { id: newId(), equipment_id: id, person_id: pid, service_id: service, purpose, settings, checked_note: checked, started_by: by, started_at: minsAgo(mins) });
    store.run("UPDATE equipment SET state = 'IN_USE' WHERE id = ?", id);
    move(id, 'AVAILABLE', 'IN_USE', by, mins, purpose);
  };
  const event = (id: string, kind: string, note: string, u: string, mins: number) => {
    const by = who(u);
    if (by) store.insert('equipment_event', { id: newId(), equipment_id: id, kind, note, person_id: null, patient_affected: null, by_id: by, at: minsAgo(mins) });
  };
  store.tx(() => {
    const p412 = item('svc-genmed', 'IP-0412', 'INFUSION_PUMP', 'Volumetric infusion pump', 120);
    use(p412, person('ZZZ9999'), 'svc-genmed', 'nicki', 60 * 6, 'IV antibiotics', 'As charted on the medicine chart', 'Tag in date, self-test passed, line primed');
    item('svc-genmed', 'IP-0415', 'INFUSION_PUMP', 'Volumetric infusion pump', 200);
    const p419 = item('svc-genmed', 'IP-0419', 'INFUSION_PUMP', 'Volumetric infusion pump', 90, 'QUARANTINED');
    event(p419, 'FAULT', 'Occlusion alarm with no occlusion, three times in an hour', 'nicki', 60 * 20);
    move(p419, 'AVAILABLE', 'QUARANTINED', who('nicki'), 60 * 20, 'Occlusion alarm with no occlusion');
    item('svc-genmed', 'OM-0031', 'OBS_MONITOR', 'Observation monitor on a stand', 45);
    item('svc-genmed', 'SU-0008', 'SUCTION', 'Portable suction unit', 30);
    const pm107 = item('svc-arc', 'PM-0107', 'PRESSURE_MATTRESS', 'Alternating air mattress', -3);
    use(pm107, person('ZZZ0075'), 'svc-arc', 'kate', 60 * 24 * 2, 'Pressure injuries on both heels', 'Alternating mode, set to his weight', 'Pump running, no alarms, cover intact');
    item('svc-arc', 'HS-0021', 'HOIST', 'Mobile hoist with full-body sling', 5);
    const hs22 = item('svc-arc', 'HS-0022', 'HOIST', 'Mobile hoist', 150, 'IN_REPAIR');
    event(hs22, 'FAULT', 'Boom drifts down slowly when loaded', 'tama', 60 * 24 * 4);
    event(hs22, 'SENT_FOR_REPAIR', 'Collected by the service agent, job 55812', 'kate', 60 * 24 * 3);
    move(hs22, 'AVAILABLE', 'QUARANTINED', who('tama'), 60 * 24 * 4, 'Boom drifts down slowly when loaded');
    move(hs22, 'QUARANTINED', 'IN_REPAIR', who('kate'), 60 * 24 * 3, 'Job 55812');
    const om5 = item('svc-ed', 'OM-0105', 'OBS_MONITOR', 'Bedside monitor', 60);
    use(om5, person('ZZZ0148'), 'svc-ed', 'mere', 50, 'Hourly neuro observations', 'Blood pressure every 30 minutes', 'Alarms on, leads checked');
    item('svc-ed', 'IP-0501', 'INFUSION_PUMP', 'Volumetric infusion pump', 80);
  });
}

// Set 17: bed features and history for Ward K. Every occupied bed gets its stay from when the
// patient arrived. Peggy needs a low bed near the nurses' station after her fall; Sione has
// been given the single room while his cough is looked into.
function set17(store: Store): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const bed = (label: string) => store.get<{ id: string; state: string; person_id: string | null }>("SELECT id, state, person_id FROM bed WHERE service_id = 'svc-genmed' AND label = ?", label);
  const features: Record<number, string> = {
    1: 'SINGLE_ROOM,ENSUITE', 2: 'SINGLE_ROOM', 3: 'NEAR_STATION,OXYGEN,SUCTION', 4: 'OXYGEN,SUCTION', 5: 'OXYGEN', 6: 'OXYGEN',
    7: 'OXYGEN', 8: 'BARIATRIC,OXYGEN', 9: 'OXYGEN', 10: 'OXYGEN', 11: 'NEAR_STATION,LOW_BED', 12: 'OXYGEN',
  };
  store.tx(() => {
    for (const [n, f] of Object.entries(features)) store.run("UPDATE bed SET features = ? WHERE service_id = 'svc-genmed' AND label = ?", f, `Ward K Bed ${n}`);
    for (const b of store.all<{ id: string; person_id: string; service_id: string }>(
      "SELECT b.id, b.person_id, b.service_id FROM bed b WHERE b.state = 'OCCUPIED' AND b.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bed_occupancy o WHERE o.bed_id = b.id AND o.until_at IS NULL)",
    )) {
      const since = store.get<{ at: string }>("SELECT started_at AS at FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", b.person_id, b.service_id)?.at ?? minsAgo(60 * 24);
      store.insert('bed_occupancy', { id: newId(), bed_id: b.id, person_id: b.person_id, service_id: b.service_id, from_at: since, reason_in: 'Admitted' });
    }
    const move = (nhi: string, needs: string, reason: string, urgency: string, by: string, mins: number, to?: { label: string; by: string; mins: number; note?: string }) => {
      const pid = person(nhi);
      const requester = who(by);
      const from = store.get<{ id: string }>("SELECT id FROM bed WHERE person_id = ? AND state = 'OCCUPIED'", pid ?? '');
      if (!pid || !requester || !from) return;
      const id = newId();
      const target = to ? bed(to.label) : null;
      const allocated = !!(to && target && target.state === 'AVAILABLE');
      store.insert('bed_move', {
        id, person_id: pid, service_id: 'svc-genmed', needs, reason, urgency, state: allocated ? 'ALLOCATED' : 'REQUESTED', from_bed_id: from.id,
        bed_id: allocated ? target!.id : null, requested_by: requester, requested_at: minsAgo(mins),
        allocated_by: allocated ? who(to!.by) : null, allocated_at: allocated ? minsAgo(to!.mins) : null, allocation_note: allocated ? to!.note ?? null : null,
      });
      store.insert('state_transition', { id: newId(), object_type: 'bedmove', object_id: id, from_state: null, to_state: 'REQUESTED', actor_id: requester, work_context_id: null, at: minsAgo(mins), reason, transaction_id: null });
      if (allocated) {
        store.run("UPDATE bed SET state = 'RESERVED', person_id = ?, updated_at = ? WHERE id = ?", pid, minsAgo(to!.mins), target!.id);
        store.insert('state_transition', { id: newId(), object_type: 'bedmove', object_id: id, from_state: 'REQUESTED', to_state: 'ALLOCATED', actor_id: who(to!.by), work_context_id: null, at: minsAgo(to!.mins), reason: to!.label, transaction_id: null });
      }
    };
    move('ZZZ0032', 'NEAR_STATION,LOW_BED', 'Fell last night getting up alone; needs to be seen easily', 'TODAY', 'nicki', 90);
    move('ZZZ0024', 'SINGLE_ROOM', 'New cough and fever; sputum sent, keep apart until results', 'NOW', 'hannah', 40, { label: 'Ward K Bed 1', by: 'pita', mins: 25 });
  });
}

function set18(store: Store): void {
  const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string | null, mins: number, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'leave', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: at(mins), reason, transaction_id: null });
  interface Leave {
    nhi: string; service: string; kind: string; purpose: string; destination: string; companion: string; contact: string; conditions: string;
    legal: string; leave: number; back: number; by: string; asked: number; approvedBy?: string; approved?: number; departed?: { by: string; mins: number; note: string };
  }
  const add = (l: Leave) => {
    const pid = person(l.nhi);
    const by = who(l.by);
    if (!pid || !by) return;
    const id = newId();
    const approver = l.approvedBy ? who(l.approvedBy) : null;
    const leaver = l.departed ? who(l.departed.by) : null;
    const state = l.departed ? 'AWAY' : approver ? 'APPROVED' : 'REQUESTED';
    store.insert('leave_of_absence', {
      id, person_id: pid, service_id: l.service, kind: l.kind, purpose: l.purpose, destination: l.destination, companion: l.companion,
      contact: l.contact, conditions: l.conditions, legal: l.legal, leave_at: at(l.leave), return_by: at(l.back), state,
      requested_by: by, requested_at: at(l.asked), approved_by: approver, approved_at: approver ? at(l.approved ?? l.asked) : null,
      departed_by: leaver, departed_at: l.departed ? at(l.departed.mins) : null, departure_note: l.departed?.note ?? null,
    });
    step(id, null, 'REQUESTED', by, l.asked, l.purpose);
    if (approver) step(id, 'REQUESTED', 'APPROVED', approver, l.approved ?? l.asked, 'Approved');
    if (l.departed) step(id, 'APPROVED', 'AWAY', leaver, l.departed.mins, l.departed.note);
  };
  store.tx(() => {
    add({
      nhi: 'ZZZ0083', service: 'svc-arc', kind: 'OUTING', purpose: 'Sunday service and lunch with the church family', destination: 'Tongan Methodist Church, Onehunga',
      companion: 'Mele (daughter)', contact: 'Mele 021 555 0183', conditions: 'Lunchtime metformin given before leaving. Walker with her. Mele to call if Losa is tired or unwell.',
      legal: 'NONE', leave: -180, back: 120, by: 'nicki', asked: -60 * 26, approvedBy: 'nicki',
      departed: { by: 'nicki', mins: -175, note: 'Went through the plan with Mele. Metformin given 09:50. Walker and cardigan packed.' },
    });
    add({
      nhi: 'ZZZ0091', service: 'svc-arc', kind: 'OUTING', purpose: 'Lunch out with his son', destination: 'Cornwall Park café',
      companion: 'Robert Grant (son)', contact: 'Robert 027 555 0191', conditions: 'Back before afternoon medicines at 14:00. Uses a wheelchair outdoors.',
      legal: 'NONE', leave: -210, back: -35, by: 'nicki', asked: -60 * 30, approvedBy: 'nicki',
      departed: { by: 'nicki', mins: -205, note: 'Robert shown how to fold the wheelchair. Bill in good spirits.' },
    });
    add({
      nhi: 'ZZZ0059', service: 'svc-arc', kind: 'OVERNIGHT', purpose: 'Mokopuna\'s 21st birthday at the family home', destination: 'Family home, Kaikohe',
      companion: 'Aroha Hēnare (granddaughter)', contact: 'Aroha 022 555 0159', conditions: 'Medicines packed for the night and morning in a labelled pack. Needs help in the shower.',
      legal: 'NONE', leave: 60 * 20, back: 60 * 44, by: 'nicki', asked: -60 * 48, approvedBy: 'nicki',
    });
    add({
      nhi: 'ZZZ0032', service: 'svc-genmed', kind: 'TRIAL', purpose: 'Afternoon at home to try the stairs and bathroom before going home', destination: 'Her home, Epsom',
      companion: 'Karen Oliver (daughter)', contact: 'Karen 021 555 0132', conditions: 'Low bed and walking frame at home already. Back for evening medicines.',
      legal: 'NONE', leave: 60 * 22, back: 60 * 26, by: 'nicki', asked: -45,
    });
  });
}

function set19(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const add = (nhi: string, service: string, category: string, statement: string, source: string, by: string, mins: number,
    extra: { sourceName?: string; context?: string; relevance?: string; outcome?: [string, string | null, string, number] } = {}) => {
    const pid = person(nhi);
    const author = who(by);
    if (!pid || !author) return;
    const id = newId();
    store.insert('preference', {
      id, person_id: pid, service_id: service, category, statement, source, source_name: extra.sourceName ?? null, context: extra.context ?? null,
      relevance: extra.relevance ?? 'ALWAYS', state: 'ACTIVE', recorded_by: author, recorded_at: ago(mins),
    });
    store.insert('state_transition', { id: newId(), object_type: 'preference', object_id: id, from_state: null, to_state: 'ACTIVE', actor_id: author, work_context_id: null, at: ago(mins), reason: statement, transaction_id: null });
    store.insert('preference_ack', { preference_id: id, worker_id: author, at: ago(mins) });
    if (extra.outcome) {
      const [outcome, note, u, m] = extra.outcome;
      store.insert('preference_outcome', { id: newId(), preference_id: id, outcome, note, by_id: who(u), at: ago(m) });
      store.run('INSERT OR IGNORE INTO preference_ack (preference_id, worker_id, at) VALUES (?, ?, ?)', id, who(u), ago(m));
    }
  };
  store.tx(() => {
    add('ZZZ0032', 'svc-genmed', 'NAME', 'Please call me Peggy. Only the bank calls me Margaret.', 'PERSON', 'nicki', 60 * 30);
    add('ZZZ0032', 'svc-genmed', 'ROUTINE', 'I like my shower in the evening so I sleep well, not first thing.', 'PERSON', 'nicki', 60 * 29, { relevance: 'THIS_STAY' });
    add('ZZZ0024', 'svc-genmed', 'PRIVACY', 'I want my wife Ana with me when the doctors talk about my results.', 'PERSON', 'hannah', 60 * 20, { context: 'Results and any big decisions' });
    add('ZZZ0083', 'svc-arc', 'COMMUNICATION', 'Speak to Mum in Tongan if you can, and have me there for anything important.', 'WHANAU', 'nicki', 60 * 50, { sourceName: 'Mele Faleolo (daughter)' });
    add('ZZZ0083', 'svc-arc', 'CULTURAL', 'The tapa cloth on her wall stays up. Please ask before moving it.', 'WHANAU', 'nicki', 60 * 49, { sourceName: 'Mele Faleolo (daughter)' });
    add('ZZZ0059', 'svc-arc', 'CULTURAL', 'Keep my pillow and hairbrush away from where food goes, and do not sit on my pillow.', 'PERSON', 'nicki', 60 * 24 * 20);
    add('ZZZ0067', 'svc-arc', 'ROUTINE', 'Vera Lynn records help her settle in the late afternoon.', 'OBSERVED', 'tama', 60 * 24 * 6, {
      context: 'When she starts calling out or pacing', outcome: ['MET', null, 'tama', 60 * 20],
    });
    add('ZZZ0075', 'svc-arc', 'PERSONAL_CARE', 'I would rather a man helps me in the shower.', 'PERSON', 'nicki', 60 * 24 * 40, {
      outcome: ['NOT_MET', 'No male caregiver on the afternoon shift. Frank chose a sponge wash tonight and a shower with Ravi in the morning.', 'tama', 60 * 26],
    });
  });
}

function set20(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string | null, mins: number, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'capacity', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason, transaction_id: null });
  interface Found {
    by: string; mins: number; answers: [string, string, string, string]; findings: string; supports: string | null; present?: string;
    determination: string; note?: string; reassessBy?: string | null;
  }
  const add = (nhi: string, service: string, decision: string, kind: string, concern: string, by: string, mins: number, found?: Found) => {
    const pid = person(nhi);
    const raiser = who(by);
    if (!pid || !raiser) return;
    const id = newId();
    const assessor = found ? who(found.by) : null;
    store.insert('capacity_assessment', {
      id, person_id: pid, service_id: service, decision, decision_kind: kind, concern, state: found ? 'DETERMINED' : 'RAISED', raised_by: raiser, raised_at: ago(mins),
      understand: found?.answers[0] ?? null, retain: found?.answers[1] ?? null, weigh: found?.answers[2] ?? null, communicate: found?.answers[3] ?? null,
      findings: found?.findings ?? null, supports: found?.supports ?? null, present: found?.present ?? null, determination: found?.determination ?? null,
      determination_note: found?.note ?? null, assessed_by: assessor, assessed_at: found ? ago(found.mins) : null, reassess_by: found?.reassessBy ?? null,
    });
    step(id, null, 'RAISED', raiser, mins, decision);
    if (found) step(id, 'RAISED', 'DETERMINED', assessor, found.mins, found.determination);
  };
  store.tx(() => {
    add('ZZZ0032', 'svc-genmed', 'Whether to go home to live alone or move into residential care', 'LIVING',
      'Karen is worried Peggy does not remember her falls at home and says she "never falls". Peggy wants to go home.', 'nicki', 120);
    add('ZZZ0016', 'svc-genmed', 'Whether to leave hospital before the infection is treated', 'TREATMENT',
      'Wiremu tried to leave twice overnight to "feed the dogs". New confusion since admission, likely delirium.', 'nicki', 60 * 30, {
        by: 'hannah', mins: 60 * 28, answers: ['NO', 'NO', 'NO', 'YES'],
        findings: 'Explained the kidney infection and the risk of leaving. He could not say why he was in hospital two minutes later, and said he needed to go because it was 1985 and the dogs were hungry.',
        supports: 'Spoke with him in the morning when he is clearest, with his hearing aid in. His son Rawiri was on the phone and explained things in te reo Māori. Dogs confirmed fed by his neighbour.',
        present: 'Rawiri Te Whare (son) by phone, Nicki V RN', determination: 'LACKS',
        note: 'Likely delirium, expected to improve with treatment. Assess again as it settles.', reassessBy: day(-1),
      });
    add('ZZZ9999', 'svc-genmed', 'Whether to have a colonoscopy', 'TREATMENT',
      'Drowsy after a night of poor sleep and new pain relief; wanted to be sure she could decide.', 'nicki', 60 * 20, {
        by: 'hannah', mins: 60 * 18, answers: ['YES', 'YES', 'YES', 'YES'],
        findings: 'Explained what a colonoscopy is, why it is suggested, the risks and the choice not to have it. Aroha repeated this back in her own words and asked about sedation.',
        supports: 'Waited until the afternoon when she was more awake. Written leaflet given.', present: 'Aroha\'s partner Hemi', determination: 'HAS',
        note: 'She is still thinking about it and will tell us tomorrow.',
      });
    add('ZZZ0067', 'svc-arc', 'Whether to have her remaining teeth taken out under general anaesthetic', 'TREATMENT',
      'Dentist recommends removal. Elsie has advanced dementia and says different things each time it is raised.', 'nicki', 60 * 24 * 2);
  });
}

function set21(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface Support {
    nhi: string; name: string; relationship: string; note?: string; phone?: string; first?: boolean; wishes: string; share: string;
    involve?: string; limits?: string; authority?: string; authorityRef?: string; by: string; mins: number;
    contacts?: [string, string, string, string, string, number][];
  }
  const add = (x: Support) => {
    const pid = person(x.nhi);
    const by = who(x.by);
    if (!pid || !by) return;
    const id = newId();
    store.insert('support_person', {
      id, person_id: pid, name: x.name, relationship: x.relationship, relationship_note: x.note ?? null, phone: x.phone ?? null, first_contact: x.first ? 1 : 0,
      wishes: x.wishes, share: x.share, involve: x.involve ?? null, limits: x.limits ?? null, authority: x.authority ?? 'NONE', authority_ref: x.authorityRef ?? null,
      authority_seen_by: x.authority ? by : null, authority_seen_at: x.authority ? ago(x.mins) : null, state: 'ACTIVE', added_by: by, added_at: ago(x.mins),
    });
    store.insert('state_transition', { id: newId(), object_type: 'supportperson', object_id: id, from_state: null, to_state: 'ACTIVE', actor_id: by, work_context_id: null, at: ago(x.mins), reason: x.name, transaction_id: null });
    for (const [kind, summary, shared, u, service, m] of x.contacts ?? []) {
      store.insert('support_contact', { id: newId(), support_person_id: id, kind, summary, shared, by_id: who(u), service_id: service, at: ago(m) });
    }
  };
  store.tx(() => {
    add({
      nhi: 'ZZZ0032', name: 'Karen Oliver', relationship: 'CHILD', note: 'Daughter, lives in Epsom', phone: '021 555 0132', first: true, wishes: 'ASKED', share: 'ALL',
      involve: 'Discharge planning and anything about going home', by: 'nicki', mins: 60 * 24 * 5,
      contacts: [['WE_CALLED', 'Update on the fall and the plan for a home visit with the OT. Karen can come Thursday.', 'HEALTH', 'nicki', 'svc-genmed', 60 * 6]],
    });
    add({
      nhi: 'ZZZ0032', name: 'Paul Oliver', relationship: 'CHILD', note: 'Son, Australia', wishes: 'ASKED', share: 'NOTHING',
      limits: 'Peggy does not want Paul told anything about her health. Pass messages to her.', by: 'nicki', mins: 60 * 24 * 5,
      contacts: [['THEY_CALLED', 'Asked how Mum is. Told him she is on the ward and would love a call; put him through to her phone.', 'NONE', 'nicki', 'svc-genmed', 60 * 30]],
    });
    add({
      nhi: 'ZZZ0016', name: 'Rawiri Te Whare', relationship: 'CHILD', note: 'Son', phone: '027 555 0116', first: true, wishes: 'NOT_ABLE', share: 'UNKNOWN',
      authority: 'EPOA_CARE', authorityRef: 'Enduring power of attorney for personal care and welfare, signed 12 March 2021; copy seen and on file', by: 'nicki', mins: 60 * 29,
      contacts: [['THEY_CALLED', 'Rawiri rang to ask how his dad slept. Asked him to come in this afternoon to talk with Dr Li.', 'NONE', 'nicki', 'svc-genmed', 60 * 5]],
    });
    add({ nhi: 'ZZZ0024', name: 'Ana Tuilagi', relationship: 'PARTNER', note: 'Wife', phone: '021 555 0124', first: true, wishes: 'ASKED', share: 'ALL', involve: 'Results and big decisions', by: 'hannah', mins: 60 * 20 });
    add({ nhi: 'ZZZ0083', name: 'Mele Faleolo', relationship: 'CHILD', note: 'Daughter', phone: '021 555 0183', first: true, wishes: 'ASKED', share: 'ALL', involve: 'Anything important, and to interpret', by: 'nicki', mins: 60 * 24 * 50 });
    add({ nhi: 'ZZZ0059', name: 'Aroha Hēnare', relationship: 'GRANDCHILD', note: 'Mokopuna', phone: '022 555 0159', wishes: 'NOT_YET', share: 'UNKNOWN', by: 'nicki', mins: 60 * 24 * 3 });
  });
}

// Interpreters and communication needs (Object 253).
function set22(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (type: string, id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: type, object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  const need = (nhi: string, kind: string, language: string | null, detail: string, when: string, u: string, mins: number, reviewDate?: string) => {
    const pid = person(nhi);
    const by = who(u);
    if (!pid || !by) return null;
    const id = newId();
    store.insert('comm_need', { id, person_id: pid, kind, language, detail, when_needed: when, review_date: reviewDate ?? null, state: 'ACTIVE', recorded_by: by, recorded_at: ago(mins) });
    step('commneed', id, null, 'ACTIVE', by, ago(mins), detail);
    return { id, pid, by };
  };
  interface Booking { purpose: string; mode: string; neededIn: number; service: string; u: string; mins: number; provider?: string; reference?: string; interpreter?: string; outcome?: string; family?: boolean; state: string }
  const book = (n: { id: string; pid: string } | null, x: Booking) => {
    const by = who(x.u);
    if (!n || !by) return;
    const id = newId();
    const booked = x.state !== 'REQUESTED';
    const closed = ['PROVIDED', 'NOT_PROVIDED'].includes(x.state);
    const needed = new Date(Date.now() + x.neededIn * 60_000).toISOString();
    store.insert('interpreter_booking', {
      id, need_id: n.id, person_id: n.pid, service_id: x.service, purpose: x.purpose, mode: x.mode, needed_at: needed, state: x.state,
      requested_by: by, requested_at: ago(x.mins), provider: x.provider ?? null, reference: x.reference ?? null, interpreter: x.interpreter ?? null,
      booked_by: booked ? by : null, booked_at: booked ? ago(x.mins - 30) : null, outcome: x.outcome ?? null, family_interpreted: x.family ? 1 : 0,
      closed_by: closed ? by : null, closed_at: closed ? needed : null,
    });
    step('interpreter', id, null, 'REQUESTED', by, ago(x.mins), x.purpose);
    if (booked) step('interpreter', id, 'REQUESTED', 'BOOKED', by, ago(x.mins - 30), x.provider ?? 'Arranged on the spot');
    if (closed) step('interpreter', id, 'BOOKED', x.state, by, needed, x.outcome ?? '');
  };
  store.tx(() => {
    const losa = need('ZZZ0083', 'INTERPRETER', 'Tongan', 'Speaks some English day to day but Tongan for anything about her health. Mele (daughter) often helps.', 'IMPORTANT', 'nicki', 60 * 24 * 58);
    book(losa, {
      purpose: 'Six-monthly care review with Losa and her family', mode: 'IN_PERSON', neededIn: 60 * 26, service: 'svc-arc', u: 'kate', mins: 60 * 3, state: 'REQUESTED',
    });
    book(losa, {
      purpose: 'Admission meeting', mode: 'PHONE', neededIn: -60 * 24 * 57, service: 'svc-arc', u: 'nicki', mins: 60 * 24 * 58, state: 'PROVIDED', family: true,
      outcome: 'Mele interpreted. The phone interpreter could not be reached after two tries and Losa asked for Mele. Losa agreed the care plan.',
    });
    const wiremu = need('ZZZ0016', 'INTERPRETER', 'Te reo Māori', 'Wiremu and Rawiri want kōrero about big decisions in te reo Māori.', 'IMPORTANT', 'nicki', 60 * 24 * 3);
    book(wiremu, {
      purpose: 'Whānau hui with Dr Li about going home', mode: 'IN_PERSON', neededIn: 60 * 5, service: 'svc-genmed', u: 'nicki', mins: 60 * 20, state: 'BOOKED',
      provider: 'Te Awa Hospital Māori health service', reference: 'KH-2291', interpreter: 'Matua Hemi',
    });
    need('ZZZ0075', 'HEARING', null, 'Hearing aid in the left ear; check the battery each morning. Face Frank and speak slowly; he lip-reads.', 'ALWAYS', 'kate', 60 * 24 * 140, new Date(Date.now() - 60 * 60_000 * 24).toISOString().slice(0, 10));
    need('ZZZ0067', 'VISION', null, 'Macular degeneration. Large print only, and tell Elsie who you are when you come in.', 'ALWAYS', 'kate', 60 * 24 * 600);
  });
}

// Information from other providers (Object 254).
function set23(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = (days: number) => ago(days * 24 * 60).slice(0, 10);
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'external', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Item {
    service: string; org: string; author?: string; kind: string; channel: string; written: string; title: string; content: string;
    name: string; nhi?: string; dob?: string; u: string; mins: number;
    match?: { nhi: string; checks: string };
    review?: { u: string; summary: string; outcome: string; note?: string; mins: number };
    supersedes?: string;
  }
  const add = (x: Item) => {
    const by = who(x.u);
    if (!by) return null;
    const pid = x.match ? person(x.match.nhi) : null;
    if (x.match && !pid) return null;
    const id = newId();
    const reviewer = x.review ? who(x.review.u) : null;
    store.insert('external_info', {
      id, service_id: x.service, person_id: pid, source_org: x.org, source_author: x.author ?? null, source_kind: x.kind, channel: x.channel, written_at: x.written,
      title: x.title, content: x.content, content_hash: sha256(x.content), stated_name: x.name, stated_nhi: x.nhi ?? null, stated_dob: x.dob ?? null,
      state: x.review ? x.review.outcome : x.match ? 'MATCHED' : 'RECEIVED', received_by: by, received_at: ago(x.mins),
      matched_by: pid ? by : null, matched_at: pid ? ago(x.mins - 5) : null, match_checks: x.match?.checks ?? null,
      reviewed_by: reviewer, reviewed_at: x.review ? ago(x.review.mins) : null, review_summary: x.review?.summary ?? null, outcome_note: x.review?.note ?? null,
      supersedes: x.supersedes ?? null,
    });
    step(id, null, 'RECEIVED', by, ago(x.mins), `${x.org}: ${x.title}`);
    if (pid) step(id, 'RECEIVED', 'MATCHED', by, ago(x.mins - 5), `Matched on ${x.match!.checks}`);
    if (x.review && reviewer) step(id, 'MATCHED', x.review.outcome, reviewer, ago(x.review.mins), x.review.summary);
    return id;
  };
  store.tx(() => {
    // General Medicine inbox.
    add({
      service: 'svc-genmed', org: 'Epsom Medical Centre', author: 'Dr Grace Lin, GP', kind: 'GP_LETTER', channel: 'ELECTRONIC', written: day(1),
      title: 'GP letter about Peggy', name: 'Margaret Oliver', nhi: 'ZZZ0032', dob: '1938-09-30', u: 'nicki', mins: 90,
      content: 'Dear Ward K team,\n\nThank you for caring for Peggy. She had two falls at home in August. Her daughter Karen has been worried about her managing stairs. Peggy stopped her evening amlodipine in July because of dizziness; I agreed with this. Please let me know the outcome of your home visit assessment.\n\nGrace Lin, GP',
    });
    add({
      service: 'svc-genmed', org: 'Northern Community Laboratory', kind: 'RESULT', channel: 'FAX', written: day(2),
      title: 'Ferritin and B12', name: 'J Chen', dob: '1985-01-17', u: 'nicki', mins: 60,
      content: 'Patient: J CHEN  DOB 17/01/1985\nFerritin 9 ug/L (L)  [30-400]\nVitamin B12 310 pmol/L  [150-700]\nRequested by: Harbour Urgent Care',
    });
    add({
      service: 'svc-genmed', org: 'Harbour Physiotherapy', kind: 'OTHER', channel: 'EMAIL', written: day(3),
      title: 'Physio discharge letter', name: 'Mary Olsen', nhi: 'ZZZ0999', dob: '1950-05-05', u: 'nicki', mins: 45,
      content: 'Mary Olsen has completed her course of physiotherapy after her hip replacement and is walking independently with one stick.',
    });
    add({
      service: 'svc-genmed', org: 'St John Ambulance', author: 'Paramedic crew 412', kind: 'AMBULANCE', channel: 'ELECTRONIC', written: day(1),
      title: 'Ambulance patient report form', name: 'Sione Tuilagi', nhi: 'ZZZ0024', dob: '1972-06-21', u: 'nicki', mins: 60 * 20, match: { nhi: 'ZZZ0024', checks: 'NHI,DOB,NAME' },
      content: 'Called 06:40 for chest tightness at work, 45 minutes. Aspirin 300 mg given 06:58. GTN 400 mcg x2 with some relief. ECG: no ST elevation. Pain 6/10 on arrival at ED.',
    });
    add({
      service: 'svc-genmed', org: 'Ponsonby Family Doctors', author: 'Dr Rewi Karaka, GP', kind: 'MEDICINES', channel: 'ELECTRONIC', written: day(3),
      title: 'Current medicines from GP', name: 'Aroha Rangi', nhi: 'ZZZ9999', dob: '1964-03-14', u: 'nicki', mins: 60 * 30, match: { nhi: 'ZZZ9999', checks: 'NHI,DOB,NAME' },
      review: { u: 'hannah', mins: 60 * 26, outcome: 'INCORPORATED', summary: 'GP list matches ours except metformin, which the GP increased to 1 g twice daily last month.', note: 'Medicines chart updated to metformin 1 g twice daily.' },
      content: 'Metformin 1 g twice daily (increased 14 Aug)\nCilazapril 2.5 mg daily\nAtorvastatin 40 mg at night\nAllergy: penicillin (rash)',
    });
    // Residential Care.
    add({
      service: 'svc-arc', org: 'Te Awa Hospital, Older Adults Service', author: 'Dr Ana Fifita, Geriatrician', kind: 'SPECIALIST_LETTER', channel: 'ELECTRONIC', written: day(2),
      title: 'Geriatrician clinic letter', name: 'Losa Faleolo', nhi: 'ZZZ0083', dob: '1946-04-19', u: 'kate', mins: 60 * 6, match: { nhi: 'ZZZ0083', checks: 'NHI,DOB,NAME' },
      content: 'Seen with her daughter Mele, Tongan interpreter present. Memory testing shows mild cognitive impairment, stable since March. Please continue the daily walk and church outings. Review in 6 months. No medicine changes.',
    });
    const first = add({
      service: 'svc-arc', org: 'Hear Well Audiology', author: 'Sam Reid, Audiologist', kind: 'SPECIALIST_LETTER', channel: 'EMAIL', written: day(40),
      title: 'Audiology report', name: 'Frank Dawson', nhi: 'ZZZ0075', dob: '1941-12-01', u: 'kate', mins: 60 * 24 * 40, match: { nhi: 'ZZZ0075', checks: 'NHI,DOB,NAME' },
      review: { u: 'kate', mins: 60 * 24 * 39, outcome: 'REFERENCED', summary: 'Severe loss in the right ear, moderate in the left. New left hearing aid to be fitted.' },
      content: 'Severe sensorineural loss right, moderate left. Left aid to be fitted on 20 August. Right ear aid not helpful.',
    });
    if (first) {
      const second = add({
        service: 'svc-arc', org: 'Hear Well Audiology', author: 'Sam Reid, Audiologist', kind: 'SPECIALIST_LETTER', channel: 'EMAIL', written: day(20),
        title: 'Audiology report (updated)', name: 'Frank Dawson', nhi: 'ZZZ0075', dob: '1941-12-01', u: 'kate', mins: 60 * 24 * 20, match: { nhi: 'ZZZ0075', checks: 'NHI,DOB,NAME' },
        review: { u: 'kate', mins: 60 * 24 * 19, outcome: 'REFERENCED', summary: 'Left aid fitted 20 August. Battery size 312, change weekly. Face him when speaking.' },
        supersedes: first,
        content: 'Severe sensorineural loss right, moderate left. Left aid fitted 20 August and working well. Battery size 312, change weekly. Staff to face Frank when speaking.',
      });
      if (second) {
        store.run("UPDATE external_info SET state = 'SUPERSEDED', superseded_by = ? WHERE id = ?", second, first);
        step(first, 'REFERENCED', 'SUPERSEDED', who('kate')!, ago(60 * 24 * 20), 'Replaced by a newer version from Hear Well Audiology');
      }
    }
    add({
      service: 'svc-arc', org: 'Remuera Pharmacy', kind: 'MEDICINES', channel: 'FAX', written: day(1),
      title: 'Blister pack medicines list', name: 'Elsie Morgan', dob: '1933-07-12', u: 'kate', mins: 120,
      content: 'ELSIE MORGAN  12/07/1933\nDonepezil 5 mg at night\nParacetamol 1 g four times daily\nCholecalciferol 1.25 mg monthly',
    });
  });
}

// Clinical coding (Object 255): a clinical coder, and hospital episodes at each stage.
function set24(store: Store, password: string): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const DAY = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  store.insert('service', { id: 'svc-coding', organisation_id: 'org-hosp', facility_id: 'fac-hosp', name: 'Clinical Coding', sector: 'Hospital operations', subject_label: 'Patient' });
  const lee = newWorker(store, hashPassword(password), 'lee', 'Lee', 'Wong', 'Lee Wong');
  const eid = newId();
  store.insert('employment', { id: eid, workforce_person_id: lee, organisation_id: 'org-hosp', employment_type: 'PERMANENT', start_date: '2021-02-01' });
  const pos = newId();
  store.insert('position', { id: pos, employment_id: eid, service_id: 'svc-coding', title: 'Clinical Coder', role_key: 'clinical-coder', start_date: '2021-02-01' });
  const today = todayLocal();
  for (let d = -7; d < 28; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (dow === 0 || dow === 6) continue;
    store.insert('roster_shift', { id: newId(), workforce_person_id: lee, position_id: pos, service_id: 'svc-coding', shift_date: date, start_time: '08:00', end_time: '16:30', state: 'PLANNED', data_source: 'SYNTHETIC' });
  }
  const step = (type: string, id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: type, object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Episode {
    nhi: string; service: string; location: string; kind: string; from: number; to: number; reason: string;
    events: [string, string, string, string, number][];   // category, text, author username, role label, minutes ago
  }
  const episode = (x: Episode) => {
    const pid = person(x.nhi);
    if (!pid) return null;
    const enc = newId();
    store.insert('encounter', { id: enc, person_id: pid, service_id: x.service, location: x.location, kind: x.kind, started_at: ago(x.from), ended_at: ago(x.to), state: 'ENDED' });
    const ids: string[] = [];
    for (const [category, text, u, role, m] of x.events) {
      const id = newId();
      store.insert('clinical_event', {
        id, lineage_id: id, version: 1, person_id: pid, encounter_id: enc, category, key_code: null, key_version: null, fields_json: '{}', rendered_text: text,
        author_id: who(u), author_position_id: null, author_role_label: role, service_id: x.service, recorded_at: ago(m - 5), effective_at: ago(m), state: 'CURRENT',
        urgent: 0, collection: 'DIRECT', data_source: 'SYNTHETIC',
      });
      ids.push(id);
    }
    const cid = newId();
    store.insert('coding_case', { id: cid, encounter_id: enc, person_id: pid, service_id: x.service, organisation_id: 'org-hosp', state: 'REQUIRED', required_at: ago(x.to), required_reason: x.reason });
    step('coding', cid, null, 'REQUIRED', lee, ago(x.to), x.reason);
    return { cid, ids, pid };
  };
  const entry = (cid: string, system: string, code: string, term: string, role: string, source: string, mins: number) =>
    store.insert('coding_entry', { id: newId(), case_id: cid, system, code, term, role, source_event_id: source, source_note: null, state: 'ACTIVE', added_by: lee, added_at: ago(mins) });
  const DR = 'Physician, General Medicine';
  const ED_DR = 'Emergency Physician, Emergency Department';
  const ED_RN = 'Registered Nurse, Emergency Department';
  store.tx(() => {
    // Sione: his Emergency Department episode ended when General Medicine took over. Not coded yet.
    episode({
      nhi: 'ZZZ0024', service: 'svc-ed', location: 'Resus 1', kind: 'EMERGENCY', from: 27 * 60, to: 24 * 60, reason: 'Transferred to General Medicine',
      events: [
        ['TRIAGE', 'Triage: chest tightness at work for 45 minutes, pain 6/10, sweaty. Aspirin given by ambulance.', 'mere', ED_RN, 27 * 60 - 5],
        ['MEDICAL', 'ECG: no ST elevation. High-sensitivity troponin 45 then 112 ng/L at 2 hours. Impression: NSTEMI. Plan: admit General Medicine, cardiology review.', 'ravi', ED_DR, 25 * 60],
        ['DISPOSITION', 'Admitted to General Medicine, Ward K Bed 6.', 'ravi', ED_DR, 24 * 60 + 10],
      ],
    });
    // Frank: a General Medicine stay for pneumonia, being coded, with a question to the ward.
    const frank = episode({
      nhi: 'ZZZ0075', service: 'svc-genmed', location: 'Ward K Bed 3', kind: 'INPATIENT', from: 25 * DAY, to: 19 * DAY, reason: 'Discharged: Residential care',
      events: [
        ['PROBLEM', 'Problem: Community-acquired pneumonia, right lower lobe (Active)', 'hannah', DR, 25 * DAY - 120],
        ['REVIEW', 'Ward round. Impression: right lower lobe pneumonia. Plan: IV amoxicillin, then oral when afebrile.', 'hannah', DR, 24 * DAY],
        ['PROGRESS', 'More confused overnight and pulling at his IV line. Settled with reorientation and his hearing aid in.', 'nicki', 'Registered Nurse, General Medicine', 23 * DAY],
        ['REVIEW', 'Ward round. Afebrile 48 hours, eating well, back to his usual self. Oral amoxicillin to finish 7 days. Back to his rest home tomorrow.', 'hannah', DR, 20 * DAY],
      ],
    });
    if (frank) {
      store.run("UPDATE coding_case SET state = 'IN_PROGRESS', coder_id = ?, started_at = ? WHERE id = ?", lee, ago(DAY), frank.cid);
      step('coding', frank.cid, 'REQUIRED', 'IN_PROGRESS', lee, ago(DAY), 'Coding started');
      entry(frank.cid, 'ICD10AM', 'J18.9', 'Pneumonia, unspecified', 'PRINCIPAL', frank.ids[0], DAY - 20);
      const qid = newId();
      store.insert('coding_query', {
        id: qid, case_id: frank.cid, service_id: 'svc-genmed', state: 'OPEN', asked_by: lee, asked_at: ago(DAY - 30),
        question: 'The nursing note on day 2 says Frank was more confused overnight and pulling at his IV line. Was this delirium? If so, was it caused by the pneumonia?',
      });
      step('codingquery', qid, null, 'OPEN', lee, ago(DAY - 30), 'Question about confusion on day 2');
    }
    // Elsie: an Emergency Department visit after a fall, coded and finalised.
    const elsie = episode({
      nhi: 'ZZZ0067', service: 'svc-ed', location: 'Minors 2', kind: 'EMERGENCY', from: 12 * DAY, to: 12 * DAY - 180, reason: 'Discharged: Residential care',
      events: [
        ['TRIAGE', 'Triage: fall at her rest home, 4 cm skin tear to the left forearm. No head strike. Pain 3/10.', 'mere', ED_RN, 12 * DAY - 10],
        ['PROCEDURE', 'Skin tear cleaned, flap laid back and closed with adhesive strips. Dressing on.', 'mere', ED_RN, 12 * DAY - 90],
        ['DISPOSITION', 'Back to her rest home. Dressing check in 3 days by rest home nurse.', 'ravi', ED_DR, 12 * DAY - 170],
      ],
    });
    if (elsie) {
      store.run("UPDATE coding_case SET state = 'FINALISED', coder_id = ?, started_at = ?, finalised_by = ?, finalised_at = ? WHERE id = ?", lee, ago(11 * DAY), lee, ago(10 * DAY), elsie.cid);
      step('coding', elsie.cid, 'REQUIRED', 'IN_PROGRESS', lee, ago(11 * DAY), 'Coding started');
      step('coding', elsie.cid, 'IN_PROGRESS', 'FINALISED', lee, ago(10 * DAY), 'Coding finalised');
      entry(elsie.cid, 'ICD10AM', 'S51.8', 'Open wound of other parts of forearm', 'PRINCIPAL', elsie.ids[0], 11 * DAY);
      entry(elsie.cid, 'ICD10AM', 'W19', 'Unspecified fall', 'ADDITIONAL', elsie.ids[0], 11 * DAY);
    }
  });
}

// Patient-reported information (Object 256): what people told staff, in their words.
function set25(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'report', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Said {
    nhi: string; service: string; topic: string; words: string; u: string; mins: number; source?: string; sourceName?: string; how?: string;
    rating?: number; about?: string; review?: boolean; reviewed?: { u: string; outcome: string; note?: string; mins: number };
    lineage?: string; version?: number; supersedes?: string; change?: string; state?: string;
  }
  const add = (x: Said) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return null;
    const id = newId();
    const rv = x.reviewed ? who(x.reviewed.u) : null;
    const state = x.state ?? (x.reviewed ? 'REVIEWED' : 'RECORDED');
    store.insert('patient_report', {
      id, lineage_id: x.lineage ?? id, version: x.version ?? 1, supersedes: x.supersedes ?? null, change_kind: x.change ?? null, person_id: pid, service_id: x.service,
      source: x.source ?? 'PATIENT', source_name: x.sourceName ?? null, how: x.how ?? 'IN_PERSON', topic: x.topic, words: x.words, rating: x.rating ?? null,
      about_when: x.about ?? null, reported_at: ago(x.mins), recorded_by: by, recorded_at: ago(x.mins - 5), needs_review: x.review || (x.rating ?? 0) >= 7 ? 1 : 0,
      state, reviewed_by: rv, reviewed_at: x.reviewed ? ago(x.reviewed.mins) : null, review_outcome: x.reviewed?.outcome ?? null, review_note: x.reviewed?.note ?? null,
    });
    step(id, null, 'RECORDED', by, ago(x.mins - 5), x.words.slice(0, 200));
    if (x.reviewed && rv) step(id, 'RECORDED', 'REVIEWED', rv, ago(x.reviewed.mins), x.reviewed.note ?? 'Read; no change to care');
    return id;
  };
  store.tx(() => {
    add({
      nhi: 'ZZZ0032', service: 'svc-genmed', topic: 'PAIN', rating: 7, about: 'the last two nights', u: 'nicki', mins: 50,
      words: 'My left hip aches at night, worse when I lie on that side. The tablets at tea time wear off by about 2 o\'clock.',
    });
    add({
      nhi: 'ZZZ0016', service: 'svc-genmed', topic: 'GOALS', source: 'WHANAU', sourceName: 'Rawiri, son', how: 'PHONE', u: 'nicki', mins: 60 * 20,
      words: 'Dad really wants to be home for the kapa haka at his mokopuna\'s school on the 10th. It matters more to him than anything.',
      reviewed: { u: 'hannah', outcome: 'INCORPORATED', note: 'Discharge planning aims for before the 10th; told Rawiri.', mins: 60 * 18 },
    });
    add({
      nhi: 'ZZZ9999', service: 'svc-genmed', topic: 'SLEEP', about: 'last night', u: 'nicki', mins: 60 * 9, review: true,
      words: 'I can\'t sleep with the oxygen tubing. It dries my nose right out and I wake up every hour.',
      reviewed: { u: 'hannah', outcome: 'INCORPORATED', note: 'Humidified oxygen at night; nasal gel added to the chart.', mins: 60 * 7 },
    });
    add({
      nhi: 'ZZZ0083', service: 'svc-arc', topic: 'EATING', how: 'INTERPRETER', u: 'kate', mins: 60 * 30, review: true,
      words: 'The food has no taste. I would eat more if my family could bring in food from home, like they do at church.',
    });
    add({ nhi: 'ZZZ0075', service: 'svc-arc', topic: 'MOOD', u: 'tama', mins: 60 * 4, words: 'I miss my dog Bess. My neighbour has her now. Some days that is the hardest thing.' });
    const first = add({
      nhi: 'ZZZ0091', service: 'svc-arc', topic: 'MEDICINES', u: 'tama', mins: 60 * 24 * 3, state: 'SUPERSEDED',
      words: 'I take my inhaler twice a day.',
    });
    if (first) {
      add({
        nhi: 'ZZZ0091', service: 'svc-arc', topic: 'MEDICINES', u: 'kate', mins: 60 * 5, review: true, lineage: first, version: 2, supersedes: first, change: 'CORRECTION',
        words: 'I only use the brown inhaler in the morning. I got muddled before; the blue one is just for when I\'m puffed, and I\'ve needed it most days this week.',
      });
      step(first, 'RECORDED', 'SUPERSEDED', who('kate')!, ago(60 * 5 - 5), 'Replaced by their correction');
    }
  });
}

function set26(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'instrument', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Use {
    nhi: string; service: string; code: string; reason: string; asked: string; askedMins: number; dueMins: number; repeatOf?: string;
    done?: { u: string; mins: number; mode: string; answers: number[] };
    interpreted?: { u: string; mins: number; meaning: string; action: string };
  }
  const add = (x: Use) => {
    const inst = INSTRUMENT_BY_CODE.get(x.code)!;
    const pid = person(x.nhi);
    const by = who(x.asked);
    if (!pid || !by) return null;
    const id = newId();
    const row: Record<string, unknown> = {
      id, person_id: pid, service_id: x.service, instrument_code: inst.code, instrument_version: inst.version, state: 'REQUESTED',
      reason: x.reason, due_at: ago(x.dueMins), requested_by: by, requested_at: ago(x.askedMins), repeat_of: x.repeatOf ?? null,
    };
    const doneBy = x.done ? who(x.done.u) : null;
    if (x.done && doneBy) {
      const responses = Object.fromEntries(inst.items.map((it, n) => [it.id, x.done!.answers[n]]));
      const score = inst.items.reduce((t, it, n) => t + it.options[x.done!.answers[n]].score, 0);
      const flags = inst.flags.filter((f) => inst.items.find((it) => it.id === f.item)!.options[responses[f.item]].score >= f.atLeast).map((f) => f.text);
      Object.assign(row, {
        state: 'COMPLETED', mode: x.done.mode, administered_by: doneBy, administered_at: ago(x.done.mins), responses_json: JSON.stringify(responses),
        score, band: inst.bands.find((b) => score >= b.min && score <= b.max)?.label ?? null, flags_json: flags.length ? JSON.stringify(flags) : null,
      });
    }
    const readBy = x.interpreted ? who(x.interpreted.u) : null;
    if (x.interpreted && readBy) Object.assign(row, { state: 'INTERPRETED', interpreted_by: readBy, interpreted_at: ago(x.interpreted.mins), interpretation: x.interpreted.meaning, action: x.interpreted.action });
    store.insert('instrument_use', row);
    step(id, null, 'REQUESTED', by, ago(x.askedMins), `${inst.name}: ${x.reason}`);
    if (x.done && doneBy) step(id, 'REQUESTED', 'COMPLETED', doneBy, ago(x.done.mins), `Score ${row.score}`);
    if (x.interpreted && readBy) step(id, 'COMPLETED', 'INTERPRETED', readBy, ago(x.interpreted.mins), x.interpreted.meaning.slice(0, 200));
    return id;
  };
  store.tx(() => {
    // Wiremu: a 4AT yesterday suggested delirium; the physician read it and asked for a daily repeat, now overdue.
    const first = add({
      nhi: 'ZZZ0016', service: 'svc-genmed', code: '4AT', reason: 'Night staff noticed new confusion', asked: 'nicki', askedMins: 60 * 27, dueMins: 60 * 27,
      done: { u: 'nicki', mins: 60 * 26, mode: 'OBSERVED', answers: [0, 1, 0, 1] },
      interpreted: { u: 'hannah', mins: 60 * 25, meaning: 'Possible delirium, new since admission. Most likely from his urine infection and poor sleep; no new medicines to blame.',
        action: 'Delirium care plan started: glasses and hearing aids on, lights low at night, fluids pushed. Son Rawiri told. Repeat the 4AT daily.' },
    });
    if (first) {
      const next = add({ nhi: 'ZZZ0016', service: 'svc-genmed', code: '4AT', reason: 'Repeat of 4AT (score 5)', asked: 'hannah', askedMins: 60 * 25, dueMins: 60, repeatOf: first });
      if (next) store.run('UPDATE instrument_use SET next_id = ? WHERE id = ?', next, first);
    }
    // Peggy: a PHQ-9 asked for this morning, due later today.
    add({ nhi: 'ZZZ0032', service: 'svc-genmed', code: 'PHQ-9', reason: 'Low mood and eating little since admission', asked: 'hannah', askedMins: 90, dueMins: -180 });
    // Frank: filled in with Kate this afternoon; item 9 was answered and no one has followed it up yet.
    add({
      nhi: 'ZZZ0075', service: 'svc-arc', code: 'PHQ-9', reason: 'Talking a lot about missing his dog Bess; sleeping in the day', asked: 'kate', askedMins: 60 * 24, dueMins: 60 * 5,
      done: { u: 'kate', mins: 60 * 3, mode: 'STAFF_ASKED', answers: [2, 2, 1, 2, 1, 1, 1, 0, 1] },
    });
  });
}

function set27(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (type: string, id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: type, object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  type E = [string, string | null, string | null];   // level, aid, note
  const ACTS = ['WALKING', 'TRANSFERS', 'STAIRS', 'WASHING', 'DRESSING', 'TOILETING', 'EATING'];
  const assess = (x: { nhi: string; service: string; kind: string; u: string; mins: number; e: (E | null)[]; source?: string; sourceName?: string; summary?: string; reviewMins?: number }) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const entries = Object.fromEntries(ACTS.map((a, n) => [a, x.e[n]]).filter(([, e]) => e).map(([a, e]) => [a, { level: (e as E)[0], aid: (e as E)[1], note: (e as E)[2] }]));
    const id = newId();
    store.insert('function_assessment', {
      id, person_id: pid, service_id: x.service, kind: x.kind, state: 'CURRENT', source: x.source ?? null, source_name: x.sourceName ?? null,
      entries_json: JSON.stringify(entries), summary: x.summary ?? null, assessed_by: by, assessed_at: ago(x.mins),
      review_due: x.reviewMins === undefined ? null : ago(-x.reviewMins), supersedes: null,
    });
    step('function', id, null, 'CURRENT', by, ago(x.mins), x.kind === 'CURRENT' ? 'Function now recorded' : 'Usual function recorded');
  };
  const plan = (x: { nhi: string; service: string; activity: string; what: string; u: string; mins: number; started?: number; stopped?: { mins: number; outcome: string } }) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const state = x.stopped ? 'STOPPED' : x.started !== undefined ? 'IN_PLACE' : 'PLANNED';
    store.insert('function_intervention', {
      id, person_id: pid, service_id: x.service, activity: x.activity, what: x.what, state, planned_by: by, planned_at: ago(x.mins),
      started_by: x.started !== undefined ? by : null, started_at: x.started !== undefined ? ago(x.started) : null,
      stopped_by: x.stopped ? by : null, stopped_at: x.stopped ? ago(x.stopped.mins) : null, outcome: x.stopped?.outcome ?? null,
    });
    step('functionplan', id, null, 'PLANNED', by, ago(x.mins), x.what);
    if (x.started !== undefined) step('functionplan', id, 'PLANNED', 'IN_PLACE', by, ago(x.started), 'Put in place');
    if (x.stopped) step('functionplan', id, 'IN_PLACE', 'STOPPED', by, ago(x.stopped.mins), x.stopped.outcome);
  };
  const I: E = ['INDEPENDENT', null, null];
  store.tx(() => {
    // Wiremu: fully independent at home with a stick, per his son; much less so since the delirium.
    assess({
      nhi: 'ZZZ0016', service: 'svc-genmed', kind: 'BASELINE', u: 'nicki', mins: 60 * 70, source: 'WHANAU', sourceName: 'Rawiri, son, by phone',
      e: [['INDEPENDENT', 'Stick', 'Walks to the marae and back'], I, ['INDEPENDENT', 'Rail', null], I, I, I, I],
      summary: 'Lives with his son. Drives short distances. No carers.',
    });
    assess({
      nhi: 'ZZZ0016', service: 'svc-genmed', kind: 'CURRENT', u: 'nicki', mins: 60 * 26, reviewMins: 60 * 20,
      e: [['ASSIST_1', 'Frame', 'Unsteady when turning'], ['SUPERVISION', null, null], ['NOT_DOING', null, 'Not needed on the ward'],
        ['ASSIST_1', 'Shower chair', null], ['SUPERVISION', null, 'Needs prompting with order'], ['SUPERVISION', null, null], I],
      summary: 'Much less steady since the delirium began. Falls risk.',
    });
    plan({ nhi: 'ZZZ0016', service: 'svc-genmed', activity: 'WALKING', what: 'Physio to walk him with the frame twice a day', u: 'nicki', mins: 60 * 25, started: 60 * 24 });
    plan({ nhi: 'ZZZ0016', service: 'svc-genmed', activity: 'WASHING', what: 'Shower with a nurse each morning, sitting on the shower chair', u: 'nicki', mins: 60 * 25, started: 60 * 22 });
    // Peggy: hip pain has slowed her; the reassessment is overdue and no one has asked how she usually manages.
    assess({
      nhi: 'ZZZ0032', service: 'svc-genmed', kind: 'CURRENT', u: 'nicki', mins: 60 * 50, reviewMins: -180,
      e: [['ASSIST_1', 'Frame', 'Left hip pain on weight bearing'], ['ASSIST_1', null, null], ['NOT_DOING', null, 'Hip pain'], ['ASSIST_1', 'Shower stool', null],
        ['ASSIST_1', null, 'Help with lower half'], ['SUPERVISION', 'Raised seat', null], I],
    });
    // Frank: usual function in the home, and the same now. Two staff for all transfers.
    assess({
      nhi: 'ZZZ0075', service: 'svc-arc', kind: 'BASELINE', u: 'kate', mins: 60 * 24 * 120, source: 'STAFF', sourceName: 'Care team, Room 8',
      e: [['DEPENDENT', 'Wheelchair', 'Pushed by staff'], ['ASSIST_2', 'Full hoist', null], ['NOT_DOING', null, 'Wheelchair user'], ['ASSIST_1', 'Shower chair', null],
        ['ASSIST_1', null, null], ['ASSIST_2', 'Commode', null], ['INDEPENDENT', 'Lidded cup', null]],
    });
    assess({
      nhi: 'ZZZ0075', service: 'svc-arc', kind: 'CURRENT', u: 'kate', mins: 60 * 24 * 10, reviewMins: 60 * 24 * 20,
      e: [['DEPENDENT', 'Wheelchair', 'Pushed by staff'], ['ASSIST_2', 'Full hoist', 'Two staff every time'], ['NOT_DOING', null, 'Wheelchair user'], ['ASSIST_1', 'Shower chair', null],
        ['ASSIST_1', null, null], ['ASSIST_2', 'Commode', null], ['INDEPENDENT', 'Lidded cup', null]],
      summary: 'Unchanged from usual. Knees sore on weight bearing.',
    });
    plan({
      nhi: 'ZZZ0075', service: 'svc-arc', activity: 'TRANSFERS', what: 'Trial of the standing hoist instead of the full hoist', u: 'kate', mins: 60 * 24 * 40, started: 60 * 24 * 38,
      stopped: { mins: 60 * 24 * 30, outcome: 'Could not take his weight through his knees. Back to the full hoist.' },
    });
  });
}

function set28(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (type: string, id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: type, object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  const usual = (x: { nhi: string; service: string; domain: string; statement?: string; low?: number; high?: number; source: string; sourceName?: string; u: string; mins: number; state?: string; supersedes?: string }) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return null;
    const id = newId();
    store.insert('usual_state', {
      id, person_id: pid, service_id: x.service, domain: x.domain, statement: x.statement ?? null, low: x.low ?? null, high: x.high ?? null,
      source: x.source, source_name: x.sourceName ?? null, recorded_by: by, recorded_at: ago(x.mins), state: x.state ?? 'CURRENT', supersedes: x.supersedes ?? null,
    });
    step('usual', id, null, 'CURRENT', by, ago(x.mins), 'Usual recorded');
    return id;
  };
  const diff = (x: { nhi: string; service: string; domain: string; usualId: string | null; usualText: string | null; now: string; u: string; mins: number;
    acted?: { u: string; mins: number; action: string }; closed?: { u: string; mins: number; outcome: string; note: string; newUsual?: string } }) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const ab = x.acted ? who(x.acted.u) : null;
    const cb = x.closed ? who(x.closed.u) : null;
    store.insert('usual_difference', {
      id, person_id: pid, service_id: x.service, domain: x.domain, usual_id: x.usualId, usual_text: x.usualText, now_text: x.now, noticed_by: by, noticed_at: ago(x.mins),
      state: x.closed ? 'CLOSED' : x.acted ? 'ACTING' : 'NOTICED', action: x.acted?.action ?? null, acted_by: ab, acted_at: x.acted ? ago(x.acted.mins) : null,
      outcome: x.closed?.outcome ?? null, outcome_note: x.closed?.note ?? null, closed_by: cb, closed_at: x.closed ? ago(x.closed.mins) : null, new_usual_id: x.closed?.newUsual ?? null,
    });
    step('difference', id, null, 'NOTICED', by, ago(x.mins), x.now.slice(0, 200));
    if (x.acted && ab) step('difference', id, 'NOTICED', 'ACTING', ab, ago(x.acted.mins), x.acted.action);
    if (x.closed && cb) step('difference', id, x.acted ? 'ACTING' : 'NOTICED', 'CLOSED', cb, ago(x.closed.mins), x.closed.note);
  };
  store.tx(() => {
    const G = 'svc-genmed';
    const A = 'svc-arc';
    const wThink = 'Sharp; does the crossword every day and knows all his mokopuna\'s names';
    const w = usual({ nhi: 'ZZZ0016', service: G, domain: 'THINKING', statement: wThink, source: 'WHANAU', sourceName: 'Rawiri, son, by phone', u: 'nicki', mins: 60 * 70 });
    diff({ nhi: 'ZZZ0016', service: G, domain: 'THINKING', usualId: w, usualText: wThink, now: 'Confused at night, thinks he is at home, pulling at his drip', u: 'nicki', mins: 60 * 30,
      acted: { u: 'hannah', mins: 60 * 25, action: 'Delirium care plan started; 4AT daily; urine infection being treated' } });
    usual({ nhi: 'ZZZ0016', service: G, domain: 'COMMUNICATION', statement: 'Clear speech; prefers te reo Māori with whānau; hearing aid in the left ear', source: 'WHANAU', sourceName: 'Rawiri, son, by phone', u: 'nicki', mins: 60 * 70 });
    const pEat = 'Good appetite; eats everything and loves a cup of tea with two sugars';
    const p = usual({ nhi: 'ZZZ0032', service: G, domain: 'EATING', statement: pEat, source: 'WHANAU', sourceName: 'Anne, daughter', u: 'nicki', mins: 60 * 120 });
    diff({ nhi: 'ZZZ0032', service: G, domain: 'EATING', usualId: p, usualText: pEat, now: 'Eating about a quarter of each meal for three days; says she is not hungry', u: 'nicki', mins: 60 * 5 });
    usual({ nhi: 'ZZZ9999', service: G, domain: 'HR', low: 60, high: 80, statement: 'Resting heart rate in her GP records', source: 'PRIOR_RECORD', sourceName: 'GP summary, August 2026', u: 'hannah', mins: 60 * 40 });
    const fMood = 'Cheerful; jokes with staff and loves talking about his dog Bess';
    const f = usual({ nhi: 'ZZZ0075', service: A, domain: 'MOOD', statement: fMood, source: 'STAFF', sourceName: 'Care team, Room 8', u: 'kate', mins: 60 * 24 * 100 });
    diff({ nhi: 'ZZZ0075', service: A, domain: 'MOOD', usualId: f, usualText: fMood, now: 'Quiet, staying in his room, not joking with staff', u: 'tama', mins: 60 * 48,
      acted: { u: 'kate', mins: 60 * 24, action: 'PHQ-9 asked for; GP to review; visit from Bess being arranged' } });
    usual({ nhi: 'ZZZ0091', service: A, domain: 'SPO2', low: 88, high: 92, statement: 'COPD; lives in this range on room air', source: 'PRIOR_RECORD', sourceName: 'Respiratory clinic letter, June 2026', u: 'kate', mins: 60 * 24 * 90 });
    const old = usual({ nhi: 'ZZZ0091', service: A, domain: 'CONTINENCE', statement: 'Continent day and night', source: 'STAFF', sourceName: 'Admission assessment', u: 'kate', mins: 60 * 24 * 400, state: 'SUPERSEDED' });
    const now = usual({ nhi: 'ZZZ0091', service: A, domain: 'CONTINENCE', statement: 'Continent by day; needs a pad at night since March', source: 'STAFF', sourceName: 'After a change noticed in February', u: 'kate', mins: 60 * 24 * 200, supersedes: old ?? undefined });
    if (old && now) {
      step('usual', old, 'CURRENT', 'SUPERSEDED', who('kate')!, ago(60 * 24 * 200), 'New usual after a change');
      diff({ nhi: 'ZZZ0091', service: A, domain: 'CONTINENCE', usualId: old, usualText: 'Continent day and night', now: 'Wet most nights for a week', u: 'tama', mins: 60 * 24 * 230,
        acted: { u: 'kate', mins: 60 * 24 * 229, action: 'Urine tested (clear); bladder chart for 3 days; GP review' },
        closed: { u: 'kate', mins: 60 * 24 * 200, outcome: 'NEW_USUAL', note: 'No infection. Night-time pads suit him; he is comfortable with this.', newUsual: now } });
    }
  });
}

function set29(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string | null, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'assignment', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Named {
    nhi: string; service: string; kind: string; u?: string; ext?: string; org?: string; team?: string; by: string; mins: number; reason?: string;
    state?: 'PROPOSED' | 'ACTIVE' | 'ENDED'; endsIn?: number; coverFor?: string | null; ended?: { mins: number; reason: string }; replaces?: string | null;
  }
  const named = (x: Named) => {
    const pid = person(x.nhi);
    const by = who(x.by);
    const assignee = x.u ? who(x.u) : null;
    if (!pid || !by || (x.u && !assignee)) return null;
    const id = newId();
    const state = x.ended ? 'ENDED' : x.state ?? 'ACTIVE';
    const confirmed = state !== 'PROPOSED';
    store.insert('assignment', {
      id, person_id: pid, service_id: x.service, kind: x.kind, assignee_id: assignee, external_name: x.ext ?? null, external_org: x.org ?? null, team_name: x.team ?? null,
      state, proposed_by: by, proposed_at: ago(x.mins), reason: x.reason ?? null, starts_at: ago(x.mins), ends_at: x.endsIn ? ago(-x.endsIn) : null,
      confirmed_by: confirmed ? by : null, confirmed_at: confirmed ? ago(x.mins) : null, confirm_note: confirmed ? (x.u === x.by ? 'Named themselves' : 'Agreed at the board round') : null,
      activated_at: confirmed ? ago(x.mins) : null, ended_by: x.ended ? by : null, ended_at: x.ended ? ago(x.ended.mins) : null, end_reason: x.ended?.reason ?? null,
      replaces: x.replaces ?? null, cover_for: x.coverFor ?? null,
    });
    step(id, null, 'PROPOSED', by, ago(x.mins), x.reason ?? 'Proposed');
    if (confirmed) {
      step(id, 'PROPOSED', 'CONFIRMED', by, ago(x.mins), 'Confirmed');
      step(id, 'CONFIRMED', 'ACTIVE', by, ago(x.mins), 'Starts now');
    }
    if (x.ended) step(id, 'ACTIVE', 'ENDED', by, ago(x.ended.mins), x.ended.reason);
    return id;
  };
  const G = 'svc-genmed';
  const A = 'svc-arc';
  const E = 'svc-ed';
  const day = 60 * 24;
  store.tx(() => {
    // General Medicine: Dr Li is responsible for everyone on Ward K; Nicki is named nurse for most.
    for (const nhi of ['ZZZ9999', 'ZZZ0016', 'ZZZ0024', 'ZZZ0032']) named({ nhi, service: G, kind: 'RESPONSIBLE_DOCTOR', u: 'hannah', by: 'hannah', mins: 3 * day });
    named({ nhi: 'ZZZ9999', service: G, kind: 'NAMED_NURSE', u: 'nicki', by: 'nicki', mins: 2 * day });
    named({ nhi: 'ZZZ9999', service: G, kind: 'TEAM', team: 'General Medicine Team B', by: 'hannah', mins: 2 * day });
    const wDoc = store.get<{ id: string }>("SELECT a.id FROM assignment a JOIN external_identifier x ON x.person_id = a.person_id AND x.system = 'NHI' AND x.value = 'ZZZ0016' WHERE a.kind = 'RESPONSIBLE_DOCTOR'")?.id ?? null;
    if (wDoc) named({ nhi: 'ZZZ0016', service: G, kind: 'RESPONSIBLE_DOCTOR', u: 'sam', by: 'hannah', mins: 60 * 6, endsIn: 2 * day, coverFor: wDoc, reason: 'Dr Li at a conference' });
    named({ nhi: 'ZZZ0016', service: G, kind: 'NAMED_NURSE', u: 'nicki', by: 'nicki', mins: 3 * day });
    named({ nhi: 'ZZZ0032', service: G, kind: 'NAMED_NURSE', u: 'nicki', by: 'hannah', mins: 60 * 2, state: 'PROPOSED', reason: 'Nicki knows her well from last admission' });
    named({ nhi: 'ZZZ0032', service: G, kind: 'PHYSIO', u: 'lena', by: 'lena', mins: 4 * day });
    // Emergency Department.
    named({ nhi: 'ZZZ0105', service: E, kind: 'RESPONSIBLE_DOCTOR', u: 'ravi', by: 'ravi', mins: 90 });
    named({ nhi: 'ZZZ0148', service: E, kind: 'RESPONSIBLE_DOCTOR', u: 'ravi', by: 'ravi', mins: 50 });
    // Residential care: Kate is named nurse; their GP is outside SHIFT.
    for (const nhi of ['ZZZ0059', 'ZZZ0067', 'ZZZ0075', 'ZZZ0083', 'ZZZ0091']) named({ nhi, service: A, kind: 'NAMED_NURSE', u: 'kate', by: 'kate', mins: 60 * day });
    for (const nhi of ['ZZZ0059', 'ZZZ0067', 'ZZZ0075']) named({ nhi, service: A, kind: 'GP', ext: 'Dr Anna Whyte', org: 'Cornwall Medical Centre', by: 'kate', mins: 90 * day });
    named({ nhi: 'ZZZ0075', service: A, kind: 'KEY_WORKER', u: 'tama', by: 'kate', mins: 30 * day });
    named({ nhi: 'ZZZ0083', service: A, kind: 'GP', ext: 'Dr Sione Vaifale', org: 'Onehunga Pacific Health', by: 'kate', mins: 60 * 3, state: 'PROPOSED', reason: 'Losa and her family want a Tongan-speaking GP' });
    const oldGp = named({ nhi: 'ZZZ0091', service: A, kind: 'GP', ext: 'Dr Mark Tane', org: 'Epsom Medical', by: 'kate', mins: 400 * day, ended: { mins: 120 * day, reason: 'His practice closed; handed over to Dr Whyte' } });
    named({ nhi: 'ZZZ0091', service: A, kind: 'GP', ext: 'Dr Anna Whyte', org: 'Cornwall Medical Centre', by: 'kate', mins: 120 * day, replaces: oldGp });
  });
}

// Set 30: patient allocation. A second General Medicine nurse; the allocation in use now for
// each ward (replacing the day-by-day rows from set 1), and the next General Medicine shift
// drafted by Grace and waiting for another nurse to review it.
function set30(store: Store, password: string): void {
  const today = todayLocal();
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;

  let grace = who('grace');
  if (!grace) {
    grace = newWorker(store, hashPassword(password), 'grace', 'Grace', 'Tupou', 'Grace Tupou');
    store.insert('professional_authority', { id: newId(), workforce_person_id: grace, profession: 'Registered Nurse', regulator: 'Nursing Council of New Zealand', registration_number: 'SYN-RN-41502', scope: 'Registered nurse', valid_from: '2026-04-01', valid_to: '2027-03-31', status: 'CURRENT', data_source: 'SYNTHETIC' });
    const eid = newId();
    store.insert('employment', { id: eid, workforce_person_id: grace, organisation_id: 'org-hosp', employment_type: 'PERMANENT', start_date: '2025-01-13' });
    const pos = newId();
    store.insert('position', { id: pos, employment_id: eid, service_id: 'svc-genmed', title: 'Registered Nurse', role_key: 'genmed-rn', start_date: '2025-01-13' });
    for (let d = -7; d < 28; d++) {
      const date = addDays(today, d);
      if (new Date(`${date}T00:00:00`).getDay() === 0) continue;
      store.insert('roster_shift', { id: newId(), workforce_person_id: grace, position_id: pos, service_id: 'svc-genmed', shift_date: date, start_time: d % 2 ? '14:30' : '07:00', end_time: d % 2 ? '23:00' : '15:30', state: 'PLANNED', data_source: 'SYNTHETIC' });
    }
  }

  const step = (id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'allocplan', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  const nowShift = currentPeriod();
  const next = nextPeriod(nowShift.date, nowShift.period);
  interface Plan { service: string; date: string; period: string; state: 'ACTIVE' | 'SUBMITTED'; drafted: string; reviewer?: string; mins: number; lines: [string, string[]][]; note?: string }
  const plan = (x: Plan) => {
    const by = who(x.drafted);
    const reviewer = x.reviewer ? who(x.reviewer) : null;
    const staff = x.lines.map(([u]) => who(u)).filter((w): w is string => !!w);
    if (!by || staff.length !== x.lines.length) return;
    const id = newId();
    const active = x.state === 'ACTIVE';
    store.insert('allocation_plan', {
      id, service_id: x.service, shift_date: x.date, period: x.period, state: x.state, staff_json: JSON.stringify(staff.map((w) => ({ id: w, onRoster: true, reason: null }))),
      drafted_by: by, drafted_at: ago(x.mins + 60), submitted_by: by, submitted_at: ago(x.mins + 30),
      reviewed_by: active ? reviewer : null, reviewed_at: active ? ago(x.mins + 15) : null, review_note: null,
      started_by: active ? by : null, started_at: active ? ago(x.mins) : null,
    });
    step(id, null, 'DRAFT', by, ago(x.mins + 60), 'Drafted from the roster');
    step(id, 'DRAFT', 'SUBMITTED', by, ago(x.mins + 30), x.note ?? 'Submitted for review');
    if (active && reviewer) {
      step(id, 'SUBMITTED', 'CONFIRMED', reviewer, ago(x.mins + 15), 'Reviewed and confirmed');
      step(id, 'CONFIRMED', 'ACTIVE', by, ago(x.mins), 'Shift started');
    }
    x.lines.forEach(([u, nhis], i) => {
      for (const nhi of nhis) {
        const pid = person(nhi);
        if (!pid) continue;
        store.insert('allocation', { id: newId(), workforce_person_id: staff[i], person_id: pid, service_id: x.service, shift_date: x.date, created_at: ago(x.mins + 45), created_by: by, plan_id: id, state: active ? 'ACTIVE' : 'PROPOSED' });
      }
      void u;
    });
  };

  store.run("UPDATE allocation SET state = 'ENDED', ended_at = ?, end_reason = 'Replaced by allocation plans' WHERE state = 'LEGACY'", now());
  plan({ service: 'svc-genmed', date: nowShift.date, period: nowShift.period, state: 'ACTIVE', drafted: 'nicki', reviewer: 'grace', mins: 90,
    lines: [['nicki', ['ZZZ9999', 'ZZZ0016']], ['grace', ['ZZZ0024', 'ZZZ0032', 'ZZZ0040']]] });
  plan({ service: 'svc-genmed', date: next.date, period: next.period, state: 'SUBMITTED', drafted: 'grace', mins: 20,
    note: 'Peggy now needs two to help her move, so I have given Sione to Nicki to even out the load',
    lines: [['nicki', ['ZZZ9999', 'ZZZ0016', 'ZZZ0024']], ['grace', ['ZZZ0032', 'ZZZ0040']]] });
  plan({ service: 'svc-arc', date: nowShift.date, period: nowShift.period, state: 'ACTIVE', drafted: 'kate', reviewer: 'nicki', mins: 100,
    lines: [['nicki', ['ZZZ0059', 'ZZZ0067', 'ZZZ0075']], ['kate', ['ZZZ0083', 'ZZZ0091']], ['tama', ['ZZZ0059', 'ZZZ0067', 'ZZZ0075', 'ZZZ0083', 'ZZZ0091']]] });
}

// Set 31: clinical status. Each ward's recorded statuses: some better, some worse, one overdue
// for another look, and a few people with none yet.
function set31(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'acuity', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  const rank = (l: string) => LEVEL_BY_ID.get(l)!.rank;
  // Oldest first; each later one replaces the one before.
  const history = (nhi: string, service: string, entries: { u: string; level: string; mins: number; basis: string }[]) => {
    const pid = person(nhi);
    if (!pid) return;
    let prior: { id: string; level: string } | null = null;
    for (const e of entries) {
      const by = who(e.u);
      if (!by) continue;
      const id = newId();
      const change = prior === null ? 'FIRST' : rank(e.level) > rank(prior.level) ? 'WORSE' : rank(e.level) < rank(prior.level) ? 'BETTER' : 'SAME';
      const at = ago(e.mins);
      const last = e === entries[entries.length - 1];
      store.insert('acuity_assessment', {
        id, person_id: pid, service_id: service, level: e.level, basis: e.basis, evidence_json: last ? JSON.stringify(acuityEvidence(store, pid)) : null, change,
        review_due: ago(e.mins - LEVEL_BY_ID.get(e.level)!.reviewHours * 60), state: 'CURRENT', assessed_by: by, assessed_at: at, supersedes: prior?.id ?? null,
      });
      step(id, null, 'CURRENT', by, at, `${LEVEL_BY_ID.get(e.level)!.label}: ${e.basis}`);
      if (prior) {
        store.run("UPDATE acuity_assessment SET state = 'SUPERSEDED' WHERE id = ?", prior.id);
        step(prior.id, 'CURRENT', 'SUPERSEDED', by, at, 'Reassessed');
      }
      prior = { id, level: e.level };
    }
  };
  const G = 'svc-genmed';
  const A = 'svc-arc';
  const E = 'svc-ed';
  history('ZZZ9999', G, [
    { u: 'nicki', level: 'STABLE', mins: 20 * 60, basis: 'Obs within her usual, eating and walking to the bathroom' },
    { u: 'nicki', level: 'WATCH', mins: 120, basis: 'Heart rate 88, above her usual 60 to 80; says she feels "a bit off". Hourly obs for now' },
  ]);
  history('ZZZ0016', G, [
    { u: 'nicki', level: 'WATCH', mins: 14 * 60, basis: 'Confused overnight, pulling at his drip' },
    { u: 'sam', level: 'UNWELL', mins: 150, basis: 'More confused than this morning, resp rate 22, not drinking. Possible sepsis; bloods sent' },
  ]);
  history('ZZZ0024', G, [{ u: 'nicki', level: 'WATCH', mins: 11 * 60, basis: 'New admission with chest pain, settled on arrival; troponin repeat due' }]);
  history('ZZZ0032', G, [
    { u: 'hannah', level: 'UNWELL', mins: 3 * 24 * 60, basis: 'Fall with hip pain on admission, needed IV pain relief' },
    { u: 'nicki', level: 'STABLE', mins: 6 * 60, basis: 'Pain controlled, obs steady for two days, eating a little more' },
  ]);
  history('ZZZ0059', A, [{ u: 'kate', level: 'STABLE', mins: 9 * 60, basis: 'Her usual self: up for breakfast, obs normal' }]);
  history('ZZZ0067', A, [{ u: 'kate', level: 'WATCH', mins: 5 * 60, basis: 'Coughing more since yesterday, temp 37.6; GP to see tomorrow' }]);
  history('ZZZ0075', A, [
    { u: 'kate', level: 'STABLE', mins: 30 * 60, basis: 'His usual' },
    { u: 'nicki', level: 'UNWELL', mins: 90, basis: 'Drowsy and hard to rouse at lunch, sats 89% on air (usually 94%)' },
  ]);
  history('ZZZ0091', A, [{ u: 'kate', level: 'STABLE', mins: 10 * 60, basis: 'No change from his usual' }]);
  history('ZZZ0105', E, [{ u: 'ravi', level: 'UNWELL', mins: 40, basis: 'Short of breath at rest, resp rate 26; waiting for a medical bed' }]);
}

// Set 32: deterioration. Wiremu being responded to on the ward, Frank noticed by his caregiver
// and not yet escalated, Kiri escalated in ED and waiting, and Peggy's from admission, closed.
function set32(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const step = (type: string, id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: type, object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Step { kind: 'ESCALATED' | 'RESPONSE' | 'INTERVENTION' | 'REASSESSMENT' | 'OUTCOME'; u: string; mins: number; body: string; to?: string; urgency?: string; responded?: { u: string; mins: number; text: string } }
  const episode = (x: { nhi: string; service: string; u: string; mins: number; change: string; state: string; steps: Step[]; outcome?: string; note?: string }) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const closing = x.steps.find((s) => s.kind === 'OUTCOME');
    store.insert('deterioration_event', {
      id, person_id: pid, service_id: x.service, change_text: x.change, evidence_json: JSON.stringify(acuityEvidence(store, pid)), state: x.state,
      detected_by: by, detected_at: ago(x.mins), outcome: x.outcome ?? null, outcome_note: x.note ?? null,
      closed_by: closing ? who(closing.u) : null, closed_at: closing ? ago(closing.mins) : null,
    });
    step('deterioration', id, null, 'DETECTED', by, ago(x.mins), x.change);
    store.insert('deterioration_step', { id: newId(), event_id: id, kind: 'DETECTED', body: x.change, link_id: null, by_id: by, at: ago(x.mins) });
    let state = 'DETECTED';
    const move = (to: string, u: string, mins: number, reason: string) => { if (state !== to) { step('deterioration', id, state, to, u, ago(mins), reason); state = to; } };
    for (const s of x.steps) {
      const sb = who(s.u);
      if (!sb) continue;
      let link: string | null = null;
      if (s.kind === 'ESCALATED') {
        link = newId();
        const r = s.responded;
        const rb = r ? who(r.u) : null;
        store.insert('escalation', {
          id: link, person_id: pid, service_id: x.service, recipient_role_key: s.to, urgency: s.urgency, concern: 'Deterioration', trigger_text: s.body,
          state: r ? 'RESPONDED' : 'RAISED', raised_by: sb, raised_service_id: x.service, raised_at: ago(s.mins), level: 1,
          received_by: rb, acknowledged_by: rb, response: r?.text ?? null, responded_by: rb,
        });
        step('escalation', link, null, 'RAISED', sb, ago(s.mins), `${String(s.urgency).toLowerCase()} · Deterioration`);
        if (r && rb) {
          step('escalation', link, 'RAISED', 'RECEIVED', rb, ago(r.mins + 2), 'Received');
          step('escalation', link, 'RECEIVED', 'ACKNOWLEDGED', rb, ago(r.mins + 1), 'Acknowledged');
          step('escalation', link, 'ACKNOWLEDGED', 'RESPONDED', rb, ago(r.mins), r.text);
        }
        move('ESCALATED', s.u, s.mins, 'Escalated');
      }
      if (s.kind === 'RESPONSE' || s.kind === 'INTERVENTION') move('RESPONDING', s.u, s.mins, 'Response recorded');
      if (s.kind === 'REASSESSMENT') move('REASSESSED', s.u, s.mins, 'Reassessed');
      if (s.kind === 'OUTCOME') move('CLOSED', s.u, s.mins, s.body);
      store.insert('deterioration_step', { id: newId(), event_id: id, kind: s.kind, body: s.body, link_id: link, by_id: sb, at: ago(s.mins) });
    }
  };
  episode({ nhi: 'ZZZ0016', service: 'svc-genmed', u: 'nicki', mins: 240, state: 'RESPONDING',
    change: 'More confused than this morning, pulling at his drip, resp rate up to 22, not drinking',
    steps: [
      { kind: 'ESCALATED', u: 'nicki', mins: 235, to: 'genmed-physician', urgency: 'URGENT', body: 'Acutely more confused, RR 22, T 38.1, not drinking. Please review',
        responded: { u: 'sam', mins: 180, text: 'Reviewed. Possible sepsis, likely urinary. Bloods, cultures and urine sent; see plan' } },
      { kind: 'RESPONSE', u: 'sam', mins: 175, body: 'Dr Sam Patel reviewed at bedside: possible urosepsis. Bloods, cultures, urine. Review again after fluids' },
      { kind: 'INTERVENTION', u: 'nicki', mins: 160, body: 'IV fluids 1 L over 4 hours started; first dose IV antibiotics given; obs hourly' },
    ] });
  episode({ nhi: 'ZZZ0075', service: 'svc-arc', u: 'tama', mins: 100, state: 'ESCALATED',
    change: 'Drowsy and hard to wake for lunch, breathing sounds rattly',
    steps: [{ kind: 'ESCALATED', u: 'tama', mins: 98, to: 'arc-rn', urgency: 'URGENT', body: 'Frank is drowsy and hard to wake, breathing rattly. Not his usual' }] });
  episode({ nhi: 'ZZZ0067', service: 'svc-arc', u: 'kate', mins: 25, state: 'DETECTED',
    change: 'Coughing more, temp now 38.0, off her lunch', steps: [] });
  episode({ nhi: 'ZZZ0105', service: 'svc-ed', u: 'mere', mins: 35, state: 'ESCALATED',
    change: 'Short of breath at rest, resp rate 26, sats 90% on 4 L',
    steps: [{ kind: 'ESCALATED', u: 'mere', mins: 33, to: 'ed-doctor', urgency: 'IMMEDIATE', body: 'Worse since triage: RR 26, sats 90% on 4 L, speaking in short sentences' }] });
  episode({ nhi: 'ZZZ0032', service: 'svc-genmed', u: 'nicki', mins: 3 * 24 * 60 + 60, state: 'CLOSED', outcome: 'IMPROVED',
    change: 'In a lot of pain after her fall, grimacing and calling out, HR 110',
    note: 'Pain controlled with regular analgesia; obs back to her usual',
    steps: [
      { kind: 'ESCALATED', u: 'nicki', mins: 3 * 24 * 60 + 55, to: 'genmed-physician', urgency: 'URGENT', body: 'Severe hip pain after fall, HR 110, not settling with paracetamol',
        responded: { u: 'hannah', mins: 3 * 24 * 60 + 30, text: 'Reviewed. No new fracture on x-ray; IV analgesia charted' } },
      { kind: 'RESPONSE', u: 'hannah', mins: 3 * 24 * 60 + 30, body: 'Dr Hannah Li reviewed: no new fracture, pain from bruising. IV analgesia charted' },
      { kind: 'INTERVENTION', u: 'nicki', mins: 3 * 24 * 60 + 20, body: 'IV analgesia given, repositioned with pillows' },
      { kind: 'REASSESSMENT', u: 'nicki', mins: 3 * 24 * 60 - 60, body: 'Needs closer watching (better): pain 3/10, HR 88' },
      { kind: 'OUTCOME', u: 'nicki', mins: 2 * 24 * 60, body: `${DETERIORATION_OUTCOMES.IMPROVED}: Pain controlled with regular analgesia; obs back to her usual` },
    ] });
}

// Set 33: incidents. Rua's night-time fall with actions under way, a near miss for Elsie and a
// labelling near miss for James waiting for review, Wiremu's late antibiotics being
// investigated, and Bill's pressure injury from last month, closed.
function set33(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const date = (days: number) => addDays(todayLocal(), days);
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const trans = (id: string, from: string | null, to: string, by: string, at: string, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'incident', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at, reason, transaction_id: null });
  interface Inc {
    nhi: string; service: string; category: string; mins: number; place: string; what: string; immediate: string; harm: string; u: string;
    review?: { u: string; mins: number; harm: string; notify: string; notifyNote?: string; disclosure: string; disclosureNote?: string; notified?: string };
    investigate?: { u: string; mins: number; lead: string; ref?: string };
    findings?: { u: string; mins: number; text: string };
    actions?: { what: string; owner: string; due: number; done?: { u: string; mins: number; note: string } }[];
    close?: { u: string; mins: number; note: string };
  }
  const incident = (x: Inc) => {
    const pid = person(x.nhi);
    const rb = who(x.u);
    if (!pid || !rb) return;
    const id = newId();
    const steps: { kind: string; body: string; by: string; at: string }[] = [];
    let state = 'REPORTED';
    const move = (to: string, by: string, at: string, reason: string) => { trans(id, state, to, by, at, reason); state = to; };
    const fields: Record<string, unknown> = {};
    trans(id, null, 'REPORTED', rb, ago(x.mins - 20), x.what.slice(0, 200));
    steps.push({ kind: 'REPORTED', body: `${x.what} Straight away: ${x.immediate}`, by: rb, at: ago(x.mins - 20) });
    if (x.review) {
      const v = who(x.review.u)!;
      const at = ago(x.review.mins);
      Object.assign(fields, { harm: x.review.harm, notify: x.review.notify, notify_note: x.review.notifyNote ?? null, disclosure: x.review.disclosure, disclosure_note: x.review.disclosureNote ?? null, reviewed_by: v, reviewed_at: at });
      move('REVIEWED', v, at, 'Reviewed');
      steps.push({ kind: 'REVIEWED', body: `Harm: ${x.review.harm.toLowerCase().replace('_', ' ')}. Notification: ${x.review.notify.toLowerCase().replace('_', ' ')}${x.review.notifyNote ? `: ${x.review.notifyNote}` : ''}. Open disclosure: ${x.review.disclosureNote ?? x.review.disclosure.toLowerCase()}.`, by: v, at });
      if (x.review.notified) { fields.notified_at = at; steps.push({ kind: 'NOTIFIED', body: x.review.notified, by: v, at }); }
    }
    if (x.investigate) {
      const v = who(x.investigate.u)!;
      Object.assign(fields, { investigation_lead: x.investigate.lead, investigation_ref: x.investigate.ref ?? null });
      move('INVESTIGATING', v, ago(x.investigate.mins), `Led by ${x.investigate.lead}`);
      steps.push({ kind: 'INVESTIGATING', body: `Led by ${x.investigate.lead}${x.investigate.ref ? ` (reference ${x.investigate.ref})` : ''}`, by: v, at: ago(x.investigate.mins) });
    }
    if (x.findings) {
      const v = who(x.findings.u)!;
      fields.findings = x.findings.text;
      move('ACTIONS', v, ago(x.findings.mins), 'Findings recorded');
      steps.push({ kind: 'FINDINGS', body: x.findings.text, by: v, at: ago(x.findings.mins) });
    }
    if (x.close) {
      const v = who(x.close.u)!;
      Object.assign(fields, { closed_by: v, closed_at: ago(x.close.mins), close_note: x.close.note });
    }
    store.insert('incident', {
      id, person_id: pid, service_id: x.service, category: x.category, occurred_at: ago(x.mins), place: x.place, what: x.what, immediate: x.immediate,
      reported_harm: x.harm, state: 'REPORTED', reported_by: rb, reported_at: ago(x.mins - 20), ...fields,
    });
    for (const a of x.actions ?? []) {
      const by = who(x.findings!.u)!;
      const done = a.done ? who(a.done.u) : null;
      store.insert('incident_action', {
        id: newId(), incident_id: id, what: a.what, owner: a.owner, due: date(a.due), created_by: by, created_at: ago(x.findings!.mins - 5),
        done_at: a.done ? ago(a.done.mins) : null, done_by: done, done_note: a.done?.note ?? null,
      });
      steps.push({ kind: 'ACTION', body: `${a.what} (${a.owner}, due ${date(a.due)})`, by, at: ago(x.findings!.mins - 5) });
      if (a.done && done) steps.push({ kind: 'ACTION_DONE', body: `${a.what}: ${a.done.note}`, by: done, at: ago(a.done.mins) });
    }
    if (x.close) {
      const v = who(x.close.u)!;
      move('CLOSED', v, ago(x.close.mins), x.close.note);
      steps.push({ kind: 'CLOSED', body: x.close.note, by: v, at: ago(x.close.mins) });
    }
    store.run('UPDATE incident SET state = ? WHERE id = ?', state, id);
    steps.sort((a, b) => a.at.localeCompare(b.at));
    for (const st of steps) store.insert('incident_step', { id: newId(), incident_id: id, kind: st.kind, body: st.body, by_id: st.by, at: st.at });
  };
  const A = 'svc-arc';
  const G = 'svc-genmed';
  incident({ nhi: 'ZZZ0059', service: A, category: 'FALL', u: 'tama', mins: 2 * day, place: 'Beside her bed, Room 3', harm: 'MINOR',
    what: 'Found sitting on the floor beside her bed at 02:10. Said she was trying to get to the toilet. Bed alarm did not sound.',
    immediate: 'Checked for injury: small skin tear on left forearm, dressed. Full obs normal. Kate and her daughter told',
    review: { u: 'kate', mins: 2 * day - 300, harm: 'MINOR', notify: 'NOT_REQUIRED', disclosure: 'DONE', disclosureNote: 'Kate phoned her daughter Mere at 08:30 and explained what happened' },
    findings: { u: 'kate', mins: day, text: 'The bed alarm had been switched off for cleaning the day before and not switched back on. No check for this in the cleaning routine' },
    actions: [
      { what: 'Switch Rua\'s bed alarm back on and check it every night shift', owner: 'Kate Rowe', due: -1, done: { u: 'kate', mins: day - 60, note: 'Alarm on; added to the night checklist' } },
      { what: 'Add a bed alarm check to the cleaning routine for every room', owner: 'Facility manager', due: 3 },
    ] });
  incident({ nhi: 'ZZZ0067', service: A, category: 'MEDICATION', u: 'nicki', mins: 200, place: 'Medicine round, Room 5', harm: 'NEAR_MISS',
    what: 'Evening antibiotic dose drawn up for Elsie from Rua\'s supply, which had the same name and strength. Noticed before giving it.',
    immediate: 'Dose discarded, correct supply used, Kate told' });
  incident({ nhi: 'ZZZ0040', service: G, category: 'IDENTIFICATION', u: 'sam', mins: 300, place: 'Ward K', harm: 'NEAR_MISS',
    what: 'Blood tubes for James Chen were labelled with Sione Tuilagi\'s sticker. Picked up by the lab before testing.',
    immediate: 'Samples discarded and taken again with the right labels; both patients checked' });
  incident({ nhi: 'ZZZ0016', service: G, category: 'DELAY', u: 'grace', mins: 20 * 60, place: 'Ward K Bed 5', harm: 'MINOR',
    what: 'First dose of IV antibiotics for suspected sepsis given 2 hours after it was charted.',
    immediate: 'Dose given as soon as noticed; Dr Patel told; obs hourly',
    review: { u: 'nicki', mins: 18 * 60, harm: 'MINOR', notify: 'UNSURE', notifyNote: 'Asked the quality and patient safety team', disclosure: 'DONE', disclosureNote: 'Dr Patel explained the delay to Wiremu and his wife' },
    investigate: { u: 'nicki', mins: 17 * 60, lead: 'Charge Nurse Manager, Ward K', ref: 'QPS-2026-114' } });
  incident({ nhi: 'ZZZ0091', service: A, category: 'PRESSURE_INJURY', u: 'kate', mins: 28 * day, place: 'Room 9', harm: 'MODERATE',
    what: 'Stage 2 pressure injury found on his left heel at morning cares.',
    immediate: 'Heel offloaded, dressing applied, wound chart started, GP told',
    review: { u: 'nicki', mins: 28 * day - 240, harm: 'MODERATE', notify: 'NOT_REQUIRED', disclosure: 'DONE', disclosureNote: 'Kate talked with Bill and his son at the next visit' },
    findings: { u: 'nicki', mins: 25 * day, text: 'Heel boots were not on the equipment list for his room after he moved rooms; repositioning chart gaps overnight' },
    actions: [{ what: 'Carry equipment lists over when a resident moves rooms', owner: 'Kate Rowe', due: -20, done: { u: 'kate', mins: 21 * day, note: 'Added to the room move checklist' } }],
    close: { u: 'nicki', mins: 14 * day, note: 'Heel healing; room move checklist now carries equipment over' } });
}

// Set 34: deaths. Hēmi Parata, a resident in palliative care, died early this morning: verified,
// whānau and GP told, his wishes recorded, and the certificate, donation decision and release
// still to do. Ivy Clarke died on Ward K ten days ago and her stay has ended.
function set34(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const S = 'SYNTHETIC';
  const newPerson = (p: { given: string; family: string; preferred?: string; dob: string; gender: string; ethnicity: string; iwi?: string; nhi: string; service: string; location: string; kind: string; startMins: number; endMins?: number }) => {
    const id = newId();
    store.insert('person', { id, family_name: p.family, given_name: p.given, preferred_name: p.preferred ?? null, date_of_birth: p.dob, gender: p.gender, ethnicity: p.ethnicity, iwi: p.iwi ?? null, data_source: S, created_at: now() });
    store.insert('external_identifier', { id: newId(), person_id: id, system: 'NHI', value: p.nhi, verification: S, created_at: now() });
    store.insert('encounter', { id: newId(), person_id: id, service_id: p.service, location: p.location, kind: p.kind, started_at: ago(p.startMins),
      state: p.endMins ? 'ENDED' : 'ACTIVE', ended_at: p.endMins ? ago(p.endMins) : null });
    return id;
  };
  const kate = who('kate');
  const tama = who('tama');
  const hannah = who('hannah');
  const grace = who('grace');
  if (!kate || !tama || !hannah || !grace) return;
  interface Step { kind: string; body: string; by: string; mins: number }
  const write = (id: string, steps: Step[], notes: { kind: string; name: string; note: string; by: string; mins: number }[], trans: [string | null, string, string, number, string][]) => {
    for (const [from, to, by, mins, reason] of trans) {
      store.insert('state_transition', { id: newId(), object_type: 'death', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason, transaction_id: null });
    }
    for (const n of notes) store.insert('death_notification', { id: newId(), event_id: id, kind: n.kind, name: n.name, note: n.note, by_id: n.by, at: ago(n.mins) });
    for (const st of steps.sort((a, b) => b.mins - a.mins)) store.insert('death_step', { id: newId(), event_id: id, kind: st.kind, body: st.body, by_id: st.by, at: ago(st.mins) });
  };

  // Hēmi: open, in residential care.
  const hemi = newPerson({ given: 'Hēmi', family: 'Parata', dob: '1934-05-02', gender: 'Male', ethnicity: 'Māori', iwi: 'Ngāti Kahungunu', nhi: 'ZZZ0156', service: 'svc-arc', location: 'Room 12', kind: 'RESIDENTIAL', startMins: 800 * day });
  const h1 = newId();
  const hemiWishes = 'Whānau to stay with him until he leaves. Karakia by his kaumātua before he is moved. Window opened. He is to go home to his marae in Wairoa.';
  store.insert('death_event', {
    id: h1, person_id: hemi, service_id: 'svc-arc', died_at: ago(320), expected: 'EXPECTED', place: 'In his room, Room 12',
    circumstances: 'Found not breathing at the night check. Comfortable and settled an hour before. On the palliative care plan for three weeks.',
    state: 'VERIFIED', identified_by: tama, identified_at: ago(315), verified_by: kate, verified_at: ago(290),
    verify_note: 'No pulse or breath sounds for one minute, no heart sounds, pupils fixed and dilated, no response to voice or pain.', wishes: hemiWishes,
  });
  write(h1, [
    { kind: 'IDENTIFIED', body: 'Expected. Found not breathing at the night check. Comfortable and settled an hour before. On the palliative care plan for three weeks.', by: tama, mins: 315 },
    { kind: 'VERIFIED', body: 'No pulse or breath sounds for one minute, no heart sounds, pupils fixed and dilated, no response to voice or pain.', by: kate, mins: 290 },
    { kind: 'NOTIFIED', body: 'Whānau or next of kin: Rawiri Parata (son). Phoned straight away; whānau coming in.', by: kate, mins: 280 },
    { kind: 'WISHES', body: hemiWishes, by: kate, mins: 240 },
    { kind: 'NOTIFIED', body: 'Their GP: Dr Anna Kerr, Parkside Medical. Message left with the practice; she will visit this morning.', by: kate, mins: 110 },
  ], [
    { kind: 'WHANAU', name: 'Rawiri Parata (son)', note: 'Phoned straight away; whānau coming in.', by: kate, mins: 280 },
    { kind: 'GP', name: 'Dr Anna Kerr, Parkside Medical', note: 'Message left with the practice; she will visit this morning.', by: kate, mins: 110 },
  ], [[null, 'IDENTIFIED', tama, 315, 'Expected'], ['IDENTIFIED', 'VERIFIED', kate, 290, 'Verified']]);

  // Ivy: closed, ten days ago on Ward K.
  const ivy = newPerson({ given: 'Ivy', family: 'Clarke', dob: '1929-11-18', gender: 'Female', ethnicity: 'NZ European', nhi: 'ZZZ0164', service: 'svc-genmed', location: 'Ward K Bed 2', kind: 'INPATIENT', startMins: 16 * day, endMins: 10 * day - 300 });
  const i1 = newId();
  store.insert('death_event', {
    id: i1, person_id: ivy, service_id: 'svc-genmed', died_at: ago(10 * day), expected: 'EXPECTED', place: 'Ward K Bed 2',
    circumstances: 'Died peacefully with her daughter present, on the end of life care plan for pneumonia.',
    state: 'CLOSED', identified_by: grace, identified_at: ago(10 * day - 10), verified_by: grace, verified_at: ago(10 * day - 20),
    verify_note: 'No pulse or breath sounds for one minute, no heart sounds, pupils fixed and dilated.',
    cert_kind: 'CERTIFICATE', cert_by: 'Dr Hannah Li', cert_ref: null, donation: 'NOT_APPLICABLE',
    released_to: 'FUNERAL_DIRECTOR', released_name: 'Hope Funeral Services', released_at: ago(10 * day - 280), released_by: grace,
    closed_by: grace, closed_at: ago(10 * day - 300),
  });
  write(i1, [
    { kind: 'IDENTIFIED', body: 'Expected. Died peacefully with her daughter present, on the end of life care plan for pneumonia.', by: grace, mins: 10 * day - 10 },
    { kind: 'VERIFIED', body: 'No pulse or breath sounds for one minute, no heart sounds, pupils fixed and dilated.', by: grace, mins: 10 * day - 20 },
    { kind: 'NOTIFIED', body: 'Whānau or next of kin: Susan Clarke (daughter). Present when she died.', by: grace, mins: 10 * day - 25 },
    { kind: 'CERTIFIED', body: 'Medical certificate of cause of death completed by Dr Hannah Li.', by: hannah, mins: 10 * day - 120 },
    { kind: 'DONATION', body: 'Not applicable', by: grace, mins: 10 * day - 125 },
    { kind: 'NOTIFIED', body: 'Their GP: Dr Paul Singh, Eastside Health. Discharge summary sent.', by: grace, mins: 10 * day - 200 },
    { kind: 'RELEASED', body: 'Funeral director: Hope Funeral Services.', by: grace, mins: 10 * day - 280 },
    { kind: 'CLOSED', body: 'Stay ended.', by: grace, mins: 10 * day - 300 },
  ], [
    { kind: 'WHANAU', name: 'Susan Clarke (daughter)', note: 'Present when she died.', by: grace, mins: 10 * day - 25 },
    { kind: 'GP', name: 'Dr Paul Singh, Eastside Health', note: 'Discharge summary sent.', by: grace, mins: 10 * day - 200 },
  ], [[null, 'IDENTIFIED', grace, 10 * day - 10, 'Expected'], ['IDENTIFIED', 'VERIFIED', grace, 10 * day - 20, 'Verified'], ['VERIFIED', 'CLOSED', grace, 10 * day - 300, 'Stay ended']]);
}

// Set 35: clinical problems. Every .problem entry already in the record joins the problem list.
// Then: a new concern about Rua's confusion waiting to be assessed, Wiremu's chest infection
// improving but overdue a look, Peggy's falls as a working problem, and Frank's constipation,
// resolved last week.
function set35(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const date = (days: number) => addDays(todayLocal(), days);
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const trans = (id: string, from: string | null, to: string, by: string, mins: number, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'problem', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason, transaction_id: null });
  const step = (id: string, kind: string, body: string, by: string, mins: number) =>
    store.insert('problem_step', { id: newId(), problem_id: id, kind, body, by_id: by, at: ago(mins) });

  // Existing .problem entries.
  const entries = store.all<{ id: string; person_id: string; service_id: string; fields_json: string; author_id: string; recorded_at: string }>(
    "SELECT id, person_id, service_id, fields_json, author_id, recorded_at FROM clinical_event WHERE key_code = '.problem' AND state = 'CURRENT' ORDER BY recorded_at");
  for (const e of entries) {
    if (store.get('SELECT 1 FROM clinical_problem WHERE source_event_id = ?', e.id)) continue;
    const f = JSON.parse(e.fields_json) as Record<string, string>;
    if (!f.problem) continue;
    const state = f.status === 'Resolved' ? 'RESOLVED' : f.status === 'Under investigation' ? 'PROVISIONAL' : 'ACTIVE';
    const id = newId();
    store.insert('clinical_problem', {
      id, person_id: e.person_id, service_id: e.service_id, title: f.problem, state, recurrences: 0, raised_by: e.author_id, raised_at: e.recorded_at,
      assessed_by: e.author_id, assessed_at: e.recorded_at, assessment: f.note || null, source_event_id: e.id,
      closed_by: state === 'RESOLVED' ? e.author_id : null, closed_at: state === 'RESOLVED' ? e.recorded_at : null,
    });
    store.insert('state_transition', { id: newId(), object_type: 'problem', object_id: id, from_state: null, to_state: state, actor_id: e.author_id, work_context_id: null, at: e.recorded_at, reason: 'From a .problem entry', transaction_id: null });
    store.insert('problem_step', { id: newId(), problem_id: id, kind: 'ENTRY', body: [`${f.problem} (${f.status ?? 'Active'})`, f.note].filter(Boolean).join('. '), by_id: e.author_id, at: e.recorded_at });
  }
  const hannah = who('hannah');
  const aroha = person('ZZZ9999');
  const pneumonia = aroha ? store.get<{ id: string }>("SELECT id FROM clinical_problem WHERE person_id = ? AND title = 'Community-acquired pneumonia' AND state = 'ACTIVE'", aroha) : null;
  if (pneumonia && hannah) {
    store.run('UPDATE clinical_problem SET management = ?, monitoring = ?, review_due = ?, trend = ?, last_review_at = ? WHERE id = ?',
      'IV amoxicillin, switch to oral when afebrile 24 hours; chest physio', '4-hourly obs; oxygen to keep sats 92 to 96%', date(0), 'IMPROVING', ago(day), pneumonia.id);
    step(pneumonia.id, 'PLAN', 'Managing: IV amoxicillin, switch to oral when afebrile 24 hours; chest physio. Watching: 4-hourly obs; oxygen to keep sats 92 to 96%.', hannah, 2 * day - 60);
    step(pneumonia.id, 'REVIEW', 'Improving: afebrile overnight, off oxygen.', hannah, day);
  }

  interface P { nhi: string; service: string; title: string; u: string; mins: number; evidence: string; onset?: number;
    provisional?: { u: string; mins: number; note: string }; confirm?: { u: string; mins: number; note: string };
    plan?: { u: string; mins: number; management: string; monitoring: string; due: number };
    reviews?: { u: string; mins: number; trend: string; note: string }[]; resolve?: { u: string; mins: number; note: string } }
  const problem = (x: P) => {
    const pid = person(x.nhi);
    const rb = who(x.u);
    if (!pid || !rb) return;
    const id = newId();
    const pending: [string, string, string, number][] = [];
    const later = (kind: string, text: string, by: string, mins: number) => pending.push([kind, text, by, mins]);
    let state = 'CONCERN';
    const fields: Record<string, unknown> = {};
    trans(id, null, 'CONCERN', rb, x.mins, x.title);
    later('RAISED', x.evidence, rb, x.mins);
    if (x.provisional) {
      const v = who(x.provisional.u)!;
      trans(id, state, 'PROVISIONAL', v, x.provisional.mins, x.provisional.note.slice(0, 200)); state = 'PROVISIONAL';
      Object.assign(fields, { assessment: x.provisional.note, assessed_by: v, assessed_at: ago(x.provisional.mins) });
      later('PROVISIONAL', `${x.title}: ${x.provisional.note}`, v, x.provisional.mins);
    }
    if (x.confirm) {
      const v = who(x.confirm.u)!;
      trans(id, state, 'ACTIVE', v, x.confirm.mins, x.confirm.note.slice(0, 200)); state = 'ACTIVE';
      Object.assign(fields, { assessment: x.confirm.note, assessed_by: v, assessed_at: ago(x.confirm.mins) });
      later('CONFIRMED', `${x.title}: ${x.confirm.note}`, v, x.confirm.mins);
    }
    if (x.plan) {
      const v = who(x.plan.u)!;
      Object.assign(fields, { management: x.plan.management, monitoring: x.plan.monitoring, review_due: date(x.plan.due) });
      later('PLAN', `Managing: ${x.plan.management}. Watching: ${x.plan.monitoring}. Look again by ${date(x.plan.due)}.`, v, x.plan.mins);
    }
    for (const r of x.reviews ?? []) {
      Object.assign(fields, { trend: r.trend, last_review_at: ago(r.mins) });
      later('REVIEW', `${r.trend === 'IMPROVING' ? 'Improving' : r.trend === 'WORSENING' ? 'Worse' : 'Stable'}: ${r.note}`, who(r.u)!, r.mins);
    }
    if (x.resolve) {
      const v = who(x.resolve.u)!;
      trans(id, state, 'RESOLVED', v, x.resolve.mins, x.resolve.note.slice(0, 200)); state = 'RESOLVED';
      Object.assign(fields, { closed_by: v, closed_at: ago(x.resolve.mins), close_note: x.resolve.note, review_due: null });
      later('RESOLVED', x.resolve.note, v, x.resolve.mins);
    }
    store.insert('clinical_problem', {
      id, person_id: pid, service_id: x.service, title: x.title, state, onset: x.onset !== undefined ? date(x.onset) : null, recurrences: 0,
      raised_by: rb, raised_at: ago(x.mins), ...fields,
    });
    for (const [kind, text, by, mins] of pending) step(id, kind, text, by, mins);
  };
  problem({ nhi: 'ZZZ0059', service: 'svc-arc', title: 'New confusion', u: 'tama', mins: 180, onset: 0,
    evidence: 'Not recognising Mere this morning, pulling at her blanket and more drowsy than usual. Ate only a few mouthfuls of breakfast.' });
  problem({ nhi: 'ZZZ0016', service: 'svc-genmed', title: 'Chest infection with sepsis', u: 'grace', mins: 4 * day, onset: -4,
    evidence: 'Temp 38.9, resp rate 26, BP 92/58, new cough with green sputum.',
    confirm: { u: 'sam', mins: 4 * day - 60, note: 'Right lower lobe consolidation on chest X-ray; lactate 3.1. Meets the sepsis pathway.' },
    plan: { u: 'sam', mins: 4 * day - 50, management: 'IV ceftriaxone; IV fluids; oxygen to keep sats 92 to 96%', monitoring: 'Hourly obs for 12 hours then 4-hourly; fluid balance; lactate repeat', due: -1 },
    reviews: [{ u: 'sam', mins: 2 * day, trend: 'IMPROVING', note: 'Afebrile, lactate 1.4, eating again.' }] });
  problem({ nhi: 'ZZZ0032', service: 'svc-genmed', title: 'Falls: unsteady on her feet', u: 'nicki', mins: 30 * 60, onset: -10,
    evidence: 'Two near falls walking to the toilet overnight; says she has been dizzy when she stands up.',
    provisional: { u: 'grace', mins: 20 * 60, note: 'Possible postural drop: lying 138/80, standing 112/70. Checking her medicines and bloods.' } });
  problem({ nhi: 'ZZZ0075', service: 'svc-arc', title: 'Constipation', u: 'tama', mins: 14 * day, onset: -15,
    evidence: 'No bowel motion for 4 days; abdomen bloated and he is off his food.',
    confirm: { u: 'kate', mins: 14 * day - 90, note: 'Hard stool on examination; on codeine for his knee.' },
    plan: { u: 'kate', mins: 14 * day - 80, management: 'Laxatives twice daily; more fluids and fruit; GP asked to review codeine', monitoring: 'Bowel chart daily', due: -10 },
    resolve: { u: 'kate', mins: 7 * day, note: 'Bowels open daily for five days; codeine stopped by his GP.' } });
}

// Set 36: symptoms. Aroha's chest pain had paracetamol and is overdue a second look; Elsie's
// nausea was just recorded by Tama and is not yet assessed; Frank's knee pain is easing with
// regular pain relief; Wiremu's breathlessness went yesterday.
function set36(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface S { nhi: string; service: string; kind: string; site?: string; u: string; mins: number; score: number; pattern?: string; context?: string; associated?: string; onsetMins?: number;
    steps: { kind: string; body: string; u: string; mins: number; score?: number }[]; state: string; assessment?: { u: string; mins: number; note: string };
    reassessInMins?: number; close?: { u: string; mins: number; outcome: string; note?: string } }
  const symptom = (x: S) => {
    const pid = person(x.nhi);
    const rb = who(x.u);
    if (!pid || !rb) return;
    const id = newId();
    store.insert('symptom', {
      id, person_id: pid, service_id: x.service, kind: x.kind, site: x.site ?? null, context: x.context ?? null, pattern: x.pattern ?? null, associated: x.associated ?? null,
      onset: x.onsetMins !== undefined ? ago(x.onsetMins) : null, state: x.state, recorded_by: rb, recorded_at: ago(x.mins),
      assessment: x.assessment?.note ?? null, assessed_by: x.assessment ? who(x.assessment.u) : null, assessed_at: x.assessment ? ago(x.assessment.mins) : null,
      reassess_due: x.reassessInMins !== undefined ? new Date(Date.now() + x.reassessInMins * 60_000).toISOString() : null,
      outcome: x.close?.outcome ?? null, outcome_note: x.close?.note ?? null, closed_by: x.close ? who(x.close.u) : null, closed_at: x.close ? ago(x.close.mins) : null,
    });
    store.insert('symptom_score', { id: newId(), symptom_id: id, score: x.score, rated_by: 'SELF', by_id: rb, at: ago(x.mins) });
    const path: [string, number, string][] = [['RECORDED', x.mins, rb]];
    for (const st of x.steps) {
      const by = who(st.u)!;
      store.insert('symptom_step', { id: newId(), symptom_id: id, kind: st.kind, body: st.body, by_id: by, at: ago(st.mins) });
      if (st.score !== undefined) store.insert('symptom_score', { id: newId(), symptom_id: id, score: st.score, rated_by: 'SELF', by_id: by, at: ago(st.mins) });
      if (st.kind !== 'RECORDED' && path[path.length - 1][0] !== st.kind) path.push([st.kind, st.mins, by]);
    }
    let from: string | null = null;
    for (const [to, mins, by] of path) {
      store.insert('state_transition', { id: newId(), object_type: 'symptom', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
      from = to;
    }
  };
  symptom({ nhi: 'ZZZ9999', service: 'svc-genmed', kind: 'PAIN', site: 'Right side of chest', u: 'nicki', mins: 150, score: 6, pattern: 'COMES_AND_GOES',
    context: 'Deep breaths and coughing', onsetMins: 2 * 24 * 60, state: 'INTERVENTION', reassessInMins: -30,
    assessment: { u: 'hannah', mins: 130, note: 'Pleuritic pain from her pneumonia. No new signs; sats unchanged.' },
    steps: [
      { kind: 'RECORDED', body: 'Right side of chest: 6/10 (their own rating). Comes and goes. Brought on by: deep breaths and coughing.', u: 'nicki', mins: 150 },
      { kind: 'ASSESSED', body: 'Pleuritic pain from her pneumonia. No new signs; sats unchanged.', u: 'hannah', mins: 130 },
      { kind: 'INTERVENTION', body: 'Paracetamol 1 g as charted; sitting upright with a pillow to hug when coughing. Look again in 60 minutes.', u: 'nicki', mins: 90 },
    ] });
  symptom({ nhi: 'ZZZ0067', service: 'svc-arc', kind: 'NAUSEA', u: 'tama', mins: 40, score: 5, pattern: 'AFTER_FOOD', associated: 'Vomited once after lunch',
    state: 'RECORDED', steps: [{ kind: 'RECORDED', body: 'Nausea or vomiting: 5/10 (their own rating). After eating. Also: vomited once after lunch.', u: 'tama', mins: 40 }] });
  symptom({ nhi: 'ZZZ0075', service: 'svc-arc', kind: 'PAIN', site: 'Left knee', u: 'tama', mins: 26 * 60, score: 7, pattern: 'ON_MOVEMENT', context: 'Standing and walking',
    onsetMins: 30 * 24 * 60, state: 'REASSESSED', assessment: { u: 'kate', mins: 25 * 60, note: 'Osteoarthritis flare; no heat or swelling. GP stopped codeine, so regular paracetamol and a heat pack.' },
    steps: [
      { kind: 'RECORDED', body: 'Left knee: 7/10 (their own rating). When moving. Brought on by: standing and walking.', u: 'tama', mins: 26 * 60 },
      { kind: 'ASSESSED', body: 'Osteoarthritis flare; no heat or swelling. GP stopped codeine, so regular paracetamol and a heat pack.', u: 'kate', mins: 25 * 60 },
      { kind: 'INTERVENTION', body: 'Paracetamol 1 g; heat pack 20 minutes before his walk. Look again in 120 minutes.', u: 'kate', mins: 24 * 60 },
      { kind: 'REASSESSED', body: '4/10 (was 7). Walked to the lounge with his frame.', u: 'tama', mins: 22 * 60, score: 4 },
      { kind: 'REASSESSED', body: '3/10 (was 4). Comfortable this morning.', u: 'tama', mins: 3 * 60, score: 3 },
    ] });
  symptom({ nhi: 'ZZZ0016', service: 'svc-genmed', kind: 'BREATHLESSNESS', u: 'grace', mins: 3 * 24 * 60, score: 8, pattern: 'CONSTANT', associated: 'Productive cough',
    state: 'CLOSED', assessment: { u: 'sam', mins: 3 * 24 * 60 - 30, note: 'From his chest infection; oxygen as charted.' },
    close: { u: 'grace', mins: 24 * 60, outcome: 'RESOLVED', note: 'Off oxygen, walking the corridor without stopping' },
    steps: [
      { kind: 'RECORDED', body: 'Breathlessness: 8/10 (their own rating). All the time. Also: productive cough.', u: 'grace', mins: 3 * 24 * 60 },
      { kind: 'ASSESSED', body: 'From his chest infection; oxygen as charted.', u: 'sam', mins: 3 * 24 * 60 - 30 },
      { kind: 'INTERVENTION', body: 'Oxygen 2 L by nasal prongs; sitting up. Look again in 60 minutes.', u: 'grace', mins: 3 * 24 * 60 - 20 },
      { kind: 'REASSESSED', body: '5/10 (was 8).', u: 'grace', mins: 3 * 24 * 60 - 80, score: 5 },
      { kind: 'REASSESSED', body: '1/10 (was 5). Off oxygen.', u: 'grace', mins: 24 * 60 + 30, score: 1 },
      { kind: 'CLOSED', body: 'Gone: off oxygen, walking the corridor without stopping', u: 'grace', mins: 24 * 60 },
    ] });
}

// Set 37: interventions. Aroha's breathing exercises for her pneumonia are overdue; Sione's
// urinary catheter is waiting for a doctor to authorise it; Rua's two-hourly toileting round
// for her confusion is under way; Frank's heat pack for his knee is due a review; Wiremu's
// oxygen was stopped yesterday.
function set37(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface I { nhi: string; service: string; category: string; what: string; u: string; mins: number; frequency: string; everyHours?: number;
    problem?: string; symptom?: string; purpose?: string; state: string; authorised?: { u: string; mins: number; note?: string };
    done?: { u: string; mins: number; note?: string; response?: string }[]; reviewDue?: number; ceased?: { u: string; mins: number; note: string } }
  const intervention = (x: I) => {
    const pid = person(x.nhi);
    const pb = who(x.u);
    if (!pid || !pb) return;
    const problemId = x.problem ? store.get<{ id: string }>('SELECT id FROM clinical_problem WHERE person_id = ? AND title = ? ORDER BY raised_at DESC', pid, x.problem)?.id ?? null : null;
    const symptomId = x.symptom ? store.get<{ id: string }>("SELECT id FROM symptom WHERE person_id = ? AND kind = ? AND state != 'CLOSED' ORDER BY recorded_at DESC", pid, x.symptom)?.id ?? null : null;
    const id = newId();
    const lastDone = x.done?.length ? Math.min(...x.done.map((d) => d.mins)) : null;
    const hours = x.frequency === 'DAILY' ? 24 : x.everyHours ?? 0;
    const nextDue = x.state !== 'ACTIVE' || x.frequency === 'AS_NEEDED' ? null : lastDone === null ? ago(x.mins) : x.frequency === 'ONCE' ? null : ago(lastDone - hours * 60);
    store.insert('intervention', {
      id, person_id: pid, service_id: x.service, category: x.category, what: x.what, purpose: x.purpose ?? null, problem_id: problemId, symptom_id: symptomId,
      frequency: x.frequency, every_hours: x.everyHours ?? null, state: x.state, start_at: ago(x.mins), next_due: nextDue,
      review_due: x.reviewDue !== undefined ? addDays(todayLocal(), x.reviewDue) : null, last_done_at: lastDone !== null ? ago(lastDone) : null,
      planned_by: pb, planned_at: ago(x.mins), authorised_by: x.authorised ? who(x.authorised.u) : null, authorised_at: x.authorised ? ago(x.authorised.mins) : null,
      auth_note: x.authorised?.note ?? null, ceased_by: x.ceased ? who(x.ceased.u) : null, ceased_at: x.ceased ? ago(x.ceased.mins) : null, cease_note: x.ceased?.note ?? null,
    });
    const freq = x.frequency === 'HOURS' ? `Every ${x.everyHours} hours` : x.frequency === 'DAILY' ? 'Once a day' : x.frequency === 'ONCE' ? 'Once' : 'When needed';
    const steps: [string, string, string, number][] = [['PLANNED', `${x.what}. ${freq}.`, pb, x.mins]];
    const trans: [string | null, string, string, number][] = [[null, x.authorised || x.state === 'AWAITING_AUTHORISATION' ? 'AWAITING_AUTHORISATION' : 'ACTIVE', pb, x.mins]];
    if (x.authorised) { steps.push(['AUTHORISED', x.authorised.note ?? 'Authorised.', who(x.authorised.u)!, x.authorised.mins]); trans.push(['AWAITING_AUTHORISATION', 'ACTIVE', who(x.authorised.u)!, x.authorised.mins]); }
    for (const d of x.done ?? []) {
      const by = who(d.u)!;
      store.insert('intervention_delivery', { id: newId(), intervention_id: id, done: 1, note: d.note ?? null, response: d.response ?? null, by_id: by, at: ago(d.mins) });
      steps.push(['DONE', [d.note, d.response ? `Response: ${d.response}` : ''].filter(Boolean).join(' ') || 'Done.', by, d.mins]);
    }
    if (x.ceased) { steps.push(['CEASED', x.ceased.note, who(x.ceased.u)!, x.ceased.mins]); trans.push([trans[trans.length - 1][1], 'CEASED', who(x.ceased.u)!, x.ceased.mins]); }
    for (const [kind, body, by, mins] of steps.sort((a, b) => b[3] - a[3])) store.insert('intervention_step', { id: newId(), intervention_id: id, kind, body, by_id: by, at: ago(mins) });
    for (const [from, to, by, mins] of trans) store.insert('state_transition', { id: newId(), object_type: 'intervention', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
  };
  intervention({ nhi: 'ZZZ9999', service: 'svc-genmed', category: 'NURSING', what: 'Deep breathing and coughing exercises, 10 breaths', u: 'nicki', mins: day, frequency: 'HOURS', everyHours: 2,
    problem: 'Community-acquired pneumonia', state: 'ACTIVE', reviewDue: 1,
    done: [{ u: 'nicki', mins: 6 * 60, response: 'Coughed up green sputum' }, { u: 'nicki', mins: 150, response: 'Less sputum; sats 94%' }] });
  intervention({ nhi: 'ZZZ0024', service: 'svc-genmed', category: 'DEVICE', what: 'Urinary catheter for retention', u: 'grace', mins: 50, frequency: 'ONCE',
    purpose: 'Not passed urine for 9 hours; bladder scan 780 mL', state: 'AWAITING_AUTHORISATION' });
  intervention({ nhi: 'ZZZ0059', service: 'svc-arc', category: 'NURSING', what: 'Toileting round, offer the toilet and a drink', u: 'kate', mins: 8 * 60, frequency: 'HOURS', everyHours: 2,
    problem: 'New confusion', state: 'ACTIVE',
    done: [{ u: 'tama', mins: 6 * 60 }, { u: 'tama', mins: 4 * 60, response: 'Passed urine; drank half a cup of tea' }, { u: 'tama', mins: 100 }] });
  intervention({ nhi: 'ZZZ0075', service: 'svc-arc', category: 'COMFORT', what: 'Heat pack on his left knee for 20 minutes before walking', u: 'kate', mins: 24 * 60, frequency: 'DAILY',
    symptom: 'PAIN', state: 'ACTIVE', reviewDue: 0, done: [{ u: 'tama', mins: 23 * 60, response: 'Walked to the lounge more easily' }, { u: 'tama', mins: 5 * 60 }] });
  intervention({ nhi: 'ZZZ0016', service: 'svc-genmed', category: 'NURSING', what: 'Oxygen 2 L by nasal prongs, keep sats 92 to 96%', u: 'grace', mins: 4 * day, frequency: 'AS_NEEDED',
    problem: 'Chest infection with sepsis', state: 'CEASED', ceased: { u: 'grace', mins: day, note: 'Sats 95% on air for 24 hours' } });
}

// Treatment plans (Shared Lifecycle Object 277): Aroha's pneumonia plan under way and slower than
// hoped, with its review due today; Peggy's falls plan waiting for a doctor to agree it; Rua's
// confusion plan waiting in residential care, where no-one can agree it (RR-TP-002); and
// Wiremu's sepsis plan completed.
function set38(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface O { what: string; benefits?: string; risks?: string }
  interface C { kind: string; what: string; service: string; intervention?: string }
  interface P { nhi: string; service: string; problem: string; goal: string; u: string; mins: number; options: O[]; state: string;
    proposed?: { option: number; u: string; mins: number };
    agreed?: { option: number; u: string; mins: number; with: string; note?: string };
    components?: C[]; startedMins?: number; reviewDue?: number; progress?: { u: string; mins: number; progress: string; note: string }[];
    ended?: { u: string; mins: number; note: string } }
  const plan = (x: P) => {
    const pid = person(x.nhi);
    const cb = who(x.u);
    if (!pid || !cb) return;
    const problemId = store.get<{ id: string }>('SELECT id FROM clinical_problem WHERE person_id = ? AND title = ? ORDER BY raised_at DESC', pid, x.problem)?.id ?? null;
    const id = newId();
    const optionIds = x.options.map(() => newId());
    store.insert('treatment_plan', {
      id, person_id: pid, service_id: x.service, need: problemId ? null : x.problem, problem_id: problemId, goal: x.goal, state: x.state,
      chosen_option_id: x.agreed ? optionIds[x.agreed.option] : null, proposed_option_id: x.proposed && !x.agreed ? optionIds[x.proposed.option] : null, version: 1,
      agreed_with: x.agreed?.with ?? null, agreement_note: x.agreed?.note ?? null, authorised_by: x.agreed ? who(x.agreed.u) : null, authorised_at: x.agreed ? ago(x.agreed.mins) : null,
      started_at: x.startedMins !== undefined ? ago(x.startedMins) : null, review_due: x.reviewDue !== undefined ? addDays(todayLocal(), x.reviewDue) : null,
      created_by: cb, created_at: ago(x.mins), ended_by: x.ended ? who(x.ended.u) : null, ended_at: x.ended ? ago(x.ended.mins) : null, end_note: x.ended?.note ?? null,
    });
    const steps: [string, string, string, number][] = [['NEED', `${x.problem}. Goal: ${x.goal}`, cb, x.mins]];
    const trans: [string | null, string, string, number][] = [[null, 'DRAFT', cb, x.mins]];
    x.options.forEach((o, i) => {
      store.insert('treatment_option', { id: optionIds[i], plan_id: id, what: o.what, benefits: o.benefits ?? null, risks: o.risks ?? null, added_by: cb, added_at: ago(x.mins - 1 - i) });
      steps.push(['OPTION', [o.what, o.benefits ? `Benefits: ${o.benefits}` : '', o.risks ? `Risks: ${o.risks}` : ''].filter(Boolean).join('. '), cb, x.mins - 1 - i]);
    });
    if (x.proposed) {
      steps.push(['PROPOSED', `${x.options[x.proposed.option].what}. Waiting for a doctor or therapist to agree it with the person.`, who(x.proposed.u)!, x.proposed.mins]);
      trans.push(['DRAFT', 'AWAITING_AGREEMENT', who(x.proposed.u)!, x.proposed.mins]);
    }
    if (x.agreed) {
      const labels: Record<string, string> = { PATIENT: 'the person themselves', WHANAU: 'the person, with their whānau', EPOA: 'their EPOA or welfare guardian' };
      steps.push(['AGREED', `${x.options[x.agreed.option].what}. Agreed with ${labels[x.agreed.with]}.${x.agreed.note ? ` ${x.agreed.note}` : ''}`, who(x.agreed.u)!, x.agreed.mins]);
      trans.push([trans[trans.length - 1][1], 'AGREED', who(x.agreed.u)!, x.agreed.mins]);
    }
    const names = store.all<{ id: string; name: string }>('SELECT id, name FROM service');
    for (const [i, c] of (x.components ?? []).entries()) {
      const interventionId = c.intervention ? store.get<{ id: string }>('SELECT id FROM intervention WHERE person_id = ? AND what = ?', pid, c.intervention)?.id ?? null : null;
      const at = (x.agreed?.mins ?? x.mins) - 1 - i;
      const cs = x.state === 'COMPLETED' ? 'DONE' : x.startedMins !== undefined ? 'UNDER_WAY' : 'PLANNED';
      store.insert('treatment_component', { id: newId(), plan_id: id, kind: c.kind, what: c.what, service_id: c.service, intervention_id: interventionId, state: cs,
        note: null, added_by: cb, added_at: ago(at), updated_by: null, updated_at: null });
      const kinds: Record<string, string> = { INTERVENTION: 'Intervention', MEDICINE: 'Medicine', THERAPY: 'Therapy', TEST: 'Test or investigation' };
      steps.push(['COMPONENT', `${kinds[c.kind]}: ${c.what}. Responsible: ${names.find((n) => n.id === c.service)?.name}.`, cb, at]);
    }
    if (x.startedMins !== undefined) {
      steps.push(['STARTED', 'Started.', cb, x.startedMins]);
      trans.push(['AGREED', 'ACTIVE', cb, x.startedMins]);
    }
    for (const g of x.progress ?? []) {
      const labels: Record<string, string> = { ON_TRACK: 'Going to plan', SLOWER: 'Slower than hoped', NOT_WORKING: 'Not working' };
      store.insert('treatment_progress', { id: newId(), plan_id: id, progress: g.progress, note: g.note, by_id: who(g.u)!, at: ago(g.mins) });
      steps.push(['PROGRESS', `${labels[g.progress]}: ${g.note}`, who(g.u)!, g.mins]);
    }
    if (x.ended) {
      steps.push([x.state, x.ended.note, who(x.ended.u)!, x.ended.mins]);
      trans.push(['ACTIVE', x.state, who(x.ended.u)!, x.ended.mins]);
    }
    for (const [kind, body, by, mins] of steps) store.insert('treatment_step', { id: newId(), plan_id: id, kind, body, by_id: by, at: ago(mins) });
    for (const [from, to, by, mins] of trans) store.insert('state_transition', { id: newId(), object_type: 'treatment_plan', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
  };
  plan({ nhi: 'ZZZ9999', service: 'svc-genmed', problem: 'Community-acquired pneumonia', goal: 'Chest clear, off oxygen and walking the corridor, ready to go home', u: 'hannah', mins: day + 60,
    options: [
      { what: 'Oral antibiotics, chest physiotherapy and breathing exercises', benefits: 'Can stay mobile; no drip', risks: 'Slower if the infection is resistant' },
      { what: 'Intravenous antibiotics', benefits: 'Works faster in severe infection', risks: 'Drip site infection; stays in bed more' },
    ],
    state: 'ACTIVE', agreed: { option: 0, u: 'hannah', mins: day + 50, with: 'PATIENT', note: 'Aroha prefers tablets and wants to keep walking.' },
    components: [
      { kind: 'INTERVENTION', what: 'Deep breathing and coughing exercises, 10 breaths', service: 'svc-genmed', intervention: 'Deep breathing and coughing exercises, 10 breaths' },
      { kind: 'MEDICINE', what: 'Amoxicillin by mouth for 5 days (prescribed in her medicines)', service: 'svc-genmed' },
      { kind: 'THERAPY', what: 'Chest physiotherapy and walking practice twice a day', service: 'svc-physio' },
    ],
    startedMins: day + 40, reviewDue: 0,
    progress: [
      { u: 'lena', mins: 20 * 60, progress: 'ON_TRACK', note: 'Walked 20 metres with a frame; productive cough.' },
      { u: 'nicki', mins: 3 * 60, progress: 'SLOWER', note: 'Still needing 2 L oxygen overnight; tired after walking to the bathroom.' },
    ] });
  plan({ nhi: 'ZZZ0032', service: 'svc-genmed', problem: 'Falls: unsteady on her feet', goal: 'Walking safely to the toilet with a frame, with no more falls', u: 'nicki', mins: 5 * 60,
    options: [
      { what: 'Strength and balance programme with physiotherapy, and stop the night-time sedative', benefits: 'Treats the causes; she keeps her independence', risks: 'May sleep less well at first' },
      { what: 'Walking frame and supervision only', benefits: 'Simple to start today', risks: 'Does not treat the weakness or the sedative' },
    ],
    state: 'AWAITING_AGREEMENT', proposed: { option: 0, u: 'nicki', mins: 4 * 60 },
    components: [
      { kind: 'THERAPY', what: 'Strength and balance exercises every morning', service: 'svc-physio' },
      { kind: 'MEDICINE', what: 'Stop the night-time sedative (change in her medicines)', service: 'svc-genmed' },
    ] });
  plan({ nhi: 'ZZZ0059', service: 'svc-arc', problem: 'New confusion', goal: 'Back to her usual self: knows where she is and sleeping at night', u: 'kate', mins: 150,
    options: [
      { what: 'Look for and treat the cause here: urine test, fluids, toileting round and a GP review', benefits: 'Stays in familiar surroundings with her whānau', risks: 'Slower to find a serious cause' },
      { what: 'Transfer to hospital for assessment', benefits: 'Quick access to tests', risks: 'Moving often makes confusion worse' },
    ],
    state: 'AWAITING_AGREEMENT', proposed: { option: 0, u: 'kate', mins: 140 },
    components: [
      { kind: 'INTERVENTION', what: 'Toileting round, offer the toilet and a drink', service: 'svc-arc', intervention: 'Toileting round, offer the toilet and a drink' },
      { kind: 'TEST', what: 'Urine dipstick and send a sample', service: 'svc-arc' },
    ] });
  plan({ nhi: 'ZZZ0016', service: 'svc-genmed', problem: 'Chest infection with sepsis', goal: 'Infection treated, eating and walking, back to his usual breathing', u: 'hannah', mins: 5 * day,
    options: [{ what: 'Intravenous antibiotics then tablets, oxygen and fluids', benefits: 'Standard sepsis treatment', risks: 'Drip site problems' }],
    state: 'COMPLETED', agreed: { option: 0, u: 'hannah', mins: 5 * day - 20, with: 'WHANAU', note: 'Discussed with Wiremu and his son.' },
    components: [
      { kind: 'MEDICINE', what: 'Intravenous antibiotics, changing to tablets when improving', service: 'svc-genmed' },
      { kind: 'INTERVENTION', what: 'Oxygen 2 L by nasal prongs, keep sats 92 to 96%', service: 'svc-genmed', intervention: 'Oxygen 2 L by nasal prongs, keep sats 92 to 96%' },
    ],
    startedMins: 5 * day - 30,
    progress: [{ u: 'grace', mins: 2 * day, progress: 'ON_TRACK', note: 'Fever settled; eating half his meals.' }],
    ended: { u: 'hannah', mins: day - 60, note: 'Goal met: on air, eating and walking the corridor.' } });
}

// Clinical pathways (Shared Lifecycle Object 278): Peggy on the after-a-fall pathway with the
// doctor told late and telling her whānau now overdue; Rua on the new-confusion pathway with a
// step deferred; Frank's fall suggesting the pathway, not yet started; Wiremu's sepsis
// pathway completed.
function set39(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const defs: Record<string, { id: string; label: string; dueMins: number; optional?: boolean }[]> = {
    POST_FALL: [
      { id: 'injury', label: 'Check for injury before moving them', dueMins: 0 }, { id: 'obs', label: 'Observations after the fall', dueMins: 30 },
      { id: 'doctor', label: 'Tell the doctor, nurse practitioner or GP', dueMins: 60 }, { id: 'whanau', label: 'Tell their whānau or next of kin', dueMins: 240, optional: true },
      { id: 'incident', label: 'Report the fall as an incident', dueMins: 24 * 60 }, { id: 'risk', label: 'Review their falls risk and care plan', dueMins: 24 * 60 },
    ],
    SEPSIS: [
      { id: 'senior', label: 'Senior clinician review', dueMins: 30 }, { id: 'bloods', label: 'Blood tests, including cultures', dueMins: 60 },
      { id: 'antibiotics', label: 'Antibiotics as prescribed', dueMins: 60 }, { id: 'fluids', label: 'Fluids as prescribed', dueMins: 60, optional: true },
      { id: 'monitor', label: 'Closer observation plan in place', dueMins: 60 }, { id: 'review', label: 'Review response to treatment', dueMins: 6 * 60 },
    ],
    DELIRIUM: [
      { id: 'screen', label: 'Confusion screen', dueMins: 2 * 60 }, { id: 'whanau', label: 'Ask whānau what is usual for them', dueMins: 4 * 60 },
      { id: 'causes', label: 'Look for causes: infection, pain, constipation, fluids', dueMins: 8 * 60 }, { id: 'meds', label: 'Medicines review', dueMins: 24 * 60 },
      { id: 'comfort', label: 'Comfort, orientation and sleep measures in the care plan', dueMins: 24 * 60 },
      { id: 'review', label: 'Review whether the confusion is settling', dueMins: 48 * 60 },
    ],
  };
  const LOGS: Record<string, string> = { DONE: 'DONE', SKIPPED: 'SKIPPED', NOT_APPLICABLE: 'NOT_APPLICABLE', DEFERRED: 'DEFERRED' };
  interface S { state: string; u: string; mins: number; note?: string; deferTo?: number }
  interface P { nhi: string; service: string; pathway: string; state: string; u: string; mins: number; eligibility?: boolean[]; trigger?: string;
    steps?: Record<string, S>; deviations?: { step?: string; kind: string; note: string; u: string; mins: number }[]; ended?: { u: string; mins: number; note?: string } }
  const pathway = (x: P) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const suggested = x.state === 'SUGGESTED';
    store.insert('pathway_instance', {
      id, person_id: pid, service_id: x.service, pathway_id: x.pathway, state: x.state, trigger_text: x.trigger ?? null, trigger_event_id: null,
      eligibility_json: x.eligibility ? JSON.stringify(x.eligibility) : null, suggested_by: suggested ? by : null, suggested_at: suggested ? ago(x.mins) : null,
      started_by: suggested ? null : by, started_at: suggested ? null : ago(x.mins), ended_by: x.ended ? who(x.ended.u) : null, ended_at: x.ended ? ago(x.ended.mins) : null,
      exit_reason: null, end_note: x.ended?.note ?? null,
    });
    const logs: [string, string, string, number][] = [[suggested ? 'SUGGESTED' : 'STARTED', suggested ? `Suggested by a .fall entry: ${x.trigger}` : `${x.trigger ?? ''}`.trim() || 'Started.', by, x.mins]];
    const trans: [string | null, string, string, number][] = [[null, suggested ? 'SUGGESTED' : 'ACTIVE', by, x.mins]];
    const stepIds: Record<string, string> = {};
    if (!suggested) {
      defs[x.pathway].forEach((d, i) => {
        const st = x.steps?.[d.id];
        const sid = newId();
        stepIds[d.id] = sid;
        const due = st?.deferTo !== undefined ? ago(-st.deferTo) : ago(x.mins - d.dueMins);
        store.insert('pathway_step', { id: sid, instance_id: id, step_key: d.id, label: d.label, seq: i, optional: d.optional ? 1 : 0, due_at: due,
          state: st?.state ?? 'PENDING', note: st?.note ?? null, by_id: st ? who(st.u) : null, at: st ? ago(st.mins) : null });
        if (st) logs.push([LOGS[st.state], `${d.label}.${st.note ? ` ${st.note}` : ''}`, who(st.u)!, st.mins]);
      });
    }
    for (const d of x.deviations ?? []) {
      const labels: Record<string, string> = { LATE: 'Step done late', SKIPPED: 'Step skipped', DEFERRED: 'Step deferred' };
      store.insert('pathway_deviation', { id: newId(), instance_id: id, step_id: d.step ? stepIds[d.step] : null, kind: d.kind, note: d.note, escalation_id: null, by_id: who(d.u)!, at: ago(d.mins) });
      logs.push(['DEVIATION', `${labels[d.kind]}: ${d.note}`, who(d.u)!, d.mins]);
    }
    if (x.ended) { logs.push(['COMPLETED', x.ended.note ?? 'Every step recorded.', who(x.ended.u)!, x.ended.mins]); trans.push(['ACTIVE', x.state, who(x.ended.u)!, x.ended.mins]); }
    for (const [kind, body, b, mins] of logs.sort((a, c) => c[3] - a[3])) store.insert('pathway_log', { id: newId(), instance_id: id, kind, body, by_id: b, at: ago(mins) });
    for (const [from, to, b, mins] of trans) store.insert('state_transition', { id: newId(), object_type: 'pathway', object_id: id, from_state: from, to_state: to, actor_id: b, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
  };
  pathway({ nhi: 'ZZZ0032', service: 'svc-genmed', pathway: 'POST_FALL', state: 'ACTIVE', u: 'nicki', mins: 5 * 60, eligibility: [true],
    trigger: 'Found sitting on the floor by her bed; says she slipped getting up to the toilet.',
    steps: {
      injury: { state: 'DONE', u: 'nicki', mins: 5 * 60 - 5, note: 'Bruise on her right hip; moving all limbs; no head strike.' },
      obs: { state: 'DONE', u: 'nicki', mins: 5 * 60 - 25, note: 'Within her usual range.' },
      doctor: { state: 'DONE', u: 'nicki', mins: 3 * 60, note: 'Dr Sam Patel told; will review on the ward round.' },
    },
    deviations: [{ step: 'doctor', kind: 'LATE', note: 'Tell the doctor, nurse practitioner or GP: done 60 minutes after it was due. Registrar was at a cardiac arrest.', u: 'nicki', mins: 3 * 60 }] });
  pathway({ nhi: 'ZZZ0059', service: 'svc-arc', pathway: 'DELIRIUM', state: 'ACTIVE', u: 'kate', mins: 3 * 60, eligibility: [true, true],
    trigger: 'More muddled since yesterday; not sure where she is.',
    steps: {
      screen: { state: 'DONE', u: 'kate', mins: 2 * 60, note: 'Screen positive: inattentive and disorganised thinking.' },
      whanau: { state: 'DEFERRED', u: 'kate', mins: 50, note: 'Daughter not answering; try again after work hours.', deferTo: 3 * 60 },
    },
    deviations: [{ step: 'whanau', kind: 'DEFERRED', note: 'Ask whānau what is usual for them: Daughter not answering; try again after work hours.', u: 'kate', mins: 50 }] });
  pathway({ nhi: 'ZZZ0075', service: 'svc-arc', pathway: 'POST_FALL', state: 'SUGGESTED', u: 'tama', mins: 40,
    trigger: 'Found on the floor beside his bed; says he was reaching for his glasses.' });
  pathway({ nhi: 'ZZZ0016', service: 'svc-genmed', pathway: 'SEPSIS', state: 'COMPLETED', u: 'grace', mins: 4 * 24 * 60, eligibility: [true, true],
    trigger: 'Fever, fast breathing and new confusion with a chest infection.',
    steps: {
      senior: { state: 'DONE', u: 'hannah', mins: 4 * 24 * 60 - 20 }, bloods: { state: 'DONE', u: 'grace', mins: 4 * 24 * 60 - 40 },
      antibiotics: { state: 'DONE', u: 'grace', mins: 4 * 24 * 60 - 50 }, fluids: { state: 'NOT_APPLICABLE', u: 'hannah', mins: 4 * 24 * 60 - 20, note: 'Blood pressure normal; drinking well.' },
      monitor: { state: 'DONE', u: 'grace', mins: 4 * 24 * 60 - 55 }, review: { state: 'DONE', u: 'hannah', mins: 4 * 24 * 60 - 6 * 60, note: 'Fever settling.' },
    },
    ended: { u: 'hannah', mins: 4 * 24 * 60 - 6 * 60 } });
}

// Checklists (the checklist lifecycle under Shared Lifecycle Object 278): Peggy's bedside
// safety check with an open exception (a bed brake that will not lock); Aroha's admission
// checklist completed with one exception fixed; Tom's before-transfer checklist in the ED,
// overdue; Rua's bedside safety check not started.
function set40(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const defs: Record<string, { label: string; dueMins: number; items: [string, string, string | null][] }> = {
    SAFETY_ROUND: { label: 'Bedside safety check', dueMins: 120, items: [
      ['bell', 'Call bell within reach and working', null], ['bed', 'Bed at its lowest height with the brakes on', null], ['aid', 'Walking aid within reach', null],
      ['floor', 'Floor clear and dry', null], ['drink', 'Drink within reach', null], ['band', 'Identity band on and correct', null]] },
    ADMISSION: { label: 'Admission checklist', dueMins: 24 * 60, items: [
      ['identity', 'Identity checked with the person and band on', null], ['allergies', 'Allergies checked with the person', 'What they said'],
      ['medicines', 'Medicines list taken', 'Where from, e.g. GP list, own supply'], ['contact', 'Whānau or contact person recorded', null],
      ['falls', 'Falls risk assessed', null], ['skin', 'Skin and pressure injury risk assessed', null], ['belongings', 'Belongings and valuables listed', null]] },
    TRANSFER_OUT: { label: 'Before transfer', dueMins: 60, items: [
      ['handover', 'Handover given to the receiving team', 'Who took the handover'], ['meds', 'Medicines chart and own medicines go with them', null],
      ['belongings', 'Belongings packed', null], ['whanau', 'Whānau told where they are going', null], ['escort', 'Escort and transport arranged', null]] },
  };
  interface I { state: string; u: string; mins: number; evidence?: string; note?: string; resolution?: { u: string; mins: number; note: string } }
  interface C { nhi: string; service: string; template: string; state: string; u: string; mins: number; reason?: string; items?: Record<string, I>; ended?: { u: string; mins: number } }
  const LOG: Record<string, string> = { DONE: 'DONE', NOT_APPLICABLE: 'NOT_APPLICABLE', EXCEPTION: 'EXCEPTION', RESOLVED: 'EXCEPTION' };
  const checklist = (x: C) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const def = defs[x.template];
    const id = newId();
    store.insert('checklist', {
      id, person_id: pid, service_id: x.service, template_id: x.template, state: x.state, due_at: ago(x.mins - def.dueMins), reason: x.reason ?? null,
      required_by: by, required_at: ago(x.mins), ended_by: x.ended ? who(x.ended.u) : null, ended_at: x.ended ? ago(x.ended.mins) : null, end_note: null,
    });
    const logs: [string, string, string, number][] = [['REQUIRED', `${def.label}.${x.reason ? ` ${x.reason}` : ''}`, by, x.mins]];
    const trans: [string | null, string, string, number][] = [[null, 'REQUIRED', by, x.mins]];
    let first = Infinity;
    def.items.forEach(([key, label, evidenceLabel], i) => {
      const it = x.items?.[key];
      store.insert('checklist_item', {
        id: newId(), checklist_id: id, item_key: key, label, seq: i, evidence_label: evidenceLabel, state: it?.state ?? 'DUE', evidence: it?.evidence ?? null, note: it?.note ?? null,
        by_id: it ? who(it.u) : null, at: it ? ago(it.mins) : null, resolution: it?.resolution?.note ?? null, resolved_by: it?.resolution ? who(it.resolution.u) : null,
        resolved_at: it?.resolution ? ago(it.resolution.mins) : null, escalation_id: null,
      });
      if (it) {
        first = first === Infinity ? it.mins : Math.max(first, it.mins);
        logs.push([LOG[it.state], `${label}.${it.evidence ? ` ${evidenceLabel}: ${it.evidence}.` : ''}${it.note ? ` ${it.note}` : ''}`, who(it.u)!, it.mins]);
        if (it.resolution) logs.push(['RESOLVED', `${label}. ${it.resolution.note}`, who(it.resolution.u)!, it.resolution.mins]);
      }
    });
    if (first !== Infinity) trans.push(['REQUIRED', 'IN_PROGRESS', by, first]);
    if (x.ended) { logs.push(['COMPLETED', 'Every item checked.', who(x.ended.u)!, x.ended.mins]); trans.push(['IN_PROGRESS', 'COMPLETED', who(x.ended.u)!, x.ended.mins]); }
    for (const [kind, body, b, mins] of logs.sort((a, c) => c[3] - a[3])) store.insert('checklist_log', { id: newId(), checklist_id: id, kind, body, by_id: b, at: ago(mins) });
    for (const [from, to, b, mins] of trans) store.insert('state_transition', { id: newId(), object_type: 'checklist', object_id: id, from_state: from, to_state: to, actor_id: b, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
  };
  checklist({ nhi: 'ZZZ0032', service: 'svc-genmed', template: 'SAFETY_ROUND', state: 'IN_PROGRESS', u: 'grace', mins: 100, reason: 'After her fall.',
    items: {
      bell: { state: 'DONE', u: 'grace', mins: 90 },
      bed: { state: 'EXCEPTION', u: 'grace', mins: 88, note: 'Brake on the left side will not lock; bed moves when she sits on the edge.' },
      aid: { state: 'DONE', u: 'grace', mins: 87 },
      floor: { state: 'DONE', u: 'grace', mins: 86 },
    } });
  checklist({ nhi: 'ZZZ9999', service: 'svc-genmed', template: 'ADMISSION', state: 'COMPLETED', u: 'nicki', mins: 2 * 24 * 60,
    items: {
      identity: { state: 'DONE', u: 'nicki', mins: 2 * 24 * 60 - 10 },
      allergies: { state: 'DONE', u: 'nicki', mins: 2 * 24 * 60 - 12, evidence: 'Penicillin: rash as a child' },
      medicines: { state: 'DONE', u: 'nicki', mins: 2 * 24 * 60 - 30, evidence: 'GP list and her own supply' },
      contact: { state: 'DONE', u: 'nicki', mins: 2 * 24 * 60 - 35 },
      falls: { state: 'DONE', u: 'nicki', mins: 2 * 24 * 60 - 60 },
      skin: { state: 'RESOLVED', u: 'nicki', mins: 2 * 24 * 60 - 62, note: 'No pressure-relieving mattress on the bed.', resolution: { u: 'grace', mins: 2 * 24 * 60 - 180, note: 'Air mattress fitted.' } },
      belongings: { state: 'DONE', u: 'nicki', mins: 2 * 24 * 60 - 70 },
    },
    ended: { u: 'grace', mins: 2 * 24 * 60 - 181 } });
  checklist({ nhi: 'ZZZ0148', service: 'svc-ed', template: 'TRANSFER_OUT', state: 'IN_PROGRESS', u: 'mere', mins: 80, reason: 'Going to Ward K.',
    items: {
      meds: { state: 'DONE', u: 'mere', mins: 70 },
      belongings: { state: 'DONE', u: 'mere', mins: 69 },
    } });
  checklist({ nhi: 'ZZZ0059', service: 'svc-arc', template: 'SAFETY_ROUND', state: 'REQUIRED', u: 'kate', mins: 30, reason: 'New confusion; check her room.' });
}

// Recommendations (the recommendation lifecycle under Shared Lifecycle Object 278): Lena's
// mobility recommendation for Peggy and Dr Singh's neuro observations for Tom, both waiting for
// the ward nurses; Lena's sit-out-for-meals for Aroha, accepted and waiting to be done; Dr Li's
// daily weights for Wiremu, done and waiting for her review.
function set41(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface R { nhi: string; u: string; from: [string, string]; to: [string, string]; mins: number; basis: string; what: string; state: string; channel?: string;
    implementBy?: number; response?: { u: string; mins: number; requirement: string; note?: string }; done?: { u: string; mins: number; note: string } }
  const rec = (x: R) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    store.insert('recommendation', {
      id, person_id: pid, state: x.state, basis: x.basis, what: x.what, from_service_id: x.from[0], from_role_key: x.from[1], to_service_id: x.to[0], to_role_key: x.to[1],
      implement_by: x.implementBy !== undefined ? addDays(todayLocal(), x.implementBy) : null, made_by: by, made_at: ago(x.mins),
      channel: x.channel ?? null, communicated_at: x.channel ? ago(x.mins) : null,
      responded_by: x.response ? who(x.response.u) : null, responded_at: x.response ? ago(x.response.mins) : null, response: x.response?.note ?? null,
      modified_what: null, requirement: x.response?.requirement ?? null,
      implemented_by: x.done ? who(x.done.u) : null, implemented_at: x.done ? ago(x.done.mins) : null, not_done_reason: null, implementation_note: x.done?.note ?? null,
      reviewed_by: null, reviewed_at: null, review_note: null,
    });
    const logs: [string, string, string, number][] = [['RECOMMENDED', `${x.what}. Based on: ${x.basis}`, by, x.mins]];
    const trans: [string | null, string, string, number][] = [[null, 'RECOMMENDED', by, x.mins]];
    if (x.channel) { logs.push(['COMMUNICATED', x.channel === 'SHIFT' ? 'Sent in SHIFT.' : 'Told them in person.', by, x.mins]); trans.push(['RECOMMENDED', 'COMMUNICATED', by, x.mins]); }
    if (x.response) {
      logs.push(['ACCEPTED', `${x.response.note ? `${x.response.note} ` : ''}To do: ${x.response.requirement}.`, who(x.response.u)!, x.response.mins]);
      trans.push(['COMMUNICATED', 'ACCEPTED', who(x.response.u)!, x.response.mins]);
    }
    if (x.done) { logs.push(['IMPLEMENTED', x.done.note, who(x.done.u)!, x.done.mins]); trans.push(['ACCEPTED', 'IMPLEMENTED', who(x.done.u)!, x.done.mins]); }
    for (const [kind, body, b, mins] of logs) store.insert('recommendation_log', { id: newId(), recommendation_id: id, kind, body, by_id: b, at: ago(mins) });
    for (const [from, to, b, mins] of trans) store.insert('state_transition', { id: newId(), object_type: 'recommendation', object_id: id, from_state: from, to_state: to, actor_id: b, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
  };
  rec({ nhi: 'ZZZ0032', u: 'lena', from: ['svc-physio', 'physio'], to: ['svc-genmed', 'genmed-rn'], mins: 120, state: 'COMMUNICATED', channel: 'SHIFT',
    basis: 'Unsteady when turning; relies on furniture; walks safely with a frame and one person beside her.',
    what: 'Walk with her frame and one person beside her to the toilet, day and night; not to walk alone yet' });
  rec({ nhi: 'ZZZ0148', u: 'ravi', from: ['svc-ed', 'ed-doctor'], to: ['svc-genmed', 'genmed-rn'], mins: 45, state: 'COMMUNICATED', channel: 'SHIFT',
    basis: 'Head injury while on apixaban; CT head clear.',
    what: 'Neuro observations every hour for 24 hours after he arrives on the ward', implementBy: 0 });
  rec({ nhi: 'ZZZ9999', u: 'lena', from: ['svc-physio', 'physio'], to: ['svc-genmed', 'genmed-rn'], mins: 26 * 60, state: 'ACCEPTED', channel: 'VERBAL',
    basis: 'Deconditioned after four days in bed; breathing better when upright.',
    what: 'Sit out of bed in the chair for lunch and dinner', implementBy: 0,
    response: { u: 'grace', mins: 25 * 60, requirement: 'Add to her care plan; help her into the chair before meals' } });
  rec({ nhi: 'ZZZ0016', u: 'hannah', from: ['svc-genmed', 'genmed-physician'], to: ['svc-genmed', 'genmed-rn'], mins: 3 * 24 * 60, state: 'IMPLEMENTED', channel: 'SHIFT',
    basis: 'Swollen ankles and crackles at both lung bases; on furosemide.',
    what: 'Weigh him every morning before breakfast, on the same scales',
    response: { u: 'grace', mins: 3 * 24 * 60 - 30, requirement: 'Daily weight on the morning list' },
    done: { u: 'grace', mins: 2 * 24 * 60, note: 'On the morning list; weighed daily since. Down 1.8 kg.' } });
}

// Requirements (the requirement lifecycle under Shared Lifecycle Object 278). On Ward K: the
// requirement from Lena's accepted sit-out recommendation for Aroha, with Grace; a pressure
// mattress for Peggy waiting to be assigned; a shower stool for Wiremu assigned to Nicki and not
// yet accepted; a diabetes educator visit for Sione deferred until his result is back; and
// spacer teaching for James, done and waiting for its outcome. At Kōwhai: new hearing aid
// batteries for Rua, waiting for someone to take it on.
function set42(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface Q { nhi: string; svc: string; u: string; mins: number; what: string; priority: string; due?: number; label: string; detail?: string;
    source?: { kind: string; id: string | null }; assigned?: { u: string; by: string; mins: number; accepted: boolean };
    deferred?: { until: number; reason: string; note: string; mins: number }; actioned?: { u: string; mins: number; note: string } }
  const req = (x: Q) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const state = x.actioned ? 'ACTIONED' : x.deferred ? 'DEFERRED' : x.assigned ? 'ASSIGNED' : 'PENDING';
    const a = x.assigned ?? (x.actioned ? { u: x.actioned.u, by: x.actioned.u, mins: x.actioned.mins + 30, accepted: true } : undefined);
    store.insert('requirement', {
      id, person_id: pid, service_id: x.svc, state, what: x.what, detail: x.detail ?? null, priority: x.priority,
      due_by: x.due !== undefined ? addDays(todayLocal(), x.due) : null, source: x.source?.kind ?? 'MANUAL', source_id: x.source?.id ?? null, source_label: x.label,
      generated_by: by, generated_at: ago(x.mins),
      assigned_to: a && !x.deferred ? who(a.u) : null, assigned_by: a && !x.deferred ? who(a.by) : null, assigned_at: a && !x.deferred ? ago(a.mins) : null,
      accepted_at: a && a.accepted && !x.deferred ? ago(a.mins) : null,
      actioned_by: x.actioned ? who(x.actioned.u) : null, actioned_at: x.actioned ? ago(x.actioned.mins) : null, action_note: x.actioned?.note ?? null,
      deferred_until: x.deferred ? addDays(todayLocal(), x.deferred.until) : null, defer_reason: x.deferred?.reason ?? null,
      ended_note: null, outcome: null, outcome_note: null, closed_by: null, closed_at: null,
    });
    const logs: [string, string, string, number][] = [['GENERATED', `${x.what}. From ${x.label}.`, by, x.mins]];
    const trans: [string | null, string, string, number][] = [[null, 'PENDING', by, x.mins]];
    if (a) {
      logs.push(['ASSIGNED', a.u === a.by ? 'Took it on.' : 'Assigned; waiting for them to accept.', who(a.by)!, a.mins]);
      trans.push(['PENDING', 'ASSIGNED', who(a.by)!, a.mins]);
    }
    if (x.deferred) {
      logs.push(['DEFERRED', `Until ${addDays(todayLocal(), x.deferred.until)}. ${x.deferred.note}`, by, x.deferred.mins]);
      trans.push([a ? 'ASSIGNED' : 'PENDING', 'DEFERRED', by, x.deferred.mins]);
    }
    if (x.actioned) { logs.push(['ACTIONED', x.actioned.note, who(x.actioned.u)!, x.actioned.mins]); trans.push(['ASSIGNED', 'ACTIONED', who(x.actioned.u)!, x.actioned.mins]); }
    for (const [kind, body, b, mins] of logs) store.insert('requirement_log', { id: newId(), requirement_id: id, kind, body, by_id: b, at: ago(mins) });
    for (const [from, to, b, mins] of trans) store.insert('state_transition', { id: newId(), object_type: 'requirement', object_id: id, from_state: from, to_state: to, actor_id: b, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
  };
  const aroha = person('ZZZ9999');
  const sitOut = aroha ? store.get<{ id: string; requirement: string }>("SELECT id, requirement FROM recommendation WHERE person_id = ? AND state = 'ACCEPTED' LIMIT 1", aroha) : undefined;
  if (sitOut) {
    req({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'grace', mins: 25 * 60, what: sitOut.requirement, priority: 'TODAY', due: 0,
      label: "Lena Fox's recommendation (Physiotherapist): Sit out of bed in the chair for lunch and dinner", source: { kind: 'RECOMMENDATION', id: sitOut.id },
      assigned: { u: 'grace', by: 'grace', mins: 25 * 60 - 5, accepted: true } });
  }
  req({ nhi: 'ZZZ0032', svc: 'svc-genmed', u: 'grace', mins: 3 * 60, what: 'Get a pressure-relieving mattress on her bed', priority: 'URGENT', due: 0,
    label: 'Skin check on the morning round', detail: 'Red area on her sacrum that does not blanch; Waterlow 18.' });
  req({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'grace', mins: 90, what: 'Order a shower stool for home before he goes', priority: 'ROUTINE', due: 2,
    label: 'Discharge planning meeting', assigned: { u: 'nicki', by: 'grace', mins: 80, accepted: false } });
  req({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'hannah', mins: 26 * 60, what: 'Diabetes educator to see him before discharge', priority: 'ROUTINE',
    label: 'Ward round', deferred: { until: 1, reason: 'WAITING', note: 'Waiting for his HbA1c; the educator will come once it is back.', mins: 20 * 60 } });
  req({ nhi: 'ZZZ0040', svc: 'svc-genmed', u: 'grace', mins: 8 * 60, what: 'Teach him to use his inhaler with the new spacer', priority: 'TODAY', due: 0,
    label: 'Admission assessment', actioned: { u: 'nicki', mins: 4 * 60, note: 'Shown twice; he did it back correctly both times.' } });
  req({ nhi: 'ZZZ0059', svc: 'svc-arc', u: 'nicki', mins: 5 * 60, what: 'Put new batteries in her hearing aids', priority: 'TODAY', due: 0,
    label: 'Morning cares', detail: 'Left aid whistling; she is missing conversation at lunch.' });
}

// Care due (the due-date lifecycle under Shared Lifecycle Object 278). On Ward K: Peggy's
// two-hourly turns, overdue; Wiremu's cannula check, due now; Aroha's daily weight, coming up;
// James's repeat potassium later today; Sione's dressing in two days. At Kōwhai: Frank's catheter
// bag, due now; Elsie's weekly weight, overdue; Rua's four-hourly turns, coming up.
function set43(store: Store): void {
  const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface D { nhi: string; svc: string; u: string; kind: string; what: string; every: number | null; setMins: number; dueIn: number; detail?: string; done?: { u: string; mins: number }[] }
  const item = (x: D) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    store.insert('due_item', {
      id, person_id: pid, service_id: x.svc, kind: x.kind, what: x.what, detail: x.detail ?? null, every_hours: x.every, state: 'ACTIVE',
      set_by: by, set_at: at(-x.setMins), ended_by: null, ended_at: null, ended_note: null,
    });
    store.insert('state_transition', { id: newId(), object_type: 'due_item', object_id: id, from_state: null, to_state: 'ACTIVE', actor_id: by, work_context_id: null, at: at(-x.setMins), reason: null, transaction_id: null });
    store.insert('due_log', { id: newId(), item_id: id, kind: 'SET_UP', body: `${x.what}. ${x.every ? `Every ${x.every} hours` : 'Once'}.`, by_id: by, at: at(-x.setMins) });
    const occ = (dueMins: number, done?: { u: string; mins: number }) => {
      const oid = newId();
      const d = done ? who(done.u) : null;
      store.insert('due_occurrence', { id: oid, item_id: id, due_at: at(dueMins), state: done ? 'COMPLETED' : 'SCHEDULED', done_by: d, done_at: done ? at(-done.mins) : null, note: null, reason: null });
      store.insert('state_transition', { id: newId(), object_type: 'due_occurrence', object_id: oid, from_state: null, to_state: 'SCHEDULED', actor_id: by, work_context_id: null, at: at(-x.setMins), reason: null, transaction_id: null });
      if (done && d) {
        store.insert('state_transition', { id: newId(), object_type: 'due_occurrence', object_id: oid, from_state: 'SCHEDULED', to_state: 'COMPLETED', actor_id: d, work_context_id: null, at: at(-done.mins), reason: null, transaction_id: null });
        store.insert('due_log', { id: newId(), item_id: id, kind: 'DONE', body: 'Done.', by_id: d, at: at(-done.mins) });
      }
    };
    for (const dn of x.done ?? []) occ(-dn.mins, dn);
    occ(x.dueIn);
  };
  item({ nhi: 'ZZZ0032', svc: 'svc-genmed', u: 'grace', kind: 'REPOSITION', what: 'Change position (pressure care)', every: 2, setMins: 6 * 60, dueIn: -40,
    detail: 'Red area on her sacrum. Left side, back, right side; off her back as much as she will allow.', done: [{ u: 'grace', mins: 4 * 60 + 40 }, { u: 'grace', mins: 2 * 60 + 40 }] });
  item({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'grace', kind: 'CANNULA', what: 'Check the IV cannula site', every: 8, setMins: 30 * 60, dueIn: -10, done: [{ u: 'grace', mins: 8 * 60 + 10 }] });
  item({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'grace', kind: 'WEIGHT', what: 'Weigh', every: 24, setMins: 45 * 60, dueIn: 3 * 60, detail: 'Same scales, before breakfast.', done: [{ u: 'grace', mins: 21 * 60 }] });
  item({ nhi: 'ZZZ0040', svc: 'svc-genmed', u: 'hannah', kind: 'BLOODS', what: 'Repeat potassium', every: null, setMins: 2 * 60, dueIn: 5 * 60, detail: 'Potassium 3.1 this morning; on oral replacement.' });
  item({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'grace', kind: 'DRESSING', what: 'Change the dressing on his left shin', every: 72, setMins: 26 * 60, dueIn: 46 * 60 });
  item({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', kind: 'CATHETER_BAG', what: 'Change the catheter bag', every: 168, setMins: 30 * 24 * 60, dueIn: -2 * 60, done: [{ u: 'tama', mins: 7 * 24 * 60 + 120 }] });
  item({ nhi: 'ZZZ0067', svc: 'svc-arc', u: 'nicki', kind: 'WEIGHT', what: 'Weigh', every: 168, setMins: 60 * 24 * 60, dueIn: -6 * 60, done: [{ u: 'tama', mins: 7 * 24 * 60 + 360 }] });
  item({ nhi: 'ZZZ0059', svc: 'svc-arc', u: 'nicki', kind: 'REPOSITION', what: 'Change position (pressure care)', every: 4, setMins: 3 * 24 * 60, dueIn: 30, done: [{ u: 'tama', mins: 3 * 60 + 30 }] });
}

// Recalls (Shared Lifecycle Object 283). At Kōwhai: Losa's flu vaccine due in ten days (last
// year's done); Rua's flu vaccine due in three weeks; Frank's B12 injection booked for tomorrow;
// Bill's six-monthly medicines review overdue, his son phoned; Elsie's eye check missed when the
// optometrist came. On Ward K: a heart failure nurse review for Wiremu after he goes home.
function set44(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface R { nhi: string; svc: string; u: string; kind: string; what: string; every: number | null; due: number; setDays: number; detail?: string;
    checked?: number; invited?: { days: number; channel: string; note?: string }; booked?: { inMins: number; where: string; days: number };
    dna?: { days: number; note: string }; done?: { days: number; outcome: string }; previousId?: string }
  const rec = (x: R) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return null;
    const id = newId();
    const state = x.done ? 'DONE' : x.dna ? 'DID_NOT_ATTEND' : x.booked ? 'BOOKED' : x.invited ? 'INVITED' : 'SCHEDULED';
    store.insert('recall', {
      id, person_id: pid, service_id: x.svc, kind: x.kind, what: x.what, detail: x.detail ?? null, every_days: x.every, due_date: addDays(todayLocal(), x.due),
      state, previous_id: x.previousId ?? null, next_id: null, set_by: by, set_at: ago(x.setDays * day),
      checked_by: x.checked !== undefined ? by : null, checked_at: x.checked !== undefined ? ago(x.checked * day) : null, eligibility_note: null,
      invited_by: x.invited ? by : null, invited_at: x.invited ? ago(x.invited.days * day) : null, channel: x.invited?.channel ?? null, invite_note: x.invited?.note ?? null,
      booked_by: x.booked ? by : null, booked_at: x.booked ? ago(x.booked.days * day) : null,
      booked_for: x.booked ? new Date(Date.now() + x.booked.inMins * 60_000).toISOString() : null, booked_where: x.booked?.where ?? null,
      dna_at: x.dna ? ago(x.dna.days * day) : null, dna_note: x.dna?.note ?? null,
      done_by: x.done ? by : null, done_at: x.done ? ago(x.done.days * day) : null, outcome: x.done?.outcome ?? null,
      exit_reason: null, ended_by: null, ended_at: null, ended_note: null,
    });
    const steps: [string, string, string | null, string, number][] = [['SET_UP', `${x.what}. Due ${addDays(todayLocal(), x.due)}.`, null, 'SCHEDULED', x.setDays]];
    if (x.checked !== undefined) steps.push(['ELIGIBLE', 'Checked.', null, '', x.checked]);
    if (x.invited) steps.push(['INVITED', `${x.invited.channel === 'PHONE' ? 'By phone' : x.invited.channel === 'WHANAU' ? 'Through their whānau or representative' : 'Told them in person'}.${x.invited.note ? ` ${x.invited.note}` : ''}`, 'SCHEDULED', 'INVITED', x.invited.days]);
    if (x.booked) steps.push(['BOOKED', `${x.booked.where}.`, 'INVITED', 'BOOKED', x.booked.days]);
    if (x.dna) steps.push(['DID_NOT_ATTEND', x.dna.note, 'BOOKED', 'DID_NOT_ATTEND', x.dna.days]);
    if (x.done) steps.push(['DONE', x.done.outcome, 'BOOKED', 'DONE', x.done.days]);
    for (const [kind, body, from, to, days] of steps) {
      store.insert('recall_log', { id: newId(), recall_id: id, kind, body, by_id: by, at: ago(days * day) });
      if (to) store.insert('state_transition', { id: newId(), object_type: 'recall', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(days * day), reason: null, transaction_id: null });
    }
    return id;
  };
  const A = 'svc-arc';
  const last = rec({ nhi: 'ZZZ0083', svc: A, u: 'nicki', kind: 'FLU', what: 'Influenza vaccine', every: 365, due: -355, setDays: 720, checked: 362,
    invited: { days: 362, channel: 'WHANAU', note: 'Talked it through with Mele; Losa agreed.' }, booked: { inMins: -355 * 24 * 60, where: 'Kōwhai treatment room', days: 361 },
    done: { days: 355, outcome: 'Vaccine given, left arm. No reaction.' } });
  const next = rec({ nhi: 'ZZZ0083', svc: A, u: 'nicki', kind: 'FLU', what: 'Influenza vaccine', every: 365, due: 10, setDays: 355, previousId: last ?? undefined });
  if (last && next) store.run('UPDATE recall SET next_id = ? WHERE id = ?', next, last);
  rec({ nhi: 'ZZZ0059', svc: A, u: 'nicki', kind: 'FLU', what: 'Influenza vaccine', every: 365, due: 21, setDays: 300 });
  rec({ nhi: 'ZZZ0075', svc: A, u: 'nicki', kind: 'B12', what: 'Vitamin B12 injection', every: 91, due: 1, setDays: 90, checked: 4,
    invited: { days: 3, channel: 'IN_PERSON' }, booked: { inMins: 24 * 60, where: 'Kōwhai treatment room', days: 3 } });
  rec({ nhi: 'ZZZ0091', svc: A, u: 'nicki', kind: 'MEDS_REVIEW', what: 'Medicines review with the GP', every: 182, due: -5, setDays: 180, checked: 9,
    invited: { days: 8, channel: 'WHANAU', note: 'Phoned his son Ian, who wants to be there; he will call back with a day.' } });
  rec({ nhi: 'ZZZ0067', svc: A, u: 'nicki', kind: 'EYES', what: 'Eye check (optometrist)', every: 365, due: -20, setDays: 360, checked: 25,
    invited: { days: 24, channel: 'IN_PERSON' }, booked: { inMins: -6 * 24 * 60, where: 'Visiting optometrist, Kōwhai lounge', days: 20 },
    dna: { days: 6, note: 'She was at the hairdresser when the optometrist came; not told about the booking.' } });
  rec({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'hannah', kind: 'HF_REVIEW', what: 'Heart failure nurse review', every: null, due: 16, setDays: 1,
    detail: 'Two weeks after he goes home: weight, swelling, furosemide dose.' });
}

// Follow-ups (Shared Lifecycle Object 284). From Ward K: a potassium recheck for James by his GP,
// not yet confirmed; an outpatient falls review for Peggy, waiting for Physiotherapy to take it
// on; cardiology for Wiremu, referred; the diabetes clinic for Sione, booked. From Kōwhai: Losa's
// geriatrician review has happened and needs its outcome.
function set45(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface F { nhi: string; u: string; from: [string, string]; what: string; reason?: string; due: number; madeDays: number; to?: [string, string]; external?: string;
    accepted?: { days: number; told?: string; note: string }; arranged?: { days: number; link: string; ref: string }; scheduled?: { inDays: number; where: string; days: number };
    completed?: { days: number; note: string } }
  const fu = (x: F) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const state = x.completed ? 'COMPLETED' : x.scheduled ? 'SCHEDULED' : x.arranged ? 'ARRANGED' : x.accepted ? 'ACCEPTED' : 'REQUIRED';
    store.insert('followup', {
      id, person_id: pid, what: x.what, reason: x.reason ?? null, due_by: addDays(todayLocal(), x.due), state, previous_id: null, further_id: null,
      from_service_id: x.from[0], from_role_key: x.from[1], made_by: by, made_at: ago(x.madeDays * day),
      resp_kind: x.external ? 'EXTERNAL' : 'INTERNAL', to_service_id: x.to?.[0] ?? null, to_role_key: x.to?.[1] ?? null, external_name: x.external ?? null,
      accepted_by: x.accepted ? by : null, accepted_at: x.accepted ? ago(x.accepted.days * day) : null, told: x.accepted?.told ?? null, accept_note: x.accepted?.note ?? null,
      link_kind: x.arranged?.link ?? null, link_ref: x.arranged?.ref ?? null, arranged_by: x.arranged ? by : null, arranged_at: x.arranged ? ago(x.arranged.days * day) : null,
      scheduled_for: x.scheduled ? new Date(Date.now() + x.scheduled.inDays * day * 60_000).toISOString() : null, scheduled_where: x.scheduled?.where ?? null,
      completed_by: x.completed ? by : null, completed_at: x.completed ? ago(x.completed.days * day) : null, completed_note: x.completed?.note ?? null,
      outcome: null, outcome_note: null, closed_by: null, closed_at: null, ended_note: null,
    });
    const steps: [string, string, string | null, string, number][] = [['REQUIRED', `${x.what}. By ${addDays(todayLocal(), x.due)}. Responsible: ${x.external ?? 'Physiotherapist, Physiotherapy'}.`, null, 'REQUIRED', x.madeDays]];
    if (x.accepted) steps.push(['ACCEPTED', x.accepted.note, 'REQUIRED', 'ACCEPTED', x.accepted.days]);
    if (x.arranged) steps.push(['ARRANGED', x.arranged.ref, 'ACCEPTED', 'ARRANGED', x.arranged.days]);
    if (x.scheduled) steps.push(['SCHEDULED', `${x.scheduled.where}.`, 'ARRANGED', 'SCHEDULED', x.scheduled.days]);
    if (x.completed) steps.push(['COMPLETED', x.completed.note, x.scheduled ? 'SCHEDULED' : 'ARRANGED', 'COMPLETED', x.completed.days]);
    for (const [kind, body, from, to, days] of steps) {
      store.insert('followup_log', { id: newId(), followup_id: id, kind, body, by_id: by, at: ago(days * day) });
      store.insert('state_transition', { id: newId(), object_type: 'followup', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(days * day), reason: null, transaction_id: null });
    }
  };
  const GM: [string, string] = ['svc-genmed', 'genmed-physician'];
  fu({ nhi: 'ZZZ0040', u: 'hannah', from: GM, what: 'GP to recheck potassium within a week of going home', reason: 'Potassium 3.1; on oral replacement.', due: 7, madeDays: 0.1,
    external: 'Dr Priya Nair, Onehunga Health (GP)' });
  fu({ nhi: 'ZZZ0032', u: 'hannah', from: GM, what: 'Outpatient falls and balance review', reason: 'Two falls this year; walking with a frame.', due: 42, madeDays: 0.5,
    to: ['svc-physio', 'physio'] });
  fu({ nhi: 'ZZZ0016', u: 'hannah', from: GM, what: 'Cardiology review of his heart failure', due: 40, madeDays: 2, external: 'Cardiology outpatients, Auckland City Hospital',
    accepted: { days: 2, told: 'EREFERRAL', note: 'Registrar accepted the referral.' },
    arranged: { days: 2, link: 'REFERRAL', ref: 'eReferral to Cardiology' } });
  fu({ nhi: 'ZZZ0024', u: 'hannah', from: GM, what: 'Diabetes clinic review of his insulin', due: 30, madeDays: 1, external: 'Diabetes Service, Greenlane',
    accepted: { days: 1, told: 'PHONE', note: 'Clinic nurse Mei booked him in.' },
    arranged: { days: 1, link: 'APPOINTMENT', ref: 'Clinic booking by phone' },
    scheduled: { inDays: 20, where: 'Greenlane Clinical Centre, Clinic 3', days: 1 } });
  fu({ nhi: 'ZZZ0083', u: 'nicki', from: ['svc-arc', 'arc-rn'], what: 'Geriatrician review of her memory and falls', due: 5, madeDays: 40, external: 'Dr Mark Tipene, geriatrician',
    accepted: { days: 40, told: 'OTHER', note: 'GP referral accepted by the clinic.' },
    arranged: { days: 39, link: 'REFERRAL', ref: 'GP referral to the older adults clinic' },
    scheduled: { inDays: -3, where: 'Older adults clinic, Greenlane', days: 30 },
    completed: { days: 2, note: 'Seen with Mele on Wednesday; clinic letter received.' } });
}

// Surveillance plans (Shared Lifecycle Object 285). On Ward K: Wiremu's kidney function and
// potassium after starting spironolactone, bloods taken this morning with a result for Hannah to
// review; James's INR, overdue; Peggy's neuro checks after a fall on apixaban, only when triggered.
// At Kōwhai: Elsie's skin lesion on her nose, photographed monthly, due in five days; Bill's daily
// weight for heart failure, due today.
function set46(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface C { due: number; created: number; state: string; performed?: [string, number, string?]; result?: [string, number, string, string];
    notDone?: [string, string]; reviewed?: [string, number, string, string] }
  interface P { nhi: string; svc: string; u: string; kind: string; need: string; check: string; every: number | null; trigger?: string; setDays: number; checks: C[] }
  const plan = (x: P) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    store.insert('surveillance_plan', {
      id, person_id: pid, service_id: x.svc, kind: x.kind, need: x.need, investigation: x.check, every_days: x.every, trigger_text: x.trigger ?? null,
      state: 'ACTIVE', set_by: by, set_at: ago(x.setDays * day),
    });
    const log = (checkId: string | null, kind: string, body: string, u: string, mins: number) =>
      store.insert('surveillance_log', { id: newId(), plan_id: id, check_id: checkId, kind, body, by_id: who(u) ?? by, at: ago(mins) });
    const move = (type: string, oid: string, from: string | null, to: string, u: string, mins: number) =>
      store.insert('state_transition', { id: newId(), object_type: type, object_id: oid, from_state: from, to_state: to, actor_id: who(u) ?? by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
    move('survplan', id, null, 'ACTIVE', x.u, x.setDays * day);
    log(null, 'SET_UP', `${x.need} Check: ${x.check}. ${x.every ? (x.every === 1 ? 'Every day' : x.every === 7 ? 'Every week' : `Every ${x.every} days`) : 'Only when triggered'}.${x.trigger ? ` Also when: ${x.trigger}.` : ''}`, x.u, x.setDays * day);
    for (const c of x.checks) {
      const cid = newId();
      const due = addDays(todayLocal(), c.due);
      store.insert('surveillance_check', {
        id: cid, plan_id: id, person_id: pid, due_date: due, why: 'Scheduled', state: c.state, created_by: by, created_at: ago(c.created * day),
        performed_by: c.performed ? who(c.performed[0]) : c.notDone ? who(x.u) : null, performed_at: c.performed ? ago(c.performed[1] * day) : c.notDone ? ago(c.created * day - 60) : null,
        performed_note: c.performed?.[2] ?? null,
        result_by: c.result ? who(c.result[0]) : null, result_at: c.result ? ago(c.result[1] * day) : null, result: c.result?.[2] ?? null, finding: c.result?.[3] ?? null,
        not_done_reason: c.notDone?.[0] ?? null, not_done_note: c.notDone?.[1] ?? null,
        reviewed_by: c.reviewed ? who(c.reviewed[0]) : null, reviewed_at: c.reviewed ? ago(c.reviewed[1] * day) : null, decision: c.reviewed?.[2] ?? null, review_note: c.reviewed?.[3] ?? null,
      });
      move('survcheck', cid, null, 'DUE', x.u, c.created * day);
      log(cid, 'DUE', `Check due ${due}.`, x.u, c.created * day);
      let last = 'DUE';
      if (c.performed) { move('survcheck', cid, last, 'PERFORMED', c.performed[0], c.performed[1] * day); log(cid, 'PERFORMED', c.performed[2] ?? 'Done. Result to follow.', c.performed[0], c.performed[1] * day); last = 'PERFORMED'; }
      if (c.notDone) { move('survcheck', cid, last, 'NOT_DONE', x.u, c.created * day - 60); log(cid, 'NOT_DONE', c.notDone[1], x.u, c.created * day - 60); last = 'NOT_DONE'; }
      if (c.result) { move('survcheck', cid, last, 'RESULTED', c.result[0], c.result[1] * day); log(cid, 'RESULT', c.result[2], c.result[0], c.result[1] * day); last = 'RESULTED'; }
      if (c.reviewed) { move('survcheck', cid, last, 'REVIEWED', c.reviewed[0], c.reviewed[1] * day); log(cid, 'REVIEWED', `Continue as planned. ${c.reviewed[3]}`, c.reviewed[0], c.reviewed[1] * day); }
    }
  };
  plan({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'hannah', kind: 'KIDNEY_POTASSIUM', need: 'Started spironolactone for heart failure; risk of high potassium and worse kidney function.',
    check: 'Creatinine, eGFR and potassium', every: 2, setDays: 3,
    checks: [{ due: -1, created: 3, state: 'RESULTED', performed: ['nicki', 0.25, 'Bloods taken at 0600, sent to the lab.'],
      result: ['nicki', 0.1, 'Potassium 5.4 (was 4.6), creatinine 128 (was 110)', 'CHANGED'] }] });
  plan({ nhi: 'ZZZ0040', svc: 'svc-genmed', u: 'hannah', kind: 'INR', need: 'On warfarin for atrial fibrillation; interacting antibiotic started.', check: 'INR', every: 2, setDays: 4,
    checks: [
      { due: -4, created: 4, state: 'REVIEWED', performed: ['nicki', 3.9], result: ['nicki', 3.8, 'INR 2.6', 'EXPECTED'], reviewed: ['hannah', 3.7, 'CONTINUE', 'In range; same dose.'] },
      { due: -2, created: 3.7, state: 'DUE' }] });
  plan({ nhi: 'ZZZ0032', svc: 'svc-genmed', u: 'hannah', kind: 'NEURO_FALL', need: 'Fell on the ward while on apixaban; CT head clear.', check: 'Conscious level, pupils and limb power', every: null,
    trigger: 'If she falls again, hits her head, or becomes drowsy or confused', setDays: 2,
    checks: [{ due: -2, created: 2, state: 'REVIEWED', performed: ['nicki', 1.9], result: ['nicki', 1.9, 'GCS 15, pupils equal and reacting, power normal in all limbs', 'EXPECTED'],
      reviewed: ['hannah', 1.5, 'CONTINUE', 'Normal; only recheck if something happens.'] }] });
  plan({ nhi: 'ZZZ0067', svc: 'svc-arc', u: 'nicki', kind: 'SKIN_LESION', need: 'Scaly lesion on the left side of her nose; GP and Elsie chose to watch it rather than biopsy.',
    check: 'Photograph and measure the lesion', every: 28, setDays: 30,
    checks: [
      { due: -23, created: 30, state: 'REVIEWED', performed: ['nicki', 23, 'Photo in the chart.'], result: ['nicki', 23, '6 mm by 5 mm, no bleeding', 'EXPECTED'], reviewed: ['nicki', 23, 'CONTINUE', 'Same size as the GP measured.'] },
      { due: 5, created: 23, state: 'DUE' }] });
  plan({ nhi: 'ZZZ0091', svc: 'svc-arc', u: 'nicki', kind: 'WEIGHT_HF', need: 'Heart failure; furosemide dose depends on his weight. Tell the RN if up 1 kg in a day or 2 kg in a week.',
    check: 'Weigh at the same time each day, same scales', every: 1, setDays: 20,
    checks: [
      { due: -1, created: 2, state: 'REVIEWED', performed: ['tama', 1], result: ['tama', 1, '78.2 kg', 'EXPECTED'], reviewed: ['nicki', 0.9, 'CONTINUE', 'Steady.'] },
      { due: 0, created: 0.9, state: 'DUE' }] });
}

// Screening episodes (Shared Lifecycle Object 286). On Ward K: Sione's diabetic eye screen is
// overdue to be offered; Wiremu agreed to a mood screen; Aroha's memory screen is abnormal and
// waiting for Hannah's review. At Kōwhai: Rua has been offered a mood screen and wants to talk to
// her moko first; Frank's hearing screen is normal and reviewed, so he needs to be told; Elsie
// declined a memory screen last month.
function set47(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  type Step = [kind: string, to: string | null, body: string, u: string, days: number];
  interface S { nhi: string; svc: string; u: string; kind: string; what: string; test: string; eligibility: string; due: number; setDays: number; state: string;
    cols?: Record<string, string | number | null>; steps?: Step[] }
  const ep = (x: S) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    store.insert('screening', {
      id, person_id: pid, service_id: x.svc, kind: x.kind, what: x.what, test: x.test, eligibility: x.eligibility, due_date: addDays(todayLocal(), x.due),
      state: x.state, previous_id: null, next_id: null, set_by: by, set_at: ago(x.setDays * day), ...(x.cols ?? {}),
    });
    let from: string | null = null;
    for (const [kind, to, body, u, days] of [['ELIGIBLE', 'ELIGIBLE', `${x.eligibility} Due ${addDays(todayLocal(), x.due)}.`, x.u, x.setDays] as Step, ...(x.steps ?? [])]) {
      store.insert('screening_log', { id: newId(), screening_id: id, kind, body, by_id: who(u) ?? by, at: ago(days * day) });
      if (to) {
        store.insert('state_transition', { id: newId(), object_type: 'screening', object_id: id, from_state: from, to_state: to, actor_id: who(u) ?? by, work_context_id: null, at: ago(days * day), reason: null, transaction_id: null });
        from = to;
      }
    }
  };
  const nicki = who('nicki');
  const hannah = who('hannah');
  ep({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'hannah', kind: 'RETINAL', what: 'Diabetic eye screening', test: 'Retinal photographs',
    eligibility: 'Type 2 diabetes on insulin; last eye screen three years ago.', due: -10, setDays: 1, state: 'ELIGIBLE' });
  ep({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'nicki', kind: 'MOOD', what: 'Low mood', test: 'Mood screen (e.g. GDS-15)',
    eligibility: 'New heart failure diagnosis; Ana says he has been flat and not sleeping.', due: 0, setDays: 1, state: 'ACCEPTED',
    cols: { offered_by: nicki, offered_at: ago(0.8 * day), channel: 'IN_PERSON', offer_note: 'Explained with Ana present.', decided_by: nicki, decided_at: ago(0.8 * day), decision_note: 'Happy to do it after his shower.' },
    steps: [['OFFERED', 'OFFERED', 'In person. Explained with Ana present.', 'nicki', 0.8], ['ACCEPTED', 'ACCEPTED', 'Happy to do it after his shower.', 'nicki', 0.8]] });
  ep({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'hannah', kind: 'COGNITION', what: 'Memory and thinking', test: 'Cognitive screen (e.g. MoCA)',
    eligibility: 'Her whānau have noticed she is forgetting her inhalers and appointments.', due: -1, setDays: 1.5, state: 'RESULTED',
    cols: { offered_by: hannah, offered_at: ago(1.4 * day), channel: 'IN_PERSON', decided_by: hannah, decided_at: ago(1.4 * day), decision_note: 'Yes, I want to know.',
      screened_by: nicki, screened_at: ago(0.3 * day), screen_note: 'Done in the whānau room, glasses on.', result_by: nicki, result_at: ago(0.3 * day), result: 'MoCA 21/30; lost points on delayed recall and clock drawing.', finding: 'ABNORMAL' },
    steps: [['OFFERED', 'OFFERED', 'In person.', 'hannah', 1.4], ['ACCEPTED', 'ACCEPTED', 'Yes, I want to know.', 'hannah', 1.4], ['SCREENED', 'SCREENED', 'Done in the whānau room, glasses on.', 'nicki', 0.3],
      ['RESULT', 'RESULTED', 'MoCA 21/30; lost points on delayed recall and clock drawing (abnormal).', 'nicki', 0.3]] });
  ep({ nhi: 'ZZZ0059', svc: 'svc-arc', u: 'nicki', kind: 'MOOD', what: 'Low mood', test: 'Mood screen (e.g. GDS-15)',
    eligibility: 'Six-monthly screen for residents; staff say she has been staying in her room.', due: -2, setDays: 5, state: 'OFFERED',
    cols: { offered_by: nicki, offered_at: ago(2 * day), channel: 'IN_PERSON', offer_note: 'Offered during morning cares.' },
    steps: [['OFFERED', 'OFFERED', 'In person. Offered during morning cares.', 'nicki', 2], ['LATER', 'OFFERED', 'Wants to talk to her moko Hana first.', 'nicki', 2]] });
  ep({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', kind: 'HEARING', what: 'Hearing', test: 'Whisper test and ear check',
    eligibility: 'Yearly screen for residents.', due: -6, setDays: 10, state: 'REVIEWED',
    cols: { offered_by: nicki, offered_at: ago(7 * day), channel: 'IN_PERSON', decided_by: nicki, decided_at: ago(7 * day),
      screened_by: nicki, screened_at: ago(6 * day), result_by: nicki, result_at: ago(6 * day), result: 'Heard whispered numbers both sides; ear canals clear.', finding: 'NORMAL',
      reviewed_by: nicki, reviewed_at: ago(1 * day), review_note: 'Normal; screen again next year.' },
    steps: [['OFFERED', 'OFFERED', 'In person.', 'nicki', 7], ['ACCEPTED', 'ACCEPTED', 'Agreed to the screen.', 'nicki', 7], ['SCREENED', 'SCREENED', 'Done. Result to follow.', 'nicki', 6],
      ['RESULT', 'RESULTED', 'Heard whispered numbers both sides; ear canals clear (normal).', 'nicki', 6], ['REVIEWED', 'REVIEWED', 'Normal; screen again next year.', 'nicki', 1]] });
  ep({ nhi: 'ZZZ0067', svc: 'svc-arc', u: 'nicki', kind: 'COGNITION', what: 'Memory and thinking', test: 'Cognitive screen (e.g. MoCA)',
    eligibility: 'Yearly screen for residents.', due: -35, setDays: 40, state: 'DECLINED',
    cols: { offered_by: nicki, offered_at: ago(33 * day), channel: 'IN_PERSON', decided_by: nicki, decided_at: ago(33 * day), decision_note: '"My memory is my business, dear."' },
    steps: [['OFFERED', 'OFFERED', 'In person.', 'nicki', 33], ['DECLINED', 'DECLINED', '"My memory is my business, dear."', 'nicki', 33]] });
}

// Infection episodes (Shared Lifecycle Object 289). On Ward K: Aroha's pneumonia, confirmed and
// improving on antibiotics; Sione's diabetic foot ulcer growing MRSA, getting worse, debridement
// planned; Wiremu's cannula site suspected. At Kōwhai: Frank has a suspected urine infection; Elsie's
// ESBL urine infection resolved last month and still shows as a resistant organism.
function set48(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  type E = [kind: string, what: string, value: string | null, u: string, days: number];
  interface I { nhi: string; svc: string; u: string; site: string; detail?: string; why: string; days: number; state: string;
    confirm?: [source: string, note: string, u: string, days: number]; end?: [note: string, u: string, days: number]; entries?: E[] }
  const inf = (x: I) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    store.insert('infection', {
      id, person_id: pid, service_id: x.svc, site: x.site, site_detail: x.detail ?? null, suspicion: x.why, state: x.state, previous_id: null, recurrence_id: null,
      raised_by: by, raised_at: ago(x.days * day), source: x.confirm?.[0] ?? null, confirmed_by: x.confirm ? who(x.confirm[2]) : null,
      confirmed_at: x.confirm ? ago(x.confirm[3] * day) : null, confirm_note: x.confirm?.[1] ?? null,
      ended_by: x.end ? who(x.end[1]) : null, ended_at: x.end ? ago(x.end[2] * day) : null, outcome_note: x.end?.[0] ?? null,
    });
    const entry = (kind: string, what: string, value: string | null, u: string, days: number) =>
      store.insert('infection_entry', { id: newId(), infection_id: id, kind, what, value, ref_id: null, by_id: who(u) ?? by, at: ago(days * day) });
    const move = (from: string | null, to: string, u: string, days: number) =>
      store.insert('state_transition', { id: newId(), object_type: 'infection', object_id: id, from_state: from, to_state: to, actor_id: who(u) ?? by, work_context_id: null, at: ago(days * day), reason: null, transaction_id: null });
    entry('RAISED', `${x.why}`, null, x.u, x.days);
    move(null, 'SUSPECTED', x.u, x.days);
    for (const [kind, what, value, u, days] of x.entries ?? []) entry(kind, what, value, u, days);
    if (x.confirm) { entry('CONFIRMED', `${x.confirm[0]}. ${x.confirm[1]}`, null, x.confirm[2], x.confirm[3]); move('SUSPECTED', 'CONFIRMED', x.confirm[2], x.confirm[3]); }
    if (x.end) { entry(x.state, x.end[0], null, x.end[1], x.end[2]); move('CONFIRMED', x.state, x.end[1], x.end[2]); }
  };
  inf({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'hannah', site: 'CHEST', why: 'Temp 38.4, new cough with green sputum, crackles right base.', days: 2, state: 'CONFIRMED',
    confirm: ['Right lower lobe community-acquired pneumonia', 'Dr Li: clinical and chest X-ray findings.', 'hannah', 1.9],
    entries: [['EVIDENCE', 'CRP 142; chest X-ray: right lower lobe consolidation', null, 'hannah', 1.95], ['TREATMENT', 'IV amoxicillin and clavulanic acid started', null, 'hannah', 1.9],
      ['ORGANISM', 'Streptococcus pneumoniae (sputum)', 'NONE', 'hannah', 1], ['RESPONSE', 'Afebrile since last night; still coughing', 'IMPROVING', 'nicki', 0.2]] });
  inf({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'hannah', site: 'WOUND', detail: 'Right big toe ulcer', why: 'Red and swollen around the ulcer, pus on the dressing, temp 38.1.', days: 1, state: 'CONFIRMED',
    confirm: ['Infected diabetic foot ulcer, right big toe', 'Dr Li: clinical; X-ray shows no bone change yet.', 'hannah', 0.9],
    entries: [['EVIDENCE', 'CRP 96, white cells 14; X-ray: soft tissue swelling only', null, 'hannah', 0.95], ['TREATMENT', 'Oral doxycycline started', null, 'hannah', 0.9],
      ['ORGANISM', 'Staphylococcus aureus (wound swab)', 'MRSA', 'nicki', 0.4], ['SUSCEPTIBILITY', 'Doxycycline', 'S', 'nicki', 0.4], ['SUSCEPTIBILITY', 'Flucloxacillin', 'R', 'nicki', 0.4],
      ['SOURCE_CONTROL', 'Surgical debridement of the ulcer', 'PLANNED', 'hannah', 0.3], ['RESPONSE', 'Redness spreading past the pen line', 'WORSE', 'nicki', 0.1]] });
  inf({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'nicki', site: 'LINE', detail: 'Left forearm cannula', why: 'Red, tender track above the cannula; temp 37.9.', days: 0.1, state: 'SUSPECTED' });
  inf({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', site: 'URINE', why: 'Newly confused this morning, going to the toilet often, urine cloudy and smelly.', days: 0.2, state: 'SUSPECTED',
    entries: [['EVIDENCE', 'Temp 37.8; urine dipstick: leucocytes and nitrites positive; sample sent', null, 'nicki', 0.15]] });
  inf({ nhi: 'ZZZ0067', svc: 'svc-arc', u: 'nicki', site: 'URINE', why: 'Burning passing urine and new incontinence.', days: 40, state: 'RESOLVED',
    confirm: ['Lower urinary tract infection', 'Dr Priya Nair (GP) by phone: symptoms and urine culture.', 'nicki', 38],
    end: ['Symptoms gone; antibiotics finished.', 'nicki', 30],
    entries: [['EVIDENCE', 'Urine culture: E. coli >10^8', null, 'nicki', 38], ['ORGANISM', 'Escherichia coli (urine)', 'ESBL', 'nicki', 38],
      ['SUSCEPTIBILITY', 'Nitrofurantoin', 'S', 'nicki', 38], ['TREATMENT', 'Nitrofurantoin for 5 days (GP)', null, 'nicki', 38]] });
}

// Antimicrobial courses (Shared Lifecycle Object 290), for the infections in set 48. On Ward K:
// Aroha's IV amoxicillin and clavulanic acid, day 3 with the 48-hour review due today and a
// sputum result that allows a narrower agent; Sione's doxycycline for MRSA, review also due today. At
// Kōwhai: Frank's trimethoprim started on the GP's advice, urine culture pending; Elsie's
// nitrofurantoin last month, completed with its outcome recorded; Losa's cefalexin for cellulitis,
// due to finish today.
function set49(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const day = 24 * 60;
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface C { nhi: string; svc: string; u: string; site: string; agent: string; route: string; dose: string; order: string; intent: string; startDays: number; days: number; review: number;
    note?: string; micro?: [string, string, number]; state?: string; ended?: [number, string]; outcome?: [string, string]; indication?: string }
  const course = (x: C) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const inf = store.get<{ id: string; source: string | null }>('SELECT id, source FROM infection WHERE person_id = ? AND site = ? ORDER BY raised_at DESC', pid, x.site);
    const id = newId();
    const start = addDays(todayLocal(), -x.startDays);
    const state = x.state ?? 'ACTIVE';
    store.insert('antimicrobial_course', {
      id, person_id: pid, service_id: x.svc, infection_id: inf?.id ?? null, indication: x.indication ?? inf?.source ?? 'Suspected infection', intent: x.intent, agent: x.agent, route: x.route,
      dose: x.dose, order_ref: x.order, start_date: start, planned_days: x.days, end_date: addDays(start, x.days), review_by: addDays(todayLocal(), x.review),
      micro: x.micro?.[0] ?? null, micro_note: x.micro?.[1] ?? null, state, previous_id: null, next_id: null, change_type: null,
      decided_by: by, decided_at: ago(x.startDays * day), decision_note: x.note ?? null,
      stop_reason: null, ended_by: x.ended ? by : null, ended_at: x.ended ? ago(x.ended[0] * day) : null, ended_note: x.ended?.[1] ?? null,
      outcome: x.outcome?.[0] ?? null, outcome_note: x.outcome?.[1] ?? null, outcome_by: x.outcome ? by : null, outcome_at: x.outcome ? ago((x.ended?.[0] ?? 0) * day - 60) : null,
    });
    const log = (kind: string, body: string, days: number) => store.insert('antimicrobial_log', { id: newId(), course_id: id, kind, body, by_id: by, at: ago(days * day) });
    const move = (from: string | null, to: string, days: number) =>
      store.insert('state_transition', { id: newId(), object_type: 'antimicrobial', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(days * day), reason: null, transaction_id: null });
    log('STARTED', `${x.agent} ${x.route === 'IV' ? 'IV' : x.route === 'ORAL' ? 'Oral' : x.route} ${x.dose} for ${x.days} days (${x.order}).${x.note ? ` ${x.note}` : ''}`, x.startDays);
    move(null, 'ACTIVE', x.startDays);
    if (x.micro) log('MICRO', `${x.micro[1]}.`, x.micro[2]);
    if (x.ended) { log(state, x.ended[1], x.ended[0]); move('ACTIVE', state, x.ended[0]); }
    if (x.outcome) log('OUTCOME', `${x.outcome[1]}`, x.ended?.[0] ?? 0);
  };
  course({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'hannah', site: 'CHEST', agent: 'Amoxicillin and clavulanic acid', route: 'IV', dose: '1.2 g every 8 hours', order: 'Medication chart',
    intent: 'EMPIRICAL', startDays: 2, days: 7, review: 0, micro: ['COVERED', 'Sputum: Streptococcus pneumoniae, sensitive to amoxicillin and penicillin', 1] });
  course({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'hannah', site: 'WOUND', agent: 'Doxycycline', route: 'ORAL', dose: '100 mg twice a day', order: 'Medication chart',
    intent: 'EMPIRICAL', startDays: 1, days: 14, review: 0, micro: ['COVERED', 'Wound swab: MRSA, sensitive to doxycycline, resistant to flucloxacillin', 0.4] });
  course({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', site: 'URINE', agent: 'Trimethoprim', route: 'ORAL', dose: '300 mg at night', order: 'GP prescription',
    intent: 'EMPIRICAL', startDays: 0, days: 3, review: 2, note: 'Dr Nair (GP) by phone.', micro: ['PENDING', 'Urine sent for culture', 0.1] });
  course({ nhi: 'ZZZ0067', svc: 'svc-arc', u: 'nicki', site: 'URINE', agent: 'Nitrofurantoin', route: 'ORAL', dose: '50 mg four times a day', order: 'GP prescription',
    intent: 'TARGETED', startDays: 38, days: 5, review: -36, note: 'Dr Nair (GP) after the culture.', micro: ['COVERED', 'Urine: ESBL E. coli, sensitive to nitrofurantoin', 38],
    state: 'COMPLETED', ended: [33, 'Last dose given.'], outcome: ['CURED', 'Infection cured.'] });
  course({ nhi: 'ZZZ0083', svc: 'svc-arc', u: 'nicki', site: 'NONE', indication: 'Cellulitis of the left shin (GP diagnosis)', agent: 'Cefalexin', route: 'ORAL', dose: '500 mg four times a day',
    order: 'GP prescription', intent: 'EMPIRICAL', startDays: 5, days: 5, review: -3, note: 'Dr Nair (GP) at her visit.' });
}

// Set 50: procedure site and side checks. Peggy's left knee aspiration is part-checked; Wiremu's
// pleural tap is stopped because the imaging report says left, not right; Sione's toe debridement is
// verified and ready. In Residential Care, Rua's ear irrigation is part-checked and Frank's skin
// lesion removal was done last week on the verified site.
function set50(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  type K = [kind: string, outcome: string | null, mins: number, extra?: { source?: string; stated?: string; note?: string }];
  interface V { nhi: string; svc: string; u: string; procedure: string; inMins: number; plannedMins: number; site: string; side: string; detail?: string; checks: K[];
    state?: string; verifiedMins?: number; done?: [mins: number, ref: string] }
  const plan = (x: V) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const state = x.state ?? 'PLANNED';
    const where = `${x.side !== 'NOT_APPLICABLE' ? `${({ LEFT: 'Left', RIGHT: 'Right', BILATERAL: 'Both sides', MIDLINE: 'Midline' } as Record<string, string>)[x.side]} ` : ''}${x.site.toLowerCase()}${x.detail ? ` (${x.detail})` : ''}`;
    store.insert('site_verification', {
      id, person_id: pid, service_id: x.svc, procedure: x.procedure, planned_for: ago(-x.inMins), site: x.site, side: x.side, detail: x.detail ?? null, state,
      planned_by: by, planned_at: ago(x.plannedMins), verified_by: x.verifiedMins !== undefined ? by : null, verified_at: x.verifiedMins !== undefined ? ago(x.verifiedMins) : null,
      done_by: x.done ? by : null, done_at: x.done ? ago(x.done[0]) : null, done_ref: x.done?.[1] ?? null, done_mismatch: 0, done_note: null,
    });
    const check = (kind: string, outcome: string | null, mins: number, e: K[3] = {}) => store.insert('site_check', {
      id: newId(), verification_id: id, kind, source: e.source ?? null, outcome, stated: e.stated ?? null, note: e.note ?? null, superseded: 0, by_id: by, at: ago(mins),
    });
    const move = (from: string | null, to: string, mins: number) =>
      store.insert('state_transition', { id: newId(), object_type: 'sitecheck', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
    check('PLANNED', null, x.plannedMins, { note: `${x.procedure}: ${where}.` });
    move(null, 'PLANNED', x.plannedMins);
    for (const [kind, outcome, mins, e] of x.checks) {
      check(kind, outcome, mins, e);
      if (outcome === 'MISMATCH') move('PLANNED', 'DISCREPANCY', mins);
    }
    if (x.verifiedMins !== undefined) { check('VERIFIED', null, x.verifiedMins, { note: `${where}.` }); move('PLANNED', 'VERIFIED', x.verifiedMins); }
    if (x.done) { check('DONE', 'MATCH', x.done[0], { note: `${x.done[1]}. Done on the verified site.` }); move('VERIFIED', 'DONE', x.done[0]); }
  };
  plan({ nhi: 'ZZZ0032', svc: 'svc-genmed', u: 'hannah', procedure: 'Knee aspiration', inMins: 150, plannedMins: 180, site: 'Knee', side: 'LEFT', detail: 'suprapatellar approach',
    checks: [['SOURCE', 'MATCH', 170, { source: 'NOTES', note: 'Ward round note: hot swollen left knee.' }], ['PATIENT', 'MATCH', 60, { note: 'Peggy pointed to her left knee.' }]] });
  plan({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'hannah', procedure: 'Pleural tap', inMins: 90, plannedMins: 240, site: 'Chest', side: 'RIGHT', detail: 'posterior, below the scapula',
    state: 'DISCREPANCY',
    checks: [['SOURCE', 'MATCH', 230, { source: 'NOTES' }], ['SOURCE', 'MISMATCH', 40, { source: 'IMAGING', stated: 'Left pleural effusion', note: 'Chest X-ray report from this morning.' }]] });
  plan({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'hannah', procedure: 'Debridement of toe ulcer', inMins: 60, plannedMins: 300, site: 'Big toe', side: 'RIGHT', state: 'VERIFIED', verifiedMins: 20,
    checks: [['SOURCE', 'MATCH', 290, { source: 'CONSENT' }], ['PATIENT', 'MATCH', 45], ['MARK', 'MATCH', 40, { note: 'Arrow marked on the right foot.' }], ['TEAM', 'MATCH', 20, { note: 'Time-out with Nicki.' }]] });
  plan({ nhi: 'ZZZ0059', svc: 'svc-arc', u: 'nicki', procedure: 'Ear irrigation', inMins: 240, plannedMins: 600, site: 'Ear', side: 'LEFT',
    checks: [['SOURCE', 'MATCH', 590, { source: 'REFERRAL', note: 'GP request: wax in the left ear.' }]] });
  plan({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', procedure: 'Skin lesion removal', inMins: -6 * 1440, plannedMins: 8 * 1440, site: 'Forearm', side: 'RIGHT', detail: 'back of the forearm',
    state: 'DONE', verifiedMins: 6 * 1440 + 30, done: [6 * 1440, 'GP procedure note'],
    checks: [['SOURCE', 'MATCH', 8 * 1440 - 60, { source: 'REFERRAL' }], ['PATIENT', 'MATCH', 6 * 1440 + 60], ['MARK', 'MATCH', 6 * 1440 + 50], ['TEAM', 'MATCH', 6 * 1440 + 30]] });
}

// Set 51: clinical readiness. On Ward K, Wiremu's discharge home still has essentials to do, Peggy is
// waiting for a decision on walking to the bathroom, and Sione's toe debridement was ready only with a
// condition that is due to be reassessed today. Physiotherapy is working through Peggy's stairs
// practice. In Residential Care, Frank was not ready to walk again after his fall and is reassessed tomorrow.
function set51(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const TEMPLATES: Record<string, [string, boolean][]> = {
    PROCEDURE: [['Consent recorded', true], ['Allergies confirmed', true], ['Fasting as instructed', true], ['Blood tests reviewed', true],
      ['Blood thinners held, or a plan in place', true], ['Site and side checked', true]],
    DISCHARGE: [['Medically stable', true], ['Medicines reconciled and supplied', true], ['Safe to move around at home', true], ['Supports at home arranged', true],
      ['Discharge summary written', true], ['Follow-up booked', false], ['Whānau told', false]],
    MOBILISE: [['Observations within limits', true], ['Pain controlled', true], ['Weight-bearing instructions known', true], ['Enough staff to help', true],
      ['Walking aid available', false]],
    THERAPY: [['Medically fit for therapy', true], ['Agreed to therapy', true], ['Goals agreed with the person', true], ['Pain controlled', false]],
  };
  const KIND: Record<string, string> = { PROCEDURE: 'For a procedure', DISCHARGE: 'To go home or leave', MOBILISE: 'To get up and walk', THERAPY: 'For therapy' };
  interface R { nhi: string; svc: string; u: string; kind: string; purpose: string; neededBy?: number; raisedMins: number;
    done: Record<string, string | [string, string]>; decision?: [state: string, mins: number, note: string | null, conditions: string | null, reassess: number | null] }
  const raise = (x: R) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const state = x.decision?.[0] ?? 'ASSESSING';
    store.insert('readiness', {
      id, person_id: pid, service_id: x.svc, kind: x.kind, purpose: x.purpose, needed_by: x.neededBy !== undefined ? addDays(todayLocal(), x.neededBy) : null, state,
      raised_by: by, raised_at: ago(x.raisedMins), decided_by: x.decision ? by : null, decided_at: x.decision ? ago(x.decision[1]) : null,
      decision_note: x.decision?.[2] ?? null, conditions: x.decision?.[3] ?? null, reassess_by: x.decision?.[4] != null ? addDays(todayLocal(), x.decision[4]) : null,
    });
    const log = (kind: string, body: string, mins: number) => store.insert('readiness_log', { id: newId(), readiness_id: id, kind, body, by_id: by, at: ago(mins) });
    const move = (from: string | null, to: string, mins: number) =>
      store.insert('state_transition', { id: newId(), object_type: 'readiness', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
    log('RAISED', `${KIND[x.kind]}: ${x.purpose}.`, x.raisedMins);
    move(null, 'ASSESSING', x.raisedMins);
    TEMPLATES[x.kind].forEach(([label, essential], n) => {
      const d = x.done[label];
      const [status, note] = d === undefined ? ['OUTSTANDING', null] : Array.isArray(d) ? d : [d, null];
      const at = Math.round(x.raisedMins * 0.6) - n;
      store.insert('readiness_item', {
        id: newId(), readiness_id: id, label, essential: essential ? 1 : 0, status, note, done_by: d === undefined ? null : by, done_at: d === undefined ? null : ago(at),
        position: n, added_by: by, added_at: ago(x.raisedMins),
      });
      if (d !== undefined) log('ITEM', `${label}: ${status === 'COMPLETED' ? 'done' : 'not applicable'}.${note ? ` ${note}` : ''}`, at);
    });
    if (x.decision) {
      const [st, mins, note, cond, re] = x.decision;
      log(st, [cond ? `Conditions: ${cond}.` : '', note ?? '', re != null ? `Reassess by ${addDays(todayLocal(), re)}.` : ''].filter(Boolean).join(' '), mins);
      move('ASSESSING', st, mins);
    }
  };
  const C = 'COMPLETED';
  raise({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'nicki', kind: 'DISCHARGE', purpose: 'Home with Ana', neededBy: 3, raisedMins: 600,
    done: { 'Medicines reconciled and supplied': C, 'Supports at home arranged': [C, 'District nurse twice a week from Monday'] } });
  raise({ nhi: 'ZZZ0032', svc: 'svc-genmed', u: 'nicki', kind: 'MOBILISE', purpose: 'Walk to the bathroom with a frame', raisedMins: 300,
    done: { 'Observations within limits': C, 'Pain controlled': C, 'Weight-bearing instructions known': [C, 'Full weight-bearing'], 'Enough staff to help': C } });
  raise({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'hannah', kind: 'PROCEDURE', purpose: 'Debridement of toe ulcer', raisedMins: 1500,
    done: { 'Consent recorded': C, 'Allergies confirmed': C, 'Fasting as instructed': ['NOT_APPLICABLE', 'Local anaesthetic only'], 'Blood tests reviewed': C,
      'Blood thinners held, or a plan in place': ['NOT_APPLICABLE', 'None charted'], 'Site and side checked': C },
    decision: ['CONDITIONAL', 1400, 'Fit for debridement under local.', 'Only once his blood glucose is under 15 on the morning check', 0] });
  raise({ nhi: 'ZZZ0032', svc: 'svc-physio', u: 'lena', kind: 'THERAPY', purpose: 'Stairs practice', raisedMins: 200,
    done: { 'Goals agreed with the person': [C, 'Manage the 3 steps at her daughter\'s front door'] } });
  raise({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', kind: 'MOBILISE', purpose: 'Walking again with his frame after the fall', raisedMins: 3200,
    done: { 'Observations within limits': C, 'Weight-bearing instructions known': [C, 'X-ray clear; weight-bear as able'], 'Enough staff to help': C, 'Walking aid available': C },
    decision: ['NOT_READY', 2900, 'Hip pain 7/10 on standing; hoist for transfers until pain is controlled.', null, 1] });
}

// Set 52: clinical exceptions and variances. On Ward K, Aroha declined her enoxaparin and Peggy was
// not turned for four hours overnight, both waiting for a decision; Wiremu missed his daily weight
// while at X-ray and is weighed on return today. In Residential Care, Frank's paracetamol was two hours
// late (a mistake) and his pain is being watched, and Losa declined her lunchtime glucose check.
function set52(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const DECISIONS: Record<string, string> = { ACCEPT: 'Accept: no change needed', ALTERNATIVE: 'Do something else instead', RESCHEDULE: 'Do it later', ESCALATE: 'Escalate for review' };
  const REASONS: Record<string, string> = { DECLINED: 'the person declined', NOT_POSSIBLE: 'the person was not available (away, asleep, fasting)', UNAVAILABLE: 'staff, stock or equipment not available', ERROR: 'a mistake or omission' };
  interface V { nhi: string; svc: string; u: string; decider?: string; category: string; expected: string; what: string; reason: string; context: string; mins: number;
    decided?: [decision: string, action: string | null, mins: number, followUpDays: number, watch: string] }
  const add = (x: V) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    const dby = x.decider ? who(x.decider) : by;
    if (!pid || !by || !dby) return;
    const id = newId();
    const state = x.decided ? 'MONITORING' : 'RECORDED';
    store.insert('variance', {
      id, person_id: pid, service_id: x.svc, category: x.category, expected: x.expected, what_happened: x.what, reason: x.reason, context: x.context,
      occurred_at: ago(x.mins), state, recorded_by: by, recorded_at: ago(x.mins - 10),
      decision: x.decided?.[0] ?? null, action: x.decided?.[1] ?? null, decided_by: x.decided ? dby : null, decided_at: x.decided ? ago(x.decided[2]) : null,
      follow_up_by: x.decided ? addDays(todayLocal(), x.decided[3]) : null, watch: x.decided?.[4] ?? null,
    });
    const log = (kind: string, body: string, mins: number, b: string) => store.insert('variance_log', { id: newId(), variance_id: id, kind, body, by_id: b, at: ago(mins) });
    const move = (from: string | null, to: string, mins: number, b: string) =>
      store.insert('state_transition', { id: newId(), object_type: 'variance', object_id: id, from_state: from, to_state: to, actor_id: b, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
    log('RECORDED', `Expected: ${x.expected}. Instead: ${x.what}. Why: ${REASONS[x.reason]}. ${x.context}`, x.mins - 10, by);
    move(null, 'RECORDED', x.mins - 10, by);
    if (x.decided) {
      const [d, act, mins, days, watch] = x.decided;
      log('DECIDED', [`${DECISIONS[d]}.`, act, `Follow up by ${addDays(todayLocal(), days)}: ${watch}.`].filter(Boolean).join(' '), mins, dby);
      move('RECORDED', 'MONITORING', mins, dby);
    }
  };
  add({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'nicki', category: 'MEDICATION', expected: 'Enoxaparin 40 mg at 1800', what: 'Not given', reason: 'DECLINED',
    context: 'Says the injections bruise her and she is walking the ward now. Platelets normal.', mins: 14 * 60 });
  add({ nhi: 'ZZZ0032', svc: 'svc-genmed', u: 'nicki', category: 'CARE', expected: 'Turn every 2 hours overnight', what: 'Not turned from 0200 to 0600', reason: 'UNAVAILABLE',
    context: 'One nurse short overnight and two admissions. Skin intact over sacrum and heels this morning.', mins: 5 * 60 });
  add({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'nicki', decider: 'hannah', category: 'MONITORING', expected: 'Daily weight before breakfast', what: 'Not weighed', reason: 'NOT_POSSIBLE',
    context: 'Went to X-ray at 0700. Heart failure on furosemide; fluid restricted.', mins: 3 * 60,
    decided: ['RESCHEDULE', 'Weigh on return from X-ray, same scales', 2 * 60, 0, 'A gain of more than 1 kg since yesterday'] });
  add({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', category: 'MEDICATION', expected: 'Paracetamol 1 g at 0800', what: 'Given at 1000', reason: 'ERROR',
    context: 'Missed on the morning round. Hip pain after his fall.', mins: 26 * 60,
    decided: ['ACCEPT', null, 25 * 60, 1, 'Pain score before each walk; next dose not before 1400'] });
  add({ nhi: 'ZZZ0083', svc: 'svc-arc', u: 'kate', category: 'MONITORING', expected: 'Blood glucose before lunch', what: 'Not done', reason: 'DECLINED',
    context: 'Said her fingers are sore. Ate all her lunch; no signs of a low.', mins: 90 });
}

// Set 53: declined care. On Ward K, Aroha declined her enoxaparin and is offered it again today;
// Wiremu, who is confused, declined a new drip, which is high risk and not yet escalated; Sione
// declined overnight glucose checks. In Residential Care, Rua wanted a wash in bed instead of a shower,
// and Frank's refusal of oxygen has been escalated to his GP.
function set53(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  interface D { nhi: string; svc: string; u: string; category: string; offered: string; information: string; reason?: string; implications: string; risk: string;
    plan?: string; reoffer?: number; mins: number; concern?: boolean; escalated?: [to: string, mins: number] }
  const add = (x: D) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const state = x.escalated ? 'ESCALATED' : 'DECLINED';
    store.insert('declined_care', {
      id, person_id: pid, service_id: x.svc, category: x.category, offered: x.offered, information: x.information, decided_by: 'PERSON', representative: null,
      capacity_concern: x.concern ? 1 : 0, reason: x.reason ?? null, implications: x.implications, risk: x.risk, plan: x.plan ?? null,
      reoffer_by: x.reoffer !== undefined ? addDays(todayLocal(), x.reoffer) : null, offered_at: ago(x.mins), state, recorded_by: by, recorded_at: ago(x.mins - 5),
      escalated_to: x.escalated?.[0] ?? null, escalated_at: x.escalated ? ago(x.escalated[1]) : null,
    });
    const log = (kind: string, body: string, mins: number) => store.insert('declined_log', { id: newId(), declined_id: id, kind, body, by_id: by, at: ago(mins) });
    const move = (from: string | null, to: string, mins: number) =>
      store.insert('state_transition', { id: newId(), object_type: 'declined', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
    log('DECLINED', [`${x.offered} declined by the person.`, `Told: ${x.information}.`, x.reason ? `Reason: ${x.reason}.` : 'No reason given.',
      `Means: ${x.implications}.`, x.plan ? `Plan: ${x.plan}.` : '', x.concern ? 'Concern about their capacity to decide.' : ''].filter(Boolean).join(' '), x.mins - 5);
    move(null, 'DECLINED', x.mins - 5);
    if (x.escalated) { log('ESCALATED', `To ${x.escalated[0]}.`, x.escalated[1]); move('DECLINED', 'ESCALATED', x.escalated[1]); }
  };
  add({ nhi: 'ZZZ9999', svc: 'svc-genmed', u: 'nicki', category: 'MEDICINE', offered: 'Enoxaparin 40 mg injection',
    information: 'Explained it prevents clots in the legs and lungs, and the risk is higher in hospital', reason: 'The injections bruise her tummy',
    implications: 'Higher risk of a clot, though she is walking the ward', risk: 'MODERATE', plan: 'Compression stockings; walk the ward every 2 hours', reoffer: 0, mins: 14 * 60 });
  add({ nhi: 'ZZZ0016', svc: 'svc-genmed', u: 'nicki', category: 'TREATMENT', offered: 'New IV cannula for antibiotics',
    information: 'Explained the antibiotics treat his chest infection and work best through a drip', reason: 'Says he is going home and does not need it',
    implications: 'Chest infection with sepsis goes untreated; two IV doses due today', risk: 'HIGH', concern: true, mins: 50 });
  add({ nhi: 'ZZZ0024', svc: 'svc-genmed', u: 'nicki', category: 'TEST', offered: 'Blood glucose check at 0200',
    information: 'Explained his sugars have been high and overnight checks catch lows too', reason: 'Wants to sleep through',
    implications: 'A night-time low could be missed; evening reading was 9.8', risk: 'LOW', plan: 'Check at 0600 before breakfast', mins: 8 * 60 });
  add({ nhi: 'ZZZ0059', svc: 'svc-arc', u: 'kate', category: 'CARE', offered: 'Morning shower', information: 'Offered help with a shower as planned for Mondays',
    reason: 'Too cold today; would like a wash in bed', implications: 'None significant; skin care done with a bed wash', risk: 'LOW', plan: 'Bed wash today', reoffer: 1, mins: 3 * 60 });
  add({ nhi: 'ZZZ0075', svc: 'svc-arc', u: 'nicki', category: 'TREATMENT', offered: 'Oxygen through nasal prongs', information: 'Explained his oxygen level is 89% and oxygen helps his breathing and thinking',
    reason: 'Says it dries his nose and he feels fine', implications: 'Low oxygen may worsen his drowsiness and confusion', risk: 'HIGH', mins: 100,
    escalated: ['Dr Anna Whyte (GP) by phone', 80] });
}

// Set 54: clinical priority. In ED, Kiri (ATS 2) and Tom (ATS 3) were seen within their timeframes
// and Ana's ankle (ATS 4) is past hers. On Ward K, Wiremu needs an urgent review and Peggy a routine
// medicines review; physiotherapy has Peggy's stairs practice as P2. In Residential Care, Frank needs
// a GP review today and Rua a routine one.
function set54(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const LEVELS: Record<string, [string, number]> = {
    'ATS 2': ['ATS 2: within 10 minutes', 10], 'ATS 3': ['ATS 3: within 30 minutes', 30], 'ATS 4': ['ATS 4: within 60 minutes', 60],
    URGENT: ['Urgent: within 1 hour', 60], ROUTINE: ['Routine: within 24 hours', 1440], TODAY: ['Today: within 8 hours', 480],
    ARC_ROUTINE: ['Routine: next GP visit, within 2 weeks', 20160], P2: ['P2: within 2 days', 2880],
  };
  const SOURCES: Record<string, string> = { PRESENTATION: 'Arrived or presented', REQUEST: 'Asked for a review', REFERRAL: 'Referral', CHANGE: 'Change in condition' };
  interface P { nhi: string; svc: string; scale: string; u: string; source: string; what: string; evidence: string; level: string; mins: number; acted?: [u: string, mins: number, note: string] }
  const add = (x: P) => {
    const pid = person(x.nhi);
    const by = who(x.u);
    if (!pid || !by) return;
    const id = newId();
    const [label, minutes] = LEVELS[x.level];
    const level = x.level === 'ARC_ROUTINE' ? 'ROUTINE' : x.level;
    const actor = x.acted ? who(x.acted[0]) : null;
    store.insert('priority', {
      id, person_id: pid, service_id: x.svc, scale: x.scale, source: x.source, what: x.what, evidence: x.evidence, level, level_at: ago(x.mins),
      due_at: ago(x.mins - minutes), state: x.acted ? 'ACTIONED' : 'WAITING', assigned_by: by, assigned_at: ago(x.mins),
      acted_by: actor, acted_at: x.acted ? ago(x.acted[1]) : null, action_note: x.acted?.[2] ?? null,
    });
    const log = (kind: string, body: string, mins: number, b: string) => store.insert('priority_log', { id: newId(), priority_id: id, kind, body, by_id: b, at: ago(mins) });
    const move = (from: string | null, to: string, mins: number, b: string) =>
      store.insert('state_transition', { id: newId(), object_type: 'priority', object_id: id, from_state: from, to_state: to, actor_id: b, work_context_id: null, at: ago(mins), reason: null, transaction_id: null });
    log('ASSIGNED', `${label}. ${SOURCES[x.source]}: ${x.what}. Evidence: ${x.evidence}`, x.mins, by);
    move(null, 'WAITING', x.mins, by);
    if (x.acted && actor) {
      log('ACTIONED', `${x.acted[2]} ${x.acted[1] >= x.mins - minutes ? 'Within the timeframe.' : 'Later than the timeframe.'}`, x.acted[1], actor);
      move('WAITING', 'ACTIONED', x.acted[1], actor);
    }
  };
  add({ nhi: 'ZZZ0105', svc: 'svc-ed', scale: 'ATS', u: 'mere', source: 'PRESENTATION', what: 'Central chest pain for 2 hours, radiating to left arm',
    evidence: 'Pain 8/10, sweaty, HR 98, BP 148/92', level: 'ATS 2', mins: 90, acted: ['ravi', 84, 'Seen by Dr Singh; ECG and troponin done.'] });
  add({ nhi: 'ZZZ0121', svc: 'svc-ed', scale: 'ATS', u: 'mere', source: 'PRESENTATION', what: 'Right ankle inversion injury playing netball',
    evidence: 'Can weight-bear 4 steps; swelling over lateral malleolus; pain 5/10', level: 'ATS 4', mins: 135 });
  add({ nhi: 'ZZZ0148', svc: 'svc-ed', scale: 'ATS', u: 'mere', source: 'PRESENTATION', what: 'Fall at home, on apixaban, small scalp laceration',
    evidence: 'GCS 15, 2 cm scalp laceration, on apixaban, no loss of consciousness', level: 'ATS 3', mins: 50, acted: ['ravi', 28, 'Seen by Dr Singh; CT head requested.'] });
  add({ nhi: 'ZZZ0016', svc: 'svc-genmed', scale: 'WARD', u: 'nicki', source: 'CHANGE', what: 'Doctor review: more confused, pulling at his drip',
    evidence: 'New confusion since morning, RR 22, not drinking, NEWS 5', level: 'URGENT', mins: 30 });
  add({ nhi: 'ZZZ0032', svc: 'svc-genmed', scale: 'WARD', u: 'nicki', source: 'REQUEST', what: 'Medicines review before discharge',
    evidence: 'Daughter asked about her 11 regular medicines; discharge planned this week', level: 'ROUTINE', mins: 180 });
  add({ nhi: 'ZZZ0032', svc: 'svc-physio', scale: 'PHYSIO', u: 'lena', source: 'REFERRAL', what: 'Stairs practice before discharge',
    evidence: 'Three steps at her daughter\'s front door; walks 20 m with a frame', level: 'P2', mins: 1440 });
  add({ nhi: 'ZZZ0075', svc: 'svc-arc', scale: 'ARC', u: 'nicki', source: 'CHANGE', what: 'GP review: drowsy, oxygen 89%',
    evidence: 'Drowsy but rousable, SpO2 89% on air, declining oxygen, hip pain after fall', level: 'TODAY', mins: 120 });
  add({ nhi: 'ZZZ0059', svc: 'svc-arc', scale: 'ARC', u: 'kate', source: 'REQUEST', what: 'GP to check her left ear after irrigation',
    evidence: 'Hearing still reduced on the left after wax softening drops', level: 'ARC_ROUTINE', mins: 1440 });
}

// Set 55: identity matching. An unidentified man brought in by ambulance has a temporary identity;
// he is Tipene Walker, known to SHIFT from an emergency visit last year with a penicillin allergy.
// Kiri's arrival this morning was matched to his record on his NHI and date of birth.
function set55(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const person = (nhi: string) => store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi)?.id ?? null;
  const mere = who('mere');
  if (!mere) return;
  const S = 'SYNTHETIC';
  const move = (id: string, from: string | null, to: string, mins: number, reason: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'identity_match', object_id: id, from_state: from, to_state: to, actor_id: mere, work_context_id: null, at: ago(mins), reason, transaction_id: null });
  const log = (id: string, kind: string, body: string, mins: number) => store.insert('identity_match_log', { id: newId(), match_id: id, kind, body, by_id: mere, at: ago(mins) });

  // Tipene Walker: known from an emergency visit last year.
  if (!person('ZZZ0172')) {
    const tipene = newId();
    store.insert('person', { id: tipene, family_name: 'Walker', given_name: 'Tipene', date_of_birth: '1971-03-14', gender: 'Male', ethnicity: 'Māori', iwi: 'Ngāpuhi', data_source: S, created_at: ago(400 * 1440) });
    store.insert('external_identifier', { id: newId(), person_id: tipene, system: 'NHI', value: 'ZZZ0172', verification: S, created_at: ago(400 * 1440) });
    store.insert('encounter', { id: newId(), person_id: tipene, service_id: 'svc-ed', location: 'Cubicle 6', kind: 'EMERGENCY', started_at: ago(400 * 1440), ended_at: ago(400 * 1440 - 300), state: 'ENDED' });
    store.insert('allergy', { id: newId(), person_id: tipene, kind: 'ALLERGY', substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'SEVERE', certainty: 'CONFIRMED', state: 'ACTIVE',
      source: 'Emergency department record, confirmed with GP record', recorded_by: mere, recorded_at: ago(400 * 1440), data_source: S });
  }

  // Unidentified Male A: brought in by ambulance 40 minutes ago.
  const temp = newId();
  store.insert('person', { id: temp, family_name: 'Male A', given_name: 'Unidentified', date_of_birth: null, gender: 'Male', data_source: 'LOCAL', created_at: ago(40) });
  store.insert('encounter', { id: newId(), person_id: temp, service_id: 'svc-ed', location: 'Resus 2', kind: 'EMERGENCY', started_at: ago(40), state: 'ACTIVE' });
  const m1 = newId();
  store.insert('identity_match', {
    id: m1, person_id: temp, service_id: 'svc-ed', source: 'AMBULANCE', stated_gender: 'MALE', temporary: 1, state: 'UNRESOLVED',
    description: 'Man about 50, collapsed at a bus stop on Queen St. No wallet or phone; drowsy, cannot give his name.', registered_by: mere, registered_at: ago(40),
  });
  move(m1, null, 'UNRESOLVED', 40, 'Ambulance handover');
  log(m1, 'REGISTERED', 'Ambulance handover: Male. Man about 50, collapsed at a bus stop on Queen St. No wallet or phone; drowsy, cannot give his name.', 40);
  log(m1, 'TEMPORARY', 'Care can start under the temporary identity. Identify them as soon as possible.', 40);

  // Kiri Moana: matched on arrival this morning.
  const daniel = person('ZZZ0105');
  const enc = daniel ? store.get<{ r: number; at: string }>("SELECT rowid AS r, started_at AS at FROM encounter WHERE person_id = ? AND service_id = 'svc-ed' AND state = 'ACTIVE'", daniel) : undefined;
  const p = daniel ? store.get<{ given_name: string; family_name: string; date_of_birth: string; gender: string }>('SELECT given_name, family_name, date_of_birth, gender FROM person WHERE id = ?', daniel) : undefined;
  if (daniel && enc && p) {
    const snapshot: Record<string, number> = {};
    for (const t of store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      if (!store.all<{ name: string }>(`PRAGMA table_info(${t.name})`).some((c) => c.name === 'person_id')) continue;
      snapshot[t.name] = t.name === 'encounter' ? enc.r - 1 : store.get<{ m: number | null }>(`SELECT max(rowid) AS m FROM ${t.name}`)?.m ?? 0;
    }
    const mins = Math.round((Date.now() - Date.parse(enc.at)) / 60_000);
    const evidence = { personId: daniel, name: `${p.given_name} ${p.family_name}`, nhi: 'ZZZ0105', dob: p.date_of_birth, gender: p.gender, agree: ['NHI', 'DOB', 'FAMILY', 'GIVEN'], differ: [],
      enough: true, agreeLabel: 'NHI, Date of birth, Family name, Given name', differLabel: '' };
    const m2 = newId();
    store.insert('identity_match', {
      id: m2, person_id: daniel, service_id: 'svc-ed', source: 'PERSON', stated_given: p.given_name, stated_family: p.family_name, stated_nhi: 'ZZZ0105', stated_dob: p.date_of_birth,
      stated_gender: 'MALE', evidence: JSON.stringify(evidence), temporary: 0, state: 'CONFIRMED', registered_by: mere, registered_at: enc.at, manifest: JSON.stringify({ snapshot }),
    });
    move(m2, null, 'CONFIRMED', mins, 'The person told us');
    log(m2, 'REGISTERED', `The person told us: ${p.given_name} ${p.family_name}, NHI ZZZ0105, born ${p.date_of_birth}, Male.`, mins);
    log(m2, 'MATCHED', `${p.given_name} ${p.family_name}. Agrees: NHI, Date of birth, Family name, Given name.`, mins);
  }
}

// Set 56: duplicate records. Physiotherapy outpatients made a local record for Margaret Oliver two
// years ago, before her NHI was known; it holds a codeine allergy her main record lacks. SHIFT
// spotted the pair yesterday.
function set56(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const main = store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = 'ZZZ0032'")?.id;
  const lena = who('lena');
  if (!main || !lena) return;
  const day = 1440;
  const dup = newId();
  store.insert('person', { id: dup, family_name: 'Oliver', given_name: 'Margaret', date_of_birth: '1938-09-30', gender: 'Female', ethnicity: 'NZ European', data_source: 'LOCAL', created_at: ago(700 * day) });
  store.insert('external_identifier', { id: newId(), person_id: dup, system: 'LOCAL_MRN', value: 'PHY-20417', verification: 'UNVERIFIED', created_at: ago(700 * day) });
  store.insert('encounter', { id: newId(), person_id: dup, service_id: 'svc-physio', location: 'Outpatient gym', kind: 'OUTPATIENT', started_at: ago(700 * day), ended_at: ago(640 * day), state: 'ENDED' });
  store.insert('allergy', { id: newId(), person_id: dup, kind: 'ALLERGY', substance: 'Codeine', reaction: 'Vomiting and confusion', severity: 'MODERATE', certainty: 'CONFIRMED', state: 'ACTIVE',
    source: 'Patient report at physiotherapy outpatients', recorded_by: lena, recorded_at: ago(700 * day), data_source: 'SYNTHETIC' });
  const id = newId();
  const evidence = { personId: main, name: 'Margaret Oliver', nhi: 'ZZZ0032', dob: '1938-09-30', gender: 'Female', agree: ['DOB', 'FAMILY', 'GIVEN', 'GENDER'], differ: [], enough: true,
    agreeLabel: 'Date of birth, Family name, Given name, Gender', differLabel: '' };
  store.insert('duplicate_case', {
    id, person_a: main, person_b: dup, detected_how: 'SHIFT', detected_by: null, detected_at: ago(day), state: 'POSSIBLE',
    reason: 'Same date of birth, family name, given name, gender.', evidence: JSON.stringify(evidence),
  });
  store.insert('state_transition', { id: newId(), object_type: 'duplicate_case', object_id: id, from_state: null, to_state: 'POSSIBLE', actor_id: lena, work_context_id: null, at: ago(day), reason: 'Spotted by SHIFT', transaction_id: null });
  store.insert('duplicate_log', { id: newId(), case_id: id, kind: 'DETECTED', body: 'Two records agree on Date of birth, Family name, Given name, Gender.', by_id: null, at: ago(day) });
}

// Set 57: break-glass access. In the last hour Mere, in ED, opened Rua Hēnare's residential care
// record in an emergency. The hour has passed, so the use is waiting for Dr Ravi Singh to review,
// with what she looked at listed from the audit trail.
function set57(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const mere = store.get<{ id: string }>("SELECT id FROM workforce_person WHERE username = 'mere'")?.id;
  const rua = store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = 'ZZZ0059'")?.id;
  const pos = store.get<{ id: string }>(
    "SELECT p.id FROM position p JOIN employment e ON e.id = p.employment_id WHERE e.workforce_person_id = ? AND p.service_id = 'svc-ed'", mere ?? '',
  )?.id;
  if (!mere || !rua || !pos) return;
  const session = newId();
  const ctx = newId();
  store.insert('session', { id: session, token_hash: `seed-${newId()}`, workforce_person_id: mere, created_at: ago(65), last_seen_at: ago(1), ended_at: ago(1), end_reason: 'SIGNED_OUT' });
  store.insert('work_context', { id: ctx, session_id: session, workforce_person_id: mere, position_id: pos, service_id: 'svc-ed', established_at: ago(65), ended_at: ago(1) });
  const id = newId();
  const reason = 'Brought in by ambulance unresponsive from the rest home; need her allergies, medicines and goals of care.';
  // What she looked at is written to the audit trail first, so it falls inside the hour of access.
  const base = { actorId: mere, sessionId: session, workContextId: ctx, space: 'WORK' as const, subjectPersonId: rua, purpose: 'DIRECT_CARE', decision: 'ALLOW' };
  audit(store, { ...base, operation: 'BREAK_GLASS_OPEN', objectType: 'exceptional_access', objectId: id, outcome: 'COMMITTED', reason: reason.slice(0, 200), ruleRefs: ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-BREAKGLASS-001'], engines: [26] });
  audit(store, { ...base, operation: 'VIEW_RECORD', objectType: 'person', outcome: 'VIEWED' });
  for (const code of ['allergies', 'meds', 'goals', 'careplan']) audit(store, { ...base, operation: 'RETRIEVE', objectType: `?${code}`, outcome: 'VIEWED' });
  const end = new Date(Date.now() + 1000).toISOString();
  const start = ago(59);
  store.insert('exceptional_access', {
    id, work_context_id: ctx, workforce_person_id: mere, person_id: rua, reason, granted_at: start, expires_at: end, kind: 'EMERGENCY',
    service_id: 'svc-ed', state: 'ENDED', decided_at: start, ended_at: end,
  });
  const step = (from: string | null, to: string, at: string, why: string) => store.insert('state_transition', {
    id: newId(), object_type: 'exceptional_access', object_id: id, from_state: from, to_state: to, actor_id: mere, work_context_id: from ? null : ctx, at, reason: why, transaction_id: null,
  });
  step(null, 'ACTIVE', start, reason);
  step('ACTIVE', 'ENDED', end, 'Time limit reached');
  store.insert('exceptional_access_log', { id: newId(), access_id: id, kind: 'OPENED', body: `Emergency: life or serious harm at risk now. ${reason} Open for 60 minutes.`, by_id: mere, at: start });
  store.insert('exceptional_access_log', { id: newId(), access_id: id, kind: 'EXPIRED', body: 'Access closed at the end of its time limit.', by_id: mere, at: end });
}

// Set 58: delegation. In Residential Care, Kate has asked Tama to reposition Frank, and Tama has
// finished Elsie's blood glucose checks for Nicki to check. On the medical ward, Dr Hannah Li has
// asked Nicki to take Aroha's bloods.
function set58(store: Store): void {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const later = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
  const who = (u: string) => store.get<{ id: string }>('SELECT id FROM workforce_person WHERE username = ?', u)?.id ?? null;
  const pt = (given: string, family: string) => store.get<{ id: string }>('SELECT id FROM person WHERE given_name = ? AND family_name = ? AND merged_into IS NULL ORDER BY created_at LIMIT 1', given, family)?.id ?? null;
  const [kate, nicki, tama, hannah] = [who('kate'), who('nicki'), who('tama'), who('hannah')];
  const [frank, elsie, aroha] = [pt('Frank', 'Dawson'), pt('Elsie', 'Morgan'), pt('Aroha', 'Rangi')];
  if (!kate || !nicki || !tama || !hannah || !frank || !elsie || !aroha) return;
  const add = (d: { person: string; service: string; activity: string; label: string; instructions: string; reportIf: string; by: string; to: string; toName: string; at: number; hours: number; review: boolean }) => {
    const id = newId();
    store.insert('delegation', {
      id, person_id: d.person, service_id: d.service, activity: d.activity, instructions: d.instructions, report_if: d.reportIf, delegator_id: d.by, delegate_id: d.to,
      starts_at: ago(d.at), ends_at: later(d.hours * 60 - d.at), state: 'OFFERED', competence_confirmed: 1, review_required: d.review ? 1 : 0, created_at: ago(d.at),
    });
    store.insert('state_transition', { id: newId(), object_type: 'delegation', object_id: id, from_state: null, to_state: 'OFFERED', actor_id: d.by, work_context_id: null, at: ago(d.at), reason: d.label, transaction_id: null });
    store.insert('delegation_log', { id: newId(), delegation_id: id, kind: 'OFFERED', body: `${d.label} to ${d.toName} for ${d.hours} h. ${d.instructions} Report straight back if: ${d.reportIf}${d.review ? ' Checked by the delegator when done.' : ''}`, by_id: d.by, at: ago(d.at) });
    return id;
  };
  const move = (id: string, from: string, to: string, by: string, at: number, why: string) =>
    store.insert('state_transition', { id: newId(), object_type: 'delegation', object_id: id, from_state: from, to_state: to, actor_id: by, work_context_id: null, at: ago(at), reason: why, transaction_id: null });
  const note = (id: string, kind: string, body: string, by: string, at: number) => store.insert('delegation_log', { id: newId(), delegation_id: id, kind, body, by_id: by, at: ago(at) });

  add({ person: frank, service: 'svc-arc', activity: 'REPOSITION', label: 'Reposition and check skin', instructions: 'Two-hourly turns this afternoon; check his heels and sacrum each time.',
    reportIf: 'Any new redness that does not fade, broken skin or pain.', by: kate, to: tama, toName: 'Tama Walker', at: 15, hours: 4, review: false });

  const bgl = add({ person: elsie, service: 'svc-arc', activity: 'BGL', label: 'Check blood glucose', instructions: 'Check before lunch and before tea, and record each reading in SHIFT.',
    reportIf: 'Below 4 or above 15 mmol/L, or she is drowsy or sweaty.', by: nicki, to: tama, toName: 'Tama Walker', at: 240, hours: 8, review: true });
  move(bgl, 'OFFERED', 'ACCEPTED', tama, 230, 'Accepted');
  note(bgl, 'ACCEPTED', 'Accepted.', tama, 230);
  note(bgl, 'PROGRESS', 'Before lunch: 7.8 mmol/L, recorded.', tama, 150);
  note(bgl, 'PROGRESS', 'Before tea: 9.1 mmol/L, recorded.', tama, 25);
  move(bgl, 'ACCEPTED', 'TO_REVIEW', tama, 20, 'Both checks done');
  note(bgl, 'FINISHED', 'Both checks done and recorded. Nicki V will check it.', tama, 20);
  store.run("UPDATE delegation SET state = 'TO_REVIEW', responded_at = ?, done_at = ? WHERE id = ?", ago(230), ago(20), bgl);

  add({ person: aroha, service: 'svc-genmed', activity: 'BLOODS', label: 'Take blood samples', instructions: 'FBC, U&E and CRP before the 2 pm ward round; send urgent.',
    reportIf: 'Two attempts without success, or she declines.', by: hannah, to: nicki, toName: 'Nicki V', at: 10, hours: 2, review: false });
}
