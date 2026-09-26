// The synthetic data set, loaded through the same store the application uses. Synthetic
// data is data: it is marked SYNTHETIC at source, and identifiers use the test NHI range.
import type { Store } from '../db/database.ts';
import { hashPassword } from '../domain/identity.ts';
import { audit } from '../domain/audit.ts';
import { recordInitial } from '../domain/lifecycle.ts';
import { KEY_BY_CODE } from '../config/keys.ts';
import { render } from '../domain/commands.ts';
import { newId, now, todayLocal, addDays } from '../lib/util.ts';

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
];

const SET = 7;

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
