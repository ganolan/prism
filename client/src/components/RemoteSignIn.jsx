import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRemoteLogin, getRemoteLoginScreen, remoteLoginClick, remoteLoginType, remoteLoginKey, stopRemoteLogin,
} from '../services/api.js';

// Remote sign-in (#136): the server's own Microsoft sign-in page, shown as a picture
// that refreshes about every 0.7 s. A tap on it is a tap on the server's page; text
// typed in the field below goes into whatever box is selected there. Works from a
// phone or a laptop with nothing installed. The text is not kept anywhere.
// onClose(signedIn) when finished or cancelled.
const PAGE = { width: 400, height: 720 }; // the server's viewport (remoteLogin.VIEWPORT)
const REFRESH_MS = 700;

const ENDED = {
  stopped: 'The sign-in was closed.',
  timed_out: 'The sign-in was left too long and closed.',
  failed: 'The sign-in could not open.',
};

export default function RemoteSignIn({ onClose }) {
  const [state, setState] = useState({ status: 'starting' });
  const [src, setSrc] = useState(null);
  const [text, setText] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState(null);
  const run = useRef(0);

  const start = useCallback(async () => {
    const mine = (run.current += 1);
    setError(null);
    setState({ status: 'starting' });
    try {
      const s = await startRemoteLogin();
      if (mine !== run.current) return;
      setState(s);
      // Refresh the picture until the sign-in ends (done, stopped, timed out).
      while (mine === run.current) {
        const r = await getRemoteLoginScreen();
        if (mine !== run.current) return;
        if (r.state) { setState(r.state); return; }
        const url = URL.createObjectURL(r.image);
        setSrc((old) => { if (old) URL.revokeObjectURL(old); return url; });
        await new Promise((ok) => setTimeout(ok, REFRESH_MS));
      }
    } catch (err) {
      if (mine === run.current) { setError(err.message); setState({ status: 'failed' }); }
    }
  }, []);

  useEffect(() => {
    start();
    return () => { run.current += 1; };
  }, [start]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const send = async (fn) => {
    try { setError(null); await fn(); } catch (err) { setError(err.message); }
  };

  function tap(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) * PAGE.width) / r.width);
    const y = Math.round(((e.clientY - r.top) * PAGE.height) / r.height);
    send(() => remoteLoginClick(x, y));
  }

  function typeIt(e) {
    e.preventDefault();
    if (!text) return;
    const t = text;
    setText('');
    send(() => remoteLoginType(t));
  }

  async function cancel() {
    run.current += 1;
    await stopRemoteLogin().catch(() => {});
    onClose(false);
  }

  if (state.status === 'done') {
    return (
      <div className="remote-signin">
        <p className="alert alert-success" role="status">Signed in. Prism saved the session.</p>
        <button type="button" className="primary" onClick={() => onClose(true)}>Close</button>
      </div>
    );
  }

  if (ENDED[state.status]) {
    return (
      <div className="remote-signin">
        <p className="alert alert-warning" role="status">{state.message || error || ENDED[state.status]}</p>
        <div className="remote-signin__row">
          <button type="button" className="secondary" onClick={start}>Start again</button>
          <button type="button" className="ghost" onClick={() => onClose(false)}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote-signin">
      <p className="text-sm text-muted">
        This is the sign-in page on the server. Tap a box on it, type in the field below, then press Type it.
        At &quot;Stay signed in?&quot; choose Yes, so the server can renew the session by itself later.
      </p>
      <div className="remote-signin__screen">
        {src
          ? <img src={src} alt="Schoology sign-in page on the server" onClick={tap} width={PAGE.width} height={PAGE.height} />
          : <p className="text-sm text-muted">Opening the sign-in on the server…</p>}
      </div>
      <form className="remote-signin__row" onSubmit={typeIt}>
        <input
          type={show ? 'text' : 'password'} value={text} onChange={(e) => setText(e.target.value)}
          aria-label="Text to type" autoComplete="off" autoCapitalize="none" spellCheck={false}
        />
        <label className="remote-signin__show text-sm">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show
        </label>
        <button type="submit" className="primary" disabled={!text}>Type it</button>
      </form>
      <div className="remote-signin__row">
        <button type="button" className="secondary" onClick={() => send(() => remoteLoginKey('Enter'))}>Enter</button>
        <button type="button" className="secondary" onClick={() => send(() => remoteLoginKey('Backspace'))}>Backspace</button>
        <button type="button" className="secondary" onClick={() => send(() => remoteLoginKey('Tab'))}>Tab</button>
        <button type="button" className="ghost" onClick={cancel}>Cancel</button>
      </div>
      {error && <p className="alert alert-warning">{error}</p>}
    </div>
  );
}
