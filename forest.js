/* ========================================
   Forest Module
   Trees, bushes, rocks using Thin Instances
   Spatial grid for collision detection
   ======================================== */

import { generateNormalMap } from './environment.js';

// --- Seeded PRNG for deterministic placement ---
function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// --- Spatial Grid for collision ---
const GRID_CELL = 8;
const collisionGrid = {};
const allTreePositions = [];  // { x, z, radius }
const allRockPositions = [];

function gridKey(x, z) {
    return `${Math.floor(x / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;
}

function addToGrid(x, z, radius) {
    const key = gridKey(x, z);
    if (!collisionGrid[key]) collisionGrid[key] = [];
    collisionGrid[key].push({ x, z, radius });
}

/**
 * Check collision of a circle (px, pz, pr) against nearby obstacles.
 * Returns push-out vector { x, z } or null if no collision.
 */
export function checkForestCollision(px, pz, playerRadius) {
    const gx = Math.floor(px / GRID_CELL);
    const gz = Math.floor(pz / GRID_CELL);
    let pushX = 0, pushZ = 0;
    let collided = false;

    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const key = `${gx + dx},${gz + dz}`;
            const cell = collisionGrid[key];
            if (!cell) continue;
            for (const obj of cell) {
                const ox = px - obj.x;
                const oz = pz - obj.z;
                const dist = Math.sqrt(ox * ox + oz * oz);
                const minDist = playerRadius + obj.radius;
                if (dist < minDist && dist > 0.001) {
                    const overlap = minDist - dist;
                    pushX += (ox / dist) * overlap;
                    pushZ += (oz / dist) * overlap;
                    collided = true;
                }
            }
        }
    }

    return collided ? { x: pushX, z: pushZ } : null;
}

/**
 * Creates the entire forest: trees, bushes, rocks.
 * Uses Thin Instances for performance.
 */
export function createForest(scene, terrain, shadowGenerator) {
    // Clear module-level collision state to avoid duplicates if re-generated
    for (const key in collisionGrid) delete collisionGrid[key];
    allTreePositions.length = 0;
    allRockPositions.length = 0;

    const rand = mulberry32(54321);
    const halfSize = terrain.worldSize / 2;

    // ---- Materials ----
    const trunkMat = createMaterial(scene, "trunkMat", "#5c3a1e", "#3d2510");
    const pineLeafMat = createMaterial(scene, "pineLeafMat", "#1a4a20", "#0d3012");
    const oakLeafMat = createMaterial(scene, "oakLeafMat", "#2a6a30", "#1a4a1c");
    const bushMat = createMaterial(scene, "bushMat", "#2d5a22", "#1a3a14");
    const rockMat = createMaterial(scene, "rockMat", "#5a5a58", "#3a3a38");

    // ---- Master Meshes ----

    // Trunk (shared by pine and oak) — Bullet stopper
    const masterTrunk = BABYLON.MeshBuilder.CreateCylinder("masterTrunk", {
        height: 1, diameterTop: 0.7, diameterBottom: 1, tessellation: 8
    }, scene);
    masterTrunk.material = trunkMat;
    masterTrunk.isVisible = false;
    masterTrunk.isPickable = true;
    masterTrunk.metadata = { isTreeTrunk: true };

    // Pine foliage (cone) — Bullets pass through
    const masterPineFoliage = BABYLON.MeshBuilder.CreateCylinder("masterPineFoliage", {
        height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 6
    }, scene);
    masterPineFoliage.material = pineLeafMat;
    masterPineFoliage.isVisible = false;
    masterPineFoliage.isPickable = false; // Bullets pass through leaves

    // Oak foliage (sphere) — Bullets pass through
    const masterOakFoliage = BABYLON.MeshBuilder.CreateSphere("masterOakFoliage", {
        diameter: 1, segments: 6
    }, scene);
    masterOakFoliage.material = oakLeafMat;
    masterOakFoliage.isVisible = false;
    masterOakFoliage.isPickable = false; // Bullets pass through leaves

    // Bush — Bullets pass through
    const masterBush = BABYLON.MeshBuilder.CreateSphere("masterBush", {
        diameter: 1, segments: 5
    }, scene);
    masterBush.material = bushMat;
    masterBush.isVisible = false;
    masterBush.isPickable = false; // Bullets pass through bushes

    // Rock
    const masterRock = BABYLON.MeshBuilder.CreatePolyhedron("masterRock", {
        type: 2, size: 1
    }, scene);
    masterRock.material = rockMat;
    masterRock.isVisible = false;
    masterRock.isPickable = false;

    // ---- Generate positions and thin instance matrices ----

    const trunkMatrices = [];
    const pineLeafMatrices = [];
    const oakLeafMatrices = [];
    const bushMatrices = [];
    const rockMatrices = [];

    const safeZone = 8; // No trees within this radius of spawn (0,0)

    // --- Pine Trees (200) ---
    for (let i = 0; i < 200; i++) {
        const x = (rand() - 0.5) * (terrain.worldSize - 10);
        const z = (rand() - 0.5) * (terrain.worldSize - 10);

        // Skip if too close to spawn
        if (Math.sqrt(x * x + z * z) < safeZone) continue;

        const y = terrain.getHeightAtCoordinates(x, z);
        const scale = 0.7 + rand() * 0.6;
        const trunkH = 3 * scale;
        const trunkR = 0.18 * scale;
        const rotation = rand() * Math.PI * 2;

        // Trunk
        const trunkMatrix = BABYLON.Matrix.Compose(
            new BABYLON.Vector3(trunkR * 2, trunkH, trunkR * 2),
            BABYLON.Quaternion.RotationYawPitchRoll(rotation, 0, 0),
            new BABYLON.Vector3(x, y + trunkH / 2, z)
        );
        trunkMatrices.push(trunkMatrix);

        // Pine foliage — 2 cone layers
        const foliageBaseY = y + trunkH * 0.5;
        for (let layer = 0; layer < 2; layer++) {
            const layerScale = (2 - layer) * 0.5 + 0.5;
            const layerH = (3.0 - layer * 0.8) * scale;
            const layerR = (2.2 - layer * 0.5) * scale;
            const layerY = foliageBaseY + layer * layerH * 0.55;

            const leafMatrix = BABYLON.Matrix.Compose(
                new BABYLON.Vector3(layerR, layerH, layerR),
                BABYLON.Quaternion.Identity(),
                new BABYLON.Vector3(x, layerY + layerH / 2, z)
            );
            pineLeafMatrices.push(leafMatrix);
        }

        // Collision
        const colRadius = trunkR + 0.2;
        allTreePositions.push({ x, z, radius: colRadius });
        addToGrid(x, z, colRadius);
    }

    // --- Oak Trees (100) ---
    for (let i = 0; i < 100; i++) {
        const x = (rand() - 0.5) * (terrain.worldSize - 10);
        const z = (rand() - 0.5) * (terrain.worldSize - 10);

        if (Math.sqrt(x * x + z * z) < safeZone) continue;

        const y = terrain.getHeightAtCoordinates(x, z);
        const scale = 0.7 + rand() * 0.5;
        const trunkH = 2.5 * scale;
        const trunkR = 0.22 * scale;
        const rotation = rand() * Math.PI * 2;

        // Trunk
        const trunkMatrix = BABYLON.Matrix.Compose(
            new BABYLON.Vector3(trunkR * 2.5, trunkH, trunkR * 2.5),
            BABYLON.Quaternion.RotationYawPitchRoll(rotation, 0, 0),
            new BABYLON.Vector3(x, y + trunkH / 2, z)
        );
        trunkMatrices.push(trunkMatrix);

        // Oak foliage — sphere
        const foliageR = 2.5 * scale;
        const foliageY = y + trunkH + foliageR * 0.25;
        const leafMatrix = BABYLON.Matrix.Compose(
            new BABYLON.Vector3(foliageR, foliageR * 0.8, foliageR),
            BABYLON.Quaternion.Identity(),
            new BABYLON.Vector3(x, foliageY, z)
        );
        oakLeafMatrices.push(leafMatrix);

        // Collision
        const colRadius = trunkR * 1.2 + 0.2;
        allTreePositions.push({ x, z, radius: colRadius });
        addToGrid(x, z, colRadius);
    }

    // --- Bushes (200) ---
    for (let i = 0; i < 200; i++) {
        const x = (rand() - 0.5) * (terrain.worldSize - 6);
        const z = (rand() - 0.5) * (terrain.worldSize - 6);
        const y = terrain.getHeightAtCoordinates(x, z);
        const scale = 0.3 + rand() * 0.5;

        const matrix = BABYLON.Matrix.Compose(
            new BABYLON.Vector3(scale * 2, scale, scale * 2),
            BABYLON.Quaternion.RotationYawPitchRoll(rand() * Math.PI * 2, 0, 0),
            new BABYLON.Vector3(x, y + scale * 0.3, z)
        );
        bushMatrices.push(matrix);
    }

    // --- Rocks (120) ---
    for (let i = 0; i < 120; i++) {
        const x = (rand() - 0.5) * (terrain.worldSize - 6);
        const z = (rand() - 0.5) * (terrain.worldSize - 6);
        const y = terrain.getHeightAtCoordinates(x, z);
        const scale = 0.15 + rand() * 0.5;
        const rotation = rand() * Math.PI * 2;

        const matrix = BABYLON.Matrix.Compose(
            new BABYLON.Vector3(scale, scale * 0.7, scale),
            BABYLON.Quaternion.RotationYawPitchRoll(rotation, rand() * 0.3, rand() * 0.3),
            new BABYLON.Vector3(x, y + scale * 0.2, z)
        );
        rockMatrices.push(matrix);

        // Rock collision (only larger rocks)
        if (scale > 0.3) {
            const colR = scale * 0.6;
            allRockPositions.push({ x, z, radius: colR });
            addToGrid(x, z, colR);
        }
    }

    // ---- Apply Thin Instances (Enable ray picking ONLY on tree trunks) ----
    applyThinInstances(masterTrunk, trunkMatrices, true); // Tree trunks STOP bullets!
    applyThinInstances(masterPineFoliage, pineLeafMatrices, false); // Foliage allows bullets to pass through
    applyThinInstances(masterOakFoliage, oakLeafMatrices, false);
    applyThinInstances(masterBush, bushMatrices, false);
    applyThinInstances(masterRock, rockMatrices, false);

    // Register shadow casters (master meshes with thin instances)
    if (shadowGenerator) {
        shadowGenerator.addShadowCaster(masterTrunk);
        shadowGenerator.addShadowCaster(masterPineFoliage);
        shadowGenerator.addShadowCaster(masterOakFoliage);
    }

    return {
        checkCollision: checkForestCollision,
        treePositions: allTreePositions,
        rockPositions: allRockPositions
    };
}

// --- Helper: apply thin instances from matrix array ---
function applyThinInstances(mesh, matrices, enablePicking = false) {
    if (matrices.length === 0) return;

    const float32 = new Float32Array(matrices.length * 16);
    for (let i = 0; i < matrices.length; i++) {
        matrices[i].copyToArray(float32, i * 16);
    }
    mesh.thinInstanceSetBuffer("matrix", float32, 16);
    mesh.thinInstanceEnablePicking = enablePicking;
    mesh.thinInstanceRefreshBoundingInfo(true);
    mesh.isPickable = enablePicking;
    mesh.isVisible = true;
}

// --- Helper: create PBR material with normal maps ---
function createMaterial(scene, name, diffuseHex, emissiveHex) {
    const mat = new BABYLON.PBRMaterial(name, scene);
    mat.albedoColor = BABYLON.Color3.FromHexString(diffuseHex);

    if (emissiveHex) {
        mat.emissiveColor = BABYLON.Color3.FromHexString(emissiveHex).scale(0.1);
    }

    // Configure PBR textures and metallic/roughness based on target object
    if (name.toLowerCase().includes("trunk")) {
        mat.bumpTexture = generateNormalMap(scene, 128, 128, "bark");
        mat.bumpTexture.uScale = 2.0;
        mat.bumpTexture.vScale = 5.0;
        mat.metallic = 0.0;
        mat.roughness = 0.88;
    } else if (name.toLowerCase().includes("rock")) {
        mat.bumpTexture = generateNormalMap(scene, 128, 128, "rock");
        mat.bumpTexture.uScale = 3.0;
        mat.bumpTexture.vScale = 3.0;
        mat.metallic = 0.15;
        mat.roughness = 0.78;
    } else if (name.toLowerCase().includes("leaf") || name.toLowerCase().includes("bush")) {
        mat.bumpTexture = generateNormalMap(scene, 128, 128, "fabric"); // Fine organic leaf weave
        mat.bumpTexture.uScale = 8.0;
        mat.bumpTexture.vScale = 8.0;
        mat.metallic = 0.05;
        mat.roughness = 0.65; // gives a natural glossy look under the sun
    } else {
        mat.metallic = 0.05;
        mat.roughness = 0.9;
    }

    return mat;
}
