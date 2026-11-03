/**
 * Work that runs after the response, in this process, bounded in both directions: at most
 * `maxLength` jobs wait and at most `concurrency` run. A job that does not fit is dropped,
 * so a flood costs a count and not the pool. An error in a job goes to `onError` and harms
 * nothing else.
 */
export function createBoundedQueue<Job>({
  maxLength,
  concurrency,
  run,
  onError,
  onOverflow,
}: {
  maxLength: number;
  concurrency: number;
  run: (job: Job) => Promise<unknown>;
  onError: (error: unknown) => void;
  /** Told each drop, with how many this queue has dropped so far. */
  onOverflow: (dropped: number) => void;
}) {
  const waiting: Job[] = [];
  let running = 0;
  let dropped = 0;
  let draining = false;
  let idle: (() => void) | undefined;

  function pump() {
    while (running < concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      running++;
      void Promise.resolve()
        .then(() => run(job))
        .catch(onError)
        .finally(() => {
          running--;
          pump();
          if (running === 0 && waiting.length === 0) idle?.();
        });
    }
  }

  return {
    /** Whether the job was taken. It starts no sooner than the next turn of the event
     * loop, so the response comes first. */
    enqueue(job: Job) {
      if (draining || waiting.length >= maxLength) {
        onOverflow(++dropped);
        return false;
      }
      waiting.push(job);
      setImmediate(pump);
      return true;
    },
    /**
     * Take no more and wait for what is here, until the deadline. What has not started by
     * then is abandoned; what is still running is reported and left to fail on its own.
     */
    async drain(deadlineMs: number) {
      draining = true;
      if (running > 0 || waiting.length > 0) {
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          new Promise<void>((resolve) => {
            idle = resolve;
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, deadlineMs);
          }),
        ]);
        clearTimeout(timer!);
      }
      return { abandoned: waiting.splice(0).length, running };
    },
  };
}
