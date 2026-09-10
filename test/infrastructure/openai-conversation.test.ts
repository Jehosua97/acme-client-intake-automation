import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { loadConfig } from "../../src/config.js";
import type { FieldDefinition } from "../../src/domain/types.js";
import { OpenAIConversationService } from "../../src/infrastructure/openai-conversation.js";

const field: FieldDefinition = {
  id: "identity.birth_date",
  section: "Datos personales",
  label: "Fecha de nacimiento",
  prompt: "¿Cuál es tu fecha de nacimiento? Usa DD/MM/AAAA.",
  kind: "date",
  required: true,
  order: 1,
  applies: () => true,
  forms: ["TEST"],
};

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    APP_ENCRYPTION_KEY: "a".repeat(64),
    DATA_DIR: path.join(os.tmpdir(), `openai-conversation-test-${process.pid}-${Math.random()}`),
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-5.4-mini",
    AI_CONVERSATION_ENABLED: "true",
    ...overrides,
  });
}

describe("OpenAI conversation interpreter", () => {
  it("returns the schema-constrained interpretation and reports a healthy status", async () => {
    const client = {
      responses: {
        create: async () => ({
          status: "completed",
          output_text: JSON.stringify({ action: "ANSWER", normalizedAnswer: "04/09/1990", confidence: 97, clarificationReason: "NONE" }),
        }),
      },
    } as unknown as OpenAI;
    const service = new OpenAIConversationService(config(), client);

    assert.deepEqual(await service.interpret("CANADA", field, "Nací el 4 de septiembre de 1990"), {
      action: "ANSWER",
      normalizedAnswer: "04/09/1990",
      confidence: 97,
      clarificationReason: "NONE",
    });
    assert.equal(service.status().active, true);
    assert.equal(service.status().lastError, null);
    assert.ok(service.status().lastSuccessAt);
  });

  it("reports the specific reason when a work answer needs one concise clarification", async () => {
    const client = {
      responses: {
        create: async () => ({
          status: "completed",
          output_text: JSON.stringify({
            action: "CLARIFY",
            normalizedAnswer: "",
            confidence: 98,
            clarificationReason: "MISSING_BUSINESS_TYPE",
          }),
        }),
      },
    } as unknown as OpenAI;
    const service = new OpenAIConversationService(config(), client);

    assert.equal((await service.interpret("CANADA", { ...field, id: "employment.1.activity" }, "Negocio propio")).clarificationReason, "MISSING_BUSINESS_TYPE");
  });

  it("does not activate without both the feature flag and API key", () => {
    assert.equal(new OpenAIConversationService(config({ AI_CONVERSATION_ENABLED: "false" })).status().active, false);
    assert.equal(new OpenAIConversationService(config({ OPENAI_API_KEY: "" })).status().active, false);
  });

  it("persists the dashboard selection across service restarts", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ai-conversation-control-"));
    const client = { responses: { create: async () => ({ status: "completed", output_text: "{}" }) } } as unknown as OpenAI;
    try {
      const runtimeConfig = config({ DATA_DIR: dataDir });
      const service = new OpenAIConversationService(runtimeConfig, client);
      await service.setEnabled(false);
      assert.equal(service.status().enabled, false);
      assert.equal(new OpenAIConversationService(runtimeConfig, client).status().enabled, false);

      await service.setEnabled(true);
      assert.equal(new OpenAIConversationService(runtimeConfig, client).status().active, true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not allow enabling AI without a server-side API key", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ai-conversation-no-key-"));
    try {
      const service = new OpenAIConversationService(config({ DATA_DIR: dataDir, OPENAI_API_KEY: "", AI_CONVERSATION_ENABLED: "false" }));
      await assert.rejects(() => service.setEnabled(true), /OPENAI_API_KEY_NOT_CONFIGURED/);
      assert.equal(service.status().enabled, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the provider does not return valid structured output", async () => {
    const client = {
      responses: { create: async () => ({ status: "completed", output_text: "{}" }) },
    } as unknown as OpenAI;
    const service = new OpenAIConversationService(config(), client);

    await assert.rejects(() => service.interpret("USA", field, "tal vez en septiembre"));
    assert.match(service.status().lastError ?? "", /invalid_type|Invalid input/i);
  });

  it("creates a structured post-intake summary only when explicitly requested", async () => {
    let calls = 0;
    const expected = {
      executiveSummary: "El PDF fue capturado y quedan dos documentos pendientes.",
      lastProgress: "Se recibió la carta laboral.",
      pendingClarifications: [],
      documentsRequested: ["Itinerario", "Estado de cuenta"],
      documentsReceived: ["Carta laboral"],
      nextAction: "Preparar un recordatorio para los dos documentos faltantes.",
      warnings: ["El contenido de la carta no ha sido aprobado por el administrador."],
      evidence: [{ statement: "Carta laboral recibida", sourceEventId: 15, sourceDocumentId: "doc-1" }],
    };
    const client = {
      responses: {
        create: async (request: { store?: boolean }) => {
          calls += 1;
          assert.equal(request.store, false);
          return { status: "completed", output_text: JSON.stringify(expected) };
        },
      },
    } as unknown as OpenAI;
    const service = new OpenAIConversationService(config({ AI_CONVERSATION_ENABLED: "false" }), client);

    assert.equal(calls, 0);
    assert.deepEqual(await service.summarizePostIntake("CANADA", { checklist: [], timeline: [] }), expected);
    assert.equal(calls, 1);
  });
});
