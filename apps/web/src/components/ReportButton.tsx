import { useRef, useState } from 'react';
import { REPORT_REASON_LABELS } from '../lib/text.ts';
import { CloseIcon } from './icons.tsx';
import { postJson } from './useTurnstile.tsx';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

const REASONS = Object.entries(REPORT_REASON_LABELS);

export default function ReportButton({ questionId }: { questionId: number }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const close = () => dialogRef.current?.close();

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!reason) return;
    setState({ kind: 'sending' });
    const res = await postJson('/api/reports', { questionId, reason, note: note.trim() || null });
    if (res.ok) setState({ kind: 'sent' });
    else setState({ kind: 'error', message: res.data?.error ?? 'Could not send. Try again.' });
  }

  return (
    <>
      <button
        type="button"
        className="btn ghost small"
        onClick={() => {
          setState({ kind: 'idle' });
          dialogRef.current?.showModal();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 21V4h11l-2 4 2 4H5" />
        </svg>
        Report a problem
      </button>
      <dialog ref={dialogRef} className="modal" aria-labelledby="report-title">
        <div className="modal-head">
          <h2 id="report-title">Report a problem</h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {state.kind === 'sent' ? (
          <>
            <div className="notice success" role="status">
              <p>Report sent.</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={close}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <fieldset className="radio-list">
              <legend>What is wrong?</legend>
              {REASONS.map(([value, label]) => (
                <label key={value}>
                  <input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} required />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor="report-note">
                Note <span className="hint">Optional. If the answer is wrong, what is the right one?</span>
              </label>
              <textarea id="report-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {state.kind === 'error' && (
              <div className="notice error" role="alert">
                <p>{state.message}</p>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={!reason || state.kind === 'sending'}>
                {state.kind === 'sending' ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
