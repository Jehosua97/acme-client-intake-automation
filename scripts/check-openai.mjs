import "dotenv/config";
import { loadConfig } from "../dist/src/config.js";
import { OpenAIConversationService } from "../dist/src/infrastructure/openai-conversation.js";

const config = loadConfig();
const service = new OpenAIConversationService(config);
const status = service.status();

if (!status.enabled) throw new Error("AI_CONVERSATION_ENABLED no está activado en .env");
if (!status.configured) throw new Error("OPENAI_API_KEY no está configurada en .env");

const field = {
  id: "identity.birth_date",
  section: "Datos personales",
  label: "Fecha de nacimiento",
  prompt: "¿Cuál es tu fecha de nacimiento? Usa DD/MM/AAAA.",
  kind: "date",
  required: true,
  order: 1,
  applies: () => true,
  forms: ["CONNECTION_CHECK"],
};

const result = await service.interpret("CANADA", field, "Nací el 4 de septiembre de 1990");
console.log(JSON.stringify({
  active: service.status().active,
  model: service.status().model,
  action: result.action,
  normalizedAnswer: result.normalizedAnswer,
  confidence: result.confidence,
  lastError: service.status().lastError,
}, null, 2));
