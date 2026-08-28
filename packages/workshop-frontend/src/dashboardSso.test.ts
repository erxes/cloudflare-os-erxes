// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import {
  clearDashboardConnectCode,
  hasDashboardConnectCode,
  peekDashboardConnectCode,
  redeemDashboardConnectCode,
  runDashboardHandoffLogin,
  stripDashboardConnectCode,
} from './dashboardSso'

describe('dashboardSso', () => {
  afterEach(() => {
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('hasDashboardConnectCode is true when the handoff code lives in sessionStorage', () => {
    sessionStorage.setItem('dashboardConnectCode', 'handoff-code')
    expect(hasDashboardConnectCode()).toBe(true)
  })

  it('stripDashboardConnectCode removes cfOsCode from the URL', () => {
    window.history.replaceState({}, '', '/?cfOsCode=handoff-code')
    stripDashboardConnectCode()
    expect(window.location.search).not.toContain('cfOsCode')
  })

  it('redeemDashboardConnectCode deduplicates concurrent calls', async () => {
    const wait = vi.fn(async () => 'session-token')
    const startGatekeeperLogin = vi.fn(async () => ({
      url: 'https://example.test/login',
      attempt: { wait },
    }))
    const rpcStub = { startGatekeeperLogin } as unknown as RpcStub<PublicApi>

    const [first, second] = await Promise.all([
      redeemDashboardConnectCode(rpcStub, 'erxes', 'connect-code'),
      redeemDashboardConnectCode(rpcStub, 'erxes', 'connect-code'),
    ])

    expect(first).toBe('session-token')
    expect(second).toBe('session-token')
    expect(startGatekeeperLogin).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('runDashboardHandoffLogin stores a session token and clears the handoff code', async () => {
    sessionStorage.setItem('dashboardConnectCode', 'handoff-code')
    window.history.replaceState({}, '', '/?cfOsCode=handoff-code')
    localStorage.setItem('authToken', 'stale-token')

    const wait = vi.fn(async () => 'fresh-token')
    const startGatekeeperLogin = vi.fn(async () => ({
      url: 'https://example.test/login',
      attempt: { wait },
    }))
    const rpcStub = {
      getServerConfig: async () => ({ authVendors: [{ vendorId: 'erxes', displayName: 'erxes' }] }),
      startGatekeeperLogin,
    } as unknown as RpcStub<PublicApi>

    const ok = await runDashboardHandoffLogin(rpcStub)

    expect(ok).toBe(true)
    expect(localStorage.getItem('authToken')).toBe('fresh-token')
    expect(peekDashboardConnectCode()).toBeNull()
    expect(window.location.search).not.toContain('cfOsCode')
    expect(startGatekeeperLogin).toHaveBeenCalledWith('erxes', 'handoff-code')
  })

  it('clearDashboardConnectCode drops a stashed handoff code', () => {
    sessionStorage.setItem('dashboardConnectCode', 'handoff-code')
    clearDashboardConnectCode()
    expect(peekDashboardConnectCode()).toBeNull()
  })
})
