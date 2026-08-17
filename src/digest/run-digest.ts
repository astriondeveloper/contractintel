/**
 * The digest.
 *
 *   npm run digest                                    print every digest worth sending
 *   npm run digest -- --person gavin.taylor@astrion.us
 *   npm run digest -- --html --out dist/digests
 *   npm run digest -- --base-url https://cie.example.astrion.us
 *   npm run digest -- --window 14
 *
 * It renders and stops. Nothing here sends anything, and that is the state to ship in rather than a
 * gap to apologise for: the hard part of a digest is what it says, and a transport is a dozen lines
 * whoever owns the mail relay can add against a shape they can already read.
 *
 * Wiring one up means calling `renderAll` and handing each `digest.subject`, `digest.text` and
 * `digest.html` to a relay. Two things to keep when you do:
 *
 *   Send nothing when `renderAll` returns nothing. It already excludes people with nothing to say,
 *   so an empty result means send no mail rather than send empty mail.
 *
 *   Do not touch `feed_watermark`. A digest is a copy of the feed, not a visit to it, and marking
 *   things read because an email was generated would empty the screen the person came to read.
 *
 * `--out` writes one file per person, which is also how to show somebody what they would get without
 * sending them anything.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, closePool } from '../db/index.js';
import { DEFAULT_WINDOW_DAYS, render, renderAll, type Digest } from './digest.js';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

function usage(): void {
  console.log(`
The digest: what each person's patch has done since they last looked.

  npm run digest -- [options]

  --person <principal>   Just this one. Otherwise every person who follows something.
  --window <days>        How far back to look for somebody with no read mark. Default ${DEFAULT_WINDOW_DAYS}.
  --named <n>            How many requirements to name before summarising the rest. Default 5.
  --base-url <url>       What links point at. Without it the digest carries paths and says so.
  --html                 Print the HTML rather than the text.
  --out <directory>      Write one .txt and .html per person instead of printing.
  --help                 This.

It renders and does not send. Nothing here touches the read mark: a digest is a copy of the feed,
and marking things read because an email was generated would empty the screen somebody came to read.

Somebody who follows nothing gets no digest. There is nothing personal to send them, and the right
nudge is a colleague rather than mail from a system they have not set up yet.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const person = flag(argv, '--person');
  const outDir = flag(argv, '--out');
  const wantsHtml = argv.includes('--html');
  const windowFlag = flag(argv, '--window');
  const namedFlag = flag(argv, '--named');

  const options = {
    baseUrl: flag(argv, '--base-url') ?? process.env.CIE_BASE_URL ?? '',
    windowDays: windowFlag === null ? undefined : Number(windowFlag),
    namedItems: namedFlag === null ? undefined : Number(namedFlag),
  };

  if (options.windowDays !== undefined && !Number.isInteger(options.windowDays)) {
    throw new Error('--window takes a whole number of days.');
  }
  if (options.namedItems !== undefined && !Number.isInteger(options.namedItems)) {
    throw new Error('--named takes a whole number.');
  }

  const client = await pool.connect();
  let digests: Digest[];
  try {
    digests = person === null
      ? await renderAll(client, options)
      : await render(client, person, options).then((d) => (d === null ? [] : [d]));
  } finally {
    client.release();
  }

  if (digests.length === 0) {
    console.log('');
    console.log('Nothing to send.');
    console.log('');
    if (person !== null) {
      console.log(`${person} either follows nothing, has nothing new since their read mark, and`);
      console.log('nothing they are tracking closes soon. Any of the three means no digest.');
    } else {
      console.log('Nobody has anything new in their patch. That is the normal state most weeks, and');
      console.log('it is why this sends nothing rather than sending a cheerful nothing: an empty');
      console.log('digest every Monday is how a digest gets filtered into a folder nobody opens.');
    }
    console.log('');
    console.log('  npm run readiness   shows whether anybody has follows at all');
    return;
  }

  if (outDir !== null) {
    await mkdir(outDir, { recursive: true });
    for (const digest of digests) {
      const stem = digest.principalName.replace(/[^a-zA-Z0-9._-]+/g, '_');
      await writeFile(path.join(outDir, `${stem}.txt`), `Subject: ${digest.subject}\n\n${digest.text}`, 'utf8');
      await writeFile(path.join(outDir, `${stem}.html`), digest.html, 'utf8');
    }
    console.log('');
    console.log(`Wrote ${digests.length * 2} file(s) to ${outDir}.`);
    for (const digest of digests) {
      console.log(`  ${digest.principalName.padEnd(34)} ${digest.subject}`);
    }
    console.log('');
    console.log('Nothing was sent, and no read mark moved.');
    return;
  }

  for (const digest of digests) {
    console.log('');
    console.log('='.repeat(78));
    console.log(`To:      ${digest.displayName} <${digest.principalName}>`);
    console.log(`Subject: ${digest.subject}`);
    console.log('='.repeat(78));
    console.log('');
    console.log(wantsHtml ? digest.html : digest.text);
  }

  console.log('');
  console.log('-'.repeat(78));
  console.log(
    `${digests.length} digest(s) rendered and none sent. No read mark moved: a digest is a copy of`,
  );
  console.log('the feed, not a visit to it.');
  if ((options.baseUrl ?? '') === '') {
    console.log('');
    console.log('Links are paths, because no base URL was set. Pass --base-url or set CIE_BASE_URL.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
