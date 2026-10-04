import { rehearsalOrigin } from "./rehearsal_guard.ts";
Deno.test("rehearsal refuses production delivery even with available key", () => {
  for (const url of [
    "https://ercot.tarazevits.io/",
    "http://192.168.1.1:8080/",
    "http://receiver:8080/api/ingest",
    "http://key:secret@receiver:8080/",
    "http://receiver:8080/?production=1",
  ]) {
    let rejected = false;
    try {
      rehearsalOrigin(url);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("accepted " + url);
  }
});
Deno.test("rehearsal permits only explicitly local root destinations", () => {
  if (rehearsalOrigin("http://127.0.0.1:4308/").port !== "4308")
    throw new Error("local receiver rejected");
});
