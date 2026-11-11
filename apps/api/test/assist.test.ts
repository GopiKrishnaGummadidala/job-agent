import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { fillFrame, type FillData, type FillReport } from '../src/assist';

/** Local copies of the field shapes used by common ATS forms. No real site is contacted. */
const FORMS: Record<string, string> = {
  greenhouse: `
    <form id="f"><label for="first_name">First Name</label><input id="first_name" name="first_name">
    <label for="last_name">Last Name</label><input id="last_name" name="last_name">
    <label for="email">Email</label><input id="email" name="email" type="text">
    <label for="phone">Phone</label><input id="phone" name="phone">
    <label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
    <label for="cover_letter">Cover Letter</label><textarea id="cover_letter" name="cover_letter"></textarea>
    <label for="q1">Are you legally authorized to work in Germany?</label><input id="q1" name="question_1">
    <button type="submit">Submit application</button></form>`,
  lever: `
    <form id="f"><input name="name" placeholder="Full name"><input name="email" type="email">
    <input name="phone"><input name="urls[LinkedIn]" aria-label="LinkedIn URL">
    <input type="file" name="resume"><textarea name="comments"></textarea>
    <button type="submit">Submit application</button></form>`,
  ashby: `
    <form id="f"><input id="_systemfield_name" name="_systemfield_name"><input id="_systemfield_email" name="_systemfield_email" type="email">
    <input type="file" id="_systemfield_resume"><button type="submit">Submit</button></form>`,
};

let browser: Browser;
let resumePath: string;
before(async () => {
  browser = await chromium.launch();
  const dir = mkdtempSync(join(tmpdir(), 'assist-test-'));
  resumePath = join(dir, 'cv.pdf');
  writeFileSync(resumePath, '%PDF-1.4 test');
});
after(() => browser?.close());

const data: FillData = {
  draftId: 'test',
  applyUrl: 'https://example.test',
  fullName: 'Ada Lovelace King',
  email: 'ada@example.test',
  phone: '+49 40 1234',
  linkedinUrl: 'https://linkedin.com/in/ada',
  location: 'Hamburg',
  coverLetter: 'Dear team',
  answers: [{ question: 'Are you legally authorized to work in Germany?', answer: 'Yes' }],
  resume: null,
};

for (const [name, html] of Object.entries(FORMS)) {
  test(`assist fills a ${name}-style form and never submits it`, async () => {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.evaluate(() => {
      (window as any).submitted = false;
      document.getElementById('f')!.addEventListener('submit', (e) => {
        (window as any).submitted = true;
        e.preventDefault();
      });
    });
    const report: FillReport = { filled: [], notFound: [] };
    await fillFrame(page.mainFrame(), data, { resume: resumePath, cover: resumePath }, report);

    const value = (sel: string) => page.locator(sel).inputValue();
    if (name === 'greenhouse') {
      assert.equal(await value('#first_name'), 'Ada');
      assert.equal(await value('#last_name'), 'Lovelace King');
      assert.equal(await value('#cover_letter'), 'Dear team');
      assert.equal(await value('#q1'), 'Yes');
    }
    if (name === 'lever') {
      assert.equal(await value('input[name="name"]'), 'Ada Lovelace King');
      assert.equal(await value('input[name="urls[LinkedIn]"]'), 'https://linkedin.com/in/ada');
      assert.equal(await value('textarea[name="comments"]'), 'Dear team');
    }
    if (name === 'ashby') assert.equal(await value('#_systemfield_name'), 'Ada Lovelace King');
    assert.match(await value('input[type="file"]'), /cv\.pdf$/);
    assert.ok(report.filled.includes('Email') && report.filled.includes('Resume'), JSON.stringify(report));
    assert.equal(await page.evaluate(() => (window as any).submitted), false);
    await page.close();
  });
}

test('assist leaves fields the user already filled untouched', async () => {
  const page = await browser.newPage();
  await page.setContent('<input name="email" type="email" value="mine@example.test">');
  await fillFrame(page.mainFrame(), data, { resume: null, cover: resumePath }, { filled: [], notFound: [] });
  assert.equal(await page.locator('input').inputValue(), 'mine@example.test');
  await page.close();
});
