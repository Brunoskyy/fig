import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import type { Request, Response } from 'express'

import type { JsonLogger } from './logger.ts'

/**
 * A request the service rejects on validation, in the legacy wire format
 * (Q11): `400 {"error": "bad request", "detail": "..."}`.
 */
export class LegacyBadRequest extends Error {
  constructor(readonly detail: string) {
    super(detail)
  }
}

/** A lookup that missed, in the new format: a real 404 with a code (the Q9 fix). */
export class NotFound extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`)
  }
}

@Catch()
export class LegacyErrorsFilter implements ExceptionFilter {
  constructor(private readonly logger?: JsonLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    if (res.headersSent) {
      this.unexpected(error, host)
      res.destroy()
      return
    }
    if (error instanceof LegacyBadRequest) {
      res.status(400).json({ error: 'bad request', detail: error.detail })
      return
    }
    if (error instanceof NotFound) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: error.message } })
      return
    }
    // Nest turns body-parser's parse failure into a BadRequestException. The
    // service throws no other 400s of its own, so this is the malformed-JSON case.
    const type = (error as { type?: string }).type
    if (type === 'entity.parse.failed' || (error instanceof HttpException && error.getStatus() === HttpStatus.BAD_REQUEST)) {
      res.status(400).json({ error: 'bad request', detail: 'invalid JSON' })
      return
    }
    if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
      res.status(404).json({ error: { code: 'NO_ROUTE', message: 'no such route' } })
      return
    }
    // Everything else, including an oversized body, is a bare 500 in the legacy
    // app too; callers only ever saw that text. The cause goes to the log, with
    // the request id, so the 500 can be found and fixed.
    this.unexpected(error, host)
    res.status(500).type('text/plain').send('Internal Server Error')
  }

  private unexpected(error: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>()
    const res = host.switchToHttp().getResponse<Response>()
    const e = error instanceof Error ? error : new Error(String(error))
    this.logger?.failure(e, {
      requestId: res.getHeader('x-request-id'),
      method: req.method,
      path: req.originalUrl,
      type: (error as { type?: string }).type,
    })
  }
}
