export function shouldCommitRequest(
  requestGeneration: number,
  currentGeneration: number,
  signal: AbortSignal,
): boolean {
  return !signal.aborted && requestGeneration === currentGeneration;
}
