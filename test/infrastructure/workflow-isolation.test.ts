import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { calculateUsaProgress, newUsaCase } from "../../src/domain/usa-engine.js";
import { usaCatalogFor, usaFieldById } from "../../src/domain/usa-catalog.js";
import { usaCrossFieldIssues, usaImmediateConsistencyIssue } from "../../src/domain/usa-consistency.js";
import { SQLiteStore, type StoreWorkflow } from "../../src/infrastructure/sqlite-store.js";

describe("Canada and USA storage isolation", () => {
  it("stores the same WhatsApp contact in two different physical databases", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "msc-workflows-"));
    const usaWorkflow: StoreWorkflow = {
      kind: "USA",
      newCase: newUsaCase,
      catalogFor: usaCatalogFor,
      fieldById: usaFieldById,
      calculateProgress: calculateUsaProgress,
      immediateConsistencyIssue: usaImmediateConsistencyIssue,
      crossFieldIssues: usaCrossFieldIssues,
    };
    const canada = new SQLiteStore(path.join(directory, "canada.sqlite"));
    const usa = new SQLiteStore(path.join(directory, "usa.sqlite"), usaWorkflow);
    try {
      const usaCase = usa.createCase("14165550123@c.us", "+14165550123", "Cliente USA");
      const canadaCase = canada.createCase("14165550123@c.us", "+14165550123", "Cliente Canadá");
      assert.equal(usa.getCaseById(usaCase.id)?.phoneE164, "+14165550123");
      assert.equal(canada.listClients().length, 1);
      assert.equal(usa.listClients().length, 1);
      usa.deleteClient(usaCase.id);
      assert.equal(usa.listClients().length, 0);
      assert.equal(canada.getCaseById(canadaCase.id)?.phoneE164, "+14165550123");
    } finally {
      canada.close(); usa.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies USA chronology validation to answers edited by staff", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "msc-usa-validation-"));
    const usaWorkflow: StoreWorkflow = {
      kind: "USA",
      newCase: newUsaCase,
      catalogFor: usaCatalogFor,
      fieldById: usaFieldById,
      calculateProgress: calculateUsaProgress,
      immediateConsistencyIssue: usaImmediateConsistencyIssue,
      crossFieldIssues: usaCrossFieldIssues,
    };
    const usa = new SQLiteStore(path.join(directory, "usa.sqlite"), usaWorkflow);
    try {
      const caseRecord = usa.createCase("14165550124@c.us", "+14165550124", "Cliente USA");
      usa.setStaffAnswer(caseRecord.id, "identity.birth_date", "15/06/1990");
      assert.throws(
        () => usa.setStaffAnswer(caseRecord.id, "passport.issue_date", "01/01/1980"),
        /posterior a tu fecha de nacimiento/,
      );
      const answer = usa.setStaffAnswer(caseRecord.id, "passport.issue_date", "01/02/2020");
      assert.equal(answer.value, "2020-02-01");
    } finally {
      usa.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
