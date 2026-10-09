import {
  AdditiveBlending, AmbientLight, AxesHelper, CanvasTexture, Color, DirectionalLight, GridHelper, Group, Mesh,
  MeshBasicMaterial, PerspectiveCamera, PointLight, Scene, SphereGeometry, Sprite, SpriteMaterial, WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Quat } from 'triki-kit'

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

  // Светодиод: белая точка на текстуре платы -> координаты модели через UV (x, y, z). Лежит на верхней грани, у края «верха».
  const led = new Group()
  led.position.set(-0.761, 0.262, -0.061)
  led.visible = false
  const lens = new Mesh(new SphereGeometry(0.06, 16, 12), new MeshBasicMaterial({ color: 0x7dffa0 }))
  led.add(lens)
  const halo = new Sprite(new SpriteMaterial({ map: haloTexture(), color: 0x39ff6a, blending: AdditiveBlending, depthWrite: false, transparent: true }))
  halo.scale.set(0.9, 0.9, 0.9)
  led.add(halo)
  const glow = new PointLight(0x39ff6a, 6, 2.5, 1.5)
  glow.position.set(0, 0.15, 0)
  led.add(glow)
  spin.add(led)

  new GLTFLoader().load(url, (gltf) => {
    spin.add(gltf.scene)
    draw()
  }, undefined, (e) => console.error('Не загрузилась модель', e))

  // По умолчанию 1: тогда светодиод модели (по -X модели) приходится на -Y датчика, «над Ż», как на жетоне
  let mountSteps = Number(safeGet('triki.mount2') ?? 1)
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
    setLed(on: boolean): void {
      led.visible = on
      draw()
    },
    rotateMount(): void {
      mountSteps = (mountSteps + 1) % 4
      spin.rotation.y = (mountSteps * Math.PI) / 2
      safeSet('triki.mount2', String(mountSteps))
      draw()
    },
  }
}

function haloTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return new CanvasTexture(c)
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v) } catch { /* ignore */ }
}
