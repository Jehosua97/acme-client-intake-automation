import type { Answer } from "./types.js";

type Answers = Readonly<Record<string, Answer>>;

export const APPLICANT_ADDRESS_FIELD_ID = "contact.residential_address";

const fixedAlternateAddressIds = new Set([
  "contact.mailing_address",
  "partner.address",
  "mother.address",
  "father.address",
  "visit.contact_address",
]);

const normalize = (value: string) => value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function isAlternateAddressField(fieldId: string): boolean {
  return fixedAlternateAddressIds.has(fieldId) || /^children\.\d+\.address$/.test(fieldId);
}

export function applicantAddress(answers: Answers): string | null {
  const answer = answers[APPLICANT_ADDRESS_FIELD_ID];
  return answer?.status === "CONFIRMED" && typeof answer.value === "string" && answer.value.trim()
    ? answer.value
    : null;
}

export function addressPrompt(basePrompt: string, fieldId: string, answers: Answers): string {
  if (!isAlternateAddressField(fieldId)) return basePrompt;
  const currentAddress = applicantAddress(answers);
  const reference = currentAddress
    ? `El domicilio que indicó el solicitante es: ${currentAddress}`
    : "El domicilio del solicitante todavía está pendiente.";
  return `${basePrompt}\n\n${reference}\nSi es la misma, escribe MISMA; si no, escribe la nueva dirección completa.`;
}

export type AddressResolution =
  | { ok: true; value: string; copiedFromApplicant: boolean }
  | { ok: false; message: string };

export function resolveAddressInput(fieldId: string, raw: string, answers: Answers): AddressResolution {
  if (!isAlternateAddressField(fieldId)) return { ok: true, value: raw, copiedFromApplicant: false };
  const sameAddress = new Set(["misma", "mismo", "igual", "la misma", "misma direccion"]);
  if (!sameAddress.has(normalize(raw))) return { ok: true, value: raw, copiedFromApplicant: false };
  const currentAddress = applicantAddress(answers);
  if (!currentAddress) {
    return { ok: false, message: "Para usar MISMA, primero necesito tener registrado tu domicilio. Escribe la dirección completa o usa SALTAR para dejarla pendiente." };
  }
  return { ok: true, value: currentAddress, copiedFromApplicant: true };
}
