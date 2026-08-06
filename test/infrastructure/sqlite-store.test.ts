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
      assert.equal(store.listClients()[0]?.documentCount, 1);
      assert.equal(store.listClients()[0]?.pendingDocumentCount, 0);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
