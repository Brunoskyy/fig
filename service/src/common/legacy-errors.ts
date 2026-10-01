import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import type { Response } from 'express'

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
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
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
    // app too; callers only ever saw that text.
    res.status(500).type('text/plain').send('Internal Server Error')
  }
}
