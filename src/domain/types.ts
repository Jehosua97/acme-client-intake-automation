export const CASE_STATUSES = [
  "DRAFT",
  "INVITED",
  "AWAITING_CONSENT",
  "ACTIVE",
  "PAUSED",
  "WAITING_FOR_CLIENT",
  "NEEDS_STAFF_REVIEW",
  "READY_FOR_REVIEW",
  "COMPLETE",
  "DECLINED",
  "DELETION_REQUESTED",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
export type AnswerStatus = "PENDING" | "PROPOSED" | "CONFIRMED" | "CONFLICT";
export type AnswerSource = "CHAT" | "DOCUMENT" | "STAFF" | "SYSTEM";
export type FieldKind = "text" | "yes_no" | "date" | "year_month" | "integer" | "email" | "phone" | "money";

export interface Answer {
  fieldId: string;
  value: string | number | boolean | null;
  status: AnswerStatus;
  source: AnswerSource;
  confidence?: number;
  updatedAt: string;
}

export interface CaseRecord {
  id: string;
  phoneE164: string;
  status: CaseStatus;
  answers: Record<string, Answer>;
  currentFieldId: string | null;
  consentVersion: string | null;
  invitedAt: string | null;
  consentedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FieldDefinition {
  id: string;
  section: string;
  label: string;
  prompt: string;
  kind: FieldKind;
  required: boolean;
  order: number;
  applies: (answers: Readonly<Record<string, Answer>>) => boolean;
  forms: readonly string[];
}

export type OutgoingMessage =
  | { type: "text"; body: string }
  | { type: "template"; name: string; language: string };

export interface EngineResult {
  caseRecord: CaseRecord;
  outgoing: OutgoingMessage[];
  auditEvents: Array<{ event: string; detail: Record<string, unknown> }>;
}

export interface Progress {
  confirmed: number;
  required: number;
  pending: number;
  proposed: number;
  conflicts: number;
  percent: number;
}

