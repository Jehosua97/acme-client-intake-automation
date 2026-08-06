import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientDriveFolderName } from "../../src/infrastructure/google-drive.js";

describe("Google Drive client folder naming", () => {
  it("places the phone before the client's complete name", () => {
    assert.equal(
      clientDriveFolderName("+52 55 1234 5678", "Ana María Pérez López"),
      "+525512345678 - Ana María Pérez López",
    );
  });

  it("uses a temporary label until the complete name is collected", () => {
    assert.equal(
      clientDriveFolderName("+16473265102", "+16473265102"),
      "+16473265102 - Nombre pendiente",
    );
  });

  it("removes characters that Google Drive folder names should not contain", () => {
    assert.equal(
      clientDriveFolderName("+521234", "Ana / Pérez: López"),
      "+521234 - Ana Pérez López",
    );
  });
});
