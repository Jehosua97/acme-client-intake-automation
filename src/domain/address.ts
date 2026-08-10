import type { Answer } from "./types.js";

type Answers = Readonly<Record<string, Answer>>;

export const APPLICANT_ADDRESS_FIELD_ID = "contact.residential_address";

const fixedAlternateAddressIds = new Set([
  "contact.mailing_address",
  "partner.address",
  "mother.address",
  "father.address",
]);
const alternateAddressSources: Readonly<Record<string, { fieldId: string; label: string }>> = {
  "relative.address": { fieldId: "visit.address", label: "Dirección de hospedaje en Estados Unidos" },
};

const normalize = (value: string) => value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function isAlternateAddressField(fieldId: string): boolean {
  return fixedAlternateAddressIds.has(fieldId) || Boolean(alternateAddressSources[fieldId]) || /^children\.\d+\.address$/.test(fieldId);
}

export function applicantAddress(answers: Answers): string | null {
  const answer = answers[APPLICANT_ADDRESS_FIELD_ID];
  return answer?.status === "CONFIRMED" && typeof answer.value === "string" && answer.value.trim()
    ? answer.value
    : null;
}

export function addressPrompt(basePrompt: string, fieldId: string, answers: Answers): string {
  if (!isAlternateAddressField(fieldId)) return basePrompt;
  const source = alternateAddressSources[fieldId];
  const currentAddress = source
    ? confirmedAddress(answers, source.fieldId)
    : applicantAddress(answers);
  const reference = currentAddress
    ? `*${source?.label ?? "Domicilio del solicitante"}:*\n${currentAddress}`
    : `*${source?.label ?? "Domicilio del solicitante"}:* pendiente`;
  return `${basePrompt}\n\n${reference}\n\nSi es la misma, responde *SÍ* o escribe *MISMA*. Si no, escribe la nueva dirección completa.`;
}

function confirmedAddress(answers: Answers, fieldId: string): string | null {
  const answer = answers[fieldId];
  return answer?.status === "CONFIRMED" && typeof answer.value === "string" && answer.value.trim() ? answer.value : null;
}

export type AddressResolution =
  | { ok: true; value: string; copiedFromApplicant: boolean }
  | { ok: false; message: string };

export function resolveAddressInput(fieldId: string, raw: string, answers: Answers): AddressResolution {
  if (!isAlternateAddressField(fieldId)) return { ok: true, value: raw, copiedFromApplicant: false };
  const sameAddress = new Set(["si", "s", "yes", "misma", "mismo", "igual", "la misma", "misma direccion"]);
  if (!sameAddress.has(normalize(raw))) return { ok: true, value: raw, copiedFromApplicant: false };
  const source = alternateAddressSources[fieldId];
  const currentAddress = source ? confirmedAddress(answers, source.fieldId) : applicantAddress(answers);
  if (!currentAddress) {
    return { ok: false, message: `Para usar MISMA, primero necesito tener registrada la ${source?.label.toLocaleLowerCase("es") ?? "dirección del solicitante"}. Escribe la dirección completa o usa SALTAR para dejarla pendiente.` };
  }
  return { ok: true, value: currentAddress, copiedFromApplicant: true };
}
