import type { Answer } from "./types.js";

type Answers = Readonly<Record<string, Answer>>;

function textValue(answers: Answers, id: string): string | null {
  const answer = answers[id];
  return answer?.status === "CONFIRMED" && typeof answer.value === "string" ? answer.value : null;
}

function monthNumber(value: string, current: number): number | null {
  if (value === "CURRENT") return current;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

function displayMonth(index: number): string {
  return `${String((index % 12) + 1).padStart(2, "0")}/${Math.floor(index / 12)}`;
}

function currentYearMonth(referenceDate: Date): string {
  return `${referenceDate.getFullYear()}-${String(referenceDate.getMonth() + 1).padStart(2, "0")}`;
}

function previousYearMonth(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function immediateConsistencyIssue(
  fieldId: string,
  value: Answer["value"],
  answers: Answers,
  referenceDate = new Date(),
): string | null {
  if (typeof value !== "string") return null;
  if (fieldId === "visit.from") {
    const until = textValue(answers, "visit.until");
    if (until && value >= until) return "La fecha de llegada debe ser anterior a la fecha estimada de salida de Canadá.";
  }
  if (fieldId === "visit.until") {
    const from = textValue(answers, "visit.from");
    if (from && from >= value) return "La fecha estimada de salida debe ser posterior a la fecha de llegada a Canadá.";
  }
  if (fieldId === "application.previous_canada_entry_date") {
    const exit = textValue(answers, "application.previous_canada_exit_date");
    if (value > referenceDate.toISOString().slice(0, 10)) return "La fecha de entrada anterior a Canadá no puede estar en el futuro.";
    if (exit && value >= exit) return "La fecha de entrada anterior debe ser anterior a la fecha de salida de Canadá.";
  }
  if (fieldId === "application.previous_canada_exit_date") {
    const entry = textValue(answers, "application.previous_canada_entry_date");
    if (value > referenceDate.toISOString().slice(0, 10)) return "La fecha de salida anterior de Canadá no puede estar en el futuro.";
    if (entry && entry >= value) return "La fecha de salida anterior debe ser posterior a la fecha de entrada a Canadá.";
  }
  const employment = fieldId.match(/^employment\.(\d+)\.from$/);
  if (employment) {
    const index = Number(employment[1]);
    if (index === 1 && value > currentYearMonth(referenceDate)) {
      return "La actividad actual no puede comenzar en una fecha futura. Usa MM/AAAA.";
    }
    if (index > 1) {
      const newerFrom = textValue(answers, `employment.${index - 1}.from`);
      if (newerFrom && value >= newerFrom) {
        return `Esta actividad debe haber comenzado antes de ${newerFrom.slice(5)}/${newerFrom.slice(0, 4)} para mantener el historial en orden.`;
      }
    }
  }
  return null;
}

export function derivedEmploymentUntil(
  fieldId: string,
  value: Answer["value"],
  answers: Answers,
): { fieldId: string; value: string } | null {
  const match = fieldId.match(/^employment\.(\d+)\.from$/);
  if (!match || typeof value !== "string") return null;
  const index = Number(match[1]);
  if (index === 1) return { fieldId: "employment.1.until", value: "CURRENT" };
  const newerFrom = textValue(answers, `employment.${index - 1}.from`);
  const until = newerFrom ? previousYearMonth(newerFrom) : null;
  return until ? { fieldId: `employment.${index}.until`, value: until } : null;
}

export function employmentCoverageIssues(answers: Answers, referenceDate = new Date()): string[] {
  const indexes = [...new Set(Object.keys(answers).flatMap((fieldId) => {
    const match = fieldId.match(/^employment\.(\d+)\.(?:from|until)$/);
    return match ? [Number(match[1])] : [];
  }))].sort((left, right) => left - right);
  if (!indexes.length) return ["Debe existir al menos una actividad para cubrir los últimos 10 años."];
  const current = referenceDate.getUTCFullYear() * 12 + referenceDate.getUTCMonth();
  const targetStart = current - 120;
  const covered = new Set<number>();
  const issues: string[] = [];
  for (const index of indexes) {
    const fromText = textValue(answers, `employment.${index}.from`);
    const untilText = textValue(answers, `employment.${index}.until`);
    if (!fromText || !untilText) continue;
    const from = monthNumber(fromText, current);
    const until = monthNumber(untilText, current);
    if (from === null || until === null || from > until) {
      issues.push(`Las fechas de la actividad ${index} no forman un periodo válido.`);
      continue;
    }
    for (let month = Math.max(from, targetStart); month <= Math.min(until, current); month++) covered.add(month);
  }
  const gaps: Array<{ from: number; until: number }> = [];
  let open: number | null = null;
  for (let month = targetStart; month <= current; month++) {
    if (!covered.has(month) && open === null) open = month;
    if (covered.has(month) && open !== null) { gaps.push({ from: open, until: month - 1 }); open = null; }
  }
  if (open !== null) gaps.push({ from: open, until: current });
  for (const gap of gaps) issues.push(`Falta actividad entre ${displayMonth(gap.from)} y ${displayMonth(gap.until)}.`);
  return issues;
}

export function crossFieldIssues(answers: Answers, referenceDate = new Date()): string[] {
  const issues: string[] = [];
  const birth = textValue(answers, "identity.birth_date");
  const issue = textValue(answers, "passport.issue_date");
  const expiry = textValue(answers, "passport.expiry_date");
  if (birth && issue && birth >= issue) issues.push("La emisión del pasaporte debe ser posterior al nacimiento.");
  if (issue && expiry && issue >= expiry) issues.push("El vencimiento del pasaporte debe ser posterior a su emisión.");
  const visitFrom = textValue(answers, "visit.from");
  const visitUntil = textValue(answers, "visit.until");
  if (visitFrom && visitUntil && visitFrom >= visitUntil) issues.push("La salida planeada de Canadá debe ser posterior a la llegada.");
  const previousCanadaEntry = textValue(answers, "application.previous_canada_entry_date");
  const previousCanadaExit = textValue(answers, "application.previous_canada_exit_date");
  if (previousCanadaEntry && previousCanadaExit && previousCanadaEntry >= previousCanadaExit) {
    issues.push("La salida del viaje anterior a Canadá debe ser posterior a la entrada.");
  }
  return [...issues, ...employmentCoverageIssues(answers, referenceDate)];
}
