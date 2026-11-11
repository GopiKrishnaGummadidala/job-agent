import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createApp } from '../src/app';
import { config } from '../src/config';

process.env.SCHEDULER = 'off';
// The suite registers many accounts from one IP; production keeps the default limit.
process.env.AUTH_RATE_LIMIT = '1000';

export interface TestUser {
  id: string;
  email: string;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
}

export class Harness {
  app!: INestApplication;
  base = '';
  owner!: Client;

  async start() {
    this.app = await createApp();
    this.app.useLogger(false);
    await this.app.listen(0, '127.0.0.1');
    const addr = this.app.getHttpServer().address();
    this.base = `http://127.0.0.1:${addr.port}/api`;
    this.owner = new Client({ connectionString: config.migrateUrl });
    await this.owner.connect();
  }

  async stop() {
    await this.owner?.end();
    await this.app?.close();
  }

  async user(): Promise<TestUser> {
    const email = `u-${randomUUID()}@example.test`;
    const res = await fetch(`${this.base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'job-agent' },
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const { id } = (await res.json()) as any;
    const call: TestUser['call'] = async (method, path, body, headers = {}) => {
      const isForm = body instanceof FormData;
      const r = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          cookie,
          'x-requested-with': 'job-agent',
          ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: r.status, body: parsed };
    };
    return { id, email, call };
  }

  /** Creates a board with one open job without touching the network, and subscribes the users. */
  async seedJob(
    users: TestUser[],
    over: Partial<{
      title: string;
      description: string;
      location: string;
      company: string;
      employment_type: string;
      workplace: string;
      seniority: string;
      posted_days_ago: number;
    }> = {},
  ) {
    const token = `test-${randomUUID().slice(0, 8)}`;
    const [board] = (
      await this.owner.query(`insert into boards (kind, token, company_name, last_synced_at) values ('greenhouse', $1, 'Acme', now()) returning id`, [token])
    ).rows;
    const [job] = (
      await this.owner.query(
        `insert into jobs (board_id, external_id, company, title, location, remote, url, apply_url, description, content_hash,
                           employment_type, workplace, seniority, posted_at)
         values ($1, '1', $5, $2, $3, $7 = 'remote', 'https://example.test/job/1', 'https://example.test/job/1/apply', $4, 'h1',
                 $6, $7, $8, now() - make_interval(days => $9))
         returning id`,
        [
          board.id,
          over.title ?? 'Senior Backend Engineer',
          over.location ?? 'Remote',
          over.description ?? 'We use TypeScript and PostgreSQL.',
          over.company ?? 'Acme',
          over.employment_type ?? 'full_time',
          over.workplace ?? 'remote',
          over.seniority ?? 'senior',
          over.posted_days_ago ?? 0,
        ],
      )
    ).rows;
    for (const u of users) {
      await this.owner.query('insert into job_sources (user_id, board_id) values ($1, $2)', [u.id, board.id]);
    }
    return { boardId: board.id as string, jobId: job.id as string };
  }
}

/** A minimal valid one-page PDF containing the given text. */
export function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function resumeForm(buf: Buffer, name = 'resume.pdf') {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), name);
  return fd;
}
