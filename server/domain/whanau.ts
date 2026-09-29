import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history, revise } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Whānau / family / support-person involvement (Shared Lifecycle Object 252):
//   person identity → relationship → patient preference → involvement requested / permitted →
//   information-sharing authority → decision-making authority where independently established →
//   communication events → changes / restrictions.
// What may be shared follows the person's own wishes. Sharing health information with someone
// they have not agreed to, or when they cannot say, is RR-WHANAU-001, so SHIFT only lets a
// contact with that person be recorded as "no health information shared". An enduring power of
// attorney or welfare guardian is recorded as a document seen; whether it is in effect is
// RR-CAP-001 and is never decided here.

type Row = Record<string, string | number | null>;
const RELATIONSHIPS: Record<string, string> = {
  PARTNER: 'Partner or spouse', CHILD: 'Son or daughter', PARENT: 'Parent', SIBLING: 'Brother or sister', GRANDCHILD: 'Mokopuna or grandchild',
  WHANAU: 'Other whānau or family', FRIEND: 'Friend', ADVOCATE: 'Advocate or support worker', OTHER: 'Other',
};
const WISHES: Record<string, string> = { ASKED: 'The person has said', NOT_ABLE: 'The person cannot say at the moment', NOT_YET: 'Not asked yet' };
const SHARE: Record<string, string> = {
  ALL: 'Everything about their care', GENERAL: 'General updates only', NOTHING: 'Nothing about their health', UNKNOWN: 'Not known yet',
};
const AUTHORITY: Record<string, string> = {
  NONE: 'None', EPOA_CARE: 'Enduring power of attorney: personal care and welfare', EPOA_PROPERTY: 'Enduring power of attorney: property',
  WELFARE_GUARDIAN: 'Welfare guardian (court order)', OTHER: 'Other legal authority',
};
const CONTACTS: Record<string, string> = { WE_CALLED: 'We phoned them', THEY_CALLED: 'They phoned', VISIT: 'Visit', MEETING: 'Family meeting', MESSAGE: 'Message' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005'];

const SELECT = `
  SELECT sp.id, sp.state, sp.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, sp.name, sp.relationship,
         sp.relationship_note AS relationshipNote, sp.phone, sp.first_contact AS firstContact, sp.wishes, sp.share, sp.involve, sp.limits,
         sp.authority, sp.authority_ref AS authorityRef, asb.display_name AS authoritySeenBy, sp.authority_seen_at AS authoritySeenAt,
         ab.display_name AS addedBy, sp.added_at AS addedAt, ub.display_name AS updatedBy, sp.updated_at AS updatedAt,
         eb.display_name AS endedBy, sp.ended_at AS endedAt, sp.end_reason AS endReason
    FROM support_person sp
    JOIN person p ON p.id = sp.person_id
    JOIN workforce_person ab ON ab.id = sp.added_by
    LEFT JOIN workforce_person ub ON ub.id = sp.updated_by
    LEFT JOIN workforce_person eb ON eb.id = sp.ended_by
    LEFT JOIN workforce_person asb ON asb.id = sp.authority_seen_by`;

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'WHANAU', personId }).decision === 'ALLOW';
const agreed = (r: Row) => r.wishes === 'ASKED' && (r.share === 'ALL' || r.share === 'GENERAL');

function shape(store: Store, ctx: WorkContext, r: Row, manage: boolean) {
  const contacts = store.all<Row>(
    `SELECT c.kind, c.summary, c.shared, c.at, w.display_name AS by, s.name AS service FROM support_contact c
       JOIN workforce_person w ON w.id = c.by_id JOIN service s ON s.id = c.service_id
      WHERE c.support_person_id = ? ORDER BY c.at DESC LIMIT 6`, String(r.id),
  );
  const active = r.state === 'ACTIVE';
  return {
    ...r, wishes: String(r.wishes), firstContact: !!r.firstContact, relationshipLabel: RELATIONSHIPS[String(r.relationship)] ?? String(r.relationship),
    wishesLabel: WISHES[String(r.wishes)], shareLabel: SHARE[String(r.share)], authorityLabel: AUTHORITY[String(r.authority)],
    mayShare: agreed(r), contacts: contacts.map((c) => ({ ...c, kindLabel: CONTACTS[String(c.kind)] })),
    actions: active && manage ? ['contact', 'change', 'end'] : [], history: history(store, 'supportperson', String(r.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'support_person', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const options = () => ({ relationships: RELATIONSHIPS, wishes: WISHES, share: SHARE, authority: AUTHORITY, contacts: CONTACTS });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId);
  const people = store.all<Row>(`${SELECT} WHERE sp.person_id = ? AND sp.state = 'ACTIVE' ORDER BY sp.first_contact DESC, sp.added_at`, personId);
  const past = store.all<Row>(`${SELECT} WHERE sp.person_id = ? AND sp.state = 'ENDED' ORDER BY sp.ended_at DESC`, personId);
  return { people: people.map((r) => shape(store, ctx, r, manage)), past: past.map((r) => shape(store, ctx, r, false)), canManage: manage, options: options() };
}

// For the record header: people who must not be told things, and legal documents held.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>(
    "SELECT name, share, limits, authority FROM support_person WHERE person_id = ? AND state = 'ACTIVE' AND (share = 'NOTHING' OR limits IS NOT NULL OR authority <> 'NONE') ORDER BY name", personId,
  );
  return rows.length ? rows.map((r) => ({
    name: r.name, limits: r.limits ?? (r.share === 'NOTHING' ? 'Share nothing about their health' : null),
    authority: r.authority !== 'NONE' ? AUTHORITY[String(r.authority)] : null,
  })) : null;
}

interface Fields {
  name?: string; relationship?: string; relationshipNote?: string; phone?: string; firstContact?: string | boolean;
  wishes?: string; share?: string; involve?: string; limits?: string; authority?: string; authorityRef?: string;
}
const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);

// What a change keeps the old value of, in the words the screen uses.
const CHANGE_LABELS: Record<string, string | [string, Record<string, string>]> = {
  name: 'Name', relationship: ['Relationship', RELATIONSHIPS], relationship_note: 'About the relationship', phone: 'Phone', first_contact: ['First contact', { 0: 'No', 1: 'Yes' }],
  wishes: ['Asked about sharing', WISHES], share: ['May be told', SHARE], involve: 'Involve them in', limits: 'Limits', authority: ['Legal authority', AUTHORITY], authority_ref: 'Document seen',
};

function clean(b: Fields) {
  const name = text(b.name, 200);
  if (name.length < 2) throw new HttpError(400, 'NAME_REQUIRED', 'Write their name.');
  const relationship = RELATIONSHIPS[String(b.relationship)] ? String(b.relationship) : '';
  if (!relationship) throw new HttpError(400, 'RELATIONSHIP_REQUIRED', 'Choose how they are related.');
  const wishes = WISHES[String(b.wishes)] ? String(b.wishes) : 'NOT_YET';
  // What may be shared only comes from the person; without their say it is not known.
  const share = wishes === 'ASKED' && SHARE[String(b.share)] ? String(b.share) : 'UNKNOWN';
  if (wishes === 'ASKED' && share === 'UNKNOWN') throw new HttpError(400, 'SHARE_REQUIRED', 'Choose what the person agrees can be shared with them.');
  const authority = AUTHORITY[String(b.authority)] ? String(b.authority) : 'NONE';
  const authorityRef = text(b.authorityRef, 300);
  if (authority !== 'NONE' && authorityRef.length < 3) throw new HttpError(400, 'AUTHORITY_REF_REQUIRED', 'Write which document you saw, and its date.');
  return {
    name, relationship, relationship_note: text(b.relationshipNote, 200) || null, phone: text(b.phone, 60) || null,
    first_contact: b.firstContact === true || b.firstContact === 'true' ? 1 : 0, wishes, share,
    involve: text(b.involve) || null, limits: text(b.limits) || null, authority, authority_ref: authority === 'NONE' ? null : authorityRef,
  };
}

export function add(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'WHANAU', personId }, personId);
  const v = clean(b);
  const id = newId();
  const at = now();
  store.tx(() => {
    if (v.first_contact) store.run("UPDATE support_person SET first_contact = 0 WHERE person_id = ? AND state = 'ACTIVE'", personId);
    store.insert('support_person', {
      id, person_id: personId, ...v, authority_seen_by: v.authority === 'NONE' ? null : ctx.workerId, authority_seen_at: v.authority === 'NONE' ? null : at,
      state: 'ACTIVE', added_by: ctx.workerId, added_at: at,
    });
    recordInitial(store, 'supportperson', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, `${v.name} (${RELATIONSHIPS[v.relationship]})`);
    logged(store, ctx, 'WHANAU_ADD', personId, id, v.name);
  });
  return { id };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${SELECT} WHERE sp.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That person is no longer recorded.');
  return r;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Fields & { kind?: string; summary?: string; shared?: string; note?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'ENDED', 'They are no longer recorded as a support person.');
  enforce(store, ctx, { op: 'WHANAU', personId }, personId);
  const at = now();
  switch (action) {
    case 'contact': {
      const kind = CONTACTS[String(b.kind)] ? String(b.kind) : '';
      if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the kind of contact.');
      const summary = text(b.summary, 1000);
      if (summary.length < 3) throw new HttpError(400, 'SUMMARY_REQUIRED', 'Write what was talked about.');
      const shared = b.shared === 'HEALTH' ? 'HEALTH' : 'NONE';
      if (shared === 'HEALTH' && !agreed(r)) {
        audit(store, {
          actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId, operation: 'WHANAU_SHARE',
          objectType: 'support_person', objectId: id, decision: 'UNRESOLVED', outcome: 'BLOCKED', reason: 'Person has not agreed to sharing', ruleRefs: ['RR-WHANAU-001', 'LAW-NZ-002'],
        });
        throw new HttpError(409, 'UNRESOLVED', `${r.name} is not someone the person has agreed can be told about their health. When health information may be shared without agreement is still being researched (RR-WHANAU-001), so record this contact as "no health information shared", or ask the person first.`);
      }
      store.tx(() => {
        store.insert('support_contact', { id: newId(), support_person_id: id, kind, summary, shared, by_id: ctx.workerId, service_id: ctx.serviceId, at });
        logged(store, ctx, shared === 'HEALTH' ? 'WHANAU_CONTACT_SHARED' : 'WHANAU_CONTACT', personId, id, summary);
      });
      break;
    }
    case 'change': {
      const v = clean({ ...b, name: b.name || String(r.name), relationship: b.relationship || String(r.relationship) });
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what changed and who said so.');
      const authorityChanged = v.authority !== r.authority || v.authority_ref !== r.authorityRef;
      store.tx(() => {
        const before = store.get<Record<string, unknown>>('SELECT * FROM support_person WHERE id = ?', id)!;
        const changed = revise(store, 'supportperson', id, before, v, CHANGE_LABELS, { actorId: ctx.workerId, workContextId: ctx.id }, note);
        if (v.first_contact) store.run("UPDATE support_person SET first_contact = 0 WHERE person_id = ? AND state = 'ACTIVE' AND id <> ?", personId, id);
        store.run(
          `UPDATE support_person SET name = ?, relationship = ?, relationship_note = ?, phone = ?, first_contact = ?, wishes = ?, share = ?, involve = ?,
             limits = ?, authority = ?, authority_ref = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
          v.name, v.relationship, v.relationship_note, v.phone, v.first_contact, v.wishes, v.share, v.involve, v.limits, v.authority, v.authority_ref, ctx.workerId, at, id,
        );
        if (authorityChanged) {
          store.run('UPDATE support_person SET authority_seen_by = ?, authority_seen_at = ? WHERE id = ?',
            v.authority === 'NONE' ? null : ctx.workerId, v.authority === 'NONE' ? null : at, id);
        }
        store.insert('state_transition', { id: newId(), object_type: 'supportperson', object_id: id, from_state: 'ACTIVE', to_state: 'ACTIVE', actor_id: ctx.workerId, work_context_id: ctx.id, at, reason: `Changed: ${note}${changed ? `. ${changed}` : ''}`, transaction_id: null });
        logged(store, ctx, 'WHANAU_CHANGE', personId, id, note);
      });
      break;
    }
    case 'end': {
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why they are no longer a support person, and who said so.');
      store.tx(() => {
        transition(store, 'supportperson', id, 'ENDED', { actorId: ctx.workerId, workContextId: ctx.id }, note);
        store.run('UPDATE support_person SET ended_by = ?, ended_at = ?, end_reason = ?, first_contact = 0 WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'WHANAU_END', personId, id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// Home → Whānau and support: everyone this service is caring for, with who to ask about.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('whanau.manage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include whānau and support`);
  }
  const patients = store.all<{ id: string; name: string; location: string | null }>(
    `SELECT p.id, p.given_name || ' ' || p.family_name AS name, e.location FROM encounter e JOIN person p ON p.id = e.person_id
      WHERE e.service_id = ? AND e.state = 'ACTIVE' ORDER BY e.location, p.family_name`, ctx.serviceId,
  );
  const rows = patients.map((p) => {
    const people = store.all<Row>(`${SELECT} WHERE sp.person_id = ? AND sp.state = 'ACTIVE' ORDER BY sp.first_contact DESC, sp.added_at`, p.id)
      .map((r) => shape(store, ctx, r, true));
    return { ...p, people, toAsk: people.length === 0 || people.some((x) => x.wishes === 'NOT_YET') };
  });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_WHANAU', decision: 'ALLOW', outcome: 'VIEWED' });
  return { patients: rows, options: options() };
}
