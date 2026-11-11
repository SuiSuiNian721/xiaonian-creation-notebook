export class Drafts {
  #values = new Map();
  read(key, base) { return structuredClone(this.#values.has(key) ? this.#values.get(key) : base); }
  write(key, value) { this.#values.set(key, structuredClone(value)); }
  commit(key, saved) {
    if (JSON.stringify(this.#values.get(key)) === JSON.stringify(saved)) this.#values.delete(key);
  }
  reconcile(key, submitted, saved) {
    const current = this.read(key, submitted);
    for (const field of Object.keys(submitted)) {
      if (current[field] === submitted[field]) current[field] = saved[field] ?? '';
    }
    this.write(key, current);
    if (Object.keys(current).every(field => current[field] === (saved[field] ?? ''))) this.#values.delete(key);
  }
}
