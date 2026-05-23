import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

async function bootstrap() {
  // Start MSW only in development when env flag is set
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === 'true') {
    const { worker } = await import('./mocks/browser')
    await worker.start({
      onUnhandledRequest: 'bypass',
      serviceWorker: { url: '/mockServiceWorker.js' },
    })
    console.info('[MSW] Mock service worker started')
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

bootstrap()
