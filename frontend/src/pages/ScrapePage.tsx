import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config'

interface PromptBlock {
  id: string
  content: string
  ChatTime: string
}

interface ApiResponse {
  success?: boolean
  count?: number
  results?: PromptBlock[]
  ChatTime?: string
  message?: string
  error?: string
}

function ScrapePage() {
  const [url, setUrl] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string>('')
  const [copiedId, setCopiedId] = useState<string>('')
  const promptCount = result?.count ?? result?.results?.length ?? 0

  const copyWithFallback = (text: string) => {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.setAttribute('readonly', '')
    textArea.style.position = 'fixed'
    textArea.style.left = '-9999px'
    textArea.style.top = '0'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    const copied = document.execCommand('copy')
    document.body.removeChild(textArea)

    if (!copied) {
      throw new Error('Fallback copy failed')
    }
  }

  const handleCopy = async (prompt: PromptBlock) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(prompt.content)
      } else {
        copyWithFallback(prompt.content)
      }

      setError('')
      setCopiedId(prompt.id)
      window.setTimeout(() => setCopiedId(''), 1600)
    } catch {
      try {
        copyWithFallback(prompt.content)
        setError('')
        setCopiedId(prompt.id)
        window.setTimeout(() => setCopiedId(''), 1600)
      } catch {
        setError('Copy failed. Please select the text manually.')
      }
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (!url.trim()) {
      setError('Please enter a Claude chat URL')
      return
    }

    setLoading(true)
    setError('')
    setResult(null)

    try {
      const response = await fetch(`${API_URL}/api/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url.trim(),
        }),
      })

      const data: ApiResponse = await response.json()

      if (!response.ok || data.success === false) {
        setError(data.message || data.error || 'Failed to scrape the URL')
      } else if (data.results && data.results.length === 0) {
        setError(data.message || 'No matching content found')
      } else {
        setResult(data)
      }
    } catch {
      setError('Failed to connect to the server. Make sure the backend is running.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="page-shell">
      <section className="app-panel" aria-labelledby="page-title">
        <header className="panel-header">
          <div>
            <p className="eyebrow"></p>
            <h1 id="page-title" className="app-title">AI Master Story</h1>
          </div>
          <Link to="/my-prompts" className="nav-btn">
            My Prompts
          </Link>
        </header>

        <form className="scrape-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="url">
              Claude Share URL
            </label>
            <input
              id="url"
              type="url"
              className="form-input"
              placeholder="https://claude.ai/share/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="submit-btn"
            disabled={loading}
          >
            {loading ? 'Scraping...' : 'Scrape and Send'}
          </button>
        </form>

        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}

        {result && result.success && (
          <section className="result-container" aria-live="polite">
            <div className="result-summary">
              <div>
                <p className="result-label"></p>
                <h2 className="result-title">{promptCount} block(s) found</h2>
              </div>
              {result.ChatTime && <span className="time-pill">{result.ChatTime}</span>}
            </div>

            <div className="prompt-list">
              {result.results?.map((prompt) => (
                <article key={prompt.id} className="prompt-item">
                  <div className="prompt-header-row">
                    <div>
                      <div className="prompt-id">{prompt.id}</div>
                      {prompt.ChatTime && <div className="prompt-time">{prompt.ChatTime}</div>}
                    </div>
                    <button
                      type="button"
                      className="copy-btn"
                      onClick={() => handleCopy(prompt)}
                      aria-label={`Copy ${prompt.id}`}
                    >
                      {copiedId === prompt.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="prompt-content">{prompt.content}</pre>
                </article>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  )
}

export default ScrapePage
