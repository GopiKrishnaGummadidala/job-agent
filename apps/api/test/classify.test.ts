import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  employmentFromLabel,
  inferEmployment,
  inferSeniority,
  inferWorkplace,
  seniorityFromLabel,
  workplaceFromLabel,
} from '../src/sources/classify';

test('board employment labels map to types', () => {
  assert.equal(employmentFromLabel('Full-time'), 'full_time');
  assert.equal(employmentFromLabel('FullTime'), 'full_time');
  assert.equal(employmentFromLabel('Permanent'), 'full_time');
  assert.equal(employmentFromLabel('PartTime'), 'part_time');
  assert.equal(employmentFromLabel('Intern'), 'internship');
  assert.equal(employmentFromLabel('Scholarship'), 'internship');
  assert.equal(employmentFromLabel('Short Term'), 'temporary');
  assert.equal(employmentFromLabel('Contract'), 'contract');
  assert.equal(employmentFromLabel(undefined), null);
});

test('employment type is inferred from titles', () => {
  assert.equal(inferEmployment('Werkstudent Softwareentwicklung (m/w/d)', ''), 'working_student');
  assert.equal(inferEmployment('Software Engineering Intern', ''), 'internship');
  assert.equal(inferEmployment('Internal Tools Engineer', ''), 'full_time', '"Internal" is not an internship');
  assert.equal(inferEmployment('Backend Developer (Part-time)', ''), 'part_time');
  assert.equal(inferEmployment('Senior .NET Contractor', ''), 'contract');
  assert.equal(inferEmployment('Backend Engineer', 'You will own our contract testing suite.'), 'full_time');
});

test('workplace uses board labels first and infers otherwise', () => {
  assert.equal(workplaceFromLabel('OnSite'), 'onsite');
  assert.equal(workplaceFromLabel('hybrid'), 'hybrid');
  assert.equal(workplaceFromLabel('unspecified'), null);
  assert.equal(inferWorkplace('Engineer', 'Remote, EMEA', ''), 'remote');
  assert.equal(inferWorkplace('Engineer', 'Hamburg (Hybrid)', ''), 'hybrid');
  assert.equal(inferWorkplace('Engineer', 'Berlin', 'We offer a hybrid working model.'), 'hybrid');
  assert.equal(inferWorkplace('Engineer', 'Berlin', ''), 'onsite');
});

test('seniority comes from the title', () => {
  assert.equal(inferSeniority('Senior Staff Engineer', 'full_time'), 'staff');
  assert.equal(inferSeniority('Engineering Manager', 'full_time'), 'lead');
  assert.equal(inferSeniority('Sr. Backend Engineer', 'full_time'), 'senior');
  assert.equal(inferSeniority('Junior Developer', 'full_time'), 'junior');
  assert.equal(inferSeniority('Backend Engineer', 'full_time'), 'mid');
  assert.equal(inferSeniority('Engineering Intern', 'internship'), 'intern');
});

test('board experience labels map to seniority', () => {
  assert.equal(seniorityFromLabel('entry-level'), 'junior');
  assert.equal(seniorityFromLabel('student_college'), 'intern');
  assert.equal(seniorityFromLabel('Mid-Senior level'), 'mid');
  assert.equal(seniorityFromLabel('executive'), 'lead');
  assert.equal(seniorityFromLabel('experienced'), null, 'too generic; the title decides');
  assert.equal(seniorityFromLabel(undefined), null);
});
