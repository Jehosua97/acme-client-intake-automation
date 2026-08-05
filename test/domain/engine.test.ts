import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acknowledgeInvitation, calculateProgress, handleClientText, handlePassportDocument, invite, newCase } from "../../src/domain/engine.js";
import type { Answer, CaseRecord } from "../../src/domain/types.js";
import { catalogFor, fieldById } from "../../src/domain/catalog.js";

function consentedCase(): CaseRecord {
  const caseRecord = newCase("case-1", "+5215550000000");
  invite(caseRecord, "inicio", "es_MX");
  acknowledgeInvitation(caseRecord);
  handleClientText(caseRecord, "ACEPTO");
  return caseRecord;
}

function confirmed(fieldId: string, value: Answer["value"]): Answer {
  return { fieldId, value, status: "CONFIRMED", source: "CHAT", confidence: 100, updatedAt: new Date().toISOString() };
}

describe("conversation engine", () => {
  it("requires invitation and explicit consent before the first question", () => {
    const caseRecord = newCase("case-1", "+5215550000000");
    const invitation = invite(caseRecord, "inicio", "es_MX");
    assert.equal(invitation.caseRecord.status, "INVITED");
    assert.equal(invitation.outgoing[0]?.type, "template");

    const consent = handleClientText(caseRecord, "hola");
    assert.equal(consent.caseRecord.status, "AWAITING_CONSENT");
    assert.match(consent.outgoing[0]?.type === "text" ? consent.outgoing[0].body : "", /ACEPTO/);

    const accepted = handleClientText(caseRecord, "ACEPTO");
    assert.equal(accepted.caseRecord.status, "ACTIVE");
    assert.equal(accepted.caseRecord.answers["contact.phone"]?.value, "+5215550000000");
    assert.equal(accepted.caseRecord.currentFieldId, "workflow.passport_uploaded");
  });

  it("does not immediately repeat a skipped question", () => {
    const caseRecord = consentedCase();
    handleClientText(caseRecord, "SALTAR"); // pasaporte pendiente
    handleClientText(caseRecord, "SALTAR"); // UCI opcional
    handleClientText(caseRecord, "Visa de visitante");
    assert.equal(caseRecord.currentFieldId, "identity.last_names");
    const result = handleClientText(caseRecord, "SALTAR");
    assert.equal(caseRecord.answers["identity.last_names"]?.status, "PENDING");
    assert.equal(caseRecord.currentFieldId, "identity.first_names");
    assert.doesNotMatch(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /apellidos completos/);
  });

  it("uses one compact confirmation for passport proposals", () => {
    const caseRecord = consentedCase();
    const result = handlePassportDocument(caseRecord, "media-1", [
      { fieldId: "identity.last_names", value: "Pérez López", confidence: 99 },
      { fieldId: "identity.first_names", value: "Ana María", confidence: 98 },
    ]);
    assert.equal(caseRecord.currentFieldId, "__proposal_batch__");
    const body = result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "";
    assert.match(body, /Pérez López/);
    assert.match(body, /Ana María/);

    handleClientText(caseRecord, "Sí");
    assert.equal(caseRecord.answers["identity.last_names"]?.status, "CONFIRMED");
    assert.notEqual(caseRecord.currentFieldId, "identity.last_names");
  });

  it("leaves passport values for staff review without asking the client again", () => {
    const caseRecord = consentedCase();
    const result = handlePassportDocument(caseRecord, "drive-file-1", []);
    assert.equal(caseRecord.answers["identity.last_names"]?.status, "PENDING");
    assert.equal(caseRecord.answers["identity.last_names"]?.source, "DOCUMENT");
    assert.notEqual(caseRecord.currentFieldId, "identity.last_names");
    assert.ok(result.outgoing.length > 0);
  });

  it("never reopens passport fields through CONTINUAR", () => {
    const caseRecord = consentedCase();
    handlePassportDocument(caseRecord, "drive-file-1", []);
    caseRecord.status = "WAITING_FOR_CLIENT";
    caseRecord.currentFieldId = null;
    const result = handleClientText(caseRecord, "CONTINUAR");
    assert.equal(caseRecord.answers["identity.last_names"]?.status, "PENDING");
    assert.notEqual(caseRecord.currentFieldId, "identity.last_names");
    assert.doesNotMatch(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /apellidos completos/i);
  });

  it("removes partner questions when the client has no partner", () => {
    const caseRecord = consentedCase();
    caseRecord.answers["family.has_partner"] = confirmed("family.has_partner", false);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("partner.first_names"), false);
    assert.equal(ids.has("partner.birth_date"), false);
  });

  it("creates as many child records as declared", () => {
    const caseRecord = consentedCase();
    caseRecord.answers["children.count"] = confirmed("children.count", 2);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("children.1.first_names"), true);
    assert.equal(ids.has("children.2.first_names"), true);
    assert.equal(ids.has("children.3.first_names"), false);
  });

  it("creates repeated employment activities instead of fixed form rows", () => {
    const caseRecord = consentedCase();
    caseRecord.answers["employment.count"] = confirmed("employment.count", 4);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("employment.4.organization"), true);
    assert.equal(ids.has("employment.5.organization"), false);
  });

  it("pauses and resumes at the persisted field", () => {
    const caseRecord = consentedCase();
    const field = caseRecord.currentFieldId;
    const paused = handleClientText(caseRecord, "PAUSAR");
    assert.equal(paused.caseRecord.status, "PAUSED");
    assert.equal(paused.caseRecord.currentFieldId, field);
    const resumed = handleClientText(caseRecord, "CONTINUAR");
    assert.equal(resumed.caseRecord.status, "ACTIVE");
    assert.equal(resumed.caseRecord.currentFieldId, field);
  });

  it("counts a skipped passport as a required pending item", () => {
    const caseRecord = consentedCase();
    const initial = calculateProgress(caseRecord);
    handleClientText(caseRecord, "SALTAR");
    const afterPassportSkip = calculateProgress(caseRecord);
    assert.equal(afterPassportSkip.required, initial.required);
    assert.equal(afterPassportSkip.confirmed, initial.confirmed);
    assert.equal(afterPassportSkip.pending, initial.pending + 1);
  });

  it("records a deletion request without deleting immediately", () => {
    const caseRecord = consentedCase();
    const result = handleClientText(caseRecord, "BORRAR MIS DATOS");
    assert.equal(result.caseRecord.status, "DELETION_REQUESTED");
    assert.equal(result.auditEvents[0]?.event, "DELETION_REQUESTED");
  });

  it("accepts a deletion request even before consent", () => {
    const caseRecord = newCase("case-1", "+5215550000000");
    invite(caseRecord, "inicio", "es_MX");
    const result = handleClientText(caseRecord, "BORRAR MIS DATOS");
    assert.equal(result.caseRecord.status, "DELETION_REQUESTED");
  });

  it("can complete the entire non-sensitive stage without looping", () => {
    const caseRecord = consentedCase();
    for (let turns = 0; turns < 400 && caseRecord.status === "ACTIVE"; turns++) {
      assert.notEqual(caseRecord.currentFieldId, null);
      if (caseRecord.currentFieldId === "__proposal_batch__") {
        handleClientText(caseRecord, "Sí");
        continue;
      }
      const current = fieldById(caseRecord.currentFieldId!, caseRecord.answers);
      assert.ok(current, `missing definition for ${caseRecord.currentFieldId}`);
      let value = "Dato de prueba";
      if (current.kind === "yes_no") {
        value = ["contact.residential_same", "residence.applying_from_current"].includes(current.id) ? "Sí" : "No";
      } else if (current.kind === "date") {
        value = current.id === "identity.birth_date" ? "01/01/1990"
          : current.id === "passport.issue_date" ? "01/01/2024"
          : current.id === "passport.expiry_date" ? "01/01/2034"
          : current.id === "visit.from" ? "01/06/2027"
          : current.id === "visit.until" ? "15/06/2027"
          : "01/01/2020";
      } else if (current.kind === "year_month") {
        value = current.id.endsWith(".until") ? "ACTUAL" : "01/2016";
      } else if (current.kind === "integer") {
        value = current.id === "employment.count" ? "1" : "0";
      } else if (current.kind === "email") value = "cliente@example.com";
      else if (current.kind === "money") value = "5000";
      if (current.id === "workflow.passport_uploaded") {
        handlePassportDocument(caseRecord, "drive-file-1", [
          { fieldId: "identity.last_names", value: "Pérez", confidence: 100 },
          { fieldId: "identity.first_names", value: "Ana", confidence: 100 },
          { fieldId: "identity.birth_date", value: "1990-01-01", confidence: 100 },
          { fieldId: "identity.birth_city", value: "Ciudad", confidence: 100 },
          { fieldId: "identity.birth_country", value: "México", confidence: 100 },
          { fieldId: "identity.citizenship", value: "Mexicana", confidence: 100 },
          { fieldId: "passport.issuing_country", value: "México", confidence: 100 },
          { fieldId: "passport.issue_date", value: "2024-01-01", confidence: 100 },
          { fieldId: "passport.expiry_date", value: "2034-01-01", confidence: 100 },
        ]);
        continue;
      }
      handleClientText(caseRecord, value);
    }
    assert.equal(caseRecord.status, "READY_FOR_REVIEW");
    assert.equal(calculateProgress(caseRecord).percent, 100);
  });
});
