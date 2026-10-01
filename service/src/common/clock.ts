/** Injection token for the clock. */
export const CLOCK = Symbol('CLOCK')

export interface Clock {
  now(): Date
}

/**
 * The legacy API reads QUAYSIDE_NOW to freeze time for QA. The new service
 * honours the same variable, which is what lets recordings replay exactly.
 */
export const systemClock: Clock = {
  now: () => (process.env.QUAYSIDE_NOW ? new Date(process.env.QUAYSIDE_NOW) : new Date()),
}

const pad = (n: number) => String(n).padStart(2, '0')

export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function stamp(d: Date): string {
  return `${ymd(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function parseDay(s: unknown): Date | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}
