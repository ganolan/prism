import '@testing-library/jest-dom';

// Node 25 ships a built-in `localStorage` global that lacks the full Web
// Storage API (no `.clear()`), and it shadows jsdom's implementation. Install
// a spec-compliant in-memory Storage so tests get a real localStorage.
class MemoryStorage {
  #store = new Map();
  get length() {
    return this.#store.size;
  }
  clear() {
    this.#store.clear();
  }
  getItem(key) {
    const k = String(key);
    return this.#store.has(k) ? this.#store.get(k) : null;
  }
  setItem(key, value) {
    this.#store.set(String(key), String(value));
  }
  removeItem(key) {
    this.#store.delete(String(key));
  }
  key(index) {
    return [...this.#store.keys()][index] ?? null;
  }
}

const memoryStorage = new MemoryStorage();
for (const target of [globalThis, globalThis.window]) {
  if (target) {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      value: memoryStorage,
    });
  }
}
