import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EncryptedTokenStore } from "../../src/infrastructure/encrypted-token-store.js";

describe("EncryptedTokenStore", () => {
  it("round-trips OAuth credentials without writing the token in clear text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "msc-token-"));
    const file = path.join(directory, "google-token.enc");
    const tokenStore = new EncryptedTokenStore(file, "11".repeat(32));
    try {
      const credentials = { access_token: "secret-access", refresh_token: "secret-refresh" };
      await tokenStore.save(credentials);
      assert.deepEqual(await tokenStore.load(), credentials);
      const bytes = await readFile(file);
      assert.equal(bytes.includes(Buffer.from("secret-refresh")), false);

      await Promise.all(Array.from({ length: 12 }, (_, index) => tokenStore.save({ sequence: index })));
      assert.deepEqual(await tokenStore.load(), { sequence: 11 });
      assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);

      await writeFile(`${file}.orphan.tmp`, "incomplete");
      await tokenStore.load();
      assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
