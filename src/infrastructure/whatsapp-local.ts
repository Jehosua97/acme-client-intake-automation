import { existsSync } from "node:fs";
import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";
import type { Message } from "whatsapp-web.js";
import type { Config } from "../config.js";
import { handleClientText, handlePassportDocument, hasPendingClientPassportQuestions, resumeIntakeByAdmin, startIntake, stopIntakeByAdmin } from "../domain/engine.js";
import type { CaseRecord, OutgoingMessage } from "../domain/types.js";
import type { GoogleDriveService } from "./google-drive.js";
import type { FullBackupService } from "./full-backup.js";
import type { PendingDocument, SQLiteStore } from "./sqlite-store.js";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const BOT_START_COMMAND = "INICIAR BOT";
const BOT_STOP_COMMAND = "DETENER BOT";
const FULL_BACKUP_COMMAND = "HACER RESPALDO BACKUP";
const { Client, LocalAuth } = WhatsAppWeb;

const phoneDigits = (value: string) => value.replace(/\D/g, "");

export function isAuthorizedCommandPhone(resolvedPhone: string, configuredPhone: string): boolean {
  return Boolean(configuredPhone) && phoneDigits(resolvedPhone) === phoneDigits(configuredPhone);
}

export const isAuthorizedBackupPhone = isAuthorizedCommandPhone;

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

export interface WhatsAppRuntimeStatus {
  state: "STARTING" | "QR" | "AUTHENTICATED" | "READY" | "BACKUP" | "DISCONNECTED" | "ERROR";
  qrDataUrl: string | null;
  account: string | null;
  lastError: string | null;
}

export class WhatsAppLocalService {
  readonly client: InstanceType<typeof Client>;
  private runtime: WhatsAppRuntimeStatus = { state: "STARTING", qrDataUrl: null, account: null, lastError: null };
  private workerTimer: NodeJS.Timeout | null = null;
  private workerBusy = false;
  private backupInProgress = false;

  constructor(
    private readonly config: Config,
    private readonly store: SQLiteStore,
    private readonly drive: GoogleDriveService,
    private readonly fullBackup: FullBackupService,
  ) {
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
      this.runtime = { state: "QR", qrDataUrl: await QRCode.toDataURL(qr, { width: 320, margin: 1 }), account: null, lastError: null };
    });
    this.client.on("authenticated", () => {
      this.runtime = { ...this.runtime, state: this.backupInProgress ? "BACKUP" : "AUTHENTICATED", qrDataUrl: null, lastError: null };
    });
    this.client.on("ready", () => {
      this.backupInProgress = false;
      this.runtime = { state: "READY", qrDataUrl: null, account: this.client.info?.wid?._serialized ?? null, lastError: null };
      void this.recoverRecentStartCommands();
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
      const command = message.body.trim().toLocaleUpperCase("es");
      if (![BOT_START_COMMAND, BOT_STOP_COMMAND].includes(command) || message.isStatus) return;
      commandReceived = command;
      if (messageId && this.store.isProcessed(messageId)) return;
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
      if (command === BOT_STOP_COMMAND) {
        await this.stopCaseByAdmin(chatId, identity);
      } else {
        await this.startOrResumeCase(chatId, identity, "OWNER");
      }
      if (messageId) this.store.markProcessed(messageId);
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

  private caseForIdentity(chatId: string, identity: ChatIdentity): CaseRecord | null {
    let caseRecord = this.store.getCaseByChatId(chatId);
    if (!caseRecord) {
      for (const alias of identity.aliases) {
        caseRecord = this.store.getCaseByChatId(alias);
        if (caseRecord) break;
      }
    }
    if (caseRecord) for (const alias of identity.aliases) this.store.addChatAlias(caseRecord.id, alias);
    return caseRecord;
  }

  private async stopCaseByAdmin(chatId: string, identity: ChatIdentity): Promise<void> {
    const caseRecord = this.caseForIdentity(chatId, identity);
    if (!caseRecord) {
      this.store.audit(null, "BOT_STOP_WITHOUT_CASE_IGNORED", { chatId });
      return;
    }
    if (["NEEDS_STAFF_REVIEW", "READY_FOR_REVIEW", "COMPLETE", "DECLINED", "DELETION_REQUESTED"].includes(caseRecord.status)) {
      this.store.audit(caseRecord.id, "BOT_STOP_IGNORED_FOR_CLOSED_CASE", { status: caseRecord.status });
      return;
    }
    const result = stopIntakeByAdmin(caseRecord);
    this.store.saveCase(result.caseRecord);
    for (const event of result.auditEvents) this.store.audit(caseRecord.id, event.event, { ...event.detail, chatId });
  }

  private async startOrResumeCase(chatId: string, identity: ChatIdentity, initiatedBy: "OWNER" | "TEST_PHONE"): Promise<void> {
    const existing = this.caseForIdentity(chatId, identity);
    if (existing) {
      let result: ReturnType<typeof startIntake> | null = null;
      if (["DRAFT", "INVITED", "AWAITING_CONSENT"].includes(existing.status)) {
        result = startIntake(existing);
      } else if (existing.status === "PAUSED") {
        result = handleClientText(existing, "CONTINUAR");
      } else if ((existing.status === "STOPPED_BY_ADMIN" && initiatedBy === "OWNER")
        || (existing.status === "NEEDS_STAFF_REVIEW" && hasPendingClientPassportQuestions(existing))) {
        result = resumeIntakeByAdmin(existing);
      }
      if (result) {
        this.store.saveCase(result.caseRecord);
        this.store.audit(existing.id, "BOT_STARTED_OR_RESUMED_FROM_CHAT", { chatId, initiatedBy });
        for (const event of result.auditEvents) this.store.audit(existing.id, event.event, event.detail);
        await this.sendAll(chatId, result.outgoing);
        return;
      }
      if (existing.status === "STOPPED_BY_ADMIN") {
        this.store.audit(existing.id, "TEST_PHONE_START_IGNORED_AFTER_ADMIN_STOP", { initiatedBy });
        return;
      }
      this.store.audit(existing.id, "DUPLICATE_START_IGNORED", { status: existing.status, initiatedBy });
      await this.client.sendMessage(chatId, "Tu expediente ya está iniciado y conserva todo el avance. El cliente puede responder la pregunta pendiente o pedir un resumen.");
      return;
    }

    const displayName = identity.phone || "Cliente de WhatsApp";
    const caseRecord = this.store.createCase(chatId, identity.phone, displayName);
    for (const alias of identity.aliases) this.store.addChatAlias(caseRecord.id, alias);
    caseRecord.status = "INVITED";
    caseRecord.invitedAt = new Date().toISOString();
    const result = startIntake(caseRecord);
    this.store.saveCase(result.caseRecord);
    this.store.audit(caseRecord.id, "BOT_STARTED_FROM_CHAT", { chatId, initiatedBy });
    for (const event of result.auditEvents) this.store.audit(caseRecord.id, event.event, event.detail);
    await this.sendAll(chatId, result.outgoing);
  }

  private async handleClientMessage(message: Message): Promise<void> {
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
      if (this.store.isProcessed(messageId)) return;
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
      if (message.body.trim().toLocaleUpperCase("es") === BOT_START_COMMAND) {
        const identity = await this.resolveChatIdentity(sourceChatId, [remoteFromId, serializedText(message.from)]);
        const authorized = isAuthorizedCommandPhone(identity.phone, this.config.TEST_SELF_START_PHONE);
        this.store.markProcessed(messageId);
        if (!authorized) {
          this.store.audit(null, "CLIENT_START_COMMAND_REJECTED", { sourceChatId, resolvedPhone: identity.phone || null });
          return;
        }
        this.store.audit(null, "TEST_PHONE_START_COMMAND_RECEIVED", { sourceChatId, resolvedPhone: identity.phone });
        await this.startOrResumeCase(sourceChatId, identity, "TEST_PHONE");
        return;
      }
      if (message.body.trim().toLocaleUpperCase("es") === FULL_BACKUP_COMMAND) {
        const identity = await this.resolveChatIdentity(sourceChatId, [remoteFromId, serializedText(message.from)]);
        const authorized = isAuthorizedBackupPhone(identity.phone, this.config.BACKUP_ADMIN_PHONE);
        this.store.markProcessed(messageId);
        if (!authorized) {
          this.store.audit(null, "FULL_BACKUP_COMMAND_REJECTED", { sourceChatId, resolvedPhone: identity.phone || null });
          return;
        }
        await this.startFullBackup(sourceChatId, messageId);
        return;
      }
      let caseRecord = this.store.getCaseByChatId(sourceChatId);
      if (!caseRecord) {
        const identity = await this.resolveChatIdentity(sourceChatId, [remoteFromId, serializedText(message.from)]);
        for (const alias of identity.aliases) {
          caseRecord = this.store.getCaseByChatId(alias);
          if (caseRecord) break;
        }
        if (caseRecord) for (const alias of identity.aliases) this.store.addChatAlias(caseRecord.id, alias);
      }
      if (!caseRecord) { this.store.markProcessed(messageId); return; }
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
          const result = handleClientText(caseRecord, message.body || "");
          this.store.saveCase(result.caseRecord);
          this.store.markProcessed(messageId);
          await this.sendAll(sourceChatId, result.outgoing);
          return;
        }
        this.store.queueDocument(caseRecord.id, messageId);
        this.store.markProcessed(messageId);
        await this.client.sendMessage(sourceChatId, "Recibí tu archivo. Lo estoy guardando en tu carpeta; te aviso en cuanto termine.");
        void this.processPendingDocument();
        return;
      }

      if (message.hasMedia) {
        this.store.markProcessed(messageId);
        await this.client.sendMessage(sourceChatId, "Por ahora solo puedo guardar fotos y archivos PDF. Envíame el pasaporte en uno de esos formatos.");
        return;
      }

      const previousFullName = caseRecord.answers["identity.full_name"]?.value;
      const result = handleClientText(caseRecord, message.body);
      this.store.saveCase(result.caseRecord);
      for (const event of result.auditEvents) this.store.audit(caseRecord.id, event.event, event.detail);
      this.store.markProcessed(messageId);
      const currentFullName = result.caseRecord.answers["identity.full_name"]?.value;
      if (typeof currentFullName === "string" && currentFullName !== previousFullName) {
        void this.drive.syncClientFolderName(caseRecord.id).catch((error) => {
          this.store.audit(caseRecord.id, "DRIVE_FOLDER_NAME_SYNC_FAILED", { error: error instanceof Error ? error.message : String(error) });
        });
      }
      await this.sendAll(sourceChatId, result.outgoing);
    } catch (error) { this.setError(error, false); }
  }

  private async processPendingDocument(): Promise<void> {
    if (this.workerBusy || this.runtime.state !== "READY") return;
    this.workerBusy = true;
    let job: PendingDocument | null = null;
    try {
      job = this.store.claimDocument();
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
        this.store.rejectDocument(job.id, `Formato no permitido: ${media.mimetype}`);
        await this.client.sendMessage(message.from, "No pude guardar ese formato. Envíame una foto JPG/PNG/WEBP o un PDF.");
        return;
      }
      const bytes = Buffer.from(media.data, "base64");
      if (bytes.length > this.config.MAX_DOCUMENT_MB * 1024 * 1024) {
        this.store.rejectDocument(job.id, "Archivo demasiado grande");
        await this.client.sendMessage(message.from, `El archivo supera ${this.config.MAX_DOCUMENT_MB} MB. Envíame una versión más pequeña.`);
        return;
      }
      const uploaded = await this.drive.uploadClientDocument(job.clientId, bytes, media.mimetype, media.filename ?? null);
      this.store.completeDocument(job, uploaded);
      const caseRecord = this.store.getCaseById(job.clientId);
      if (!caseRecord) return;
      const result = handlePassportDocument(caseRecord, uploaded.driveFileId, []);
      this.store.saveCase(result.caseRecord);
      await this.client.sendMessage(message.from, "✅ Tu pasaporte quedó guardado correctamente en tu carpeta.");
      await this.sendAll(message.from, result.outgoing);
    } catch (error) {
      if (job) this.store.failDocument(job.id, error instanceof Error ? error.message : "Error desconocido");
      this.setError(error, false);
    } finally {
      this.workerBusy = false;
    }
  }

  private async sendAll(chatId: string, outgoing: OutgoingMessage[]): Promise<void> {
    for (const message of outgoing) {
      if (message.type === "text") await this.client.sendMessage(chatId, message.body);
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

  private async recoverRecentStartCommands(): Promise<void> {
    try {
      const cutoff = Math.floor(Date.now() / 1_000) - 30 * 60;
      // getChats()/message.getChat() currently throws for some WhatsApp LID
      // records. Searching only the activation phrase avoids serializing every
      // chat and lets a recent command survive an application restart.
      const messages = await this.client.searchMessages(BOT_START_COMMAND, { limit: 25 });
      for (const message of messages) {
        if (!message.fromMe || message.isStatus || message.timestamp < cutoff) continue;
        if (message.body.trim().toLocaleUpperCase("es") !== BOT_START_COMMAND) continue;
        const messageId = normalizeWhatsAppMessageId(message.id);
        if (messageId && this.store.isProcessed(messageId)) continue;
        this.store.audit(null, "RECENT_START_COMMAND_RECOVERED", {
          messageId,
        });
        await this.handleOwnerMessage(message);
      }
    } catch (error) {
      // Recovery is best-effort. Live message_create events remain active and
      // a failed historical search must not make a healthy session look down.
      this.store.audit(null, "START_COMMAND_RECOVERY_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
}
