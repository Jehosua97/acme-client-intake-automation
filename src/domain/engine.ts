import { catalogFor, fieldById } from "./catalog.js";
import type { Answer, CaseRecord, EngineResult, FieldDefinition, OutgoingMessage, Progress } from "./types.js";
import { validateAnswer } from "./validation.js";
import { crossFieldIssues } from "./consistency.js";
import { resolveAddressInput } from "./address.js";
import { unknownParentValue } from "./family.js";

const SKIP = new Set(["saltar", "no sé", "no se", "no tengo", "no aplica", "n/a", "pendiente", "después", "despues"]);
const PAUSE_COMMANDS = new Set(["alto", "pausa", "pausar", "detente", "para"]);
const INTAKE_OVERVIEW = `👋 *Así será el proceso*

Normalmente toma entre 30 y 45 minutos en total y está dividido en 5 bloques:

1️⃣ *Datos personales, residencia y contacto*
Varios datos se tomarán directamente de tu pasaporte.

2️⃣ *Familia*
Las preguntas se adaptan según tu pareja, hijos y los datos que conozcas de tus padres.

3️⃣ *Idiomas*

4️⃣ *Estudios y actividades de los últimos 10 años*
Las actividades se registran una por una. Asegúrate de que no haya huecos de tiempo vacíos durante esos 10 años.

5️⃣ *Viaje a Canadá e historial de viajes*

*Puedes hacerlo en varios días.* Todo tu avance queda guardado después de cada respuesta. Para detener las preguntas escribe *ALTO*, *PAUSA*, *DETENTE* o *PARA*. Cuando quieras regresar, escribe *CONTINUAR* o simplemente responde la pregunta que quedó pendiente.

Si te falta algún dato, escribe *SALTAR*.`;
const MEXICO_PROFILE_DEFAULTS: ReadonlyArray<readonly [string, Answer["value"]]> = [
  ["identity.birth_country", "México"],
  ["identity.citizenship", "México"],
  ["residence.current_country", "México"],
  ["residence.current_status", "Ciudadano/a"],
  ["residence.applying_from_current", true],
  ["contact.mailing_country", "México"],
  ["contact.residential_country", "México"],
  ["contact.phone_type", "Celular"],
  ["language.mother_tongue", "Español"],
  ["language.preferred", "Inglés"],
  ["education.country", "México"],
];
const PASSPORT_MANUAL_REVIEW_FIELDS = [
  "identity.birth_date",
  "identity.birth_city",
  "identity.birth_country",
  "identity.citizenship",
  "passport.issuing_country",
  "passport.issue_date",
  "passport.expiry_date",
] as const;

const now = () => new Date().toISOString();
const text = (body: string): OutgoingMessage => ({ type: "text", body });

function applyMexicoProfileDefaults(caseRecord: CaseRecord): string[] {
  const applied: string[] = [];
  for (const [fieldId, value] of MEXICO_PROFILE_DEFAULTS) {
    if (caseRecord.answers[fieldId]) continue;
    setAnswer(caseRecord, fieldId, value, "CONFIRMED", "SYSTEM", 100);
    applied.push(fieldId);
  }
  for (const definition of catalogFor(caseRecord.answers)) {
    const match = definition.id.match(/^employment\.(\d+)\.from$/);
    if (!match) continue;
    const fieldId = `employment.${match[1]}.country`;
    if (caseRecord.answers[fieldId]) continue;
    setAnswer(caseRecord, fieldId, "México", "CONFIRMED", "SYSTEM", 100);
    applied.push(fieldId);
  }
  return applied;
}

export function newCase(id: string, phoneE164: string): CaseRecord {
  const timestamp = now();
  return {
    id,
    phoneE164,
    status: "DRAFT",
    answers: {},
    currentFieldId: null,
    consentVersion: null,
    invitedAt: null,
    consentedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function setAnswer(
  caseRecord: CaseRecord,
  fieldId: string,
  value: Answer["value"],
  status: Answer["status"],
  source: Answer["source"],
  confidence?: number,
): void {
  caseRecord.answers[fieldId] = {
    fieldId,
    value,
    status,
    source,
    ...(confidence === undefined ? {} : { confidence }),
    updatedAt: now(),
  };
}

export function calculateProgress(caseRecord: CaseRecord): Progress {
  const applicable = catalogFor(caseRecord.answers).filter((field) => field.required);
  const requiredIds = new Set(applicable.map((field) => field.id));
  const values = Object.values(caseRecord.answers).filter((answer) => requiredIds.has(answer.fieldId));
  const confirmed = values.filter((answer) => answer.status === "CONFIRMED").length;
  return {
    confirmed,
    required: applicable.length,
    pending: values.filter((answer) => answer.status === "PENDING").length,
    proposed: values.filter((answer) => answer.status === "PROPOSED").length,
    conflicts: values.filter((answer) => answer.status === "CONFLICT").length,
    percent: Math.round((confirmed / Math.max(applicable.length, 1)) * 100),
  };
}

function clientApplicableFields(caseRecord: CaseRecord): FieldDefinition[] {
  return catalogFor(caseRecord.answers).filter((field) => {
    if (!field.required) return false;
    const answer = caseRecord.answers[field.id];
    return !(answer?.status === "PENDING" && answer.source === "DOCUMENT");
  });
}

export function calculateClientProgress(caseRecord: CaseRecord): Progress {
  const applicable = clientApplicableFields(caseRecord);
  const requiredIds = new Set(applicable.map((field) => field.id));
  const values = Object.values(caseRecord.answers).filter((answer) => requiredIds.has(answer.fieldId));
  const confirmed = values.filter((answer) => answer.status === "CONFIRMED").length;
  return {
    confirmed,
    required: applicable.length,
    pending: values.filter((answer) => answer.status === "PENDING").length,
    proposed: values.filter((answer) => answer.status === "PROPOSED").length,
    conflicts: values.filter((answer) => answer.status === "CONFLICT").length,
    percent: Math.round((confirmed / Math.max(applicable.length, 1)) * 100),
  };
}

function unresolved(caseRecord: CaseRecord): FieldDefinition[] {
  return catalogFor(caseRecord.answers).filter((field) => field.required && caseRecord.answers[field.id]?.status !== "CONFIRMED");
}

function summary(caseRecord: CaseRecord): string {
  const progress = calculateClientProgress(caseRecord);
  const sections = new Map<string, { done: number; total: number }>();
  for (const field of clientApplicableFields(caseRecord)) {
    const current = sections.get(field.section) ?? { done: 0, total: 0 };
    current.total += 1;
    if (caseRecord.answers[field.id]?.status === "CONFIRMED") current.done += 1;
    sections.set(field.section, current);
  }
  const lines = [...sections].map(([section, value]) => `• ${section}: ${value.done}/${value.total}`);
  return `*Avance de tus preguntas: ${progress.percent}%* (${progress.confirmed} de ${progress.required})\n${lines.join("\n")}`;
}

function pendingSummary(caseRecord: CaseRecord): string {
  const fields = unresolved(caseRecord).filter((field) => {
    const answer = caseRecord.answers[field.id];
    return answer?.status === "CONFLICT" || (answer?.status === "PENDING" && answer.source !== "DOCUMENT");
  });
  if (!fields.length) return "No tienes datos marcados como pendientes.";
  return `Pendientes (${fields.length}):\n${fields.slice(0, 12).map((field) => `• ${field.label}`).join("\n")}${fields.length > 12 ? "\n• …" : ""}`;
}

function nextMissing(caseRecord: CaseRecord): FieldDefinition | undefined {
  return catalogFor(caseRecord.answers).find((field) => !caseRecord.answers[field.id]);
}

function proposedFields(caseRecord: CaseRecord): FieldDefinition[] {
  return catalogFor(caseRecord.answers).filter((field) => caseRecord.answers[field.id]?.status === "PROPOSED");
}

function presentValue(value: Answer["value"]): string {
  if (value === true) return "Sí";
  if (value === false) return "No";
  return String(value ?? "");
}

function advance(caseRecord: CaseRecord): OutgoingMessage[] {
  const proposed = proposedFields(caseRecord);
  if (proposed.length) {
    caseRecord.currentFieldId = "__proposal_batch__";
    const values = proposed.slice(0, 12).map((field) => `• ${field.label}: ${presentValue(caseRecord.answers[field.id]?.value ?? null)}`);
    return [text(`Aproveché estos datos del documento o mensaje:\n${values.join("\n")}${proposed.length > 12 ? "\n• …" : ""}\n\n¿Todo está correcto? Responde Sí o No.`)];
  }
  const missing = nextMissing(caseRecord);
  if (missing) {
    caseRecord.currentFieldId = missing.id;
    return [text(missing.prompt)];
  }
  const progress = calculateProgress(caseRecord);
  caseRecord.currentFieldId = null;
  if (progress.conflicts > 0) {
    caseRecord.status = "NEEDS_STAFF_REVIEW";
    return [text("✅ *Tus preguntas están completas: 100%*\n\nEncontramos datos que nuestro equipo debe revisar internamente. Conservamos todo tu avance y te contactaremos si necesitamos aclarar algo.\n\nNo necesitas responder nada más en este momento.")];
  }
  if (progress.pending > 0) {
    const hasClientPending = unresolved(caseRecord).some((field) => {
      const answer = caseRecord.answers[field.id];
      return answer?.status === "PENDING" && answer.source !== "DOCUMENT";
    });
    if (!hasClientPending) {
      caseRecord.status = "NEEDS_STAFF_REVIEW";
      return [text(`✅ *Tus preguntas están completas: 100%*\n\nTerminamos todo lo que necesitábamos preguntarte por ahora. Nuestro equipo completará internamente los datos visibles en tu pasaporte y revisará el expediente.\n\nNo necesitas responder nada más en este momento.`)];
    }
    caseRecord.status = "WAITING_FOR_CLIENT";
    return [text(`${summary(caseRecord)}\n\nTerminamos todo lo disponible por ahora. ${pendingSummary(caseRecord)}\nCuando tengas alguno, escribe CONTINUAR. No te lo volveré a preguntar inmediatamente.`)];
  }
  const issues = crossFieldIssues(caseRecord.answers);
  if (issues.length) {
    caseRecord.status = "NEEDS_STAFF_REVIEW";
    return [text(`✅ *Tus preguntas están completas: 100%*\n\nDetectamos ${issues.length} posible(s) inconsistencia(s) que nuestro equipo revisará internamente:\n${issues.slice(0, 5).map((issue) => `• ${issue}`).join("\n")}\n\nNo necesitas responder nada más en este momento.`)];
  }
  caseRecord.status = "READY_FOR_REVIEW";
  return [text(`✅ *Tus preguntas están completas: 100%*\n\n¡Terminamos esta etapa! Nuestro equipo revisará la información antes de usarla.\n\nNo necesitas responder nada más en este momento.`)];
}

export function invite(caseRecord: CaseRecord, templateName: string, language: string): EngineResult {
  caseRecord.status = "INVITED";
  caseRecord.invitedAt = now();
  caseRecord.updatedAt = now();
  return {
    caseRecord,
    outgoing: [{ type: "template", name: templateName, language }],
    auditEvents: [{ event: "CASE_INVITED", detail: {} }],
  };
}

export function startIntake(caseRecord: CaseRecord): EngineResult {
  caseRecord.status = "ACTIVE";
  caseRecord.consentVersion = null;
  caseRecord.consentedAt = null;
  const defaultedFields = applyMexicoProfileDefaults(caseRecord);
  caseRecord.updatedAt = now();
  return {
    caseRecord,
    outgoing: [text(INTAKE_OVERVIEW), ...advance(caseRecord)],
    auditEvents: [
      { event: "PREAUTHORIZED_INTAKE_STARTED", detail: {} },
      { event: "MEXICO_PROFILE_DEFAULTS_APPLIED", detail: { fields: defaultedFields } },
    ],
  };
}

export function applyProposals(
  caseRecord: CaseRecord,
  proposals: Array<{ fieldId: string; value: string | number | boolean; confidence: number }>,
  source: "DOCUMENT" | "CHAT" = "DOCUMENT",
): EngineResult {
  const auditEvents: EngineResult["auditEvents"] = [];
  for (const proposal of proposals) {
    const definition = fieldById(proposal.fieldId, caseRecord.answers);
    if (!definition) continue;
    const current = caseRecord.answers[proposal.fieldId];
    if (current?.status === "CONFIRMED" && current.value !== proposal.value) {
      setAnswer(caseRecord, proposal.fieldId, current.value, "CONFLICT", current.source, current.confidence);
      auditEvents.push({
        event: "ANSWER_CONFLICT",
        detail: { fieldId: proposal.fieldId, source, confirmedValue: current.value, proposedValue: proposal.value, proposedConfidence: proposal.confidence },
      });
      continue;
    }
    if (!current || current.status !== "CONFIRMED") {
      setAnswer(caseRecord, proposal.fieldId, proposal.value, "PROPOSED", source, proposal.confidence);
      auditEvents.push({ event: "ANSWER_PROPOSED", detail: { fieldId: proposal.fieldId, source, confidence: proposal.confidence } });
    }
  }
  caseRecord.updatedAt = now();
  return { caseRecord, outgoing: caseRecord.status === "ACTIVE" ? advance(caseRecord) : [], auditEvents };
}

export function handlePassportDocument(
  caseRecord: CaseRecord,
  documentId: string,
  proposals: Array<{ fieldId: string; value: string | number | boolean; confidence: number }>,
): EngineResult {
  const defaultedFields = applyMexicoProfileDefaults(caseRecord);
  setAnswer(caseRecord, "workflow.passport_uploaded", documentId, "CONFIRMED", "DOCUMENT", 100);
  // Phase one deliberately has no OCR/AI. Passport facts remain pending for
  // staff review, but the client's complete name is requested in chat so the
  // dashboard can identify the case immediately.
  for (const fieldId of PASSPORT_MANUAL_REVIEW_FIELDS) {
    if (!caseRecord.answers[fieldId]) setAnswer(caseRecord, fieldId, null, "PENDING", "DOCUMENT");
  }
  const result = applyProposals(caseRecord, proposals, "DOCUMENT");
  if (defaultedFields.length) result.auditEvents.unshift({ event: "MEXICO_PROFILE_DEFAULTS_APPLIED", detail: { fields: defaultedFields } });
  result.auditEvents.unshift({ event: "PASSPORT_RECEIVED", detail: { documentId, proposals: proposals.length } });
  return result;
}

export function handleClientText(caseRecord: CaseRecord, raw: string): EngineResult {
  const input = raw.trim();
  const command = input.toLocaleLowerCase("es");
  const auditEvents: EngineResult["auditEvents"] = [];

  if (command === "borrar mis datos") {
    caseRecord.status = "DELETION_REQUESTED";
    caseRecord.currentFieldId = null;
    return { caseRecord, outgoing: [text("Registré tu solicitud de eliminación. El equipo verificará tu identidad y completará el proceso según la política aplicable.")], auditEvents: [{ event: "DELETION_REQUESTED", detail: {} }] };
  }

  if (["INVITED", "AWAITING_CONSENT"].includes(caseRecord.status)) return startIntake(caseRecord);

  const defaultedFields = applyMexicoProfileDefaults(caseRecord);
  if (defaultedFields.length) auditEvents.push({ event: "MEXICO_PROFILE_DEFAULTS_APPLIED", detail: { fields: defaultedFields } });

  if (command === "resumen") return { caseRecord, outgoing: [text(summary(caseRecord))], auditEvents };
  if (command === "pendientes") return { caseRecord, outgoing: [text(pendingSummary(caseRecord))], auditEvents };
  if (command === "ayuda") return { caseRecord, outgoing: [text("Comandos disponibles: SALTAR; ALTO, PAUSA, PAUSAR, DETENTE o PARA; CONTINUAR; RESUMEN; PENDIENTES y BORRAR MIS DATOS.")], auditEvents };
  if (PAUSE_COMMANDS.has(command) && ["ACTIVE", "WAITING_FOR_CLIENT"].includes(caseRecord.status)) {
    caseRecord.status = "PAUSED";
    return { caseRecord, outgoing: [text("Pausamos aquí. Tu avance quedó guardado y no se perderá aunque regreses otro día. Escribe CONTINUAR cuando quieras retomar.")], auditEvents: [{ event: "CASE_PAUSED", detail: { command: command.toUpperCase() } }] };
  }
  if (command === "continuar" && ["PAUSED", "WAITING_FOR_CLIENT", "ACTIVE"].includes(caseRecord.status)) {
    caseRecord.status = "ACTIVE";
    // A pending field becomes eligible only by explicit CONTINUAR after the normal pass.
    const pending = unresolved(caseRecord).find((field) => {
      const answer = caseRecord.answers[field.id];
      return answer?.status === "PENDING" && answer.source !== "DOCUMENT";
    });
    if (pending && !nextMissing(caseRecord) && !proposedFields(caseRecord).length) {
      delete caseRecord.answers[pending.id];
    }
    return { caseRecord, outgoing: advance(caseRecord), auditEvents: [{ event: "CASE_RESUMED", detail: {} }] };
  }
  if (caseRecord.status !== "ACTIVE") return { caseRecord, outgoing: [], auditEvents };

  if (caseRecord.currentFieldId === "__proposal_batch__") {
    const confirmationField: FieldDefinition = { id: "confirmation", section: "", label: "", prompt: "", kind: "yes_no", required: true, order: 0, applies: () => true, forms: [] };
    const confirmation = validateAnswer(confirmationField, input);
    if (!confirmation.ok) return { caseRecord, outgoing: [text("Para confirmar el resumen, responde Sí o No.")], auditEvents };
    const proposals = proposedFields(caseRecord);
    if (confirmation.value === true) {
      for (const proposal of proposals) {
        const proposalAnswer = caseRecord.answers[proposal.id];
        if (proposalAnswer) setAnswer(caseRecord, proposal.id, proposalAnswer.value, "CONFIRMED", proposalAnswer.source, proposalAnswer.confidence);
      }
      auditEvents.push({ event: "PROPOSAL_BATCH_CONFIRMED", detail: { fields: proposals.map((field) => field.id) } });
      return { caseRecord, outgoing: advance(caseRecord), auditEvents };
    }
    const first = proposals[0];
    if (!first) return { caseRecord, outgoing: advance(caseRecord), auditEvents };
    delete caseRecord.answers[first.id];
    caseRecord.currentFieldId = first.id;
    auditEvents.push({ event: "PROPOSAL_BATCH_REJECTED", detail: { firstField: first.id } });
    return { caseRecord, outgoing: [text(`Vamos a corregirlos. ${first.prompt}`)], auditEvents };
  }

  const current = caseRecord.currentFieldId ? fieldById(caseRecord.currentFieldId, caseRecord.answers) : undefined;
  if (!current) return { caseRecord, outgoing: advance(caseRecord), auditEvents };
  const existing = caseRecord.answers[current.id];

  if (SKIP.has(command) && !unknownParentValue(current.id, input)) {
    setAnswer(caseRecord, current.id, null, "PENDING", "CHAT");
    auditEvents.push({ event: "ANSWER_SKIPPED", detail: { fieldId: current.id } });
    return { caseRecord, outgoing: advance(caseRecord), auditEvents };
  }

  if (current.id === "workflow.passport_uploaded") {
    return { caseRecord, outgoing: [text("Para leerlo necesito que lo envíes como foto o documento. Si no lo tienes ahora, escribe SALTAR.")], auditEvents };
  }

  const addressResolution = resolveAddressInput(current.id, input, caseRecord.answers);
  if (!addressResolution.ok) return { caseRecord, outgoing: [text(addressResolution.message)], auditEvents };
  const validation = validateAnswer(current, addressResolution.value);
  if (!validation.ok) return { caseRecord, outgoing: [text(validation.message)], auditEvents };
  setAnswer(caseRecord, current.id, validation.value, "CONFIRMED", "CHAT", 100);
  auditEvents.push({ event: "ANSWER_CONFIRMED", detail: { fieldId: current.id, source: "CHAT", copiedFromApplicantAddress: addressResolution.copiedFromApplicant } });
  caseRecord.updatedAt = now();
  return { caseRecord, outgoing: advance(caseRecord), auditEvents };
}
