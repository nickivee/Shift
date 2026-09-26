import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from '../db/database.ts';
import { audit } from './audit.ts';
import { newId, now, sha256, token, todayLocal, HttpError } from '../lib/util.ts';
import { ROLE_BY_KEY, type RoleConfig } from '../config/workstations.ts';

const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

// A dummy hash so unknown usernames cost the same time as wrong passwords.
const DUMMY = hashPassword(randomBytes(12).toString('hex'));

export interface Session {
  id: string;
  workerId: string;
  displayName: string;
}

export function login(store: Store, username: string, password: string): { token: string; session: Session } {
  const w = store.get<{ id: string; display_name: string; password_hash: string; status: string }>(
    'SELECT id, display_name, password_hash, status FROM workforce_person WHERE username = ?',
    username.trim().toLowerCase(),
  );
  const ok = verifyPassword(password, w?.password_hash ?? DUMMY);
  if (!w || !ok || w.status !== 'ACTIVE') {
    audit(store, {
      actorId: w?.id ?? null,
      space: 'AUTH',
      operation: 'SIGN_IN',
      outcome: 'BLOCKED',
      reason: !w || !ok ? 'Credentials not accepted' : `Workforce status ${w.status}`,
    });
    throw new HttpError(401, 'SIGN_IN_FAILED', 'That username and password were not accepted.');
  }
  const t = token();
  const id = newId();
  const at = now();
  store.insert('session', { id, token_hash: sha256(t), workforce_person_id: w.id, created_at: at, last_seen_at: at });
  audit(store, { actorId: w.id, sessionId: id, space: 'AUTH', operation: 'SIGN_IN', outcome: 'COMMITTED' });
  return { token: t, session: { id, workerId: w.id, displayName: w.display_name } };
}

export function resolveSession(store: Store, t: string | undefined): Session | null {
  if (!t) return null;
  const s = store.get<{ id: string; workforce_person_id: string; created_at: string; last_seen_at: string; display_name: string }>(
    `SELECT s.id, s.workforce_person_id, s.created_at, s.last_seen_at, w.display_name
       FROM session s JOIN workforce_person w ON w.id = s.workforce_person_id
      WHERE s.token_hash = ? AND s.ended_at IS NULL AND w.status = 'ACTIVE'`,
    sha256(t),
  );
  if (!s) return null;
  const nowMs = Date.now();
  const expired =
    nowMs - Date.parse(s.last_seen_at) > IDLE_MS ? 'IDLE_TIMEOUT' : nowMs - Date.parse(s.created_at) > ABSOLUTE_MS ? 'ABSOLUTE_TIMEOUT' : null;
  if (expired) {
    endSession(store, s.id, s.workforce_person_id, expired);
    return null;
  }
  store.run('UPDATE session SET last_seen_at = ? WHERE id = ?', now(), s.id);
  return { id: s.id, workerId: s.workforce_person_id, displayName: s.display_name };
}

export function endSession(store: Store, sessionId: string, workerId: string, reason: string): void {
  store.tx(() => {
    const at = now();
    store.run('UPDATE work_context SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', at, sessionId);
    store.run('UPDATE session SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL', at, reason, sessionId);
    audit(store, { actorId: workerId, sessionId, space: 'AUTH', operation: 'SIGN_OUT', outcome: 'COMMITTED', reason });
  });
}

// WORK context ------------------------------------------------------------------------

export interface PositionOption {
  positionId: string;
  title: string;
  roleKey: string;
  serviceId: string;
  serviceName: string;
  subjectLabel: string;
  organisationName: string;
  facilityName: string | null;
  configured: boolean;
}

export function positionOptions(store: Store, workerId: string): PositionOption[] {
  const today = todayLocal();
  const rows = store.all<Record<string, string>>(
    `SELECT p.id AS positionId, p.title, p.role_key AS roleKey, s.id AS serviceId, s.name AS serviceName,
            s.subject_label AS subjectLabel, o.name AS organisationName, f.name AS facilityName
       FROM position p
       JOIN employment e ON e.id = p.employment_id
       JOIN service s ON s.id = p.service_id
       JOIN organisation o ON o.id = s.organisation_id
       LEFT JOIN facility f ON f.id = s.facility_id
      WHERE e.workforce_person_id = ?
        AND e.start_date <= ? AND (e.end_date IS NULL OR e.end_date >= ?)
        AND p.start_date <= ? AND (p.end_date IS NULL OR p.end_date >= ?)
      ORDER BY s.name`,
    workerId, today, today, today, today,
  );
  return rows.map((r) => ({ ...(r as unknown as PositionOption), configured: ROLE_BY_KEY.has(r.roleKey) }));
}

export interface WorkContext {
  id: string;
  sessionId: string;
  workerId: string;
  displayName: string;
  positionId: string;
  positionTitle: string;
  serviceId: string;
  serviceName: string;
  subjectLabel: string;
  organisationId: string;
  organisationName: string;
  role: RoleConfig;
  authority: { profession: string; status: string; validTo: string | null; current: boolean } | null;
}

export function establishContext(store: Store, session: Session, positionId: string): WorkContext {
  const option = positionOptions(store, session.workerId).find((p) => p.positionId === positionId);
  if (!option) {
    audit(store, { actorId: session.workerId, sessionId: session.id, space: 'WORK', operation: 'ESTABLISH_CONTEXT', objectType: 'position', objectId: positionId, decision: 'BLOCK', outcome: 'BLOCKED', reason: 'Position is not a current position of this worker', ruleRefs: ['ORG-SYN-001'] });
    throw new HttpError(403, 'CONTEXT_BLOCKED', 'That position is not one of your current positions.');
  }
  if (!option.configured) {
    throw new HttpError(409, 'CONTEXT_UNCONFIGURED', 'This position has no workstation configuration yet.');
  }
  const id = newId();
  store.tx(() => {
    store.run('UPDATE work_context SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', now(), session.id);
    store.insert('work_context', {
      id, session_id: session.id, workforce_person_id: session.workerId, position_id: positionId, service_id: option.serviceId, established_at: now(),
    });
    audit(store, { actorId: session.workerId, sessionId: session.id, workContextId: id, space: 'WORK', operation: 'ESTABLISH_CONTEXT', objectType: 'position', objectId: positionId, decision: 'ALLOW', outcome: 'COMMITTED', ruleRefs: ['ORG-SYN-001'], engines: [3] });
  });
  return activeContext(store, session)!;
}

export function leaveContext(store: Store, session: Session): void {
  const r = store.run('UPDATE work_context SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', now(), session.id);
  if (r.changes) audit(store, { actorId: session.workerId, sessionId: session.id, space: 'WORK', operation: 'END_CONTEXT', outcome: 'COMMITTED' });
}

export function activeContext(store: Store, session: Session): WorkContext | null {
  const r = store.get<Record<string, string>>(
    `SELECT wc.id, wc.position_id, p.title, p.role_key, s.id AS service_id, s.name AS service_name, s.subject_label,
            o.id AS org_id, o.name AS org_name
       FROM work_context wc
       JOIN position p ON p.id = wc.position_id
       JOIN service s ON s.id = wc.service_id
       JOIN organisation o ON o.id = s.organisation_id
      WHERE wc.session_id = ? AND wc.ended_at IS NULL`,
    session.id,
  );
  if (!r) return null;
  const role = ROLE_BY_KEY.get(r.role_key);
  if (!role) return null;
  let authority: WorkContext['authority'] = null;
  if (role.profession) {
    const today = todayLocal();
    const a = store.get<{ profession: string; status: string; valid_from: string; valid_to: string | null }>(
      `SELECT profession, status, valid_from, valid_to FROM professional_authority
        WHERE workforce_person_id = ? AND profession = ? ORDER BY valid_from DESC LIMIT 1`,
      session.workerId, role.profession,
    );
    if (a) {
      const current = a.status === 'CURRENT' && a.valid_from <= today && (a.valid_to === null || a.valid_to >= today);
      authority = { profession: a.profession, status: current ? a.status : a.status === 'CURRENT' ? 'EXPIRED' : a.status, validTo: a.valid_to, current };
    }
  }
  return {
    id: r.id, sessionId: session.id, workerId: session.workerId, displayName: session.displayName,
    positionId: r.position_id, positionTitle: r.title, serviceId: r.service_id, serviceName: r.service_name,
    subjectLabel: r.subject_label, organisationId: r.org_id, organisationName: r.org_name, role, authority,
  };
}
