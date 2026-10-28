/** Shapes shared by the API and the web app. */

export interface Criterion {
  text: string;
  /** how the AI can check it: 'page' (look at the delivered URL), 'image' (screenshot), 'manual' (client confirms) */
  check: 'page' | 'image' | 'manual';
}

export interface Milestone {
  title: string;
  amount: number;
  /** ISO date or null */
  due: string | null;
  criteria: Criterion[];
}

export interface Plan {
  title: string;
  summary: string;
  currency: string;
  milestones: Milestone[];
  /** things that are vague in the brief and could cause a conflict later */
  risks: string[];
}

export interface CheckResult {
  criterion: string;
  status: 'pass' | 'fail' | 'unclear';
  evidence: string;
}

export interface Review {
  verdict: 'approve' | 'changes' | 'reject';
  score: number;
  summary: string;
  checks: CheckResult[];
  /** what the freelancer should fix, if anything */
  fixes: string[];
  /** how the score was computed */
  counts?: { checkable: number; confirmed: number; client: number };
  /** facts gathered from the delivered page */
  observed: { url: string; title: string; status: number; mobile: boolean; forms: number; images: number; words: number } | null;
}

export interface Submission {
  url: string;
  notes: string;
  /** optional screenshot(s) as data URLs */
  image?: string;
  images?: string[];
  at: number;
}

export type MilestoneState = 'draft' | 'held' | 'submitted' | 'reviewed' | 'released' | 'returned';

export interface PayState {
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
  heldUntil?: string;
  payer?: string;
}
