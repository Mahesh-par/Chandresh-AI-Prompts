import { BrowserRouter, Route, Routes } from 'react-router-dom'
import ScrapePage from './pages/ScrapePage'
import MyPromptsPage from './pages/MyPromptsPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ScrapePage />} />
        <Route path="/my-prompts" element={<MyPromptsPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
