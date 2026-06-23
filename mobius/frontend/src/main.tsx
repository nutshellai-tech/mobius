import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { installStaleChunkHandler } from './services/handle-stale-chunk'

installStaleChunkHandler()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
