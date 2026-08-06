import path from "node:path";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("./.data"),
  ORGANIZATION_NAME: z.string().trim().min(1).max(100).default("MultiServicios"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://127.0.0.1:3000/auth/google/callback"),
  GOOGLE_DRIVE_ROOT_FOLDER_NAME: z.string().min(1).default("MultiServicios - Clientes"),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "debe tener 64 caracteres hexadecimales"),
  WHATSAPP_AUTOSTART: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  WHATSAPP_BROWSER_VISIBLE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  WHATSAPP_SESSION_ID: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("acme-client-intake"),
  WHATSAPP_DEVICE_NAME: z.string().trim().min(1).max(100).default("MultiServicios Client Intake"),
  CHROME_EXECUTABLE_PATH: z.string().default(""),
  MAX_DOCUMENT_MB: z.coerce.number().min(1).max(100).default(20),
});

export type Config = z.infer<typeof schema> & {
  dataDir: string;
  databasePath: string;
  whatsappSessionPath: string;
  googleTokenPath: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Configuración inválida: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const dataDir = path.resolve(parsed.data.DATA_DIR);
  return {
    ...parsed.data,
    dataDir,
    databasePath: path.join(dataDir, "bot.sqlite"),
    whatsappSessionPath: path.join(dataDir, "whatsapp-session"),
    googleTokenPath: path.join(dataDir, "google-token.enc"),
  };
}
