// Complaints (entries 25, 26): received → acknowledged and being looked into → responded to →
// closed, with "not satisfied" sending it back to be looked at again, and what the service is
// changing because of it. The Code of Rights gives every consumer the right to complain
// (LAW-NZ-005, Right 10); the timeframes, what must be written down and told to the person, and
// what a rest home must report for certification are still being researched (RR-COMPLAINT-001),
// so the person handling it sets the reply date and SHIFT holds no deadline of its own.

export const FROM: Record<string, string> = {
  PERSON: 'The person themselves',
  WHANAU: 'Whānau or a friend',
  ADVOCATE: 'An advocate for them',
  OTHER: 'Someone else',
};

export const HOW: Record<string, string> = {
  IN_PERSON: 'Told us in person',
  PHONE: 'By phone',
  WRITING: 'In a letter or form',
  EMAIL: 'By email',
  HDC: 'Through the Health and Disability Commissioner',
};

export const ABOUT: Record<string, string> = {
  CARE: 'Care or treatment',
  COMMUNICATION: 'Communication or information',
  ATTITUDE: 'How staff treated them',
  WAITING: 'Waiting or delays',
  PRIVACY: 'Privacy or dignity',
  ENVIRONMENT: 'Room, building or cleanliness',
  FOOD: 'Food',
  COST: 'Costs or charges',
  OTHER: 'Something else',
};

export const ACK_HOW: Record<string, string> = {
  IN_PERSON: 'In person',
  PHONE: 'By phone',
  LETTER: 'By letter',
  EMAIL: 'By email',
};

export const STATES: Record<string, string> = {
  RECEIVED: 'Received, not acknowledged yet',
  LOOKING: 'Being looked into',
  RESPONDED: 'Responded to',
  CLOSED: 'Closed',
};

export const OUTCOME: Record<string, string> = {
  RESOLVED: 'Resolved with them',
  NOT_RESOLVED: 'Not resolved; they know where else to take it',
  WITHDRAWN: 'They withdrew it',
  ERROR: 'Recorded in error',
};

export const REPLY_DAYS = [5, 10, 15, 20];

export const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005', 'RR-COMPLAINT-001'];
