/* ========================================
   HUD Module
   DOM-based heads-up display updates
   HP bar, kill feed, scoreboard
   ======================================== */

export function createHUD(player, weapons, cameraSystem, engine, network, remotePlayers, myTeam) {
    let localTeam = myTeam;
    // ---- DOM References ----
    const fpsEl = document.getElementById("fps-value");
    const pingEl = document.getElementById("ping-value");
    const cameraEl = document.getElementById("camera-mode-value");
    const statusEl = document.getElementById("status-value");
    const ammoCurrentEl = document.getElementById("ammo-current");
    const ammoMaxEl = document.getElementById("ammo-max");
    const ammoContainer = document.getElementById("ammo-counter");
    const coordsEl = document.getElementById("coords-value");
    const hpFill = document.getElementById("hp-fill");
    const hpText = document.getElementById("hp-text");
    const killFeed = document.getElementById("kill-feed");
    const scoreboardBody = document.getElementById("scoreboard-body");
    const scoreboardOverlay = document.getElementById("scoreboard-overlay");
    const playerCountEl = document.getElementById("player-count");
    const deathOverlay = document.getElementById("death-overlay");
    const dmgOverlay = document.getElementById("damage-overlay");
    const teamIndicatorEl = document.getElementById("team-indicator");
    const directionalIndicatorEl = document.getElementById("directional-damage-indicator");
    const killBannerEl = document.getElementById("kill-banner");
    const killVictimNameEl = document.getElementById("kill-victim-name");

    // Weapon HUD elements
    const weaponIconEl = document.getElementById("weapon-icon");
    const weaponNameEl = document.getElementById("weapon-name");
    const weaponTimerContainer = document.getElementById("weapon-timer-container");
    const weaponTimerFill = document.getElementById("weapon-timer-fill");
    const weaponTimerText = document.getElementById("weapon-timer-text");
    const invulnIndicator = document.getElementById("invuln-indicator");

    // FPS tracking
    let frameCount = 0;
    let fpsAccum = 0;
    let displayFPS = 60;

    // Throttle counter for non-critical DOM updates (~10 fps at 60 fps)
    let hudFrameCount = 0;
    const HUD_THROTTLE = 6; // Update every 6th frame

    // Kill feed entries
    const killFeedEntries = [];
    const MAX_KILL_FEED = 5;

    // Tab key for scoreboard
    let tabPressed = false;
    window.addEventListener("keydown", (e) => {
        if (e.code === "Tab") { e.preventDefault(); tabPressed = true; }
    });
    window.addEventListener("keyup", (e) => {
        if (e.code === "Tab") { tabPressed = false; }
    });

    // Cached HP state to avoid redundant DOM writes
    let lastHpPct = -1;
    let lastHpValue = -1;

    function update() {
        hudFrameCount++;
        const isThrottledFrame = (hudFrameCount % HUD_THROTTLE === 0);

        // ---- FPS Counter (every 500ms) ----
        frameCount++;
        fpsAccum += engine.getDeltaTime();
        if (fpsAccum >= 500) {
            displayFPS = Math.round((frameCount / fpsAccum) * 1000);
            frameCount = 0;
            fpsAccum = 0;
            if (fpsEl) fpsEl.textContent = displayFPS;
        }

        // ==== CRITICAL: Update every frame ====

        // ---- HP Bar (only on change) ----
        const currentHp = player.hp;
        if (currentHp !== lastHpValue) {
            lastHpValue = currentHp;
            const pct = Math.max(0, (currentHp / player.maxHp) * 100);
            if (hpFill && pct !== lastHpPct) {
                lastHpPct = pct;
                hpFill.style.width = pct + "%";
                if (pct > 60) hpFill.style.background = "linear-gradient(90deg, #44cc44, #66ee66)";
                else if (pct > 30) hpFill.style.background = "linear-gradient(90deg, #ccaa22, #eecc44)";
                else hpFill.style.background = "linear-gradient(90deg, #cc2222, #ee4444)";
            }
            if (hpText) hpText.textContent = currentHp;
        }

        // ---- Death Overlay ----
        if (deathOverlay) {
            if (!player.alive) {
                deathOverlay.classList.add("show");
            } else {
                deathOverlay.classList.remove("show");
            }
        }

        // ---- Invulnerability Indicator ----
        if (invulnIndicator) {
            if (player.invulnerable) {
                invulnIndicator.classList.add("show");
            } else {
                invulnIndicator.classList.remove("show");
            }
        }

        // ---- Ammo Counter (fires rapidly, keep responsive) ----
        if (ammoCurrentEl) {
            if (weapons.currentWeaponDef && weapons.currentWeaponDef.type === "melee") {
                ammoCurrentEl.textContent = "∞";
            } else {
                ammoCurrentEl.textContent = weapons.isReloading
                    ? "..." : weapons.currentAmmo;
            }
        }

        // ==== THROTTLED: Non-critical updates every 6 frames ====
        if (!isThrottledFrame) {
            // Still handle scoreboard (Tab) on every frame for responsiveness
            if (scoreboardOverlay) {
                if (tabPressed) {
                    scoreboardOverlay.classList.add("show");
                    updateScoreboard();
                } else {
                    scoreboardOverlay.classList.remove("show");
                }
            }
            return;
        }

        // ---- Team Indicator ----
        if (teamIndicatorEl && localTeam) {
            const color = localTeam === "X" ? "#66aaff" : "#ffaa44";
            teamIndicatorEl.innerHTML = `Team <span style="color:${color}">${localTeam}</span>`;
        }

        // ---- Camera Mode ----
        if (cameraEl) {
            cameraEl.textContent = cameraSystem.mode;
        }

        // ---- Player Status ----
        if (statusEl) {
            statusEl.textContent = player.state;
        }

        // ---- Ammo Max ----
        if (ammoMaxEl) {
            if (weapons.currentWeaponDef && weapons.currentWeaponDef.type === "melee") {
                ammoMaxEl.textContent = "∞";
            } else {
                ammoMaxEl.textContent = weapons.maxAmmo;
            }
        }
        if (ammoContainer) {
            ammoContainer.classList.toggle("reloading", weapons.isReloading);
            ammoContainer.classList.toggle("low", !weapons.isReloading && weapons.currentAmmo <= 5 && weapons.currentWeaponDef.type !== "melee");
        }

        // ---- Weapon Info ----
        if (weaponIconEl && weapons.currentWeaponDef) {
            weaponIconEl.textContent = weapons.currentWeaponDef.icon;
        }
        if (weaponNameEl && weapons.currentWeaponDef) {
            weaponNameEl.textContent = weapons.currentWeaponDef.name;
        }

        // ---- Weapon Timer ----
        if (weaponTimerContainer) {
            if (weapons.weaponTimerActive && weapons.weaponTimer > 0) {
                weaponTimerContainer.classList.remove("hidden");
                const maxDuration = weapons.currentWeaponDef.duration;
                const pct = (weapons.weaponTimer / maxDuration) * 100;
                if (weaponTimerFill) weaponTimerFill.style.width = pct + "%";
                if (weaponTimerText) weaponTimerText.textContent = Math.ceil(weapons.weaponTimer) + "s";
            } else {
                weaponTimerContainer.classList.add("hidden");
            }
        }

        // ---- Coordinates (debug) ----
        if (coordsEl) {
            const p = player.position;
            coordsEl.textContent = `${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)}`;
        }

        // ---- Player Count ----
        if (playerCountEl && remotePlayers) {
            playerCountEl.textContent = remotePlayers.count + 1; // +1 for self
        }

        // ---- Scoreboard Toggle (Tab) ----
        if (scoreboardOverlay) {
            if (tabPressed) {
                scoreboardOverlay.classList.add("show");
                updateScoreboard();
            } else {
                scoreboardOverlay.classList.remove("show");
            }
        }
    }

    // ---- Kill Feed ----
    function addKillFeedEntry(killerName, victimName) {
        if (!killFeed) return;

        const entry = document.createElement("div");
        entry.className = "kill-entry";

        const killerSpan = document.createElement("span");
        killerSpan.className = "killer";
        killerSpan.textContent = killerName;
        const victimSpan = document.createElement("span");
        victimSpan.className = "victim";
        victimSpan.textContent = victimName;
        entry.append(killerSpan, " ☠ ", victimSpan);

        killFeed.appendChild(entry);

        killFeedEntries.push(entry);
        if (killFeedEntries.length > MAX_KILL_FEED) {
            const old = killFeedEntries.shift();
            if (old.parentNode) old.parentNode.removeChild(old);
        }

        // Auto-remove after 5 seconds
        setTimeout(() => {
            entry.classList.add("fade-out");
            setTimeout(() => {
                if (entry.parentNode) entry.parentNode.removeChild(entry);
                const idx = killFeedEntries.indexOf(entry);
                if (idx !== -1) killFeedEntries.splice(idx, 1);
            }, 500);
        }, 5000);
    }

    // ---- Damage Flash ----
    function showDamageFlash() {
        if (!dmgOverlay) return;
        dmgOverlay.classList.add("show");
        setTimeout(() => dmgOverlay.classList.remove("show"), 200);
    }

    // ---- Scoreboard ----
    function updateScoreboard() {
        if (!scoreboardBody || !remotePlayers) return;

        // Collect all players (self + remotes)
        const allPlayers = [];
        allPlayers.push({
            name: "You",
            kills: player.kills,
            deaths: player.deaths,
            hp: player.hp,
            team: localTeam || "?",
            isSelf: true,
        });

        for (const [id, rp] of remotePlayers.all) {
            allPlayers.push({
                name: rp.name,
                kills: rp.kills ?? 0,
                deaths: rp.deaths ?? 0,
                hp: rp.hp ?? 0,
                team: rp.team || "?",
                isSelf: false,
            });
        }

        // Sort by kills descending
        allPlayers.sort((a, b) => b.kills - a.kills);

        // Render
        scoreboardBody.innerHTML = "";
        for (const p of allPlayers) {
            const row = document.createElement("tr");
            const teamClass = p.team === "X" ? "team-x" : p.team === "Y" ? "team-y" : "";
            row.className = p.isSelf ? "self-row" : teamClass;

            for (const val of [p.name, p.team, p.kills, p.deaths, p.hp]) {
                const td = document.createElement("td");
                td.textContent = val;
                row.appendChild(td);
            }
            scoreboardBody.appendChild(row);
        }
    }

    // ---- Directional Damage Indicator ----
    function showDirectionalDamage(shooterX, shooterZ, playerX, playerZ, playerYaw) {
        if (!directionalIndicatorEl) return;
        if (shooterX === undefined || shooterZ === undefined) return;

        const dx = shooterX - playerX;
        const dz = shooterZ - playerZ;
        const worldAngle = Math.atan2(dx, dz); // angle in radians

        // Relative angle to player's current view yaw
        const relAngle = worldAngle - playerYaw;
        const deg = relAngle * (180 / Math.PI);

        directionalIndicatorEl.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
        directionalIndicatorEl.classList.add("show");

        if (directionalIndicatorEl._timer) clearTimeout(directionalIndicatorEl._timer);
        directionalIndicatorEl._timer = setTimeout(() => {
            directionalIndicatorEl.classList.remove("show");
        }, 600);
    }

    // ---- Kill Confirmation Banner ----
    function showKillBanner(victimName) {
        if (!killBannerEl) return;
        if (killVictimNameEl) killVictimNameEl.textContent = victimName;
        killBannerEl.classList.add("show");
        if (killBannerEl._timer) clearTimeout(killBannerEl._timer);
        killBannerEl._timer = setTimeout(() => {
            killBannerEl.classList.remove("show");
        }, 2200);
    }

    // ---- Ping / Latency Display ----
    function setPing(ms) {
        if (!pingEl) return;
        pingEl.textContent = ms + "ms";
        if (ms < 50) pingEl.style.color = "#00ff66";
        else if (ms < 100) pingEl.style.color = "#ffcc00";
        else pingEl.style.color = "#ff4444";
    }

    return {
        update,
        addKillFeedEntry,
        showDamageFlash,
        showDirectionalDamage,
        showKillBanner,
        setPing,
        setTeam(t) { localTeam = t; },
    };
}
