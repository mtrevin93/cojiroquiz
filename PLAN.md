# cojiroquiz.com — plan

Crowdsourced, searchable answer key for the quizzes in the Ocarina of Time remake.
Anyone can upload a screenshot; the site parses it, dedupes it, and makes it searchable as plain text.
Unofficial fan site: no Nintendo logos or ripped game assets; footer disclaimer.

## 1. Decisions already made

| Topic | Decision |
|---|---|
| Frontend | Astro (SSR) + React + TypeScript islands |
| Backend | Node, same Astro app (API routes), full-stack TypeScript |
| Repo | Turborepo + pnpm monorepo |
| Storage | SQLite on a Fly.io volume. All images in Tigris, Fly's built-in S3-compatible object storage: a public bucket for published images, a private bucket for quarantine |
| Hosting | Fly.io, one machine, one volume |
| Auth | None for visitors; one secret-token admin page for the owner |
| Parsing | Claude vision API returning structured JSON |
| Answer source | Read from the reveal screenshot when present; otherwise the uploader clicks the correct choice |
| Moderation | Publish instantly, with rate limits, report button, admin page. Uploads the parser can't fit are **kept in a private quarantine** for admin review, never deleted on the spot |
| Languages | Each question is stored in the exact language and wording it was shown in, tagged with its language. No translation, no cross-language merging |
| Feedback | On-site form; server emails the owner's Proton address through an email API (address is a secret, never in the page) |

## 2. Repo layout

```
cojiroquiz/
  apps/
    web/                 Astro app: pages, React islands, API routes, Dockerfile, fly.toml
  packages/
    db/                  Drizzle schema, migrations, query functions (better-sqlite3)
    ingest/              the hard part: parse -> normalize -> dedupe -> store
    shared/              types + zod schemas shared by web and ingest
  turbo.json, pnpm-workspace.yaml, tsconfig.base.json
```

One deployable (`apps/web`). `ingest` and `db` are plain libraries with no web dependencies, so they are unit-testable with screenshot fixtures.

## 3. Data model (SQLite)

```
questions
  id, slug (unique; `<id>-<text>` so non-Latin questions still get stable URLs)
  lang                  BCP-47 tag detected by the parser, e.g. 'en', 'ja', 'es', 'pt-BR'
  level                 as displayed, in the screenshot's language, e.g. "Egg Level"
  kind                  'text' | 'image'      (image = captcha-style picture question)
  question_text         as displayed, e.g. "R A Y R A Y\nThis is the music score for Saria's Song."
  image_description     Claude's plain-text description, for image questions
  search_text           normalized text used for search (see 5.2)
  dedupe_key            sha256 of the canonical text (unique)
  question_phash        perceptual hash of the question region (image questions)
  choices_json          [{ label: "X" }, { label: "✓" }] or text/image choices
  answer_index          resolved answer (majority of submissions)
  answer_source         'reveal' | 'manual'
  question_image_id     best image of the question
  answer_image_id       reveal screenshot, nullable -> fall back to plain-text answer
  submission_count, disputed (bool), hidden (bool), created_at, updated_at

submissions            one row per upload, kept forever (audit + votes)
  id, question_id, image_id, parsed_json, answer_index, answer_source,
  ip_hash, created_at

images
  id, sha256 (unique, of the uploaded bytes), path, width, height, has_reveal

reports
  id, question_id, reason, note, ip_hash, created_at, resolved

feedback
  id, message, contact (optional), ip_hash, created_at, emailed (bool)
```

`ip_hash` is a salted hash, used only for rate limiting and counting distinct voters; raw IPs are not stored.

## 4. Upload flow

```
browser                         server (/api/uploads)
  pick/paste/drop 1..n images
  ───────────────────────────▶  1. validate: type, size (<8 MB), rate limit, Turnstile token
                                2. sha256 of bytes -> already seen? return that question, stop
                                3. sharp: strip EXIF, crop phone status bar, resize, save webp
                                4. Claude vision -> ParsedQuiz JSON (5.1)
                                5. doesn't fit a known quiz shape -> quarantine (7.1), tell uploader
                                   "we couldn't read this one, it's been sent for review"
                                6. normalize + compute dedupe_key / phash (5.2, 5.3)
  ◀───────────────────────────  7. return draft: parsed text, choices, detected answer, match (if any)
  review step:
   - reveal detected: "Answer: ✓" shown for confirmation
   - no reveal: "Tap the correct answer" (required)
   - duplicate found: "We already have this one" + its current answer
   - text is editable if OCR got a word wrong
  ───────────────────────────▶  8. POST /api/uploads/:draftId/confirm -> insert or merge (5.3)
  ◀───────────────────────────  9. link to the live question page
```

Drafts live in a `drafts` table (or a row in `submissions` with `status='draft'`) and are purged after 24h.
A second, "type it in" tab on the upload page covers users with no screenshot: question text + choices + answer, going through the same normalize/dedupe/store steps (skipping 3–5).

## 5. Ingest pipeline (`packages/ingest`)

### 5.1 Parse (Claude vision)

One call per image, structured output validated with zod:

```ts
type ParsedQuiz = {
  isQuizScreenshot: boolean;
  lang: string;                         // BCP-47, language of the quiz text itself
  level: string | null;                 // "Egg Level"
  questionNumber: number | null;        // not stored as identity; order is random per run
  kind: 'text' | 'image';
  questionText: string;                 // exact text, line breaks kept
  imageDescription: string | null;      // for picture questions: what is shown, in plain words
  choices: { label: string; kind: 'text' | 'symbol' | 'image'; description?: string }[];
  reveal: { present: boolean; correctIndex: number | null; selectedIndex: number | null };
  confidence: 'high' | 'medium' | 'low';
};
```

- Model is a config value; start with the small/cheap tier and move up only if fixtures fail.
- The prompt includes the two reference screenshots (no-reveal and reveal) as few-shot examples so the reveal styling is read correctly.
- Parsed text is treated as data: it is escaped on render and never executed or used as instructions.
- Low confidence -> the review step highlights the fields for the uploader to check.

### 5.2 Normalize (plain text for search and dedupe)

- Text is stored verbatim in `question_text`; normalization only produces derived columns and never alters or translates the original.
- All normalization is Unicode-aware (letters and digits of any script are kept; no ASCII-only stripping, no accent folding in the dedupe key).
- `canonical` (for dedupe): NFKC, locale-independent lowercase, curly -> straight quotes, strip punctuation, collapse whitespace.
- `search_text` (for search): canonical text **plus** a variant where runs of single letters are joined, so "R A Y R A Y" is also indexed as "rayray". Without this, searching `ray` would not find the example question. Also appended: level, choice labels, answer text, image description.

### 5.3 Dedupe

1. **Identical file**: `images.sha256` match -> return existing question, no parse, no API cost.
2. **Same question**: `dedupe_key = sha256(lang + canonical question text + sorted canonical choices)` -> merge. Language is part of the key, so the English and Japanese versions of a question are separate entries.
3. **Image questions**: perceptual hash (dHash via sharp) of the question region, Hamming distance under a threshold, combined with matching choices -> merge.
4. **Near matches are never auto-merged.** Quiz statements differ by tiny edits ("R A Y R A Y" vs "R Y A R Y A" are different questions with opposite answers), so fuzzy similarity is only used to show "possible duplicates" in the admin page.

Merge behaviour:
- Add a `submissions` row; bump `submission_count`.
- A reveal screenshot beats a manual answer; it becomes `answer_image_id` and sets `answer_source='reveal'`.
- If submissions disagree, the answer is the majority (reveal-sourced votes outweigh manual ones) and `disputed=1`, shown as a badge.

### 5.4 Tests

Fixture screenshots (the two provided, plus image-question examples once available) with expected parsed output; the Claude call is behind an interface so normalize/dedupe/merge tests run offline against recorded responses.

## 6. Site

### Pages

| Route | Purpose |
|---|---|
| `/` | Search bar + question list. Server-rendered list; `?q=` works without JS |
| `/q/[slug]` | One question: text, question image, answer image (or plain-text answer), level, confirmations, report button |
| `/level/[level]` | Questions for one level (SEO landing pages) |
| `/upload` | Upload + review flow (React island) |
| `/about` | What it is, how to contribute, disclaimer |
| `/admin?token=…` | Reports, rejected uploads (quarantine), recent uploads, hide/edit/delete, merge duplicates |
| `/sitemap.xml`, `/robots.txt` | Generated from the DB |

### Search

- The home page ships a compact JSON index (`id, slug, search_text, answer, thumb`); the React search island filters by case-insensitive substring on every keystroke. Typing `ray` or `saria` narrows to the example question instantly.
- Multiple words = all must match, any order.
- Search runs over the exact stored text in every language at once, so typing in any language finds that language's entries. Substring matching (not word tokenizing) means it also works for scripts without spaces, such as Japanese or Chinese. An accent-insensitive variant is added to `search_text` only, so `cancion` finds `canción`.
- A language filter appears once more than one language exists; it defaults to the browser's language when that language has entries, otherwise "all". Each card carries a small language tag.
- Server-side fallback uses the same matcher (`LIKE` on `search_text`; move to FTS5 with the trigram tokenizer if the set outgrows a few thousand rows).
- Each result card shows the question, then the answer image; if there is no answer image, the answer in plain text.

### Theme (taken from the screenshots)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#16110d` | page background (near-black, warm) |
| `--panel` | `#5e4630` | cards, answer boxes |
| `--panel-dark` | `#3a2b1d` | header bar |
| `--border-gold` | `#8f7430` | thin double border with corner flourishes |
| `--text` | `#f6edd6` | cream body text |
| `--text-muted` | `#b9a88a` | level label |
| `--accent` | `#c9512f` | timer orange-red: buttons, focus |
| `--wrong` | `#d58c8c` | pink X / wrong glow |
| `--right` | `#a8872f` | gold check / correct |

Bold humanist sans for body (e.g. Noto Sans), an old-style display serif for numerals and headings; subtle paper-grain texture; question cards styled like the quiz panel with "Egg Level" in the top-right. Dark only. All original CSS — no game art.

### SEO

- SSR HTML for every question; one canonical URL per question with the question text in `<title>` and `<h1>`.
- JSON-LD `QAPage` on question pages, `WebSite` + `SearchAction` on home.
- Sitemap from the DB, Open Graph image per question, descriptive `alt` text from `image_description`.
- Fast pages: static CSS, small islands, webp images with width/height, long cache headers.
- Each question page sets `lang` on its content to the question's language, so search engines index it for speakers of that language. Site chrome stays English at launch.
- `noindex` on `/upload`, `/admin`, hidden questions.

## 7. Abuse, cost, and safety

- Per-IP-hash rate limits: uploads (e.g. 20/hour), reports, feedback.
- Cloudflare Turnstile on upload and feedback — protects the Claude API bill from bots.
- Daily cap on parse calls (env var); when hit, uploads queue as "pending" instead of failing.
- Uploads that don't fit are quarantined, not deleted (7.1).
- **Report button**: opens a small menu — *wrong answer / not a real quiz question / duplicate / inappropriate* plus an optional note. It writes a `reports` row, never changes the entry by itself, and shows up in the admin page. Two safety valves: three reports from distinct visitors auto-hides the entry until reviewed, and a "wrong answer" report marks it `disputed`. New reports are included in a daily email digest.
- Admin page behind a long random token (Fly secret), constant-time compare.

### 7.1 Quarantine (rejected uploads)

Purpose: catch question types nobody anticipated instead of silently dropping them.

- Anything the parser marks as not a quiz screenshot, an unknown layout, low confidence the uploader abandoned, or a parse error is saved with its raw parser output and a reason.
- Stored in the private Tigris bucket, never publicly served; the admin page shows them through short-lived signed URLs.
- `quarantine` table: `id, image_path, sha256, reason, parsed_json, ip_hash, created_at, status ('new' | 'promoted' | 'dismissed')`.
- Admin "Rejected uploads" section: thumbnail grid, newest first, with the parser's reason and raw output. Actions: **Promote** (opens the normal review form pre-filled, to publish it by hand), **Dismiss**, **Delete**, and **Save as fixture** (flags it as a new question type to teach the parser).
- Limits, since these are unvetted files from anonymous visitors: same size/type checks and rate limits as normal uploads, a total size cap, and dismissed items purged after 30 days.

## 8. Feedback

Footer/header "Feedback" button -> modal with message + optional reply email -> `POST /api/feedback` -> stored in `feedback`, then sent through an email API (Resend) to `FEEDBACK_TO` (the Proton address, a Fly secret). Stored first so nothing is lost if the email send fails.

## 9. Deploy (Fly.io)

- Dockerfile: multi-stage pnpm + turbo prune, Node 22, `better-sqlite3` and `sharp` built for linux.
- `fly.toml`: 1 shared-cpu machine, 512 MB, volume mounted at `/data` (`/data/cojiro.db` only), auto-stop off or min 1 running, health check on `/healthz`.
- SQLite in WAL mode; migrations run on boot.
- Object storage: `fly storage create` twice (public `cojiroquiz-images`, private `cojiroquiz-quarantine`); it is billed through the Fly account and sets the S3 credentials as app secrets automatically. Code uses the standard S3 client behind a small `storage` interface; local dev uses a folder on disk.
- Backups: Litestream replicating the DB to the private bucket + volume snapshots.
- Secrets: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `FEEDBACK_TO`, `ADMIN_TOKEN`, `TURNSTILE_SECRET`, `IP_HASH_SALT`.
- Domain: buy `cojiroquiz.com` (Cloudflare Registrar is at-cost and also provides DNS + Turnstile), `fly certs add` for apex and `www`, redirect `www` -> apex, add Resend DNS records.
- CI: GitHub Actions — typecheck, test, `fly deploy` on main.

## 10. Build order

| Phase | Work | Parallel? |
|---|---|---|
| 0 | Scaffold monorepo, shared types/zod schemas, DB schema + migrations | first, alone |
| 1a | `ingest`: parse, normalize, dedupe, merge + fixture tests | parallel |
| 1b | Theme + pages: home/search, question page, level page, with seeded data | parallel |
| 1c | Dockerfile, fly.toml, volume, health check, CI | parallel |
| 2 | Upload API + review UI wiring 1a into 1b | after 1a/1b |
| 3 | Report button, admin page, feedback form + email, rate limits, Turnstile | after 2 |
| 4 | SEO pass (JSON-LD, sitemap, OG images), backups, domain + certs, launch | last |

## 11. Needed from the owner

| Item | Status |
|---|---|
| Feedback address | Found in sts2-tracker (`apps/web/src/pages/index.astro`): the `knowledgedemon` Proton address. Goes in the `FEEDBACK_TO` Fly secret, not in the repo. Confirmed for now; a dedicated address can replace it later by changing the secret. |
| Fly.io | `flyctl` installed but not logged in (`fly auth login`). Conventions to copy from sts2-tracker: region `iad`, shared-cpu, `force_https`, per-app `fly.*.toml` + Dockerfile. |
| Cloudflare | sts2-tracker `.env.local` has `CF_API_TOKEN` and `CF_ZONE_ID`. The zone ID is for that site; the token may be scoped to it. A new zone (and probably token) is needed once the domain is bought. |
| Anthropic API key | Not present in sts2-tracker or the shell. Needs creating. |
| Email API (Resend) key | **TODO (owner):** DNS records for Resend are live as of 2026-11-14 (DKIM at `resend._domainkey`, SPF + MX on `send`). Click Verify in Resend, create a sending-only API key, save it to `.env` as `RESEND_API_KEY`. |
| Domain | Bought; DNS on Cloudflare. |
| Image-question screenshots | Pending from owner. |

## 12. Confirmed from screenshots

- **Reveal reading**: white border = the player's pick, pink = wrong, gold = correct answer. The parser reports both `selectedIndex` and `correctIndex`; only `correctIndex` is stored as the answer.
- **Levels**: at least "Egg Level" and "Cucco Level"; `level` is free text from the header, not an enum.
- **Choice shapes seen**: 2 symbol choices (X / ✓), 4 text choices (B / E / G / C), and 4 image choices (bottled poe, fish, bug, fairy under a text question such as "which of these sells for the most").
- **Image choices**: each choice box is cropped out of the screenshot and saved as its own image, with a plain-text description from the parser ("bottled fairy"). The description goes into `search_text`, so `fairy` finds the question, and the answer is shown as the cropped image with the description as alt text. If cropping fails, the full screenshot is shown.
- **Choice order** may be shuffled between runs, so the dedupe key uses sorted choices and the answer is stored against the choice's content, not its position.

## 13. Resolved

- Languages: stored and searched as shown, tagged per language, never translated or merged across languages. The review step shows the detected language and lets the uploader correct it. Linking translations of the same question together is possible later (a shared group id) but is not built.

- The same question always has the same answer, at any level: `level` stays out of the dedupe key, and conflicting answers are treated as a mistake (`disputed`), not as variants.
- Questions are always text as far as seen; only choices can be pictures. `kind: 'image'` now describes the choices. A picture-question would land in quarantine and surface in admin review.
