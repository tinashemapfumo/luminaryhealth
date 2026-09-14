import React, { useState } from 'react';
import { AlertTriangle, Check, UserPlus } from 'lucide-react';
import { LuminaryLogo } from './LuminaryLogo';
import { Field, Input } from './ui';
import { api } from '../services/api';

export default function AcceptInvitationScreen({ token, onComplete }) {
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!fullName.trim()) return setError('Enter your full name.');
    if (!displayName.trim()) return setError('Enter the name shown in Luminary.');
    if (!password) return setError('Choose a password.');
    if (password !== confirmPassword) return setError('Passwords do not match.');

    setBusy(true);
    try {
      const user = await api.users.acceptInvitation({
        token,
        fullName: fullName.trim(),
        displayName: displayName.trim(),
        password,
      });
      setCreated(user);
    } catch (err) {
      setError(err.message || 'Could not accept this invitation.');
    } finally {
      setBusy(false);
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
          {created ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success">
                  <Check size={16} />
                </span>
                <div>
                  <h1 className="text-lg font-semibold text-ink">Account ready</h1>
                  <p className="mt-1 text-base text-muted">Sign in with {created.email} to continue.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onComplete}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-base font-medium text-ink-on transition hover:bg-ink-hover"
              >
                Go to sign in
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <UserPlus size={16} />
                </span>
                <div>
                  <h1 className="text-lg font-semibold text-ink">Accept invitation</h1>
                  <p className="mt-1 text-base text-muted">Create your Luminary account for this practice.</p>
                </div>
              </div>

              <form onSubmit={submit} className="mt-5 space-y-3.5">
                <Field label="Full name" required>
                  <Input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" />
                </Field>
                <Field label="Display name" required>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="nickname" />
                </Field>
                <Field label="Password" required>
                  <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="Confirm password" required>
                  <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" />
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
                  {busy ? 'Creating account...' : 'Create account'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
