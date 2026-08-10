import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleUsaDocument, handleUsaText, newUsaCase, startUsaIntake } from "../../src/domain/usa-engine.js";
import { CURRENT_USA_WORKFLOW_SCHEMA_VERSION, USA_WORKFLOW_SCHEMA_FIELD, usaCatalogFor, usaFieldById } from "../../src/domain/usa-catalog.js";
import { resolveAddressInput } from "../../src/domain/address.js";
import type { CaseRecord, FieldDefinition } from "../../src/domain/types.js";

const answerFor = (field: FieldDefinition): string => {
  const specific: Record<string, string> = {
    "identity.full_name": "Ana Pérez López",
    "identity.birth_date": "15/06/1990",
    "identity.birth_city": "Veracruz",
    "identity.birth_country": "México",
    "passport.issuing_country": "México",
    "passport.issue_date": "01/02/2020",
    "passport.expiry_date": "01/02/2030",
    "contact.phone": "Sí",
    "contact.email": "ana@example.com",
    "education.level": "Sin estudios",
    "mother.full_name": "No sé",
    "father.full_name": "No sé",
    "workflow.correction_notes": "TODO CORRECTO",
  };
  const specificAnswer = specific[field.id];
  if (specificAnswer !== undefined) return specificAnswer;
  if (field.kind === "yes_no") return "No";
  if (field.kind === "phone") return "+1 305 555 0123";
  if (field.kind === "email") return "dato@example.com";
  if (field.kind === "date") return "01/01/1990";
  if (field.kind === "year_month") return "01/2020";
  if (field.kind === "integer") return "1";
  return "Dato de prueba";
};

function advanceTo(caseRecord: CaseRecord, target: string, overrides: Record<string, string> = {}): CaseRecord {
  for (let count = 0; count < 100; count += 1) {
    if (caseRecord.currentFieldId === target) return caseRecord;
    assert.equal(caseRecord.status, "ACTIVE", `El flujo terminó antes de llegar a ${target}`);
    const currentId = caseRecord.currentFieldId;
    assert.ok(currentId, `No hay pregunta activa antes de ${target}`);
    if (currentId === "workflow.passport_uploaded") {
      caseRecord = handleUsaDocument(caseRecord, "drive-passport").caseRecord;
      continue;
    }
    const field = usaFieldById(currentId, caseRecord.answers);
    assert.ok(field, `No existe la definición de ${currentId}`);
    caseRecord = handleUsaText(caseRecord, overrides[currentId] ?? answerFor(field)).caseRecord;
  }
  assert.fail(`El flujo no llegó a ${target}`);
}

function completeActivePass(caseRecord: CaseRecord): CaseRecord {
  for (let count = 0; count < 100 && caseRecord.status === "ACTIVE"; count += 1) {
    const currentId = caseRecord.currentFieldId;
    assert.ok(currentId, "El flujo activo debe tener una pregunta");
    if (currentId === "workflow.passport_uploaded") caseRecord = handleUsaDocument(caseRecord, "drive-passport").caseRecord;
    else {
      const field = usaFieldById(currentId, caseRecord.answers);
      assert.ok(field, `No existe la definición de ${currentId}`);
      caseRecord = handleUsaText(caseRecord, answerFor(field)).caseRecord;
    }
  }
  return caseRecord;
}

describe("USA conversation engine", () => {
  it("versions new questionnaires without changing legacy cases", () => {
    const modern = newUsaCase("usa-version", "+14165550123");
    assert.equal(modern.answers[USA_WORKFLOW_SCHEMA_FIELD]?.value, CURRENT_USA_WORKFLOW_SCHEMA_VERSION);
    const modernIds = usaCatalogFor(modern.answers).map((field) => field.id);
    const legacyIds = usaCatalogFor({}).map((field) => field.id);
    assert.equal(modernIds[2], "identity.birth_date");
    assert.equal(legacyIds[2], "contact.residential_address");
  });

  it("asks about other emails immediately after the primary email", () => {
    const ids = usaCatalogFor(newUsaCase().answers).map((field) => field.id);
    assert.equal(ids.includes("contact.email_confirmed"), false);
    assert.equal(ids.indexOf("contact.has_additional_email"), ids.indexOf("contact.email") + 1);
  });

  it("allows reporting a deceased parent and then removes inapplicable details", () => {
    const caseRecord = newUsaCase("usa-parent", "+14165550123");
    caseRecord.answers["father.full_name"] = { fieldId: "father.full_name", value: "FALLECIDO", status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() };
    const ids = usaCatalogFor(caseRecord.answers).map((field) => field.id);
    assert.equal(ids.includes("father.address"), false);
    assert.equal(ids.includes("father.birth_date"), false);
    assert.equal(ids.includes("father.occupation"), false);
    caseRecord.answers["father.full_name"].value = "José Pérez";
    assert.match(usaFieldById("father.occupation", caseRecord.answers)?.prompt ?? "", /FALLECIDO/);
  });

  it("does not mention death while requesting the mother's full name", () => {
    const field = usaFieldById("mother.full_name", newUsaCase().answers);
    assert.match(field?.prompt ?? "", /Si no la conoces, escribe NO SÉ/);
    assert.doesNotMatch(field?.prompt ?? "", /falleci|FALLECIDA/i);
  });

  it("asks for visited countries in one message and stores a normalized list", () => {
    const caseRecord = newUsaCase("usa-countries", "+14165550123");
    caseRecord.status = "ACTIVE";
    caseRecord.currentFieldId = "travel.countries";
    caseRecord.answers["travel.has_foreign_travel"] = { fieldId: "travel.has_foreign_travel", value: true, status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() };
    assert.match(usaFieldById("travel.countries", caseRecord.answers)?.prompt ?? "", /separados por comas y en un solo mensaje/);
    const result = handleUsaText(caseRecord, "Canadá, Estados Unidos, canadá, Francia");
    assert.equal(result.caseRecord.answers["travel.countries"]?.value, "Canadá, Estados Unidos, Francia");
  });

  it("asks the last education level and conditionally requests its details", () => {
    let noStudies = advanceTo(startUsaIntake(newUsaCase("usa-school-no", "+14165550123")).caseRecord, "education.level");
    noStudies = handleUsaText(noStudies, "Sin estudios").caseRecord;
    assert.equal(noStudies.currentFieldId, "visit.destination");

    let studies = advanceTo(startUsaIntake(newUsaCase("usa-school-yes", "+14165550123")).caseRecord, "education.level");
    studies = handleUsaText(studies, "Licenciatura").caseRecord;
    assert.equal(studies.currentFieldId, "education.school");
    studies = handleUsaText(studies, "Universidad Veracruzana").caseRecord;
    assert.equal(studies.currentFieldId, "education.from");
    assert.equal(usaFieldById("education.from", studies.answers)?.kind, "year_month");
  });

  it("starts with the passport, records its document source and requests identity facts", () => {
    let result = startUsaIntake(newUsaCase("usa-1", "+14165550123"));
    assert.equal(result.caseRecord.currentFieldId, "workflow.passport_uploaded");
    result = handleUsaDocument(result.caseRecord, "drive-passport");
    assert.equal(result.caseRecord.answers["workflow.passport_uploaded"]?.source, "DOCUMENT");
    assert.equal(result.caseRecord.currentFieldId, "identity.full_name");
    result = handleUsaText(result.caseRecord, "María López");
    assert.equal(result.caseRecord.currentFieldId, "identity.birth_date");
  });

  it("uses the Canada-style address and WhatsApp phone patterns", () => {
    let caseRecord = advanceTo(startUsaIntake(newUsaCase("usa-4", "+14378781645")).caseRecord, "contact.residential_address");
    const summaryResult = handleUsaText(caseRecord, "RESUMEN");
    assert.equal(summaryResult.caseRecord.currentFieldId, "contact.residential_address");
    caseRecord = handleUsaText(caseRecord, "Avenida de los Pinos 245, Boca del Río, Veracruz, C.P. 94294").caseRecord;
    assert.equal(caseRecord.currentFieldId, "contact.phone");
    const phoneReply = handleUsaText(caseRecord, "Sí");
    assert.equal(phoneReply.caseRecord.answers["contact.phone"]?.value, "+14378781645");
    assert.equal(phoneReply.caseRecord.currentFieldId, "contact.has_additional_phone");
  });

  it("asks for a different phone after the WhatsApp number is rejected", () => {
    const caseRecord = advanceTo(startUsaIntake(newUsaCase("usa-phone-no", "+14378781645")).caseRecord, "contact.phone");
    const rejected = handleUsaText(caseRecord, "No");
    assert.equal(rejected.caseRecord.currentFieldId, "contact.phone");
    assert.equal(rejected.caseRecord.answers["contact.phone"], undefined);
    assert.match(rejected.outgoing[0]?.type === "text" ? rejected.outgoing[0].body : "", /otro número/);
  });

  it("continues directly from the primary email to additional-email history", () => {
    let caseRecord = advanceTo(startUsaIntake(newUsaCase("usa-email", "+14165550123")).caseRecord, "contact.email");
    caseRecord = handleUsaText(caseRecord, "correcto@example.com").caseRecord;
    assert.equal(caseRecord.answers["contact.email"]?.value, "correcto@example.com");
    assert.equal(caseRecord.currentFieldId, "contact.has_additional_email");
  });

  it("advances old active cases that were waiting on the removed email confirmation", () => {
    const caseRecord = newUsaCase("usa-old-email-confirmation", "+14165550123");
    caseRecord.status = "ACTIVE";
    caseRecord.currentFieldId = "contact.email_confirmed";
    caseRecord.answers["contact.email"] = { fieldId: "contact.email", value: "ana@example.com", status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() };
    const result = handleUsaText(caseRecord, "Sí");
    assert.equal(result.caseRecord.currentFieldId, "workflow.passport_uploaded");
    assert.equal(result.caseRecord.answers["contact.email"]?.value, "ana@example.com");
  });

  it("asks only for the social networks the client selected", () => {
    let caseRecord = advanceTo(startUsaIntake(newUsaCase("usa-social", "+14165550123")).caseRecord, "social.has_social_media");
    caseRecord = handleUsaText(caseRecord, "Sí").caseRecord;
    assert.equal(caseRecord.currentFieldId, "social.platforms");
    caseRecord = handleUsaText(caseRecord, "Facebook, Instagram").caseRecord;
    caseRecord = handleUsaText(caseRecord, "Ana Pérez").caseRecord;
    assert.equal(caseRecord.currentFieldId, "social.facebook");
    caseRecord = handleUsaText(caseRecord, "ana.fb").caseRecord;
    assert.equal(caseRecord.currentFieldId, "social.instagram");
    assert.equal(usaCatalogFor(caseRecord.answers).some((field) => field.id === "social.twitter"), false);
  });

  it("skips employment details when there is no work and uses month-year for prior work", () => {
    let noWork = advanceTo(startUsaIntake(newUsaCase("usa-work-no", "+14165550123")).caseRecord, "employment.has_current_or_previous");
    noWork = handleUsaText(noWork, "No").caseRecord;
    assert.equal(noWork.currentFieldId, "education.level");

    let priorWork = advanceTo(startUsaIntake(newUsaCase("usa-work-yes", "+14165550123")).caseRecord, "employment.has_current_or_previous");
    priorWork = handleUsaText(priorWork, "Sí").caseRecord;
    priorWork = handleUsaText(priorWork, "No").caseRecord;
    assert.equal(priorWork.currentFieldId, "employment.company");
    assert.equal(usaFieldById("employment.from", priorWork.answers)?.kind, "year_month");
    assert.ok(usaFieldById("employment.until", priorWork.answers));
  });

  it("respects the persisted current question instead of consuming an answer in an earlier gap", () => {
    const caseRecord = newUsaCase("usa-current", "+14165550123");
    caseRecord.status = "ACTIVE";
    caseRecord.currentFieldId = "visit.address";
    const result = handleUsaText(caseRecord, "1200 Brickell Avenue, Miami, Florida, 33131");
    assert.equal(result.caseRecord.answers["visit.address"]?.value, "1200 Brickell Avenue, Miami, Florida, 33131");
    assert.equal(result.caseRecord.answers["workflow.passport_uploaded"], undefined);
  });

  it("marks a skipped passport pending, completes the normal pass and reopens it", () => {
    let caseRecord = startUsaIntake(newUsaCase("usa-pending", "+14165550123")).caseRecord;
    caseRecord = handleUsaText(caseRecord, "SALTAR").caseRecord;
    assert.equal(caseRecord.answers["workflow.passport_uploaded"]?.status, "PENDING");
    assert.equal(caseRecord.currentFieldId, "identity.full_name");
    caseRecord = completeActivePass(caseRecord);
    assert.equal(caseRecord.status, "WAITING_FOR_CLIENT");
    const resumed = handleUsaText(caseRecord, "CONTINUAR");
    assert.equal(resumed.caseRecord.status, "ACTIVE");
    assert.equal(resumed.caseRecord.currentFieldId, "workflow.passport_uploaded");
  });

  it("reports progress, pending fields and contextual help without moving the current question", () => {
    let caseRecord = startUsaIntake(newUsaCase("usa-progress", "+14165550125")).caseRecord;
    caseRecord = handleUsaDocument(caseRecord, "passport").caseRecord;
    const summary = handleUsaText(caseRecord, "RESUMEN");
    assert.match(summary.outgoing[0]?.type === "text" ? summary.outgoing[0].body : "", /Avance de tu expediente USA/);
    assert.match(summary.outgoing[0]?.type === "text" ? summary.outgoing[0].body : "", /Documentos: 1\/1/);
    assert.equal(summary.caseRecord.currentFieldId, "identity.full_name");
    assert.match(handleUsaText(caseRecord, "PENDIENTES").outgoing[0]?.type === "text" ? (handleUsaText(caseRecord, "PENDIENTES").outgoing[0] as { type: "text"; body: string }).body : "", /Datos pendientes/);
    assert.match(handleUsaText(caseRecord, "AYUDA").outgoing[0]?.type === "text" ? (handleUsaText(caseRecord, "AYUDA").outgoing[0] as { type: "text"; body: string }).body : "", /SALTAR/);
  });

  it("offers the USA lodging address for the relative and accepts MISMA", () => {
    const caseRecord = newUsaCase("usa-5", "+14378781645");
    const lodging = "1200 Brickell Avenue, Miami, Florida, 33131";
    caseRecord.answers["visit.address"] = { fieldId: "visit.address", value: lodging, status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() };
    caseRecord.answers["relative.has_us_citizen"] = { fieldId: "relative.has_us_citizen", value: true, status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() };
    caseRecord.answers["relative.full_name"] = { fieldId: "relative.full_name", value: "Juan Pérez", status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() };
    const field = usaFieldById("relative.address", caseRecord.answers);
    assert.match(field?.prompt ?? "", /Dirección de hospedaje en Estados Unidos/);
    assert.match(field?.prompt ?? "", /1200 Brickell Avenue/);
    const result = resolveAddressInput("relative.address", "MISMA", caseRecord.answers);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, lodging);
  });

  it("shows a fictitious US-format example when requesting the lodging address", () => {
    const field = usaFieldById("visit.address", newUsaCase().answers);
    assert.match(field?.prompt ?? "", /Ejemplo ficticio: 1450 Lakeview Avenue, Orlando, Florida, C\.P\. 32801/);
  });

  it("offers the destination phone for the relative and accepts MISMO", () => {
    let caseRecord = advanceTo(
      startUsaIntake(newUsaCase("usa-6", "+14378781645")).caseRecord,
      "relative.address",
      { "relative.has_us_citizen": "Sí", "visit.phone": "+1 305 555 0123" },
    );
    caseRecord = handleUsaText(caseRecord, "200 Ocean Drive, Miami, Florida, 33139").caseRecord;
    assert.equal(caseRecord.currentFieldId, "relative.phone");
    const question = handleUsaText(caseRecord, "RESUMEN").caseRecord;
    assert.equal(question.currentFieldId, "relative.phone");
    const currentPrompt = handleUsaText(caseRecord, "No es teléfono");
    assert.match(currentPrompt.outgoing[0]?.type === "text" ? currentPrompt.outgoing[0].body : "", /teléfono válido/i);
    const phoneResult = handleUsaText(caseRecord, "MISMO");
    assert.equal(phoneResult.caseRecord.answers["relative.phone"]?.value, "+13055550123");
  });

  it("rejects impossible chronology and completes a consistent questionnaire", () => {
    let issueCase = advanceTo(startUsaIntake(newUsaCase("usa-date", "+14165550123")).caseRecord, "passport.issue_date");
    const rejected = handleUsaText(issueCase, "01/01/1980");
    assert.equal(rejected.caseRecord.currentFieldId, "passport.issue_date");
    assert.equal(rejected.caseRecord.answers["passport.issue_date"], undefined);
    assert.match(rejected.outgoing[0]?.type === "text" ? rejected.outgoing[0].body : "", /posterior a tu fecha de nacimiento/);

    let complete = advanceTo(startUsaIntake(newUsaCase("usa-complete", "+14165550123")).caseRecord, "workflow.correction_notes");
    const finished = handleUsaText(complete, "TODO CORRECTO");
    complete = finished.caseRecord;
    assert.equal(complete.status, "READY_FOR_REVIEW");
    const finalBody = finished.outgoing[0]?.type === "text" ? finished.outgoing[0].body : "";
    assert.match(finalBody, /📧 ana@example\.com/);
    assert.doesNotMatch(finalBody, /\*ana@example\.com\*/);
    const closing = handleUsaText(complete, "otro mensaje");
    assert.equal(closing.outgoing.length, 0);
    assert.equal(complete.answers["contact.email"]?.value, "ana@example.com");
  });
});
