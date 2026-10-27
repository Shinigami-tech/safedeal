/** Deals live in this browser (localStorage). Both roles can be tried in one browser via the role switch. */
import type { Milestone, MilestoneState, PayState, Plan, Review, Submission } from '../api/_types';

export interface Event {
  at: number;
  who: 'client' | 'freelancer' | 'ai' | 'paypal';
  text: string;
}

export interface DealMilestone extends Milestone {
  state: MilestoneState;
  pay: PayState;
  submissions: Submission[];
  reviews: Review[];
}

export interface Deal {
  id: string;
  created: number;
  brief: string;
  payee: string;
  plan: Omit<Plan, 'milestones'>;
  milestones: DealMilestone[];
  log: Event[];
}

const KEY = 'safedeal-deals-v1';
const ROLE = 'safedeal-role';

export function loadDeals(): Deal[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as Deal[];
  } catch {
    return [];
  }
}

export function saveDeals(d: Deal[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d.slice(0, 30)));
  } catch {
    // too big (screenshots): drop images from old submissions and retry
    try {
      const slim = d.map((x) => ({ ...x, milestones: x.milestones.map((m) => ({ ...m, submissions: m.submissions.map((s) => ({ ...s, image: undefined })) })) }));
      localStorage.setItem(KEY, JSON.stringify(slim.slice(0, 30)));
    } catch {
      /* ignore */
    }
  }
}

export type Role = 'client' | 'freelancer';
export function loadRole(): Role {
  try {
    return localStorage.getItem(ROLE) === 'freelancer' ? 'freelancer' : 'client';
  } catch {
    return 'client';
  }
}
export function saveRole(r: Role) {
  try {
    localStorage.setItem(ROLE, r);
  } catch {
    /* ignore */
  }
}

export function dealFromPlan(plan: Plan, brief: string, payee: string): Deal {
  const { milestones, ...rest } = plan;
  return {
    id: Math.random().toString(36).slice(2, 10),
    created: Date.now(),
    brief,
    payee,
    plan: rest,
    milestones: milestones.map((m) => ({ ...m, state: 'draft', pay: {}, submissions: [], reviews: [] })),
    log: [{ at: Date.now(), who: 'ai', text: `Planned ${milestones.length} milestone${milestones.length > 1 ? 's' : ''} with acceptance criteria` }],
  };
}
