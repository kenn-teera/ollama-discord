// Conversation histories, keyed by channel (or channel and user). Questions in one conversation are answered one at a time,
// so overlapping questions cannot interleave or overwrite each other's history, and a reset during a slow reply is respected.
export function createConversations() {
  const histories = new Map();
  const tails = new Map(); // key -> promise of the last queued task
  const resets = new Map(); // key -> how many times it was reset
  let clears = 0; // how many times everything was cleared
  const stamp = (key) => `${clears}:${resets.get(key) ?? 0}`;

  return {
    // A copy, so callers can add to it freely; nothing changes until save().
    get: (key) => [...(histories.get(key) ?? [])],
    // Read this before generating a reply and pass it to save(): if the conversation was reset meanwhile, save() does nothing.
    epoch: stamp,
    save(key, messages, epoch, limit) {
      if (epoch !== stamp(key)) return false;
      histories.set(key, messages.slice(-limit));
      return true;
    },
    reset(key) {
      histories.delete(key);
      resets.set(key, (resets.get(key) ?? 0) + 1);
    },
    clear() {
      histories.clear();
      resets.clear();
      clears++;
    },
    // Runs task after the previous task for the same key has finished (whether it succeeded or failed); other keys run in parallel.
    run(key, task) {
      const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => task());
      tails.set(key, next);
      const done = () => {
        if (tails.get(key) === next) tails.delete(key);
      };
      next.then(done, done);
      return next;
    },
    pending: () => tails.size,
  };
}
