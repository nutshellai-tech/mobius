import { useEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, SRGBColorSpace } from 'three/src/constants.js'
import { AmbientLight } from 'three/src/lights/AmbientLight.js'
import { DirectionalLight } from 'three/src/lights/DirectionalLight.js'
import { HemisphereLight } from 'three/src/lights/HemisphereLight.js'
import { BufferGeometry } from 'three/src/core/BufferGeometry.js'
import { Float32BufferAttribute } from 'three/src/core/BufferAttribute.js'
import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js'
import { CircleGeometry } from 'three/src/geometries/CircleGeometry.js'
import { PlaneGeometry } from 'three/src/geometries/PlaneGeometry.js'
import { TorusGeometry } from 'three/src/geometries/TorusGeometry.js'
import { LineBasicMaterial } from 'three/src/materials/LineBasicMaterial.js'
import { MeshBasicMaterial } from 'three/src/materials/MeshBasicMaterial.js'
import { MeshStandardMaterial } from 'three/src/materials/MeshStandardMaterial.js'
import { SpriteMaterial } from 'three/src/materials/SpriteMaterial.js'
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js'
import { Raycaster } from 'three/src/core/Raycaster.js'
import type { Object3D } from 'three/src/core/Object3D.js'
import { clamp } from 'three/src/math/MathUtils.js'
import { Color } from 'three/src/math/Color.js'
import { Vector2 } from 'three/src/math/Vector2.js'
import { Vector3 } from 'three/src/math/Vector3.js'
import { Group } from 'three/src/objects/Group.js'
import { Line } from 'three/src/objects/Line.js'
import { Mesh } from 'three/src/objects/Mesh.js'
import { Sprite } from 'three/src/objects/Sprite.js'
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js'
import { Scene } from 'three/src/scenes/Scene.js'
import { FogExp2 } from 'three/src/scenes/FogExp2.js'
import { CanvasTexture } from 'three/src/textures/CanvasTexture.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ThemeName } from '../theme'

export type ResearchTeamSceneAgent = {
  id: string
  name: string
  purpose?: string
  role: 'chief_researcher' | 'research_assistant'
  modelLabel?: string
  mainSkillName?: string
  locked?: boolean
  status?: string
}

type SceneProps = {
  agents: ResearchTeamSceneAgent[]
  selectedId: string | null
  onSelect: (id: string) => void
  theme: ThemeName
}

type SceneTarget = {
  center: Vector3
  cameraDistance: number
  stageRadius: number
}

type Palette = {
  background: number
  fog: number
  sky: number
  ground: number
  groundFar: number
  stage: number
  platform: number
  runway: number
  runwaySoft: number
  building: number
  buildingTop: number
  labelBg: string
  labelBgSelected: string
  labelText: string
  labelMuted: string
  labelSkill: string
}

const CHIEF_COLOR = 0x10b981
const ASSISTANT_COLOR = 0x3b82f6
const LOCKED_COLOR = 0x94a3b8

function paletteForTheme(theme: SceneProps['theme']): Palette {
  if (theme === 'light') {
    return {
      background: 0xeaf4ff,
      fog: 0xdbeafe,
      sky: 0xf8fbff,
      ground: 0xd7e4ef,
      groundFar: 0xb9c8d6,
      stage: 0xe8f1f8,
      platform: 0x7dd3fc,
      runway: 0x0ea5e9,
      runwaySoft: 0x93c5fd,
      building: 0x9fb2c3,
      buildingTop: 0xe5f0fb,
      labelBg: 'rgba(248,250,252,0.93)',
      labelBgSelected: 'rgba(239,246,255,0.98)',
      labelText: '#0f172a',
      labelMuted: '#475569',
      labelSkill: '#1d4ed8',
    }
  }
  if (theme === 'purple') {
    return {
      background: 0x160f2a,
      fog: 0x251442,
      sky: 0x2e1b55,
      ground: 0x1e1731,
      groundFar: 0x3c2b61,
      stage: 0x211b36,
      platform: 0xa78bfa,
      runway: 0x7dd3fc,
      runwaySoft: 0xc084fc,
      building: 0x352855,
      buildingTop: 0x8b5cf6,
      labelBg: 'rgba(25,18,45,0.91)',
      labelBgSelected: 'rgba(35,24,68,0.96)',
      labelText: '#f8fafc',
      labelMuted: '#c4b5fd',
      labelSkill: '#93c5fd',
    }
  }
  return {
    background: 0x08111d,
    fog: 0x0f172a,
    sky: 0x102235,
    ground: 0x111827,
    groundFar: 0x233249,
    stage: 0x101827,
    platform: 0x38bdf8,
    runway: 0x22d3ee,
    runwaySoft: 0x3b82f6,
    building: 0x182338,
    buildingTop: 0x334155,
    labelBg: 'rgba(8,13,23,0.9)',
    labelBgSelected: 'rgba(15,23,42,0.95)',
    labelText: '#f8fafc',
    labelMuted: '#94a3b8',
    labelSkill: '#93c5fd',
  }
}

function truncateText(text: string, max: number) {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function roleLabel(role: ResearchTeamSceneAgent['role']) {
  return role === 'chief_researcher' ? 'chief' : 'assistant'
}

function layoutAgents(count: number) {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return new Vector3(0, 0, 2.15)
    const rank = Math.ceil(index / 2)
    const side = index % 2 === 1 ? -1 : 1
    return new Vector3(side * rank * 2.25, 0, 2.15 - rank * 1.72)
  })
}

function boundsForPositions(positions: Vector3[]) {
  if (positions.length === 0) {
    return {
      minX: -2,
      maxX: 2,
      minZ: -2,
      maxZ: 2,
    }
  }
  return positions.reduce((acc, p) => ({
    minX: Math.min(acc.minX, p.x),
    maxX: Math.max(acc.maxX, p.x),
    minZ: Math.min(acc.minZ, p.z),
    maxZ: Math.max(acc.maxZ, p.z),
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  })
}

function computeTarget(positions: Vector3[], aspect: number): SceneTarget {
  const bounds = boundsForPositions(positions)
  const width = Math.max(6.4, bounds.maxX - bounds.minX + 4.6)
  const depth = Math.max(6.6, bounds.maxZ - bounds.minZ + 5.2)
  const center = new Vector3(
    (bounds.minX + bounds.maxX) / 2,
    0.55,
    (bounds.minZ + bounds.maxZ) / 2 - 0.28,
  )
  const stageRadius = Math.max(width, depth) * 0.62
  const cameraDistance = clamp(Math.max(depth * 1.35, width / Math.max(aspect, 0.55) * 1.2), 8.6, 18)
  return { center, cameraDistance, stageRadius }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function makeLabelTexture(agent: ResearchTeamSceneAgent, selected: boolean, theme: SceneProps['theme']) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 188
  const ctx = canvas.getContext('2d')!
  const palette = paletteForTheme(theme)
  const isChief = agent.role === 'chief_researcher'
  const accent = selected ? '#38bdf8' : isChief ? '#10b981' : '#3b82f6'

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.shadowColor = theme === 'light' ? 'rgba(15,23,42,0.16)' : 'rgba(0,0,0,0.42)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 8
  roundRect(ctx, 18, 16, 476, 152, 18)
  ctx.fillStyle = selected ? palette.labelBgSelected : palette.labelBg
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = selected ? 4 : 2
  ctx.strokeStyle = accent
  ctx.stroke()

  ctx.fillStyle = accent
  roundRect(ctx, 36, 34, 54, 28, 14)
  ctx.fill()
  ctx.font = '700 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText(isChief ? 'C' : 'A', 63, 54)
  ctx.textAlign = 'left'

  ctx.font = '700 31px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = palette.labelText
  ctx.fillText(truncateText(agent.name || '未命名 Agent', 18), 104, 58)

  ctx.font = '500 21px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = palette.labelMuted
  ctx.fillText(`${roleLabel(agent.role)} · ${truncateText(agent.modelLabel || '默认模型', 18)}`, 38, 98)

  ctx.font = '500 20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = palette.labelSkill
  ctx.fillText(truncateText(agent.mainSkillName || '完全自定义', 28), 38, 130)

  const status = agent.locked ? '已创建 · 锁定' : agent.status || ''
  if (status) {
    ctx.font = '700 18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.fillStyle = status.includes('失败') ? '#ef4444' : selected ? '#38bdf8' : '#10b981'
    ctx.fillText(truncateText(status, 18), 38, 156)
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function disposeObject(object: Object3D) {
  object.traverse((child: any) => {
    if (child.geometry) child.geometry.dispose()
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m: any) => {
        if (m.map) m.map.dispose()
        m.dispose()
      })
      else {
        if (child.material.map) child.material.map.dispose()
        child.material.dispose()
      }
    }
  })
}

function setAgentId(object: Object3D, agentId: string) {
  object.userData.agentId = agentId
  object.traverse((child) => {
    child.userData.agentId = agentId
  })
}

function makeLine(points: Vector3[], color: number, opacity: number) {
  const geometry = new BufferGeometry().setFromPoints(points)
  const material = new LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  })
  return new Line(geometry, material)
}

function makeCityline(target: SceneTarget, palette: Palette, theme: SceneProps['theme']) {
  const root = new Group()
  const blockMaterial = new MeshStandardMaterial({
    color: palette.building,
    roughness: 0.8,
    metalness: 0.08,
    emissive: new Color(palette.buildingTop).multiplyScalar(theme === 'light' ? 0.015 : 0.045),
  })
  const capMaterial = new MeshBasicMaterial({
    color: palette.buildingTop,
    transparent: true,
    opacity: theme === 'light' ? 0.18 : 0.28,
    depthWrite: false,
  })

  const count = 72
  const spread = Math.max(target.stageRadius * 4.8, 28)
  const backZ = target.center.z - target.stageRadius * 2.35
  for (let i = 0; i < count; i += 1) {
    const n = i + 1
    const lane = i % 3
    const x = (((n * 47) % 113) / 112 - 0.5) * spread
    const z = backZ - lane * 2.15 - (((n * 31) % 97) / 96) * 2.2
    const h = 0.6 + (((n * 43) % 100) / 99) * 3.2
    const w = 0.28 + (((n * 19) % 100) / 99) * 0.85
    const d = 0.28 + (((n * 23) % 100) / 99) * 0.65
    const block = new Mesh(new BoxGeometry(w, h, d), blockMaterial.clone())
    block.position.set(target.center.x + x, h / 2 - 0.08, z)
    root.add(block)

    if (i % 4 === 0) {
      const cap = new Mesh(new BoxGeometry(w * 0.72, 0.035, d * 0.72), capMaterial.clone())
      cap.position.set(block.position.x, h + 0.02, block.position.z)
      root.add(cap)
    }
  }
  return root
}

function makeStage(target: SceneTarget, palette: Palette, theme: SceneProps['theme']) {
  const root = new Group()
  const radius = target.stageRadius

  const ground = new Mesh(new PlaneGeometry(radius * 7, radius * 6), new MeshStandardMaterial({
    color: palette.ground,
    roughness: 0.78,
    metalness: 0.02,
  }))
  ground.rotation.x = -Math.PI / 2
  ground.position.set(target.center.x, -0.08, target.center.z - radius * 0.7)
  root.add(ground)

  const farGround = new Mesh(new PlaneGeometry(radius * 7, radius * 2.8), new MeshBasicMaterial({
    color: palette.groundFar,
    transparent: true,
    opacity: theme === 'light' ? 0.26 : 0.18,
    depthWrite: false,
  }))
  farGround.rotation.x = -Math.PI / 2
  farGround.position.set(target.center.x, -0.055, target.center.z - radius * 2.25)
  root.add(farGround)

  const platform = new Mesh(new CircleGeometry(radius, 96), new MeshStandardMaterial({
    color: palette.stage,
    roughness: 0.52,
    metalness: 0.18,
    emissive: new Color(palette.platform).multiplyScalar(theme === 'light' ? 0.025 : 0.06),
  }))
  platform.rotation.x = -Math.PI / 2
  platform.scale.z = 0.55
  platform.position.set(target.center.x, 0.012, target.center.z + radius * 0.1)
  root.add(platform)

  const ring = new Mesh(new TorusGeometry(radius * 0.98, 0.018, 8, 128), new MeshBasicMaterial({
    color: palette.platform,
    transparent: true,
    opacity: theme === 'light' ? 0.35 : 0.48,
    depthWrite: false,
    blending: AdditiveBlending,
  }))
  ring.rotation.x = Math.PI / 2
  ring.scale.z = 0.55
  ring.position.copy(platform.position)
  ring.position.y = 0.045
  root.add(ring)

  for (let i = -3; i <= 3; i += 1) {
    const alpha = i === 0 ? 0.34 : 0.15
    root.add(makeLine([
      new Vector3(target.center.x + i * radius * 0.28, 0.05, target.center.z + radius * 0.7),
      new Vector3(target.center.x + i * radius * 0.46, 0.05, target.center.z - radius * 1.1),
    ], palette.runwaySoft, theme === 'light' ? alpha * 0.72 : alpha))
  }

  const fogBandMaterial = new MeshBasicMaterial({
    color: palette.fog,
    transparent: true,
    opacity: theme === 'light' ? 0.22 : 0.28,
    depthWrite: false,
  })
  for (let i = 0; i < 3; i += 1) {
    const band = new Mesh(new PlaneGeometry(radius * 5.2, radius * 0.48), fogBandMaterial.clone())
    band.position.set(target.center.x, 0.32 + i * 0.16, target.center.z - radius * (1.35 + i * 0.48))
    band.rotation.x = -Math.PI * 0.36
    root.add(band)
  }

  root.add(makeCityline(target, palette, theme))
  return root
}

function makeFormationLines(positions: Vector3[], palette: Palette, theme: SceneProps['theme']) {
  const root = new Group()
  if (positions.length < 2) return root
  const chief = positions[0]
  const opacity = theme === 'light' ? 0.36 : 0.52
  const leftWing = positions.filter((_, index) => index > 0 && index % 2 === 1)
  const rightWing = positions.filter((_, index) => index > 0 && index % 2 === 0)
  if (leftWing.length > 0) {
    root.add(makeLine([chief, ...leftWing].map(p => new Vector3(p.x, 0.08, p.z)), palette.runway, opacity))
  }
  if (rightWing.length > 0) {
    root.add(makeLine([chief, ...rightWing].map(p => new Vector3(p.x, 0.08, p.z)), palette.runway, opacity))
  }
  return root
}

function makeAgentAvatar(agent: ResearchTeamSceneAgent, color: number, selected: boolean, theme: SceneProps['theme']) {
  const bodyColor = agent.locked ? LOCKED_COLOR : color
  const glow = new Color(bodyColor)
  const bodyMat = new MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.38,
    metalness: 0.36,
    emissive: glow.clone().multiplyScalar(selected ? 0.15 : 0.045),
  })
  const topMat = new MeshStandardMaterial({
    color: theme === 'light' ? 0xf1f5f9 : 0x1f2a3f,
    roughness: 0.5,
    metalness: 0.22,
    emissive: glow.clone().multiplyScalar(selected ? 0.05 : 0.018),
  })
  const panelMat = new MeshBasicMaterial({
    color: selected ? 0xdbeafe : bodyColor,
    transparent: true,
    opacity: selected ? 0.84 : 0.62,
  })
  const glowMat = new MeshBasicMaterial({
    color: selected ? 0x38bdf8 : bodyColor,
    transparent: true,
    opacity: selected ? 0.4 : 0.16,
    depthWrite: false,
    blending: AdditiveBlending,
  })

  const group = new Group()
  const pad = new Mesh(new CircleGeometry(0.74, 56), glowMat)
  pad.rotation.x = -Math.PI / 2
  pad.scale.z = 0.48
  pad.position.y = 0.012

  const ring = new Mesh(new TorusGeometry(selected ? 0.72 : 0.58, selected ? 0.025 : 0.014, 8, 96), glowMat.clone())
  ring.rotation.x = Math.PI / 2
  ring.scale.z = 0.6
  ring.position.y = 0.055

  const base = new Mesh(new BoxGeometry(0.82, 0.2, 0.72), bodyMat)
  base.position.y = 0.15
  const body = new Mesh(new BoxGeometry(0.64, 0.9, 0.56), bodyMat)
  body.position.y = 0.7
  const top = new Mesh(new BoxGeometry(0.44, 0.34, 0.44), topMat)
  top.position.y = 1.32
  const frontPanel = new Mesh(new BoxGeometry(0.44, 0.12, 0.045), panelMat)
  frontPanel.position.set(0, 0.78, 0.305)
  const topPanel = new Mesh(new BoxGeometry(0.28, 0.075, 0.04), panelMat.clone())
  topPanel.position.set(0, 1.35, 0.245)
  const selectedFrame = selected
    ? new Mesh(new BoxGeometry(0.92, 1.34, 0.035), glowMat.clone())
    : null
  if (selectedFrame) selectedFrame.position.set(0, 0.78, -0.31)

  group.add(pad, ring, base, body, top, frontPanel, topPanel)
  if (selectedFrame) group.add(selectedFrame)
  setAgentId(group, agent.id)
  return {
    group,
    clickable: [base, body, top, frontPanel, topPanel],
  }
}

export function ResearchAgentTeamScene({ agents, selectedId, onSelect, theme }: SceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const cameraRef = useRef<PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const stageRootRef = useRef<Group | null>(null)
  const pieceRootRef = useRef<Group | null>(null)
  const raycasterRef = useRef(new Raycaster())
  const pointerRef = useRef(new Vector2())
  const clickableRef = useRef<Object3D[]>([])
  const frameRef = useRef<number | null>(null)
  const onSelectRef = useRef(onSelect)
  const lastLayoutKeyRef = useRef('')

  const positions = useMemo(() => layoutAgents(agents.length), [agents.length])

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const palette = paletteForTheme(theme)
    const scene = new Scene()
    scene.background = new Color(palette.background)
    scene.fog = new FogExp2(palette.fog, theme === 'light' ? 0.018 : 0.028)

    const camera = new PerspectiveCamera(39, 1, 0.1, 120)
    camera.position.set(0, 5.4, 10)
    camera.lookAt(0, 0.55, 0)

    const renderer = new WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = SRGBColorSpace
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.55, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.autoRotate = false
    controls.enablePan = false
    controls.minDistance = 6.5
    controls.maxDistance = 26
    controls.maxPolarAngle = Math.PI / 2.08
    controls.update()

    scene.add(new HemisphereLight(palette.sky, palette.groundFar, theme === 'light' ? 0.86 : 0.74))
    scene.add(new AmbientLight(0xffffff, theme === 'light' ? 0.34 : 0.18))
    const key = new DirectionalLight(0xffffff, theme === 'light' ? 1.12 : 1.35)
    key.position.set(4.8, 9, 6.5)
    scene.add(key)

    const stageRoot = new Group()
    const pieceRoot = new Group()
    scene.add(stageRoot, pieceRoot)

    sceneRef.current = scene
    cameraRef.current = camera
    rendererRef.current = renderer
    controlsRef.current = controls
    stageRootRef.current = stageRoot
    pieceRootRef.current = pieceRoot

    const resize = () => {
      const rect = host.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      frameRef.current = requestAnimationFrame(animate)
    }
    frameRef.current = requestAnimationFrame(animate)

    let pointerDown: { x: number, y: number } | null = null
    const handlePointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY }
    }
    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerDown) return
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
      pointerDown = null
      if (moved > 5) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycasterRef.current.setFromCamera(pointerRef.current, camera)
      const hits = raycasterRef.current.intersectObjects(clickableRef.current, true)
      const hit = hits.find(item => item.object.userData.agentId)
      const id = hit?.object?.userData?.agentId
      if (id) onSelectRef.current(String(id))
    }
    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('pointerup', handlePointerUp)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.cursor = 'pointer'

    return () => {
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('pointerup', handlePointerUp)
      ro.disconnect()
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      controls.dispose()
      disposeObject(stageRoot)
      disposeObject(pieceRoot)
      scene.clear()
      renderer.dispose()
      renderer.domElement.remove()
      rendererRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      stageRootRef.current = null
      pieceRootRef.current = null
      clickableRef.current = []
    }
  }, [theme])

  useEffect(() => {
    const scene = sceneRef.current
    const stageRoot = stageRootRef.current
    const pieceRoot = pieceRootRef.current
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!scene || !stageRoot || !pieceRoot || !camera || !controls) return

    const palette = paletteForTheme(theme)
    scene.background = new Color(palette.background)
    scene.fog = new FogExp2(palette.fog, theme === 'light' ? 0.018 : 0.028)

    const target = computeTarget(positions, camera.aspect || 1.35)
    const layoutKey = `${agents.length}:${positions.map(p => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join('|')}:${target.center.x.toFixed(2)},${target.center.z.toFixed(2)},${target.cameraDistance.toFixed(2)}`
    if (layoutKey !== lastLayoutKeyRef.current) {
      lastLayoutKeyRef.current = layoutKey
      controls.target.set(target.center.x, target.center.y, target.center.z - 0.35)
      controls.minDistance = Math.max(5.8, target.cameraDistance * 0.56)
      controls.maxDistance = Math.max(14, target.cameraDistance * 1.75)
      camera.position.set(target.center.x, target.center.y + 4.8, target.center.z + target.cameraDistance)
      controls.update()
    }

    disposeObject(stageRoot)
    stageRoot.clear()
    stageRoot.add(makeStage(target, palette, theme))
    stageRoot.add(makeFormationLines(positions, palette, theme))

    disposeObject(pieceRoot)
    pieceRoot.clear()
    clickableRef.current = []

    agents.forEach((agent, index) => {
      const position = positions[index] || new Vector3()
      const selected = selectedId === agent.id
      const color = agent.role === 'chief_researcher' ? CHIEF_COLOR : ASSISTANT_COLOR
      const { group, clickable } = makeAgentAvatar(agent, agent.locked ? LOCKED_COLOR : color, selected, theme)
      const depthScale = clamp(1.02 + (position.z - target.center.z) * 0.035, 0.9, 1.14)
      group.position.copy(position)
      group.scale.setScalar((selected ? 1.06 : 1) * depthScale)

      const texture = makeLabelTexture(agent, selected, theme)
      const sprite = new Sprite(new SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }))
      sprite.renderOrder = 4
      sprite.position.set(0, 2.25, 0.08)
      sprite.scale.set(selected ? 2.85 : 2.62, selected ? 1.05 : 0.96, 1)
      group.add(sprite)

      pieceRoot.add(group)
      clickableRef.current.push(...clickable)
    })
  }, [agents, positions, selectedId, theme])

  return (
    <div className="relative h-full min-h-[360px] overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
      <div ref={hostRef} className="absolute inset-0" />
      {agents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
          暂无 Agent
        </div>
      )}
    </div>
  )
}
