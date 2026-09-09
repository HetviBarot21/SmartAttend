import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker } from './sw/register'
import { startSyncOnReconnect } from './services/syncService'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registered after render so precaching never competes with first paint.
registerServiceWorker()

// Flush the outbound attendance queue now (if online) and on every reconnect.
startSyncOnReconnect()
