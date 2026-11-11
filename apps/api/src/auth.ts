import {
  BadRequestException,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from './config';
import { Db } from './db';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 30;
const COOKIE = 'sid';

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  private attempts = new Map<string, { count: number; reset: number }>();

  constructor(private db: Db) {}

  /** 10 attempts per 15 minutes per key; in-memory is enough for a single instance. */
  throttle(key: string) {
    const now = Date.now();
    const a = this.attempts.get(key);
    if (!a || a.reset < now) {
      this.attempts.set(key, { count: 1, reset: now + 15 * 60_000 });
      return;
    }
    if (++a.count > 10) throw new HttpException('Too many attempts. Try again later.', 429);
  }

  async register(email: string, password: string): Promise<string> {
    const rows = await this.db.query(
      'insert into users (email, password_hash) values ($1, $2) on conflict (email) do nothing returning id',
      [email, await hashPassword(password)],
    );
    if (!rows[0]) throw new ConflictException('An account with this email already exists.');
    return rows[0].id;
  }

  async login(email: string, password: string): Promise<string> {
    const [user] = await this.db.query('select id, password_hash from users where email = $1', [email]);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    return user.id;
  }

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(
      `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), userId, SESSION_DAYS],
    );
    return token;
  }

  async userFromToken(token: string | undefined): Promise<{ id: string; email: string } | null> {
    if (!token) return null;
    const [row] = await this.db.query(
      `select u.id, u.email from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [sha256(token)],
    );
    return row ?? null;
  }

  async destroySession(token: string | undefined) {
    if (token) await this.db.query('delete from sessions where token_hash = $1', [sha256(token)]);
  }
}

type AuthedRequest = Request & { user?: { id: string; email: string } };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = await this.auth.userFromToken(req.cookies?.[COOKIE]);
    if (!user) throw new UnauthorizedException('Sign in required.');
    req.user = user;
    return true;
  }
}

/** The authenticated user's id. Only valid on routes behind AuthGuard. */
export const UserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user!.id,
);

const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private setCookie(res: Response, token: string) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: SESSION_DAYS * 86_400_000,
      path: '/',
    });
  }

  @Post('register')
  async register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(credentials, body);
    this.auth.throttle(`register:${req.ip}`);
    const id = await this.auth.register(email, password);
    this.setCookie(res, await this.auth.createSession(id));
    return { id, email };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(credentials.extend({ password: z.string().max(200) }), body);
    this.auth.throttle(`login:${req.ip}:${email}`);
    const id = await this.auth.login(email, password);
    this.setCookie(res, await this.auth.createSession(id));
    return { id, email };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.destroySession(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: AuthedRequest) {
    return req.user;
  }
}
