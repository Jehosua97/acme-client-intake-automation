import { existsSync } from "node:fs";
import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";
import type { Message } from "whatsapp-web.js";
import type { Config } from "../config.js";
import { acknowledgeInvitation, handleClientText, handlePassportDocument } from "../domain/engine.js";
import type { OutgoingMessage } from "../domain/types.js";
import type { GoogleDriveService } from "./google-drive.js";
import type { PendingDocument, SQLiteStore } from "./sqlite-store.js";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const { Client, LocalAuth } = WhatsAppWeb;

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

export interface WhatsAppRuntimeStatus {
  state: "STARTING" | "QR" | "AUTHENTICATED" | "READY" | "DISCONNECTED" | "ERROR";
  qrDataUrl: string | null;
  account: string | null;
  lastError: string | null;
}

export class WhatsAppLocalService {
  readonly client: InstanceType<typeof Client>;
  private runtime: WhatsAppRuntimeStatus = { state: "STARTING", qrDataUrl: null, account: null, lastError: null };
  private workerTimer: NodeJS.Timeout | null = null;
  private workerBusy = false;

  constructor(private readonly config: Config, private readonly store: SQLiteStore, private readonly drive: GoogleDriveService) {
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
    this.client.on("authenticated", () => { this.runtime = { ...this.runtime, state: "AUTHENTICATED", qrDataUrl: null, lastError: null }; });
    this.client.on("ready", () => {
      this.runtime = { state: "READY", qrDataUrl: null, account: this.client.info?.wid?._serialized ?? null, lastError: null };
    });
    this.client.on("auth_failure", (message) => { this.runtime = { ...this.runtime, state: "ERROR", lastError: message }; });
    this.client.on("disconnected", (reason) => { this.runtime = { ...this.runtime, state: "DISCONNECTED", lastError: String(reason) }; });
    this.client.on("message_create", (message) => {
      if (message.fromMe) void this.handleOwnerMessage(message).catch((error) => this.setError(error, false));
    });
    this.client.on("message", (message) => {
      if (!message.fromMe) void this.handleClientMessage(message).catch((error) => this.setError(error, false));
    });
  }

  private async handleOwnerMessage(message: Message): Promise<void> {
    try {
      if (message.body.trim().toLocaleUpperCase("es") !== "INICIAR BOT" || message.isStatus) return;
      const chat = await message.getChat();
      if (chat.isGroup) return;
      const chatId = message.to;
      const existing = this.store.getCaseByChatId(chatId);
      if (existing && !["DRAFT", "DECLINED", "COMPLETE"].includes(existing.status)) {
        this.store.audit(existing.id, "DUPLICATE_START_IGNORED", { status: existing.status });
        return;
      }
      const contact = await this.client.getContactById(chatId);
      const phone = `+${chatId.split("@")[0]?.replace(/\D/g, "") ?? ""}`;
      const caseRecord = existing ?? this.store.createCase(chatId, phone, contact.pushname || contact.name || phone);
      caseRecord.status = "INVITED";
      caseRecord.invitedAt = new Date().toISOString();
      const result = acknowledgeInvitation(caseRecord);
      this.store.saveCase(result.caseRecord);
      this.store.audit(caseRecord.id, "BOT_STARTED_FROM_CHAT", { chatId });
      await this.sendAll(chatId, result.outgoing);
    } catch (error) { this.setError(error, false); }
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
      const chat = await message.getChat();
      if (chat.isGroup) { this.store.markProcessed(messageId); return; }
      const caseRecord = this.store.getCaseByChatId(message.from);
      if (!caseRecord) { this.store.markProcessed(messageId); return; }

      if (message.hasMedia && ["image", "document"].includes(message.type)) {
        if (caseRecord.status !== "ACTIVE") {
          const result = handleClientText(caseRecord, message.body || "");
          this.store.saveCase(result.caseRecord);
          this.store.markProcessed(messageId);
          await this.sendAll(message.from, result.outgoing);
          return;
        }
        this.store.queueDocument(caseRecord.id, messageId);
        this.store.markProcessed(messageId);
        await this.client.sendMessage(message.from, "Recibí tu archivo. Lo estoy guardando en tu carpeta; te aviso en cuanto termine.");
        void this.processPendingDocument();
        return;
      }

      if (message.hasMedia) {
        this.store.markProcessed(messageId);
        await this.client.sendMessage(message.from, "Por ahora solo puedo guardar fotos y archivos PDF. Envíame el pasaporte en uno de esos formatos.");
        return;
      }

      const result = handleClientText(caseRecord, message.body);
      this.store.saveCase(result.caseRecord);
      for (const event of result.auditEvents) this.store.audit(caseRecord.id, event.event, event.detail);
      this.store.markProcessed(messageId);
      await this.sendAll(message.from, result.outgoing);
    } catch (error) { this.setError(error, false); }
  }

  private async processPendingDocument(): Promise<void> {
    if (this.workerBusy || this.runtime.state !== "READY") return;
    this.workerBusy = true;
    let job: PendingDocument | null = null;
    try {
      job = this.store.claimDocument();
      if (!job) return;
      const message = await this.client.getMessageById(job.whatsappMessageId);
      if (!message) throw new Error("WhatsApp ya no tiene disponible el mensaje del archivo");
      const media = await message.downloadMedia();
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
