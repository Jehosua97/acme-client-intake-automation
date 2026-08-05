import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { google } from "googleapis";
import type { Config } from "../config.js";
import type { SQLiteStore } from "./sqlite-store.js";
import { EncryptedTokenStore } from "./encrypted-token-store.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
type OAuthClient = InstanceType<typeof google.auth.OAuth2>;
type OAuthCredentials = Parameters<OAuthClient["setCredentials"]>[0];

export class GoogleDriveService {
  private readonly oauth: OAuthClient;
  private readonly tokenStore: EncryptedTokenStore;
  private credentials: OAuthCredentials = {};
  private connected = false;
  private rootFolderLink: string | null = null;

  constructor(private readonly config: Config, private readonly store: SQLiteStore) {
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
    } catch {
      this.connected = false;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  status(): { configured: boolean; connected: boolean; rootFolderLink: string | null } {
    return { configured: this.isConfigured(), connected: this.connected, rootFolderLink: this.rootFolderLink };
  }

  authorizationUrl(): string {
    if (!this.isConfigured()) throw new Error("Google OAuth no está configurado en .env");
    return this.oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [DRIVE_SCOPE] });
  }

  async authorize(code: string): Promise<void> {
    const { tokens } = await this.oauth.getToken(code);
    this.credentials = tokens;
    this.oauth.setCredentials(tokens);
    await this.tokenStore.save(tokens);
    await this.ensureRootFolder();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    try { await this.oauth.revokeCredentials(); } catch { /* local removal still proceeds */ }
    await this.tokenStore.remove();
    this.credentials = {};
    this.oauth.setCredentials({});
    this.connected = false;
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

  private async ensureRootFolder(): Promise<{ id: string; link: string }> {
    const drive = google.drive({ version: "v3", auth: this.oauth });
    const storedId = this.store.getSetting("google_root_folder_id");
    if (storedId) {
      try {
        const existing = await drive.files.get({ fileId: storedId, fields: "id,webViewLink,trashed" });
        if (!(existing.data as { trashed?: boolean }).trashed) {
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
    const displayName = String(details.displayName || details.phoneE164 || "Cliente").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    const phone = String(details.phoneE164 ?? "").replace(/[^+\d]/g, "");
    const drive = google.drive({ version: "v3", auth: this.oauth });
    const created = await drive.files.create({
      requestBody: { name: `${displayName} - ${phone}`, mimeType: "application/vnd.google-apps.folder", parents: [root.id] },
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
}
