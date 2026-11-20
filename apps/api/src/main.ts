import { createApp } from './app';
import { config } from './config';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';

async function main() {
  const app = await createApp();
  const hosted = process.env.JOB_AGENT_HOSTED === 'true';
  if (hosted) {
    if (!process.env.DATABASE_URL || !config.cookieSecure || !process.env.WEB_ORIGIN?.startsWith('https://') ||
        process.env.ASSIST === 'local' || !process.env.JOB_AGENT_SIGNUP_EMAILS?.trim() ||
        !process.env.JOB_AGENT_SIGNUP_CODE_HASHES?.trim()) {
      throw new Error('Hosted mode requires a database URL, HTTPS origin, secure cookies, signup invitations and local assist disabled.');
    }
    const web = join(__dirname, '../../../web/dist');
    const index = join(web, 'index.html');
    if (!existsSync(index)) throw new Error('Build the web app before starting hosted mode.');
    (app as NestExpressApplication).useStaticAssets(web, { index: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && req.accepts('html') && !/^\/(api|assets)(\/|$)/.test(req.path)) {
        return res.sendFile(index);
      }
      next();
    });
  }
  await app.listen(config.port, hosted ? '0.0.0.0' : '127.0.0.1');
  console.log(`API listening on http://localhost:${config.port}/api`);
}

void main();
