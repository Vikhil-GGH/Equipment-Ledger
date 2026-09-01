import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { AuthProvider } from './features/auth/AuthProvider'
import { App } from './App'
import './index.css'

// autoUpdate: a new service worker activates and takes over silently on the
// next load rather than prompting — appropriate for an internal tool where
// staleness just means "not the very latest build", not a decision the user
// needs to make.
if ('serviceWorker' in navigator) {
  registerSW({ immediate: true })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
