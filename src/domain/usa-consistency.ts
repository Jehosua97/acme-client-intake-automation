import type { Answer } from "./types.js";

type Answers = Readonly<Record<string, Answer>>;
const textValue = (answers: Answers, id: string) => {
  const answer = answers[id];
  return answer?.status === "CONFIRMED" && typeof answer.value === "string" ? answer.value : null;
};
const today = (reference: Date) => reference.toISOString().slice(0, 10);
const currentMonth = (reference: Date) => reference.toISOString().slice(0, 7);

export function usaImmediateConsistencyIssue(fieldId: string, value: Answer["value"], answers: Answers, reference = new Date()): string | null {
  if (typeof value !== "string") return null;
  if (["identity.birth_date", "mother.birth_date", "father.birth_date", "passport.issue_date", "visa.previous_application_date"].includes(fieldId) && value > today(reference)) {
    return "La fecha no puede estar en el futuro.";
  }
  if (fieldId === "passport.issue_date") {
    const birth = textValue(answers, "identity.birth_date");
    if (birth && value <= birth) return "La emisión del pasaporte debe ser posterior a tu fecha de nacimiento.";
    const expiry = textValue(answers, "passport.expiry_date");
    if (expiry && value >= expiry) return "La emisión del pasaporte debe ser anterior a su vencimiento.";
  }
  if (fieldId === "passport.expiry_date") {
    const issue = textValue(answers, "passport.issue_date");
    if (issue && value <= issue) return "El vencimiento del pasaporte debe ser posterior a su emisión.";
  }
  if (["mother.birth_date", "father.birth_date"].includes(fieldId)) {
    const applicantBirth = textValue(answers, "identity.birth_date");
    if (applicantBirth && value >= applicantBirth) return "La fecha de nacimiento del padre o madre debe ser anterior a la del solicitante.";
  }
  if (fieldId === "visa.previous_application_date") {
    const birth = textValue(answers, "identity.birth_date");
    if (birth && value <= birth) return "La solicitud anterior debe ser posterior a tu fecha de nacimiento.";
  }
  if (["education.from", "employment.from"].includes(fieldId) && value > currentMonth(reference)) {
    return "La fecha de inicio no puede estar en el futuro. Usa MM/AAAA.";
  }
  if (fieldId === "education.from") {
    const until = textValue(answers, "education.until");
    if (until && until !== "CURRENT" && value > until) return "El inicio de estudios debe ser anterior al término.";
  }
  if (fieldId === "education.until") {
    const from = textValue(answers, "education.from");
    if (value !== "CURRENT" && from && value < from) return "El término de estudios debe ser posterior al inicio.";
  }
  if (fieldId === "employment.from") {
    const until = textValue(answers, "employment.until");
    if (until && value > until) return "El inicio del trabajo debe ser anterior al término.";
  }
  if (fieldId === "employment.until") {
    if (value === "CURRENT") return "Como indicaste que es un trabajo anterior, escribe el mes y año en que terminó usando MM/AAAA.";
    const from = textValue(answers, "employment.from");
    if (from && value < from) return "El término del trabajo debe ser posterior al inicio.";
    if (value > currentMonth(reference)) return "La fecha de término no puede estar en el futuro.";
  }
  return null;
}

export function usaCrossFieldIssues(answers: Answers): string[] {
  const issues: string[] = [];
  const birth = textValue(answers, "identity.birth_date");
  const issue = textValue(answers, "passport.issue_date");
  const expiry = textValue(answers, "passport.expiry_date");
  if (birth && issue && birth >= issue) issues.push("La emisión del pasaporte debe ser posterior al nacimiento.");
  if (issue && expiry && issue >= expiry) issues.push("El vencimiento del pasaporte debe ser posterior a su emisión.");
  const educationFrom = textValue(answers, "education.from");
  const educationUntil = textValue(answers, "education.until");
  if (educationFrom && educationUntil && educationUntil !== "CURRENT" && educationFrom > educationUntil) issues.push("Las fechas de estudios están invertidas.");
  const employmentFrom = textValue(answers, "employment.from");
  const employmentUntil = textValue(answers, "employment.until");
  if (employmentFrom && employmentUntil && employmentFrom > employmentUntil) issues.push("Las fechas de trabajo están invertidas.");
  const motherBirth = textValue(answers, "mother.birth_date");
  const fatherBirth = textValue(answers, "father.birth_date");
  if (birth && motherBirth && motherBirth >= birth) issues.push("La fecha de nacimiento de la madre no es anterior a la del solicitante.");
  if (birth && fatherBirth && fatherBirth >= birth) issues.push("La fecha de nacimiento del padre no es anterior a la del solicitante.");
  const previousVisa = textValue(answers, "visa.previous_application_date");
  if (birth && previousVisa && previousVisa <= birth) issues.push("La fecha de la solicitud anterior no es posterior al nacimiento.");
  return issues;
}
