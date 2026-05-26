// ============================================
// Smartwatch Motion → 3D Printer Controller
// ============================================

// --- Ultimaker 2+ build area ---
const BED_X = 223; // mm
const BED_Y = 223; // mm
const CANVAS_SIZE = 600; // pixels

// --- State ---
let bleDevice = null;
let bleCharacteristic = null;
let isRecording = false;
let cursorX = BED_X / 2; // start at center (mm)
let cursorY = BED_Y / 2;
let path = [];           // array of {x, y} points (in mm)
let allPaths = [];        // array of completed paths (for undo)
let currentPath = [];     // current recording segment

// --- Canvas setup ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// --- UI elements ---
const btnConnect = document.getElementById('btnConnect');
const btnRecord = document.getElementById('btnRecord');
const btnStop = document.getElementById('btnStop');
const btnClear = document.getElementById('btnClear');
const btnExport = document.getElementById('btnExport');
const btnUndo = document.getElementById('btnUndo');
const recIndicator = document.getElementById('recIndicator');

// --- Settings ---
const speedSlider = document.getElementById('speed');
const lineWidthSlider = document.getElementById('lineWidth');

speedSlider.addEventListener('input', () => {
    document.getElementById('speedVal').textContent = speedSlider.value;
});
lineWidthSlider.addEventListener('input', () => {
    document.getElementById('lineWidthVal').textContent = lineWidthSlider.value;
});

// ============================================
// BLE CONNECTION
// ============================================

async function connectWatch() {
    try {
        btnConnect.textContent = 'Connecting...';
        btnConnect.disabled = true;

        // Request BLE device with our custom service
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Bangle' }],
            optionalServices: ['12340001-1234-1234-1234-123456789abc']
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService('12340001-1234-1234-1234-123456789abc');
        bleCharacteristic = await service.getCharacteristic('12340002-1234-1234-1234-123456789abc');

        // Subscribe to notifications
        await bleCharacteristic.startNotifications();
        bleCharacteristic.addEventListener('characteristicvaluechanged', onMotionData);

        // Update UI
        document.getElementById('bleStatus').className = 'status-dot dot-green';
        document.getElementById('bleText').textContent = 'Watch: Connected';
        btnConnect.textContent = 'Connected ✓';
        btnRecord.disabled = false;

        console.log('Connected to Bangle.js!');

    } catch (error) {
        console.error('BLE connection failed:', error);
        btnConnect.textContent = 'Connect Watch';
        btnConnect.disabled = false;
        document.getElementById('bleStatus').className = 'status-dot dot-red';
        document.getElementById('bleText').textContent = 'Watch: Failed - ' + error.message;
    }
}

function onDisconnected() {
    document.getElementById('bleStatus').className = 'status-dot dot-red';
    document.getElementById('bleText').textContent = 'Watch: Disconnected';
    btnConnect.textContent = 'Reconnect';
    btnConnect.disabled = false;
    btnRecord.disabled = true;
    stopRecording();
    bleCharacteristic = null;
}

// ============================================
// MOTION DATA HANDLING
// ============================================

function onMotionData(event) {
    const data = event.target.value;
    const tiltX = data.getInt16(0);
    const tiltY = data.getInt16(2);

    // Update display values
    document.getElementById('valX').textContent = tiltX;
    document.getElementById('valY').textContent = tiltY;

    if (!isRecording) return;

    // Convert tilt to movement
    // Speed factor: how many mm per update per tilt unit
    const speed = parseFloat(speedSlider.value) * 0.02;

    // Update cursor position
    cursorX += tiltX * speed;
    cursorY -= tiltY * speed; // inverted: tilt forward = Y increase

    // Clamp to bed boundaries
    cursorX = Math.max(5, Math.min(BED_X - 5, cursorX));
    cursorY = Math.max(5, Math.min(BED_Y - 5, cursorY));

    // Update position display
    document.getElementById('valPX').textContent = cursorX.toFixed(1);
    document.getElementById('valPY').textContent = cursorY.toFixed(1);

    // Add point to current path
    currentPath.push({ x: cursorX, y: cursorY });

    // Update point count
    const totalPoints = allPaths.reduce((sum, p) => sum + p.length, 0) + currentPath.length;
    document.getElementById('pointCount').textContent = 'Points: ' + totalPoints;

    // Redraw
    drawCanvas();
}

// ============================================
// RECORDING CONTROLS
// ============================================

function startRecording() {
    isRecording = true;
    currentPath = [{ x: cursorX, y: cursorY }];

    btnRecord.disabled = true;
    btnStop.disabled = false;
    btnExport.disabled = true;
    recIndicator.style.display = 'block';

    document.getElementById('bleStatus').className = 'status-dot dot-yellow';
    document.getElementById('bleText').textContent = 'Watch: Recording...';
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    // Save current path if it has points
    if (currentPath.length > 1) {
        allPaths.push([...currentPath]);
    }
    currentPath = [];

    btnRecord.disabled = !bleCharacteristic;
    btnStop.disabled = true;
    btnExport.disabled = allPaths.length === 0;
    btnClear.disabled = allPaths.length === 0;
    btnUndo.disabled = allPaths.length === 0;
    recIndicator.style.display = 'none';

    if (bleCharacteristic) {
        document.getElementById('bleStatus').className = 'status-dot dot-green';
        document.getElementById('bleText').textContent = 'Watch: Connected';
    }
}

function clearDrawing() {
    allPaths = [];
    currentPath = [];
    cursorX = BED_X / 2;
    cursorY = BED_Y / 2;
    document.getElementById('pointCount').textContent = 'Points: 0';
    document.getElementById('valPX').textContent = cursorX.toFixed(0);
    document.getElementById('valPY').textContent = cursorY.toFixed(0);
    btnExport.disabled = true;
    btnClear.disabled = true;
    btnUndo.disabled = true;
    drawCanvas();
}

function undoLast() {
    if (allPaths.length > 0) {
        allPaths.pop();
        const totalPoints = allPaths.reduce((sum, p) => sum + p.length, 0);
        document.getElementById('pointCount').textContent = 'Points: ' + totalPoints;
        btnExport.disabled = allPaths.length === 0;
        btnClear.disabled = allPaths.length === 0;
        btnUndo.disabled = allPaths.length === 0;
        drawCanvas();
    }
}

// ============================================
// CANVAS DRAWING
// ============================================

function drawCanvas() {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Background grid (represents printer bed)
    drawGrid();

    // Draw all completed paths
    allPaths.forEach((p, index) => {
        drawPath(p, getPathColor(index), false);
    });

    // Draw current recording path
    if (currentPath.length > 0) {
        drawPath(currentPath, '#00ff88', true);
    }

    // Draw cursor
    drawCursor();
}

function drawGrid() {
    const scale = CANVAS_SIZE / BED_X;

    ctx.strokeStyle = '#1a2a44';
    ctx.lineWidth = 1;

    // Grid lines every 10mm
    for (let i = 0; i <= BED_X; i += 10) {
        const pos = i * scale;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, CANVAS_SIZE);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(CANVAS_SIZE, pos);
        ctx.stroke();
    }

    // Center crosshair
    ctx.strokeStyle = '#2a3a54';
    ctx.lineWidth = 1;
    const center = CANVAS_SIZE / 2;
    ctx.beginPath();
    ctx.moveTo(center, 0);
    ctx.lineTo(center, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(CANVAS_SIZE, center);
    ctx.stroke();

    // Border
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_SIZE - 2, CANVAS_SIZE - 2);
}

function getPathColor(index) {
    const colors = ['#00d4ff', '#ff6688', '#ffaa00', '#aa66ff', '#44ffaa', '#ff44aa'];
    return colors[index % colors.length];
}

function drawPath(points, color, isActive) {
    if (points.length < 2) return;

    const scale = CANVAS_SIZE / BED_X;
    const width = parseInt(lineWidthSlider.value);

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (isActive) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x * scale, (BED_Y - points[0].y) * scale);

    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * scale, (BED_Y - points[i].y) * scale);
    }

    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw start point marker
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(points[0].x * scale, (BED_Y - points[0].y) * scale, 4, 0, Math.PI * 2);
    ctx.fill();
}

function drawCursor() {
    const scale = CANVAS_SIZE / BED_X;
    const cx = cursorX * scale;
    const cy = (BED_Y - cursorY) * scale;

    // Outer ring
    ctx.strokeStyle = isRecording ? '#ff0000' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = isRecording ? '#ff0000' : '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair lines
    ctx.strokeStyle = isRecording ? 'rgba(255,0,0,0.3)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(CANVAS_SIZE, cy);
    ctx.stroke();
}

// ============================================
// G-CODE EXPORT
// ============================================

function exportGcode() {
    if (allPaths.length === 0) return;

    const feedRate = parseInt(document.getElementById('printSpeed').value) || 1500;
    const zHeight = 1; // draw at 1mm height (pen just touches bed)

    let gcode = [];

    // Header
    gcode.push('; ==========================================');
    gcode.push('; Generated by Smartwatch Motion Controller');
    gcode.push('; Ultimaker 2+ compatible');
    gcode.push('; Date: ' + new Date().toISOString());
    gcode.push('; Paths: ' + allPaths.length);
    gcode.push('; ==========================================');
    gcode.push('');
    gcode.push('; --- Printer Setup ---');
    gcode.push('G21 ; set units to millimeters');
    gcode.push('G90 ; absolute positioning');
    gcode.push('G28 ; home all axes');
    gcode.push('');
    gcode.push('; --- Heat bed and nozzle (PLA defaults) ---');
    gcode.push('M140 S60 ; set bed temp');
    gcode.push('M105 ; report temp');
    gcode.push('M190 S60 ; wait for bed temp');
    gcode.push('M104 S200 ; set nozzle temp');
    gcode.push('M105 ; report temp');
    gcode.push('M109 S200 ; wait for nozzle temp');
    gcode.push('');
    gcode.push('; --- Prime nozzle ---');
    gcode.push('G1 Z5 F3000 ; lift nozzle');
    gcode.push('G1 X5 Y5 F3000 ; move to corner');
    gcode.push('G1 Z0.3 F1000 ; lower');
    gcode.push('G1 X50 E10 F500 ; prime line');
    gcode.push('G1 Z5 F3000 ; lift');
    gcode.push('G92 E0 ; reset extruder');
    gcode.push('');
    gcode.push('; --- Start Drawing ---');

    let totalE = 0; // extruder position
    const layerHeight = 0.2;
    const lineWidthMM = 0.4;
    const filamentDiameter = 2.85; // Ultimaker 2+ uses 2.85mm filament
    const filamentArea = Math.PI * (filamentDiameter / 2) * (filamentDiameter / 2);
    const extrusionMultiplier = (layerHeight * lineWidthMM) / filamentArea;

    allPaths.forEach((pathPoints, pathIndex) => {
        gcode.push('');
        gcode.push('; --- Path ' + (pathIndex + 1) + ' (' + pathPoints.length + ' points) ---');

        // Simplify path to reduce G-code size
        const simplified = simplifyPath(pathPoints, 0.5);

        // Move to start of path (travel move - no extrusion)
        gcode.push('G1 Z' + (layerHeight + 2).toFixed(1) + ' F3000 ; lift for travel');
        gcode.push('G1 X' + simplified[0].x.toFixed(2) + ' Y' + simplified[0].y.toFixed(2) + ' F3000 ; travel to start');
        gcode.push('G1 Z' + layerHeight.toFixed(1) + ' F1000 ; lower to print height');

        // Draw path
        for (let i = 1; i < simplified.length; i++) {
            const dx = simplified[i].x - simplified[i - 1].x;
            const dy = simplified[i].y - simplified[i - 1].y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            totalE += dist * extrusionMultiplier;

            gcode.push(
                'G1 X' + simplified[i].x.toFixed(2) +
                ' Y' + simplified[i].y.toFixed(2) +
                ' E' + totalE.toFixed(4) +
                ' F' + feedRate
            );
        }
    });

    // Footer
    gcode.push('');
    gcode.push('; --- End ---');
    gcode.push('G1 Z10 F3000 ; lift nozzle');
    gcode.push('G1 X5 Y' + (BED_Y - 5).toFixed(0) + ' F3000 ; move to back');
    gcode.push('M104 S0 ; turn off nozzle');
    gcode.push('M140 S0 ; turn off bed');
    gcode.push('M84 ; disable motors');
    gcode.push('M107 ; turn off fan');

    // Download file
    const blob = new Blob([gcode.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'smartwatch_drawing_' + Date.now() + '.gcode';
    a.click();
    URL.revokeObjectURL(url);
}

// Simplify path using Douglas-Peucker algorithm
function simplifyPath(points, tolerance) {
    if (points.length <= 2) return points;

    // Find point with max distance from line between first and last
    let maxDist = 0;
    let maxIndex = 0;

    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const dist = perpendicularDistance(points[i], first, last);
        if (dist > maxDist) {
            maxDist = dist;
            maxIndex = i;
        }
    }

    if (maxDist > tolerance) {
        const left = simplifyPath(points.slice(0, maxIndex + 1), tolerance);
        const right = simplifyPath(points.slice(maxIndex), tolerance);
        return left.slice(0, -1).concat(right);
    } else {
        return [first, last];
    }
}

function perpendicularDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) {
        const ddx = point.x - lineStart.x;
        const ddy = point.y - lineStart.y;
        return Math.sqrt(ddx * ddx + ddy * ddy);
    }

    return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / len;
}

// ============================================
// DEMO MODE (for testing without watch)
// ============================================

// Allow mouse drawing for testing
let mouseDown = false;

canvas.addEventListener('mousedown', (e) => {
    if (bleCharacteristic) return; // use watch if connected
    mouseDown = true;
    const rect = canvas.getBoundingClientRect();
    const scale = BED_X / CANVAS_SIZE;
    cursorX = (e.clientX - rect.left) * scale;
    cursorY = BED_Y - (e.clientY - rect.top) * scale;
    currentPath = [{ x: cursorX, y: cursorY }];
    isRecording = true;
    recIndicator.style.display = 'block';
    drawCanvas();
});

canvas.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    const rect = canvas.getBoundingClientRect();
    const scale = BED_X / CANVAS_SIZE;
    cursorX = Math.max(5, Math.min(BED_X - 5, (e.clientX - rect.left) * scale));
    cursorY = Math.max(5, Math.min(BED_Y - 5, BED_Y - (e.clientY - rect.top) * scale));

    document.getElementById('valPX').textContent = cursorX.toFixed(1);
    document.getElementById('valPY').textContent = cursorY.toFixed(1);

    currentPath.push({ x: cursorX, y: cursorY });

    const totalPoints = allPaths.reduce((sum, p) => sum + p.length, 0) + currentPath.length;
    document.getElementById('pointCount').textContent = 'Points: ' + totalPoints;

    drawCanvas();
});

canvas.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    isRecording = false;
    recIndicator.style.display = 'none';

    if (currentPath.length > 1) {
        allPaths.push([...currentPath]);
    }
    currentPath = [];

    btnExport.disabled = allPaths.length === 0;
    btnClear.disabled = allPaths.length === 0;
    btnUndo.disabled = allPaths.length === 0;
    drawCanvas();
});

// ============================================
// INIT
// ============================================

drawCanvas();
console.log('Smartwatch Motion Controller ready.');
console.log('No watch? Draw with your mouse on the canvas to test!');
