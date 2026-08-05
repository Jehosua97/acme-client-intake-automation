import type { Answer } from "./types.js";

type Answers = Readonly<Record<string, Answer>>;

const unknownParentValues: Readonly<Record<string, string>> = {
  "mother.full_name": "DESCONOCIDA",
  "father.full_name": "DESCONOCIDO",
};

const normalize = (value: string) => value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const unknownParentPattern = /^(?:no se|no (?:la|lo) conozco|no conozco|no tengo (?:informacion|datos)|nunca (?:la|lo) conoci|desconozco|desconocid[oa])(?:\s+.*)?$/;

export function unknownParentValue(fieldId: string, raw: string): string | null {
  const canonical = unknownParentValues[fieldId];
  return canonical && unknownParentPattern.test(normalize(raw)) ? canonical : null;
}

export const isKnownParent = (fullNameFieldId: string) => (answers: Answers): boolean => {
  const answer = answers[fullNameFieldId];
  const unknownValue = unknownParentValues[fullNameFieldId];
  return answer?.status === "CONFIRMED" && typeof answer.value === "string" && answer.value !== unknownValue;
};
