type Listener = (timestamp: number | null, pinned: boolean) => void;

class ChartCoordinator {
  private frame: number | null = null;
  private listeners = new Set<Listener>();
  private pendingTimestamp: number | null = null;
  private pinned = false;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(timestamp: number | null) {
    if (this.pinned) return;
    this.pendingTimestamp = timestamp;
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.pinned) return;
      for (const listener of this.listeners) listener(this.pendingTimestamp, false);
    });
  }

  togglePin(timestamp: number | null) {
    this.pinned = !this.pinned;
    this.pendingTimestamp = this.pinned ? timestamp : null;
    for (const listener of this.listeners) listener(this.pendingTimestamp, this.pinned);
  }

  clearPin() {
    if (!this.pinned) return;
    this.pinned = false;
    this.pendingTimestamp = null;
    for (const listener of this.listeners) listener(null, false);
  }

  snapshot() {
    return { pinned: this.pinned, timestamp: this.pendingTimestamp };
  }
}

export const chartCoordinator = new ChartCoordinator();
