// Oxygen therapy (entries 70, 199) in the Emergency Department and General Medicine.
// The target range, the device and the flow are what the prescribing doctor writes. SHIFT holds no
// target ranges, flow rates or titration rules of its own, and only compares each reading with the
// range the doctor set. National requirements are RR-OXYGEN-001.
export const STATES: Record<string, string> = { ON: 'On oxygen', WEANING: 'Being weaned', STOPPED: 'Stopped' };
export const DEVICE: Record<string, string> = {
  NASAL: 'Nasal prongs',
  SIMPLE_MASK: 'Simple face mask',
  RESERVOIR: 'Mask with reservoir bag',
  VENTURI: 'Venturi mask',
  HIGH_FLOW: 'High-flow nasal oxygen',
  OTHER: 'Something else',
};
export const REFS = ['ORG-SYN-001 v1', 'RR-OXYGEN-001'];
