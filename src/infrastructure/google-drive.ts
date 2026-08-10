import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { google } from "googleapis";
import type { Config } from "../config.js";
import { EncryptedTokenStore } from "./encrypted-token-store.js";

interface DriveStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  getDriveFolder(clientId: string): { id: string; link: string } | null;
  setDriveFolder(clientId: string, folderId: string, link: string): void;
  getClientDetails(clientId: string): Record<string, unknown> | null;
  audit(clientId: string | null, event: string, detail?: Record<string, unknown>): void;
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GOOGLE_SCOPES = [DRIVE_SCOPE, GMAIL_SEND_SCOPE] as const;
type OAuthClient = InstanceType<typeof google.auth.OAuth2>;
type OAuthCredentials = Parameters<OAuthClient["setCredentials"]>[0];

export function clientDriveFolderName(phoneValue: unknown, displayNameValue: unknown): string {
  const phone = String(phoneValue ?? "").replace(/[^+\d]/g, "").slice(0, 30) || "Sin teléfono";
  const rawName = String(displayNameValue ?? "").trim();
  const nameIsOnlyPhone = rawName.replace(/[^+\d]/g, "") === phone;
  const safeName = (rawName && !nameIsOnlyPhone ? rawName : "Nombre pendiente")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Nombre pendiente";
  return `${phone} - ${safeName}`;
}

export class GoogleDriveService {
  private readonly oauth: OAuthClient;
  private readonly tokenStore: EncryptedTokenStore;
  private credentials: OAuthCredentials = {};
  private connected = false;
  private rootFolderLink: string | null = null;
  private authorizedScopes = new Set<string>();

  constructor(private readonly config: Config, private readonly store: DriveStore) {
    this.oauth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI);
    this.tokenStore = new EncryptedTokenStore(config.googleTokenPath, config.APP_ENCRYPTION_KEY);
    this.oauth.on("tokens", (tokens) => {
      const previousRefreshToken = this.credentials.refresh_token;
      this.credentials = { ...this.credentials, ...tokens };
      if (!this.credentials.refresh_token && previousRefreshToken) this.credentials.refresh_token = previousRefreshToken;
      // During the initial authorization authorize() persists the complete
      // token explicitly. This listener is only needed for later refreshes.
      if (this.connected) void this.tokenStore.save(this.credentials).catch(() => { this.connected = false; });
    });
  }

  async initialize(): Promise<void> {
    const token = await this.tokenStore.load<OAuthCredentials>();
    if (!token) return;
    this.credentials = token;
    this.oauth.setCredentials(token);
    try {
      await this.ensureRootFolder();
      this.connected = true;
      try { await this.refreshAuthorizedScopes(); } catch { this.authorizedScopes.clear(); }
    } catch {
      this.connected = false;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  status(): { configured: boolean; connected: boolean; rootFolderLink: string | null; gmailSendAuthorized: boolean } {
    return {
      configured: this.isConfigured(),
      connected: this.connected,
      rootFolderLink: this.rootFolderLink,
      gmailSendAuthorized: this.authorizedScopes.has(GMAIL_SEND_SCOPE),
    };
  }

  authorizationUrl(): string {
    if (!this.isConfigured()) throw new Error("Google OAuth no está configurado en .env");
    return this.oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: [...GOOGLE_SCOPES] });
  }

  async authorize(code: string): Promise<void> {
    const { tokens } = await this.oauth.getToken(code);
    const credentials = { ...tokens };
    if (!credentials.refresh_token && this.credentials.refresh_token) credentials.refresh_token = this.credentials.refresh_token;
    this.credentials = credentials;
    this.oauth.setCredentials(credentials);
    await this.tokenStore.save(credentials);
    await this.ensureRootFolder();
    this.connected = true;
    await this.refreshAuthorizedScopes();
  }

  async disconnect(): Promise<void> {
    try { await this.oauth.revokeCredentials(); } catch { /* local removal still proceeds */ }
    await this.tokenStore.remove();
    this.credentials = {};
    this.oauth.setCredentials({});
    this.connected = false;
    this.authorizedScopes.clear();
  }

  async sendClientPdf(recipient: string, clientName: string, filename: string, pdf: Buffer): Promise<string> {
    if (!this.connected) throw new Error("GOOGLE_NOT_CONNECTED");
    if (!this.authorizedScopes.has(GMAIL_SEND_SCOPE)) await this.refreshAuthorizedScopes();
    if (!this.authorizedScopes.has(GMAIL_SEND_SCOPE)) throw new Error("GMAIL_REAUTH_REQUIRED");

    const safeClientName = clientName.replace(/[\r\n]+/g, " ").trim() || "cliente";
    const subject = `Validación de expediente de visa - ${safeClientName}`;
    const body = `Hola ${safeClientName},\n\nAdjuntamos un resumen de la información que nos compartiste para tu proceso de visa.\n\nPor favor revisa cuidadosamente el documento y confirma que tu correo electrónico y tus datos sean correctos. Si encuentras algún error o dato pendiente, comunícate con nuestro equipo para corregirlo.\n\nAtentamente,\n${this.config.ORGANIZATION_NAME}`;
    const raw = this.mimeMessage(recipient, subject, body, filename, pdf);
    const gmail = google.gmail({ version: "v1", auth: this.oauth });
    const response = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    if (!response.data.id) throw new Error("GMAIL_SEND_FAILED");
    return response.data.id;
  }

  async uploadClientDocument(
    clientId: string,
    bytes: Buffer,
    mimeType: string,
    originalName: string | null,
  ): Promise<{ id: string; driveFileId: string; name: string; mimeType: string; size: number; webViewLink: string }> {
    if (!this.connected) throw new Error("Google Drive no está conectado");
    const folder = await this.ensureClientFolder(clientId);
    const extension = this.extensionFor(mimeType, originalName);
    const safeOriginal = originalName?.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 80);
    const name = safeOriginal || `Pasaporte_${new Date().toISOString().replace(/[:.]/g, "-")}${extension}`;
    const drive = google.drive({ version: "v3", auth: this.oauth });
    const response = await drive.files.create({
      requestBody: { name, parents: [folder.id] },
      media: { mimeType, body: Readable.from(bytes) },
      fields: "id,name,mimeType,size,webViewLink",
    });
    if (!response.data.id) throw new Error("Google Drive no devolvió ID del archivo");
    return {
      id: randomUUID(),
      driveFileId: response.data.id,
      name: response.data.name ?? name,
      mimeType: response.data.mimeType ?? mimeType,
      size: Number(response.data.size ?? bytes.length),
      webViewLink: response.data.webViewLink ?? `https://drive.google.com/file/d/${response.data.id}/view`,
    };
  }

  async syncClientFolderName(clientId: string): Promise<void> {
    if (!this.connected) return;
    const folder = this.store.getDriveFolder(clientId);
    if (!folder) return;
    const details = this.store.getClientDetails(clientId);
    if (!details) return;
    const name = clientDriveFolderName(details.phoneE164, details.displayName);
    const drive = google.drive({ version: "v3", auth: this.oauth });
    await drive.files.update({ fileId: folder.id, requestBody: { name }, fields: "id,name" });
    this.store.audit(clientId, "DRIVE_FOLDER_NAME_SYNCED", { name });
  }

  async deleteClientFolder(clientId: string): Promise<void> {
    const folder = this.store.getDriveFolder(clientId);
    if (!folder) return;
    if (!this.connected) throw new Error("GOOGLE_NOT_CONNECTED");
    const drive = google.drive({ version: "v3", auth: this.oauth });
    try {
      await drive.files.delete({ fileId: folder.id });
      this.store.audit(clientId, "DRIVE_CLIENT_FOLDER_DELETED", { folderId: folder.id });
    } catch (error) {
      const status = (error as { code?: number; response?: { status?: number } }).code ?? (error as { response?: { status?: number } }).response?.status;
      if (status !== 404) throw error;
    }
  }

  private async ensureRootFolder(): Promise<{ id: string; link: string }> {
    const drive = google.drive({ version: "v3", auth: this.oauth });
    const storedId = this.store.getSetting("google_root_folder_id");
    if (storedId) {
      try {
        const existing = await drive.files.get({ fileId: storedId, fields: "id,name,webViewLink,trashed" });
        if (!(existing.data as { trashed?: boolean }).trashed) {
          if (existing.data.name !== this.config.GOOGLE_DRIVE_ROOT_FOLDER_NAME) {
            await drive.files.update({ fileId: storedId, requestBody: { name: this.config.GOOGLE_DRIVE_ROOT_FOLDER_NAME }, fields: "id,name" });
          }
          const link = existing.data.webViewLink ?? `https://drive.google.com/drive/folders/${storedId}`;
          this.rootFolderLink = link;
          return { id: storedId, link };
        }
      } catch { /* create a replacement below */ }
    }
    const created = await drive.files.create({
      requestBody: { name: this.config.GOOGLE_DRIVE_ROOT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
      fields: "id,webViewLink",
    });
    if (!created.data.id) throw new Error("No fue posible crear la carpeta raíz de Google Drive");
    const link = created.data.webViewLink ?? `https://drive.google.com/drive/folders/${created.data.id}`;
    this.store.setSetting("google_root_folder_id", created.data.id);
    this.rootFolderLink = link;
    return { id: created.data.id, link };
  }

  private async ensureClientFolder(clientId: string): Promise<{ id: string; link: string }> {
    const saved = this.store.getDriveFolder(clientId);
    if (saved) return saved;
    const details = this.store.getClientDetails(clientId);
    if (!details) throw new Error("Cliente inexistente");
    const root = await this.ensureRootFolder();
    const name = clientDriveFolderName(details.phoneE164, details.displayName);
    const drive = google.drive({ version: "v3", auth: this.oauth });
    const created = await drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [root.id] },
      fields: "id,webViewLink",
    });
    if (!created.data.id) throw new Error("No fue posible crear la carpeta del cliente");
    const link = created.data.webViewLink ?? `https://drive.google.com/drive/folders/${created.data.id}`;
    this.store.setDriveFolder(clientId, created.data.id, link);
    return { id: created.data.id, link };
  }

  private extensionFor(mimeType: string, originalName: string | null): string {
    if (originalName?.includes(".")) return "";
    return mimeType === "application/pdf" ? ".pdf"
      : mimeType === "image/png" ? ".png"
      : mimeType === "image/webp" ? ".webp"
      : ".jpg";
  }

  private async refreshAuthorizedScopes(): Promise<void> {
    const accessToken = await this.oauth.getAccessToken();
    if (!accessToken.token) {
      this.authorizedScopes.clear();
      return;
    }
    const tokenInfo = await this.oauth.getTokenInfo(accessToken.token);
    this.authorizedScopes = new Set(tokenInfo.scopes);
  }

  private mimeMessage(recipient: string, subject: string, body: string, filename: string, pdf: Buffer): string {
    const boundary = `acme_${randomUUID().replace(/-/g, "")}`;
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
    const encodedBody = Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    const encodedAttachment = pdf.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    const asciiFilename = filename.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._ -]/g, "_");
    const encodedFilename = encodeURIComponent(filename).replace(/'/g, "%27");
    const message = [
      `To: ${recipient}`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodedBody,
      `--${boundary}`,
      `Content-Type: application/pdf; name=\"${asciiFilename}\"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename=\"${asciiFilename}\"; filename*=UTF-8''${encodedFilename}`,
      "",
      encodedAttachment,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return Buffer.from(message, "utf8").toString("base64url");
  }
}
