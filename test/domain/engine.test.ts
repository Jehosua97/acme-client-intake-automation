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
    const overview = accepted.outgoing[0]?.type === "text" ? accepted.outgoing[0].body : "";
    assert.match(overview, /30 y 45 minutos/);
    assert.match(overview, /5 bloques/);
    assert.match(overview, /Familia: 18 preguntas base/);
    assert.match(overview, /ALTO, PAUSA, DETENTE o PARA/);
    assert.match(overview, /distintos días/);
  });

  it("prefills facts shared by Mexican-born clients living and applying in Mexico", () => {
    const caseRecord = consentedCase();
    const expected: Record<string, Answer["value"]> = {
      "identity.birth_country": "México",
      "identity.citizenship": "México",
      "residence.current_country": "México",
      "residence.current_status": "Ciudadano/a",
      "residence.applying_from_current": true,
      "contact.mailing_country": "México",
      "contact.residential_country": "México",
      "language.mother_tongue": "Español",
      "language.preferred": "Inglés",
    };
    for (const [fieldId, value] of Object.entries(expected)) {
      assert.equal(caseRecord.answers[fieldId]?.value, value);
      assert.equal(caseRecord.answers[fieldId]?.source, "SYSTEM");
      assert.equal(caseRecord.answers[fieldId]?.status, "CONFIRMED");
    }
  });

  it("does not immediately repeat a skipped question", () => {
    const caseRecord = consentedCase();
    handleClientText(caseRecord, "SALTAR"); // pasaporte pendiente
    handleClientText(caseRecord, "SALTAR"); // UCI opcional
    handleClientText(caseRecord, "Visa de visitante");
    assert.equal(caseRecord.currentFieldId, "identity.full_name");
    const result = handleClientText(caseRecord, "SALTAR");
    assert.equal(caseRecord.answers["identity.full_name"]?.status, "PENDING");
    assert.equal(caseRecord.currentFieldId, "identity.birth_date");
    assert.doesNotMatch(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /nombre completo/);
  });

  it("uses one compact confirmation for passport proposals", () => {
    const caseRecord = consentedCase();
    const result = handlePassportDocument(caseRecord, "media-1", [
      { fieldId: "identity.full_name", value: "Ana María Pérez López", confidence: 99 },
    ]);
    assert.equal(caseRecord.currentFieldId, "__proposal_batch__");
    const body = result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "";
    assert.match(body, /Ana María Pérez López/);

    handleClientText(caseRecord, "Sí");
    assert.equal(caseRecord.answers["identity.full_name"]?.status, "CONFIRMED");
    assert.notEqual(caseRecord.currentFieldId, "identity.full_name");
  });

  it("leaves passport values for staff review without asking the client again", () => {
    const caseRecord = consentedCase();
    const result = handlePassportDocument(caseRecord, "drive-file-1", []);
    assert.equal(caseRecord.answers["identity.full_name"]?.status, "PENDING");
    assert.equal(caseRecord.answers["identity.full_name"]?.source, "DOCUMENT");
    assert.notEqual(caseRecord.currentFieldId, "identity.full_name");
    assert.ok(result.outgoing.length > 0);
  });

  it("never reopens passport fields through CONTINUAR", () => {
    const caseRecord = consentedCase();
    handlePassportDocument(caseRecord, "drive-file-1", []);
    caseRecord.status = "WAITING_FOR_CLIENT";
    caseRecord.currentFieldId = null;
    const result = handleClientText(caseRecord, "CONTINUAR");
    assert.equal(caseRecord.answers["identity.full_name"]?.status, "PENDING");
    assert.notEqual(caseRecord.currentFieldId, "identity.full_name");
    assert.doesNotMatch(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /apellidos completos/i);
  });

  it("removes partner questions when the client has no partner", () => {
    const caseRecord = consentedCase();
    caseRecord.answers["family.has_partner"] = confirmed("family.has_partner", false);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("partner.full_name"), false);
    assert.equal(ids.has("partner.birth_date"), false);
  });

  it("infers deceased relatives from marital status and skips their remaining details", () => {
    const caseRecord = consentedCase();
    caseRecord.answers["parent1.marital_status"] = confirmed("parent1.marital_status", "FALLECIDO/A");
    caseRecord.answers["children.count"] = confirmed("children.count", 1);
    caseRecord.answers["children.1.marital_status"] = confirmed("children.1.marital_status", "FALLECIDO/A");
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    for (const prefix of ["parent1", "children.1"]) {
      assert.equal(ids.has(`${prefix}.full_name`), true);
      assert.equal(ids.has(`${prefix}.birth_date`), true);
      assert.equal(ids.has(`${prefix}.marital_status`), true);
      for (const suffix of ["address", "occupation", "accompanies"]) {
        assert.equal(ids.has(`${prefix}.${suffix}`), false, `${prefix}.${suffix}`);
      }
    }
  });

  it("creates as many child records as declared", () => {
    const caseRecord = consentedCase();
    caseRecord.answers["children.count"] = confirmed("children.count", 2);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("children.1.full_name"), true);
    assert.equal(ids.has("children.2.full_name"), true);
    assert.equal(ids.has("children.3.full_name"), false);
  });

  it("asks for the applicant address before alternate addresses and copies it when the answer is MISMA", () => {
    const caseRecord = consentedCase();
    const applicantAddress = "Calle Principal 10, Colonia Centro, Municipio de Veracruz, Veracruz, C.P. 91700";
    caseRecord.answers["contact.residential_address"] = confirmed("contact.residential_address", applicantAddress);
    caseRecord.answers["family.has_partner"] = confirmed("family.has_partner", true);
    caseRecord.answers["children.count"] = confirmed("children.count", 1);
    caseRecord.answers["children.1.marital_status"] = confirmed("children.1.marital_status", "Soltero/a");
    const fields = catalogFor(caseRecord.answers);
    const ids = fields.map((field) => field.id);
    assert.ok(ids.indexOf("contact.residential_address") < ids.indexOf("contact.mailing_address"));
    assert.ok(ids.indexOf("contact.mailing_address") < ids.indexOf("partner.address"));
    assert.match(fields.find((field) => field.id === "contact.residential_address")?.prompt ?? "", /Avenida de los Pinos 245/);
    for (const fieldId of ["contact.mailing_address", "partner.address", "parent1.address", "parent2.address", "children.1.address", "visit.contact_address"]) {
      const prompt = fields.find((field) => field.id === fieldId)?.prompt ?? "";
      assert.match(prompt, /escribe MISMA/, fieldId);
      assert.match(prompt, /Calle Principal 10/, fieldId);
      assert.match(prompt, /escribe la nueva dirección completa/, fieldId);
      assert.doesNotMatch(prompt, /nombre de la calle y número/, fieldId);
    }

    caseRecord.currentFieldId = "partner.address";
    handleClientText(caseRecord, "MISMA");
    assert.equal(caseRecord.answers["partner.address"]?.value, applicantAddress);
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

  it("accepts every advertised pause command without losing the current field", () => {
    for (const command of ["ALTO", "PAUSA", "PAUSAR", "DETENTE", "PARA"]) {
      const caseRecord = consentedCase();
      const field = caseRecord.currentFieldId;
      const paused = handleClientText(caseRecord, command);
      assert.equal(paused.caseRecord.status, "PAUSED", command);
      assert.equal(paused.caseRecord.currentFieldId, field, command);
      assert.match(paused.outgoing[0]?.type === "text" ? paused.outgoing[0].body : "", /no se perderá/);
      handleClientText(caseRecord, "CONTINUAR");
      assert.equal(caseRecord.status, "ACTIVE", command);
      assert.equal(caseRecord.currentFieldId, field, command);
    }
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
        value = current.id === "residence.applying_from_current" ? "Sí" : "No";
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
          { fieldId: "identity.full_name", value: "Ana Pérez", confidence: 100 },
          { fieldId: "identity.birth_date", value: "1990-01-01", confidence: 100 },
          { fieldId: "identity.birth_city", value: "Ciudad", confidence: 100 },
          { fieldId: "identity.birth_country", value: "México", confidence: 100 },
          { fieldId: "identity.citizenship", value: "México", confidence: 100 },
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
