import OpenAI from "openai";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { FieldDefinition } from "../domain/types.js";

const interpretationSchema = z.object({
  action: z.enum(["ANSWER", "CLARIFY"]),
  normalizedAnswer: z.string(),
  confidence: z.number().int().min(0).max(100),
});

export type AiInterpretation = z.infer<typeof interpretationSchema>;

export interface AiConversationStatus {
  enabled: boolean;
  configured: boolean;
  active: boolean;
  model: string;
  lastError: string | null;
  lastSuccessAt: string | null;
}

const responseSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["ANSWER", "CLARIFY"],
      description: "ANSWER only when the pending field is clearly answered; otherwise CLARIFY.",
    },
    normalizedAnswer: {
      type: "string",
      description: "The answer normalized for deterministic validation, or an empty string for CLARIFY.",
    },
    confidence: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Confidence that normalizedAnswer faithfully represents the client's message.",
    },
  },
  required: ["action", "normalizedAnswer", "confidence"],
  additionalProperties: false,
} as const;

const SYSTEM_INSTRUCTIONS = `You are a careful data-intake interpreter for a WhatsApp visa questionnaire.
You do not decide the workflow and you do not provide immigration or legal advice.
You receive exactly one pending field and one client message, in Spanish or English.

Return ANSWER only when the message clearly answers that pending field. Otherwise return CLARIFY.
Never invent, infer, complete, translate, or correct personal facts that the client did not provide.
For names, addresses, employers, schools, identifiers and free text, preserve the client's wording and spelling as closely as possible while removing conversational filler.
An address may be valid even when it omits a postal code, state, municipality, or another component requested in the ideal example. If it contains a recognizable street/location and useful identifying detail, return ANSWER rather than demanding every suggested component.
A work or activity start date may be earlier than the requested ten-year cutoff. A valid earlier date still answers the field and must return ANSWER.
Normalize dates to DD/MM/YYYY, month/year values to MM/YYYY, yes/no answers to Sí or No, phone numbers with country code, integers to digits, and money to digits only.
If the client asks an unrelated question, changes the subject, or gives an ambiguous answer, use CLARIFY and leave normalizedAnswer empty.
Commands such as SALTAR, RESUMEN, PENDIENTES, AYUDA, PAUSAR, CONTINUAR and BORRAR MIS DATOS are handled outside of you and must never be invented.`;

function safeError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(apiKey, "[redacted]").slice(0, 500);
}

export class OpenAIConversationService {
  private readonly client: OpenAI | null;
  private readonly controlPath: string;
  private enabled: boolean;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;

  constructor(private readonly config: Config, client?: OpenAI) {
    this.controlPath = path.join(config.dataDir, "ai-conversation-control.json");
    this.enabled = this.loadEnabled();
    this.client = client ?? (config.OPENAI_API_KEY
      ? new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 15_000, maxRetries: 1 })
      : null);
  }

  status(): AiConversationStatus {
    const configured = Boolean(this.config.OPENAI_API_KEY);
    return {
      enabled: this.enabled,
      configured,
      active: this.enabled && configured,
      model: this.config.OPENAI_MODEL,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  async setEnabled(enabled: boolean): Promise<AiConversationStatus> {
    if (enabled && !this.client) throw new Error("OPENAI_API_KEY_NOT_CONFIGURED");
    await mkdir(path.dirname(this.controlPath), { recursive: true });
    const temporary = `${this.controlPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }), "utf8");
    await rename(temporary, this.controlPath);
    this.enabled = enabled;
    return this.status();
  }

  async interpret(workflow: "CANADA" | "USA", field: FieldDefinition, clientMessage: string): Promise<AiInterpretation> {
    if (!this.status().active || !this.client) throw new Error("OPENAI_NOT_ACTIVE");
    try {
      const response = await this.client.responses.create({
        model: this.config.OPENAI_MODEL,
        store: false,
        max_output_tokens: 300,
        input: [
          { role: "system", content: SYSTEM_INSTRUCTIONS },
          {
            role: "user",
            content: JSON.stringify({
              workflow,
              pendingField: { id: field.id, label: field.label, kind: field.kind, question: field.prompt },
              clientMessage,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "whatsapp_field_interpretation",
            strict: true,
            schema: responseSchema,
          },
        },
      });
      if (response.status !== "completed" || !response.output_text) {
        throw new Error(`OPENAI_RESPONSE_${response.status ?? "WITHOUT_OUTPUT"}`);
      }
      const parsed = interpretationSchema.parse(JSON.parse(response.output_text));
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      return parsed;
    } catch (error) {
      this.lastError = safeError(error, this.config.OPENAI_API_KEY);
      throw new Error(this.lastError, { cause: error });
    }
  }

  private loadEnabled(): boolean {
    try {
      const saved = JSON.parse(readFileSync(this.controlPath, "utf8")) as { enabled?: unknown };
      return typeof saved.enabled === "boolean" ? saved.enabled : this.config.AI_CONVERSATION_ENABLED;
    } catch {
      return this.config.AI_CONVERSATION_ENABLED;
    }
  }
}
