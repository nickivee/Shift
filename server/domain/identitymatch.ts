import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { SOURCES, GENDERS, CHECKS, ARRIVAL_KIND } from '../config/identitymatch.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Identity Matching (Shared Lifecycle Object 300, identity):
//   incoming identity information → candidate match → matching evidence → confirmed match OR
//   unresolved identity → merge/link correction process where authorised → provenance.
// A clinician registering an arrival records what they were told and where it came from. SHIFT
// finds possible matches and shows which identifiers agree and which differ; the clinician decides.
// Joining an existing record needs two identifiers to agree and a stated NHI never to differ
// (ORG-SYN-001). Someone who cannot be identified gets a temporary identity so care starts at once;
// identifying them later either confirms the temporary record or merges it into the existing one.
// A wrong match or merge can be corrected by an authorised clinician, and every step is kept.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  CONFIRMED: 'Matched to an existing record', NEW: 'New record', UNRESOLVED: 'Not yet identified', RESOLVED: 'Identified',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-IDENT-001'];
// Tables whose person_id is never moved: identities, the workforce and the immutable audit trail.
const FIXED = new Set(['person', 'external_identifier', 'workforce_person', 'audit_event', 'identity_match', 'identity_match_log']);

const Q = `
  SELECT m.id, m.service_id AS serviceId, s.name AS service, m.person_id AS personId,
         p.given_name || ' ' || p.family_name AS patient, m.linked_to AS linkedTo,
         lp.given_name || ' ' || lp.family_name AS linkedName,
         m.source, m.stated_given AS statedGiven, m.stated_family AS statedFamily, m.stated_nhi AS statedNhi,
         m.stated_dob AS statedDob, m.stated_gender AS statedGender, m.description, m.evidence, m.not_them AS notThem, m.state,
         rb.display_name AS registeredBy, m.registered_by AS registeredById, m.registered_at AS registeredAt,
         vb.display_name AS resolvedBy, m.resolved_at AS resolvedAt, m.resolved_note AS resolvedNote,
         cb.display_name AS correctedBy, m.corrected_at AS correctedAt, m.corrected_note AS correctedNote, m.manifest
    FROM identity_match m
    JOIN service s ON s.id = m.service_id
    JOIN person p ON p.id = m.person_id
    LEFT JOIN person lp ON lp.id = m.linked_to
    JOIN workforce_person rb ON rb.id = m.registered_by
    LEFT JOIN workforce_person vb ON vb.id = m.resolved_by
    LEFT JOIN workforce_person cb ON cb.id = m.corrected_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const canRegister = (ctx: WorkContext) => ctx.role.capabilities.includes('identity.register');
const canCorrect = (ctx: WorkContext) => ctx.role.capabilities.includes('identity.correct');
const LOG_LABELS: Record<string, string> = {
  REGISTERED: 'Arrival registered', MATCHED: 'Matched to an existing record', NEW: 'New record created', TEMPORARY: 'Temporary identity given',
  IDENTIFIED: 'Identified', MERGED: 'Merged into the existing record', CORRECTED: 'Corrected',
};

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'identity_match', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const log = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('identity_match_log', { id: newId(), match_id: id, kind, body, by_id: ctx.workerId, at: now() });

// What an arrival or a later identification said about the person.
export interface Stated { given: string; family: string; nhi: string; dob: string; gender: string }
function stated(b: Record<string, unknown>, needName: boolean): Stated {
  const given = text(b.given, 100);
  const family = text(b.family, 100);
  if (needName && (given.length < 1 || family.length < 1)) throw new HttpError(400, 'NAME_REQUIRED', 'Write the given name and family name as they were given.');
  const nhi = text(b.nhi, 10).toUpperCase().replace(/\s/g, '');
  if (nhi && !/^[A-Z]{3}[0-9]{2}[0-9A-Z]{2}$/.test(nhi)) throw new HttpError(400, 'NHI_FORMAT', 'That NHI is not in the right form (three letters then four characters).');
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dob ?? '')) ? String(b.dob) : '';
  if (dob && dob > new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'DOB_FUTURE', 'The date of birth is in the future.');
  const gender = GENDERS[String(b.gender)] ? String(b.gender) : '';
  return { given, family, nhi, dob, gender };
}

// Which identifiers agree with a person in SHIFT and which differ. Blank details are not compared.
export function compare(store: Store, personId: string, s: Stated) {
  const p = store.get<Row>('SELECT id, given_name, family_name, preferred_name, date_of_birth, gender FROM person WHERE id = ?', personId)!;
  const nhi = store.get<{ v: string }>("SELECT value AS v FROM external_identifier WHERE person_id = ? AND system = 'NHI'", personId)?.v ?? null;
  const agree: string[] = [];
  const differ: string[] = [];
  // Macrons and other accents are compared without their marks, so Hemi finds Hēmi.
  const low = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (s.nhi && nhi) (s.nhi === nhi ? agree : differ).push('NHI');
  if (s.dob && p.date_of_birth) (s.dob === p.date_of_birth ? agree : differ).push('DOB');
  if (s.family) (low(s.family) === low(p.family_name) ? agree : differ).push('FAMILY');
  if (s.given) ([p.given_name, p.preferred_name].filter(Boolean).map(low).some((g) => g === low(s.given) || g.split(' ')[0] === low(s.given).split(' ')[0]) ? agree : differ).push('GIVEN');
  if (s.gender && s.gender !== 'UNKNOWN' && p.gender) (low(GENDERS[s.gender]) === low(p.gender) ? agree : differ).push('GENDER');
  // Two identifiers: the NHI, or date of birth with the full name. A stated NHI must never differ.
  const enough = !differ.includes('NHI') && (agree.includes('NHI') || (agree.includes('DOB') && agree.includes('FAMILY') && agree.includes('GIVEN')));
  return {
    personId, name: `${p.given_name} ${p.family_name}`, nhi, dob: p.date_of_birth, gender: p.gender, agree, differ, enough,
    agreeLabel: agree.map((k) => CHECKS[k]).join(', '), differLabel: differ.map((k) => CHECKS[k]).join(', '),
  };
}

// Possible matches among everyone in SHIFT, best first. Merged temporary identities and staff are left out.
function candidates(store: Store, s: Stated, exclude?: string) {
  const ids = store.all<{ id: string }>(
    `SELECT p.id FROM person p
      WHERE p.merged_into IS NULL AND p.id NOT IN (SELECT person_id FROM workforce_person) AND p.id != ?
        AND (p.id IN (SELECT person_id FROM external_identifier WHERE system = 'NHI' AND value = ?)
             OR (? != '' AND p.date_of_birth = ?)
             OR (? != '' AND lower(p.family_name) = lower(?)))`,
    exclude ?? '', s.nhi, s.dob, s.dob, s.family, s.family,
  );
  return ids.map((r) => compare(store, r.id, s))
    .filter((c) => c.agree.length > 0)
    .sort((a, b) => Number(b.enough) - Number(a.enough) || Number(b.agree.includes('NHI')) - Number(a.agree.includes('NHI')) || b.agree.length - a.agree.length || a.differ.length - b.differ.length)
    .slice(0, 6);
}

const nhiOwner = (store: Store, nhi: string) => nhi
  ? store.get<{ id: string; name: string }>("SELECT p.id, p.given_name || ' ' || p.family_name AS name FROM external_identifier x JOIN person p ON p.id = x.person_id WHERE x.system = 'NHI' AND x.value = ?", nhi)
  : undefined;

function checkEnough(store: Store, personId: string, s: Stated) {
  const c = compare(store, personId, s);
  if (c.differ.includes('NHI')) throw new HttpError(409, 'NHI_DIFFERS', `The NHI given is not ${c.name}'s NHI. Do not match them; check the NHI.`);
  if (!c.enough) throw new HttpError(409, 'NOT_ENOUGH', `Only ${c.agreeLabel || 'nothing'} agrees with ${c.name}. Match only when the NHI agrees, or the date of birth and full name agree.`);
  return c;
}

// Rows about a person, table by table, for moving between records and moving back.
export function personTables(store: Store, fixed = FIXED) {
  return store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((t) => t.name).filter((t) => !fixed.has(t))
    .map((t) => ({ table: t, cols: store.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name) }))
    .filter((t) => t.cols.includes('person_id'));
}
export function moveAll(store: Store, from: string, to: string, fixed = FIXED) {
  const manifest: Record<string, number[]> = {};
  for (const { table } of personTables(store, fixed)) {
    const rows = store.all<{ r: number }>(`SELECT rowid AS r FROM ${table} WHERE person_id = ?`, from).map((x) => x.r);
    if (!rows.length) continue;
    store.run(`UPDATE ${table} SET person_id = ? WHERE person_id = ?`, to, from);
    manifest[table] = rows;
  }
  return manifest;
}
export function moveBack(store: Store, manifest: Record<string, number[]>, to: string) {
  for (const [table, rows] of Object.entries(manifest)) {
    for (const r of rows) store.run(`UPDATE ${table} SET person_id = ? WHERE rowid = ?`, to, r);
  }
}
// The highest row in each table when an arrival was matched, so a wrong match can be undone.
function snapshot(store: Store) {
  const out: Record<string, number> = {};
  for (const { table } of personTables(store)) out[table] = store.get<{ m: number | null }>(`SELECT max(rowid) AS m FROM ${table}`)?.m ?? 0;
  return out;
}
export const counted = (m: Record<string, number[]>) => Object.values(m).reduce((n, r) => n + r.length, 0);

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const state = String(r.state);
  const actions: string[] = [];
  const here = ctx.serviceId === r.serviceId;
  if (here && canRegister(ctx) && state === 'UNRESOLVED') actions.push('identify');
  if (here && canCorrect(ctx) && (state === 'CONFIRMED' || state === 'RESOLVED')) actions.push('correct');
  // A record this arrival was wrongly matched to is never offered again as a possible match.
  const { manifest, ...rest } = r;
  const wrong = manifest ? (JSON.parse(String(manifest)) as { unmatched?: unknown; from?: string }) : {};
  const s: Stated = { given: String(r.statedGiven ?? ''), family: String(r.statedFamily ?? ''), nhi: String(r.statedNhi ?? ''), dob: String(r.statedDob ?? ''), gender: String(r.statedGender ?? '') };
  return {
    ...rest, id, state, stateLabel: STATES[state], sourceLabel: SOURCES[String(r.source)] ?? String(r.source),
    statedGenderLabel: GENDERS[String(r.statedGender)] ?? null,
    evidence: r.evidence ? JSON.parse(String(r.evidence)) : null,
    // Possible matches for someone not yet identified, from what is known so far.
    candidates: state === 'UNRESOLVED' && actions.length && (s.nhi || s.dob || s.family) ? candidates(store, s, String(r.personId)).filter((c) => !(wrong.unmatched && c.personId === wrong.from)) : [],
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM identity_match_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.match_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'identity_match', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE m.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That identity record is no longer in SHIFT.');
  return r;
};

const options = () => ({ sources: SOURCES, genders: GENDERS });

// Registering an arrival, step 1: who might this be? Nothing is saved.
export function find(store: Store, ctx: WorkContext, b: Record<string, unknown>) {
  if (!canRegister(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not register arrivals`);
  const s = stated(b, false);
  if (!s.nhi && !s.dob && !s.family) throw new HttpError(400, 'DETAILS_REQUIRED', 'Write an NHI, a date of birth or a family name to look for.');
  const found = candidates(store, s);
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'IDENTITY_SEARCH', purpose: 'DIRECT_CARE', decision: 'ALLOW', outcome: 'VIEWED', reason: `${found.length} possible matches`, ruleRefs: REFS });
  return { candidates: found.map((c) => ({ ...c, here: Boolean(store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", c.personId, ctx.serviceId)) })) };
}

function tempName(store: Store, ctx: WorkContext, gender: string) {
  const n = store.get<{ n: number }>("SELECT count(*) AS n FROM identity_match WHERE service_id = ? AND temporary = 1", ctx.serviceId)!.n;
  let letters = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) letters = String.fromCharCode(65 + (i % 26)) + letters;
  const who = gender === 'MALE' ? 'Male' : gender === 'FEMALE' ? 'Female' : 'Person';
  return { given: 'Unidentified', family: `${who} ${letters}` };
}

// Registering an arrival, step 2: match them, make a new record, or give a temporary identity.
export function register(store: Store, ctx: WorkContext, b: Record<string, unknown>) {
  if (!canRegister(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not register arrivals`);
  const decision = String(b.decision ?? '');
  const source = SOURCES[String(b.source)] ? String(b.source) : '';
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose where the details came from.');
  const location = text(b.location, 60) || null;
  const s = stated(b, decision === 'NEW');
  const description = text(b.description, 500);
  const notThem = text(b.notThem, 500);
  const at = now();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  let personId = '';
  let state = '';
  let evidence: unknown = null;
  let temporary = 0;
  let snap: Record<string, number> | null = null;
  if (decision === 'MATCH') {
    personId = String(b.personId ?? '');
    if (!store.get('SELECT 1 FROM person WHERE id = ? AND merged_into IS NULL', personId)) throw new HttpError(404, 'NOT_FOUND', 'That record is not in SHIFT.');
    const owner = nhiOwner(store, s.nhi);
    if (owner && owner.id !== personId) throw new HttpError(409, 'NHI_OTHER', `The NHI given belongs to ${owner.name}. Check it before matching.`);
    evidence = checkEnough(store, personId, s);
    state = 'CONFIRMED';
    snap = snapshot(store);
  } else if (decision === 'NEW') {
    const owner = nhiOwner(store, s.nhi);
    if (owner) throw new HttpError(409, 'NHI_EXISTS', `That NHI already belongs to ${owner.name} in SHIFT. Match them instead, or check the NHI.`);
    const close = candidates(store, s).filter((c) => c.enough);
    if (close.length && notThem.length < 10) throw new HttpError(409, 'POSSIBLE_MATCH', `${close[0].name} matches these details. Say why this is a different person before making a new record.`);
    if (!s.dob && !s.nhi) throw new HttpError(400, 'IDENTIFIER_REQUIRED', 'A new record needs a date of birth or an NHI as well as the name. If you do not have them, give a temporary identity.');
    state = 'NEW';
  } else if (decision === 'UNKNOWN') {
    if (description.length < 5) throw new HttpError(400, 'DESCRIPTION_REQUIRED', 'Describe the person and how they arrived, e.g. "Man about 40, brought in by ambulance from Queen St, no ID".');
    state = 'UNRESOLVED';
    temporary = 1;
  } else throw new HttpError(400, 'DECISION_REQUIRED', 'Choose a match, a new record or a temporary identity.');
  if (personId && store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId)) {
    throw new HttpError(409, 'ALREADY_HERE', 'They are already here in your service. Open their record instead.');
  }
  const id = newId();
  store.tx(() => {
    if (!personId) {
      personId = newId();
      const name = temporary ? tempName(store, ctx, s.gender) : { given: s.given, family: s.family };
      store.insert('person', {
        id: personId, family_name: name.family, given_name: name.given, date_of_birth: temporary ? null : s.dob || null,
        gender: s.gender && s.gender !== 'UNKNOWN' ? GENDERS[s.gender] : null, data_source: 'LOCAL', created_at: at,
      });
      if (!temporary && s.nhi) store.insert('external_identifier', { id: newId(), person_id: personId, system: 'NHI', value: s.nhi, verification: 'UNVERIFIED', created_at: at });
    }
    store.insert('encounter', { id: newId(), person_id: personId, service_id: ctx.serviceId, location, kind: ARRIVAL_KIND[ctx.serviceId] ?? 'INPATIENT', started_at: at, state: 'ACTIVE' });
    store.insert('identity_match', {
      id, person_id: personId, service_id: ctx.serviceId, source, stated_given: s.given || null, stated_family: s.family || null,
      stated_nhi: s.nhi || null, stated_dob: s.dob || null, stated_gender: s.gender || null, description: description || null,
      evidence: evidence ? JSON.stringify(evidence) : null, not_them: notThem || null, temporary, state,
      registered_by: ctx.workerId, registered_at: at, manifest: snap ? JSON.stringify({ snapshot: snap }) : null,
    });
    recordInitial(store, 'identity_match', id, state, who, SOURCES[source]);
    const told = [s.given || s.family ? `${s.given} ${s.family}`.trim() : null, s.nhi ? `NHI ${s.nhi}` : null, s.dob ? `born ${s.dob}` : null,
      s.gender ? GENDERS[s.gender] : null].filter(Boolean).join(', ');
    log(store, ctx, id, 'REGISTERED', `${SOURCES[source]}${told ? `: ${told}` : ''}.${description ? ` ${description}` : ''}`);
    if (state === 'CONFIRMED') {
      const c = evidence as ReturnType<typeof compare>;
      log(store, ctx, id, 'MATCHED', `${c.name}. Agrees: ${c.agreeLabel}.${c.differLabel ? ` Differs: ${c.differLabel}.` : ''}`);
    } else if (state === 'NEW') log(store, ctx, id, 'NEW', `No existing record matched.${notThem ? ` ${notThem}` : ''}${s.nhi ? ' The NHI is recorded as not yet verified.' : ''}`);
    else log(store, ctx, id, 'TEMPORARY', 'Care can start under the temporary identity. Identify them as soon as possible.');
    logged(store, ctx, `IDENTITY_${state}`, personId, id, SOURCES[source]);
  });
  return { id, personId, state };
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Record<string, unknown>) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'IDENTITY', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This arrival was registered by ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const manifest = r.manifest ? JSON.parse(String(r.manifest)) as Record<string, unknown> : {};
  let result = personId;
  switch (action) {
    case 'identify': {
      if (!canRegister(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not identify arrivals`);
      if (state !== 'UNRESOLVED') throw new HttpError(409, 'WRONG_STATE', `This identity is ${STATES[state].toLowerCase()}.`);
      const source = SOURCES[String(b.source)] ? String(b.source) : '';
      if (!source || source === 'NONE') throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose where the identifying details came from.');
      const s = stated(b, true);
      const target = String(b.personId ?? '');
      if (target) {
        // Merge the temporary identity into the existing record.
        if (!store.get('SELECT 1 FROM person WHERE id = ? AND merged_into IS NULL', target) || target === personId) throw new HttpError(404, 'NOT_FOUND', 'That record is not in SHIFT.');
        const owner = nhiOwner(store, s.nhi);
        if (owner && owner.id !== target) throw new HttpError(409, 'NHI_OTHER', `The NHI given belongs to ${owner.name}. Check it before merging.`);
        const c = checkEnough(store, target, s);
        if (store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", target, ctx.serviceId)) {
          throw new HttpError(409, 'BOTH_HERE', `${c.name} already has another record open in your service. Resolve the duplicate first.`);
        }
        store.tx(() => {
          const moved = moveAll(store, personId, target);
          store.run('UPDATE person SET merged_into = ? WHERE id = ?', target, personId);
          transition(store, 'identity_match', id, 'RESOLVED', who, `Merged into ${c.name}`.slice(0, 200));
          store.run(`UPDATE identity_match SET linked_to = ?, person_id = ?, evidence = ?, resolved_by = ?, resolved_at = ?, resolved_note = ?, manifest = ?,
            stated_given = ?, stated_family = ?, stated_nhi = ?, stated_dob = ?, stated_gender = ?, id_source = ? WHERE id = ?`,
          target, target, JSON.stringify(c), ctx.workerId, at, note || null, JSON.stringify({ ...manifest, merged: moved, from: personId }),
          s.given, s.family, s.nhi || null, s.dob || null, s.gender || null, source, id);
          log(store, ctx, id, 'IDENTIFIED', `${SOURCES[source]}: ${s.given} ${s.family}${s.nhi ? `, NHI ${s.nhi}` : ''}${s.dob ? `, born ${s.dob}` : ''}.${note ? ` ${note}` : ''}`);
          log(store, ctx, id, 'MERGED', `${r.patient} is ${c.name}. Agrees: ${c.agreeLabel}.${c.differLabel ? ` Differs: ${c.differLabel}.` : ''} ${counted(moved)} entries moved to ${c.name}'s record; the temporary record is kept, marked as merged.`);
          logged(store, ctx, 'IDENTITY_MERGE', target, id, `${personId} into ${target}`);
        });
        result = target;
      } else {
        // Confirm the temporary identity as this person's own, new record.
        const owner = nhiOwner(store, s.nhi);
        if (owner) throw new HttpError(409, 'NHI_EXISTS', `That NHI belongs to ${owner.name}. Merge into their record instead.`);
        const close = candidates(store, s, personId).filter((c) => c.enough);
        if (close.length && note.length < 10) throw new HttpError(409, 'POSSIBLE_MATCH', `${close[0].name} matches these details. Merge into their record, or say why this is a different person.`);
        if (!s.dob && !s.nhi) throw new HttpError(400, 'IDENTIFIER_REQUIRED', 'Write the date of birth or the NHI as well as the name.');
        const before = store.get<Row>('SELECT given_name, family_name, date_of_birth, gender FROM person WHERE id = ?', personId);
        store.tx(() => {
          store.run('UPDATE person SET given_name = ?, family_name = ?, date_of_birth = ?, gender = COALESCE(?, gender) WHERE id = ?',
            s.given, s.family, s.dob || null, s.gender && s.gender !== 'UNKNOWN' ? GENDERS[s.gender] : null, personId);
          const nhiId = s.nhi ? newId() : null;
          if (nhiId) store.insert('external_identifier', { id: nhiId, person_id: personId, system: 'NHI', value: s.nhi, verification: 'UNVERIFIED', created_at: at });
          transition(store, 'identity_match', id, 'RESOLVED', who, `Identified as ${s.given} ${s.family}`.slice(0, 200));
          store.run(`UPDATE identity_match SET resolved_by = ?, resolved_at = ?, resolved_note = ?, manifest = ?,
            stated_given = ?, stated_family = ?, stated_nhi = ?, stated_dob = ?, stated_gender = ?, id_source = ? WHERE id = ?`,
          ctx.workerId, at, note || null, JSON.stringify({ ...manifest, before, nhiId }), s.given, s.family, s.nhi || null, s.dob || null, s.gender || null, source, id);
          log(store, ctx, id, 'IDENTIFIED', `${SOURCES[source]}: ${s.given} ${s.family}${s.nhi ? `, NHI ${s.nhi} (not yet verified)` : ''}${s.dob ? `, born ${s.dob}` : ''}. No existing record; the temporary record is now theirs.${note ? ` ${note}` : ''}`);
          logged(store, ctx, 'IDENTITY_IDENTIFIED', personId, id, `${s.given} ${s.family}`);
        });
      }
      break;
    }
    case 'correct': {
      if (!canCorrect(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot correct an identity. Ask a senior clinician.`);
      if (note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what was wrong, e.g. "Wrong Mary Smith: whānau confirmed a different date of birth".');
      if (state === 'RESOLVED' && manifest.merged) {
        // Undo a merge: every entry moved goes back to the temporary record.
        const from = String(manifest.from);
        store.tx(() => {
          moveBack(store, manifest.merged as Record<string, number[]>, from);
          store.run('UPDATE person SET merged_into = NULL WHERE id = ?', from);
          transition(store, 'identity_match', id, 'UNRESOLVED', who, note.slice(0, 200));
          store.run('UPDATE identity_match SET person_id = ?, linked_to = NULL, evidence = NULL, manifest = ?, corrected_by = ?, corrected_at = ?, corrected_note = ? WHERE id = ?',
            from, JSON.stringify({ snapshot: manifest.snapshot ?? null }), ctx.workerId, at, note, id);
          log(store, ctx, id, 'CORRECTED', `Merge undone: ${counted(manifest.merged as Record<string, number[]>)} entries moved back from ${r.linkedName} to the temporary record. ${note}`);
          logged(store, ctx, 'IDENTITY_UNMERGE', from, id, note.slice(0, 200));
        });
        result = from;
      } else if (state === 'RESOLVED') {
        // Undo an identification: the record goes back to its temporary details.
        const before = manifest.before as Row;
        store.tx(() => {
          store.run('UPDATE person SET given_name = ?, family_name = ?, date_of_birth = ?, gender = ? WHERE id = ?', before.given_name, before.family_name, before.date_of_birth, before.gender, personId);
          if (manifest.nhiId) store.run('DELETE FROM external_identifier WHERE id = ?', String(manifest.nhiId));
          transition(store, 'identity_match', id, 'UNRESOLVED', who, note.slice(0, 200));
          store.run('UPDATE identity_match SET manifest = NULL, corrected_by = ?, corrected_at = ?, corrected_note = ? WHERE id = ?', ctx.workerId, at, note, id);
          log(store, ctx, id, 'CORRECTED', `Identification undone: back to ${before.given_name} ${before.family_name}. ${note}`);
          logged(store, ctx, 'IDENTITY_UNIDENTIFY', personId, id, note.slice(0, 200));
        });
      } else if (state === 'CONFIRMED') {
        // A wrong match: this arrival, and what this service recorded for it since, move to a temporary identity.
        const snap = (manifest.snapshot ?? {}) as Record<string, number>;
        const temp = newId();
        store.tx(() => {
          const name = tempName(store, ctx, String(r.statedGender ?? ''));
          store.insert('person', { id: temp, family_name: name.family, given_name: name.given, date_of_birth: null, gender: null, data_source: 'LOCAL', created_at: at });
          const moved: Record<string, number[]> = {};
          const check: string[] = [];
          for (const { table, cols } of personTables(store)) {
            const since = snap[table] ?? 0;
            if (cols.includes('service_id')) {
              const rows = store.all<{ r: number }>(`SELECT rowid AS r FROM ${table} WHERE person_id = ? AND service_id = ? AND rowid > ?`, personId, ctx.serviceId, since).map((x) => x.r);
              for (const x of rows) store.run(`UPDATE ${table} SET person_id = ? WHERE rowid = ?`, temp, x);
              if (rows.length) moved[table] = rows;
            } else {
              const n = store.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE person_id = ? AND rowid > ?`, personId, since)!.n;
              if (n) check.push(`${n} ${table.replaceAll('_', ' ')}`);
            }
          }
          store.run('UPDATE identity_match SET temporary = 1 WHERE id = ?', id);
          transition(store, 'identity_match', id, 'UNRESOLVED', who, note.slice(0, 200));
          store.run('UPDATE identity_match SET person_id = ?, linked_to = ?, evidence = NULL, manifest = ?, corrected_by = ?, corrected_at = ?, corrected_note = ? WHERE id = ?',
            temp, null, JSON.stringify({ unmatched: moved, from: personId }), ctx.workerId, at, note, id);
          log(store, ctx, id, 'CORRECTED', `Not ${r.patient}. This arrival and ${counted(moved)} entries your service recorded since the match moved to a temporary identity, ${name.given} ${name.family}.${check.length ? ` Check ${r.patient}'s record: ${check.join(', ')} added since the match may belong to this arrival.` : ''} ${note}`);
          logged(store, ctx, 'IDENTITY_UNMATCH', personId, id, note.slice(0, 200));
          logged(store, ctx, 'IDENTITY_TEMPORARY', temp, id, 'Moved from a wrong match');
        });
        result = temp;
      } else throw new HttpError(409, 'WRONG_STATE', `This identity is ${STATES[state].toLowerCase()} and cannot be corrected here.`);
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return { personId: result, ...forPerson(store, ctx, result) };
}

// The person's Identity view: how they were identified, every step, and anything still open.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const all = store.all<Row>(`${Q} WHERE m.person_id = ? OR m.linked_to = ? ORDER BY m.registered_at DESC`, personId, personId).map((r) => shape(store, ctx, r));
  const p = store.get<Row>("SELECT merged_into AS mergedInto, (SELECT given_name || ' ' || family_name FROM person t WHERE t.id = person.merged_into) AS mergedName FROM person WHERE id = ?", personId);
  const nhi = store.get<Row>("SELECT value, verification FROM external_identifier WHERE person_id = ? AND system = 'NHI'", personId);
  return {
    matches: all, nhi: nhi ?? null, mergedInto: p?.mergedInto ?? null, mergedName: p?.mergedName ?? null,
    canCorrect: canCorrect(ctx), options: options(),
  };
}

// For the record header: a temporary identity not yet identified.
export function current(store: Store, personId: string) {
  return store.get<Row>("SELECT id, registered_at AS registeredAt, description FROM identity_match WHERE person_id = ? AND state = 'UNRESOLVED' ORDER BY registered_at DESC LIMIT 1", personId) ?? null;
}

// Home → Arrivals: people not yet identified, and today's arrivals, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!canRegister(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not register arrivals`);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = store.all<Row>(`${Q} WHERE m.service_id = ? AND (m.state = 'UNRESOLVED' OR m.registered_at >= ? OR m.resolved_at >= ? OR m.corrected_at >= ?) ORDER BY m.registered_at DESC`,
    ctx.serviceId, since, since, since).map((r) => ({ ...shape(store, ctx, r), candidates: [], actions: [] }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ARRIVALS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    unresolved: rows.filter((x) => x.state === 'UNRESOLVED'),
    recent: rows.filter((x) => x.state !== 'UNRESOLVED'),
    options: options(),
  };
}
