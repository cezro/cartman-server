import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Global exception filter. HttpExceptions (BadRequestException,
 * UnauthorizedException, the ValidationPipe's 400s, etc.) pass through
 * unchanged — their existing shape/status is exactly what mobile clients
 * already parse (see CartmanApiException in cartman-mobile's
 * cartman_api_client.dart). Anything else (a thrown Prisma error, a bug) is
 * logged in full server-side but the client only ever sees a generic
 * `{statusCode: 500, message: 'Internal server error'}` — never a stack
 * trace or raw error message, in any environment.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
