import { useRef, useState } from 'react';
import { CloseIcon } from './icons.tsx';
import { postJson, useTurnstile } from './useTurnstile.tsx';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

export default function FeedbackButton({ turnstileSiteKey }: { turnstileSiteKey?: string | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const turnstile = useTurnstile(turnstileSiteKey, open);

  const show = () => {
    setOpen(true);
    setState({ kind: 'idle' });
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!message.trim()) return;
    setState({ kind: 'sending' });
    const token = await turnstile.take();
    const res = await postJson('/api/feedback', { message, contact: contact.trim() || null }, token);
    if (res.ok) {
      setState({ kind: 'sent' });
      setMessage('');
    } else {
      setState({ kind: 'error', message: res.data?.error ?? 'Could not send. Try again.' });
    }
  }

  return (
    <>
      <button type="button" className="link-btn" onClick={show}>
        Feedback
      </button>
      <dialog ref={dialogRef} className="modal" aria-labelledby="feedback-title" onClose={() => setOpen(false)}>
        <div className="modal-head">
          <h2 id="feedback-title">Feedback</h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {state.kind === 'sent' ? (
          <>
            <div className="notice success" role="status">
              <p>Sent.</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={close}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="fb-message">Message</label>
              <textarea
                id="fb-message"
                required
                maxLength={4000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder=""
              />
            </div>
            <div className="field">
              <label htmlFor="fb-contact">
                Your email <span className="hint">Optional, for a reply.</span>
              </label>
              <input
                id="fb-contact"
                type="email"
                maxLength={200}
                autoComplete="email"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </div>
            {turnstile.slot}
            {state.kind === 'error' && (
              <div className="notice error" role="alert">
                <p>{state.message}</p>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={state.kind === 'sending' || !message.trim()}>
                {state.kind === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
