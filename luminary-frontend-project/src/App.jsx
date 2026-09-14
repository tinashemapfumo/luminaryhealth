import React, { Component, useCallback, useEffect, useRef, useState } from 'react'
import WorkspaceShell from './components/LuminaryDemo'
import LoginScreen from './components/LoginScreen'
import AcceptInvitationScreen from './components/AcceptInvitationScreen'
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
 * Live session gate.
 *
 * Authentication is always server-backed. The browser holds only a bearer token;
 * the API owns identity, tenancy, audit, and revocation.
 */
function App() {
  const [session, setSession] = useState(null)
  const [lockedUser, setLockedUser] = useState(null)
  const [restoring, setRestoring] = useState(isLive() && Boolean(getToken()))
  const [inviteToken, setInviteToken] = useState(() => {
    const url = new URL(window.location.href)
    const pathToken = url.pathname.startsWith('/invite/') ? url.pathname.split('/invite/')[1] : ''
    return url.searchParams.get('invite') || url.searchParams.get('token') || pathToken || ''
  })
  const idleTimer = useRef(null)

  const record = useCallback(() => {}, [])
  const switchPractice = useCallback(() => {}, [])

  const lock = useCallback(() => {
    setSession((current) => {
      if (!current) return current
      setLockedUser(current.user)
      return null
    })
  }, [])

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

  useEffect(
    () =>
      onSessionExpired(() => {
        setToken(null)
        setSession(null)
        setLockedUser(null)
      }),
    [],
  )

  useEffect(() => {
    if (!session) return undefined
    const reset = () => {
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(lock, IDLE_LIMIT_MS)
    }
    const events = ['mousedown', 'keydown', 'touchstart', 'wheel']
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }))
    reset()
    return () => {
      events.forEach((event) => window.removeEventListener(event, reset))
      window.clearTimeout(idleTimer.current)
    }
  }, [session, lock])

  const authenticate = async ({ practiceId, email, password }) => {
    try {
      const { token } = await api.auth.signIn(practiceId, email, password)
      setToken(token)
      const { user, practice } = await api.auth.me(token)
      setLockedUser(null)
      setSession({ user, practice, since: new Date().toISOString() })
      return { ok: true }
    } catch (error) {
      setToken(null)
      return { ok: false, message: error.message }
    }
  }

  const signOut = async () => {
    try {
      await api.auth.signOut()
    } catch {
      // The local token is discarded even if the network is gone.
    }
    setToken(null)
    setSession(null)
    setLockedUser(null)
  }

  const unlock = async (password) => {
    try {
      await api.auth.unlock(password)
      const { user, practice } = await api.auth.me()
      setLockedUser(null)
      setSession({ user, practice, since: new Date().toISOString() })
      return { ok: true }
    } catch (error) {
      if (error.isUnauthenticated && !getToken()) {
        setLockedUser(null)
        return { ok: false, message: 'Your session expired while locked. Please sign in again.' }
      }
      return { ok: false, message: error.message }
    }
  }

  const signInAsOther = async () => {
    if (getToken()) {
      try {
        await api.auth.signOut()
      } catch {
        // Ignored, as above.
      }
      setToken(null)
    }
    setLockedUser(null)
  }

  const clearInvitation = () => {
    window.history.replaceState(null, '', '/')
    setInviteToken('')
  }

  if (restoring) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-base text-muted">Restoring your session...</p>
      </div>
    )
  }

  if (!session && inviteToken) {
    return <AcceptInvitationScreen token={decodeURIComponent(inviteToken)} onComplete={clearInvitation} />
  }

  if (!session) {
    return (
      <LoginScreen
        onAuthenticate={authenticate}
        onUnlock={unlock}
        onSignInAsOther={signInAsOther}
        lockedUser={lockedUser}
      />
    )
  }

  return (
    <WorkspaceErrorBoundary key={session.user.id}>
      <WorkspaceShell
        session={session}
        onSignOut={signOut}
        onLock={lock}
        onSwitchPractice={switchPractice}
        auditLog={[]}
        recordAudit={record}
      />
    </WorkspaceErrorBoundary>
  )
}

export default App
