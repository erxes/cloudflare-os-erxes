export const DASHBOARD_CONNECT_CODE_PARAM = 'cfOsCode'

export function readDashboardConnectCode(): string | null {
  return new URLSearchParams(window.location.search).get(DASHBOARD_CONNECT_CODE_PARAM)
}

export function hasDashboardConnectCode(): boolean {
  return readDashboardConnectCode() !== null
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

export function installErxesEmbedLogoutListener(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    if (event.data?.type !== 'erxes-logout') return
    clearStoredAuthToken()
    window.location.reload()
  })
}
