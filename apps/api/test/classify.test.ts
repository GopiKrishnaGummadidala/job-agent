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
import { boardHomeCountry, countriesOfName, coversCountry, inferCountries, jobCountries } from '../src/sources/countries';

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

test('countries come from country names, cities, codes and US states', () => {
  assert.deepEqual(inferCountries('Stuttgart, BW, Germany'), ['DE']);
  assert.deepEqual(inferCountries('Remote, Hamburg, Berlin, München'), ['DE']);
  assert.deepEqual(inferCountries('Göttingen'), ['DE']);
  assert.deepEqual(inferCountries('Remote - US'), ['US']);
  assert.deepEqual(inferCountries('Remote (US)'), ['US']);
  assert.deepEqual(inferCountries('New York, NY (HQ)'), ['US']);
  assert.deepEqual(inferCountries('Wilmington, DE'), ['US'], 'DE after a comma is Delaware');
  assert.deepEqual(inferCountries('London, UK'), ['GB']);
  assert.deepEqual(inferCountries('Remote, Canada; Remote, United States'), ['CA', 'US']);
  assert.deepEqual(inferCountries('Remote - European Union'), ['EU']);
  assert.deepEqual(inferCountries('bengaluru, , India'), ['IN']);
  assert.deepEqual(inferCountries('Remote'), []);
  assert.deepEqual(inferCountries('Breidenbach'), []);
  assert.deepEqual(inferCountries('Remote, KSA'), ['SA']);
  assert.deepEqual(jobCountries('Remote', 'Site Reliability Engineer, Infrastructure — US'), ['US']);
  assert.deepEqual(jobCountries('Remote', 'Software Engineer - Edge & Cloud (m/f/d)'), []);
  assert.deepEqual(jobCountries('Berlin', 'Engineer - US'), ['DE'], 'the location wins over the title');
});

test('country preferences and board home countries', () => {
  assert.deepEqual(countriesOfName('Germany'), ['DE']);
  assert.deepEqual(countriesOfName('dach'), ['DE', 'AT', 'CH']);
  assert.deepEqual(countriesOfName('Hamburg'), [], 'a city is not a country preference');
  assert.ok(countriesOfName('Europe').includes('DE'));
  assert.ok(coversCountry(['EU'], 'DE'));
  assert.ok(!coversCountry(['EU'], 'US'));
  assert.equal(boardHomeCountry([['DE'], ['DE'], ['DE'], [], ['DE']]), 'DE');
  assert.equal(boardHomeCountry([['DE'], ['US'], ['IN'], ['DE']]), null);
  assert.equal(boardHomeCountry([['DE'], []]), null, 'too few located jobs');
});

test('board experience labels map to seniority', () => {
  assert.equal(seniorityFromLabel('entry-level'), 'junior');
  assert.equal(seniorityFromLabel('student_college'), 'intern');
  assert.equal(seniorityFromLabel('Mid-Senior level'), 'mid');
  assert.equal(seniorityFromLabel('executive'), 'lead');
  assert.equal(seniorityFromLabel('experienced'), null, 'too generic; the title decides');
  assert.equal(seniorityFromLabel(undefined), null);
});
