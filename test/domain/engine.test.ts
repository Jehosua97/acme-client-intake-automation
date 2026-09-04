import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateClientProgress, calculateProgress, handleClientText, handlePassportDocument, invite, newCase, questionFor, resumeIntakeByAdmin, startIntake, stopIntakeByAdmin } from "../../src/domain/engine.js";
import type { Answer, CaseRecord } from "../../src/domain/types.js";
import { catalogFor, fieldById, WORKFLOW_SCHEMA_FIELD } from "../../src/domain/catalog.js";

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
    assert.equal(started.caseRecord.answers["contact.phone"], undefined);
    assert.equal(started.caseRecord.answers["contact.phone_type"]?.value, "Celular");
    assert.equal(started.caseRecord.currentFieldId, "workflow.passport_uploaded");
    assert.equal(started.caseRecord.consentVersion, null);
    assert.equal(started.caseRecord.consentedAt, null);
    const overview = started.outgoing[0]?.type === "text" ? started.outgoing[0].body : "";
    assert.equal(started.outgoing.length, 1);
    assert.match(overview, /30 y 45 minutos/);
    assert.match(overview, /5 bloques/);
    assert.doesNotMatch(overview, /familiar falleció/i);
    assert.doesNotMatch(started.outgoing.map((message) => message.type === "text" ? message.body : "").join(" "), /ACEPTO|NO ACEPTO/);
    assert.match(overview, /varios días/);
    assert.match(overview, /cerrar WhatsApp y regresar cuando quieras/i);
    assert.match(overview, /cubrir los 10 años sin dejar meses vacíos/i);
    assert.match(overview, /Comencemos con tu pasaporte/i);
    assert.match(overview, /foto clara o un PDF/i);
    assert.doesNotMatch(overview, /ALTO|PAUSA|DETENTE|PARA|CONTINUAR/i);
    assert.doesNotMatch(overview, /de antemano cuántos periodos/i);
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
      "contact.phone_type": "Celular",
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
    assert.equal(caseRecord.currentFieldId, "identity.full_name");
    handleClientText(caseRecord, "Ana María Pérez López");
    assert.equal(caseRecord.currentFieldId, "identity.birth_date");
    const result = handleClientText(caseRecord, "SALTAR");
    assert.equal(caseRecord.answers["identity.birth_date"]?.status, "PENDING");
    assert.equal(caseRecord.currentFieldId, "identity.birth_city");
    assert.doesNotMatch(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /fecha de nacimiento/i);
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

  it("asks for the complete name and then collects the passport facts from the client", () => {
    const caseRecord = activeCase();
    const result = handlePassportDocument(caseRecord, "drive-file-1", []);
    assert.equal(caseRecord.answers["identity.full_name"], undefined);
    assert.equal(Object.hasOwn(caseRecord.answers, "identity.birth_date"), false);
    assert.equal(Object.hasOwn(caseRecord.answers, "passport.issuing_country"), false);
    assert.equal(caseRecord.currentFieldId, "identity.full_name");
    assert.match(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /nombre completo/i);

    handleClientText(caseRecord, "Ana María Pérez López");
    assert.equal(caseRecord.currentFieldId, "identity.birth_date");
    handleClientText(caseRecord, "01/01/1990");
    assert.equal(caseRecord.currentFieldId, "identity.birth_city");
    handleClientText(caseRecord, "Veracruz");
    assert.equal(caseRecord.currentFieldId, "passport.issuing_country");
    const issuingCountry = handleClientText(caseRecord, "Sí");
    assert.equal(caseRecord.answers["passport.issuing_country"]?.value, "México");
    assert.equal(caseRecord.currentFieldId, "passport.issue_date");
    assert.match(issuingCountry.outgoing[0]?.type === "text" ? issuingCountry.outgoing[0].body : "", /fecha de emisión/i);
  });

  it("reopens legacy passport facts that were left pending for staff", () => {
    const caseRecord = activeCase();
    handlePassportDocument(caseRecord, "drive-file-1", []);
    handleClientText(caseRecord, "Ana María Pérez López");
    caseRecord.answers["identity.birth_date"] = {
      fieldId: "identity.birth_date", value: null, status: "PENDING", source: "DOCUMENT", updatedAt: new Date().toISOString(),
    };
    caseRecord.status = "WAITING_FOR_CLIENT";
    caseRecord.currentFieldId = null;
    const result = handleClientText(caseRecord, "CONTINUAR");
    assert.equal(caseRecord.answers["identity.birth_date"]?.status, "PENDING");
    assert.equal(caseRecord.answers["identity.full_name"]?.value, "Ana María Pérez López");
    assert.equal(caseRecord.currentFieldId, "identity.birth_date");
    assert.match(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /fecha de nacimiento/i);
  });

  it("asks for the actual issuing country when the passport is not Mexican", () => {
    const caseRecord = activeCase();
    handlePassportDocument(caseRecord, "drive-file-1", []);
    handleClientText(caseRecord, "Ana María Pérez López");
    handleClientText(caseRecord, "01/01/1990");
    handleClientText(caseRecord, "Veracruz");
    const clarification = handleClientText(caseRecord, "No");
    assert.equal(caseRecord.currentFieldId, "passport.issuing_country");
    assert.equal(Object.hasOwn(caseRecord.answers, "passport.issuing_country"), false);
    assert.match(clarification.outgoing[0]?.type === "text" ? clarification.outgoing[0].body : "", /nombre del país/i);
    handleClientText(caseRecord, "Canadá");
    assert.equal(caseRecord.answers["passport.issuing_country"]?.value, "Canadá");
    assert.equal(caseRecord.currentFieldId, "passport.issue_date");
  });

  it("keeps an administrator-stopped case inactive until an explicit administrator resume", () => {
    const caseRecord = activeCase();
    const currentField = caseRecord.currentFieldId;
    const stopped = stopIntakeByAdmin(caseRecord);
    assert.equal(caseRecord.status, "STOPPED_BY_ADMIN");
    assert.equal(caseRecord.currentFieldId, currentField);
    assert.deepEqual(stopped.outgoing, []);
    assert.equal(stopped.auditEvents[0]?.event, "CASE_STOPPED_BY_ADMIN");
    const result = resumeIntakeByAdmin(caseRecord);
    assert.equal(caseRecord.status, "ACTIVE");
    assert.equal(caseRecord.currentFieldId, "workflow.passport_uploaded");
    assert.equal(result.auditEvents[0]?.event, "CASE_RESUMED_BY_ADMIN");
  });

  it("removes partner questions when the client has no partner", () => {
    const caseRecord = activeCase();
    caseRecord.answers["family.has_partner"] = confirmed("family.has_partner", false);
    const ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("partner.full_name"), false);
    assert.equal(ids.has("partner.birth_date"), false);
  });

  it("replaces UCI with prior-trip dates and biometrics when a new client has traveled to Canada", () => {
    const caseRecord = activeCase();
    caseRecord.answers["application.has_previous_canada_visa"] = confirmed("application.has_previous_canada_visa", true);
    caseRecord.answers["application.has_traveled_to_canada"] = confirmed("application.has_traveled_to_canada", true);
    let fields = catalogFor(caseRecord.answers);
    assert.equal(fields.some((field) => field.id === "application.uci"), false);
    assert.equal(fields.some((field) => field.id === "application.previous_canada_entry_date"), true);
    assert.equal(fields.some((field) => field.id === "application.previous_canada_exit_date"), true);
    assert.match(fields.find((field) => field.id === "application.has_canada_biometrics")?.prompt ?? "", /No sé/i);

    caseRecord.answers["application.has_traveled_to_canada"] = confirmed("application.has_traveled_to_canada", false);
    fields = catalogFor(caseRecord.answers);
    assert.equal(fields.some((field) => field.id === "application.uci"), true);
    assert.equal(fields.some((field) => field.id === "application.previous_canada_entry_date"), false);
  });

  it("keeps the previous UCI rules for expedients created before the workflow change", () => {
    const caseRecord = activeCase();
    delete caseRecord.answers[WORKFLOW_SCHEMA_FIELD];
    caseRecord.answers["application.has_previous_canada_visa"] = confirmed("application.has_previous_canada_visa", true);
    const fields = catalogFor(caseRecord.answers);
    assert.equal(fields.some((field) => field.id === "application.has_traveled_to_canada"), false);
    assert.equal(fields.some((field) => field.id === "application.uci"), true);
  });

  it("records an unknown biometrics status as a confirmed answer", () => {
    const caseRecord = activeCase();
    caseRecord.answers["application.has_previous_canada_visa"] = confirmed("application.has_previous_canada_visa", true);
    caseRecord.answers["application.has_traveled_to_canada"] = confirmed("application.has_traveled_to_canada", true);
    caseRecord.answers["application.previous_canada_entry_date"] = confirmed("application.previous_canada_entry_date", "2024-01-01");
    caseRecord.answers["application.previous_canada_exit_date"] = confirmed("application.previous_canada_exit_date", "2024-01-15");
    caseRecord.currentFieldId = "application.has_canada_biometrics";
    const result = handleClientText(caseRecord, "No sé");
    assert.equal(caseRecord.answers["application.has_canada_biometrics"]?.value, "NO SÉ");
    assert.equal(caseRecord.answers["application.has_canada_biometrics"]?.status, "CONFIRMED");
    assert.equal(result.auditEvents.some((event) => event.event === "ANSWER_SKIPPED"), false);
  });

  it("collects resident contact details only when the client has one in Canada", () => {
    const caseRecord = activeCase();
    const contactFields = ["visit.contact_name", "visit.contact_address", "visit.contact_phone", "visit.contact_email"];
    caseRecord.answers["visit.has_permanent_resident_contact"] = confirmed("visit.has_permanent_resident_contact", false);
    let ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    for (const fieldId of contactFields) assert.equal(ids.has(fieldId), false, fieldId);

    caseRecord.answers["visit.has_permanent_resident_contact"] = confirmed("visit.has_permanent_resident_contact", true);
    const fields = catalogFor(caseRecord.answers);
    ids = new Set(fields.map((field) => field.id));
    for (const fieldId of contactFields) assert.equal(ids.has(fieldId), true, fieldId);
    assert.equal(ids.has("visit.contact_relationship"), false);
    assert.match(fields.find((field) => field.id === "visit.contact_name")?.prompt ?? "", /nombres y apellidos/i);
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
    caseRecord.answers["visit.has_permanent_resident_contact"] = confirmed("visit.has_permanent_resident_contact", true);
    const fields = catalogFor(caseRecord.answers);
    const ids = fields.map((field) => field.id);
    assert.ok(ids.indexOf("contact.residential_address") < ids.indexOf("contact.mailing_address"));
    assert.ok(ids.indexOf("contact.mailing_address") < ids.indexOf("contact.email"));
    assert.ok(ids.indexOf("contact.email") < ids.indexOf("contact.phone"));
    assert.ok(ids.indexOf("contact.phone") < ids.indexOf("family.marital_status"));
    assert.ok(ids.indexOf("contact.email") < ids.indexOf("family.marital_status"));
    assert.ok(ids.indexOf("contact.mailing_address") < ids.indexOf("partner.address"));
    assert.match(fields.find((field) => field.id === "contact.residential_address")?.prompt ?? "", /_Ejemplo ficticio: Avenida de los Pinos 245.*_/);
    for (const fieldId of ["contact.mailing_address", "partner.address", "mother.address", "father.address", "children.1.address"]) {
      const prompt = fields.find((field) => field.id === fieldId)?.prompt ?? "";
      assert.match(prompt, /responde \*SÍ\* o escribe \*MISMA\*/, fieldId);
      assert.match(prompt, /Calle Principal 10/, fieldId);
      assert.match(prompt, /escribe la nueva dirección completa/, fieldId);
      assert.doesNotMatch(prompt, /nombre de la calle y número/, fieldId);
    }
    const canadaAddressPrompt = fields.find((field) => field.id === "visit.contact_address")?.prompt ?? "";
    assert.doesNotMatch(canadaAddressPrompt, /MISMA|Calle Principal 10/);

    caseRecord.currentFieldId = "partner.address";
    handleClientText(caseRecord, "Sí");
    assert.equal(caseRecord.answers["partner.address"]?.value, applicantAddress);

    caseRecord.currentFieldId = "mother.address";
    handleClientText(caseRecord, "MISMA");
    assert.equal(caseRecord.answers["mother.address"]?.value, applicantAddress);
  });

  it("offers the WhatsApp number naturally and accepts Sí as confirmation", () => {
    const caseRecord = activeCase();
    const phoneField = fieldById("contact.phone", caseRecord.answers);
    assert.ok(phoneField);
    assert.match(questionFor(caseRecord, phoneField), /Registramos que tu número de WhatsApp es/);
    assert.match(questionFor(caseRecord, phoneField), /\+5215550000000/);

    caseRecord.currentFieldId = "contact.phone";
    handleClientText(caseRecord, "Sí");
    assert.equal(caseRecord.answers["contact.phone"]?.value, "+5215550000000");

    const alternate = activeCase();
    alternate.currentFieldId = "contact.phone";
    handleClientText(alternate, "+52 229 123 4567");
    assert.equal(alternate.answers["contact.phone"]?.value, "+522291234567");
  });

  it("collects employment periods incrementally until the dynamic ten-year cutoff", () => {
    const caseRecord = activeCase();
    let fields = catalogFor(caseRecord.answers);
    let ids = new Set(fields.map((field) => field.id));
    assert.equal(ids.has("employment.count"), false);
    assert.equal(ids.has("employment.1.activity"), true);
    assert.equal(ids.has("employment.1.from"), true);
    assert.equal(ids.has("employment.1.until"), false);
    assert.equal(ids.has("employment.2.from"), false);
    assert.equal(ids.has("employment.1.country"), false);
    assert.ok(fields.findIndex((field) => field.id === "employment.1.activity") < fields.findIndex((field) => field.id === "employment.1.organization"));
    assert.ok(fields.findIndex((field) => field.id === "employment.1.organization") < fields.findIndex((field) => field.id === "employment.1.from"));
    const intro = fields.find((field) => field.id === "employment.1.activity")?.prompt ?? "";
    const today = new Date();
    const cutoffLabel = `${["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][today.getMonth()]} de ${today.getFullYear() - 10}`;
    assert.ok(intro.includes(cutoffLabel));
    assert.match(intro, /trabajo o actividad actual/i);
    assert.doesNotMatch(intro, /ejemplo|2 periodos|08\/2016 a 01\/2023/i);

    caseRecord.currentFieldId = "employment.1.activity";
    handleClientText(caseRecord, "Desarrollador de software");
    caseRecord.currentFieldId = "employment.1.organization";
    handleClientText(caseRecord, "Empresa actual");
    caseRecord.currentFieldId = "employment.1.from";
    handleClientText(caseRecord, "02/2023");
    assert.equal(caseRecord.answers["employment.1.until"]?.value, "CURRENT");
    fields = catalogFor(caseRecord.answers);
    ids = new Set(fields.map((field) => field.id));
    assert.equal(ids.has("employment.2.activity"), true);
    assert.match(fields.find((field) => field.id === "employment.2.activity")?.prompt ?? "", /Antes de .*Desarrollador de software.*Empresa actual/i);

    caseRecord.currentFieldId = "employment.2.activity";
    handleClientText(caseRecord, "Estudiante");
    caseRecord.currentFieldId = "employment.2.organization";
    handleClientText(caseRecord, "Universidad Veracruzana");
    caseRecord.currentFieldId = "employment.2.from";
    handleClientText(caseRecord, "08/2016");
    assert.equal(caseRecord.answers["employment.2.until"]?.value, "2023-01");
    ids = new Set(catalogFor(caseRecord.answers).map((field) => field.id));
    assert.equal(ids.has("employment.3.activity"), false);
  });

  it("rejects employment dates that break the backwards chronology", () => {
    const caseRecord = activeCase();
    caseRecord.answers["employment.1.from"] = confirmed("employment.1.from", "2023-02");
    caseRecord.currentFieldId = "employment.2.from";
    const result = handleClientText(caseRecord, "03/2023");
    assert.equal(caseRecord.answers["employment.2.from"], undefined);
    assert.match(result.outgoing[0]?.type === "text" ? result.outgoing[0].body : "", /debe haber comenzado antes de 02\/2023/i);
  });

  it("accepts an activity that began before the ten-year cutoff", () => {
    const caseRecord = activeCase();
    caseRecord.answers["employment.1.from"] = confirmed("employment.1.from", "2018-07");
    caseRecord.currentFieldId = "employment.2.from";
    const result = handleClientText(caseRecord, "01/2014");
    assert.equal(result.caseRecord.answers["employment.2.from"]?.value, "2014-01");
    assert.equal(result.caseRecord.answers["employment.2.until"]?.value, "2018-06");
    assert.equal(result.auditEvents.some((event) => event.event === "ANSWER_CONFIRMED"), true);
  });

  it("rejects a departure date that is not after arrival in Canada", () => {
    const caseRecord = activeCase();
    caseRecord.answers["visit.from"] = confirmed("visit.from", "2027-06-15");
    caseRecord.currentFieldId = "visit.until";
    const sameDay = handleClientText(caseRecord, "15/06/2027");
    assert.equal(caseRecord.answers["visit.until"], undefined);
    assert.match(sameDay.outgoing[0]?.type === "text" ? sameDay.outgoing[0].body : "", /salida debe ser posterior/i);
    const valid = handleClientText(caseRecord, "16/06/2027");
    assert.equal(valid.caseRecord.answers["visit.until"]?.value, "2027-06-16");
  });

  it("asks travel history in direct, client-friendly language", () => {
    const caseRecord = activeCase();
    caseRecord.answers["travel_history.has_travel"] = confirmed("travel_history.has_travel", true);
    caseRecord.answers["travel_history.count"] = confirmed("travel_history.count", 1);
    const fields = catalogFor(caseRecord.answers);
    assert.equal(fields.find((field) => field.id === "travel_history.has_travel")?.prompt, "✈️ ¿Has viajado al extranjero? Responde Sí o No.");
    assert.equal(fields.find((field) => field.id === "travel_history.count")?.prompt, "¿Cuántas veces has viajado al extranjero?");
    assert.ok(fields.findIndex((field) => field.id === "workflow.correction_notes") > fields.findIndex((field) => field.id === "travel_history.1.purpose"));
    assert.equal(fields.at(-1)?.id, "workflow.correction_notes");
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

  it("keeps hidden pause commands working without advertising CONTINUAR", () => {
    for (const command of ["ALTO", "PAUSA", "PAUSAR", "DETENTE", "PARA"]) {
      const caseRecord = activeCase();
      const field = caseRecord.currentFieldId;
      const paused = handleClientText(caseRecord, command);
      assert.equal(paused.caseRecord.status, "PAUSED", command);
      assert.equal(paused.caseRecord.currentFieldId, field, command);
      assert.match(paused.outgoing[0]?.type === "text" ? paused.outgoing[0].body : "", /no se perderá/);
      assert.doesNotMatch(paused.outgoing[0]?.type === "text" ? paused.outgoing[0].body : "", /CONTINUAR/i);
      handleClientText(caseRecord, "CONTINUAR");
      assert.equal(caseRecord.status, "ACTIVE", command);
      assert.equal(caseRecord.currentFieldId, field, command);
    }
  });

  it("resumes naturally when the client replies after a hidden pause", () => {
    const caseRecord = activeCase();
    handleClientText(caseRecord, "PAUSA");
    const resumed = handleClientText(caseRecord, "SALTAR");
    assert.equal(caseRecord.status, "ACTIVE");
    assert.equal(caseRecord.answers["workflow.passport_uploaded"]?.status, "PENDING");
    assert.equal(caseRecord.currentFieldId, "identity.full_name");
    assert.ok(resumed.outgoing.length > 0);
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
    let lastAuditEvents: Array<{ event: string; detail: Record<string, unknown> }> = [];
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
          : current.id === "application.previous_canada_entry_date" ? "01/01/2024"
          : current.id === "application.previous_canada_exit_date" ? "15/01/2024"
          : current.id === "visit.from" ? "01/06/2027"
          : current.id === "visit.until" ? "15/06/2027"
          : "01/01/2020";
      } else if (current.kind === "year_month") {
        value = current.id.endsWith(".until") ? "ACTUAL" : "01/2016";
      } else if (current.kind === "integer") {
        value = "0";
      } else if (current.kind === "email") value = "cliente@example.com";
      else if (current.kind === "phone") value = "+52 55 1234 5678";
      else if (current.kind === "money") value = "5000";
      if (current.id === "application.has_canada_biometrics") value = "No sé";
      if (current.id === "workflow.correction_notes") value = "TODO CORRECTO";
      if (current.id === "workflow.passport_uploaded") {
        const result = handlePassportDocument(caseRecord, "drive-file-1", []);
        lastOutgoing = result.outgoing.map((message) => message.type === "text" ? message.body : "").join("\n");
        lastAuditEvents = result.auditEvents;
        continue;
      }
      const result = handleClientText(caseRecord, value);
      lastOutgoing = result.outgoing.map((message) => message.type === "text" ? message.body : "").join("\n");
      lastAuditEvents = result.auditEvents;
    }
    assert.equal(caseRecord.status, "READY_FOR_REVIEW");
    assert.equal(calculateProgress(caseRecord).percent, 100);
    assert.equal(calculateClientProgress(caseRecord).percent, 100);
    assert.equal(caseRecord.answers["workflow.correction_notes"]?.value, "SIN CORRECCIONES");
    assert.match(lastOutgoing, /Eso es todo\. Muchas gracias/);
    assert.match(lastOutgoing, /cliente@example\.com/);
    assert.match(lastOutgoing, /próximas horas/);
    assert.match(lastOutgoing, /bot ya no procesará más mensajes/);
    assert.equal(lastAuditEvents.some((event) => event.event === "CLIENT_INTAKE_CLOSED"), true);
    assert.deepEqual(handleClientText(caseRecord, "Otro mensaje").outgoing, []);
  });
});
