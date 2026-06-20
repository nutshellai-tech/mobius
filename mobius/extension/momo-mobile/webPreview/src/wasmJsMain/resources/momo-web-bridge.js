(() => {
  const fileResults = new Map()
  const permissionResults = new Map()
  const recordings = new Map()
  let sequence = 0

  const nextId = (prefix) => `${prefix}-${Date.now()}-${++sequence}`

  const arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
    }
    return btoa(binary)
  }

  const take = (map, id) => {
    if (!map.has(id)) return null
    const value = map.get(id)
    map.delete(id)
    return value
  }

  const supportedRecorderMimeType = () => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ]
    return candidates.find((type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) || ''
  }

  const recorderExtension = (mimeType) => {
    if (mimeType.includes('mp4')) return 'm4a'
    if (mimeType.includes('ogg')) return 'ogg'
    return 'webm'
  }

  globalThis.MomoWebBridge = {
    storageGet(key) {
      return globalThis.localStorage?.getItem(key) ?? null
    },

    storageSet(key, value) {
      globalThis.localStorage?.setItem(key, value)
    },

    storageRemove(key) {
      globalThis.localStorage?.removeItem(key)
    },

    baseUrl() {
      return globalThis.location?.origin || ''
    },

    nowShortTime() {
      return new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    },

    formatBackendTime(raw) {
      if (!raw) return ''
      const time = Date.parse(raw)
      if (!Number.isFinite(time)) return ''
      const diff = Date.now() - time
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分钟前`
      if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}小时前`
      const date = new Date(time)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    },

    openFilePicker(maxFiles) {
      const requestId = nextId('files')
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = maxFiles > 1
      input.style.display = 'none'
      input.addEventListener('change', async () => {
        try {
          const selected = Array.from(input.files || []).slice(0, Math.max(1, maxFiles))
          const files = await Promise.all(selected.map(async (file) => ({
            name: file.name || 'attachment',
            mimeType: file.type || 'application/octet-stream',
            base64: arrayBufferToBase64(await file.arrayBuffer()),
          })))
          fileResults.set(requestId, JSON.stringify({ files, error: '' }))
        } catch (error) {
          fileResults.set(requestId, JSON.stringify({ files: [], error: error?.message || '读取附件失败' }))
        } finally {
          input.remove()
        }
      }, { once: true })
      input.addEventListener('cancel', () => {
        fileResults.set(requestId, JSON.stringify({ files: [], error: '' }))
        input.remove()
      }, { once: true })
      document.body.appendChild(input)
      input.click()
      return requestId
    },

    takeFileResult(requestId) {
      return take(fileResults, requestId)
    },

    hasMicrophonePermission() {
      return Boolean(navigator.mediaDevices?.getUserMedia)
    },

    requestMicrophonePermission() {
      const requestId = nextId('permission')
      if (!navigator.mediaDevices?.getUserMedia) {
        permissionResults.set(requestId, 'denied')
        return requestId
      }
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop())
          permissionResults.set(requestId, 'granted')
        })
        .catch(() => permissionResults.set(requestId, 'denied'))
      return requestId
    },

    takePermissionResult(requestId) {
      return take(permissionResults, requestId)
    },

    startRecording() {
      const recordingId = nextId('recording')
      const state = {
        events: [],
        chunks: [],
        canceled: false,
        recorder: null,
        stream: null,
        audioContext: null,
        analyserTimer: null,
      }
      recordings.set(recordingId, state)

      if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
        state.events.push(JSON.stringify({ type: 'error', message: '当前浏览器不支持录音' }))
        return recordingId
      }

      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      }).then((stream) => {
        if (state.canceled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        state.stream = stream
        const mimeType = supportedRecorderMimeType()
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream)
        state.recorder = recorder
        recorder.ondataavailable = (event) => {
          if (event.data?.size) state.chunks.push(event.data)
        }
        recorder.onerror = () => {
          state.events.push(JSON.stringify({ type: 'error', message: '浏览器录音失败' }))
        }
        recorder.onstop = async () => {
          clearInterval(state.analyserTimer)
          state.audioContext?.close?.()
          stream.getTracks().forEach((track) => track.stop())
          if (state.canceled) {
            state.events.push(JSON.stringify({ type: 'end' }))
            return
          }
          try {
            const resolvedType = recorder.mimeType || mimeType || 'audio/webm'
            const blob = new Blob(state.chunks, { type: resolvedType })
            state.events.push(JSON.stringify({
              type: 'audio',
              base64: arrayBufferToBase64(await blob.arrayBuffer()),
              mimeType: resolvedType,
              fileName: `momo-voice.${recorderExtension(resolvedType)}`,
            }))
          } catch (error) {
            state.events.push(JSON.stringify({ type: 'error', message: error?.message || '读取录音失败' }))
          }
        }

        try {
          const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext
          if (AudioContext) {
            const context = new AudioContext()
            const analyser = context.createAnalyser()
            analyser.fftSize = 256
            context.createMediaStreamSource(stream).connect(analyser)
            const values = new Uint8Array(analyser.frequencyBinCount)
            state.audioContext = context
            state.analyserTimer = setInterval(() => {
              analyser.getByteFrequencyData(values)
              const average = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
              const level = Math.max(1, Math.min(5, Math.ceil(average / 24)))
              state.events.push(JSON.stringify({ type: 'volume', level }))
            }, 160)
          }
        } catch {
          // Volume feedback is optional; recording remains functional.
        }

        recorder.start(250)
        state.events.push(JSON.stringify({ type: 'ready' }))
      }).catch((error) => {
        state.events.push(JSON.stringify({ type: 'error', message: error?.message || '麦克风权限未开启' }))
      })

      return recordingId
    },

    takeRecordingEvent(recordingId) {
      const state = recordings.get(recordingId)
      if (!state?.events.length) return null
      const event = state.events.shift()
      if (!state.events.length && /"type":"(?:audio|error|end)"/.test(event)) {
        recordings.delete(recordingId)
      }
      return event
    },

    stopRecording(recordingId) {
      const state = recordings.get(recordingId)
      if (!state) return
      if (state.recorder?.state && state.recorder.state !== 'inactive') {
        state.recorder.stop()
      }
    },

    cancelRecording(recordingId) {
      const state = recordings.get(recordingId)
      if (!state) return
      state.canceled = true
      clearInterval(state.analyserTimer)
      if (state.recorder?.state && state.recorder.state !== 'inactive') {
        state.recorder.stop()
      } else {
        state.stream?.getTracks?.().forEach((track) => track.stop())
        state.events.push(JSON.stringify({ type: 'end' }))
      }
    },

    speak(text, languageTag) {
      if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return false
      globalThis.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = languageTag || 'zh-CN'
      utterance.rate = 1
      globalThis.speechSynthesis.speak(utterance)
      return true
    },

    stopSpeaking() {
      globalThis.speechSynthesis?.cancel()
    },
  }
})()
