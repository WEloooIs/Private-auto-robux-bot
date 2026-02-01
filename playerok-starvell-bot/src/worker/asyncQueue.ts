export type Job<T> = () => Promise<T>;

export class AsyncQueue {
  private running = false;
  private q: Array<{
    id: string;
    job: Job<any>;
    resolve: (v: any) => void;
    reject: (e: any) => void;
  }> = [];

  enqueue<T>(id: string, job: Job<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.q.push({ id, job, resolve, reject });
      void this.pump();
    });
  }

  size(): number {
    return this.q.length;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;

    while (this.q.length) {
      const item = this.q.shift()!;
      try {
        const res = await item.job();
        item.resolve(res);
      } catch (e) {
        item.reject(e);
      }
    }

    this.running = false;
  }
}
