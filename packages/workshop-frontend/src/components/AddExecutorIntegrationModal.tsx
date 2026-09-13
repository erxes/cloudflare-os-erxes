import { Dialog } from '@cloudflare/kumo'
import { X, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BeginExecutorConnectResult,
  ExecutorDetectCandidate,
  ExecutorIntegrationInfo,
  ExecutorIntegrationKind,
  IntegrationCatalogRow,
  IntegrationCatalogSurface,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'
import { useAuthenticatedApi } from '../AuthContext'
import { logRpcFailure } from '../rpcErrors'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
  connected: ExecutorIntegrationInfo[]
}

const KINDS: { id: '' | ExecutorIntegrationKind; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'mcp', label: 'MCP' },
  { id: 'openapi', label: 'API' },
  { id: 'graphql', label: 'GraphQL' },
]

function looksLikeUrl(raw: string): boolean {
  const v = raw.trim()
  if (!v) return false
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) return true
  if (v.includes('/')) return true
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(v)) return true
  return false
}

async function handleConnectResult(
  result: BeginExecutorConnectResult,
  opts: {
    onConnected: () => void
    onOauthStarted: (slug: string) => void
    onNeedsSecret: (slug: string, templateId: string, label: string) => void
    onNeedsChoice: (candidates: ExecutorDetectCandidate[]) => void
    onError: (message: string) => void
    onNeedsErxes: () => void
  },
) {
  switch (result.status) {
    case 'connected':
      opts.onConnected()
      return
    case 'needs_oauth': {
      window.open(
        result.authorizationUrl,
        'executor-oauth',
        'popup=1,width=640,height=760',
      )
      opts.onOauthStarted(result.slug)
      return
    }
    case 'needs_secret':
      opts.onNeedsSecret(result.slug, result.template.id, result.template.label)
      return
    case 'needs_choice':
      opts.onNeedsChoice(result.candidates)
      return
    case 'needs_erxes':
      opts.onNeedsErxes()
      return
    case 'unsupported_kind':
      opts.onError(`${result.kind.toUpperCase()} connect is not supported yet. Try an MCP server.`)
      return
    case 'error':
      opts.onError(result.message)
      return
  }
}

export function AddExecutorIntegrationModal({
  open,
  onOpenChange,
  onConnected,
  connected,
}: Props) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'' | ExecutorIntegrationKind>('')
  const [catalog, setCatalog] = useState<IntegrationCatalogSurface | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ slug: string; template: string; label: string } | null>(
    null,
  )
  const [secretValue, setSecretValue] = useState('')
  const [choices, setChoices] = useState<ExecutorDetectCandidate[] | null>(null)

  const [oauthSlug, setOauthSlug] = useState<string | null>(null)

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
      const surface = await authenticatedApi.listIntegrationCatalog({
        q: q.trim() || undefined,
        kind: kind || undefined,
        limit: 80,
      })
      setCatalog(surface)
    } catch (err) {
      logRpcFailure('Failed to load integration catalog:', err)
      setCatalog({ fetchedAt: 0, stale: true, entries: [] })
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
      setChoices(null)
      setOauthSlug(null)
      setQ('')
      setKind('')
    }
  }, [open])

  useEffect(() => {
    if (!oauthSlug) return
    const deadline = Date.now() + 120_000
    const id = setInterval(() => {
      onConnected()
      if (Date.now() > deadline) {
        clearInterval(id)
        setOauthSlug(null)
      }
    }, 2500)
    return () => clearInterval(id)
  }, [oauthSlug, onConnected])

  useEffect(() => {
    if (!oauthSlug) return
    if (connected.some((c) => c.slug === oauthSlug && c.connected)) {
      setOauthSlug(null)
      onOpenChange(false)
    }
  }, [connected, oauthSlug, onOpenChange])

  const runHandlers = {
    onConnected: () => {
      onConnected()
      onOpenChange(false)
    },
    onOauthStarted: (slug: string) => {
      setOauthSlug(slug)
      setError(null)
      onConnected()
    },
    onNeedsSecret: (slug: string, templateId: string, label: string) => {
      setSecret({ slug, template: templateId, label })
    },
    onNeedsChoice: (candidates: ExecutorDetectCandidate[]) => {
      setChoices(candidates)
    },
    onError: (message: string) => setError(message),
    onNeedsErxes: () => setError('Sign in with erxes first, then connect integrations.'),
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
      setError('Connect failed.')
    } finally {
      setBusy(false)
    }
  }

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
      setError('Connect failed.')
    } finally {
      setBusy(false)
    }
  }

  const submitSecret = async () => {
    if (!secret || !secretValue.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await authenticatedApi.submitExecutorSecret({
        slug: secret.slug,
        template: secret.template,
        value: secretValue.trim(),
      })
      if (result.status === 'connected') {
        onConnected()
        onOpenChange(false)
      } else if (result.status === 'needs_erxes') {
        setError('Sign in with erxes first.')
      } else {
        setError(result.message)
      }
    } catch (err) {
      logRpcFailure('submitExecutorSecret failed:', err)
      setError('Save secret failed.')
    } finally {
      setBusy(false)
    }
  }

  const entries = catalog?.entries ?? []

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
            ) : choices ? (
              <div className="flex flex-col gap-2">
                <p className="text-[13px] text-kumo-subtle">Pick a detected surface:</p>
                {choices.map((c) => (
                  <button
                    key={`${c.kind}:${c.endpoint}`}
                    type="button"
                    disabled={busy}
                    className="rounded-xl border border-kumo-line px-3 py-2 text-left text-[13px] hover:bg-kumo-inset"
                    onClick={() => {
                      void (async () => {
                        setBusy(true)
                        setChoices(null)
                        try {
                          const result = await authenticatedApi.beginExecutorConnect({
                            source: 'manual',
                            kind: c.kind,
                            endpoint: c.endpoint,
                            name: c.name,
                          })
                          await handleConnectResult(result, runHandlers)
                        } finally {
                          setBusy(false)
                        }
                      })()
                    }}
                  >
                    <span className="font-medium text-kumo-default">{c.name}</span>
                    <span className="ml-2 text-kumo-inactive">{c.kind}</span>
                    <div className="mt-0.5 truncate text-[12px] text-kumo-subtle">{c.endpoint}</div>
                  </button>
                ))}
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

                {oauthSlug && (
                  <p className="text-[12px] text-kumo-subtle">
                    Finish sign-in in the popup. This dialog closes when the connection appears.
                  </p>
                )}

                {error && <p className="text-[12px] text-red-600">{error}</p>}

                <ul className="flex flex-col gap-1.5">
                  {entries.map((row) => {
                    const already =
                      (row.endpoint && connectedByEndpoint.has(row.endpoint)) ||
                      connected.some((c) => c.name === row.name && c.kind === row.kind)
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          disabled={busy || already || row.kind !== 'mcp' || !row.endpoint}
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
