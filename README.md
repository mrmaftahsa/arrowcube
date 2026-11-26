# Arrow Cube: Escape Puzzle

A 3D "tap away" arrow puzzle for Android. Swipe to rotate the cube, tap arrows to launch them.
If an arrow is blocked it drops into the 4-slot queue; 3 of the same colour in the queue clear out.
Fill all 4 slots and you're jammed.

**Tech:** Three.js (3D, WebGL) + Capacitor (wraps it as a native Android app). GitHub Actions builds the APK — nothing to install on your PC.

## Get the APK
1. Upload everything in this folder to a GitHub repository (including the `.github` folder).
2. Open the repo's **Actions** tab → **Build Android APK**. It runs on every push (or press **Run workflow**).
3. When it finishes (about 5 min), open the run → scroll to **Artifacts** → download **ArrowCube-APK**.
4. Unzip it, copy `ArrowCube.apk` to your phone, tap it and allow "Install unknown apps".

## Files
- `www/index.html`, `www/style.css` — screens and HUD
- `www/js/main.js` — 3D rendering, touch controls, animations
- `www/js/logic.js` — level generator (every level is guaranteed solvable), queue rules
- `www/js/audio.js` — synthesized sounds + vibration
- `assets/` — app icon and splash
- `.github/workflows/build-apk.yml` — the cloud build

## Tweaking
- Queue size / match count: top of `www/js/logic.js` (`QUEUE_SIZE`, `MATCH_COUNT`)
- Difficulty curve: `levelConfig()` in `www/js/logic.js`
- Hints per level: `hintsLeft = 3` in `www/js/main.js`
