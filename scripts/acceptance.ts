/**
 * The twelve acceptance tests from specification section 18.
 *
 *   npm run accept
 *
 * The checks themselves live in `src/acceptance/checks.ts`, because the `/acceptance`
 * screen runs the same twelve against whatever database the interface is pointed at.
 * This file is the terminal reader: it prints them and sets the exit code.
 *
 * A BLOCKED test is never reported as a pass, and the script exits non-zero if
 * anything is FAIL.
 */
import { closePool } from '../src/db/index.js';
import { runAcceptanceChecks, tally } from '../src/acceptance/checks.js';

async function main(): Promise<void> {
  const results = await runAcceptanceChecks();

  const width = 78;
  console.log('');
  console.log('Acceptance tests, specification section 18');
  console.log('='.repeat(width));

  for (const r of results) {
    const marker = r.status === 'PASS' ? 'PASS   ' : r.status === 'FAIL' ? 'FAIL   ' : 'BLOCKED';
    console.log(`\n${marker}  ${String(r.number).padStart(2)}. ${r.title}`);
    for (const line of wrap(r.detail, width - 10)) console.log(`          ${line}`);
  }

  const { passed, failed, blocked, total } = tally(results);

  console.log('');
  console.log('='.repeat(width));
  console.log(`${passed} pass, ${failed} fail, ${blocked} blocked, of ${total}.`);

  if (blocked > 0) {
    console.log('\nBlocked is not passed. Each blocked test names what it is waiting for.');
  }

  if (failed > 0) process.exitCode = 1;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
