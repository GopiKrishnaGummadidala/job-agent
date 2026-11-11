import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Frame, Page } from 'playwright';
import { config } from './config';

export interface FillData {
  draftId: string;
  applyUrl: string;
  fullName: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  location: string;
  coverLetter: string;
  answers: { question: string; answer: string }[];
  resume: { filename: string; content: Buffer } | null;
}

export interface FillReport {
  filled: string[];
  notFound: string[];
}

/**
 * Browser-assisted application: opens the employer's apply page in a visible browser on this
 * machine and pre-fills fields from the approved snapshot. It never clicks submit and never
 * attempts to pass CAPTCHAs or log-ins; the user reviews and submits in that window.
 */
@Injectable()
export class AssistService implements OnModuleDestroy {
  private log = new Logger('Assist');
  private browser?: Browser;

  async open(data: FillData): Promise<FillReport> {
    if (!config.assist) {
      throw new BadRequestException('Browser assist is turned off on this server (set ASSIST=local to enable it).');
    }
    const url = new URL(data.applyUrl);
    if (url.protocol !== 'https:') throw new BadRequestException('Only https apply pages can be opened.');

    const { chromium } = await import('playwright');
    if (!this.browser?.isConnected()) this.browser = await chromium.launch({ headless: false });
    const context = await this.browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    const dir = join(tmpdir(), 'job-agent-assist', data.draftId);
    mkdirSync(dir, { recursive: true });
    const files = {
      resume: data.resume ? join(dir, data.resume.filename) : null,
      cover: join(dir, 'cover-letter.txt'),
    };
    if (data.resume && files.resume) writeFileSync(files.resume, data.resume.content);
    writeFileSync(files.cover, data.coverLetter, 'utf8');

    const report: FillReport = { filled: [], notFound: [] };
    for (const frame of page.frames()) {
      await fillFrame(frame, data, files, report).catch((e) => this.log.warn(`Frame fill failed: ${e.message}`));
    }
    report.filled = [...new Set(report.filled)];
    report.notFound = [...new Set(report.notFound)].filter((f) => !report.filled.includes(f));
    await showBanner(page, report).catch(() => undefined);
    return report;
  }

  async onModuleDestroy() {
    await this.browser?.close().catch(() => undefined);
  }
}

async function fillText(frame: Frame, selectors: string[], value: string): Promise<boolean> {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = frame.locator(sel);
    const n = Math.min(await loc.count(), 3);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible()) || !(await el.isEditable())) continue;
      if ((await el.inputValue()).trim()) return true; // already filled; leave the user's value alone
      await el.fill(value);
      return true;
    }
  }
  return false;
}

async function setFile(frame: Frame, selectors: string[], path: string | null): Promise<boolean> {
  if (!path) return false;
  for (const sel of selectors) {
    const loc = frame.locator(sel);
    if (await loc.count()) {
      await loc.first().setInputFiles(path);
      return true;
    }
  }
  return false;
}

export async function fillFrame(
  frame: Frame,
  d: FillData,
  files: { resume: string | null; cover: string },
  r: FillReport,
) {
  const [first, ...rest] = d.fullName.trim().split(/\s+/);
  const last = rest.join(' ');
  const mark = (label: string, ok: boolean) => (ok ? r.filled : r.notFound).push(label);

  const firstOk = await fillText(frame, ['input[autocomplete="given-name"]', 'input[name*="first" i]', 'input[id*="first" i]'], first ?? '');
  const lastOk = await fillText(frame, ['input[autocomplete="family-name"]', 'input[name*="last" i]', 'input[id*="last" i]'], last);
  if (!firstOk && !lastOk) {
    mark('Name', await fillText(frame, ['input[autocomplete="name"]', 'input[name="name"]', 'input[name="_systemfield_name"]', 'input[id*="full" i][id*="name" i]'], d.fullName));
  } else {
    mark('Name', true);
  }
  mark('Email', await fillText(frame, ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]'], d.email));
  mark('Phone', await fillText(frame, ['input[type="tel"]', 'input[name*="phone" i]', 'input[id*="phone" i]'], d.phone));
  if (d.linkedinUrl) {
    mark('LinkedIn', await fillText(frame, ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[aria-label*="linkedin" i]'], d.linkedinUrl));
  }

  mark('Resume', await setFile(frame, ['input[type="file"][name*="resume" i]', 'input[type="file"][id*="resume" i]', 'input[type="file"][name*="cv" i]'], files.resume));

  const coverText = await fillText(frame, ['textarea[name*="cover" i]', 'textarea[id*="cover" i]', 'textarea[name="comments"]'], d.coverLetter);
  mark('Cover letter', coverText || (await setFile(frame, ['input[type="file"][name*="cover" i]', 'input[type="file"][id*="cover" i]'], files.cover)));

  for (const a of d.answers) {
    if (!a.question.trim() || !a.answer.trim()) continue;
    const label = a.question.length > 60 ? a.question.slice(0, 60) : a.question;
    let ok = false;
    try {
      const field = frame.getByLabel(label, { exact: false }).first();
      if ((await field.count()) && (await field.isVisible()) && (await field.isEditable())) {
        if (!(await field.inputValue()).trim()) await field.fill(a.answer);
        ok = true;
      }
    } catch {
      ok = false;
    }
    mark(`Answer: ${label}`, ok);
  }
}

async function showBanner(page: Page, r: FillReport) {
  await page.evaluate((report) => {
    const el = document.createElement('div');
    el.setAttribute('style', 'position:fixed;z-index:2147483647;left:12px;right:12px;bottom:12px;padding:12px 16px;border-radius:8px;background:#1e293b;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)');
    const title = document.createElement('strong');
    title.textContent = 'Job Agent pre-filled this form. Review every field, complete the rest, then submit it yourself.';
    const detail = document.createElement('div');
    detail.textContent = `Filled: ${report.filled.join(', ') || 'nothing'}. Not found: ${report.notFound.join(', ') || 'none'}.`;
    const close = document.createElement('button');
    close.textContent = 'Hide';
    close.setAttribute('style', 'float:right;margin-left:12px;background:#334155;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer');
    close.onclick = () => el.remove();
    el.append(close, title, detail);
    document.body.appendChild(el);
  }, r);
}
