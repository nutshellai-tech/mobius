import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useStore } from '../store'
import { readActiveGuidedDemo } from '../services/guided-demo'
import { GuideHelpModal } from './guide-help'
import {
  CONTEXT_SETUP_DEMO_TOUR_EVENT,
  EXTENSION_DEMO_TOUR_EVENT,
  FIRST_ISSUE_TOUR_EVENT,
  GUIDED_DEMO_TOUR_EVENT,
  LOGO_REVIEW_DEMO_TOUR_EVENT,
  PROJECT_IMPORT_DEMO_TOUR_EVENT,
  SELF_EVOLVE_DEMO_TOUR_EVENT,
  runFirstIssueTourForPath,
} from '../services/tour'

const FIRST_LOGIN_TOUR_KEY_PREFIX = 'imac:first-login-tour-seen:v1:'
const FIRST_LOGIN_TOUR_OPEN_KEY_PREFIX = 'imac:first-login-tour-open:v1:'
const FIRST_LOGIN_TOUR_OPEN_TTL_MS = 45_000
const FIRST_LOGIN_TOUR_TAB_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`

function firstLoginTourKey(userId: string) {
  return `${FIRST_LOGIN_TOUR_KEY_PREFIX}${userId}`
}

function firstLoginTourOpenKey(userId: string) {
  return `${FIRST_LOGIN_TOUR_OPEN_KEY_PREFIX}${userId}`
}

function claimFirstLoginGuide(openKey: string) {
  try {
    const now = Date.now()
    const raw = localStorage.getItem(openKey)
    const current = raw ? JSON.parse(raw) : null
    if (current?.tabId && current.tabId !== FIRST_LOGIN_TOUR_TAB_ID && Number(current.expiresAt) > now) {
      return false
    }
    localStorage.setItem(openKey, JSON.stringify({
      tabId: FIRST_LOGIN_TOUR_TAB_ID,
      expiresAt: now + FIRST_LOGIN_TOUR_OPEN_TTL_MS,
    }))
    const claimed = JSON.parse(localStorage.getItem(openKey) || '{}')
    return claimed?.tabId === FIRST_LOGIN_TOUR_TAB_ID
  } catch {
    return true
  }
}

function releaseFirstLoginGuide(openKey: string) {
  try {
    const raw = localStorage.getItem(openKey)
    const current = raw ? JSON.parse(raw) : null
    if (current?.tabId === FIRST_LOGIN_TOUR_TAB_ID) localStorage.removeItem(openKey)
  } catch {}
}

function ownsFirstLoginGuide(openKey: string) {
  try {
    const raw = localStorage.getItem(openKey)
    const current = raw ? JSON.parse(raw) : null
    return current?.tabId === FIRST_LOGIN_TOUR_TAB_ID && Number(current.expiresAt) > Date.now()
  } catch {
    return true
  }
}

function isUserHomePath(pathname: string, userId: string) {
  return pathname === `/u/${userId}` || pathname === `/u/${userId}/`
}

export function TourController() {
  const location = useLocation()
  const { user } = useStore()
  const [showFirstLoginGuide, setShowFirstLoginGuide] = useState(false)
  const [firstLoginStorageKey, setFirstLoginStorageKey] = useState('')
  const [firstLoginOpenKey, setFirstLoginOpenKey] = useState('')

  useEffect(() => {
    let disposed = false
    let timer: number | null = null

    const scheduleRun = (force = false) => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (disposed) return
        void runFirstIssueTourForPath(location.pathname, { force })
      }, 120)
    }

    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<{ force?: boolean }>).detail
      scheduleRun(detail?.force ?? true)
    }

    scheduleRun(false)
    window.addEventListener(FIRST_ISSUE_TOUR_EVENT, onStart)
    window.addEventListener(GUIDED_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(PROJECT_IMPORT_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(CONTEXT_SETUP_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(SELF_EVOLVE_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(EXTENSION_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(LOGO_REVIEW_DEMO_TOUR_EVENT, onStart)

    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener(FIRST_ISSUE_TOUR_EVENT, onStart)
      window.removeEventListener(GUIDED_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(PROJECT_IMPORT_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(CONTEXT_SETUP_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(SELF_EVOLVE_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(EXTENSION_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(LOGO_REVIEW_DEMO_TOUR_EVENT, onStart)
    }
  }, [location.pathname, location.search])

  useEffect(() => {
    const userId = user?.id || ''
    if (!userId) return
    if (!isUserHomePath(location.pathname, userId)) return
    if (readActiveGuidedDemo()?.state.active) return

    const storageKey = firstLoginTourKey(userId)
    const openKey = firstLoginTourOpenKey(userId)
    try {
      if (localStorage.getItem(storageKey)) return
    } catch {
      // If localStorage is unavailable, still try to run once in this mounted app.
    }

    let disposed = false
    let showTimer: number | null = null
    const timer = window.setTimeout(() => {
      if (disposed) return
      if (!claimFirstLoginGuide(openKey)) return
      showTimer = window.setTimeout(() => {
        if (disposed) return
        if (!ownsFirstLoginGuide(openKey)) return
        setFirstLoginStorageKey(storageKey)
        setFirstLoginOpenKey(openKey)
        setShowFirstLoginGuide(true)
      }, 80)
    }, 520)

    return () => {
      disposed = true
      window.clearTimeout(timer)
      if (showTimer !== null) window.clearTimeout(showTimer)
      releaseFirstLoginGuide(openKey)
    }
  }, [location.pathname, user?.id])

  const closeFirstLoginGuide = (opts?: { rememberNoAuto?: boolean; started?: boolean }) => {
    setShowFirstLoginGuide(false)
    if (firstLoginOpenKey) {
      releaseFirstLoginGuide(firstLoginOpenKey)
      setFirstLoginOpenKey('')
    }
    if (!firstLoginStorageKey) return
    try {
      if (opts?.started || opts?.rememberNoAuto) localStorage.setItem(firstLoginStorageKey, String(Date.now()))
      else localStorage.removeItem(firstLoginStorageKey)
    } catch {}
  }

  return showFirstLoginGuide
    ? <GuideHelpModal firstLogin onClose={closeFirstLoginGuide} />
    : null
}
