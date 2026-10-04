/** Keep the cold queue serialized through two frame callbacks, with a bounded hidden-page fallback. */
export function afterColdHistoryPaint(
  signal: AbortSignal,
  complete: () => void,
  scheduler: Pick<
    Window,
    "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "clearTimeout"
  > = window,
): () => void {
  if (signal.aborted) return () => {};
  let frame: number | null = null;
  let timer: number | null = null;
  let finished = false;
  const cancel = () => {
    if (finished) return;
    finished = true;
    if (frame !== null) scheduler.cancelAnimationFrame(frame);
    if (timer !== null) scheduler.clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  };
  const finish = () => {
    if (finished) return;
    cancel();
    if (!signal.aborted) complete();
  };
  signal.addEventListener("abort", cancel, { once: true });
  frame = scheduler.requestAnimationFrame(() => {
    frame = scheduler.requestAnimationFrame(finish);
  });
  timer = scheduler.setTimeout(finish, 1000);
  return cancel;
}
