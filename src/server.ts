import "dotenv/config";
import { backup } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify, { LogController } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { catalogFor } from "./domain/catalog.js";
import { CASE_STATUSES, type CaseStatus, type Progress } from "./domain/types.js";
import { clientPdfFilename, generateClientPdf, type ClientPdfData } from "./infrastructure/client-pdf.js";
import { SQLiteStore, type StoredDocument } from "./infrastructure/sqlite-store.js";
import { GoogleDriveService } from "./infrastructure/google-drive.js";
import { WhatsAppLocalService } from "./infrastructure/whatsapp-local.js";

const config = loadConfig();
if (!["127.0.0.1", "localhost", "::1"].includes(config.HOST)) {
  throw new Error("Por seguridad, el MVP local solo puede escuchar en localhost/127.0.0.1");
}

await mkdir(config.dataDir, { recursive: true });
const store = new SQLiteStore(config.databasePath);
const drive = new GoogleDriveService(config, store);
await drive.initialize();
const whatsapp = new WhatsAppLocalService(config, store, drive);
const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1024 * 1024 });

const STATUS_LABELS: Record<CaseStatus, string> = {
  DRAFT: "Borrador",
  INVITED: "Invitado",
  AWAITING_CONSENT: "Esperando consentimiento",
  ACTIVE: "En proceso",
  PAUSED: "Pausado",
  WAITING_FOR_CLIENT: "Esperando cliente",
  NEEDS_STAFF_REVIEW: "Revisión necesaria",
  READY_FOR_REVIEW: "Listo para revisar",
  COMPLETE: "Completo",
  DECLINED: "No aceptó",
  DELETION_REQUESTED: "Borrado solicitado",
};

function clientPdfData(id: string): ClientPdfData | null {
  const caseRecord = store.getCaseById(id);
  const details = store.getClientDetails(id);
  if (!caseRecord || !details) return null;
  const displayName = String(details.displayName || caseRecord.answers["identity.full_name"]?.value || caseRecord.phoneE164 || "Cliente");
  const emailAnswer = caseRecord.answers["contact.email"];
  const email = emailAnswer?.status === "CONFIRMED" && typeof emailAnswer.value === "string" ? emailAnswer.value : null;
  return {
    organizationName: config.ORGANIZATION_NAME,
    displayName,
    phone: caseRecord.phoneE164,
    email,
    statusLabel: STATUS_LABELS[caseRecord.status],
    progress: details.progress as Progress,
    answers: caseRecord.answers,
    fields: catalogFor(caseRecord.answers),
    documents: details.documents as StoredDocument[],
    customFields: details.customFields as Array<{ label: string; value: string }>,
  };
}

function attachmentHeader(filename: string): string {
  const fallback = filename.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._ -]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`;
}

await app.register(fastifyStatic, {
  root: path.resolve("public"),
  prefix: "/",
  decorateReply: true,
  index: ["index.html"],
  list: false,
});

app.get("/api/system/status", async () => ({
  organizationName: config.ORGANIZATION_NAME,
  whatsapp: whatsapp.status(),
  googleDrive: drive.status(),
  databasePath: config.databasePath,
}));

app.get("/auth/google", async (_request, reply) => {
  try { return reply.redirect(drive.authorizationUrl()); }
  catch (error) { return reply.code(400).type("text/plain").send(error instanceof Error ? error.message : "Error de configuración"); }
});

app.get("/auth/google/callback", async (request, reply) => {
  const query = z.object({ code: z.string().min(1) }).safeParse(request.query);
  if (!query.success) return reply.code(400).type("text/plain").send("Google no devolvió un código válido.");
  await drive.authorize(query.data.code);
  return reply.redirect("/?google=connected");
});

app.post("/api/google/disconnect", async () => {
  await drive.disconnect();
  return { ok: true };
});

app.get("/api/clients", async () => store.listClients());

app.get("/api/clients/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const details = store.getClientDetails(id);
  if (!details) return reply.code(404).send({ error: "Cliente no encontrado" });
  const caseRecord = store.getCaseById(id)!;
  const fields = catalogFor(caseRecord.answers).map(({ applies: _applies, ...field }) => field);
  return { ...details, fields };
});

app.get("/api/clients/:id/pdf", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const data = clientPdfData(id);
  if (!data) return reply.code(404).send({ error: "Cliente no encontrado" });
  const filename = clientPdfFilename(data.displayName);
  const pdf = await generateClientPdf(data);
  store.audit(id, "CLIENT_PDF_DOWNLOADED", { filename, bytes: pdf.length });
  return reply.type("application/pdf").header("Content-Disposition", attachmentHeader(filename)).send(pdf);
});

app.post("/api/clients/:id/pdf/email", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const data = clientPdfData(id);
  if (!data) return reply.code(404).send({ error: "Cliente no encontrado" });
  const recipient = z.string().trim().email().safeParse(data.email);
  if (!recipient.success) return reply.code(409).send({ code: "CLIENT_EMAIL_MISSING", error: "El cliente todavía no tiene un correo electrónico válido y confirmado." });
  const filename = clientPdfFilename(data.displayName);
  const pdf = await generateClientPdf(data);
  try {
    const messageId = await drive.sendClientPdf(recipient.data, data.displayName, filename, pdf);
    store.audit(id, "CLIENT_PDF_EMAILED", { recipient: recipient.data, filename, messageId, bytes: pdf.length });
    return { ok: true, recipient: recipient.data, filename, messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "GOOGLE_NOT_CONNECTED") return reply.code(409).send({ code: message, error: "Conecta Google antes de enviar el correo.", authorizationUrl: "/auth/google" });
    if (message === "GMAIL_REAUTH_REQUIRED") return reply.code(409).send({ code: message, error: "Google necesita autorización para enviar Gmail. Reconecta la cuenta una sola vez.", authorizationUrl: "/auth/google" });
    app.log.error(error);
    return reply.code(502).send({ code: "GMAIL_SEND_FAILED", error: "Gmail no pudo enviar el PDF. Verifica que Gmail API esté habilitada en Google Cloud e inténtalo nuevamente." });
  }
});

app.patch("/api/clients/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = z.object({
    displayName: z.string().trim().min(1).max(120).optional(),
    notes: z.string().max(10_000).optional(),
    status: z.enum(CASE_STATUSES).optional(),
  }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
  try { store.updateClient(id, body.data); return { ok: true }; }
  catch (error) {
    if ((error as Error).message === "CLIENT_NOT_FOUND") return reply.code(404).send({ error: "Cliente no encontrado" });
    throw error;
  }
});

app.put("/api/clients/:id/answers/:fieldId", async (request, reply) => {
  const { id, fieldId } = request.params as { id: string; fieldId: string };
  const body = z.object({ value: z.union([z.string(), z.number(), z.boolean()]) }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "value es obligatorio" });
  const raw = typeof body.data.value === "boolean" ? (body.data.value ? "Sí" : "No") : String(body.data.value);
  try { return { answer: store.setStaffAnswer(id, fieldId, raw) }; }
  catch (error) {
    const message = (error as Error).message;
    if (message === "CLIENT_NOT_FOUND") return reply.code(404).send({ error: "Cliente no encontrado" });
    if (message === "FIELD_NOT_APPLICABLE") return reply.code(409).send({ error: "Campo desconocido o no aplicable" });
    if (message.startsWith("INVALID_VALUE:")) return reply.code(400).send({ error: message.slice(14) });
    throw error;
  }
});

app.post("/api/clients/:id/custom-fields", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = z.object({ label: z.string().trim().min(1).max(120), value: z.string().trim().min(1).max(5_000) }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
  try { return reply.code(201).send(store.addCustomField(id, body.data.label, body.data.value)); }
  catch (error) {
    if ((error as Error).message === "CLIENT_NOT_FOUND") return reply.code(404).send({ error: "Cliente no encontrado" });
    throw error;
  }
});

app.delete("/api/clients/:id/custom-fields/:customFieldId", async (request) => {
  const { id, customFieldId } = request.params as { id: string; customFieldId: string };
  store.deleteCustomField(id, customFieldId);
  return { ok: true };
});

app.post("/api/system/backup", async () => {
  const directory = path.join(config.dataDir, "backups");
  await mkdir(directory, { recursive: true });
  const filename = `bot-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
  const target = path.join(directory, filename);
  await backup(store.db, target);
  return { ok: true, filename, path: target };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "Ocurrió un error local. Revisa la consola para más detalle." });
});

app.addHook("onClose", async () => {
  await whatsapp.stop();
  store.close();
});

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`Panel disponible en http://${config.HOST}:${config.PORT}`);
if (config.WHATSAPP_AUTOSTART) void whatsapp.start();
