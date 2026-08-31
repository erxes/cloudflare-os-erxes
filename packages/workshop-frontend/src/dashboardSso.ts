import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

export const DASHBOARD_CONNECT_CODE_PARAM = 'cfOsCode'
const HANDOFF_CODE_STORAGE_KEY = 'dashboardConnectCode'

// OAuthButtons mounts only after serverConfig loads, but useAuth strips cfOsCode from the URL on
// its first effect — earlier. Capture the code at module load so passwordless handoff survives.
const bootConnectCode = new URLSearchParams(window.location.search).get(DASHBOARD_CONNECT_CODE_PARAM)
if (bootConnectCode) {
  sessionStorage.setItem(HANDOFF_CODE_STORAGE_KEY, bootConnectCode)
}

export function readDashboardConnectCode(): string | null {
  return new URLSearchParams(window.location.search).get(DASHBOARD_CONNECT_CODE_PARAM)
}

export function peekDashboardConnectCode(): string | null {
  return sessionStorage.getItem(HANDOFF_CODE_STORAGE_KEY)
}

export function takeDashboardConnectCode(): string | null {
  const fromUrl = readDashboardConnectCode()
  const fromStorage = sessionStorage.getItem(HANDOFF_CODE_STORAGE_KEY)
  const code = fromUrl ?? fromStorage
  if (code) sessionStorage.removeItem(HANDOFF_CODE_STORAGE_KEY)
  return code
}

export function clearDashboardConnectCode(): void {
  sessionStorage.removeItem(HANDOFF_CODE_STORAGE_KEY)
}

export function hasDashboardConnectCode(): boolean {
  return readDashboardConnectCode() !== null || peekDashboardConnectCode() !== null
}

export function stripDashboardConnectCode(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(DASHBOARD_CONNECT_CODE_PARAM)) return
  url.searchParams.delete(DASHBOARD_CONNECT_CODE_PARAM)
  const search = url.searchParams.toString()
  const next = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
  window.history.replaceState(window.history.state, '', next)
}

export function clearStoredAuthToken(): void {
  localStorage.removeItem('authToken')
}

// StrictMode remounts OAuthButtons after disposing the first in-flight login. Deduplicate on one
// promise so the single-use connect code is redeemed exactly once.
let dashboardHandoffPromise: Promise<string> | null = null

export function redeemDashboardConnectCode(
  rpcStub: RpcStub<PublicApi>,
  vendorId: string,
  code: string,
): Promise<string> {
  dashboardHandoffPromise ??= (async () => {
    const { attempt } = await rpcStub.startGatekeeperLogin(vendorId, code)
    return attempt.wait()
  })().finally(() => {
    dashboardHandoffPromise = null
  })
  return dashboardHandoffPromise
}

/** Runs before React so embed handoff is not lost to StrictMode or delayed serverConfig. */
export async function runDashboardHandoffLogin(stub: RpcStub<PublicApi>): Promise<boolean> {
  const code = takeDashboardConnectCode()
  if (!code) return false

  clearStoredAuthToken()
  stripDashboardConnectCode()

  const cfg = await stub.getServerConfig()
  const vendor = cfg.authVendors?.[0]
  if (!vendor) throw new Error('Dashboard SSO is not configured.')

  const token = await redeemDashboardConnectCode(stub, vendor.vendorId, code)
  localStorage.setItem('authToken', token)
  clearDashboardConnectCode()
  return true
}

export function installErxesEmbedLogoutListener(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    if (event.data?.type !== 'erxes-logout') return
    clearStoredAuthToken()
    clearDashboardConnectCode()
    window.location.reload()
  })
}
