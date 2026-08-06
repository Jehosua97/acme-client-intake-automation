import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAuthorizedBackupPhone, normalizeWhatsAppMessageId, repairWhatsAppMessageId } from "../../src/infrastructure/whatsapp-local.js";

describe("WhatsApp message ID normalization", () => {
  it("accepts the serialized ID provided by normal WhatsApp messages", () => {
    assert.equal(
      normalizeWhatsAppMessageId({ _serialized: "false_5215550000000@c.us_ABC123" }),
      "false_5215550000000@c.us_ABC123",
    );
  });

  it("reconstructs IDs from runtime objects when _serialized is not a string", () => {
    assert.equal(
      normalizeWhatsAppMessageId({ fromMe: false, remote: { _serialized: "5215550000000@c.us" }, id: "ABC123", _serialized: {} }),
      "false_5215550000000@c.us_ABC123",
    );
  });

  it("rejects malformed event IDs instead of passing objects to SQLite", () => {
    assert.equal(normalizeWhatsAppMessageId({ _serialized: {}, remote: null, id: null }), null);
    assert.equal(normalizeWhatsAppMessageId(undefined), null);
  });

  it("restores _serialized for media methods affected by current WhatsApp Web IDs", () => {
    const id: Record<string, unknown> = { fromMe: false, remote: "5215550000000@lid", id: "ABC123", $1: "renamed-by-whatsapp" };
    assert.equal(repairWhatsAppMessageId(id), "false_5215550000000@lid_ABC123");
    assert.equal(id._serialized, "false_5215550000000@lid_ABC123");
  });
});

describe("WhatsApp full-backup authorization", () => {
  it("accepts only the configured administrator phone", () => {
    assert.equal(isAuthorizedBackupPhone("+14378781645", "+14378781645"), true);
    assert.equal(isAuthorizedBackupPhone("+14372139246", "+14378781645"), false);
    assert.equal(isAuthorizedBackupPhone("+14378781645", ""), false);
  });
});
