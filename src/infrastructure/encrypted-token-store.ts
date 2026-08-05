import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export class EncryptedTokenStore {
  private readonly key: Buffer;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, encryptionKeyHex: string) {
    this.key = Buffer.from(encryptionKeyHex, "hex");
    if (this.key.length !== 32) throw new Error("APP_ENCRYPTION_KEY debe representar 32 bytes");
  }

  save(value: unknown): Promise<void> {
    // Serialize immediately so later credential refreshes cannot mutate the
    // object while this write is waiting behind another one.
    const serialized = JSON.stringify(value);
    const operation = this.writeQueue.then(() => this.writeEncrypted(serialized));
    // Keep the queue usable after an individual failure while still returning
    // that failure to the caller that initiated the write.
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async writeEncrypted(serialized: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
    const payload = Buffer.concat([Buffer.from("MSCT1"), iv, cipher.getAuthTag(), ciphertext]);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.removeStaleTemporaryFiles();
    const temporary = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, payload, { mode: 0o600 });
      try {
        await rename(temporary, this.filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(code ?? "")) throw error;
        // Windows or antivirus software can briefly prevent rename-overwrite.
        // With writes serialized, copying over the destination is safe here.
        await copyFile(temporary, this.filePath);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async load<T>(): Promise<T | null> {
    await this.writeQueue;
    await this.removeStaleTemporaryFiles();
    try {
      const payload = await readFile(this.filePath);
      if (payload.subarray(0, 5).toString() !== "MSCT1") throw new Error("Token local con formato inválido");
      const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(5, 17));
      decipher.setAuthTag(payload.subarray(17, 33));
      const clear = Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]).toString("utf8");
      return JSON.parse(clear) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(): Promise<void> {
    await this.writeQueue;
    await rm(this.filePath, { force: true });
  }

  private async removeStaleTemporaryFiles(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    try {
      const names = await readdir(directory);
      await Promise.all(names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map((name) => rm(path.join(directory, name), { force: true })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
