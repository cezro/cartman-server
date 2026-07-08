import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

interface RequestWithUser {
  method: string;
  originalUrl?: string;
  url: string;
  user?: { id?: string };
}

interface ResponseLike {
  statusCode: number;
}

/**
 * Logs method, path, status, duration, and user id (when authenticated) for
 * every request. Deliberately never logs request/response bodies — those
 * can carry PII (phone numbers, addresses, OTP codes).
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse<ResponseLike>();
    const start = Date.now();
    const { method } = request;
    const path = request.originalUrl ?? request.url;

    return next.handle().pipe(
      tap({
        next: () =>
          this.logRequest(method, path, response.statusCode, start, request),
        error: (err: unknown) =>
          this.logRequest(
            method,
            path,
            this.statusFromError(err, response),
            start,
            request,
          ),
      }),
    );
  }

  private statusFromError(err: unknown, response: ResponseLike): number {
    if (
      err &&
      typeof err === 'object' &&
      'getStatus' in err &&
      typeof err.getStatus === 'function'
    ) {
      return (err as { getStatus: () => number }).getStatus();
    }
    return response.statusCode || 500;
  }

  private logRequest(
    method: string,
    path: string,
    statusCode: number,
    start: number,
    request: RequestWithUser,
  ): void {
    const durationMs = Date.now() - start;
    const userId = request.user?.id ? ` user=${request.user.id}` : '';
    this.logger.log(`${method} ${path} ${statusCode} ${durationMs}ms${userId}`);
  }
}
