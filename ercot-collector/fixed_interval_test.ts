import { fixedInterval } from "./fixed_interval.ts";

Deno.test("fixedInterval begins immediately with an idle duty cycle", async () => {
  const iterator = fixedInterval(60_000);
  const first = await iterator.next();

  if (first.done || first.value !== 0) {
    throw new Error(`expected first duty cycle to be 0, received ${String(first.value)}`);
  }

  await iterator.return();
});
