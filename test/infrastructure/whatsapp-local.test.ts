import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAuthorizedBackupPhone, isAuthorizedCommandPhone, looksLikeUsableAddress, normalizeWhatsAppMessageId, parseAdminBotCommand, parseAuthorizedSelfServiceCommand, refersToPreviousAnswer, repairWhatsAppMessageId } from "../../src/infrastructure/whatsapp-local.js";

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

  it("allows self-start only for the configured testing phone", () => {
    assert.equal(isAuthorizedCommandPhone("+14378781645", "+14378781645"), true);
    assert.equal(isAuthorizedCommandPhone("+14165550123", "+14378781645"), false);
    assert.equal(isAuthorizedCommandPhone("+14378781645", ""), false);
  });
});

describe("WhatsApp admin activation commands", () => {
  it("accepts only the exact reserved start and global stop phrases", () => {
    assert.equal(parseAdminBotCommand("start bot canada"), "START_CANADA");
    assert.equal(parseAdminBotCommand(" START BOT USA "), "START_USA");
    assert.equal(parseAdminBotCommand("start bot eta"), "START_ETA");
    assert.equal(parseAdminBotCommand("stop bot"), "STOP_ALL");
    assert.equal(parseAdminBotCommand("please start bot canada"), null);
    assert.equal(parseAdminBotCommand("iniciar bot canada"), null);
    assert.equal(parseAdminBotCommand("stop bot usa"), null);
    assert.equal(parseAdminBotCommand(""), null);
  });

  it("allows start and stop from only the configured testing phone", () => {
    assert.equal(parseAuthorizedSelfServiceCommand("START BOT CANADA", "+14378781645", "+14378781645"), "START_CANADA");
    assert.equal(parseAuthorizedSelfServiceCommand("STOP BOT", "+14378781645", "+14378781645"), "STOP_ALL");
    assert.equal(parseAuthorizedSelfServiceCommand("START BOT CANADA", "+14165550123", "+14378781645"), null);
    assert.equal(parseAuthorizedSelfServiceCommand("STOP BOT", "+14165550123", "+14378781645"), null);
  });
});

describe("AI answer safeguards", () => {
  it("accepts a recognizable address without requiring every suggested component", () => {
    assert.equal(looksLikeUsableAddress("Carr. del Bosque 12, Villa Norte"), true);
    assert.equal(looksLikeUsableAddress("No recuerdo"), false);
  });

  it("recognizes requests to reuse the immediately previous answer", () => {
    assert.equal(refersToPreviousAnswer("Ya te lo di"), true);
    assert.equal(refersToPreviousAnswer("I already sent it"), true);
    assert.equal(refersToPreviousAnswer("Esta es otra dirección"), false);
  });
});
