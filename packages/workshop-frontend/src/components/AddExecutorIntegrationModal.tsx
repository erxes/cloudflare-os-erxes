import { Dialog } from '@cloudflare/kumo'
import { X, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BeginExecutorConnectResult,
  ExecutorIntegrationInfo,
  ExecutorIntegrationKind,
  IntegrationCatalogRow,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'
import { useAuthenticatedApi } from '../AuthContext'
import { logRpcFailure } from '../rpcErrors'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
  connected: ExecutorIntegrationInfo[]
  initialCatalogId?: string
}

const KINDS: { id: '' | ExecutorIntegrationKind; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'mcp', label: 'MCP' },
  { id: 'openapi', label: 'API' },
  { id: 'graphql', label: 'GraphQL' },
]

const OAUTH_POLL_MS = 2_000
const OAUTH_TIMEOUT_MS = 120_000

function looksLikeUrl(raw: string): boolean {
  const v = raw.trim()
  if (!v) return false
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) return true
  if (v.includes('/')) return true
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(v)) return true
  return false
}

async function pollUntilConnected(
  list: () => Promise<ExecutorIntegrationInfo[]>,
  slug: string,
  popup: Window | null,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < OAUTH_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, OAUTH_POLL_MS))
    try {
      const rows = await list()
      if (rows.some((row) => row.slug === slug && row.connected)) return true
    } catch {
      // keep polling
    }
    if (popup && popup.closed) {
      try {
        const rows = await list()
        return rows.some((row) => row.slug === slug && row.connected)
      } catch {
        return false
      }
    }
  }
  return false
}

async function handleConnectResult(
  result: BeginExecutorConnectResult,
  opts: {
    listIntegrations: () => Promise<ExecutorIntegrationInfo[]>
    onConnected: () => void
    onNeedsSecret: (slug: string, templateId: string, label: string) => void
    onError: (message: string) => void
  },
) {
  switch (result.status) {
    case 'connected':
      opts.onConnected()
      return
    case 'needs_oauth': {
      const popup = window.open(
        result.authorizationUrl,
        'executor-oauth',
        'popup=1,width=640,height=760',
      )
      const ok = await pollUntilConnected(opts.listIntegrations, result.slug, popup)
      if (ok) {
        opts.onConnected()
      } else {
        opts.onError('OAuth did not finish. Complete consent in the popup, then try again.')
      }
      return
    }
    case 'needs_secret':
      opts.onNeedsSecret(result.slug, result.template.id, result.template.label)
      return
    default:
      opts.onError('Connect failed.')
  }
}

export function AddExecutorIntegrationModal({
  open,
  onOpenChange,
  onConnected,
  connected,
  initialCatalogId,
}: Props) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'' | ExecutorIntegrationKind>('')
  const [catalog, setCatalog] = useState<IntegrationCatalogRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ slug: string; template: string; label: string } | null>(
    null,
  )
  const [secretValue, setSecretValue] = useState('')

  const connectedByEndpoint = useMemo(() => {
    const map = new Map<string, ExecutorIntegrationInfo>()
    for (const row of connected) {
      if (row.displayUrl) map.set(row.displayUrl, row)
      map.set(row.slug, row)
    }
    return map
  }, [connected])

  const loadCatalog = useCallback(async () => {
    try {
      const rows = await authenticatedApi.listIntegrationCatalog({
        q: q.trim() || undefined,
        kind: kind || undefined,
        limit: 80,
      })
      setCatalog(rows)
    } catch (err) {
      logRpcFailure('Failed to load integration catalog:', err)
      setCatalog([])
    }
  }, [authenticatedApi, q, kind])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      void loadCatalog()
    }, 200)
    return () => clearTimeout(t)
  }, [open, loadCatalog])

  useEffect(() => {
    if (!open) {
      setError(null)
      setSecret(null)
      setSecretValue('')
      setQ('')
      setKind('')
      setCatalog(null)
    }
  }, [open])

  const runHandlers = {
    listIntegrations: () => authenticatedApi.listExecutorIntegrations(),
    onConnected: () => {
      onConnected()
      onOpenChange(false)
    },
    onNeedsSecret: (slug: string, templateId: string, label: string) => {
      setSecret({ slug, template: templateId, label })
    },
    onError: (message: string) => setError(message),
  }

  const connectCatalogRow = async (row: IntegrationCatalogRow) => {
    setBusy(true)
    setError(null)
    try {
      const result = await authenticatedApi.beginExecutorConnect({
        source: 'catalog',
        catalogId: row.id,
      })
      await handleConnectResult(result, runHandlers)
    } catch (err) {
      logRpcFailure('beginExecutorConnect failed:', err)
      setError(err instanceof Error ? err.message : 'Connect failed.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !initialCatalogId || busy || secret) return
    let cancelled = false
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        const result = await authenticatedApi.beginExecutorConnect({
          source: 'catalog',
          catalogId: initialCatalogId,
        })
        if (cancelled) return
        await handleConnectResult(result, {
          listIntegrations: () => authenticatedApi.listExecutorIntegrations(),
          onConnected: () => {
            onConnected()
            onOpenChange(false)
          },
          onNeedsSecret: (slug, templateId, label) => {
            setSecret({ slug, template: templateId, label })
          },
          onError: (message) => setError(message),
        })
      } catch (err) {
        if (cancelled) return
        logRpcFailure('beginExecutorConnect failed:', err)
        setError(err instanceof Error ? err.message : 'Connect failed.')
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // One-shot when opening from a catalog tile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCatalogId])

  const connectDetectOrSearch = async () => {
    const trimmed = q.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      if (looksLikeUrl(trimmed)) {
        const result = await authenticatedApi.beginExecutorConnect({
          source: 'detect',
          url: trimmed,
        })
        await handleConnectResult(result, runHandlers)
      } else {
        await loadCatalog()
      }
    } catch (err) {
      logRpcFailure('detect/connect failed:', err)
      setError(err instanceof Error ? err.message : 'Connect failed.')
    } finally {
      setBusy(false)
    }
  }

  const submitSecret = async () => {
    if (!secret || !secretValue.trim()) return
    setBusy(true)
    setError(null)
    try {
      await authenticatedApi.submitExecutorSecret({
        slug: secret.slug,
        template: secret.template,
        value: secretValue.trim(),
      })
      onConnected()
      onOpenChange(false)
    } catch (err) {
      logRpcFailure('submitExecutorSecret failed:', err)
      setError(err instanceof Error ? err.message : 'Save secret failed.')
    } finally {
      setBusy(false)
    }
  }

  const entries = catalog ?? []

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog
        className="responsive-dialog connect-connector-dialog !z-[1000] !top-[clamp(28px,8vh,80px)] !flex !max-h-[calc(100vh-clamp(28px,8vh,80px)-28px)] !w-[min(560px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0"
        size="lg"
      >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-kumo-line px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-medium tracking-[-0.25px] text-kumo-default">
                Connect an integration
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-kumo-subtle">
                Search the catalog, or paste an MCP URL to detect.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <WorkshopIconButton {...props} aria-label="Close" className="shrink-0">
                  <X size={16} />
                </WorkshopIconButton>
              )}
            />
          </div>

          <div className="new-gatekeeper-scroll-balanced flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {secret ? (
              <div className="flex flex-col gap-3">
                <p className="text-[13px] text-kumo-subtle">
                  Enter the secret for <span className="text-kumo-default">{secret.slug}</span> (
                  {secret.label}).
                </p>
                <input
                  type="password"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[13px] text-kumo-default outline-none focus:border-kumo-brand"
                  placeholder={secret.label}
                  autoFocus
                />
                <WorkshopButton disabled={busy || !secretValue.trim()} onClick={() => void submitSecret()}>
                  {busy ? 'Saving…' : 'Save and connect'}
                </WorkshopButton>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <MagnifyingGlass
                      size={14}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
                    />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void connectDetectOrSearch()
                      }}
                      placeholder="Search or paste a URL…"
                      className="w-full rounded-lg border border-kumo-line bg-kumo-base py-2 pl-8 pr-3 text-[13px] text-kumo-default outline-none focus:border-kumo-brand"
                    />
                  </div>
                  {looksLikeUrl(q) && (
                    <WorkshopButton disabled={busy} onClick={() => void connectDetectOrSearch()}>
                      {busy ? '…' : 'Detect'}
                    </WorkshopButton>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {KINDS.map((k) => (
                    <button
                      key={k.label}
                      type="button"
                      onClick={() => setKind(k.id)}
                      className={`rounded-md px-2.5 py-1 text-[12px] ${
                        kind === k.id
                          ? 'bg-kumo-brand text-white'
                          : 'border border-kumo-line text-kumo-subtle hover:bg-kumo-inset'
                      }`}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>

                {error && <p className="text-[12px] text-red-600">{error}</p>}

                <ul className="flex flex-col gap-1.5">
                  {entries.map((row) => {
                    const already =
                      (!!row.endpoint && connectedByEndpoint.has(row.endpoint)) ||
                      connected.some((c) => c.name === row.name && c.kind === row.kind && c.connected)
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          disabled={busy || already || row.kind !== 'mcp'}
                          onClick={() => void connectCatalogRow(row)}
                          className="flex w-full items-center gap-3 rounded-xl border border-kumo-line px-3 py-2.5 text-left transition-colors hover:bg-kumo-inset disabled:opacity-50"
                        >
                          {row.iconUrl ? (
                            <img src={row.iconUrl} alt="" className="size-8 rounded-lg" />
                          ) : (
                            <div className="flex size-8 items-center justify-center rounded-lg bg-kumo-inset text-[12px] font-medium text-kumo-subtle">
                              {(row.name[0] || '?').toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-kumo-default">
                              {row.name}
                            </div>
                            <div className="truncate text-[12px] text-kumo-subtle">
                              {row.kind.toUpperCase()}
                              {row.description ? ` · ${row.description}` : ''}
                            </div>
                          </div>
                          {already ? (
                            <span className="text-[11px] text-kumo-inactive">Connected</span>
                          ) : row.kind !== 'mcp' ? (
                            <span className="text-[11px] text-kumo-inactive">Soon</span>
                          ) : (
                            <Plus size={14} className="text-kumo-subtle" />
                          )}
                        </button>
                      </li>
                    )
                  })}
                  {entries.length === 0 && (
                    <li className="py-8 text-center text-[13px] text-kumo-subtle">
                      {catalog === null ? 'Loading catalog…' : 'No matches'}
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
      </Dialog>
    </Dialog.Root>
  )
}
