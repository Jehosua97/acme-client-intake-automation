import OpenAI from "openai";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { FieldDefinition } from "../domain/types.js";
import type { StoredPostIntakeSummary } from "./sqlite-store.js";

const interpretationSchema = z.object({
  action: z.enum(["ANSWER", "CLARIFY"]),
  normalizedAnswer: z.string(),
  confidence: z.number().int().min(0).max(100),
  clarificationReason: z.enum(["NONE", "IMPLAUSIBLE_DATE", "MISSING_BUSINESS_TYPE", "MISSING_ORGANIZATION_NAME", "OTHER"]),
});

export type AiInterpretation = z.infer<typeof interpretationSchema>;

const postIntakeSummarySchema = z.object({
  executiveSummary: z.string(),
  lastProgress: z.string(),
  pendingClarifications: z.array(z.string()),
  documentsRequested: z.array(z.string()),
  documentsReceived: z.array(z.string()),
  nextAction: z.string(),
  warnings: z.array(z.string()),
  evidence: z.array(z.object({
    statement: z.string(),
    sourceEventId: z.number().int().nullable(),
    sourceDocumentId: z.string().nullable(),
  })),
});

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
    clarificationReason: {
      type: "string",
      enum: ["NONE", "IMPLAUSIBLE_DATE", "MISSING_BUSINESS_TYPE", "MISSING_ORGANIZATION_NAME", "OTHER"],
      description: "Why clarification is needed. Use NONE with ANSWER.",
    },
  },
  required: ["action", "normalizedAnswer", "confidence", "clarificationReason"],
  additionalProperties: false,
} as const;

const postIntakeResponseSchema = {
  type: "object",
  properties: {
    executiveSummary: { type: "string" },
    lastProgress: { type: "string" },
    pendingClarifications: { type: "array", items: { type: "string" } },
    documentsRequested: { type: "array", items: { type: "string" } },
    documentsReceived: { type: "array", items: { type: "string" } },
    nextAction: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          sourceEventId: { type: ["integer", "null"] },
          sourceDocumentId: { type: ["string", "null"] },
        },
        required: ["statement", "sourceEventId", "sourceDocumentId"],
        additionalProperties: false,
      },
    },
  },
  required: ["executiveSummary", "lastProgress", "pendingClarifications", "documentsRequested", "documentsReceived", "nextAction", "warnings", "evidence"],
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
For a birth date, return CLARIFY with IMPLAUSIBLE_DATE when the year is in the future or would make the person more than 120 years old.
For an activity, position or duties field, a reply such as "negocio propio", "por mi cuenta" or "independiente" does not explain what the person actually does. Return CLARIFY with MISSING_BUSINESS_TYPE unless the message also states the kind of product, trade or service.
For a company, organization or school field, a category such as "taller de autos", "escuela" or "mi negocio" is not a name. Return CLARIFY with MISSING_ORGANIZATION_NAME. If the client explicitly says the business has no formal or commercial name, accept that statement as ANSWER.
If the client asks an unrelated question, changes the subject, or gives an ambiguous answer, use CLARIFY and leave normalizedAnswer empty.
Commands such as SALTAR, RESUMEN, PENDIENTES, AYUDA, PAUSAR, CONTINUAR and BORRAR MIS DATOS are handled outside of you and must never be invented.`;

const POST_INTAKE_SUMMARY_INSTRUCTIONS = `You summarize the post-intake follow-up of a visa client for an internal administrator.
Write concise Spanish. Use only facts explicitly present in the supplied checklist, documents and timeline.
Never invent that a requirement was requested, received, reviewed or approved. Never provide immigration or legal advice.
Checklist status is the operational source of truth. Conversation messages are supporting context only.
If evidence is incomplete or contradictory, say so in warnings and recommend human review.
For each important conclusion, add an evidence entry using an exact supplied event ID or document ID. Use null when no reliable source exists.
Do not claim that a document is sufficient merely because a file exists.`;

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

  async summarizePostIntake(workflow: "CANADA" | "USA", input: Record<string, unknown>): Promise<StoredPostIntakeSummary> {
    if (!this.client) throw new Error("OPENAI_API_KEY_NOT_CONFIGURED");
    try {
      const response = await this.client.responses.create({
        model: this.config.OPENAI_MODEL,
        store: false,
        max_output_tokens: 1_200,
        input: [
          { role: "system", content: POST_INTAKE_SUMMARY_INSTRUCTIONS },
          { role: "user", content: JSON.stringify({ workflow, ...input }) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "post_intake_follow_up_summary",
            strict: true,
            schema: postIntakeResponseSchema,
          },
        },
      });
      if (response.status !== "completed" || !response.output_text) {
        throw new Error(`OPENAI_RESPONSE_${response.status ?? "WITHOUT_OUTPUT"}`);
      }
      const parsed = postIntakeSummarySchema.parse(JSON.parse(response.output_text));
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
