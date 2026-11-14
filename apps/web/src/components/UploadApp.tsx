import type { ConfirmInput, ConfirmResult, DraftDTO, UploadResult } from '@cojiro/shared';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { CheckIcon, CloseIcon } from './icons.tsx';
import { QuestionText, questionPath } from './QuestionCard.tsx';
import { postJson, TURNSTILE_HEADER, useTurnstile } from './useTurnstile.tsx';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 1600;
const QUARANTINED_MESSAGE = "Couldn't read this one. Sent for review.";

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
  const turnstile = useTurnstile(turnstileSiteKey);

  return (
    <div>
      {turnstile.slot}
      <ScreenshotTab takeToken={turnstile.take} active />
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
  const lang = draft.lang;
  const [answer, setAnswer] = useState<number | null>(draft.detectedAnswerIndex ?? (dupIndex >= 0 ? dupIndex : null));
  const saving = item.status === 'confirming';
  const lowConfidence = draft.confidence !== 'high';

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (answer === null) return;
    // The text comes from the screenshot only; uploaders choose the answer, nothing else.
    onConfirm({ answerIndex: answer });
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
          <p>Hard to read. If the text is wrong, skip it.</p>
        </div>
      )}
      {item.message && (
        <div className="notice error" role="alert">
          <p>{item.message}</p>
        </div>
      )}

      <div className="qcard">
        <div className="qcard-body">
          <p className="qcard-text" lang={lang}>
            <QuestionText text={draft.questionText} />
          </p>
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
                  {c.label || c.description || `Choice ${i + 1}`}
                  {c.kind === 'image' && c.description && c.label ? <span className="choice-desc">{c.description}</span> : null}
                </span>
              </button>
            ))}
          </fieldset>
        </div>
      </div>

      <div className="sticky-bar">
        <button type="button" className="btn ghost" onClick={onSkip} disabled={saving}>
          Skip
        </button>
        <button type="submit" className="btn" disabled={saving || answer === null}>
          {saving ? 'Saving…' : answer === null ? 'Tap the correct answer' : 'Publish'}
        </button>
      </div>
    </form>
  );
}
