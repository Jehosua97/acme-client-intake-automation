import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeWhatsAppMessageId } from "../../src/infrastructure/whatsapp-local.js";

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
});
