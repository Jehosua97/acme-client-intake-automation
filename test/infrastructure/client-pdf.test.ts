import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogFor } from "../../src/domain/catalog.js";
import { calculateProgress, newCase, startIntake } from "../../src/domain/engine.js";
import type { Answer } from "../../src/domain/types.js";
import { clientPdfFilename, employmentRowsForPdf, generateClientPdf, reportSectionsForPdf } from "../../src/infrastructure/client-pdf.js";

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
    caseRecord.answers["employment.1.from"] = answer("employment.1.from", "2023-02");
    caseRecord.answers["employment.1.until"] = answer("employment.1.until", "CURRENT");
    caseRecord.answers["employment.1.activity"] = answer("employment.1.activity", "Trabajo remoto");
    caseRecord.answers["employment.1.organization"] = answer("employment.1.organization", "Empresa actual");
    caseRecord.answers["employment.1.city"] = answer("employment.1.city", "Veracruz");
    caseRecord.answers["employment.1.province"] = answer("employment.1.province", "Veracruz");
    caseRecord.answers["employment.2.from"] = answer("employment.2.from", "2016-08");
    caseRecord.answers["employment.2.until"] = answer("employment.2.until", "2023-01");
    caseRecord.answers["employment.2.activity"] = answer("employment.2.activity", "Estudiante");
    caseRecord.answers["employment.2.organization"] = answer("employment.2.organization", "Universidad");
    caseRecord.answers["employment.2.city"] = answer("employment.2.city", "Boca del Río");
    caseRecord.answers["employment.2.province"] = answer("employment.2.province", "Veracruz");
    const fields = catalogFor(caseRecord.answers);
    const data = {
      organizationName: "MultiServicios",
      displayName: "Ana María Pérez López",
      phone: caseRecord.phoneE164,
      email: "ana@example.com",
      statusLabel: "En proceso",
      progress: calculateProgress(caseRecord),
      answers: caseRecord.answers,
      fields,
      documents: [{
        id: "document-1",
        clientId: caseRecord.id,
        driveFileId: "drive-1",
        name: "Pasaporte.pdf",
        mimeType: "application/pdf",
        size: 1024,
        webViewLink: "https://drive.google.com/file/d/drive-1/view",
        createdAt: new Date().toISOString(),
      }],
      customFields: [{ label: "Referencia", value: "Cliente recurrente" }],
      generatedAt: new Date("2026-08-06T12:00:00-04:00"),
    };
    const pdf = await generateClientPdf(data);

    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 2_000);
    assert.match(pdf.toString("latin1"), /\/Subtype\s*\/Link/);
    assert.match(pdf.toString("latin1"), /drive\.google\.com/);
    const employment = employmentRowsForPdf({ answers: data.answers, fields });
    assert.deepEqual(employment.map((row) => [row.from.value, row.until.value, row.activity.value]), [
      ["08/2016", "01/2023", "Estudiante"],
      ["02/2023", "ACTUAL", "Trabajo remoto"],
    ]);
    assert.equal(clientPdfFilename("Ana María Pérez/López"), "Ana María Pérez López_expediente.pdf");
  });

  it("does not create empty pages while adding the footer", async () => {
    const caseRecord = newCase("client-2", "+525500000000");
    startIntake(caseRecord);
    caseRecord.answers["identity.full_name"] = answer("identity.full_name", "Cliente Prueba");
    const identityField = catalogFor(caseRecord.answers).find((field) => field.id === "identity.full_name");
    assert.ok(identityField);
    const pdf = await generateClientPdf({
      organizationName: "MultiServicios",
      displayName: "Cliente Prueba",
      phone: caseRecord.phoneE164,
      email: null,
      statusLabel: "En proceso",
      progress: calculateProgress(caseRecord),
      answers: caseRecord.answers,
      fields: [identityField],
      documents: [],
      customFields: [],
      generatedAt: new Date("2026-08-06T12:00:00-04:00"),
    });
    const pageCount = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
    assert.equal(pageCount, 1);
  });

  it("organizes family information into person-specific blocks", () => {
    const caseRecord = newCase("client-family", "+525500000001");
    startIntake(caseRecord);
    Object.assign(caseRecord.answers, {
      "family.marital_status": answer("family.marital_status", "Unión libre"),
      "family.has_partner": answer("family.has_partner", true),
      "partner.full_name": answer("partner.full_name", "Pareja Actual"),
      "family.had_previous_partner": answer("family.had_previous_partner", true),
      "previous_partner.full_name": answer("previous_partner.full_name", "Pareja Anterior"),
      "mother.full_name": answer("mother.full_name", "Nombre Madre"),
      "father.full_name": answer("father.full_name", "Nombre Padre"),
      "children.count": answer("children.count", 2),
      "children.1.full_name": answer("children.1.full_name", "Primer Hijo"),
      "children.2.full_name": answer("children.2.full_name", "Segundo Hijo"),
    });
    const fields = catalogFor(caseRecord.answers);
    const sections = reportSectionsForPdf({
      organizationName: "MultiServicios",
      displayName: "Cliente Familia",
      phone: caseRecord.phoneE164,
      email: null,
      statusLabel: "En proceso",
      progress: calculateProgress(caseRecord),
      answers: caseRecord.answers,
      fields,
      documents: [],
      customFields: [],
    });
    const familyTitles = sections.filter((section) => section.title.startsWith("Familia ·")).map((section) => section.title);
    assert.deepEqual(familyTitles, [
      "Familia · Resumen familiar",
      "Familia · Pareja actual",
      "Familia · Pareja anterior",
      "Familia · Madre",
      "Familia · Padre",
      "Familia · Hijo/a 1",
      "Familia · Hijo/a 2",
    ]);
    const partner = sections.find((section) => section.title === "Familia · Pareja actual");
    assert.equal(partner?.items.some((item) => /madre|padre|hijo/i.test(item.label)), false);
  });
});
