import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = await mkdtemp(path.join(tmpdir(), "msc-smoke-"));
const port = 31_000 + Math.floor(Math.random() * 1_000);
let stderr = "";
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: dataRoot,
    APP_ENCRYPTION_KEY: "22".repeat(32),
    WHATSAPP_AUTOSTART: "false",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
try {
  let status;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó antes de responder.\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/system/status`);
      if (response.ok) { status = await response.json(); break; }
    } catch { /* todavía está iniciando */ }
    await delay(100);
  }
  if (!status) throw new Error(`El servidor no respondió a tiempo.\n${stderr}`);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  if (!page.ok || !html.includes("Expedientes de clientes")) throw new Error("El panel no devolvió su página principal");
  console.log(JSON.stringify({ httpStatus: page.status, panel: true, database: status.databasePath, driveConfigured: status.googleDrive.configured }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(dataRoot, { recursive: true, force: true });
}
