import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { backup as sqliteBackup } from "node:sqlite";
import path from "node:path";
import type { SQLiteStore } from "./sqlite-store.js";

export interface FullBackupResult {
  filename: string;
  path: string;
  bytes: number;
  durationMs: number;
}

function timestamp(date = new Date()): string {
  const part = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}_${part(date.getHours())}-${part(date.getMinutes())}-${part(date.getSeconds())}-${part(date.getMilliseconds(), 3)}`;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class FullBackupService {
  private active: Promise<FullBackupResult> | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly outputDirectory: string,
    private readonly store: SQLiteStore,
  ) {}

  isRunning(): boolean { return this.active !== null; }

  create(): Promise<FullBackupResult> {
    if (this.active) throw new Error("FULL_BACKUP_IN_PROGRESS");
    const operation = this.run();
    this.active = operation;
    void operation.finally(() => { this.active = null; }).catch(() => {});
    return operation;
  }

  private async run(): Promise<FullBackupResult> {
    const startedAt = Date.now();
    const source = path.resolve(this.projectRoot);
    const destination = path.resolve(this.outputDirectory);
    if (isInside(source, destination)) throw new Error("La carpeta de salida del respaldo debe estar fuera del proyecto.");
    await mkdir(destination, { recursive: true });

    const suffix = timestamp();
    const databaseBackupDirectory = path.join(source, ".data", "backups");
    await mkdir(databaseBackupDirectory, { recursive: true });
    await sqliteBackup(this.store.db, path.join(databaseBackupDirectory, `bot-before-full-backup-${suffix}.sqlite`));

    const filename = `MultiServiciosBot_Backup_${suffix}.zip`;
    const finalPath = path.join(destination, filename);
    const partialPath = path.join(destination, `.MultiServiciosBot_Backup_${suffix}.partial.zip`);
    try {
      await this.archiveWithWindowsTar(source, partialPath);
      await rename(partialPath, finalPath);
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => {});
      throw error;
    }
    const details = await stat(finalPath);
    return { filename, path: finalPath, bytes: details.size, durationMs: Date.now() - startedAt };
  }

  private archiveWithWindowsTar(source: string, target: string): Promise<void> {
    if (process.platform !== "win32") throw new Error("El respaldo ZIP completo está configurado para Windows.");
    const parent = path.dirname(source);
    const folder = path.basename(source);
    return new Promise((resolve, reject) => {
      const child = spawn("tar.exe", ["-c", "-a", "-f", target, "-C", parent, folder], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`No fue posible comprimir la carpeta completa${stderr.trim() ? `: ${stderr.trim()}` : ` (tar.exe terminó con código ${code})`}`));
      });
    });
  }
}
