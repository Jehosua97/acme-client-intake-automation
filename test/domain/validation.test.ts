import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldDefinition, FieldKind } from "../../src/domain/types.js";
import { validateAnswer } from "../../src/domain/validation.js";

const field = (kind: FieldKind, id = "x"): FieldDefinition => ({ id, section: "x", label: "x", prompt: "x", kind, required: true, order: 1, applies: () => true, forms: [] });

describe("answer validation", () => {
  it("rejects impossible calendar dates", () => {
    assert.equal(validateAnswer(field("date"), "31/02/2025").ok, false);
    assert.deepEqual(validateAnswer(field("date"), "29/02/2024"), { ok: true, value: "2024-02-29" });
  });

  it("normalizes yes/no and phone values", () => {
    assert.deepEqual(validateAnswer(field("yes_no"), "Sí"), { ok: true, value: true });
    assert.deepEqual(validateAnswer(field("phone"), "+52 55 1234 5678"), { ok: true, value: "+525512345678" });
  });

  it("recognizes common and misspelled ways to say that a relative died", () => {
    const deceased = field("text", "mother.marital_status");
    for (const value of ["FINADO", "finada", "Falleció", "ya fallecido", "Muerta", "fayecido", "FAYECIDA", "difunto"]) {
      assert.deepEqual(validateAnswer(deceased, value), { ok: true, value: "FALLECIDO/A" }, value);
    }
    assert.deepEqual(validateAnswer(deceased, "Casado"), { ok: true, value: "Casado" });
  });

  it("records unknown mother or father names as a known condition", () => {
    assert.deepEqual(validateAnswer(field("text", "mother.full_name"), "NO SÉ"), { ok: true, value: "DESCONOCIDA" });
    assert.deepEqual(validateAnswer(field("text", "father.full_name"), "No lo conozco"), { ok: true, value: "DESCONOCIDO" });
  });

  it("accepts current employment and validates month", () => {
    assert.deepEqual(validateAnswer(field("year_month"), "ACTUAL"), { ok: true, value: "CURRENT" });
    assert.equal(validateAnswer(field("year_month", "employment.1.from"), "ACTUAL").ok, false);
    assert.equal(validateAnswer(field("year_month"), "13/2020").ok, false);
  });
});
