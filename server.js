/* ========================================
   Multiplayer LAN Server
   WebSocket server + static file serving
   Manages players, broadcasts state,
   validates hits and kills
   ======================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ---- Configuration ----
const PORT = process.env.PORT || 3000;
const TICK_RATE = 30; // Server broadcasts per second (33.3ms for ultra-low latency)
const TICK_INTERVAL = 1000 / TICK_RATE;
const MAX_HP = 100;
const RESPAWN_DELAY = 3000; // ms
const WORLD_SIZE = 200;
const INVULN_DURATION = 2000; // ms (2s protection, cancels immediately on attack)

// ---- Rate Limiting ----
const MSG_RATE_LIMIT = 60;       // max messages per second per client
const MSG_RATE_WINDOW = 1000;    // 1 second window
const MAX_MSG_SIZE = 50 * 1024;  // 50 KB max per message (excludes join images)
const MAX_JOIN_MSG_SIZE = 5 * 1024 * 1024; // 5 MB for join (includes images)

// ---- Anti-cheat: max speed per second (units) ----
const MAX_SPEED = 15; // slightly above RUN_SPEED (10) to allow latency

// ---- Weapon Damage and Range Table ----
const WEAPON_DAMAGE = {
    knife: 35,
    mw11: 20,
    m16: 25,
    by15: 5,   // per pellet, 8 pellets max (40 max dmg)
    rytec: 90,
};

const WEAPON_RANGES = {
    knife: 5.0,     // 3m base + 2m latency buffer
    mw11: 120.0,
    m16: 180.0,
    by15: 40.0,
    rytec: 350.0,
};

// ---- Anti-cheat: minimum interval between hits per weapon (ms) ----
const WEAPON_FIRE_INTERVALS = {
    knife: 500,
    mw11: 250,
    m16: 120,
    by15: 800,
    rytec: 1200,
};

// ---- MIME types for static file serving ----
const MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
};

// ---- Game State ----
const players = new Map(); // id -> { id, name, ws, x, y, z, yaw, pitch, animState, hp, kills, deaths, alive, weapon, invulnerable, faceImg, bodyImg, team, map, lastStateTime, rateCounter, rateWindowStart }
let nextPlayerId = 1;

// ---- Delta Compression: last sent state per player per recipient ----
// lastSentState[recipientId] = Map<playerId, {x, y, z, yaw, pitch, animState, hp, alive, weapon, invulnerable, kills, deaths, team}>
const lastSentState = new Map();

// Spawn points for forest map (spread around the map, away from center)
const FOREST_SPAWN_POINTS = [
    { x: -30, z: -30 },
    { x:  30, z: -30 },
    { x: -30, z:  30 },
    { x:  30, z:  30 },
    { x: -50, z:   0 },
    { x:  50, z:   0 },
    { x:   0, z: -50 },
    { x:   0, z:  50 },
    { x: -60, z: -40 },
    { x:  60, z:  40 },
];

// Spawn points for city map (within 100x100 area)
const CITY_SPAWN_TEAM_X = [
    { x: -35, z: -10 },
    { x: -35, z:  10 },
    { x: -40, z:   0 },
    { x: -25, z: -20 },
    { x: -25, z:  20 },
];
const CITY_SPAWN_TEAM_Y = [
    { x:  35, z: -10 },
    { x:  35, z:  10 },
    { x:  40, z:   0 },
    { x:  25, z: -20 },
    { x:  25, z:  20 },
];

// ---- Team helpers ----
function getTeamCounts() {
    let xCount = 0, yCount = 0;
    for (const [, p] of players) {
        if (p.team === "X") xCount++;
        else if (p.team === "Y") yCount++;
    }
    return { xCount, yCount };
}

function assignTeam() {
    const { xCount, yCount } = getTeamCounts();
    return xCount <= yCount ? "X" : "Y";
}

function autoBalanceTeams() {
    const { xCount, yCount } = getTeamCounts();
    const diff = Math.abs(xCount - yCount);
    if (diff < 2) return; // Balanced enough

    const fromTeam = xCount > yCount ? "X" : "Y";
    const toTeam = fromTeam === "X" ? "Y" : "X";

    // Find the last player who joined the larger team
    let lastJoined = null;
    let lastId = -1;
    for (const [id, p] of players) {
        if (p.team === fromTeam && id > lastId) {
            lastJoined = p;
            lastId = id;
        }
    }

    if (lastJoined) {
        lastJoined.team = toTeam;
        // Broadcast team change
        broadcast({
            type: "teamChanged",
            id: lastJoined.id,
            team: toTeam,
        });
        console.log(`[⚖] Auto-balance: "${lastJoined.name}" moved to Team ${toTeam}`);
    }
}

function getRandomSpawn(map, team) {
    if (map === "city") {
        const pool = team === "Y" ? CITY_SPAWN_TEAM_Y : CITY_SPAWN_TEAM_X;
        const sp = pool[Math.floor(Math.random() * pool.length)];
        return { x: sp.x, y: 5, z: sp.z };
    }
    // Forest default
    const sp = FOREST_SPAWN_POINTS[Math.floor(Math.random() * FOREST_SPAWN_POINTS.length)];
    return { x: sp.x, y: 20, z: sp.z }; // y=20 to fall onto terrain
}

// ---- Validation Helpers ----
function isFiniteNum(v) {
    return typeof v === "number" && Number.isFinite(v);
}

function clampToWorld(v, mapType) {
    const half = mapType === "city" ? 50 : WORLD_SIZE / 2;
    return Math.max(-half, Math.min(half, v));
}

function validateImageDataUrl(v) {
    if (typeof v !== "string") return null;
    if (v.length > 1024 * 1024) return null; // 1 MB max per image
    if (!v.startsWith("data:image/")) return null;
    return v;
}

// ---- Rate Limiting ----
function checkRateLimit(player) {
    const now = Date.now();
    if (now - player.rateWindowStart > MSG_RATE_WINDOW) {
        player.rateCounter = 0;
        player.rateWindowStart = now;
    }
    player.rateCounter++;
    return player.rateCounter <= MSG_RATE_LIMIT;
}

// ---- Static File Server ----
const STATIC_ROOT = path.join(__dirname, "..");

// Whitelist of publicly served paths (never the repo root, source, or configs)
const PUBLIC_PATHS = ["/index.html", "/css/", "/js/", "/models/"];

function serveStatic(req, res) {
    let filePath = req.url === "/" ? "/index.html" : req.url;
    // Remove query strings
    filePath = filePath.split("?")[0];

    // Security: only serve explicitly allowed paths
    const isAllowed = PUBLIC_PATHS.some(
        (p) => filePath === p || (p.endsWith("/") && filePath.startsWith(p))
    );
    if (!isAllowed) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    // Decode percent-encoded traversal attempts
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(filePath);
    } catch (e) {
        res.writeHead(400);
        res.end("Bad request");
        return;
    }

    const fullPath = path.normalize(path.join(STATIC_ROOT, decodedPath));

    // Security: prevent directory traversal
    if (!fullPath.startsWith(STATIC_ROOT + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            if (err.code === "ENOENT") {
                res.writeHead(404);
                res.end("Not found: " + filePath);
            } else {
                res.writeHead(500);
                res.end("Server error");
            }
            return;
        }
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
}

// ---- Create HTTP + WebSocket Server ----
const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_JOIN_MSG_SIZE });

// ---- Send JSON helper ----
function send(ws, data) {
    if (ws.readyState === 1) { // WebSocket.OPEN
        try {
            ws.send(JSON.stringify(data));
        } catch (e) {
            console.error("[!] Send error:", e.message);
        }
    }
}

function broadcast(data, excludeId) {
    let msg;
    try {
        msg = JSON.stringify(data);
    } catch (e) {
        console.error("[!] Broadcast JSON error:", e.message);
        return;
    }
    for (const [id, p] of players) {
        if (id !== excludeId && p.ws.readyState === 1) {
            try {
                p.ws.send(msg);
            } catch (e) {
                console.error(`[!] Broadcast send error to ${id}:`, e.message);
            }
        }
    }
}

// ---- Active Timers tracking (for cleanup on disconnect) ----
// playerTimers[playerId] = Set of timer IDs
const playerTimers = new Map();

function setPlayerTimeout(playerId, callback, delay) {
    const timerId = setTimeout(() => {
        // Remove from tracking set
        const timers = playerTimers.get(playerId);
        if (timers) timers.delete(timerId);
        // Only execute if player still exists
        if (players.has(playerId)) {
            callback();
        }
    }, delay);
    // Track the timer
    if (!playerTimers.has(playerId)) {
        playerTimers.set(playerId, new Set());
    }
    playerTimers.get(playerId).add(timerId);
    return timerId;
}

function clearPlayerTimers(playerId) {
    const timers = playerTimers.get(playerId);
    if (timers) {
        for (const timerId of timers) {
            clearTimeout(timerId);
        }
        timers.clear();
        playerTimers.delete(playerId);
    }
}

// ---- WebSocket Connection Handler ----
wss.on("connection", (ws, req) => {
    const playerId = nextPlayerId++;
    const clientIP = req.socket.remoteAddress;

    // Disable Nagle's algorithm for ultra-low latency packet dispatch
    if (req.socket && typeof req.socket.setNoDelay === "function") {
        req.socket.setNoDelay(true);
    }

    console.log(`[+] Player ${playerId} connected from ${clientIP}`);

    // Temporary state until they send "join"
    let player = null;

    ws.on("message", (raw) => {
        // ---- Message size check ----
        const rawLen = typeof raw === "string" ? raw.length : raw.byteLength;
        const maxSize = player ? MAX_MSG_SIZE : MAX_JOIN_MSG_SIZE;
        if (rawLen > maxSize) {
            console.warn(`[!] Player ${playerId}: message too large (${rawLen} bytes), dropping`);
            return;
        }

        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }

        // ---- Rate limiting (after join) ----
        if (player && !checkRateLimit(player)) {
            return; // Silently drop excess messages
        }

        try { switch (msg.type) {
            case "join": {
                // Prevent double-join
                if (player) return;

                // ---- Validate and sanitize inputs ----
                const rawName = typeof msg.name === "string" ? msg.name.trim() : "";
                const name = (rawName.replace(/[^A-Za-z0-9 _\-.]/g, "").substring(0, 16)) || "Player";
                const faceImg = validateImageDataUrl(msg.faceImg);
                const bodyImg = validateImageDataUrl(msg.bodyImg);

                const playerMap = (msg.map === "city") ? "city" : "forest";
                const team = assignTeam();
                const spawn = getRandomSpawn(playerMap, team);
                player = {
                    id: playerId,
                    name,
                    ws,
                    x: spawn.x,
                    y: spawn.y,
                    z: spawn.z,
                    yaw: 0,
                    pitch: 0,
                    animState: "IDLE",
                    hp: MAX_HP,
                    kills: 0,
                    deaths: 0,
                    alive: true,
                    weapon: "knife",
                    invulnerable: true,
                    faceImg: faceImg,
                    bodyImg: bodyImg,
                    team: team,
                    map: playerMap,
                    lastHitTime: 0,
                    // Rate limiting state
                    rateCounter: 0,
                    rateWindowStart: Date.now(),
                    // Position validation
                    lastStateTime: Date.now(),
                };
                players.set(playerId, player);

                // Initialize delta compression tracking for this player
                lastSentState.set(playerId, new Map());

                // Clear invulnerability after INVULN_DURATION
                setPlayerTimeout(playerId, () => {
                    if (players.has(playerId)) {
                        player.invulnerable = false;
                    }
                }, INVULN_DURATION);

                // Send welcome (own ID + existing players + team)
                const existingPlayers = [];
                for (const [id, p] of players) {
                    if (id !== playerId) {
                        existingPlayers.push({
                            id: p.id, name: p.name,
                            x: p.x, y: p.y, z: p.z,
                            yaw: p.yaw, pitch: p.pitch,
                            animState: p.animState,
                            hp: p.hp, kills: p.kills, deaths: p.deaths, alive: p.alive,
                            faceImg: p.faceImg, bodyImg: p.bodyImg,
                            team: p.team,
                        });
                    }
                }

                send(ws, {
                    type: "welcome",
                    id: playerId,
                    spawn,
                    team: team,
                    players: existingPlayers,
                });

                // Notify others (include avatar images + team)
                broadcast({
                    type: "playerJoined",
                    id: playerId,
                    name: player.name,
                    x: spawn.x, y: spawn.y, z: spawn.z,
                    hp: MAX_HP,
                    faceImg: player.faceImg, bodyImg: player.bodyImg,
                    team: team,
                }, playerId);

                console.log(`[*] "${player.name}" (ID:${playerId}) joined Team ${team} on ${playerMap}`);
                break;
            }

            case "state": {
                if (!player || !player.alive) return;

                // ---- Validate incoming values ----
                const newX = msg.x;
                const newY = msg.y;
                const newZ = msg.z;

                if (newX !== undefined && !isFiniteNum(newX)) return;
                if (newY !== undefined && !isFiniteNum(newY)) return;
                if (newZ !== undefined && !isFiniteNum(newZ)) return;
                if (msg.yaw !== undefined && !isFiniteNum(msg.yaw)) return;
                if (msg.pitch !== undefined && !isFiniteNum(msg.pitch)) return;

                // ---- Basic speed validation & anti-cheat rubberbanding ----
                const now = Date.now();
                const elapsed = (now - player.lastStateTime) / 1000;
                player.lastStateTime = now;

                let applyX = newX !== undefined ? clampToWorld(newX, player.map) : player.x;
                let applyY = newY !== undefined ? Math.max(-10, Math.min(200, newY)) : player.y;
                let applyZ = newZ !== undefined ? clampToWorld(newZ, player.map) : player.z;

                if (elapsed > 0 && elapsed < 2) {
                    const dx = applyX - player.x;
                    const dz = applyZ - player.z;
                    const moveDistSq = dx * dx + dz * dz;
                    const maxAllowedDist = MAX_SPEED * elapsed * 1.5 + 1.0; // allowance for lag bursts
                    if (moveDistSq > maxAllowedDist * maxAllowedDist) {
                        console.warn(`[!] Speed anomaly from ${player.name}: ${Math.sqrt(moveDistSq).toFixed(1)}m in ${elapsed.toFixed(2)}s (max allowed ${maxAllowedDist.toFixed(1)}m). Rubberbanding.`);
                        applyX = player.x;
                        applyZ = player.z;
                    }
                }

                player.x = applyX;
                player.y = applyY;
                player.z = applyZ;

                player.yaw = msg.yaw ?? player.yaw;
                player.pitch = msg.pitch ?? player.pitch;
                player.animState = msg.animState ?? player.animState;
                if (msg.weapon) player.weapon = msg.weapon;
                // Server controls invulnerability — ignore client value
                break;
            }

            case "fire": {
                if (!player || !player.alive) return;
                player.invulnerable = false; // Attacking cancels spawn protection
                const weaponKey = msg.weapon || player.weapon || "knife";
                // Broadcast to all other players for 3D positional audio and remote muzzle flashes
                broadcast({
                    type: "weaponFired",
                    shooterId: playerId,
                    weapon: weaponKey,
                    x: player.x,
                    y: player.y + 1.2,
                    z: player.z,
                    yaw: player.yaw,
                    pitch: player.pitch,
                }, playerId);
                break;
            }

            case "hit": {
                if (!player || !player.alive) return;
                player.invulnerable = false; // Attacking cancels spawn protection
                const target = players.get(msg.targetId);
                if (!target || !target.alive) return;

                // Reject hits on invulnerable players
                if (target.invulnerable) return;

                // Reject friendly fire (same team)
                if (player.team && target.team && player.team === target.team) return;

                const weaponKey = msg.weapon || "knife";

                // ---- Fire-rate validation (anti-cheat) ----
                const nowHit = Date.now();
                const minInterval = WEAPON_FIRE_INTERVALS[weaponKey] || 250;
                if (nowHit - (player.lastHitTime || 0) < minInterval * 0.6) {
                    return; // Too fast — reject hit
                }
                player.lastHitTime = nowHit;

                const maxRange = WEAPON_RANGES[weaponKey] || 100;

                // Distance validation: evaluate XZ horizontal distance with vertical height tolerance
                const dx = player.x - target.x;
                const dy = player.y - target.y;
                const dz = player.z - target.z;
                const horizontalDistSq = dx * dx + dz * dz;
                const maxAllowed = maxRange + 10;
                if (horizontalDistSq > maxAllowed * maxAllowed || Math.abs(dy) > 30) {
                    console.warn(`[!] Out-of-range hit rejected: ${player.name} -> ${target.name} (${Math.sqrt(horizontalDistSq).toFixed(1)}m > ${maxRange}m)`);
                    return;
                }

                // Look up damage from weapon type with shotgun pellet scaling
                let damage = WEAPON_DAMAGE[weaponKey] || 25;
                if (weaponKey === "by15") {
                    const pellets = Math.max(1, Math.min(8, Number(msg.pellets) || 1));
                    damage = pellets * (WEAPON_DAMAGE.by15 || 5);
                }

                // Apply damage
                target.hp = Math.max(0, target.hp - damage);

                // Broadcast damage with shooter position for directional indicator
                broadcast({
                    type: "damage",
                    targetId: target.id,
                    shooterId: playerId,
                    shooterName: player.name,
                    shooterX: player.x,
                    shooterY: player.y,
                    shooterZ: player.z,
                    hp: target.hp,
                    damage: damage,
                    weapon: weaponKey,
                });

                console.log(`[!] ${player.name} hit ${target.name} with ${weaponKey} (-${damage}) → HP: ${target.hp}`);

                // Kill?
                if (target.hp <= 0) {
                    target.alive = false;
                    player.kills++;
                    target.deaths++;

                    broadcast({
                        type: "kill",
                        killerId: playerId,
                        killerName: player.name,
                        victimId: target.id,
                        victimName: target.name,
                        killerKills: player.kills,
                        victimDeaths: target.deaths,
                        weapon: weaponKey,
                    });

                    console.log(`[X] ${player.name} killed ${target.name} with ${weaponKey}! (K:${player.kills})`);

                    // Schedule respawn with safe timer tracking
                    const targetId = target.id;
                    setPlayerTimeout(targetId, () => {
                        const t = players.get(targetId);
                        if (t) {
                            const sp = getRandomSpawn(t.map, t.team);
                            t.x = sp.x;
                            t.y = sp.y;
                            t.z = sp.z;
                            t.hp = MAX_HP;
                            t.alive = true;
                            t.weapon = "knife";
                            t.invulnerable = true;

                            broadcast({
                                type: "respawn",
                                id: t.id,
                                x: sp.x, y: sp.y, z: sp.z,
                                hp: MAX_HP,
                            });

                            console.log(`[↻] ${t.name} respawned (invulnerable for ${INVULN_DURATION/1000}s)`);

                            // Clear invulnerability after timer
                            setPlayerTimeout(targetId, () => {
                                const tp = players.get(targetId);
                                if (tp) {
                                    tp.invulnerable = false;
                                }
                            }, INVULN_DURATION);
                        }
                    }, RESPAWN_DELAY);
                }
                break;
            }

            case "fallDeath": {
                if (!player || !player.alive) return;
                player.alive = false;
                player.hp = 0;
                player.deaths++;

                // Broadcast kill feed (self-kill from fall)
                broadcast({
                    type: "kill",
                    killerId: playerId,
                    killerName: player.name,
                    victimId: playerId,
                    victimName: player.name,
                    killerKills: player.kills,
                    victimDeaths: player.deaths,
                    weapon: "fall",
                });

                console.log(`[X] ${player.name} died from fall damage! (D:${player.deaths})`);

                // Schedule respawn with safe timer tracking
                setPlayerTimeout(playerId, () => {
                    if (players.has(playerId)) {
                        const sp = getRandomSpawn(player.map, player.team);
                        player.x = sp.x;
                        player.y = sp.y;
                        player.z = sp.z;
                        player.hp = MAX_HP;
                        player.alive = true;
                        player.weapon = "knife";
                        player.invulnerable = true;

                        broadcast({
                            type: "respawn",
                            id: player.id,
                            x: sp.x, y: sp.y, z: sp.z,
                            hp: MAX_HP,
                        });

                        console.log(`[↻] ${player.name} respawned after fall death`);

                        // Clear invulnerability after timer
                        setPlayerTimeout(playerId, () => {
                            if (players.has(playerId)) {
                                player.invulnerable = false;
                            }
                        }, INVULN_DURATION);
                    }
                }, RESPAWN_DELAY);
                break;
            }

            case "pickupCollected": {
                // Broadcast to all other players so they see the pickup disappear
                if (!player) return;
                broadcast({
                    type: "pickupCollected",
                    pickupId: msg.pickupId,
                    playerId: playerId,
                }, playerId);
                break;
            }

            case "weaponChanged": {
                if (!player) return;
                player.weapon = msg.weapon || "knife";
                break;
            }

            case "ping": {
                // Instantly reply with pong to calculate accurate RTT
                send(ws, { type: "pong", t: msg.t });
                break;
            }
        }
        } catch (err) {
            console.error("[!] Message handler error (player " + playerId + "):", err && err.message ? err.message : err);
        }
    });

    ws.on("close", () => {
        if (player) {
            // Clear all pending timers for this player
            clearPlayerTimers(playerId);
            // Clean up delta state tracking
            lastSentState.delete(playerId);
            // Remove from other players' delta caches
            for (const [, cache] of lastSentState) {
                cache.delete(playerId);
            }

            players.delete(playerId);
            broadcast({ type: "playerLeft", id: playerId });
            console.log(`[-] "${player.name}" (ID:${playerId}) disconnected`);
            // Auto-balance teams after player leaves
            autoBalanceTeams();
        }
    });

    ws.on("error", (err) => {
        console.error(`[!] WebSocket error for player ${playerId}:`, err.message);
        // Force cleanup on error
        try { ws.close(); } catch (e) { /* ignore */ }
    });
});

// ---- Periodic Team Auto-Balancing (every 5s) ----
setInterval(autoBalanceTeams, 5000);

// ---- World State Broadcast Tick (with Delta Compression) ----
setInterval(() => {
    if (players.size === 0) return;

    // Build current state snapshot
    const currentStates = new Map();
    for (const [id, p] of players) {
        currentStates.set(id, {
            id: p.id, name: p.name,
            x: Math.round(p.x * 100) / 100,   // Round to 2 decimals to reduce noise
            y: Math.round(p.y * 100) / 100,
            z: Math.round(p.z * 100) / 100,
            yaw: Math.round(p.yaw * 1000) / 1000,
            pitch: Math.round(p.pitch * 1000) / 1000,
            animState: p.animState,
            hp: p.hp,
            kills: p.kills,
            deaths: p.deaths,
            alive: p.alive,
            weapon: p.weapon,
            invulnerable: p.invulnerable,
            team: p.team,
        });
    }

    // Send delta-compressed state to each player
    for (const [recipientId, recipient] of players) {
        if (recipient.ws.readyState !== 1) continue;

        let recipientCache = lastSentState.get(recipientId);
        if (!recipientCache) {
            recipientCache = new Map();
            lastSentState.set(recipientId, recipientCache);
        }

        const deltaPlayers = [];
        for (const [playerId, current] of currentStates) {
            const prev = recipientCache.get(playerId);

            if (!prev) {
                // First time seeing this player — send full data
                deltaPlayers.push(current);
                recipientCache.set(playerId, { ...current });
            } else {
                // Compute delta: only changed fields
                const delta = { id: current.id };
                let hasChanges = false;

                if (current.x !== prev.x) { delta.x = current.x; hasChanges = true; }
                if (current.y !== prev.y) { delta.y = current.y; hasChanges = true; }
                if (current.z !== prev.z) { delta.z = current.z; hasChanges = true; }
                if (current.yaw !== prev.yaw) { delta.yaw = current.yaw; hasChanges = true; }
                if (current.pitch !== prev.pitch) { delta.pitch = current.pitch; hasChanges = true; }
                if (current.animState !== prev.animState) { delta.animState = current.animState; hasChanges = true; }
                if (current.hp !== prev.hp) { delta.hp = current.hp; hasChanges = true; }
                if (current.kills !== prev.kills) { delta.kills = current.kills; hasChanges = true; }
                if (current.deaths !== prev.deaths) { delta.deaths = current.deaths; hasChanges = true; }
                if (current.alive !== prev.alive) { delta.alive = current.alive; hasChanges = true; }
                if (current.weapon !== prev.weapon) { delta.weapon = current.weapon; hasChanges = true; }
                if (current.invulnerable !== prev.invulnerable) { delta.invulnerable = current.invulnerable; hasChanges = true; }
                if (current.team !== prev.team) { delta.team = current.team; hasChanges = true; }

                if (hasChanges) {
                    deltaPlayers.push(delta);
                    // Update cache
                    Object.assign(prev, current);
                }
            }
        }

        // Remove cached players that no longer exist
        for (const cachedId of recipientCache.keys()) {
            if (!currentStates.has(cachedId)) {
                recipientCache.delete(cachedId);
            }
        }

        // Only send if there are changes
        if (deltaPlayers.length > 0) {
            try {
                recipient.ws.send(JSON.stringify({
                    type: "worldState",
                    players: deltaPlayers,
                    delta: true, // Flag so client knows this is delta-compressed
                }));
            } catch (e) {
                console.error(`[!] worldState send error to ${recipientId}:`, e.message);
            }
        }
    }
}, TICK_INTERVAL);

// ---- Start Server ----
httpServer.listen(PORT, "0.0.0.0", () => {
    // Get local IP addresses
    const os = require("os");
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name in interfaces) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }

    console.log("═══════════════════════════════════════════");
    console.log("  🎮 THALVORN — LAN Server");
    console.log("═══════════════════════════════════════════");
    console.log(`  Local:   http://localhost:${PORT}`);
    if (ips.length > 0) {
        ips.forEach(ip => {
            console.log(`  LAN:     http://${ip}:${PORT}`);
        });
    }
    console.log("═══════════════════════════════════════════");
    console.log("  Players connect via browser to the LAN URL above.");
    console.log("  Press Ctrl+C to stop the server.\n");
});
