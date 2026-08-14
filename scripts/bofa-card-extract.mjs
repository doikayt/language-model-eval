#!/usr/bin/env node
// Deterministic extractor for Bank of America Visa credit-card statements.
//
// Reads a `pdftotext -layout` text dump (or a PDF, shelling out to pdftotext)
// and emits a transaction-level CSV on stdout. Prints a reconciliation summary
// to stderr: per-section sums vs the statement's own printed
// "TOTAL ... FOR THIS PERIOD" lines. If those do not match, the extraction is
// not trustworthy and the exit code is non-zero.
//
// Usage:
//   node scripts/bofa-card-extract.mjs statement.pdf            > out.csv
//   node scripts/bofa-card-extract.mjs statement.layout.txt     > out.csv
//   node scripts/bofa-card-extract.mjs statement.pdf --out out.csv
//
// A `.pdf` input requires `pdftotext` (poppler-utils) on PATH; a `.txt` input
// is read directly, so the parser can be tested without poppler installed.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// A transaction row: two MM/DD dates, a description, then the signed amount as
// the last decimal on the line. Reference/account numbers (when present) are
// stripped from the tail of the description afterwards.
const ROW = /^\s*(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\s+(.+?)\s+(-?[\d,]+\.\d{2})\s*$/;
const REF_ACCT = /^(.*?)\s+(\d{4})\s+(\d{4})$/;
const SECTION =
  /^\s*(Payments and Other Credits|Purchases and Adjustments|Interest Charged|Fees Charged)\s*$/;
const PRINTED_TOTAL = /TOTAL (.+?) FOR THIS PERIOD\s+(-?\$[\d,]+\.\d{2})/;
const CLOSING = /Statement Closing Date\s+(\d{2})\/(\d{2})\/(\d{4})/;

function loadText(input) {
  if (input.toLowerCase().endsWith('.pdf')) {
    return execFileSync('pdftotext', ['-layout', input, '-'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return readFileSync(input, 'utf8');
}

// "-1,740.67" | "$6,117.76" | "0.00" -> signed integer cents (exact, no float$).
function parseCents(s) {
  const neg = s.includes('-');
  const [dollars, frac = '0'] = s.replace(/[^\d.]/g, '').split('.');
  const cents = Number(dollars) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return neg ? -cents : cents;
}

function fmtAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// MM/DD carries no year; infer it from the statement closing date. A date that
// would fall *after* the closing date belongs to the previous calendar year
// (handles the December -> January statement that straddles a year boundary).
function inferYear(mm, dd, closing) {
  return mm * 100 + dd > closing.mm * 100 + closing.dd ? closing.yyyy - 1 : closing.yyyy;
}

function csvField(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function extract(text) {
  const lines = text.split('\n');

  const c = text.match(CLOSING);
  if (!c) {
    throw new Error('could not find "Statement Closing Date" — cannot infer transaction years');
  }
  const closing = { mm: Number(c[1]), dd: Number(c[2]), yyyy: Number(c[3]) };

  const txns = [];
  let section = '';
  for (const line of lines) {
    const sec = line.match(SECTION);
    if (sec) {
      section = sec[1];
      continue;
    }
    const m = line.match(ROW);
    if (!m) continue;
    const [, tmm, tdd, pmm, pdd, middleRaw, amountRaw] = m;

    let description = middleRaw.replace(/\s+/g, ' ').trim();
    let referenceNumber = '';
    const ra = description.match(REF_ACCT);
    if (ra) {
      description = ra[1].trim();
      referenceNumber = ra[2];
    }

    txns.push({
      transactionDate: `${inferYear(+tmm, +tdd, closing)}-${tmm}-${tdd}`,
      postingDate: `${inferYear(+pmm, +pdd, closing)}-${pmm}-${pdd}`,
      description,
      referenceNumber,
      section,
      amountCents: parseCents(amountRaw),
    });
  }

  const printed = {};
  for (const line of lines) {
    const p = line.match(PRINTED_TOTAL);
    if (p) printed[p[1].trim()] = parseCents(p[2]);
  }

  return { txns, printed };
}

function toCsv({ txns }) {
  const header = 'transactionDate,postingDate,description,referenceNumber,section,amount';
  const rows = txns.map((t) =>
    [
      t.transactionDate,
      t.postingDate,
      csvField(t.description),
      t.referenceNumber,
      csvField(t.section),
      fmtAmount(t.amountCents),
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

// Reconcile per-section parsed sums against the statement's printed totals.
// Returns true only if every printed section total is matched exactly.
function reconcile({ txns, printed }) {
  const sums = {};
  for (const t of txns) sums[t.section] = (sums[t.section] || 0) + t.amountCents;

  const map = [
    ['Payments and Other Credits', 'PAYMENTS AND OTHER CREDITS'],
    ['Purchases and Adjustments', 'PURCHASES AND ADJUSTMENTS'],
    ['Interest Charged', 'INTEREST CHARGED'],
  ];

  console.error(`\n${txns.length} transactions extracted. Reconciliation (parsed vs printed):`);
  let ok = true;
  for (const [section, printedKey] of map) {
    const got = sums[section] || 0;
    const want = printed[printedKey];
    const match = want !== undefined && got === want;
    if (want !== undefined && !match) ok = false;
    console.error(
      `  ${section.padEnd(28)} parsed ${fmtAmount(got).padStart(12)}   ` +
        `printed ${want === undefined ? '         n/a' : fmtAmount(want).padStart(12)}   ` +
        `${want === undefined ? '' : match ? 'OK' : 'MISMATCH'}`,
    );
  }
  console.error(ok ? '  => reconciles.' : '  => DOES NOT reconcile — do not trust this extraction.');
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!input) {
    console.error('usage: bofa-card-extract <statement.pdf|statement.txt> [--out file.csv]');
    process.exit(2);
  }

  const result = extract(loadText(input));
  const csv = toCsv(result);
  if (outFile) writeFileSync(outFile, csv);
  else process.stdout.write(csv);

  const ok = reconcile(result);
  process.exit(ok ? 0 : 1);
}

main();
