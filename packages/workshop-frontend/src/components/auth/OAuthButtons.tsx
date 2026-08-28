import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { Button, Banner } from '@cloudflare/kumo'
import { stripDashboardConnectCode } from '../../dashboardSso'

interface OAuthButtonsProps {
  rpcStub: RpcStub<PublicApi>
  vendors: AuthVendorInfo[]
  onSuccess?: () => void
}

/**
 * Renders a sign-in button per auth-capable gatekeeper vendor. Clicking opens the gatekeeper's
 * OAuth popup (which self-closes) and waits for the result over RPC; on success the session token is
 * stored and the app re-authenticates.
 */
export default function OAuthButtons({ rpcStub, vendors, onSuccess }: OAuthButtonsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // A dashboard-embedded sign-in arrives with `?cfOsCode=<single-use code>`: start the matching
  // vendor's flow immediately with that code so the gatekeeper skips its password form.
  const autoCodeRef = useRef<string | null | undefined>(undefined)
  if (autoCodeRef.current === undefined) {
    autoCodeRef.current = new URLSearchParams(window.location.search).get('cfOsCode')
  }
  const autoStartedRef = useRef(false)
  useEffect(() => {
    const code = autoCodeRef.current
    if (!code || autoStartedRef.current || vendors.length === 0) return
    // The embedded dashboard only signs in through its own vendor; pick the sole auth vendor
    // configured with connect codes (the erxes gatekeeper).
    autoStartedRef.current = true
    start(vendors[0].vendorId, code)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount when vendors arrive
  }, [vendors])

  // Track the pop-up-poll interval, the in-flight login RPC, and mounted state so we can stop a
  // sign-in attempt that's still running if the component unmounts (e.g. the user navigates away
  // mid-login): clear the poller, dispose the RPC (Cap'n Web treats this as a best-effort cancel and
  // frees the client-side pending call), and avoid updating state on an unmounted component.
  const pollRef = useRef<number | null>(null)
  const loginRpcRef = useRef<Disposable | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-assert on (re)mount: under StrictMode the effect runs mount→cleanup→mount, and the cleanup
    // below sets this false. Without resetting here it would stay false for the component's whole
    // life, causing a successful login result to be silently dropped by the `!mountedRef.current`
    // guards below.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollRef.current !== null) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (loginRpcRef.current) {
        try { loginRpcRef.current[Symbol.dispose]() } catch { /* already settled/disposed */ }
        loginRpcRef.current = null
      }
    }
  }, [])

  if (vendors.length === 0) return null

  async function start(vendorId: string, initialCode?: string) {
    setError(null)
    setPending(vendorId)
    try {
      const { url, attempt } = await rpcStub.startGatekeeperLogin(vendorId, initialCode)
      // `attempt` is the capability to receive the session token; track it so we can dispose it
      // (cancelling the wait server-side) if the component unmounts mid-login.
      loginRpcRef.current = attempt as unknown as Disposable
      // Connect-code SSO finishes inside startGatekeeperLogin; the browser must not open a
      // frame (Workshop CSP is frame-src srcdoc:). Manual sign-in still uses a popup.
      const popup = initialCode
        ? null
        : window.open(url, 'gatekeeper-login', 'popup,width=520,height=680')
      if (!initialCode && !popup) {
        try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already disposed */ }
        loginRpcRef.current = null
        throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
      }

      const token = await new Promise<string>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
          // Dispose the attempt stub: cancels the in-flight wait() (e.g. pop-up closed), no-op if it
          // already settled.
          try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already settled */ }
          loginRpcRef.current = null
          fn()
        }
        if (popup) {
          pollRef.current = window.setInterval(() => {
            if (popup.closed) finish(() => reject(new Error('Sign-in was cancelled.')))
          }, 500)
        }
        attempt.wait()
          .then(t => finish(() => resolve(t)))
          .catch(e => finish(() => reject(e instanceof Error ? e : new Error('Could not sign in'))))
      })
      if (!mountedRef.current) return  // user navigated away mid-flow; drop the result
      localStorage.setItem('authToken', token)
      stripDashboardConnectCode()
      if (onSuccess) onSuccess()
      else window.location.reload()
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Could not sign in')
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      {error && <Banner variant="error" title={error} />}
      {vendors.map((vendor) => (
        <Button
          key={vendor.vendorId}
          variant="secondary"
          onClick={() => start(vendor.vendorId)}
          loading={pending === vendor.vendorId}
          disabled={pending !== null}
          className="w-full justify-center"
        >
          {vendor.logo && (
            <img
              src={vendor.logo.url}
              alt=""
              className="mr-1"
              style={{ height: 18, width: 'auto' }}
            />
          )}
          Continue with {vendor.displayName}
        </Button>
      ))}
    </div>
  )
}
