import {
  AmbientLight, AxesHelper, Color, DirectionalLight, GridHelper, Group, PerspectiveCamera, Scene, WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Quat } from '../core/quat'

/**
 * Three.js-сцена с моделью Triki. Мир (как в ядре): Z вверх; three: Y вверх. Поэтому root повёрнут на -90° по X.
 * Модель - плоский диск с тонкой осью Y; ось датчика Z - тоже «толщина», поэтому mount поворачивает модель на +90° по X.
 * Цветные оси привязаны к системе датчика: X красная, Y зелёная, Z синяя.
 */
export function mountModel(el: HTMLElement, url: string) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  el.appendChild(renderer.domElement)

  const scene = new Scene()
  const camera = new PerspectiveCamera(35, 1, 0.1, 50)
  // Вид спереди: камера на оси мирового -Y (в three это +Z), по X по центру, чуть выше по Z (в three это Y), смотрит вниз на жетон
  camera.position.set(0, 1.6, 4.8)
  camera.lookAt(0, 0, 0)
  scene.add(new AmbientLight(0xffffff, 1.6))
  const sun = new DirectionalLight(0xffffff, 2.2)
  sun.position.set(3, 5, 4)
  scene.add(sun)

  const grid = new GridHelper(4, 8, 0x888888, 0x888888)
  grid.position.y = -1.3
  ;(grid.material as { opacity: number; transparent: boolean }).transparent = true
  ;(grid.material as { opacity: number }).opacity = 0.3
  scene.add(grid)

  const root = new Group()
  root.rotation.x = -Math.PI / 2
  scene.add(root)
  const pivot = new Group() // система датчика, сюда ставим кватернион ориентации
  root.add(pivot)
  pivot.add(new AxesHelper(1.6))
  const mount = new Group()
  mount.rotation.x = Math.PI / 2
  pivot.add(mount)
  const spin = new Group() // поворот модели вокруг её тонкой оси: подгонка «передней» стороны
  mount.add(spin)

  new GLTFLoader().load(url, (gltf) => {
    spin.add(gltf.scene)
    draw()
  }, undefined, (e) => console.error('Не загрузилась модель', e))

  let mountSteps = Number(safeGet('triki.mount') ?? 0)
  spin.rotation.y = (mountSteps * Math.PI) / 2

  function resize(): void {
    const w = el.clientWidth
    const h = el.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    draw()
  }
  new ResizeObserver(resize).observe(el)

  function draw(): void {
    renderer.setClearColor(new Color(0), 0)
    renderer.render(scene, camera)
  }

  return {
    setQuat(q: Quat): void {
      pivot.quaternion.set(q[1], q[2], q[3], q[0])
      draw()
    },
    rotateMount(): void {
      mountSteps = (mountSteps + 1) % 4
      spin.rotation.y = (mountSteps * Math.PI) / 2
      safeSet('triki.mount', String(mountSteps))
      draw()
    },
  }
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v) } catch { /* ignore */ }
}
