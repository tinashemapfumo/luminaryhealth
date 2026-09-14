import React, { Component, useCallback, useEffect, useRef, useState } from 'react'
import LuminaryPMSDemo from './components/LuminaryDemo'
import LoginScreen from './components/LoginScreen'
import { users, practiceById, AUDIT } from './data/organisation'
import { auditEntry } from './lib/access'
import { usePersistentState } from './lib/persistence'
import { api, isLive, setToken, getToken, onSessionExpired } from './services/api'

/** Clinical workstations are shared. Lock the session rather than trusting the room. */
const IDLE_LIMIT_MS = 15 * 60 * 1000

class WorkspaceErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Workspace render failed', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
          <div className="max-w-xl rounded-lg border border-danger-line bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-danger-deep">Workspace failed to open</p>
            <h1 className="mt-2 text-lg font-semibold text-ink">{this.state.error.message}</h1>
            <p className="mt-2 text-sm text-muted">
              The API sign-in worked, but the workspace hit a frontend render error. Refresh after the fix is applied.
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

/**
 * The session gate.
 *
 * Authentication is the one concern that genuinely differs between the two
 * modes, so it is resolved here and nowhere else. Live mode holds a bearer
 * token and asks the server who it belongs to; demo mode matches against seeded
 * credentials in the browser. Everything below this component receives the same
 * `session` shape either way.
 *
 * The idle lock behaves differently in each, and deliberately: in demo mode
 * locking only hides the screen, while in live mode it is backed by a real
 * password re-check the server audits. Only one of those is a security control,
 * and the sign-in screen says which one you are looking at.
 */
function App() {
  const [session, setSession] = useState(null)
  const [lockedUser, setLockedUser] = useState(null)
  // Restoring a live session is a round trip, so the shell must not decide it
  // is unauthenticated before that answer arrives — otherwise every reload
  // flashes the sign-in screen at someone who is already signed in.
  const [restoring, setRestoring] = useState(isLive() && Boolean(getToken()))
  // The audit trail is the one collection that must not evaporate: an
  // append-only compliance record that resets on refresh is false assurance.
  // In live mode the server owns it and this is unused.
  const [auditLog, setAuditLog] = usePersistentState('audit', [])
  const idleTimer = useRef(null)

  const record = useCallback((entry) => {
    // In live mode the server writes audit entries from the authenticated
    // principal. A client-supplied audit trail is not a record of anything.
    if (isLive()) return
    setAuditLog((prev) => [auditEntry(entry), ...prev])
  }, [setAuditLog])

  const lock = useCallback(() => {
    setSession((current) => {
      if (!current) return current
      setLockedUser(current.user)
      record({ user: current.user, action: 'Session locked', detail: 'Idle timeout', severity: AUDIT.INFO })
      return null
    })
  }, [record])

  // Restore a live session on reload. The token alone is not trusted — the
  // server is asked to resolve it, so a revoked or expired one lands on
  // sign-in rather than rendering a workspace that can load nothing.
  useEffect(() => {
    if (!isLive() || !getToken()) return undefined
    let cancelled = false

    api.auth
      .me()
      .then(({ user, practice }) => {
        if (cancelled) return
        setSession({ user, practice, since: new Date().toISOString() })
      })
      .catch(() => {
        if (!cancelled) setToken(null)
      })
      .finally(() => {
        if (!cancelled) setRestoring(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // A session can end while the workspace is open — expiry, or revoked from
  // another machine. The API client reports that once, centrally, so every
  // page does not have to handle it.
  useEffect(
    () =>
      onSessionExpired(() => {
        setToken(null)
        setSession(null)
        setLockedUser(null)
      }),
    [],
  )

  // Any real interaction defers the lock; a quiet workstation locks itself.
  useEffect(() => {
    if (!session) return undefined
    const reset = () => {
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(lock, IDLE_LIMIT_MS)
    }
    const events = ['mousedown', 'keydown', 'touchstart', 'wheel']
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => {
      events.forEach((e) => window.removeEventListener(e, reset))
      window.clearTimeout(idleTimer.current)
    }
  }, [session, lock])

  /** Demo mode: the seeded user becomes the session directly. */
  const startDemoSession = (user) => {
    setLockedUser(null)
    setSession({ user, practice: practiceById(user.practiceId), since: new Date().toISOString() })
    record({
      user,
      action: 'Signed in',
      subject: practiceById(user.practiceId)?.short,
      detail: `${user.jobTitle} · ${user.role}`,
      severity: AUDIT.INFO,
    })
  }

  /**
   * Sign in, in whichever mode this build runs.
   *
   * Returns `{ ok, message }` rather than throwing, because the sign-in screen
   * renders the failure and there is nothing above here to catch it.
   */
  const authenticate = async ({ practiceId, email, password }) => {
    if (!isLive()) {
      const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase())
      if (!user || user.password !== password) {
        // One message for both cases — never reveal which accounts exist.
        return { ok: false, message: 'Those details do not match an account.' }
      }
      if (user.practiceId !== practiceId) {
        return {
          ok: false,
          message: `That account belongs to ${practiceById(user.practiceId)?.short}. Choose the correct practice above.`,
        }
      }
      startDemoSession(user)
      return { ok: true }
    }

    try {
      const { token } = await api.auth.signIn(practiceId, email, password)
      setToken(token)
      const { user, practice } = await api.auth.me()
      setLockedUser(null)
      setSession({ user, practice, since: new Date().toISOString() })
      return { ok: true }
    } catch (error) {
      setToken(null)
      return { ok: false, message: error.message }
    }
  }

  const signOut = async () => {
    if (session) record({ user: session.user, action: 'Signed out', severity: AUDIT.INFO })
    if (isLive()) {
      // Revoke server-side first, then clear locally. A failure here still
      // clears the browser, because leaving someone signed in at a shared
      // workstation because the network blipped is the worse outcome.
      try {
        await api.auth.signOut()
      } catch {
        // Deliberately ignored; the token is discarded either way.
      }
      setToken(null)
    }
    setSession(null)
    setLockedUser(null)
  }

  const unlock = async (password) => {
    const user = lockedUser

    if (!isLive()) {
      if (password !== user.password) {
        return { ok: false, message: 'That password does not match. Try again or sign in as a different user.' }
      }
      setLockedUser(null)
      setSession({ user, practice: practiceById(user.practiceId), since: new Date().toISOString() })
      record({ user, action: 'Session unlocked', severity: AUDIT.INFO })
      return { ok: true }
    }

    try {
      await api.auth.unlock(password)
      // The session never ended, so it is resumed rather than recreated —
      // and re-read, in case anything about the principal changed while the
      // workstation sat locked.
      const { user: fresh, practice } = await api.auth.me()
      setLockedUser(null)
      setSession({ user: fresh, practice, since: new Date().toISOString() })
      return { ok: true }
    } catch (error) {
      // A token that expired while locked cannot be unlocked, only replaced.
      if (error.isUnauthenticated && !getToken()) {
        setLockedUser(null)
        return { ok: false, message: 'Your session expired while locked. Please sign in again.' }
      }
      return { ok: false, message: error.message }
    }
  }

  const signInAsOther = async () => {
    if (isLive() && getToken()) {
      try {
        await api.auth.signOut()
      } catch {
        // Ignored, as above.
      }
      setToken(null)
    }
    setLockedUser(null)
  }

  const switchDemoPractice = useCallback((practiceId) => {
    if (isLive() || !session) return
    const practice = practiceById(practiceId)
    if (!practice) return

    const nextUser =
      users.find((user) => user.practiceId === practiceId && user.role === session.user.role) ||
      users.find((user) => user.practiceId === practiceId && user.role === 'manager') ||
      users.find((user) => user.practiceId === practiceId)

    if (!nextUser) return
    setLockedUser(null)
    setSession({ user: nextUser, practice, since: new Date().toISOString() })
    record({
      user: nextUser,
      action: 'Switched practice',
      subject: practice.short,
      detail: `${session.practice?.short || session.practice?.name} to ${practice.short || practice.name}`,
      severity: AUDIT.INFO,
    })
  }, [record, session])

  if (restoring) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-base text-muted">Restoring your session…</p>
      </div>
    )
  }

  if (!session) {
    return (
      <LoginScreen
        onAuthenticate={authenticate}
        onUnlock={unlock}
        onSignInAsOther={signInAsOther}
        lockedUser={lockedUser}
        onDevBypass={() => startDemoSession(users.find((u) => u.id === 'USR-007'))}
      />
    )
  }

  return (
    <WorkspaceErrorBoundary key={session.user.id}>
      <LuminaryPMSDemo
        session={session}
        onSignOut={signOut}
        onLock={lock}
        onSwitchPractice={switchDemoPractice}
        auditLog={auditLog}
        recordAudit={record}
      />
    </WorkspaceErrorBoundary>
  )
}

export default App
