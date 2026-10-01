import { randomUUID } from 'node:crypto'
import type { LoggerService } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

type Level = 'debug' | 'info' | 'warn' | 'error'

/**
 * One JSON object per line, with the request id when there is one. The edge
 * proxy sets `x-request-id`; the legacy app ignores it, the new service logs
 * it, so a request can be followed across both.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(l + '\n')) {}

  private emit(level: Level, message: unknown, context?: unknown, extra: Record<string, unknown> = {}): void {
    if (process.env.QUAYSIDE_QUIET === '1' && level !== 'error') return
    this.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        context: typeof context === 'string' ? context : undefined,
        msg: typeof message === 'string' ? message : JSON.stringify(message),
        ...extra,
      }),
    )
  }

  log(message: unknown, context?: unknown): void {
    this.emit('info', message, context)
  }
  error(message: unknown, trace?: unknown, context?: unknown): void {
    this.emit('error', message, context, typeof trace === 'string' ? { trace } : {})
  }
  warn(message: unknown, context?: unknown): void {
    this.emit('warn', message, context)
  }
  debug(message: unknown, context?: unknown): void {
    this.emit('debug', message, context)
  }

  request(fields: Record<string, unknown>): void {
    this.emit('info', 'request', 'http', fields)
  }
}

/** Express middleware: keeps or creates a request id and logs the request when it finishes. */
export function requestLog(logger: JsonLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['x-request-id']
    const id = typeof header === 'string' && header.length <= 100 ? header : randomUUID()
    res.setHeader('x-request-id', id)
    const started = process.hrtime.bigint()
    res.on('finish', () => {
      logger.request({
        requestId: id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      })
    })
    next()
  }
}
