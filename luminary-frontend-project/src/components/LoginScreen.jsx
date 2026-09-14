import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, LogIn, ShieldCheck } from 'lucide-react';
import { LuminaryLogo } from './LuminaryLogo';
import { Field, Input, Select } from './ui';
import { practices as seededPractices } from '../data/organisation';
import { api, isLive } from '../services/api';

/**
 * Sign-in.
 *
 * The practice is chosen explicitly rather than inferred from the account, so a
 * wrong-tenant login fails loudly instead of silently landing someone in the
 * wrong clinic's data.
 *
 * This screen collects credentials and renders the outcome; it decides nothing.
 * `onAuthenticate` and `onUnlock` are async and return `{ ok, message }`, so the
 * same form serves a real server and the seeded demo build without knowing
 * which it is talking to. That is also why no client-side password comparison
 * survives here: in live mode there is nothing in the browser to compare
 * against, which is the entire point of moving authentication to the server.
 */
export default function LoginScreen({ onAuthenticate, onUnlock, onSignInAsOther, onDevBypass, lockedUser }) {
  const live = isLive();
  const [practices, setPractices] = useState(live ? [] : seededPractices);
  const [practiceId, setPracticeId] = useState(live ? '' : seededPractices[0].id);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [practiceLoadError, setPracticeLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingPractices, setLoadingPractices] = useState(live);

  const locked = Boolean(lockedUser);

  const loadLivePractices = useCallback(() => {
    if (!live || locked) return undefined;
    let cancelled = false;

    setPracticeLoadError('');
    setError('');
    setLoadingPractices(true);
    api.practices
      .list()
      .then((rows) => {
        if (cancelled) return;
        const options = rows.map((p) => ({
          id: p.id,
          name: p.name,
          short: p.short_name,
          location: p.city,
        }));
        setPractices(options);
        setPracticeId((current) => current || options[0]?.id || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setPractices([]);
        setPracticeId('');
        setPracticeLoadError(err.message);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingPractices(false);
      });

    return () => {
      cancelled = true;
    };
  }, [live, locked]);

  // In live mode the practice list comes from the server, because the client
  // has no seed data to fall back on and must not invent one.
  useEffect(() => loadLivePractices(), [loadLivePractices]);

  const byId = (id) => practices.find((p) => p.id === id);
  const selectedPractice = byId(practiceId);
  const practiceOptions = practices.length ? practices.map((p) => p.id) : [''];

  const submit = async (event) => {
    event.preventDefault();
    setError('');

    if (locked) {
      if (!password) return setError('Enter your password.');
      setBusy(true);
      const result = await onUnlock(password);
      setBusy(false);
      if (!result.ok) {
        setPassword('');
        setError(result.message);
      }
      return undefined;
    }

    if (!practiceId) return setError('Choose your practice.');
    if (!email.trim()) return setError('Enter your work email address.');
    if (!password) return setError('Enter your password.');

    setBusy(true);
    const result = await onAuthenticate({ practiceId, email: email.trim(), password });
    setBusy(false);
    if (!result.ok) {
      setPassword('');
      setError(result.message);
    }
    return undefined;
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <LuminaryLogo size={40} />
        </div>

        <div className="rounded-lg border border-edge bg-white/90 p-6 shadow-[0_22px_54px_-34px_rgba(11,21,36,0.55)] backdrop-blur">
          {locked ? (
            <>
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand text-md font-semibold text-white">
                  {lockedUser.initials}
                </div>
                <div>
                  <h1 className="text-lg font-semibold text-ink">{lockedUser.fullName}</h1>
                  <p className="text-sm text-muted">Session locked · {lockedUser.jobTitle}</p>
                </div>
              </div>
              <p className="mb-4 text-base leading-6 text-body">
                Your session locked after a period of inactivity. Enter your password to continue.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-[-0.01em] text-ink">Sign in</h1>
              <p className="mt-1 text-base text-muted">Access your practice workspace.</p>
            </>
          )}

          <form onSubmit={submit} className="mt-5 space-y-3.5">
            {!locked && (
              <>
                <Field label="Practice" required>
                  <Select
                    value={practiceId}
                    onChange={(e) => setPracticeId(e.target.value)}
                    options={practiceOptions}
                    render={(id) => {
                      if (id) return byId(id)?.name || id;
                      if (loadingPractices) return 'Loading practices...';
                      if (practiceLoadError) return 'Live API unavailable';
                      return 'No practices available';
                    }}
                    disabled={loadingPractices || Boolean(practiceLoadError)}
                  />
                </Field>
                <p className="-mt-1.5 text-xs text-muted">
                  {selectedPractice
                    ? `${byId(practiceId).name} · ${byId(practiceId).location}`
                    : live
                      ? 'Loading practices…'
                      : ''}
                </p>
                {practiceLoadError && (
                  <button
                    type="button"
                    onClick={loadLivePractices}
                    className="-mt-1 text-xs font-medium text-brand hover:underline"
                  >
                    Retry practice lookup
                  </button>
                )}

                <Field label="Work email" required>
                  <Input
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@practice.co.zw"
                  />
                </Field>
              </>
            )}

            <Field label="Password" required>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded border border-danger-line bg-danger-soft p-2.5">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
                <p className="text-sm leading-5 text-danger-deep">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-base font-medium text-ink-on transition hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogIn size={14} />
              {busy ? (locked ? 'Unlocking…' : 'Signing in…') : locked ? 'Unlock' : 'Sign in'}
            </button>

            {locked && (
              <button
                type="button"
                onClick={onSignInAsOther}
                className="w-full text-center text-sm font-medium text-brand hover:underline"
              >
                Sign in as a different user
              </button>
            )}
          </form>

          {!locked && (
            <div className="mt-5 border-t border-line pt-4">
              <p className="flex items-start gap-1.5 text-xs leading-5 text-muted">
                <ShieldCheck size={13} className="mt-0.5 shrink-0 text-warning" />
                {live ? (
                  <span>
                    <strong className="font-semibold text-ink">Connected to the Luminary API.</strong>{' '}
                    Credentials are verified server-side, and this session can be revoked centrally.
                  </span>
                ) : (
                  <span>
                    <strong className="font-semibold text-warning-deep">Demonstration build.</strong> Credentials are
                    checked in the browser and are not secure. Real authentication is enforced server-side.
                  </span>
                )}
              </p>
            </div>
          )}
        </div>

        {!locked && !live && (
          <div className="mt-4 rounded-lg border border-edge bg-white/72 p-4 shadow-[0_12px_32px_-28px_rgba(11,21,36,0.45)]">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-muted">Demo accounts</p>
            <p className="mb-2.5 text-xs text-muted">Password for every account: <code className="rounded bg-canvas px-1 py-0.5 font-mono text-2xs text-ink">luminary</code></p>
            <ul className="space-y-1 text-xs text-body">
              <li><strong className="font-medium text-ink">n.dhlamini@hararecentral.co.zw</strong>, receptionist, front desk</li>
              <li><strong className="font-medium text-ink">m.chen@hararecentral.co.zw</strong>, doctor, own list</li>
              <li><strong className="font-medium text-ink">s.moyo@hararecentral.co.zw</strong>, nurse, whole practice</li>
              <li><strong className="font-medium text-ink">r.chikafu@hararecentral.co.zw</strong>, practice manager</li>
              <li><strong className="font-medium text-ink">t.mapfumo@hararecentral.co.zw</strong>, admin, audit log</li>
              <li><strong className="font-medium text-ink">t.ncube@bulawayofamily.co.zw</strong>, <em>other practice</em></li>
            </ul>
            <button
              type="button"
              onClick={onDevBypass}
              className="mt-3 w-full rounded border border-edge-strong bg-white px-3 py-1.5 text-xs font-medium text-brand transition hover:border-brand"
            >
              Skip sign-in (demo shortcut)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
