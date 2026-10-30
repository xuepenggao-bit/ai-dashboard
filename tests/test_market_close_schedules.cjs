'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// When deployed under tests/, the default is the checkout root. The override
// lets a release candidate be checked without changing a dirty local checkout.
const repo = process.env.MARKET_CLOSE_ROOT
  ? path.resolve(process.env.MARKET_CLOSE_ROOT)
  : path.resolve(__dirname, '..');

function cronEntries(name) {
  const source = fs.readFileSync(path.join(repo, '.github/workflows', name), 'utf8');
  const block = source.match(/^  schedule:\s*\n([\s\S]*?)(?=^  [A-Za-z_]|^(?:concurrency|permissions|jobs):)/m);
  assert.ok(block, name + ' must retain its scheduled trigger');
  return [...block[1].matchAll(/^\s+- cron:\s*['"]([^'"]+)['"]\s*$/gm)]
    .map(match => match[1]);
}

function includes(crons, value, message) {
  assert.ok(crons.includes(value), message + ': missing ' + value);
}

function fieldMatches(field, value) {
  return field.split(',').some(part => {
    if (part === '*') return true;
    if (/^\d+$/.test(part)) return +part === value;
    const range = part.match(/^(\d+)-(\d+)$/);
    return !!range && value >= +range[1] && value <= +range[2];
  });
}

function beijingWeekdayMinutes(crons, weekday = 1) {
  const result = [];
  for (const cron of crons) {
    const fields = cron.trim().split(/\s+/);
    assert.equal(fields.length, 5, 'a GitHub cron must have five fields');
    assert.equal(fields[2], '*', 'close refresh must not restrict day of month');
    assert.equal(fields[3], '*', 'close refresh must not restrict month');
    // All checked schedules run before UTC 16:00, so UTC/Beijing weekdays
    // agree at their selected hours. Enumerate rather than parse an hour list
    // as a single number, which would miss existing 7,8 or 0,8,12 schedules.
    for (let hour = 0; hour < 16; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        if (fieldMatches(fields[0], minute) && fieldMatches(fields[1], hour)
            && fieldMatches(fields[4], weekday)) result.push((hour + 8) * 60 + minute);
      }
    }
  }
  return result;
}

const added = [
  ['refresh-market-breadth.yml', '15 8 * * 1-5', ['5,35 7 * * 1-5']],
  ['refresh-market-risk.yml', '15 8 * * 1-5', ['20 0,13 * * 1-5', '50 9 * * 1-5']],
  ['refresh-etf-shares.yml', '15 8 * * 1-5', ['25 0,13 * * 1-5', '55 9 * * 1-5']],
  ['refresh-account-openings.yml', '15 8 * * *', ['41 0 * * *']],
];

for (const [name, close, existing] of added) {
  test(name + ' adds a 16:15 Beijing check without replacing earlier/later checks', () => {
    const crons = cronEntries(name);
    includes(crons, close, name + ' after-close check');
    for (const value of existing) includes(crons, value, name + ' retained schedule');
    assert.equal(new Set(crons).size, crons.length, name + ' should not duplicate cron entries');
    assert.ok(beijingWeekdayMinutes(crons).includes(16 * 60 + 15));
  });
}

for (const [name, expected] of [
  ['refresh-high-low-52w.yml', '15 7,8,12 * * 1-5'],
  ['refresh-market-quality.yml', '25 7,8,12 * * 1-5'],
  ['refresh-market-heat.yml', '35 0,8,12 * * 1-5'],
]) {
  test(name + ' retains its existing after-16:10 refresh', () => {
    const crons = cronEntries(name);
    includes(crons, expected, name + ' existing schedule');
    for (let weekday = 1; weekday <= 5; weekday++) {
      assert.ok(beijingWeekdayMinutes(crons, weekday)
        .some(minute => minute >= 16 * 60 + 10 && minute < 17 * 60),
      name + ' should check after both markets close on every weekday');
    }
  });
}

test('risk and ETF evening disclosure checks remain after clearing', () => {
  for (const [name, expected] of [
    ['refresh-market-risk.yml', [17 * 60 + 50, 21 * 60 + 20]],
    ['refresh-etf-shares.yml', [17 * 60 + 55, 21 * 60 + 25]],
  ]) {
    const minutes = beijingWeekdayMinutes(cronEntries(name));
    for (const value of expected) assert.ok(minutes.includes(value), name + ' must retain ' + value);
  }
});

test('monthly account disclosure checks remain daily, including weekends', () => {
  const crons = cronEntries('refresh-account-openings.yml');
  for (const weekday of [0, 6]) {
    const minutes = beijingWeekdayMinutes(crons, weekday);
    assert.ok(minutes.includes(8 * 60 + 41));
    assert.ok(minutes.includes(16 * 60 + 15));
  }
});

test('temperature still recomputes after successful upstream refresh workflows', () => {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/refresh-market-heat.yml'), 'utf8');
  assert.match(source, /^  workflow_run:/m);
  for (const workflow of [
    'Refresh A-share Return Distribution and Trading Concentration',
    'Refresh A-share 52-week High Low and MA Breadth',
    'Refresh A-share Market Breadth',
    'Refresh Market Risk',
    'Refresh ETF Shares',
  ]) assert.ok(source.includes("- '" + workflow + "'"), 'temperature must retain upstream ' + workflow);
  assert.match(source, /github\.event\.workflow_run\.conclusion == 'success'/);
});
