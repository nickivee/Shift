// The synthetic data set, loaded through the same store the application uses. Synthetic
// data is data: it is marked SYNTHETIC at source, and identifiers use the test NHI range.
import type { Store } from '../db/database.ts';
import { hashPassword } from '../domain/identity.ts';
import { audit } from '../domain/audit.ts';
import { recordInitial } from '../domain/lifecycle.ts';
import { KEY_BY_CODE } from '../config/keys.ts';
import { render } from '../domain/commands.ts';
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
  { username: 'lee', label: 'Lee Wong, Clinical Coder (Te Awa Hospital)' },
];

const SET = 25;

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
