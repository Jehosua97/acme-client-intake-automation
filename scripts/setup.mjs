import { randomBytes } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";

const target = new URL("../.env", import.meta.url);
const example = new URL("../.env.example", import.meta.url);

try {
  await access(target);
  console.log(".env ya existe; no se modificó.");
} catch {
  await copyFile(example, target);
  const contents = await readFile(target, "utf8");
  const configured = contents.replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`);
  await writeFile(target, configured, "utf8");
  console.log("Se creó .env con una clave de cifrado local nueva.");
  console.log("Ahora agrega GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.");
}
