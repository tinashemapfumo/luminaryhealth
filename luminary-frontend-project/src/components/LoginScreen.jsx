import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, LogIn, ShieldCheck } from 'lucide-react';
import { LuminaryLogo } from './LuminaryLogo';
import { Field, Input, Select } from './ui';
import { api } from '../services/api';

/**
 * Sign-in.
 *
 * The practice is chosen explicitly rather than inferred from the account, so a
 * wrong-tenant login fails loudly instead of silently landing someone in the
 * wrong clinic's data. The practice list comes only from the API.
 */
export default function LoginScreen({ onAuthenticate, onUnlock, onSignInAsOther, lockedUser }) {
  const [practices, setPractices] = useState([]);
  const [practiceId, setPracticeId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [practiceLoadError, setPracticeLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingPractices, setLoadingPractices] = useState(true);

  const locked = Boolean(lockedUser);

  const loadPractices = useCallback(() => {
    if (locked) return undefined;
    let cancelled = false;

    setPracticeLoadError('');
    setError('');
    setLoadingPractices(true);
    api.practices
      .list()
      .then((rows) => {
        if (cancelled) return;
        const options = rows.map((practice) => ({
          id: practice.id,
          name: practice.name,
          short: practice.short_name,
          location: practice.city,
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
  }, [locked]);

  useEffect(() => loadPractices(), [loadPractices]);

  const byId = (id) => practices.find((practice) => practice.id === id);
  const selectedPractice = byId(practiceId);
  const practiceOptions = practices.length ? practices.map((practice) => practice.id) : [''];

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
                  <p className="text-sm text-muted">Session locked - {lockedUser.jobTitle}</p>
                </div>
              </div>
              <p className="mb-4 text-base leading-6 text-body">
                Your session locked after a period of inactivity. Enter your password to continue.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-ink">Sign in</h1>
              <p className="mt-1 text-base text-muted">Access your practice workspace.</p>
            </>
          )}

          <form onSubmit={submit} className="mt-5 space-y-3.5">
            {!locked && (
              <>
                <Field label="Practice" required>
                  <Select
                    value={practiceId}
                    onChange={(event) => setPracticeId(event.target.value)}
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
                  {selectedPractice ? `${selectedPractice.name} - ${selectedPractice.location}` : 'Loading practices...'}
                </p>
                {practiceLoadError && (
                  <button
                    type="button"
                    onClick={loadPractices}
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
                    onChange={(event) => setEmail(event.target.value)}
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
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
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
              {busy ? (locked ? 'Unlocking...' : 'Signing in...') : locked ? 'Unlock' : 'Sign in'}
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
                <span>
                  <strong className="font-semibold text-ink">Connected to the Luminary API.</strong>{' '}
                  Credentials are verified server-side, and this session can be revoked centrally.
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
