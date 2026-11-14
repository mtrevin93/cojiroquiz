import type { ConfirmInput, ConfirmResult, DraftDTO, ManualInput, UploadResult } from '@cojiro/shared';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { langName } from '../lib/text.ts';
import { CheckIcon, CloseIcon } from './icons.tsx';
import { questionPath } from './QuestionCard.tsx';
import { postJson, TURNSTILE_HEADER, useTurnstile } from './useTurnstile.tsx';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 1600;
const QUARANTINED_MESSAGE = "Couldn't read this one. Sent for review.";
const COMMON_LANGS = ['en', 'ja', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ko', 'zh', 'ru'];

type ItemStatus = 'queued' | 'preparing' | 'uploading' | 'reading' | 'review' | 'confirming' | 'done' | 'info' | 'error';

interface Item {
  id: number;
  file: File;
  name: string;
  thumbUrl: string;
  status: ItemStatus;
  /** Upload progress 0..1 while status is 'uploading'. */
  progress: number;
  message?: string;
  link?: { href: string; label: string };
  draft?: DraftDTO;
}

const ACTIVE: ItemStatus[] = ['preparing', 'uploading', 'reading', 'review', 'confirming'];
const STATUS_TEXT: Record<ItemStatus, string> = {
  queued: 'Waiting',
  preparing: 'Preparing…',
  uploading: 'Uploading…',
  reading: 'Reading…',
  review: 'Ready to check',
  confirming: 'Saving…',
  done: 'Added',
  info: '',
  error: 'Failed',
};

/** Shrink big screenshots before upload so cellular uploads are quick. Falls back to the original. */
async function downscale(file: File): Promise<Blob> {
  try {
    if (!('createImageBitmap' in window)) return file;
    const bmp = await createImageBitmap(file);
    const long = Math.max(bmp.width, bmp.height);
    if (long <= MAX_EDGE && file.size <= 1.5 * 1024 * 1024) {
      bmp.close();
      return file;
    }
    const scale = Math.min(1, MAX_EDGE / long);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const c2d = canvas.getContext('2d');
    if (!c2d) return file;
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;
    return blob;
  } catch {
    return file;
  }
}

function uploadWithProgress(
  blob: Blob,
  name: string,
  token: string | null,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    if (token) xhr.setRequestHeader(TURNSTILE_HEADER, token);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ status: 0, data: { error: 'Network error. Try again.' } });
    xhr.ontimeout = () => resolve({ status: 0, data: { error: 'Upload timed out. Try again.' } });
    xhr.timeout = 120_000;
    const form = new FormData();
    form.append('file', blob, name);
    xhr.send(form);
  });
}

let nextId = 1;

export default function UploadApp({ turnstileSiteKey }: { turnstileSiteKey?: string | null }) {
  const [tab, setTab] = useState<'shot' | 'manual'>('shot');
  const turnstile = useTurnstile(turnstileSiteKey);

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="How to add a question">
        <button type="button" role="tab" id="tab-shot" className="tab" aria-selected={tab === 'shot'} aria-controls="panel-shot" onClick={() => setTab('shot')}>
          Screenshot
        </button>
        <button type="button" role="tab" id="tab-manual" className="tab" aria-selected={tab === 'manual'} aria-controls="panel-manual" onClick={() => setTab('manual')}>
          Type it in
        </button>
      </div>
      {turnstile.slot}
      <div role="tabpanel" id="panel-shot" aria-labelledby="tab-shot" hidden={tab !== 'shot'}>
        <ScreenshotTab takeToken={turnstile.take} active={tab === 'shot'} />
      </div>
      <div role="tabpanel" id="panel-manual" aria-labelledby="tab-manual" hidden={tab !== 'manual'}>
        <ManualTab takeToken={turnstile.take} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- screenshot tab */

function ScreenshotTab({ takeToken, active }: { takeToken: () => Promise<string | null>; active: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [paused, setPaused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const patch = useCallback((id: number, p: Partial<Item>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  const addFiles = useCallback((files: Iterable<File>) => {
    const fresh: Item[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      fresh.push({
        id: nextId++,
        file,
        name: file.name || 'Pasted screenshot',
        thumbUrl: URL.createObjectURL(file),
        status: 'queued',
        progress: 0,
      });
    }
    if (fresh.length) {
      setPaused(null);
      setItems((list) => [...list, ...fresh]);
    }
  }, []);

  // Paste from clipboard anywhere on the page while this tab is showing.
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [active, addFiles]);

  // One file at a time: start the next queued file when nothing is in flight or under review.
  useEffect(() => {
    if (busy.current || paused) return;
    if (items.some((it) => ACTIVE.includes(it.status))) return;
    const next = items.find((it) => it.status === 'queued');
    if (!next) return;
    busy.current = true;
    void (async () => {
      try {
        patch(next.id, { status: 'preparing' });
        const blob = await downscale(next.file);
        if (blob.size > MAX_BYTES) {
          patch(next.id, { status: 'error', message: 'Image is over 8 MB.' });
          return;
        }
        const token = await takeToken();
        patch(next.id, { status: 'uploading', progress: 0 });
        const res = await uploadWithProgress(blob, next.name, token, (f) =>
          patch(next.id, f >= 1 ? { status: 'reading', progress: 1 } : { progress: f }),
        );
        const body = res.data as (UploadResult & { error?: string }) | { error?: string; status?: undefined } | null;
        if (!body || !('status' in body) || !body.status) {
          const message = body?.error ?? `Upload failed (${res.status || 'offline'}).`;
          patch(next.id, { status: 'error', message });
          if (res.status === 503 || res.status === 429 || res.status === 0) setPaused(message);
          return;
        }
        switch (body.status) {
          case 'draft':
            patch(next.id, { status: 'review', draft: body.draft });
            break;
          case 'duplicate_file':
            patch(next.id, {
              status: 'done',
              message: 'Already have this screenshot.',
              link: { href: questionPath(body.question.slug), label: 'View' },
            });
            break;
          case 'quarantined':
            patch(next.id, { status: 'info', message: QUARANTINED_MESSAGE });
            break;
          case 'rate_limited':
            patch(next.id, { status: 'error', message: body.message || 'Too many uploads. Try again later.' });
            setPaused('Uploads paused: too many at once.');
            break;
          case 'cap_reached':
            patch(next.id, { status: 'error', message: body.message || 'Daily limit reached. Try again tomorrow.' });
            setPaused('Uploads paused: daily limit reached.');
            break;
          case 'parser_unavailable':
            patch(next.id, { status: 'error', message: body.message || "Can't read screenshots right now. Try again in a few minutes." });
            setPaused("Uploads paused: can't read screenshots right now.");
            break;
          case 'invalid_file':
            patch(next.id, { status: 'error', message: body.message || 'Not a usable image.' });
            break;
        }
      } finally {
        busy.current = false;
      }
    })();
  }, [items, paused, patch, takeToken]);

  const current = items.find((it) => it.status === 'review' || it.status === 'confirming');
  useEffect(() => {
    if (current?.status === 'review') reviewRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  async function confirm(item: Item, input: ConfirmInput) {
    patch(item.id, { status: 'confirming' });
    const res = await postJson(`/api/uploads/${encodeURIComponent(item.draft!.draftId)}/confirm`, input);
    if (res.ok && res.data?.slug) {
      const r = res.data as ConfirmResult;
      patch(item.id, {
        status: 'done',
        message: r.merged
          ? r.disputed
            ? 'Vote added. Uploads disagree, so the answer is marked disputed.'
            : 'Already had this one. Answer confirmed.'
          : 'Published.',
        link: { href: questionPath(r.slug), label: 'View' },
      });
    } else {
      patch(item.id, { status: 'review', message: res.data?.error ?? 'Could not save. Try again.' });
    }
  }

  const retry = (item: Item) => {
    setPaused(null);
    patch(item.id, { status: 'queued', message: undefined, progress: 0 });
  };
  const remove = (item: Item) => {
    URL.revokeObjectURL(item.thumbUrl);
    setItems((list) => list.filter((it) => it.id !== item.id));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer.files);
  };

  const queuedCount = items.filter((it) => it.status === 'queued').length;

  return (
    <div>
      <div
        className={`dropzone${over ? ' is-over' : ''}${items.length ? ' is-compact' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={fileRef}
          id="shot-files"
          className="sr-only"
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <label htmlFor="shot-files" className="btn" style={{ marginBottom: 0 }}>
          {items.length ? 'Add more screenshots' : 'Choose screenshots'}
        </label>
        <p className="muted">Pick one or several.</p>
        <p className="muted desktop-only">Or drag and drop, or paste.</p>
      </div>

      {paused && (
        <div className="notice error" role="alert">
          <p>{paused}</p>
          {queuedCount > 0 && (
            <p>
              <button type="button" className="btn small secondary" onClick={() => setPaused(null)}>
                Resume ({queuedCount} waiting)
              </button>
            </p>
          )}
        </div>
      )}

      {current?.draft && (
        <div ref={reviewRef} style={{ scrollMarginTop: 12 }}>
          <Review
            key={current.id}
            item={current}
            position={items.indexOf(current) + 1}
            total={items.length}
            onConfirm={(input) => confirm(current, input)}
            onSkip={() => patch(current.id, { status: 'info', message: 'Skipped.' })}
          />
        </div>
      )}

      {items.length > 0 && (
        <ul className="queue" aria-label="Your screenshots">
          {items.map((it) => (
            <li key={it.id} className={`queue-item${it === current ? ' is-current' : ''}`}>
              <img className="queue-thumb" src={it.thumbUrl} alt="" width={44} height={60} />
              <div style={{ minWidth: 0 }}>
                <div className="queue-name">{it.name}</div>
                <div
                  className={`queue-status${it.status === 'error' ? ' is-error' : ''}${it.status === 'done' ? ' is-done' : ''}`}
                  role={it.status === 'error' ? 'alert' : 'status'}
                >
                  {it.status === 'review' || it.status === 'confirming' ? STATUS_TEXT[it.status] : it.message || STATUS_TEXT[it.status]}
                  {it.link && (
                    <>
                      {' '}
                      <a href={it.link.href}>{it.link.label}</a>
                    </>
                  )}
                </div>
                {(it.status === 'preparing' || it.status === 'uploading' || it.status === 'reading' || it.status === 'confirming') && (
                  <div
                    className={`progress${it.status === 'uploading' ? '' : ' indeterminate'}`}
                    role="progressbar"
                    aria-label={STATUS_TEXT[it.status]}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={it.status === 'uploading' ? Math.round(it.progress * 100) : undefined}
                  >
                    <i style={{ width: `${Math.round(it.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {it.status === 'error' ? (
                <button type="button" className="btn small secondary" onClick={() => retry(it)}>
                  Retry
                </button>
              ) : it.status === 'queued' || it.status === 'done' || it.status === 'info' ? (
                <button type="button" className="icon-btn" style={{ margin: 0 }} onClick={() => remove(it)} aria-label={`Remove ${it.name}`}>
                  <CloseIcon size={18} />
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Review({
  item,
  position,
  total,
  onConfirm,
  onSkip,
}: {
  item: Item;
  position: number;
  total: number;
  onConfirm: (input: ConfirmInput) => void;
  onSkip: () => void;
}) {
  const draft = item.draft!;
  const dupIndex = draft.duplicateOf ? draft.choices.findIndex((c) => c.label === draft.duplicateOf!.answerLabel) : -1;
  const [lang, setLang] = useState(draft.lang);
  const [level, setLevel] = useState(draft.level ?? '');
  const [text, setText] = useState(draft.questionText);
  const [labels, setLabels] = useState(draft.choices.map((c) => c.label));
  const [editChoices, setEditChoices] = useState(false);
  const [answer, setAnswer] = useState<number | null>(draft.detectedAnswerIndex ?? (dupIndex >= 0 ? dupIndex : null));
  const saving = item.status === 'confirming';
  const lowConfidence = draft.confidence !== 'high';
  const langs = COMMON_LANGS.includes(lang) ? COMMON_LANGS : [lang, ...COMMON_LANGS];

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (answer === null || !text.trim()) return;
    const input: ConfirmInput = { answerIndex: answer };
    if (text !== draft.questionText) input.questionText = text;
    if (lang !== draft.lang) input.lang = lang;
    if ((level.trim() || null) !== draft.level) input.level = level.trim() || null;
    if (labels.some((l, i) => l !== draft.choices[i]?.label)) input.choiceLabels = labels;
    onConfirm(input);
  }

  return (
    <form className="review" onSubmit={submit} aria-label={`Check screenshot ${position} of ${total}`}>
      <h2>
        Check it{total > 1 ? ` (${position} of ${total})` : ''}
      </h2>

      {draft.duplicateOf && (
        <div className="notice">
          <p>
            <strong>Already have this one.</strong> Current answer: <strong lang={lang}>{draft.duplicateOf.answerLabel}</strong>.{' '}
            <a href={questionPath(draft.duplicateOf.slug)}>View</a>
          </p>
          <p className="muted">Confirming adds a vote for the answer.</p>
        </div>
      )}
      {lowConfidence && (
        <div className="notice">
          <p>Hard to read. Check the text and choices.</p>
        </div>
      )}
      {item.message && (
        <div className="notice error" role="alert">
          <p>{item.message}</p>
        </div>
      )}

      <div className="qcard">
        <div className="qcard-head">
          <span className="qcard-num">Question</span>
          <span className="qcard-level">{level || 'No level'}</span>
        </div>
        <div className="qcard-body">
          <label className="sr-only" htmlFor={`rv-text-${item.id}`}>
            Question text
          </label>
          <textarea
            id={`rv-text-${item.id}`}
            lang={lang}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
            maxLength={2000}
            required
            spellCheck={false}
          />
        </div>
        <div className="qcard-foot">
          <fieldset className="pick-list">
            <legend>
              {draft.detectedAnswerIndex !== null
                ? 'Answer read from the screenshot. Correct?'
                : 'Tap the correct answer'}
            </legend>
            {draft.choices.map((c, i) => (
              <button
                key={i}
                type="button"
                className="pick ornate"
                aria-pressed={answer === i}
                onClick={() => setAnswer(i)}
                lang={lang}
              >
                {answer === i && <CheckIcon />}
                {c.previewUrl && <img src={c.previewUrl} alt="" width={64} height={64} />}
                <span>
                  {labels[i] || c.description || `Choice ${i + 1}`}
                  {c.kind === 'image' && c.description && labels[i] ? <span className="choice-desc">{c.description}</span> : null}
                </span>
              </button>
            ))}
          </fieldset>
        </div>
      </div>

      <div className="review-grid" style={{ marginTop: 14 }}>
        <div>
          <label htmlFor={`rv-lang-${item.id}`}>Language</label>
          <select id={`rv-lang-${item.id}`} value={lang} onChange={(e) => setLang(e.target.value)}>
            {langs.map((l) => (
              <option key={l} value={l}>
                {langName(l)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`rv-level-${item.id}`}>Level</label>
          <input id={`rv-level-${item.id}`} type="text" value={level} maxLength={100} onChange={(e) => setLevel(e.target.value)} placeholder="Egg Level" />
        </div>
      </div>

      <p style={{ margin: '10px 0 0' }}>
        <button type="button" className="link-btn" aria-expanded={editChoices} onClick={() => setEditChoices((v) => !v)}>
          {editChoices ? 'Done' : 'Fix a choice'}
        </button>
      </p>
      {editChoices && (
        <div className="choice-inputs">
          {labels.map((l, i) => (
            <div key={i}>
              <label className="sr-only" htmlFor={`rv-choice-${item.id}-${i}`}>
                Choice {i + 1}
              </label>
              <input
                id={`rv-choice-${item.id}-${i}`}
                type="text"
                lang={lang}
                value={l}
                maxLength={300}
                onChange={(e) => setLabels((ls) => ls.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </div>
          ))}
        </div>
      )}

      <div className="sticky-bar">
        <button type="button" className="btn ghost" onClick={onSkip} disabled={saving}>
          Skip
        </button>
        <button type="submit" className="btn" disabled={saving || answer === null || !text.trim()}>
          {saving ? 'Saving…' : answer === null ? 'Tap the correct answer' : 'Publish'}
        </button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- manual tab */

function ManualTab({ takeToken }: { takeToken: () => Promise<string | null> }) {
  const [lang, setLang] = useState('en');
  const [level, setLevel] = useState('');
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<string[]>(['', '']);
  const [answer, setAnswer] = useState<number | null>(null);
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string } | { kind: 'done'; result: ConfirmResult }
  >({ kind: 'idle' });

  useEffect(() => {
    const primary = navigator.language?.toLowerCase().split('-')[0];
    if (primary && COMMON_LANGS.includes(primary)) setLang(primary);
  }, []);

  const filled = choices.map((c) => c.trim());
  const valid = text.trim() !== '' && filled.every(Boolean) && filled.length >= 2 && answer !== null && answer < filled.length;

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!valid || answer === null) return;
    setState({ kind: 'sending' });
    const input: ManualInput = {
      lang,
      level: level.trim() || null,
      questionText: text.trim(),
      choiceLabels: filled,
      answerIndex: answer,
    };
    const token = await takeToken();
    const res = await postJson('/api/questions', input, token);
    if (res.ok && res.data?.slug) {
      setState({ kind: 'done', result: res.data as ConfirmResult });
      setText('');
      setChoices(['', '']);
      setAnswer(null);
    } else {
      setState({ kind: 'error', message: res.data?.error ?? 'Could not save. Try again.' });
    }
  }

  const truefalse = () => {
    setChoices(['X', '✓']);
    setAnswer(null);
  };

  return (
    <form onSubmit={submit}>
      {state.kind === 'done' && (
        <div className="notice success" role="status">
          <p>
            {state.result.merged ? 'Already had this one. Answer counted.' : 'Published.'}{' '}
            <a href={questionPath(state.result.slug)}>View</a>
          </p>
        </div>
      )}
      <div className="field">
        <label htmlFor="m-text">
          Question <span className="hint">Exactly as shown.</span>
        </label>
        <textarea id="m-text" lang={lang} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} required spellCheck={false} />
      </div>
      <div className="review-grid field">
        <div>
          <label htmlFor="m-lang">Language</label>
          <select id="m-lang" value={lang} onChange={(e) => setLang(e.target.value)}>
            {COMMON_LANGS.map((l) => (
              <option key={l} value={l}>
                {langName(l)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="m-level">Level</label>
          <input id="m-level" type="text" value={level} maxLength={100} onChange={(e) => setLevel(e.target.value)} placeholder="Egg Level" />
        </div>
      </div>
      <fieldset className="pick-list field">
        <legend>
          Choices <span className="hint">Select the correct one.</span>
        </legend>
        <div className="choice-inputs">
          {choices.map((c, i) => (
            <div className="choice-input-row" key={i}>
              <input
                type="radio"
                name="m-answer"
                checked={answer === i}
                onChange={() => setAnswer(i)}
                aria-label={`Choice ${i + 1} is the correct answer`}
              />
              <input
                type="text"
                lang={lang}
                value={c}
                maxLength={300}
                aria-label={`Choice ${i + 1}`}
                placeholder={`Choice ${i + 1}`}
                onChange={(e) => setChoices((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {choices.length > 2 ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove choice ${i + 1}`}
                  onClick={() => {
                    setChoices((cs) => cs.filter((_, j) => j !== i));
                    setAnswer((a) => (a === null || a === i ? null : a > i ? a - 1 : a));
                  }}
                >
                  <CloseIcon size={18} />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          {choices.length < 8 && (
            <button type="button" className="btn small secondary" onClick={() => setChoices((cs) => [...cs, ''])}>
              Add a choice
            </button>
          )}
          <button type="button" className="btn small ghost" onClick={truefalse}>
            Use X / ✓
          </button>
        </div>
      </fieldset>
      {state.kind === 'error' && (
        <div className="notice error" role="alert">
          <p>{state.message}</p>
        </div>
      )}
      <div className="sticky-bar">
        <button type="submit" className="btn" disabled={!valid || state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Saving…' : answer === null ? 'Select the correct choice' : 'Publish'}
        </button>
      </div>
    </form>
  );
}
