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
  if (visitFrom && visitUntil && visitFrom > visitUntil) issues.push("La salida planeada de Canadá debe ser posterior a la llegada.");
  return [...issues, ...employmentCoverageIssues(answers, referenceDate)];
}
