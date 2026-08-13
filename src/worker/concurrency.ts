/**
 * Bounded parallelism for outbound deliveries (ARCHITECTURE.md section 12,
 * ENGINEERING_RULES.md section 10).
 *
 * A fixed pool of runners pulls from a shared cursor, so at most `limit` tasks
 * are ever in flight regardless of how many items are queued. This exists
 * instead of `Promise.all(items.map(task))`, which would start every claimed
 * delivery at once and let a single burst exhaust sockets.
 *
 * The cursor needs no lock: JavaScript runs this on one thread and there is no
 * `await` between reading and incrementing it, so two runners cannot observe
 * the same index.
 *
 * `task` is expected to handle its own failures. A rejection here would abort
 * its runner and propagate, which is the opposite of the failure isolation the
 * worker needs, so the caller wraps each delivery.
 *
 * `shouldStopStartingWork` is consulted before each item is picked up, so a
 * shutdown stops the pool from *starting* work it has not begun while letting
 * everything already in flight finish. It never interrupts a running task.
 * Items left unstarted are not lost: they are claimed rows, and their leases
 * expire into the recovery sweep (ARCHITECTURE.md section 31). Defaulting it to
 * "never stop" keeps existing callers unchanged.
 */
export async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  shouldStopStartingWork: () => boolean = () => false,
): Promise<void> {
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      if (shouldStopStartingWork()) {
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      await task(items[index] as T);
    }
  };

  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    runners.push(runner());
  }

  await Promise.all(runners);
}
