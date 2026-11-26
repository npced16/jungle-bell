import { assertEquals } from "@std/assert";
import { hmac, mobileToken, sessionHash, sha256, uiSessionHash } from "../../functions/_shared/crypto.ts";
import { config } from "../support/config.ts";

// Independently computed with node:crypto from the Kotlin TokenCodec domain strings.
Deno.test("Kotlin TokenCodec fixed vectors include NUL separators and receipt SHA256", async () => {
  assertEquals(
    await sessionHash("jbd_" + "a".repeat(64)),
    "e96d308060c07c13bb0ac5385b764375a37d6a8ee5142dabbbea911f140ca185",
  );
  assertEquals(
    await uiSessionHash("jbui_" + "b".repeat(64)),
    "ecfa60b24772e438eda566181358d59eb820e2dc09557242f420c6645bb97bf9",
  );
  const receiptHash = await sha256("jbcr_" + "a".repeat(64));
  assertEquals(receiptHash, "04bdb12ab2d425ca3158950ee3e4a09faabc0c6345956016ec6358332fd3da5f");
  assertEquals(
    await mobileToken(config.pairingSecret, receiptHash),
    "jbs_fe1dc759713c95120cdb8055fc0d408a75070a1775ddb5269eae261de49d605e",
  );
  assertEquals(
    await hmac(config.pairingSecret, "0123456789"),
    "1b6cabff18638309c4284dcf2bb8047c226b63b40e7cc28ace61d13e8e5c4cfb",
  );
});
