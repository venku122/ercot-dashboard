/**
 * Strictly timed async loop that yields only at intervals of the specified duration.
 * If work runs over schedule, iterations are skipped to prevent concurrent or desynchronized runs.
 * The yielded number is the previous iteration's duty-cycle fraction.
 */
export async function* fixedInterval(periodMillis: number): AsyncGenerator<number, void, void> {
  let deadline = Date.now();
  let previousWorkMillis = 0;

  while (true) {
    yield previousWorkMillis / periodMillis;

    const completedAt = Date.now();
    previousWorkMillis = completedAt - deadline;

    do {
      deadline += periodMillis;
    } while (deadline < completedAt);

    const delayMillis = deadline - completedAt;
    if (delayMillis < 0 || delayMillis > periodMillis) {
      throw new Error(`invalid ${delayMillis}ms delay for a ${periodMillis}ms fixed interval`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMillis));
  }
}
