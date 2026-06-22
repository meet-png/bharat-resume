// Tiny in-process concurrency limiter (no dependency). Caps how many heavy
// async tasks run at once; the rest queue FIFO and start as slots free up.
// Used to bound concurrent Puppeteer render + watermark pipelines so a burst of
// inbound WhatsApp messages can't spawn N Chromium renders and OOM the box.
//
// In-process only — one limiter per Node process. On a single Railway instance
// that is exactly the memory boundary we care about; if scaled horizontally,
// each instance bounds its own renders, which is the desired behaviour.
function createLimiter(max) {
  const limit = Math.max(1, max | 0);
  let active = 0;
  const queue = [];

  const drain = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        drain();
      });
  };

  // Wrap an async thunk; returns a promise that settles with the thunk's result
  // but only runs once a slot is free.
  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      drain();
    });
  }

  run.stats = () => ({ active, queued: queue.length, limit });
  return run;
}

module.exports = { createLimiter };
