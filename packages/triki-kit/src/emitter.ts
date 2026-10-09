/** Крошечный типизированный emitter. Ошибка в слушателе не ломает поток данных. */
export class Emitter<M extends object> {
  private map = new Map<keyof M, Set<(payload: never) => void>>()

  on<K extends keyof M>(name: K, fn: (payload: M[K]) => void): () => void {
    let set = this.map.get(name)
    if (!set) this.map.set(name, (set = new Set()))
    set.add(fn as (payload: never) => void)
    return () => void set.delete(fn as (payload: never) => void)
  }

  emit<K extends keyof M>(name: K, payload: M[K]): void {
    const set = this.map.get(name)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as (p: M[K]) => void)(payload)
      } catch (e) {
        queueMicrotask(() => {
          throw e
        })
      }
    }
  }

  has(name: keyof M): boolean {
    return (this.map.get(name)?.size ?? 0) > 0
  }

  clear(): void {
    this.map.clear()
  }
}
