import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { FullBackupService } from "../../src/infrastructure/full-backup.js";
import { SQLiteStore } from "../../src/infrastructure/sqlite-store.js";

const execFileAsync = promisify(execFile);

describe("full local backup", () => {
  it("creates a ZIP with the complete project folder", { skip: process.platform !== "win32" }, async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "msc-full-backup-"));
    const project = path.join(temporary, "project");
    const desktop = path.join(temporary, "Desktop");
    await mkdir(path.join(project, ".data"), { recursive: true });
    await writeFile(path.join(project, "archivo-prueba.txt"), "contenido del respaldo", "utf8");
    const store = new SQLiteStore(path.join(project, ".data", "bot.sqlite"));
    try {
      const service = new FullBackupService(project, desktop, store);
      const result = await service.create();
      assert.match(result.filename, /^MultiServiciosBot_Backup_.*\.zip$/);
      assert.ok(result.bytes > 0);
      const listing = await execFileAsync("tar.exe", ["-t", "-f", result.path], { encoding: "utf8" });
      assert.match(listing.stdout, /project\/archivo-prueba\.txt/);
      assert.match(listing.stdout, /project\/\.data\/backups\/bot-before-full-backup-/);
    } finally {
      store.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
