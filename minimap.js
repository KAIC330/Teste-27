/* ========================================
   Minimap Module
   Top-down radar-style minimap showing
   player position and remote players.
   Smaller on mobile devices.
   ======================================== */

let WORLD_SIZE = 200;
let HALF_WORLD = WORLD_SIZE / 2;

export function createMinimap(player, remotePlayers, mapType, localTeam) {
    // Adjust world size for city
    if (mapType === "city") {
        WORLD_SIZE = 100;
        HALF_WORLD = 50;
    }
    const canvas = document.getElementById("minimap-canvas");
    if (!canvas) return { update() {} };
    const ctx = canvas.getContext("2d");

    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && window.innerWidth < 900);

    // Size: desktop = 180, mobile = 110
    const SIZE = isMobile ? 110 : 180;
    canvas.width = SIZE;
    canvas.height = SIZE;
    canvas.style.width = SIZE + "px";
    canvas.style.height = SIZE + "px";

    const CENTER = SIZE / 2;
    const SCALE = SIZE / WORLD_SIZE; // pixels per world unit

    // Pre-draw a terrain background texture (cached once)
    const bgCanvas = document.createElement("canvas");
    bgCanvas.width = SIZE;
    bgCanvas.height = SIZE;
    const bgCtx = bgCanvas.getContext("2d");
    if (mapType === "city") {
        drawCityBackground(bgCtx, SIZE, WORLD_SIZE);
    } else {
        drawTerrainBackground(bgCtx, SIZE);
    }

    // Throttle: update every 3rd frame (~20 fps at 60fps)
    let frameCount = 0;

    function update() {
        frameCount++;
        if (frameCount % 3 !== 0) return;

        // Clear and draw background
        ctx.clearRect(0, 0, SIZE, SIZE);

        // Circular clip
        ctx.save();
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, CENTER - 1, 0, Math.PI * 2);
        ctx.clip();

        // Terrain background
        ctx.drawImage(bgCanvas, 0, 0);

        // Semi-transparent overlay for contrast
        ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
        ctx.fillRect(0, 0, SIZE, SIZE);

        // ---- Draw remote players ----
        if (remotePlayers && remotePlayers.all) {
            for (const [id, entry] of remotePlayers.all) {
                if (!entry.alive) continue;
                const rx = worldToMapX(entry.mesh.position.x);
                const ry = worldToMapZ(entry.mesh.position.z);

                // Check if within circle
                const dx = rx - CENTER;
                const dy = ry - CENTER;
                if (dx * dx + dy * dy > (CENTER - 4) * (CENTER - 4)) continue;

                // Color by team: green=ally, red=enemy
                const isAlly = localTeam && entry.team === localTeam;
                ctx.beginPath();
                ctx.arc(rx, ry, isMobile ? 2.5 : 3.5, 0, Math.PI * 2);
                ctx.fillStyle = isAlly ? "#44dd44" : "#ff4444";
                ctx.fill();

                // Tiny glow
                ctx.beginPath();
                ctx.arc(rx, ry, isMobile ? 4 : 6, 0, Math.PI * 2);
                ctx.fillStyle = isAlly ? "rgba(68, 221, 68, 0.25)" : "rgba(255, 68, 68, 0.25)";
                ctx.fill();
            }
        }

        // ---- Draw local player ----
        const px = worldToMapX(player.position.x);
        const py = worldToMapZ(player.position.z);
        const yaw = player.yaw; // Sharp tip points directly in player's forward advancing heading

        // Tactical Direction Arrow (Prominent sharp tip)
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(yaw);

        const triSize = isMobile ? 5.5 : 7.5;
        ctx.beginPath();
        ctx.moveTo(0, -triSize * 2.0);             // Long sharp tip (forward advancing direction)
        ctx.lineTo(-triSize * 0.75, triSize * 0.85); // Back left wing
        ctx.lineTo(0, triSize * 0.35);               // Inner notch
        ctx.lineTo(triSize * 0.75, triSize * 0.85);  // Back right wing
        ctx.closePath();

        ctx.fillStyle = "#00ffff";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();

        // Player glow
        ctx.beginPath();
        ctx.arc(px, py, isMobile ? 6 : 8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(68, 221, 255, 0.15)";
        ctx.fill();

        ctx.restore(); // End circular clip

        // ---- Draw border ring ----
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, CENTER - 1, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(100, 200, 255, 0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // ---- Cardinal direction label ----
        ctx.font = `bold ${isMobile ? 9 : 11}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        ctx.fillText("N", CENTER, 10);
    }

    function worldToMapX(wx) {
        return (wx + HALF_WORLD) * SCALE;
    }

    function worldToMapZ(wz) {
        return (HALF_WORLD - wz) * SCALE;
    }

    return { update };
}

// ---- Generate a static terrain background ----
function drawTerrainBackground(ctx, size) {
    // Dark green base
    ctx.fillStyle = "#1a2d12";
    ctx.fillRect(0, 0, size, size);

    // Noise-like terrain patches
    const colors = [
        "#1e3316", "#243a1c", "#1a2e14", "#2a4020",
        "#162a10", "#223618", "#1c3014", "#28381e"
    ];

    for (let i = 0; i < 2000; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const s = 1 + Math.random() * 4;
        ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
        ctx.globalAlpha = 0.3 + Math.random() * 0.5;
        ctx.fillRect(x, y, s, s);
    }

    // Lighter spots (clearings)
    ctx.globalAlpha = 0.1;
    for (let i = 0; i < 15; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const r = 5 + Math.random() * 15;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, "#4a6a30");
        grd.addColorStop(1, "transparent");
        ctx.fillStyle = grd;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    ctx.globalAlpha = 1;
}

// ---- Generate a city-themed background ----
function drawCityBackground(ctx, size, worldSize) {
    // Dark asphalt base
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, size, size);

    // Asphalt noise
    for (let i = 0; i < 800; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const v = 30 + Math.random() * 20;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    ctx.globalAlpha = 1;

    // Draw building blocks (4x4 grid)
    const ROAD_WIDTH = 8;
    const GRID = 4;
    const blockW = (worldSize - ROAD_WIDTH * (GRID + 1)) / GRID;
    const blockD = blockW;
    const scale = size / worldSize;
    const half = worldSize / 2;

    ctx.fillStyle = "#555566";
    for (let col = 0; col < GRID; col++) {
        for (let row = 0; row < GRID; row++) {
            const bx = -half + ROAD_WIDTH + col * (blockW + ROAD_WIDTH);
            const bz = -half + ROAD_WIDTH + row * (blockD + ROAD_WIDTH);
            const px = (bx + half) * scale;
            const py = (bz + half) * scale;
            ctx.fillRect(px, py, blockW * scale, blockD * scale);
        }
    }

    // Yellow road lines
    ctx.fillStyle = "rgba(200, 200, 60, 0.3)";
    for (let row = 0; row <= GRID; row++) {
        const z = ROAD_WIDTH / 2 + row * (blockD + ROAD_WIDTH);
        const py = z * scale;
        ctx.fillRect(0, py - 0.3, size, 0.6);
    }
    for (let col = 0; col <= GRID; col++) {
        const x = ROAD_WIDTH / 2 + col * (blockW + ROAD_WIDTH);
        const px = x * scale;
        ctx.fillRect(px - 0.3, 0, 0.6, size);
    }
}
