import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";
import type { Message } from "whatsapp-web.js";
import type { Config } from "../config.js";
import { handleClientText, handlePassportDocument, hasPendingClientPassportQuestions, resumeIntakeByAdmin, startIntake, stopIntakeByAdmin } from "../domain/engine.js";
import { handleUsaDocument, handleUsaText, resumeUsaIntake, startUsaIntake, stopUsaIntake } from "../domain/usa-engine.js";
import type { CaseRecord, OutgoingMessage } from "../domain/types.js";
import type { GoogleDriveService } from "./google-drive.js";
import type { FullBackupService } from "./full-backup.js";
import type { PendingDocument, SQLiteStore } from "./sqlite-store.js";
import type { OpenAIConversationService } from "./openai-conversation.js";
import { fieldById } from "../domain/catalog.js";
import { usaFieldById } from "../domain/usa-catalog.js";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const BOT_START_CANADA_COMMAND = "START BOT CANADA";
const BOT_START_USA_COMMAND = "START BOT USA";
const BOT_START_ETA_COMMAND = "START BOT ETA";
const BOT_STOP_COMMAND = "STOP BOT";
const FULL_BACKUP_COMMAND = "HACER RESPALDO BACKUP";
const VISA_CANADA_INFO_COMMAND = "INFO VISA CANADA";
const VISA_USA_INFO_COMMAND = "INFO VISA USA";
const VISA_CANADA_INFO_MESSAGE = `🇨🇦 *REQUISITOS PARA VISA DE CANADÁ*

📄 *Documentos y fotografías*
📌 Foto del pasaporte
📌 Foto personal

👤 *Datos personales*
📌 Correo electrónico
📌 Dirección completa en México:
   • Número de casa
   • Código postal
   • Ciudad y estado
📌 Fecha estimada de viaje
📌 ¿Ha viajado a algún otro país?
📌 ¿Ha estado anteriormente en Canadá?

🎓 *Educación*
📌 Nombre de la escuela (solo el último nivel de estudios)
📌 Año y mes de inicio
📌 Año y mes de término
📌 Ciudad y estado donde se encuentra la escuela

💼 *Trabajo actual o anterior*
📌 Nombre de la empresa donde trabaja o trabajó en México
📌 Año y mes de inicio
📌 Año y mes de término (si aplica)
📌 Ciudad donde se encuentra la empresa
📌 Puesto que ocupa

🏪 *Negocio (si aplica)*
📌 ¿Tiene algún negocio?
📌 ¿Cuenta con algún registro?
📌 Nombre del negocio
📌 Fecha en que lo inició

👪 *Datos de los padres*
📌 Madre: nombre completo, ocupación, dirección y fecha de nacimiento
📌 Padre: nombre completo, ocupación, dirección y fecha de nacimiento

💍 *Estado civil del aplicante*
📌 Estado civil (soltero o casado)
📌 Nombre completo del esposo(a), si aplica
📌 Fecha del matrimonio legal (día, mes y año), si aplica
📌 Fecha de nacimiento
📌 Dirección
📌 Ocupación de la pareja
📌 Nombre completo de la pareja
📌 Fecha de nacimiento de la pareja (día, mes y año)

👧👦 *Datos de los hijos (si aplica)*
📌 Nombre completo
📌 Ocupación
📌 Fecha de nacimiento (día, mes y año)
📌 Dirección`;
const VISA_USA_INFO_MESSAGE = `🇺🇸 *REQUISITOS PARA VISA DE ESTADOS UNIDOS 2026*

📄 *Documentos y datos personales*
📌 Foto del pasaporte
📌 Dirección completa del aplicante, con código postal y ciudad
📌 Número de teléfono del aplicante
📌 Número de teléfono adicional
📌 Correo electrónico
📌 Nombre utilizado en redes sociales
📌 Perfiles de Facebook, Twitter e Instagram

💼 *Trabajo actual o anterior*
📌 Nombre completo de la empresa
📌 Fecha de ingreso (día, mes y año)
📌 Dirección completa de la empresa, con código postal
📌 Descripción, con sus propias palabras, de las actividades que realiza en la empresa

🎓 *Educación*
📌 Nombre completo de la escuela
📌 Fecha de ingreso (día, mes y año)
📌 Fecha de término (día, mes y año)
📌 Nombre de la carrera

📧 *Información adicional de contacto*
📌 ¿Tiene algún correo adicional que haya utilizado durante los últimos 5 años?

✈️ *Información del viaje*
📌 ¿A qué parte de Estados Unidos piensa viajar?
📌 Dirección completa del destino, con código postal
📌 Teléfono del destino

🗽 *Familiares en Estados Unidos*
📌 ¿Tiene algún familiar ciudadano en Estados Unidos?
📌 Nombre completo
📌 Dirección
📌 Teléfono
📌 Correo electrónico
📌 Vínculo familiar

👪 *Datos de los padres*
📌 Madre: nombre completo, dirección, fecha de nacimiento y ocupación en México
📌 Padre: nombre completo, dirección, fecha de nacimiento y ocupación en México

🌎 *Antecedentes adicionales*
📌 ¿Habla algún otro idioma? Indique cuál.
📌 ¿Ha viajado al extranjero? Mencione todos los países que ha visitado.
📌 ¿Ha sido deportado de algún país? Indique cuál.
📌 ¿Ha solicitado anteriormente una visa americana? Indique cuándo (mes, día y año).`;
const { Client, LocalAuth } = WhatsAppWeb;

const phoneDigits = (value: string) => value.replace(/\D/g, "");

export function isAuthorizedCommandPhone(resolvedPhone: string, configuredPhone: string): boolean {
  return Boolean(configuredPhone) && phoneDigits(resolvedPhone) === phoneDigits(configuredPhone);
}

export const isAuthorizedBackupPhone = isAuthorizedCommandPhone;

export function parseAuthorizedSelfServiceCommand(value: string, resolvedPhone: string, configuredPhone: string): AdminBotCommand | null {
  return isAuthorizedCommandPhone(resolvedPhone, configuredPhone) ? parseAdminBotCommand(value) : null;
}

function serializedText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>)._serialized;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return null;
}

export function normalizeWhatsAppMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") return serializedText(value);
  const id = value as Record<string, unknown>;
  const serialized = serializedText(id._serialized);
  if (serialized) return serialized;
  const remote = serializedText(id.remote);
  const localId = typeof id.id === "string" && id.id.trim() ? id.id : null;
  if (!remote || !localId) return null;
  return `${id.fromMe === true}_${remote}_${localId}`;
}

export function repairWhatsAppMessageId(value: unknown): string | null {
  const serialized = normalizeWhatsAppMessageId(value);
  if (!serialized || !value || typeof value !== "object") return serialized;
  const id = value as Record<string, unknown>;
  if (!serializedText(id._serialized)) id._serialized = serialized;
  return serialized;
}

interface ChatIdentity {
  aliases: string[];
  phone: string;
}
type WorkflowKind = "CANADA" | "USA";

const AI_BYPASS_COMMANDS = new Set([
  "saltar", "no sé", "no se", "no tengo", "no aplica", "n/a", "pendiente", "después", "despues",
  "resumen", "pendientes", "ayuda", "alto", "pausa", "pausar", "detente", "para", "continuar", "borrar mis datos",
]);

function normalizedCommand(value: string): string {
  return value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function refersToPreviousAnswer(value: string): boolean {
  return /^(?:ya\s+(?:te\s+)?(?:lo|la)\s+(?:di|mande|envie)|ya\s+respondi|te\s+lo\s+acabo\s+de\s+dar|i\s+already\s+(?:gave|sent)\s+it)$/.test(normalizedCommand(value));
}

export function looksLikeUsableAddress(value: string): boolean {
  const clean = value.trim();
  return clean.length >= 8 && /\p{L}/u.test(clean) && /\d/.test(clean)
    && (clean.includes(",") || /\b(?:calle|carr(?:etera)?|av(?:enida)?|blvd|boulevard|road|rd|street|st|drive|dr|court|ct|trail|trl)\b/i.test(clean));
}

function timelineMessagePreview(body: string | undefined, type: string): string {
  const normalized = String(body ?? "").replace(/\s+/g, " ").trim();
  if (normalized) return normalized.slice(0, 500);
  if (type === "image") return "[Imagen]";
  if (type === "document") return "[Documento]";
  return `[Mensaje ${type || "sin texto"}]`;
}

export type AdminBotCommand = "START_CANADA" | "START_USA" | "START_ETA" | "STOP_ALL";

/** Exact, case-insensitive allow-list. No partial matches or extra words activate the bot. */
export function parseAdminBotCommand(value: string): AdminBotCommand | null {
  switch (value.trim().toLocaleUpperCase("es")) {
    case BOT_START_CANADA_COMMAND: return "START_CANADA";
    case BOT_START_USA_COMMAND: return "START_USA";
    case BOT_START_ETA_COMMAND: return "START_ETA";
    case BOT_STOP_COMMAND: return "STOP_ALL";
    default: return null;
  }
}

export interface WhatsAppRuntimeStatus {
  state: "STARTING" | "QR" | "AUTHENTICATED" | "READY" | "BACKUP" | "DISCONNECTED" | "ERROR";
  qrDataUrl: string | null;
  account: string | null;
  lastError: string | null;
  automationPaused: boolean;
}

export class WhatsAppLocalService {
  readonly client: InstanceType<typeof Client>;
  private runtime: WhatsAppRuntimeStatus;
  private readonly automationControlPath: string;
  private workerTimer: NodeJS.Timeout | null = null;
  private workerBusy = false;
  private backupInProgress = false;

  constructor(
    private readonly config: Config,
    private readonly store: SQLiteStore,
    private readonly drive: GoogleDriveService,
    private readonly fullBackup: FullBackupService,
    private readonly usaStore: SQLiteStore,
    private readonly usaDrive: GoogleDriveService,
    private readonly aiConversation: OpenAIConversationService,
  ) {
    this.automationControlPath = path.join(config.dataDir, "automation-control.json");
    this.runtime = { state: "STARTING", qrDataUrl: null, account: null, lastError: null, automationPaused: this.loadAutomationPaused() };
    const executablePath = config.CHROME_EXECUTABLE_PATH || this.findBrowser();
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.whatsappSessionPath, clientId: config.WHATSAPP_SESSION_ID }),
      puppeteer: {
        headless: !config.WHATSAPP_BROWSER_VISIBLE,
        ...(executablePath ? { executablePath } : {}),
      },
      deviceName: config.WHATSAPP_DEVICE_NAME,
      browserName: "Chrome",
    });
    this.bindEvents();
  }

  status(): WhatsAppRuntimeStatus { return { ...this.runtime }; }

  async setAutomationPaused(paused: boolean): Promise<WhatsAppRuntimeStatus> {
    await mkdir(path.dirname(this.automationControlPath), { recursive: true });
    const temporary = `${this.automationControlPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ paused, updatedAt: new Date().toISOString() }), "utf8");
    await rename(temporary, this.automationControlPath);
    this.runtime = { ...this.runtime, automationPaused: paused };
    this.store.audit(null, paused ? "AUTOMATION_PAUSED_FROM_DASHBOARD" : "AUTOMATION_RESUMED_FROM_DASHBOARD", {});
    return this.status();
  }

  async start(): Promise<void> {
    this.workerTimer = setInterval(() => void this.processPendingDocument(), 3_000);
    this.workerTimer.unref();
    try { await this.client.initialize(); }
    catch (error) { this.setError(error); }
  }

  async stop(): Promise<void> {
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = null;
    try { await this.client.destroy(); } catch { /* already closed */ }
  }

  private bindEvents(): void {
    this.client.on("qr", async (qr) => {
      this.runtime = { ...this.runtime, state: "QR", qrDataUrl: await QRCode.toDataURL(qr, { width: 320, margin: 1 }), account: null, lastError: null };
    });
    this.client.on("authenticated", () => {
      this.runtime = { ...this.runtime, state: this.backupInProgress ? "BACKUP" : "AUTHENTICATED", qrDataUrl: null, lastError: null };
    });
    this.client.on("ready", () => {
      this.backupInProgress = false;
      this.runtime = { ...this.runtime, state: "READY", qrDataUrl: null, account: this.client.info?.wid?._serialized ?? null, lastError: null };
    });
    this.client.on("auth_failure", (message) => { this.runtime = { ...this.runtime, state: "ERROR", lastError: message }; });
    this.client.on("disconnected", (reason) => {
      this.runtime = this.backupInProgress
        ? { ...this.runtime, state: "BACKUP", lastError: null }
        : { ...this.runtime, state: "DISCONNECTED", lastError: String(reason) };
    });
    this.client.on("message_create", (message) => {
      if (message.fromMe) void this.handleOwnerMessage(message).catch((error) => this.setError(error, false));
    });
    this.client.on("message", (message) => {
      if (!message.fromMe) void this.handleClientMessage(message).catch((error) => this.setError(error, false));
    });
  }

  private async handleOwnerMessage(message: Message): Promise<void> {
    let commandReceived: string | null = null;
    let chatId: string | null = null;
    const messageId = normalizeWhatsAppMessageId(message.id);
    try {
      const parsedCommand = parseAdminBotCommand(message.body);
      if (!parsedCommand || message.isStatus) return;
      if (this.runtime.automationPaused && parsedCommand !== "STOP_ALL") {
        this.store.audit(null, "ADMIN_COMMAND_IGNORED_WHILE_AUTOMATION_PAUSED", { command: parsedCommand });
        return;
      }
      commandReceived = parsedCommand;
      if (messageId && (this.store.isProcessed(messageId) || this.usaStore.isProcessed(messageId))) return;
      const rawMessageId = message.id as unknown;
      const remoteFromId = rawMessageId && typeof rawMessageId === "object"
        ? serializedText((rawMessageId as Record<string, unknown>).remote)
        : null;
      chatId = serializedText(message.to) ?? remoteFromId;
      if (!chatId) throw new Error("WhatsApp no devolvió un identificador válido para el chat");
      if (chatId.endsWith("@g.us") || chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter")) {
        if (messageId) this.store.markProcessed(messageId);
        return;
      }
      const identity = await this.resolveChatIdentity(chatId, [remoteFromId, serializedText(message.to)]);
      if (parsedCommand === "STOP_ALL") {
        await this.stopCaseByAdmin(chatId, identity, "CANADA", "OWNER");
        await this.stopCaseByAdmin(chatId, identity, "USA", "OWNER");
        if (messageId) {
          this.store.markProcessed(messageId);
          this.usaStore.markProcessed(messageId);
        }
      } else if (parsedCommand === "START_ETA") {
        if (messageId) this.store.markProcessed(messageId);
        this.store.audit(null, "ETA_START_COMMAND_RECEIVED", { chatId, messageId });
        await this.client.sendMessage(chatId, "El flujo eTA todavía no está habilitado. No se inició ningún expediente ni se enviarán más mensajes.");
      } else {
        const workflow: WorkflowKind = parsedCommand === "START_USA" ? "USA" : "CANADA";
        await this.startOrResumeCase(chatId, identity, "OWNER", workflow);
        if (messageId) this.storeFor(workflow).markProcessed(messageId);
      }
      this.runtime = { ...this.runtime, lastError: null };
    } catch (error) {
      if (commandReceived) this.store.audit(null, "BOT_ADMIN_COMMAND_FAILED", {
        command: commandReceived,
        chatId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setError(error, false);
    }
  }

  private storeFor(workflow: WorkflowKind): SQLiteStore { return workflow === "USA" ? this.usaStore : this.store; }
  private driveFor(workflow: WorkflowKind): GoogleDriveService { return workflow === "USA" ? this.usaDrive : this.drive; }

  private caseForIdentity(chatId: string, identity: ChatIdentity, workflow: WorkflowKind): CaseRecord | null {
    const store = this.storeFor(workflow);
    let caseRecord = store.getCaseByChatId(chatId);
    if (!caseRecord) {
      for (const alias of identity.aliases) {
        caseRecord = store.getCaseByChatId(alias);
        if (caseRecord) break;
      }
    }
    if (caseRecord) for (const alias of identity.aliases) store.addChatAlias(caseRecord.id, alias);
    return caseRecord;
  }

  private async stopCaseByAdmin(chatId: string, identity: ChatIdentity, workflow: WorkflowKind, initiatedBy: "OWNER" | "TEST_PHONE"): Promise<void> {
    const store = this.storeFor(workflow);
    const caseRecord = this.caseForIdentity(chatId, identity, workflow);
    if (!caseRecord) {
      store.audit(null, "BOT_STOP_WITHOUT_CASE_IGNORED", { chatId, workflow });
      return;
    }
    if (["NEEDS_STAFF_REVIEW", "READY_FOR_REVIEW", "COMPLETE", "DECLINED", "DELETION_REQUESTED"].includes(caseRecord.status)) {
      store.audit(caseRecord.id, "BOT_STOP_IGNORED_FOR_CLOSED_CASE", { status: caseRecord.status });
      return;
    }
    const result = workflow === "USA" ? stopUsaIntake(caseRecord) : stopIntakeByAdmin(caseRecord);
    store.saveCase(result.caseRecord);
    for (const event of result.auditEvents) store.audit(caseRecord.id, event.event, { ...event.detail, chatId, initiatedBy });
  }

  private async startOrResumeCase(chatId: string, identity: ChatIdentity, initiatedBy: "OWNER" | "TEST_PHONE", workflow: WorkflowKind): Promise<void> {
    const store = this.storeFor(workflow);
    const otherWorkflow: WorkflowKind = workflow === "USA" ? "CANADA" : "USA";
    const otherCase = this.caseForIdentity(chatId, identity, otherWorkflow);
    if (otherCase && ["ACTIVE", "PAUSED", "WAITING_FOR_CLIENT"].includes(otherCase.status)) {
      await this.sendTrackedText(chatId, `Primero detén el bot de ${otherWorkflow === "USA" ? "USA" : "Canadá"} para evitar que las respuestas se asignen al expediente equivocado.`, this.storeFor(otherWorkflow), otherCase.id);
      return;
    }
    const existing = this.caseForIdentity(chatId, identity, workflow);
    if (existing) {
      let result: ReturnType<typeof startIntake> | null = null;
      if (["DRAFT", "INVITED", "AWAITING_CONSENT"].includes(existing.status)) {
        result = workflow === "USA" ? startUsaIntake(existing) : startIntake(existing);
      } else if (existing.status === "PAUSED") {
        result = workflow === "USA" ? handleUsaText(existing, "CONTINUAR") : handleClientText(existing, "CONTINUAR");
      } else if (existing.status === "STOPPED_BY_ADMIN"
        || (workflow === "CANADA" && existing.status === "NEEDS_STAFF_REVIEW" && hasPendingClientPassportQuestions(existing))) {
        result = workflow === "USA" ? resumeUsaIntake(existing) : resumeIntakeByAdmin(existing);
      }
      if (result) {
        store.saveCase(result.caseRecord);
        store.audit(existing.id, "BOT_STARTED_OR_RESUMED_FROM_CHAT", { chatId, initiatedBy, workflow });
        for (const event of result.auditEvents) store.audit(existing.id, event.event, event.detail);
        await this.sendAll(chatId, result.outgoing, store, existing.id);
        return;
      }
      store.audit(existing.id, "DUPLICATE_START_IGNORED", { status: existing.status, initiatedBy });
      await this.sendTrackedText(chatId, "Tu expediente ya está iniciado y conserva todo el avance. El cliente puede responder la pregunta pendiente o pedir un resumen.", store, existing.id);
      return;
    }

    const displayName = identity.phone || "Cliente de WhatsApp";
    const caseRecord = store.createCase(chatId, identity.phone, displayName);
    for (const alias of identity.aliases) store.addChatAlias(caseRecord.id, alias);
    caseRecord.status = "INVITED";
    caseRecord.invitedAt = new Date().toISOString();
    const result = workflow === "USA" ? startUsaIntake(caseRecord) : startIntake(caseRecord);
    store.saveCase(result.caseRecord);
    store.audit(caseRecord.id, "BOT_STARTED_FROM_CHAT", { chatId, initiatedBy, workflow });
    for (const event of result.auditEvents) store.audit(caseRecord.id, event.event, event.detail);
    await this.sendAll(chatId, result.outgoing, store, caseRecord.id);
  }

  private async handleClientMessage(message: Message): Promise<void> {
    let timelineStore: SQLiteStore | null = null;
    let timelineClientId: string | null = null;
    try {
      if (message.isStatus || message.broadcast) return;
      const messageId = normalizeWhatsAppMessageId(message.id);
      if (!messageId) {
        const rawId = message.id as unknown;
        this.store.audit(null, "WHATSAPP_MESSAGE_WITHOUT_VALID_ID_IGNORED", {
          messageType: String(message.type ?? "unknown"),
          idKeys: rawId && typeof rawId === "object" ? Object.keys(rawId as Record<string, unknown>) : [],
        });
        return;
      }
      if (this.store.isProcessed(messageId) || this.usaStore.isProcessed(messageId)) return;
      const rawMessageId = message.id as unknown;
      const remoteFromId = rawMessageId && typeof rawMessageId === "object"
        ? serializedText((rawMessageId as Record<string, unknown>).remote)
        : null;
      const sourceChatId = serializedText(message.from) ?? remoteFromId;
      if (!sourceChatId) {
        this.store.audit(null, "WHATSAPP_MESSAGE_WITHOUT_VALID_CHAT_IGNORED", { messageType: String(message.type ?? "unknown") });
        return;
      }
      if (sourceChatId.endsWith("@g.us") || sourceChatId.endsWith("@broadcast") || sourceChatId.endsWith("@newsletter")) {
        this.store.markProcessed(messageId);
        return;
      }
      const identity = await this.resolveChatIdentity(sourceChatId, [remoteFromId, serializedText(message.from)]);
      const parsedIncomingCommand = parseAdminBotCommand(message.body);
      const selfServiceCommand = parseAuthorizedSelfServiceCommand(message.body, identity.phone, this.config.TEST_SELF_START_PHONE);
      if (parsedIncomingCommand && !selfServiceCommand) {
        this.store.audit(null, "UNAUTHORIZED_CLIENT_BOT_COMMAND_IGNORED", { command: parsedIncomingCommand, phone: identity.phone });
        this.store.markProcessed(messageId);
        return;
      }
      if (selfServiceCommand) {
        if (this.runtime.automationPaused && selfServiceCommand !== "STOP_ALL") {
          this.store.audit(null, "TEST_PHONE_COMMAND_IGNORED_WHILE_AUTOMATION_PAUSED", { command: selfServiceCommand, phone: identity.phone });
          this.store.markProcessed(messageId);
          return;
        }
        if (selfServiceCommand === "STOP_ALL") {
          await this.stopCaseByAdmin(sourceChatId, identity, "CANADA", "TEST_PHONE");
          await this.stopCaseByAdmin(sourceChatId, identity, "USA", "TEST_PHONE");
          this.store.markProcessed(messageId);
          this.usaStore.markProcessed(messageId);
          return;
        }
        if (selfServiceCommand === "START_ETA") {
          this.store.markProcessed(messageId);
          await this.client.sendMessage(sourceChatId, "El flujo eTA todavía no está habilitado. No se inició ningún expediente.");
          return;
        }
        const requestedWorkflow: WorkflowKind = selfServiceCommand === "START_USA" ? "USA" : "CANADA";
        await this.startOrResumeCase(sourceChatId, identity, "TEST_PHONE", requestedWorkflow);
        this.storeFor(requestedWorkflow).markProcessed(messageId);
        return;
      }

      // Normal incoming client messages never activate a workflow. The sole
      // exception above is the explicitly configured testing phone.
      const canadaCase = this.caseForIdentity(sourceChatId, identity, "CANADA");
      const usaCase = this.caseForIdentity(sourceChatId, identity, "USA");
      const open = (record: CaseRecord | null) => record && !["STOPPED_BY_ADMIN", "NEEDS_STAFF_REVIEW", "READY_FOR_REVIEW", "COMPLETE", "DECLINED", "DELETION_REQUESTED"].includes(record.status);
      const workflow: WorkflowKind | null = open(usaCase) ? "USA" : open(canadaCase) ? "CANADA" : null;
      const caseRecord = workflow === "USA" ? usaCase : workflow === "CANADA" ? canadaCase : null;
      const activeStore = workflow ? this.storeFor(workflow) : null;
      const matchingClosedCase = caseRecord ?? usaCase ?? canadaCase;
      const matchingStore = caseRecord && activeStore ? activeStore : usaCase ? this.usaStore : canadaCase ? this.store : null;
      if (matchingClosedCase && matchingStore) {
        timelineStore = matchingStore;
        timelineClientId = matchingClosedCase.id;
        matchingStore.audit(matchingClosedCase.id, "CLIENT_MESSAGE_RECEIVED", {
          messageId,
          messageType: String(message.type ?? "unknown"),
          preview: timelineMessagePreview(message.body, String(message.type ?? "unknown")),
          ignoredBecauseClosed: !caseRecord,
          ignoredBecausePaused: this.runtime.automationPaused,
        });
      }
      if (this.runtime.automationPaused) {
        (matchingStore ?? this.store).markProcessed(messageId);
        return;
      }
      if (!caseRecord) {
        (matchingStore ?? this.store).markProcessed(messageId);
        return;
      }
      if (caseRecord.status === "STOPPED_BY_ADMIN") {
        this.store.markProcessed(messageId);
        return;
      }
      if (["NEEDS_STAFF_REVIEW", "READY_FOR_REVIEW", "COMPLETE", "DECLINED", "DELETION_REQUESTED"].includes(caseRecord.status)) {
        // The WhatsApp connection is global, but closed case content is neither
        // persisted nor processed once the source chat has been identified.
        return;
      }

      if (message.hasMedia && ["image", "document"].includes(message.type)) {
        if (caseRecord.status !== "ACTIVE") {
          const result = workflow === "USA" ? handleUsaText(caseRecord, message.body || "") : handleClientText(caseRecord, message.body || "");
          activeStore!.saveCase(result.caseRecord);
          activeStore!.markProcessed(messageId);
          await this.sendAll(sourceChatId, result.outgoing, activeStore!, caseRecord.id);
          return;
        }
        activeStore!.queueDocument(caseRecord.id, messageId);
        activeStore!.markProcessed(messageId);
        await this.sendTrackedText(sourceChatId, "Recibí tu archivo. Lo estoy guardando en tu carpeta; te aviso en cuanto termine.", activeStore!, caseRecord.id);
        void this.processPendingDocument();
        return;
      }

      if (message.hasMedia) {
        activeStore!.markProcessed(messageId);
        await this.sendTrackedText(sourceChatId, "Por ahora solo puedo guardar fotos y archivos PDF. Envíame el pasaporte en uno de esos formatos.", activeStore!, caseRecord.id);
        return;
      }

      const previousFullName = caseRecord.answers["identity.full_name"]?.value;
      const result = await this.handleConversationText(workflow!, caseRecord, message.body, messageId);
      activeStore!.saveCase(result.caseRecord);
      for (const event of result.auditEvents) activeStore!.audit(caseRecord.id, event.event, event.detail);
      activeStore!.markProcessed(messageId);
      const currentFullName = result.caseRecord.answers["identity.full_name"]?.value;
      if (typeof currentFullName === "string" && currentFullName !== previousFullName) {
        void this.driveFor(workflow!).syncClientFolderName(caseRecord.id).catch((error) => {
          activeStore!.audit(caseRecord.id, "DRIVE_FOLDER_NAME_SYNC_FAILED", { error: error instanceof Error ? error.message : String(error) });
        });
      }
      await this.sendAll(sourceChatId, result.outgoing, activeStore!, caseRecord.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (timelineStore && timelineClientId) timelineStore.audit(timelineClientId, "CLIENT_MESSAGE_PROCESSING_FAILED", { error: detail });
      this.setError(error, false);
    }
  }

  private previousAnswerAfterAiClarification(workflow: WorkflowKind, clientId: string, currentMessageId: string, fieldId: string): string | null {
    const details = this.storeFor(workflow).getClientDetails(clientId);
    const events = Array.isArray(details?.auditEvents) ? details.auditEvents as Array<{ event?: unknown; detail?: unknown }> : [];
    const currentIndex = events.findIndex((item) => item.event === "CLIENT_MESSAGE_RECEIVED"
      && (item.detail as Record<string, unknown> | undefined)?.messageId === currentMessageId);
    if (currentIndex < 0) return null;
    const clarificationIndex = events.findIndex((item, index) => index > currentIndex
      && item.event === "AI_INTERPRETATION_COMPLETED"
      && (item.detail as Record<string, unknown> | undefined)?.fieldId === fieldId
      && (item.detail as Record<string, unknown> | undefined)?.action === "CLARIFY");
    if (clarificationIndex < 0) return null;
    const previous = events.find((item, index) => index > clarificationIndex && item.event === "CLIENT_MESSAGE_RECEIVED");
    const preview = (previous?.detail as Record<string, unknown> | undefined)?.preview;
    return typeof preview === "string" && preview.trim() && !refersToPreviousAnswer(preview) ? preview.trim() : null;
  }

  private async handleConversationText(workflow: WorkflowKind, caseRecord: CaseRecord, raw: string, messageId: string): Promise<ReturnType<typeof handleClientText>> {
    const deterministic = (value: string) => workflow === "USA" ? handleUsaText(caseRecord, value) : handleClientText(caseRecord, value);
    const aiStatus = this.aiConversation.status();
    if (!aiStatus.active || !raw.trim() || !["ACTIVE", "PAUSED"].includes(caseRecord.status)) return deterministic(raw);
    if (!caseRecord.currentFieldId || caseRecord.currentFieldId === "__proposal_batch__") return deterministic(raw);
    if (AI_BYPASS_COMMANDS.has(normalizedCommand(raw))) return deterministic(raw);
    if (/^(?:hola|buen(?:os|as)?\s+(?:dias|tardes|noches)|que\s+tal)$/i.test(normalizedCommand(raw))) return deterministic(raw);

    const field = workflow === "USA"
      ? usaFieldById(caseRecord.currentFieldId, caseRecord.answers)
      : fieldById(caseRecord.currentFieldId, caseRecord.answers);
    if (!field || field.id === "workflow.passport_uploaded" || field.id.endsWith(".document")) return deterministic(raw);

    const recoveredAnswer = refersToPreviousAnswer(raw)
      ? this.previousAnswerAfterAiClarification(workflow, caseRecord.id, messageId, field.id)
      : null;
    const effectiveRaw = recoveredAnswer ?? raw;

    try {
      const interpretation = await this.aiConversation.interpret(workflow, field, effectiveRaw);
      const addressSafeguard = /(?:^|\.)(?:residential_address|mailing_address|address)$/.test(field.id)
        && looksLikeUsableAddress(effectiveRaw);
      const aiAudit = {
        event: "AI_INTERPRETATION_COMPLETED",
        detail: {
          workflow,
          fieldId: field.id,
          action: addressSafeguard && interpretation.action === "CLARIFY" ? "ANSWER_ADDRESS_SAFEGUARD" : interpretation.action,
          confidence: interpretation.confidence,
          model: aiStatus.model,
          recoveredPreviousAnswer: Boolean(recoveredAnswer),
        },
      };
      if (!addressSafeguard && (interpretation.action !== "ANSWER" || interpretation.confidence < 75 || !interpretation.normalizedAnswer.trim())) {
        return {
          caseRecord,
          outgoing: [{ type: "text", body: `Quiero asegurarme de registrar correctamente *${field.label.toLocaleLowerCase("es")}*.\n\n${field.prompt}` }],
          auditEvents: [aiAudit],
        };
      }
      const result = deterministic(addressSafeguard ? effectiveRaw : interpretation.normalizedAnswer);
      const accepted = result.auditEvents.some((event) => /ANSWER_(?:CONFIRMED|RECORDED)/.test(event.event));
      if (accepted && result.caseRecord.status === "ACTIVE" && result.outgoing[0]?.type === "text") {
        result.outgoing[0] = { type: "text", body: `Perfecto, gracias.\n\n${result.outgoing[0].body}` };
      }
      result.auditEvents.unshift(aiAudit);
      return result;
    } catch (error) {
      const result = deterministic(raw);
      result.auditEvents.unshift({
        event: "AI_INTERPRETATION_FAILED",
        detail: { workflow, fieldId: field.id, model: aiStatus.model, error: error instanceof Error ? error.message : String(error), fallback: "DETERMINISTIC_ENGINE" },
      });
      return result;
    }
  }

  private async processPendingDocument(): Promise<void> {
    if (this.workerBusy || this.runtime.state !== "READY" || this.runtime.automationPaused) return;
    this.workerBusy = true;
    let job: PendingDocument | null = null;
    let workflow: WorkflowKind = "CANADA";
    let activeStore = this.store;
    try {
      job = this.store.claimDocument();
      if (!job) {
        workflow = "USA";
        activeStore = this.usaStore;
        job = this.usaStore.claimDocument();
      }
      if (!job) return;
      let message: Message | null;
      try {
        message = await this.client.getMessageById(job.whatsappMessageId);
      } catch (error) {
        throw new Error(`No fue posible recuperar el mensaje desde WhatsApp: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!message) throw new Error("WhatsApp ya no tiene disponible el mensaje del archivo");
      if (!repairWhatsAppMessageId(message.id)) throw new Error("WhatsApp devolvió el archivo sin un identificador utilizable");
      let media;
      try {
        media = await message.downloadMedia();
      } catch (error) {
        throw new Error(`No fue posible descargar el archivo desde WhatsApp: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!media) throw new Error("No fue posible descargar el archivo de WhatsApp");
      if (!ALLOWED_MIME.has(media.mimetype)) {
        activeStore.rejectDocument(job.id, `Formato no permitido: ${media.mimetype}`);
        await this.sendTrackedText(message.from, "No pude guardar ese formato. Envíame una foto JPG/PNG/WEBP o un PDF.", activeStore, job.clientId);
        return;
      }
      const bytes = Buffer.from(media.data, "base64");
      if (bytes.length > this.config.MAX_DOCUMENT_MB * 1024 * 1024) {
        activeStore.rejectDocument(job.id, "Archivo demasiado grande");
        await this.sendTrackedText(message.from, `El archivo supera ${this.config.MAX_DOCUMENT_MB} MB. Envíame una versión más pequeña.`, activeStore, job.clientId);
        return;
      }
      const uploaded = await this.driveFor(workflow).uploadClientDocument(job.clientId, bytes, media.mimetype, media.filename ?? null);
      activeStore.completeDocument(job, uploaded);
      const caseRecord = activeStore.getCaseById(job.clientId);
      if (!caseRecord) return;
      const result = workflow === "USA" ? handleUsaDocument(caseRecord, uploaded.driveFileId) : handlePassportDocument(caseRecord, uploaded.driveFileId, []);
      activeStore.saveCase(result.caseRecord);
      for (const event of result.auditEvents) activeStore.audit(caseRecord.id, event.event, event.detail);
      await this.sendTrackedText(message.from, "✅ Tu archivo quedó guardado correctamente en la carpeta de este expediente.", activeStore, caseRecord.id);
      await this.sendAll(message.from, result.outgoing, activeStore, caseRecord.id);
    } catch (error) {
      if (job) {
        const detail = error instanceof Error ? error.message : "Error desconocido";
        activeStore.failDocument(job.id, detail);
        activeStore.audit(job.clientId, "DOCUMENT_PROCESSING_FAILED", { error: detail, jobId: job.id });
      }
      this.setError(error, false);
    } finally {
      this.workerBusy = false;
    }
  }

  private async sendAll(chatId: string, outgoing: OutgoingMessage[], store: SQLiteStore, clientId: string): Promise<void> {
    for (const message of outgoing) {
      if (message.type === "text") await this.sendTrackedText(chatId, message.body, store, clientId);
    }
  }

  private async sendTrackedText(chatId: string, body: string, store: SQLiteStore, clientId: string): Promise<void> {
    const preview = timelineMessagePreview(body, "text");
    try {
      const sent = await this.client.sendMessage(chatId, body);
      store.audit(clientId, "BOT_MESSAGE_SENT", { messageId: normalizeWhatsAppMessageId(sent?.id), preview });
    } catch (error) {
      store.audit(clientId, "BOT_MESSAGE_SEND_FAILED", { preview, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async startFullBackup(chatId: string, messageId: string): Promise<void> {
    if (this.backupInProgress || this.fullBackup.isRunning()) {
      await this.client.sendMessage(chatId, "Ya hay un respaldo completo en proceso. Te avisaré por aquí cuando termine.");
      return;
    }
    await this.client.sendMessage(chatId, "🗜️ Inicié el respaldo completo del sistema. La carpeta ocupa aproximadamente 1 GB, así que puede tardar varios minutos. El bot se desconectará temporalmente para incluir todos sus archivos y volverá a conectarse por sí solo. Te avisaré cuando termine.");
    this.store.audit(null, "FULL_BACKUP_STARTED", { chatId, messageId, outputDirectory: this.config.fullBackupOutputDir });
    this.backupInProgress = true;
    this.runtime = { ...this.runtime, state: "BACKUP", lastError: null };
    void this.executeFullBackup(chatId).catch((error) => {
      this.backupInProgress = false;
      this.setError(error);
      this.store.audit(null, "FULL_BACKUP_COORDINATION_FAILED", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async executeFullBackup(chatId: string): Promise<void> {
    let result: Awaited<ReturnType<FullBackupService["create"]>> | null = null;
    let backupError: unknown = null;
    try {
      // Chromium holds a few session files exclusively. Closing only the
      // WhatsApp browser releases them so the ZIP can contain the whole folder.
      await this.client.destroy();
      result = await this.fullBackup.create();
    } catch (error) {
      backupError = error;
    }

    try {
      await this.reconnectAfterFullBackup();
    } catch (reconnectError) {
      const backupDetail = backupError instanceof Error ? backupError.message : backupError ? String(backupError) : null;
      const reconnectDetail = reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
      throw new Error([backupDetail, `No fue posible reconectar WhatsApp: ${reconnectDetail}`].filter(Boolean).join(" | "));
    }

    if (!result) {
      const detail = backupError instanceof Error ? backupError.message : String(backupError);
      this.store.audit(null, "FULL_BACKUP_FAILED", { error: detail });
      await this.client.sendMessage(chatId, `❌ No pude completar el respaldo.\n\nDetalle: ${detail}`);
      return;
    }

    const size = result.bytes >= 1024 ** 3
      ? `${(result.bytes / 1024 ** 3).toFixed(2)} GB`
      : `${(result.bytes / 1024 ** 2).toFixed(1)} MB`;
    this.store.audit(null, "FULL_BACKUP_COMPLETED", { path: result.path, bytes: result.bytes, durationMs: result.durationMs });
    await this.client.sendMessage(chatId, `✅ Respaldo terminado correctamente.\n\n*Archivo:* ${result.filename}\n*Tamaño:* ${size}\n*Guardado en:* ${result.path}`);
  }

  private async reconnectAfterFullBackup(): Promise<void> {
    await this.client.initialize();
    const deadline = Date.now() + 120_000;
    while (this.runtime.state !== "READY" && Date.now() < deadline) {
      if (this.runtime.state === "ERROR") throw new Error(this.runtime.lastError || "falló la autenticación");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (this.runtime.state !== "READY") throw new Error("WhatsApp no quedó listo después de 2 minutos");
  }

  private async resolveChatIdentity(primaryChatId: string, candidates: Array<string | null> = []): Promise<ChatIdentity> {
    const aliases = new Set([primaryChatId, ...candidates.filter((value): value is string => Boolean(value))]);
    try {
      const mappings = await this.client.getContactLidAndPhone([...aliases]);
      for (const mapping of mappings) {
        if (mapping.lid) aliases.add(mapping.lid);
        if (mapping.pn) aliases.add(mapping.pn);
      }
    } catch {
      // Some WhatsApp contacts cannot be resolved immediately. The primary
      // chat ID and Chat object ID remain enough to continue the conversation.
    }
    const phoneAddress = [...aliases].find((alias) => alias.endsWith("@c.us") || alias.endsWith("@s.whatsapp.net"));
    const digits = phoneAddress?.split("@")[0]?.replace(/\D/g, "") ?? "";
    return { aliases: [...aliases], phone: /^\d{7,15}$/.test(digits) ? `+${digits}` : "" };
  }

  private findBrowser(): string | undefined {
    const candidates = process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
    return candidates.find(existsSync);
  }

  private setError(error: unknown, changeState = true): void {
    const message = error instanceof Error ? error.message : String(error);
    this.runtime = { ...this.runtime, ...(changeState ? { state: "ERROR" as const } : {}), lastError: message };
  }

  private loadAutomationPaused(): boolean {
    try {
      const saved = JSON.parse(readFileSync(this.automationControlPath, "utf8")) as { paused?: unknown };
      return saved.paused === true;
    } catch {
      return false;
    }
  }
}
