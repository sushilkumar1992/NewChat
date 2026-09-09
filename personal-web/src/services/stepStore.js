// A tiny external store for a stepper's state, shared between the inline Stepper and the Lightbox
// so that advancing in either place marks the previous step complete in both (two-way sync).
export function createStepStore(n) {
  let index = 0;
  const done = {};
  const listeners = new Set();
  const emit = () => listeners.forEach((l) => l());
  return {
    n,
    getSnapshot() { return index * 1000 + Object.keys(done).length; }, // cheap version key
    state() { return { index, done }; },
    next() { done[index] = true; if (index < n - 1) index++; emit(); },
    prev() { if (index > 0) index--; emit(); },
    goto(i) { if (i >= 0 && i < n) { index = i; emit(); } },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); }
  };
}
