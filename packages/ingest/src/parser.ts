import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ParsedQuiz } from '@cojiro/shared';

export interface ParserImage {
  /** The processed screenshot (webp) that the model should read. */
  bytes: Uint8Array;
  mimeType: string;
  /** sha256 (hex) of the ORIGINAL uploaded bytes. Lets recorded parsers look up by file. */
  sourceSha256?: string;
}

/** The vision parser, behind an interface so the pipeline is testable offline. */
export interface QuizParser {
  parse(image: ParserImage): Promise<ParsedQuiz>;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Recorded = unknown | Error | ((image: ParserImage) => unknown);

/**
 * Offline parser: answers from recorded responses keyed by the sha256 of the
 * original upload. Unknown images throw (which the pipeline quarantines)
 * unless a fallback is set. Responses are returned as-is (not validated) so
 * tests can also feed malformed output.
 */
export class FakeParser implements QuizParser {
  readonly calls: ParserImage[] = [];
  private readonly bySha = new Map<string, Recorded>();
  fallback: Recorded | undefined;

  /** Record the response for an upload (pass the original file bytes or their sha256). */
  set(source: Uint8Array | string, response: Recorded): this {
    this.bySha.set(typeof source === 'string' ? source : sha256Hex(source), response);
    return this;
  }

  /**
   * Load recorded responses: for every image in `screenshotsDir` that has a
   * `<name>.json` in `parsedDir`, map the image's sha256 to that JSON.
   */
  loadFixtures(screenshotsDir: string, parsedDir: string): this {
    for (const file of readdirSync(screenshotsDir)) {
      const json = join(parsedDir, `${basename(file, extname(file))}.json`);
      if (!existsSync(json)) continue;
      const parsed = ParsedQuiz.parse(JSON.parse(readFileSync(json, 'utf8')));
      this.set(new Uint8Array(readFileSync(join(screenshotsDir, file))), parsed);
    }
    return this;
  }

  async parse(image: ParserImage): Promise<ParsedQuiz> {
    this.calls.push(image);
    const recorded = (image.sourceSha256 && this.bySha.get(image.sourceSha256)) ?? this.fallback;
    if (recorded === undefined) throw new Error('FakeParser: no recorded response for this image');
    if (recorded instanceof Error) throw recorded;
    const value = typeof recorded === 'function' ? (recorded as (i: ParserImage) => unknown)(image) : recorded;
    return structuredClone(value) as ParsedQuiz;
  }
}

/** A FakeParser pre-loaded from `<fixturesDir>/screenshots` + `<fixturesDir>/parsed`. */
export function createFixtureParser(fixturesDir: string): FakeParser {
  return new FakeParser().loadFixtures(join(fixturesDir, 'screenshots'), join(fixturesDir, 'parsed'));
}
