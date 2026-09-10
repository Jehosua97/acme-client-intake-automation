import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startIntake } from "../../src/domain/engine.js";
import { SQLiteStore } from "../../src/infrastructure/sqlite-store.js";

describe("SQLiteStore", () => {
  it("persists clients, answers, custom fields and Drive documents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "msc-sqlite-"));
    const store = new SQLiteStore(path.join(directory, "bot.sqlite"));
    try {
      const caseRecord = store.createCase("5215550000000@c.us", "+5215550000000", "Ana Pérez");
      store.addChatAlias(caseRecord.id, "987654321@lid");
      assert.equal(store.getCaseByChatId("987654321@lid")?.id, caseRecord.id);
      caseRecord.status = "INVITED";
      const started = startIntake(caseRecord);
      store.saveCase(started.caseRecord);
      store.setStaffAnswer(caseRecord.id, "identity.full_name", "Ana Pérez");
      assert.equal(store.listClients()[0]?.displayName, "Ana Pérez");
      const applicantAddress = "Calle Principal 10, Colonia Centro, Municipio de Veracruz, Veracruz, C.P. 91700";
      store.setStaffAnswer(caseRecord.id, "contact.residential_address", applicantAddress);
      store.setStaffAnswer(caseRecord.id, "contact.mailing_address", "MISMA");
      store.addCustomField(caseRecord.id, "Referencia", "Cliente recurrente");

      const queued = store.queueDocument(caseRecord.id, "wa-message-1");
      const claimed = store.claimDocument();
      assert.equal(claimed?.id, queued.id);
      store.completeDocument(claimed!, {
        id: "document-1",
        driveFileId: "drive-1",
        name: "pasaporte.pdf",
        mimeType: "application/pdf",
        size: 1_024,
        webViewLink: "https://drive.google.com/file/d/drive-1/view",
      });

      const reopened = store.getCaseByChatId("5215550000000@c.us");
      assert.equal(reopened?.answers["identity.full_name"]?.value, "Ana Pérez");
      assert.equal(reopened?.answers["contact.mailing_address"]?.value, applicantAddress);
      const details = store.getClientDetails(caseRecord.id);
      assert.equal((details?.documents as unknown[]).length, 1);
      assert.equal((details?.customFields as unknown[]).length, 1);
      const auditEvents = details?.auditEvents as Array<{ event: string; detail: Record<string, unknown> }>;
      assert.ok(auditEvents.some((event) => event.event === "DOCUMENT_UPLOADED"));
      assert.ok(auditEvents.some((event) => event.event === "CUSTOM_FIELD_ADDED"));
      assert.equal(auditEvents[0]?.event, "DOCUMENT_UPLOADED");
      assert.equal(store.listClients()[0]?.documentCount, 1);
      assert.equal(store.listClients()[0]?.pendingDocumentCount, 0);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tracks post-PDF requirements without changing or contacting an active case", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "msc-post-intake-"));
    const store = new SQLiteStore(path.join(directory, "bot.sqlite"));
    try {
      const caseRecord = store.createCase("5215551111111@c.us", "+5215551111111", "Cliente prueba");
      caseRecord.status = "ACTIVE";
      store.saveCase(caseRecord);

      const followUp = store.startPostIntake(caseRecord.id);
      assert.equal(followUp.started, true);
      assert.equal(followUp.items.length, 4);
      assert.equal(followUp.items.find((item) => item.kind === "PROPERTY_EVIDENCE")?.status, "NOT_REQUIRED");
      assert.equal(store.getCaseById(caseRecord.id)?.status, "ACTIVE");

      const clarification = store.addPostIntakeItem(caseRecord.id, "Confirmar fecha de relación", "Solicitar día, mes y año");
      assert.equal(store.getPostIntake(caseRecord.id)?.stage, "CLARIFICATIONS");
      store.updatePostIntakeItem(caseRecord.id, clarification.id, { status: "APPROVED", notes: "Confirmado por el cliente" });

      const requirements = store.getPostIntake(caseRecord.id)!.items.filter((item) => item.required && item.id !== clarification.id);
      for (const item of requirements) store.updatePostIntakeItem(caseRecord.id, item.id, { status: "APPROVED" });
      const completed = store.completePostIntake(caseRecord.id);
      assert.equal(completed.stage, "COMPLETE");
      assert.equal(completed.progress.completed, completed.progress.total);
      assert.equal(store.getCaseById(caseRecord.id)?.status, "ACTIVE");

      const events = store.listAuditEvents(caseRecord.id);
      assert.ok(events.some((event) => event.event === "POST_INTAKE_STARTED"));
      assert.ok(events.some((event) => event.event === "POST_INTAKE_COMPLETED"));
      assert.equal(events.some((event) => event.event === "BOT_MESSAGE_SENT"), false);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
