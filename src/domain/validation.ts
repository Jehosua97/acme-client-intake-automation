import type { FieldDefinition } from "./types.js";

export type ValidationResult = { ok: true; value: string | number | boolean } | { ok: false; message: string };

const clean = (value: string) => value.trim().replace(/\s+/g, " ");

function isoDate(value: string): string | null {
  const match = clean(value).match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yearText}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function yearMonth(value: string): string | null {
  if (/^actual$/i.test(clean(value))) return "CURRENT";
  const match = clean(value).match(/^(\d{1,2})[\/-](\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  return `${match[2]}-${String(month).padStart(2, "0")}`;
}

export function validateAnswer(field: FieldDefinition, raw: string): ValidationResult {
  const value = clean(raw);
  if (!value) return { ok: false, message: "No alcancé a leer una respuesta. Inténtalo otra vez." };
  switch (field.kind) {
    case "yes_no": {
      const normalized = value.toLocaleLowerCase("es");
      if (["sí", "si", "s", "yes"].includes(normalized)) return { ok: true, value: true };
      if (["no", "n"].includes(normalized)) return { ok: true, value: false };
      return { ok: false, message: "Por favor responde únicamente Sí o No." };
    }
    case "date": {
      const parsed = isoDate(value);
      return parsed ? { ok: true, value: parsed } : { ok: false, message: "Usa una fecha válida en formato DD/MM/AAAA." };
    }
    case "year_month": {
      const parsed = yearMonth(value);
      return parsed ? { ok: true, value: parsed } : { ok: false, message: "Usa MM/AAAA. Si la actividad continúa actualmente, escribe ACTUAL." };
    }
    case "integer": {
      if (!/^\d{1,2}$/.test(value) || Number(value) > 20) return { ok: false, message: "Escribe un número entre 0 y 20." };
      if (field.id === "employment.count" && Number(value) < 1) return { ok: false, message: "Necesitamos al menos un periodo para cubrir tus actividades de los últimos 10 años." };
      if (field.id === "travel_history.count" && Number(value) < 1) return { ok: false, message: "Como indicaste que sí viajaste, necesitamos registrar al menos un viaje." };
      return { ok: true, value: Number(value) };
    }
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
        ? { ok: true, value: value.toLowerCase() }
        : { ok: false, message: "Ese correo parece incompleto. Revísalo y envíalo nuevamente." };
    case "phone": {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15
        ? { ok: true, value: `+${digits}` }
        : { ok: false, message: "Incluye un teléfono válido con código de país." };
    }
    case "money": {
      const amount = Number(value.replace(/[$,\s]/g, ""));
      return Number.isFinite(amount) && amount >= 0
        ? { ok: true, value: amount }
        : { ok: false, message: "Escribe la cantidad disponible usando solo números." };
    }
    default:
      return { ok: true, value };
  }
}
