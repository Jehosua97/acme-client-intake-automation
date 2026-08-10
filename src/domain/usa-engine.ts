import { randomUUID } from "node:crypto";
import type { Answer, AnswerSource, CaseRecord, EngineResult, FieldDefinition, OutgoingMessage, Progress } from "./types.js";
import { validateAnswer } from "./validation.js";
import { CURRENT_USA_WORKFLOW_SCHEMA_VERSION, USA_WORKFLOW_SCHEMA_FIELD, usaCatalogFor, usaFieldById } from "./usa-catalog.js";
import { resolveAddressInput } from "./address.js";
import { unknownParentValue } from "./family.js";
import { usaCrossFieldIssues, usaImmediateConsistencyIssue } from "./usa-consistency.js";

const SKIP = new Set(["saltar", "no sé", "no se", "no tengo", "no aplica", "n/a", "pendiente"]);
const PAUSE = new Set(["alto", "pausa", "pausar", "detente", "para"]);
const NO_CORRECTIONS = /^(?:todo\s+correcto|todo\s+bien|sin\s+correcciones|ningun[oa]?|no)$/i;
const DOCUMENT_FIELDS = new Set(["workflow.passport_uploaded"]);
const now = () => new Date().toISOString();
const text = (body: string): OutgoingMessage => ({ type: "text", body });
const normalize = (value: string) => value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const USA_INTAKE_OVERVIEW = `🇺🇸 *Así será el proceso para tu visa de Estados Unidos*

Te haré una pregunta a la vez y guardaré tu avance automáticamente. El proceso está dividido en estos bloques:

1️⃣ *Pasaporte y datos personales*
2️⃣ *Contacto y redes sociales*
3️⃣ *Trabajo y educación*
4️⃣ *Información del viaje y familiares en Estados Unidos*
5️⃣ *Datos de tus padres y antecedentes de viaje*
6️⃣ *Revisión final*

Puedes completarlo en varios momentos. Si te falta algún dato, escribe *SALTAR* y quedará pendiente.

En cualquier momento puedes escribir *AYUDA*, *RESUMEN* o *PENDIENTES*.`;

export function newUsaCase(id: string = randomUUID(), phoneE164 = ""): CaseRecord {
  const timestamp = now();
  return {
    id, phoneE164, status: "DRAFT",
    answers: {
      [USA_WORKFLOW_SCHEMA_FIELD]: { fieldId: USA_WORKFLOW_SCHEMA_FIELD, value: CURRENT_USA_WORKFLOW_SCHEMA_VERSION, status: "CONFIRMED", source: "SYSTEM", confidence: 100, updatedAt: timestamp },
    },
    currentFieldId: null, consentVersion: null, invitedAt: null, consentedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
}

export function calculateUsaProgress(caseRecord: CaseRecord): Progress {
  const fields = usaCatalogFor(caseRecord.answers).filter((field) => field.required);
  const answers = fields.map((field) => caseRecord.answers[field.id]).filter((answer): answer is Answer => Boolean(answer));
  const confirmed = answers.filter((answer) => answer.status === "CONFIRMED").length;
  return {
    confirmed, required: fields.length,
    pending: answers.filter((answer) => answer.status === "PENDING").length,
    proposed: answers.filter((answer) => answer.status === "PROPOSED").length,
    conflicts: answers.filter((answer) => answer.status === "CONFLICT").length,
    percent: Math.round(confirmed / Math.max(fields.length, 1) * 100),
  };
}

const unresolved = (caseRecord: CaseRecord) => usaCatalogFor(caseRecord.answers).filter((field) => field.required && caseRecord.answers[field.id]?.status !== "CONFIRMED");
const nextMissing = (caseRecord: CaseRecord) => usaCatalogFor(caseRecord.answers).find((field) => !caseRecord.answers[field.id]);

function usaQuestion(caseRecord: CaseRecord, field: FieldDefinition): string {
  if (field.id === "contact.phone") {
    return `📱 *Teléfono de contacto*\n\nRegistramos que tu número de WhatsApp es:\n*${caseRecord.phoneE164}*\n\n¿Confirmas que este será tu teléfono principal? Responde *Sí* o escribe otro número con código de país.\n\n_Ejemplo: +52 55 1234 5678_`;
  }
  if (field.id === "relative.phone") {
    const destinationPhone = caseRecord.answers["visit.phone"];
    const reference = destinationPhone?.status === "CONFIRMED" && typeof destinationPhone.value === "string" ? destinationPhone.value : "pendiente";
    return `${field.prompt}\n\n*Teléfono del hotel, domicilio o contacto en tu destino:*\n${reference}\n\nSi es el mismo, responde *SÍ* o escribe *MISMO*. Si no, escribe el teléfono de tu familiar con código de país.`;
  }
  return field.prompt;
}

function setAnswer(caseRecord: CaseRecord, fieldId: string, value: Answer["value"], status: Answer["status"] = "CONFIRMED", source: AnswerSource = "CHAT") {
  caseRecord.answers[fieldId] = { fieldId, value, status, source, confidence: 100, updatedAt: now() };
}

function usaSummary(caseRecord: CaseRecord): string {
  const progress = calculateUsaProgress(caseRecord);
  const sections = new Map<string, { done: number; total: number }>();
  for (const field of usaCatalogFor(caseRecord.answers).filter((item) => item.required)) {
    const current = sections.get(field.section) ?? { done: 0, total: 0 };
    current.total += 1;
    if (caseRecord.answers[field.id]?.status === "CONFIRMED") current.done += 1;
    sections.set(field.section, current);
  }
  return `🇺🇸 *Avance de tu expediente USA: ${progress.percent}%* (${progress.confirmed} de ${progress.required})\n\n${[...sections].map(([section, value]) => `• ${section}: ${value.done}/${value.total}`).join("\n")}`;
}

function usaPendingSummary(caseRecord: CaseRecord): string {
  const pending = unresolved(caseRecord);
  if (!pending.length) return "✅ No tienes datos pendientes en tu expediente USA.";
  return `🇺🇸 *Datos pendientes (${pending.length})*\n\n${pending.slice(0, 15).map((field) => `• ${field.label}`).join("\n")}${pending.length > 15 ? "\n• …" : ""}`;
}

function finalUsaMessage(caseRecord: CaseRecord, review: string): OutgoingMessage[] {
  const correction = String(caseRecord.answers["workflow.correction_notes"]?.value ?? "");
  const title = correction && correction !== "SIN CORRECCIONES" ? "✅ *Gracias. Registramos tu corrección.*" : "✅ *Eso es todo. Muchas gracias.*";
  const emailAnswer = caseRecord.answers["contact.email"];
  const email = emailAnswer?.status === "CONFIRMED" && typeof emailAnswer.value === "string" ? emailAnswer.value : null;
  const emailMessage = email ? `El correo confirmado para tu expediente es:\n📧 ${email}` : "Nuestro equipo confirmará contigo un correo de contacto.";
  return [text(`${title}\n\n${review}\n\n${emailMessage}\n\nTu captura USA quedó cerrada y nuestro equipo revisará la información.`)];
}

function advance(caseRecord: CaseRecord): OutgoingMessage[] {
  const field = nextMissing(caseRecord);
  caseRecord.updatedAt = now();
  if (field) {
    caseRecord.status = "ACTIVE";
    caseRecord.currentFieldId = field.id;
    return [text(usaQuestion(caseRecord, field))];
  }
  caseRecord.currentFieldId = null;
  const pending = unresolved(caseRecord);
  if (pending.length) {
    caseRecord.status = "WAITING_FOR_CLIENT";
    return [text(`${usaSummary(caseRecord)}\n\nTerminamos todo lo disponible por ahora.\n\n${usaPendingSummary(caseRecord)}\n\nCuando tengas un dato pendiente, escribe *CONTINUAR*.`)];
  }
  const issues = usaCrossFieldIssues(caseRecord.answers);
  if (issues.length) {
    caseRecord.status = "NEEDS_STAFF_REVIEW";
    return finalUsaMessage(caseRecord, `Nuestro equipo revisará ${issues.length} posible(s) inconsistencia(s) antes de continuar.`);
  }
  caseRecord.status = "READY_FOR_REVIEW";
  return finalUsaMessage(caseRecord, "Terminamos todas las preguntas. Nuestro equipo revisará tu información antes de continuar.");
}

export function startUsaIntake(caseRecord: CaseRecord): EngineResult {
  caseRecord.status = "ACTIVE";
  caseRecord.invitedAt ||= now();
  caseRecord.updatedAt = now();
  return { caseRecord, outgoing: [text(USA_INTAKE_OVERVIEW), ...advance(caseRecord)], auditEvents: [{ event: "USA_INTAKE_STARTED", detail: { schemaVersion: caseRecord.answers[USA_WORKFLOW_SCHEMA_FIELD]?.value ?? 1 } }] };
}

export function stopUsaIntake(caseRecord: CaseRecord): EngineResult {
  caseRecord.status = "STOPPED_BY_ADMIN";
  caseRecord.updatedAt = now();
  return { caseRecord, outgoing: [], auditEvents: [{ event: "USA_INTAKE_STOPPED_BY_ADMIN", detail: {} }] };
}

export function resumeUsaIntake(caseRecord: CaseRecord): EngineResult {
  caseRecord.status = "ACTIVE";
  caseRecord.updatedAt = now();
  return { caseRecord, outgoing: advance(caseRecord), auditEvents: [{ event: "USA_INTAKE_RESUMED", detail: {} }] };
}

export function handleUsaDocument(caseRecord: CaseRecord, driveFileId: string): EngineResult {
  const current = caseRecord.currentFieldId ? usaFieldById(caseRecord.currentFieldId, caseRecord.answers) : nextMissing(caseRecord);
  if (!current || !DOCUMENT_FIELDS.has(current.id)) return { caseRecord, outgoing: [text("El archivo quedó guardado en tu carpeta, pero en este momento esperaba una respuesta de texto.")], auditEvents: [] };
  setAnswer(caseRecord, current.id, driveFileId, "CONFIRMED", "DOCUMENT");
  return { caseRecord, outgoing: advance(caseRecord), auditEvents: [{ event: "USA_DOCUMENT_RECORDED", detail: { fieldId: current.id, driveFileId } }] };
}

function normalizeCountries(raw: string): string | null {
  const seen = new Set<string>();
  const countries = raw.split(",").map((item) => item.trim()).filter((item) => /[\p{L}]/u.test(item)).filter((item) => {
    const key = normalize(item);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return countries.length ? countries.join(", ") : null;
}

export function handleUsaText(caseRecord: CaseRecord, raw: string): EngineResult {
  const input = raw.trim();
  const command = normalize(input);
  const auditEvents: EngineResult["auditEvents"] = [];

  if (command === "borrar mis datos") {
    caseRecord.status = "DELETION_REQUESTED"; caseRecord.currentFieldId = null;
    return { caseRecord, outgoing: [text("Registramos tu solicitud de eliminación para revisión del equipo.")], auditEvents: [{ event: "USA_DELETION_REQUESTED", detail: {} }] };
  }
  if (command === "resumen") return { caseRecord, outgoing: [text(usaSummary(caseRecord))], auditEvents: [{ event: "USA_SUMMARY_REQUESTED", detail: {} }] };
  if (command === "pendientes") return { caseRecord, outgoing: [text(usaPendingSummary(caseRecord))], auditEvents: [{ event: "USA_PENDING_REQUESTED", detail: {} }] };
  if (command === "ayuda") return { caseRecord, outgoing: [text("Responde con tus propias palabras. Si te falta un dato, escribe SALTAR. También puedes usar RESUMEN, PENDIENTES, PAUSAR y CONTINUAR.")], auditEvents };
  if (PAUSE.has(command) && ["ACTIVE", "WAITING_FOR_CLIENT"].includes(caseRecord.status)) {
    caseRecord.status = "PAUSED";
    return { caseRecord, outgoing: [text("Claro, pausamos aquí. Tu avance quedó guardado y no se perderá aunque regreses otro día.")], auditEvents: [{ event: "USA_INTAKE_PAUSED", detail: { command: command.toUpperCase() } }] };
  }
  if (command === "continuar" && ["PAUSED", "WAITING_FOR_CLIENT", "ACTIVE"].includes(caseRecord.status)) {
    caseRecord.status = "ACTIVE";
    const pending = unresolved(caseRecord).find((field) => caseRecord.answers[field.id]?.status === "PENDING");
    if (pending && !nextMissing(caseRecord)) delete caseRecord.answers[pending.id];
    return { caseRecord, outgoing: advance(caseRecord), auditEvents: [{ event: "USA_INTAKE_RESUMED", detail: { pendingFieldId: pending?.id ?? null } }] };
  }
  if (caseRecord.status === "WAITING_FOR_CLIENT") {
    caseRecord.status = "ACTIVE";
    const pending = unresolved(caseRecord).find((field) => caseRecord.answers[field.id]?.status === "PENDING");
    if (pending) delete caseRecord.answers[pending.id];
    return { caseRecord, outgoing: advance(caseRecord), auditEvents: [{ event: "USA_INTAKE_RESUMED", detail: { natural: true, pendingFieldId: pending?.id ?? null } }] };
  }
  if (caseRecord.status === "PAUSED") {
    caseRecord.status = "ACTIVE";
    auditEvents.push({ event: "USA_INTAKE_RESUMED", detail: { natural: true } });
    if (/^(?:hola|buen(?:os|as)?\s+(?:dias|tardes|noches)|que\s+tal)$/i.test(command)) {
      const current = caseRecord.currentFieldId ? usaFieldById(caseRecord.currentFieldId, caseRecord.answers) : undefined;
      return { caseRecord, outgoing: current ? [text(usaQuestion(caseRecord, current))] : advance(caseRecord), auditEvents };
    }
  }
  if (caseRecord.status !== "ACTIVE") return { caseRecord, outgoing: [], auditEvents };

  // Expedientes que estaban exactamente en la confirmación retirada avanzan a
  // la siguiente pregunta sin volver a validar el correo ya almacenado.
  if (caseRecord.currentFieldId === "contact.email_confirmed") {
    delete caseRecord.answers["contact.email_confirmed"];
    caseRecord.currentFieldId = null;
    return { caseRecord, outgoing: advance(caseRecord), auditEvents: [{ event: "USA_REMOVED_EMAIL_CONFIRMATION_SKIPPED", detail: {} }] };
  }

  const current = caseRecord.currentFieldId ? usaFieldById(caseRecord.currentFieldId, caseRecord.answers) : undefined;
  if (!current) return { caseRecord, outgoing: advance(caseRecord), auditEvents };

  const unknownParent = unknownParentValue(current.id, input);
  const deceasedParent = /^(?:fallecid[oa]|finad[oa]|difunt[oa]|muert[oa]|murio)(?:\s+.*)?$/.test(command);
  if (SKIP.has(command) && !unknownParent) {
    setAnswer(caseRecord, current.id, null, "PENDING");
    auditEvents.push({ event: "USA_ANSWER_SKIPPED", detail: { fieldId: current.id } });
    return { caseRecord, outgoing: advance(caseRecord), auditEvents };
  }
  if (DOCUMENT_FIELDS.has(current.id)) return { caseRecord, outgoing: [text("Para guardarlo necesito que lo envíes como foto o documento. Si no lo tienes ahora, escribe SALTAR.")], auditEvents };

  if (current.id === "workflow.correction_notes" && NO_CORRECTIONS.test(input)) {
    setAnswer(caseRecord, current.id, "SIN CORRECCIONES");
    auditEvents.push({ event: "USA_INTAKE_CLOSED", detail: { correctionReported: false } });
    return { caseRecord, outgoing: advance(caseRecord), auditEvents };
  }
  if (unknownParent || deceasedParent && ["mother.full_name", "father.full_name"].includes(current.id)) {
    setAnswer(caseRecord, current.id, unknownParent ?? (current.id.startsWith("mother") ? "FALLECIDA" : "FALLECIDO"));
    auditEvents.push({ event: "USA_ANSWER_RECORDED", detail: { fieldId: current.id, specialCondition: unknownParent ? "UNKNOWN" : "DECEASED" } });
    return { caseRecord, outgoing: advance(caseRecord), auditEvents };
  }

  const addressResolution = resolveAddressInput(current.id, input, caseRecord.answers);
  if (!addressResolution.ok) return { caseRecord, outgoing: [text(addressResolution.message)], auditEvents };
  let resolvedRaw = addressResolution.value;
  if (current.id === "contact.phone") {
    if (["si", "s", "yes"].includes(command)) resolvedRaw = caseRecord.phoneE164;
    else if (["no", "n"].includes(command)) return { caseRecord, outgoing: [text("De acuerdo. Escribe el otro número que deseas usar, incluyendo el código de país.")], auditEvents };
  }
  if (current.id === "relative.phone" && ["si", "s", "yes", "mismo", "misma", "igual"].includes(command)) {
    const destinationPhone = caseRecord.answers["visit.phone"];
    if (destinationPhone?.status !== "CONFIRMED" || typeof destinationPhone.value !== "string") return { caseRecord, outgoing: [text("Primero necesito el teléfono de tu destino. Escribe el teléfono completo con código de país.")], auditEvents };
    resolvedRaw = destinationPhone.value;
  }
  if (current.id === "travel.countries") {
    const countries = normalizeCountries(resolvedRaw);
    if (!countries) return { caseRecord, outgoing: [text("Escribe al menos un país. Si son varios, sepáralos por comas.")], auditEvents };
    resolvedRaw = countries;
  }

  const validation = validateAnswer(current, resolvedRaw);
  if (!validation.ok) return { caseRecord, outgoing: [text(validation.message)], auditEvents };
  const consistencyIssue = usaImmediateConsistencyIssue(current.id, validation.value, caseRecord.answers);
  if (consistencyIssue) return { caseRecord, outgoing: [text(consistencyIssue)], auditEvents };
  setAnswer(caseRecord, current.id, validation.value);
  auditEvents.push({ event: "USA_ANSWER_RECORDED", detail: { fieldId: current.id, copiedFromReference: addressResolution.copiedFromApplicant } });
  if (current.id === "workflow.correction_notes") auditEvents.push({ event: "USA_INTAKE_CLOSED", detail: { correctionReported: true } });
  return { caseRecord, outgoing: advance(caseRecord), auditEvents };
}
