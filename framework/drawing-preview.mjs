const ACTIVE = new Set(['submitting', 'queued', 'running', 'unknown']);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const terminal = new Set(['execution_success', 'execution_error', 'execution_interrupted']);

function decode(bytes) {
  if (bytes.length < 12) return null;
  const type = bytes.readUInt32BE(0); let mime, promptId, start = 8;
  if (type === 1) {
    mime = { 1: 'image/jpeg', 2: 'image/png' }[bytes.readUInt32BE(4)];
  } else if (type === 4) {
    const length = bytes.readUInt32BE(4);
    if (length > 16384 || length < 2 || 8 + length >= bytes.length) return null;
    let metadata; try { metadata = JSON.parse(bytes.subarray(8, 8 + length).toString('utf8')); } catch { return null; }
    if (!metadata || typeof metadata.prompt_id !== 'string' || metadata.prompt_id.length > 160) return null;
    promptId = metadata.prompt_id; mime = metadata.image_type; start += length;
  } else return null;
  const image = bytes.subarray(start);
  if (mime === 'image/png') {
    if (image.length < 33 || !image.subarray(0, 8).equals(PNG) || image.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192) return null;
  } else if (mime === 'image/jpeg') {
    if (image.length < 5 || image[0] !== 255 || image[1] !== 216 || image[2] !== 255 || image.at(-2) !== 255 || image.at(-1) !== 217) return null;
  } else return null;
  return { mime, promptId, bytes: Buffer.from(image) };
}

// Preview pixels are ephemeral: never store them in job JSON or the image archive.
export class DrawingPreviews {
  constructor({ lookup, now = Date.now, ttlMs = 120000, maxFrameBytes = 4 * 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024 }) {
    Object.assign(this, { lookup, now, ttlMs, maxFrameBytes, maxTotalBytes });
    this.sessions = new Map(); this.frames = new Map(); this.bytes = 0; this.sequence = 0;
  }
  open(source) {
    this.disconnect(this.sessions.get(source));
    const session = { source, active: null, retired: new Set() };
    this.sessions.set(source, session); return session;
  }
  current(session) { return !!session && this.sessions.get(session.source) === session; }
  note(session, message) {
    if (!this.current(session) || !message || typeof message !== 'object') return;
    const data = message.data || {}, id = data.prompt_id;
    if (typeof id !== 'string') return;
    if (terminal.has(message.type) || message.type === 'executing' && data.node === null) {
      session.retired.add(id);
      if (session.retired.size > 200) session.retired.delete(session.retired.values().next().value);
      if (session.active === id) session.active = null;
      const job = this.lookup(session.source, id); if (job) this.dropJob(job.id);
    } else if (['execution_start', 'executing', 'progress'].includes(message.type)) {
      // A foreign client's execution event deliberately clears the old association.
      session.active = id;
    }
  }
  async receive(session, data) {
    if (!this.current(session)) return;
    const size = data instanceof Blob ? data.size : data?.byteLength;
    if (!Number.isFinite(size) || size < 12 || size > this.maxFrameBytes) return;
    const version = ++this.sequence, active = session.active;
    try {
      const bytes = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
      if (!this.current(session)) return;
      const frame = decode(bytes); if (!frame) return;
      const id = frame.promptId ?? active;
      if (!id || session.retired.has(id) || !frame.promptId && active !== session.active) return;
      const job = this.lookup(session.source, id);
      if (!job || !ACTIVE.has(job.status) || job.serviceUrl !== session.source) return;
      if ((this.frames.get(job.id)?.version || 0) >= version) return;
      this.dropJob(job.id); this.prune();
      if (frame.bytes.length > this.maxTotalBytes) return;
      while (this.bytes + frame.bytes.length > this.maxTotalBytes || this.frames.size >= 8) this.dropJob(this.frames.keys().next().value);
      this.frames.set(job.id, { ...frame, source: session.source, version, updatedAt: this.now() }); this.bytes += frame.bytes.length;
    } catch { /* Malformed upstream frames must not interrupt generation. */ }
  }
  get(job) {
    this.prune();
    if (!ACTIVE.has(job.status)) { this.dropJob(job.id); return null; }
    const frame = this.frames.get(job.id);
    return frame?.source === job.serviceUrl ? frame : null;
  }
  dropJob(id) { const frame = this.frames.get(id); if (frame) { this.bytes -= frame.bytes.length; this.frames.delete(id); } }
  prune() { for (const [id, frame] of this.frames) if (this.now() - frame.updatedAt > this.ttlMs) this.dropJob(id); }
  disconnect(session) {
    if (!this.current(session)) return;
    this.sessions.delete(session.source);
    for (const [id, frame] of this.frames) if (frame.source === session.source) this.dropJob(id);
  }
  close() { this.sessions.clear(); this.frames.clear(); this.bytes = 0; }
}
