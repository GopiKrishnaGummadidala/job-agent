import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companyFromSender, responseOutcome, senderAddress } from '../src/interview-responses';

test('distinguishes interviews from acknowledgements and uncertain replies', () => {
  assert.equal(responseOutcome('We received your application'), 'unrelated');
  assert.equal(responseOutcome('Vielen Dank für Ihre Bewerbung'), 'unrelated');
  assert.equal(responseOutcome('Interview invitation — Engineer'), 'positive');
  assert.equal(responseOutcome('Einladung zum Vorstellungsgespräch'), 'positive');
  assert.equal(responseOutcome('Your application for Engineer', 'We would like to invite you for an interview'), 'positive');
  assert.equal(responseOutcome('Absage nach dem Interview'), 'rejected');
  assert.equal(responseOutcome('Next steps'), 'review');
});

test('extracts the company display name and the Workable sender identity independently', () => {
  const from = '"Example via Workable" <4f54m_ff28rt@inbound.workablemail.com>';
  assert.equal(companyFromSender(from), 'Example');
  assert.equal(senderAddress(from), '4f54m_ff28rt@inbound.workablemail.com');
});
