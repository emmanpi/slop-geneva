import * as THREE from 'three/webgpu';
import { bryantParkLawn } from './landmarks.js';
import { groundHeight } from './terrain.js';
import { lv95ToWorld } from './geneva-frame.js';

// js/cameras.js
// Multi-camera system supporting Third-Person Chase (with mouse/touch orbit + zoom),
// Low-Angle Action Cam, POV/Cockpit Cam, 7 Geneva viewpoints, and Auto-Director Drone.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         short: 'Chase',       category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         short: 'Action',      category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   short: 'POV / Dash',  category: 'follow', fov: 68 },
  { id: 'centralPark', name: 'Promenade de la Treille', short: 'Treille', category: 'scenic', fov: 52 },
  { id: 'fifthAve', name: 'Pont de la Machine & Saint-Pierre', short: 'Saint-Pierre', category: 'scenic', fov: 48 },
  { id: 'timesSquare', name: 'Rue du Rhône', short: 'Rue du Rhône', category: 'scenic', fov: 58 },
  { id: 'chryslerGCT', name: 'Gare Cornavin & Notre-Dame', short: 'Cornavin', category: 'scenic', fov: 50 },
  { id: 'observatory', name: 'Tours de Saint-Pierre', short: 'Tours', category: 'scenic', fov: 52 },
  { id: 'bryantPark', name: 'Place des Nations', short: 'Nations', category: 'scenic', fov: 52 },
  { id: 'waterfront', name: 'Rade & Jet d’eau', short: 'Rade', category: 'scenic', fov: 46 },
  { id: 'fixed',       name: 'Test camera',              short: 'Test',        category: 'scenic', fov: 55 },
  { id: 'drone',       name: 'Auto-Director Aerial',     short: 'Director',    category: 'scenic', fov: 50 }
];

// Geneva viewpoints: [LV95 east, north, metres above the terrain] for the camera and the point it looks at
const VIEWPOINTS = {
  centralPark: [[2500160, 1117345, 1.8], [2499900, 1116700, 30]], // the Treille's long bench, over the Bastions to Plainpalais
  fifthAve: [[2500060, 1117880, 4.5], [2500411, 1117448, 45]], // Pont de la Machine, up at the cathedral's towers
  timesSquare: [[2500520, 1117740, 7], [2500080, 1117810, 6]], // down the Rue du Rhône towards Bel-Air
  chryslerGCT: [[2500060, 1118320, 14], [2499960, 1118470, 14]], // Rue du Mont-Blanc: Cornavin and Notre-Dame
  observatory: [[2500410, 1117462, 52], [2500900, 1118300, 10]], // from the north tower over the old town and the Rade
  bryantPark: [[2499740, 1119950, 2.2], [2499848, 1120281, 15]], // Place des Nations, the flags and the Palais
  waterfront: [[2501700, 1118750, 35], [2500450, 1117700, 25]] // over the Rade: the jetty, the bridges and the old town
};
const viewpoint = ([E, N, up]) => { const p = lv95ToWorld(E, N); return new THREE.Vector3(p.x, groundHeight(p.x, p.z) + up, p.z); };
const VIEWS = Object.fromEntries(Object.entries(VIEWPOINTS).map(([id, [pos, look]]) => [id, { pos: viewpoint(pos), look: viewpoint(look) }]));

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      200000 // the Alps stand 50-90 km away on the horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // The follow cameras stay on the player's side of the walls: pulled in along the line from the player's head to the
  // camera, short of the first building collider it crosses (the old town's narrow streets, the photomesh's walls)
  pullInFromWalls(entity) {
    const cm = this.controllerManager;
    if (!cm?.nearColliders) return;
    const ox = entity.position.x, oy = entity.position.y + 1.6, oz = entity.position.z;
    const dx = this.currentPos.x - ox, dy = this.currentPos.y - oy, dz = this.currentPos.z - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return;
    let tMin = 1;
    for (const c of cm.nearColliders((ox + this.currentPos.x) / 2, (oz + this.currentPos.z) / 2, len / 2 + 1)) {
      // the segment in the collider's frame (oriented boxes rotate into their axes)
      const o = c.obb;
      const cx = o ? o.cx : (c.minX + c.maxX) * 0.5, cz = o ? o.cz : (c.minZ + c.maxZ) * 0.5;
      const hx = o ? o.hx : (c.maxX - c.minX) * 0.5, hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
      const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
      const px = (ox - cx) * cs - (oz - cz) * sn, pz = (ox - cx) * sn + (oz - cz) * cs;
      const vx = dx * cs - dz * sn, vz = dx * sn + dz * cs;
      let t0 = 0, t1 = 1;
      for (const [p, v, h] of [[px, vx, hx], [pz, vz, hz]]) {
        if (Math.abs(v) < 1e-9) { if (Math.abs(p) > h) { t0 = 2; break; } continue; }
        let a = (-h - p) / v, b = (h - p) / v;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) break;
      }
      if (t0 > t1 || t0 >= tMin || t0 <= 0) continue; // missed, further, or the player stands inside it
      const y = oy + dy * t0;
      if (y > c.maxY || y < (c.minY ?? -Infinity)) continue;
      tMin = t0;
    }
    if (tMin >= 1) return;
    const t = Math.max(0.12, tMin - 0.35 / len);
    this.currentPos.set(ox + dx * t, oy + dy * t, oz + dz * t);
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : entity.type === 'car' ? 0.52 : entity.type === 'cargobike' ? 0.8 : 1.55;
        const lookAhead = entity.type === 'cargobike' ? 0.35 : 5.2;
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * lookAhead,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * lookAhead
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'cargobike') {
          fwdOffset = -0.5;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'centralPark': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.centralPark.pos).x += sway;
        desiredLook.copy(VIEWS.centralPark.look);
        break;
      }

      case 'fifthAve': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.fifthAve.pos).x += sway;
        desiredLook.copy(VIEWS.fifthAve.look);
        break;
      }

      case 'timesSquare': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.timesSquare.pos).x += sway;
        desiredLook.copy(VIEWS.timesSquare.look);
        break;
      }

      case 'chryslerGCT': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.chryslerGCT.pos).x += sway;
        desiredLook.copy(VIEWS.chryslerGCT.look);
        break;
      }

      case 'observatory': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.observatory.pos).x += sway;
        desiredLook.copy(VIEWS.observatory.look);
        break;
      }

      case 'bryantPark': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.bryantPark.pos).x += sway;
        desiredLook.copy(VIEWS.bryantPark.look);
        break;
      }

      case 'waterfront': {
        const sway = Math.sin(elapsed * 0.22) * 1.5;
        desiredPos.copy(VIEWS.waterfront.pos).x += sway;
        desiredLook.copy(VIEWS.waterfront.look);
        break;
      }

      case 'fixed': {
        // Spike test camera: window.__slopgeneva.setCamera(px, py, pz, tx, ty, tz)
        desiredPos.copy(this.fixedPos || desiredPos);
        desiredLook.copy(this.fixedLook || desiredLook);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(
          Math.cos(angle) * radius,
          alt,
          Math.sin(angle) * radius
        );
        desiredLook.set(0.0, 35.0, 0.0);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
      if (entity.type !== 'helicopter') this.pullInFromWalls(entity);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
