import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogFor } from "../../src/domain/catalog.js";
import { calculateProgress, newCase, startIntake } from "../../src/domain/engine.js";
import type { Answer } from "../../src/domain/types.js";
import { clientPdfFilename, generateClientPdf } from "../../src/infrastructure/client-pdf.js";

function answer(fieldId: string, value: Answer["value"]): Answer {
  return { fieldId, value, status: "CONFIRMED", source: "CHAT", confidence: 100, updatedAt: new Date().toISOString() };
}

describe("client PDF", () => {
  it("creates a compact PDF in memory with a safe client filename", async () => {
    const caseRecord = newCase("client-1", "+525512345678");
    startIntake(caseRecord);
    caseRecord.answers["identity.full_name"] = answer("identity.full_name", "Ana María Pérez/López");
    caseRecord.answers["contact.email"] = answer("contact.email", "ana@example.com");
    caseRecord.answers["contact.phone"] = answer("contact.phone", "+525512345678");
    const pdf = await generateClientPdf({
      organizationName: "ACME",
      displayName: "Ana María Pérez López",
      phone: caseRecord.phoneE164,
      email: "ana@example.com",
      statusLabel: "En proceso",
      progress: calculateProgress(caseRecord),
      answers: caseRecord.answers,
      fields: catalogFor(caseRecord.answers),
      documents: [],
      customFields: [{ label: "Referencia", value: "Cliente recurrente" }],
      generatedAt: new Date("2026-08-06T12:00:00-04:00"),
    });

    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 2_000);
    assert.equal(clientPdfFilename("Ana María Pérez/López"), "Ana María Pérez López_expediente.pdf");
  });
});
