import {
  AmbientLight, AxesHelper, Box3, BufferAttribute, BufferGeometry, DirectionalLight, GridHelper, Group, Line, LineBasicMaterial,
  PerspectiveCamera, Points, PointsMaterial, Scene, Vector3, WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Quat, Vec3 } from 'triki-kit'

const MAX_POINTS = 60000
const TOKEN_DIAMETER_M = 0.032 // крышка-жетон около 32 мм

export type View = 'persp' | 'top' | 'front'

/** Линия с заранее выделенным буфером: точки дописываются и переписываются без пересоздания геометрии. */
class Trail {
  readonly line: Line
  private readonly buf = new Float32Array(MAX_POINTS * 3)
  private readonly attr = new BufferAttribute(this.buf, 3)
  length = 0

  constructor(material: LineBasicMaterial) {
    const geo = new BufferGeometry()
    geo.setAttribute('position', this.attr)
    geo.setDrawRange(0, 0)
    this.line = new Line(geo, material)
    this.line.frustumCulled = false
  }

  push(p: Vec3): void {
    if (this.length >= MAX_POINTS) return
    this.buf.set(p, this.length * 3)
    this.length++
  }

  /** Обрезать до n точек (затем дописать исправленный путь сегмента). */
  truncate(n: number): void {
    this.length = Math.max(0, Math.min(n, this.length))
  }

  commit(): void {
    this.attr.needsUpdate = true
    this.line.geometry.setDrawRange(0, this.length)
  }
}

/**
 * Сцена позиции: метры, мир как в ядре (X вправо, Y от пользователя, Z вверх). three: Y вверх, поэтому root повёрнут на -90° по X.
 * Сетка: 1 м с шагом 10 см и мелкая 20 см с шагом 1 см.
 */
export function mountPositionScene(el: HTMLElement, modelUrl: string) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  el.appendChild(renderer.domElement)

  const scene = new Scene()
  const camera = new PerspectiveCamera(40, 1, 0.005, 20)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  scene.add(new AmbientLight(0xffffff, 1.6))
  const sun = new DirectionalLight(0xffffff, 2.2)
  sun.position.set(1, 3, 2)
  scene.add(sun)

  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
  const coarse = new GridHelper(1, 10, css('--muted'), css('--muted'))
  const fine = new GridHelper(0.2, 20, css('--border'), css('--border'))
  for (const g of [coarse, fine]) {
    const m = g.material as { opacity: number; transparent: boolean }
    m.transparent = true
    m.opacity = g === coarse ? 0.45 : 0.35
    scene.add(g)
  }

  const root = new Group()
  root.rotation.x = -Math.PI / 2
  scene.add(root)
  const worldAxes = new AxesHelper(0.1)
  root.add(worldAxes)

  const trail = new Trail(new LineBasicMaterial({ color: css('--z') }))
  root.add(trail.line)

  const stopGeo = new BufferGeometry()
  const stopBuf = new Float32Array(4096 * 3)
  stopGeo.setAttribute('position', new BufferAttribute(stopBuf, 3))
  stopGeo.setDrawRange(0, 0)
  const stops = new Points(stopGeo, new PointsMaterial({ color: css('--lift'), size: 7, sizeAttenuation: false }))
  stops.frustumCulled = false
  let stopCount = 0
  root.add(stops)

  // жетон: позиция и ориентация; mount/spin как в основном демо (та же настройка «Повернуть модель 90°»)
  const token = new Group()
  root.add(token)
  token.add(new AxesHelper(0.03))
  const mount = new Group()
  mount.rotation.x = Math.PI / 2
  token.add(mount)
  const spin = new Group()
  spin.rotation.y = (Number(safeGet('triki.mount2') ?? 1) * Math.PI) / 2
  mount.add(spin)
  new GLTFLoader().load(modelUrl, (gltf) => {
    const size = new Box3().setFromObject(gltf.scene).getSize(new Vector3())
    gltf.scene.scale.setScalar(TOKEN_DIAMETER_M / Math.max(size.x, size.y, size.z))
    spin.add(gltf.scene)
  }, undefined, (e) => console.error('Не загрузилась модель', e))

  let follow = false
  let view: View = 'persp'

  function setView(v: View): void {
    view = v
    const t = controls.target
    const d = 0.5
    // в three: Y вверх, мировой Y (от пользователя) = -Z three
    if (v === 'top') camera.position.set(t.x, t.y + d, t.z + 0.0001)
    else if (v === 'front') camera.position.set(t.x, t.y, t.z + d)
    else camera.position.set(t.x, t.y + d * 0.6, t.z + d * 0.8)
    camera.up.set(0, 1, 0)
    camera.lookAt(t)
    controls.update()
  }

  function resize(): void {
    const w = el.clientWidth
    const h = el.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(el)
  setView('persp')

  return {
    /** позиция в метрах (мир), ориентация жетона */
    setPose(p: Vec3, q: Quat): void {
      token.position.set(p[0], p[1], p[2])
      token.quaternion.set(q[1], q[2], q[3], q[0])
      if (follow) {
        const w = new Vector3(p[0], p[2], -p[1])
        const delta = w.clone().sub(controls.target)
        controls.target.copy(w)
        camera.position.add(delta)
      }
    },
    trail,
    addStop(p: Vec3): void {
      if (stopCount >= 4096) return
      stopBuf.set(p, stopCount * 3)
      stopCount++
      stopGeo.attributes.position.needsUpdate = true
      stopGeo.setDrawRange(0, stopCount)
    },
    clear(): void {
      trail.truncate(0)
      trail.commit()
      stopCount = 0
      stopGeo.setDrawRange(0, 0)
    },
    setFollow(on: boolean): void {
      follow = on
      if (!on) {
        controls.target.set(0, 0, 0)
        setView(view)
      }
    },
    setView,
    render(): void {
      controls.update()
      renderer.render(scene, camera)
    },
  }
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}
