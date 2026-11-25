import { randomUUID } from 'node:crypto';

export class CheckIn {
  constructor(absenceMs, abandonMs) {
    this.absenceMs = absenceMs;
    this.abandonMs = abandonMs;
    this.present = false;
    this.mode = 'marketing';
    this.session = null;
    this.absentSince = null;
  }

  setPresence(present, now = Date.now()) {
    if (present === this.present) return;
    this.present = present;
    if (present) {
      if (this.mode === 'marketing') {
        this.mode = 'check-in';
        this.session = { id: randomUUID(), phase: 'ready' };
      }
      this.absentSince = null;
    } else {
      this.absentSince = now;
    }
  }

  setPhase(id, phase) {
    if (this.session?.id !== id) return false;
    const transitions = { ready: 'active', active: 'complete' };
    if (transitions[this.session.phase] !== phase) return false;
    this.session.phase = phase;
    return true;
  }

  tick(now = Date.now()) {
    if (this.absentSince === null) return;
    const elapsed = now - this.absentSince;
    const wait = this.session.phase === 'active'
      ? Math.max(this.absenceMs, this.abandonMs)
      : this.absenceMs;
    if (elapsed < wait) return;
    this.mode = 'marketing';
    this.session = null;
    this.absentSince = null;
  }
}
