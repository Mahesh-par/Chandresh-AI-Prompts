import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config'

interface SavedPrompt {
  id: string
  name: string
  blockCount: number
  sourceUrl: string
  scrapedAt?: string
  createdAt?: string
}

interface PromptsApiResponse {
  success?: boolean
  count?: number
  prompts?: SavedPrompt[]
  error?: string
}

interface SendApiResponse {
  success?: boolean
  message?: string
  total?: number
  sent?: number
  skipped?: number
  failed?: number
  projectFolder?: string
  error?: string
}

interface RenameApiResponse {
  success?: boolean
  prompt?: SavedPrompt
  error?: string
}

function MyPromptsPage() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => {
    const fetchPrompts = async () => {
      setLoading(true)
      setError('')

      try {
        const response = await fetch(`${API_URL}/api/prompts`)
        const data: PromptsApiResponse = await response.json()

        if (!response.ok || !data.success) {
          setError(data.error || 'Failed to load prompts')
          return
        }

        setPrompts(data.prompts ?? [])
      } catch {
        setError('Failed to connect to the server. Make sure the backend is running.')
      } finally {
        setLoading(false)
      }
    }

    fetchPrompts()
  }, [])

  const handleSend = async (prompt: SavedPrompt) => {
    setSendingId(prompt.id)
    setStatusMessage('')
    setError('')

    try {
      setStatusMessage(
        `Opening 5 Chrome windows, generating ${prompt.blockCount} image(s) in parallel, and saving them to Chandresh Mockups/${prompt.name}. This may take several minutes...`,
      )

      const response = await fetch(`${API_URL}/api/prompts/${prompt.id}/send`, {
        method: 'POST',
      })
      const data: SendApiResponse = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to send prompts to Gemini')
        return
      }

      setStatusMessage(data.message || 'Prompts sent to Gemini')
    } catch {
      setError('Failed to connect to the server. Make sure the backend is running.')
    } finally {
      setSendingId(null)
    }
  }

  const startEditing = (prompt: SavedPrompt) => {
    setEditingId(prompt.id)
    setEditingName(prompt.name)
    setStatusMessage('')
    setError('')
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditingName('')
  }

  const handleRename = async (prompt: SavedPrompt) => {
    const nextName = editingName.trim()

    if (!nextName) {
      setError('Project name is required')
      return
    }

    if (nextName === prompt.name) {
      cancelEditing()
      return
    }

    setSavingId(prompt.id)
    setStatusMessage('')
    setError('')

    try {
      const response = await fetch(`${API_URL}/api/prompts/${prompt.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: nextName }),
      })
      const data: RenameApiResponse = await response.json()

      if (!response.ok || !data.success || !data.prompt) {
        setError(data.error || 'Failed to rename project')
        return
      }

      setPrompts((currentPrompts) =>
        currentPrompts.map((currentPrompt) =>
          currentPrompt.id === prompt.id ? data.prompt! : currentPrompt,
        ),
      )
      setStatusMessage('Project name updated')
      cancelEditing()
    } catch {
      setError('Failed to connect to the server. Make sure the backend is running.')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <main className="page-shell">
      <section className="app-panel prompts-panel" aria-labelledby="prompts-title">
        <header className="panel-header">
          <div>
            <p className="eyebrow">Saved Library</p>
            <h1 id="prompts-title" className="app-title">My Prompts</h1>
          </div>
          <Link to="/" className="nav-btn nav-btn-secondary">
            Home
          </Link>
        </header>

        {loading && <p className="prompts-status">Loading prompts...</p>}

        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="notice notice-success" role="status">
            {statusMessage}
          </div>
        )}

        {!loading && !error && prompts.length === 0 && (
          <p className="prompts-status">No saved prompts yet. Scrape a Claude link first.</p>
        )}

        {!loading && !error && prompts.length > 0 && (
          <div className="prompts-stack">
            {prompts.map((prompt) => (
              <article key={prompt.id} className="prompt-pillar">
                <div className="prompt-pillar-body">
                  {editingId === prompt.id ? (
                    <form
                      className="prompt-name-edit"
                      onSubmit={(event) => {
                        event.preventDefault()
                        handleRename(prompt)
                      }}
                    >
                      <input
                        className="prompt-name-input"
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        disabled={savingId === prompt.id}
                        aria-label="Project name"
                        autoFocus
                      />
                      <button
                        type="submit"
                        className="icon-btn icon-btn-primary"
                        disabled={savingId === prompt.id}
                        aria-label="Save project name"
                        title="Save"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={cancelEditing}
                        disabled={savingId === prompt.id}
                        aria-label="Cancel editing project name"
                        title="Cancel"
                      >
                        ×
                      </button>
                    </form>
                  ) : (
                    <div className="prompt-name-row">
                      <h2 className="prompt-pillar-name">{prompt.name}</h2>
                      <button
                        type="button"
                        className="icon-btn edit-name-btn"
                        onClick={() => startEditing(prompt)}
                        disabled={sendingId !== null || savingId !== null}
                        aria-label={`Edit project name for ${prompt.name}`}
                        title="Edit project name"
                      >
                        ✎
                      </button>
                    </div>
                  )}
                  <p className="prompt-pillar-meta">
                    {prompt.blockCount} block{prompt.blockCount === 1 ? '' : 's'}
                    {prompt.scrapedAt ? ` · ${prompt.scrapedAt}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => handleSend(prompt)}
                  disabled={sendingId !== null || editingId === prompt.id}
                  aria-label={`Send ${prompt.name} to Gemini`}
                >
                  {sendingId === prompt.id ? 'Generating...' : 'Send'}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

export default MyPromptsPage
