import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calculateProgress, newCase } from "../domain/engine.js";
import { catalogFor, fieldById } from "../domain/catalog.js";
import { crossFieldIssues, derivedEmploymentUntil, immediateConsistencyIssue } from "../domain/consistency.js";
import type { Answer, CaseRecord, CaseStatus } from "../domain/types.js";
import { validateAnswer } from "../domain/validation.js";
import { resolveAddressInput } from "../domain/address.js";

export interface StoreWorkflow {
  kind: "CANADA" | "USA";
  newCase: typeof newCase;
  catalogFor: typeof import("../domain/catalog.js").catalogFor;
  fieldById: typeof fieldById;
  calculateProgress: typeof calculateProgress;
  immediateConsistencyIssue?: (fieldId: string, value: Answer["value"], answers: Readonly<Record<string, Answer>>) => string | null;
  crossFieldIssues?: (answers: Readonly<Record<string, Answer>>) => string[];
  derivedAnswer?: (fieldId: string, value: Answer["value"], answers: Readonly<Record<string, Answer>>) => { fieldId: string; value: string } | null;
}

const CANADA_WORKFLOW: StoreWorkflow = {
  kind: "CANADA",
  newCase,
  catalogFor,
  fieldById,
  calculateProgress,
  immediateConsistencyIssue,
  crossFieldIssues,
  derivedAnswer: derivedEmploymentUntil,
};

export interface ClientSummary {
  id: string;
  chatId: string;
  phone: string;
  displayName: string;
  status: CaseStatus;
  currentFieldId: string | null;
  progress: ReturnType<typeof calculateProgress>;
  documentCount: number;
  pendingDocumentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDocument {
  id: string;
  clientId: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  createdAt: string;
}

export interface PendingDocument {
  id: string;
  clientId: string;
  whatsappMessageId: string;
  status: string;
  attempts: number;
  availableAt: string;
}

export interface StoredAuditEvent {
  id: number;
  event: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

type Row = Record<string, unknown>;
const iso = () => new Date().toISOString();

export class SQLiteStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly workflow: StoreWorkflow = CANADA_WORKFLOW) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.recoverJobs();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        current_field_id TEXT,
        consent_version TEXT,
        invited_at TEXT,
        consented_at TEXT,
        drive_folder_id TEXT,
        drive_folder_link TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS answers (
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL,
        value_json TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(client_id, field_id)
      );
      CREATE TABLE IF NOT EXISTS client_chat_ids (
        chat_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS answer_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        field_id TEXT NOT NULL,
        value_json TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        drive_file_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        web_view_link TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_documents (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        whatsapp_message_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_fields (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
        event TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS clients_updated_idx ON clients(updated_at DESC);
      CREATE INDEX IF NOT EXISTS client_chat_ids_client_idx ON client_chat_ids(client_id);
      CREATE INDEX IF NOT EXISTS pending_documents_ready_idx ON pending_documents(status, available_at);
      CREATE INDEX IF NOT EXISTS documents_client_idx ON documents(client_id, created_at DESC);
      INSERT OR IGNORE INTO client_chat_ids(chat_id,client_id) SELECT chat_id,id FROM clients;
    `);
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hydrate(row: Row | undefined): CaseRecord | null {
    if (!row) return null;
    const answerRows = this.db.prepare("SELECT * FROM answers WHERE client_id=?").all(String(row.id)) as Row[];
    const answers: Record<string, Answer> = {};
    for (const answer of answerRows) {
      const fieldId = String(answer.field_id);
      answers[fieldId] = {
        fieldId,
        value: answer.value_json === null ? null : JSON.parse(String(answer.value_json)),
        status: answer.status as Answer["status"],
        source: answer.source as Answer["source"],
        ...(answer.confidence === null ? {} : { confidence: Number(answer.confidence) }),
        updatedAt: String(answer.updated_at),
      };
    }
    return {
      id: String(row.id),
      phoneE164: String(row.phone),
      status: row.status as CaseStatus,
      answers,
      currentFieldId: row.current_field_id === null ? null : String(row.current_field_id),
      consentVersion: row.consent_version === null ? null : String(row.consent_version),
      invitedAt: row.invited_at === null ? null : String(row.invited_at),
      consentedAt: row.consented_at === null ? null : String(row.consented_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getCaseByChatId(chatId: string): CaseRecord | null {
    return this.hydrate(this.db.prepare(`SELECT c.* FROM clients c
      LEFT JOIN client_chat_ids a ON a.client_id=c.id
      WHERE c.chat_id=? OR a.chat_id=? LIMIT 1`).get(chatId, chatId) as Row | undefined);
  }

  getCaseById(id: string): CaseRecord | null {
    return this.hydrate(this.db.prepare("SELECT * FROM clients WHERE id=?").get(id) as Row | undefined);
  }

  getPrimaryChatId(id: string): string | null {
    const row = this.db.prepare("SELECT chat_id FROM clients WHERE id=?").get(id) as Row | undefined;
    return row ? String(row.chat_id) : null;
  }

  createCase(chatId: string, phone: string, displayName: string): CaseRecord {
    const existing = this.getCaseByChatId(chatId);
    if (existing) return existing;
    const caseRecord = this.workflow.newCase(randomUUID(), phone);
    this.db.prepare(`INSERT INTO clients(id,chat_id,phone,display_name,status,current_field_id,consent_version,invited_at,consented_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      caseRecord.id, chatId, phone, displayName, caseRecord.status, null, null, null, null, caseRecord.createdAt, caseRecord.updatedAt,
    );
    // Persist workflow metadata immediately. Both questionnaires use a hidden
    // schema-version answer so an expediente keeps the question order it began
    // with, even when staff edits it before the first WhatsApp response.
    this.saveCase(caseRecord);
    this.addChatAlias(caseRecord.id, chatId);
    this.audit(caseRecord.id, "CLIENT_CREATED", { chatId });
    return caseRecord;
  }

  addChatAlias(clientId: string, chatId: string): void {
    if (!chatId.trim()) return;
    this.db.prepare("INSERT OR IGNORE INTO client_chat_ids(chat_id,client_id) VALUES(?,?)").run(chatId, clientId);
  }

  saveCase(caseRecord: CaseRecord): void {
    this.transaction(() => {
      const confirmedName = caseRecord.answers["identity.full_name"];
      const displayName = confirmedName?.status === "CONFIRMED" && typeof confirmedName.value === "string" && confirmedName.value.trim()
        ? confirmedName.value.trim()
        : null;
      this.db.prepare(`UPDATE clients SET display_name=COALESCE(?,display_name),status=?,current_field_id=?,consent_version=?,invited_at=?,consented_at=?,updated_at=? WHERE id=?`).run(
        displayName, caseRecord.status, caseRecord.currentFieldId, caseRecord.consentVersion, caseRecord.invitedAt, caseRecord.consentedAt, iso(), caseRecord.id,
      );
      const known = new Map((this.db.prepare("SELECT field_id,value_json,status,source,confidence FROM answers WHERE client_id=?").all(caseRecord.id) as Row[])
        .map((row) => [String(row.field_id), row]));
      for (const answer of Object.values(caseRecord.answers)) {
        const value = JSON.stringify(answer.value);
        const previous = known.get(answer.fieldId);
        const changed = !previous
          || previous.value_json !== value
          || previous.status !== answer.status
          || previous.source !== answer.source
          || Number(previous.confidence ?? -1) !== Number(answer.confidence ?? -1);
        if (changed) {
          this.db.prepare(`INSERT INTO answers(client_id,field_id,value_json,status,source,confidence,updated_at) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(client_id,field_id) DO UPDATE SET value_json=excluded.value_json,status=excluded.status,source=excluded.source,confidence=excluded.confidence,updated_at=excluded.updated_at`).run(
            caseRecord.id, answer.fieldId, value, answer.status, answer.source, answer.confidence ?? null, answer.updatedAt,
          );
          this.db.prepare("INSERT INTO answer_history(client_id,field_id,value_json,status,source,changed_at) VALUES(?,?,?,?,?,?)").run(
            caseRecord.id, answer.fieldId, value, answer.status, answer.source, iso(),
          );
        }
        known.delete(answer.fieldId);
      }
      for (const fieldId of known.keys()) this.db.prepare("DELETE FROM answers WHERE client_id=? AND field_id=?").run(caseRecord.id, fieldId);
    });
  }

  isProcessed(messageId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM processed_messages WHERE message_id=?").get(messageId));
  }

  markProcessed(messageId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO processed_messages(message_id,processed_at) VALUES(?,?)").run(messageId, iso());
  }

  audit(clientId: string | null, event: string, detail: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO audit_events(client_id,event,detail_json,created_at) VALUES(?,?,?,?)").run(clientId, event, JSON.stringify(detail), iso());
  }

  listAuditEvents(clientId: string, limit = 150): StoredAuditEvent[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 300);
    const rows = this.db.prepare(`SELECT id,event,detail_json,created_at
      FROM audit_events WHERE client_id=? ORDER BY id DESC LIMIT ?`).all(clientId, safeLimit) as Row[];
    return rows.map((row) => {
      let detail: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.detail_json));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
      } catch {
        detail = { raw: String(row.detail_json) };
      }
      return { id: Number(row.id), event: String(row.event), detail, createdAt: String(row.created_at) };
    });
  }

  listClients(): ClientSummary[] {
    const rows = this.db.prepare(`SELECT c.*,COUNT(DISTINCT d.id) document_count,
      COUNT(DISTINCT CASE WHEN p.status IN ('PENDING','PROCESSING') THEN p.id END) pending_count
      FROM clients c LEFT JOIN documents d ON d.client_id=c.id LEFT JOIN pending_documents p ON p.client_id=c.id
      GROUP BY c.id ORDER BY c.updated_at DESC`).all() as Row[];
    return rows.map((row) => {
      const caseRecord = this.hydrate(row)!;
      return {
        id: caseRecord.id,
        chatId: String(row.chat_id),
        phone: String(row.phone),
        displayName: String(row.display_name),
        status: caseRecord.status,
        currentFieldId: caseRecord.currentFieldId,
        progress: this.workflow.calculateProgress(caseRecord),
        documentCount: Number(row.document_count),
        pendingDocumentCount: Number(row.pending_count),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  getClientDetails(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM clients WHERE id=?").get(id) as Row | undefined;
    const caseRecord = this.hydrate(row);
    if (!row || !caseRecord) return null;
    return {
      ...caseRecord,
      chatId: row.chat_id,
      displayName: row.display_name,
      notes: row.notes,
      driveFolderId: row.drive_folder_id,
      driveFolderLink: row.drive_folder_link,
      progress: this.workflow.calculateProgress(caseRecord),
      documents: this.listDocuments(id),
      customFields: this.listCustomFields(id),
      auditEvents: this.listAuditEvents(id),
    };
  }

  updateClient(id: string, changes: { displayName?: string | undefined; notes?: string | undefined; status?: CaseStatus | undefined }): void {
    const row = this.db.prepare("SELECT * FROM clients WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("CLIENT_NOT_FOUND");
    this.db.prepare("UPDATE clients SET display_name=?,notes=?,status=?,updated_at=? WHERE id=?").run(
      changes.displayName ?? String(row.display_name), changes.notes ?? String(row.notes), changes.status ?? String(row.status), iso(), id,
    );
    this.audit(id, "CLIENT_UPDATED", { fields: Object.keys(changes) });
  }

  deleteClient(id: string): void {
    if (!this.getCaseById(id)) throw new Error("CLIENT_NOT_FOUND");
    this.transaction(() => {
      this.db.prepare("DELETE FROM answer_history WHERE client_id=?").run(id);
      this.db.prepare("DELETE FROM audit_events WHERE client_id=?").run(id);
      this.db.prepare("DELETE FROM clients WHERE id=?").run(id);
    });
  }

  setStaffAnswer(clientId: string, fieldId: string, rawValue: string): Answer {
    const caseRecord = this.getCaseById(clientId);
    if (!caseRecord) throw new Error("CLIENT_NOT_FOUND");
    const definition = this.workflow.fieldById(fieldId, caseRecord.answers);
    if (!definition) throw new Error("FIELD_NOT_APPLICABLE");
    const addressResolution = resolveAddressInput(fieldId, rawValue, caseRecord.answers);
    if (!addressResolution.ok) throw new Error(`INVALID_VALUE:${addressResolution.message}`);
    const validation = validateAnswer(definition, addressResolution.value);
    if (!validation.ok) throw new Error(`INVALID_VALUE:${validation.message}`);
    const consistencyIssue = this.workflow.immediateConsistencyIssue?.(fieldId, validation.value, caseRecord.answers) ?? null;
    if (consistencyIssue) throw new Error(`INVALID_VALUE:${consistencyIssue}`);
    const answer: Answer = { fieldId, value: validation.value, status: "CONFIRMED", source: "STAFF", confidence: 100, updatedAt: iso() };
    caseRecord.answers[fieldId] = answer;
    const derivedUntil = this.workflow.derivedAnswer?.(fieldId, validation.value, caseRecord.answers) ?? null;
    if (derivedUntil) {
      caseRecord.answers[derivedUntil.fieldId] = {
        fieldId: derivedUntil.fieldId,
        value: derivedUntil.value,
        status: "CONFIRMED",
        source: "SYSTEM",
        confidence: 100,
        updatedAt: iso(),
      };
    }
    const progress = this.workflow.calculateProgress(caseRecord);
    if (caseRecord.status === "NEEDS_STAFF_REVIEW"
      && caseRecord.currentFieldId === null
      && progress.confirmed === progress.required
      && progress.conflicts === 0
      && (this.workflow.crossFieldIssues?.(caseRecord.answers).length ?? 0) === 0) {
      caseRecord.status = "READY_FOR_REVIEW";
    }
    this.saveCase(caseRecord);
    this.audit(clientId, "STAFF_ANSWER_SET", { fieldId });
    return answer;
  }

  setDriveFolder(clientId: string, folderId: string, link: string): void {
    this.db.prepare("UPDATE clients SET drive_folder_id=?,drive_folder_link=?,updated_at=? WHERE id=?").run(folderId, link, iso(), clientId);
  }

  getDriveFolder(clientId: string): { id: string; link: string } | null {
    const row = this.db.prepare("SELECT drive_folder_id,drive_folder_link FROM clients WHERE id=?").get(clientId) as Row | undefined;
    return row?.drive_folder_id ? { id: String(row.drive_folder_id), link: String(row.drive_folder_link ?? "") } : null;
  }

  queueDocument(clientId: string, whatsappMessageId: string): PendingDocument {
    const existing = this.db.prepare("SELECT * FROM pending_documents WHERE whatsapp_message_id=?").get(whatsappMessageId) as Row | undefined;
    if (existing) return this.pendingFromRow(existing);
    const timestamp = iso();
    const item: PendingDocument = { id: randomUUID(), clientId, whatsappMessageId, status: "PENDING", attempts: 0, availableAt: timestamp };
    this.db.prepare("INSERT INTO pending_documents(id,client_id,whatsapp_message_id,status,attempts,available_at,created_at) VALUES(?,?,?,?,?,?,?)").run(
      item.id, clientId, whatsappMessageId, item.status, 0, timestamp, timestamp,
    );
    this.audit(clientId, "DOCUMENT_QUEUED", { jobId: item.id });
    return item;
  }

  claimDocument(): PendingDocument | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM pending_documents WHERE status='PENDING' AND available_at<=? ORDER BY created_at LIMIT 1").get(iso()) as Row | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE pending_documents SET status='PROCESSING',attempts=attempts+1 WHERE id=?").run(String(row.id));
      return { ...this.pendingFromRow(row), status: "PROCESSING", attempts: Number(row.attempts) + 1 };
    });
  }

  failDocument(jobId: string, error: string): void {
    const row = this.db.prepare("SELECT attempts FROM pending_documents WHERE id=?").get(jobId) as Row | undefined;
    if (!row) return;
    const attempts = Number(row.attempts);
    const waitMs = Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);
    this.db.prepare("UPDATE pending_documents SET status='PENDING',available_at=?,last_error=? WHERE id=?").run(new Date(Date.now() + waitMs).toISOString(), error.slice(0, 1000), jobId);
  }

  rejectDocument(jobId: string, error: string): void {
    const row = this.db.prepare("SELECT client_id FROM pending_documents WHERE id=?").get(jobId) as Row | undefined;
    this.db.prepare("UPDATE pending_documents SET status='FAILED',last_error=? WHERE id=?").run(error.slice(0, 1000), jobId);
    if (row) this.audit(String(row.client_id), "DOCUMENT_REJECTED", { jobId, reason: error });
  }

  completeDocument(job: PendingDocument, document: Omit<StoredDocument, "clientId" | "createdAt">): StoredDocument {
    const stored: StoredDocument = { ...document, clientId: job.clientId, createdAt: iso() };
    this.transaction(() => {
      this.db.prepare("INSERT INTO documents(id,client_id,drive_file_id,name,mime_type,size,web_view_link,created_at) VALUES(?,?,?,?,?,?,?,?)").run(
        stored.id, stored.clientId, stored.driveFileId, stored.name, stored.mimeType, stored.size, stored.webViewLink, stored.createdAt,
      );
      this.db.prepare("UPDATE pending_documents SET status='COMPLETED',last_error=NULL WHERE id=?").run(job.id);
      this.audit(job.clientId, "DOCUMENT_UPLOADED", { documentId: stored.id, driveFileId: stored.driveFileId });
    });
    return stored;
  }

  listDocuments(clientId: string): StoredDocument[] {
    return (this.db.prepare("SELECT * FROM documents WHERE client_id=? ORDER BY created_at DESC").all(clientId) as Row[]).map((row) => ({
      id: String(row.id), clientId: String(row.client_id), driveFileId: String(row.drive_file_id), name: String(row.name),
      mimeType: String(row.mime_type), size: Number(row.size), webViewLink: String(row.web_view_link), createdAt: String(row.created_at),
    }));
  }

  addCustomField(clientId: string, label: string, value: string): Row {
    if (!this.getCaseById(clientId)) throw new Error("CLIENT_NOT_FOUND");
    const item = { id: randomUUID(), clientId, label: label.trim(), value: value.trim(), createdAt: iso(), updatedAt: iso() };
    this.db.prepare("INSERT INTO custom_fields(id,client_id,label,value,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(
      item.id, item.clientId, item.label, item.value, item.createdAt, item.updatedAt,
    );
    this.audit(clientId, "CUSTOM_FIELD_ADDED", { customFieldId: item.id });
    return item;
  }

  deleteCustomField(clientId: string, customFieldId: string): void {
    this.db.prepare("DELETE FROM custom_fields WHERE id=? AND client_id=?").run(customFieldId, clientId);
    this.audit(clientId, "CUSTOM_FIELD_DELETED", { customFieldId });
  }

  listCustomFields(clientId: string): Row[] {
    return this.db.prepare("SELECT id,label,value,created_at createdAt,updated_at updatedAt FROM custom_fields WHERE client_id=? ORDER BY created_at").all(clientId) as Row[];
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  close(): void { this.db.close(); }

  private pendingFromRow(row: Row): PendingDocument {
    return { id: String(row.id), clientId: String(row.client_id), whatsappMessageId: String(row.whatsapp_message_id), status: String(row.status), attempts: Number(row.attempts), availableAt: String(row.available_at) };
  }

  private recoverJobs(): void {
    this.db.prepare("UPDATE pending_documents SET status='PENDING',available_at=? WHERE status='PROCESSING'").run(iso());
  }
}
