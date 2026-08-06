import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateClientProgress, calculateProgress, handleClientText, handlePassportDocument, invite, newCase, startIntake } from "../../src/domain/engine.js";
import type { Answer, CaseRecord } from "../../src/domain/types.js";
import { catalogFor, fieldById } from "../../src/domain/catalog.js";

function activeCase(): CaseRecord {
  const caseRecord = newCase("case-1", "+5215550000000");
  invite(caseRecord, "inicio", "es_MX");
  startIntake(caseRecord);
  return caseRecord;
}

function confirmed(fieldId: string, value: Answer["value"]): Answer {
  return { fieldId, value, status: "CONFIRMED", source: "CHAT", confidence: 100, updatedAt: new Date().toISOString() };
}

describe("conversation engine", () => {
  it("starts the questionnaire immediately without asking for chat consent", () => {
    const caseRecord = newCase("case-1", "+5215550000000");
    const invitation = invite(caseRecord, "inicio", "es_MX");
    assert.equal(invitation.caseRecord.status, "INVITED");
    assert.equal(invitation.outgoing[0]?.type, "template");

    const started = handleClientText(caseRecord, "hola");
    assert.equal(started.caseRecord.status, "ACTIVE");
    assert.equal(started.caseRecord.answers["contact.phone"]?.value, "+5215550000000");
    assert.equal(started.caseRecord.currentFieldId, "workflow.passport_uploaded");
    assert.equal(started.caseRecord.consentVersion, null);
    assert.equal(started.caseRecord.consentedAt, null);
    const overview = started.outgoing[0]?.type === "text" ? started.outgoing[0].body : "";
    assert.match(overview, /30 y 45 minutos/);
    assert.match(overview, /5 bloques/);
    assert.doesNotMatch(overview, /familiar falleció/i);
    assert.doesNotMatch(started.outgoing.map((message) => message.type === "text" ? message.body : "").join(" "), /ACEPTO|NO ACEPTO/);
    assert.match(overview, /ALTO.*PAUSA.*DETENTE.*PARA/);
    assert.match(overview, /varios días/);
  });

  it("prefills facts shared by Mexican-born clients living and applying in Mexico", () => {
    const caseRecord = activeCase();
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
      "education.country": "México",
      "employment.1.country": "México",
    };
    for (const [fieldId, value] of Object.entries(expected)) {
      assert.equal(caseRecord.answers[fieldId]?.value, value);
      assert.equal(caseRecord.answers[fieldId]?.source, "SYSTEM");
      assert.equal(caseRecord.answers[fieldId]?.status, "CONFIRMED");
    }
  });

  it("does not immediately repeat a skipped question", () => {
    const caseRecord = activeCase();
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
    const caseRecord = activeCase();
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
    const caseRecord = activeCase();
    const result = handlePassportDocument(caseRecord, "drive-file-1", []);
    assert.equal(caseRecord.answers["identity.full_name"]?.status, "PENDING");
    assert.equal(caseRecord.answers["identity.full_name"]?.source, "DOCUMENT");
    assert.notEqual(caseRecord.currentFieldId, "identity.full_name");
    assert.ok(result.outgoing.length > 0);
  });

  it("never reopens passport fields through CONTINUAR", () => {
    const caseRecord = activeCase();
    handlePassportDocument(caseRecord, "drive-file-1", []);
    caseRecord.status = "WAITING_FOR_CLIENT";
    caseRecord.currentFieldId = null;
    const result = handleClientText(caseRecord, "CONTINUAR");
    assert.equal(caseRecord.answers["identity.full_name"]?.status, "PENDING");
    assert.notEqual(caseRecord.currentFieldId, "identity.full_name");
    assert.doesNotMatch(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /apellidos completos/i);
  });

  it("removes partner questions when the client has no partner", () => {
    const caseRecord = activeCase();
    caseRecord.answers["family.has_partner"] = confirmed("family.has_partner", false);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("partner.full_name"), false);
    assert.equal(ids.has("partner.birth_date"), false);
  });

  it("infers deceased relatives from marital status and skips their remaining details", () => {
    const caseRecord = activeCase();
    caseRecord.answers["mother.full_name"] = confirmed("mother.full_name", "María López");
    caseRecord.answers["mother.marital_status"] = confirmed("mother.marital_status", "FALLECIDO/A");
    caseRecord.answers["children.count"] = confirmed("children.count", 1);
    caseRecord.answers["children.1.marital_status"] = confirmed("children.1.marital_status", "FALLECIDO/A");
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    for (const prefix of ["mother", "children.1"]) {
      assert.equal(ids.has(`${prefix}.full_name`), true);
      assert.equal(ids.has(`${prefix}.birth_date`), true);
      assert.equal(ids.has(`${prefix}.marital_status`), true);
      for (const suffix of ["address", "occupation", "accompanies"]) {
        assert.equal(ids.has(`${prefix}.${suffix}`), false, `${prefix}.${suffix}`);
      }
    }
  });

  it("asks for the mother first and skips all remaining details when a parent is unknown", () => {
    const caseRecord = activeCase();
    let ids = catalogFor(caseRecord.answers).map((field) => field.id);
    assert.ok(ids.indexOf("mother.full_name") < ids.indexOf("father.full_name"));
    assert.equal(ids.includes("mother.birth_date"), false);
    assert.equal(ids.includes("father.birth_date"), false);

    caseRecord.currentFieldId = "mother.full_name";
    handleClientText(caseRecord, "NO SÉ");
    caseRecord.currentFieldId = "father.full_name";
    handleClientText(caseRecord, "No lo conozco");
    assert.equal(caseRecord.answers["mother.full_name"]?.value, "DESCONOCIDA");
    assert.equal(caseRecord.answers["father.full_name"]?.value, "DESCONOCIDO");

    ids = catalogFor(caseRecord.answers).map((field) => field.id);
    for (const prefix of ["mother", "father"]) {
      for (const suffix of ["birth_date", "birth_country", "marital_status", "address", "occupation", "accompanies"]) {
        assert.equal(ids.includes(`${prefix}.${suffix}`), false, `${prefix}.${suffix}`);
      }
    }
  });

  it("creates as many child records as declared", () => {
    const caseRecord = activeCase();
    caseRecord.answers["children.count"] = confirmed("children.count", 2);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("children.1.full_name"), true);
    assert.equal(ids.has("children.2.full_name"), true);
    assert.equal(ids.has("children.3.full_name"), false);
  });

  it("asks for the applicant address before alternate addresses and copies it when the answer is MISMA", () => {
    const caseRecord = activeCase();
    const applicantAddress = "Calle Principal 10, Colonia Centro, Municipio de Veracruz, Veracruz, C.P. 91700";
    caseRecord.answers["contact.residential_address"] = confirmed("contact.residential_address", applicantAddress);
    caseRecord.answers["family.has_partner"] = confirmed("family.has_partner", true);
    caseRecord.answers["mother.full_name"] = confirmed("mother.full_name", "María López");
    caseRecord.answers["father.full_name"] = confirmed("father.full_name", "Juan Pérez");
    caseRecord.answers["children.count"] = confirmed("children.count", 1);
    caseRecord.answers["children.1.marital_status"] = confirmed("children.1.marital_status", "Soltero/a");
    const fields = catalogFor(caseRecord.answers);
    const ids = fields.map((field) => field.id);
    assert.ok(ids.indexOf("contact.residential_address") < ids.indexOf("contact.mailing_address"));
    assert.ok(ids.indexOf("contact.mailing_address") < ids.indexOf("contact.email"));
    assert.ok(ids.indexOf("contact.email") < ids.indexOf("family.marital_status"));
    assert.ok(ids.indexOf("contact.mailing_address") < ids.indexOf("partner.address"));
    assert.match(fields.find((field) => field.id === "contact.residential_address")?.prompt ?? "", /_Ejemplo ficticio: Avenida de los Pinos 245.*_/);
    for (const fieldId of ["contact.mailing_address", "partner.address", "mother.address", "father.address", "children.1.address"]) {
      const prompt = fields.find((field) => field.id === fieldId)?.prompt ?? "";
      assert.match(prompt, /escribe \*MISMA\*/, fieldId);
      assert.match(prompt, /Calle Principal 10/, fieldId);
      assert.match(prompt, /escribe la nueva dirección completa/, fieldId);
      assert.doesNotMatch(prompt, /nombre de la calle y número/, fieldId);
    }
    const canadaAddressPrompt = fields.find((field) => field.id === "visit.contact_address")?.prompt ?? "";
    assert.doesNotMatch(canadaAddressPrompt, /MISMA|Calle Principal 10/);

    caseRecord.currentFieldId = "partner.address";
    handleClientText(caseRecord, "MISMA");
    assert.equal(caseRecord.answers["partner.address"]?.value, applicantAddress);
  });

  it("collects employment periods incrementally until the dynamic ten-year cutoff", () => {
    const caseRecord = activeCase();
    let fields = catalogFor(caseRecord.answers);
    let ids = new Set(fields.map((field) => field.id));
    assert.equal(ids.has("employment.count"), false);
    assert.equal(ids.has("employment.1.from"), true);
    assert.equal(ids.has("employment.2.from"), false);
    assert.equal(ids.has("employment.1.country"), false);
    const intro = fields.find((field) => field.id === "employment.1.from")?.prompt ?? "";
    assert.match(intro, /agosto de 2016/);
    assert.match(intro, /_08\/2016 a 01\/2023/);
    assert.match(intro, /una por una/);

    caseRecord.answers["employment.1.from"] = confirmed("employment.1.from", "2023-02");
    fields = catalogFor(caseRecord.answers);
    ids = new Set(fields.map((field) => field.id));
    assert.equal(ids.has("employment.2.from"), true);

    caseRecord.answers["employment.2.from"] = confirmed("employment.2.from", "2016-08");
    ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("employment.3.from"), false);
  });

  it("asks travel history in direct, client-friendly language", () => {
    const caseRecord = activeCase();
    caseRecord.answers["travel_history.has_travel"] = confirmed("travel_history.has_travel", true);
    const fields = catalogFor(caseRecord.answers);
    assert.equal(fields.find((field) => field.id === "travel_history.has_travel")?.prompt, "✈️ ¿Has viajado al extranjero? Responde Sí o No.");
    assert.equal(fields.find((field) => field.id === "travel_history.count")?.prompt, "¿Cuántas veces has viajado al extranjero?");
  });

  it("pauses and resumes at the persisted field", () => {
    const caseRecord = activeCase();
    const field = caseRecord.currentFieldId;
    const paused = handleClientText(caseRecord, "PAUSAR");
    assert.equal(paused.caseRecord.status, "PAUSED");
    assert.equal(paused.caseRecord.currentFieldId, field);
    const resumed = handleClientText(caseRecord, "CONTINUAR");
    assert.equal(resumed.caseRecord.status, "ACTIVE");
    assert.equal(resumed.caseRecord.currentFieldId, field);
  });

  it("continues normally days later even when the client never used a pause command", () => {
    const caseRecord = activeCase();
    handleClientText(caseRecord, "SALTAR");
    const persistedField = caseRecord.currentFieldId;
    caseRecord.updatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString();
    const resumed = handleClientText(caseRecord, "SALTAR");
    assert.equal(caseRecord.status, "ACTIVE");
    assert.notEqual(caseRecord.currentFieldId, persistedField);
    assert.ok(resumed.outgoing.length > 0);
  });

  it("accepts every advertised pause command without losing the current field", () => {
    for (const command of ["ALTO", "PAUSA", "PAUSAR", "DETENTE", "PARA"]) {
      const caseRecord = activeCase();
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
    const caseRecord = activeCase();
    const initial = calculateProgress(caseRecord);
    handleClientText(caseRecord, "SALTAR");
    const afterPassportSkip = calculateProgress(caseRecord);
    assert.equal(afterPassportSkip.required, initial.required);
    assert.equal(afterPassportSkip.confirmed, initial.confirmed);
    assert.equal(afterPassportSkip.pending, initial.pending + 1);
  });

  it("records a deletion request without deleting immediately", () => {
    const caseRecord = activeCase();
    const result = handleClientText(caseRecord, "BORRAR MIS DATOS");
    assert.equal(result.caseRecord.status, "DELETION_REQUESTED");
    assert.equal(result.auditEvents[0]?.event, "DELETION_REQUESTED");
  });

  it("accepts a deletion request before the questionnaire starts", () => {
    const caseRecord = newCase("case-1", "+5215550000000");
    invite(caseRecord, "inicio", "es_MX");
    const result = handleClientText(caseRecord, "BORRAR MIS DATOS");
    assert.equal(result.caseRecord.status, "DELETION_REQUESTED");
  });

  it("can complete the entire non-sensitive stage without looping", () => {
    const caseRecord = activeCase();
    let lastOutgoing = "";
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
        value = "0";
      } else if (current.kind === "email") value = "cliente@example.com";
      else if (current.kind === "money") value = "5000";
      if (current.id === "workflow.passport_uploaded") {
        const result = handlePassportDocument(caseRecord, "drive-file-1", []);
        lastOutgoing = result.outgoing.map((message) => message.type === "text" ? message.body : "").join("\n");
        continue;
      }
      const result = handleClientText(caseRecord, value);
      lastOutgoing = result.outgoing.map((message) => message.type === "text" ? message.body : "").join("\n");
    }
    assert.equal(caseRecord.status, "NEEDS_STAFF_REVIEW");
    assert.ok(calculateProgress(caseRecord).percent < 100);
    assert.equal(calculateClientProgress(caseRecord).percent, 100);
    assert.match(lastOutgoing, /preguntas están completas: 100%/);
    assert.match(lastOutgoing, /No necesitas responder nada más/);
  });
});
