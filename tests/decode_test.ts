```typescript
import { assertEquals } from "https://deno.land/std@0.167.0/testing/asserts.ts";
import { decode } from "../supabase/functions/_shared/decode.ts";
import chainEvents from "./fixtures/chain_events.json" assert { type: "json" };

Deno.test("decode fee_updated event", () => {
  const event = chainEvents.fee_updated[0];
  const decoded = decode(event);
  assertEquals(decoded.name, "fee_updated");
  assertEquals(decoded.topics.length, 2);
  assertEquals(decoded.fields, {
    fee: "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
});

Deno.test("decode treasury_updated event", () => {
  const event = chainEvents.treasury_updated[0];
  const decoded = decode(event);
  assertEquals(decoded.name, "treasury_updated");
  assertEquals(decoded.topics.length, 2);
  assertEquals(decoded.fields, {
    treasury: "0x0000000000000000000000000000000000000000000000000000000000000003",
  });
});

Deno.test("decode pause_updated event", () => {
  const event = chainEvents.pause_updated[0];
  const decoded = decode(event);
  assertEquals(decoded.name, "pause_updated");
  assertEquals(decoded.topics.length, 2);
  assertEquals(decoded.fields, {
    pause: "0x0000000000000000000000000000000000000000000000000000000000000005",
  });
});

// Adicione testes para os outros eventos já existentes
