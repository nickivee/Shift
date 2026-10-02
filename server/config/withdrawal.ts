// Alcohol and drug withdrawal (entries 111, 116) in the Emergency Department and General Medicine.
// Which scale to use, what score means a drug is needed, and when someone is safe to leave come from
// the treating doctor and the service's own protocol, and are recorded as they were given. SHIFT
// holds no withdrawal scores, thresholds or doses of its own. National requirements are RR-WITHDRAWAL-001.

export const STATES: Record<string, string> = {
  ASSESSING: 'Being assessed',
  MANAGED: 'Being managed',
  SETTLED: 'Settled',
  HANDED_ON: 'Handed on',
};

export const SUBSTANCE: Record<string, string> = {
  ALCOHOL: 'Alcohol',
  OPIOIDS: 'Opioids',
  BENZODIAZEPINES: 'Benzodiazepines or sleeping tablets',
  STIMULANTS: 'Methamphetamine or other stimulants',
  CANNABIS: 'Cannabis',
  OTHER: 'Something else',
};

export const TIME_KNOWN: Record<string, string> = {
  KNOWN: 'Time known',
  ESTIMATED: 'Time estimated',
  UNKNOWN: 'Time not known',
};

export const REFS = ['ORG-SYN-001 v1', 'RR-WITHDRAWAL-001'];
