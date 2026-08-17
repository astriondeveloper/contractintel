/**
 * Corpus readiness.
 *
 *   npm run readiness
 *
 * What the loaded corpus can and cannot support, in one place. Run it the moment real data lands:
 * every screen in this system is honest about its own weak spots individually, and this is the
 * assembly of those admissions, because "should I believe this yet" is asked of the whole thing.
 *
 * It writes nothing and it names the command that would move each number.
 */
import { pool, closePool } from '../src/db/index.js';
import { readiness } from '../src/signals/readiness.js';

const WIDTH = 78;

function rule(character = '-'): string {
  return character.repeat(WIDTH);
}

/** Wrap prose to the report width, indented, so a long sentence stays readable in a terminal. */
function wrap(text: string, indent: number): string[] {
  const width = WIDTH - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${' '.repeat(indent)}${l}`);
}

async function main(): Promise<void> {
  const client = await pool.connect();
  let sections;
  try {
    sections = await readiness(client);
  } finally {
    client.release();
  }

  console.log('');
  console.log(rule('='));
  console.log('CORPUS READINESS');
  console.log(rule('='));

  const concerns: string[] = [];
  const nexts: string[] = [];

  for (const section of sections) {
    console.log('');
    console.log(section.title);
    console.log(rule());

    for (const reading of section.readings) {
      const marker = reading.concern === true ? '!' : ' ';
      console.log(`${marker} ${reading.label.padEnd(34)} ${reading.value}`);
      if (reading.meaning !== undefined) {
        for (const line of wrap(reading.meaning, 38)) console.log(line);
      }
      if (reading.concern === true) concerns.push(`${section.title}: ${reading.label} — ${reading.value}`);
    }

    if (section.next !== undefined) {
      console.log('');
      for (const line of wrap(`Next: ${section.next}`, 2)) console.log(line);
      nexts.push(section.next);
    }
  }

  console.log('');
  console.log(rule('='));
  if (concerns.length === 0) {
    console.log('Nothing flagged. Every figure above is a fact rather than a gap.');
  } else {
    console.log(`${concerns.length} thing(s) flagged with a "!" above. In order:`);
    console.log('');
    for (const concern of concerns) {
      for (const line of wrap(`- ${concern}`, 2)) console.log(line);
    }
  }

  if (nexts.length > 0) {
    console.log('');
    console.log('The commands that move them:');
    console.log('');
    for (const next of nexts) {
      for (const line of wrap(`- ${next}`, 2)) console.log(line);
    }
  }

  console.log('');
  console.log('A "!" is not a defect. Most of them are the honest state of a corpus that does not');
  console.log('reach back far enough yet, and they improve as data accrues without any code change.');
  console.log(rule('='));
  console.log('');
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
