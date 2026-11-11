import 'reflect-metadata';
import {
  ArgumentsHost,
  Catch,
  ConflictException,
  Controller,
  ExceptionFilter,
  ForbiddenException,
  Get,
  HttpException,
  INestApplication,
  Logger,
  Module,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AiService } from './ai/ai.service';
import { AssistService } from './assist';
import { AuthController, AuthGuard, AuthService } from './auth';
import { config } from './config';
import { Db } from './db';
import { DraftsController } from './drafts';
import { JobsController } from './jobs';
import { MatchingService } from './matching/matching.service';
import { ProfileController } from './profile';
import { ResumesController } from './resumes';
import { SourcesController, SourcesService } from './sources/sources';

@Controller('me/ai')
@UseGuards(AuthGuard)
class AiController {
  constructor(private ai: AiService) {}

  @Get('options')
  options() {
    return this.ai.options();
  }
}

@Controller('health')
class HealthController {
  constructor(private db: Db) {}

  @Get()
  async health() {
    await this.db.query('select 1');
    return { ok: true };
  }
}

@Module({
  controllers: [
    HealthController,
    AuthController,
    ProfileController,
    SourcesController,
    JobsController,
    ResumesController,
    DraftsController,
    AiController,
  ],
  providers: [Db, AuthService, AuthGuard, MatchingService, SourcesService, AiService, AssistService],
})
export class AppModule {}

/** Maps database constraint errors to 409 and hides internals of unexpected errors. */
@Catch()
class ErrorFilter implements ExceptionFilter {
  private log = new Logger('Error');

  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let err: HttpException;
    if (e instanceof HttpException) err = e;
    else if (e?.code === '23505' || e?.code === '23503') err = new ConflictException('This conflicts with existing data.');
    else if (e?.code === '42501') err = new ForbiddenException();
    else {
      this.log.error(e?.stack ?? e);
      err = new HttpException('Something went wrong.', 500);
    }
    const body = err.getResponse();
    const message = typeof body === 'string' ? body : (body as any).message;
    res.status(err.getStatus()).json({ statusCode: err.getStatus(), message });
  }
}

/** CSRF defence for cookie auth: state-changing requests must carry a header a cross-site form cannot set. */
function requireAppHeader(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-requested-with') === 'job-agent') return next();
  res.status(403).json({ statusCode: 403, message: 'Missing X-Requested-With header.' });
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use((_: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    next();
  });
  app.use(requireAppHeader);
  app.useGlobalFilters(new ErrorFilter());
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.enableShutdownHooks();
  return app;
}
