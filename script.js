/**
 * Disk Scheduler for Database Workloads
 * Interactive OS Simulation & Analysis Engine
 */

(function () {
  'use strict';

  // --- Configuration & State ---
  const state = {
    diskSize: 200,
    reqCount: 50,
    headStart: 50,
    workloadKind: 'hotspot',
    algoName: 'SSTF',
    speed: 1.0,

    // Workload data
    requests: [], // Array of numbers (tracks)
    
    // Active simulation path & metrics for single visualizer
    activePath: [], // Array of { track, reqIdx, isBoundary, isJump }
    activeMetrics: null,
    
    // Animation playback state
    isPlaying: false,
    currentStepIndex: 0,
    stepProgress: 0.0, // 0 to 1 between steps
    lastTimestamp: 0,
    currentHeadPos: 50,
    servedSet: new Set(),
    trailHistory: [],

    // Multi-algorithm race state
    raceActive: false,
    racePaths: {},
    raceProgress: {
      FCFS: { stepIndex: 0, subProgress: 0, head: 50, seek: 0, served: 0, finished: false, finishTime: null },
      SSTF: { stepIndex: 0, subProgress: 0, head: 50, seek: 0, served: 0, finished: false, finishTime: null },
      SCAN: { stepIndex: 0, subProgress: 0, head: 50, seek: 0, served: 0, finished: false, finishTime: null },
      'C-SCAN': { stepIndex: 0, subProgress: 0, head: 50, seek: 0, served: 0, finished: false, finishTime: null }
    },
    raceResults: {},

    // Monte Carlo / Averages
    isAveraged: false,
    averagedMetrics: null
  };

  const ALGOS = ['FCFS', 'SSTF', 'SCAN', 'C-SCAN'];

  // --- Workload Generators ---
  function generateWorkload(kind, n, disk) {
    if (kind === 'random') {
      return Array.from({ length: n }, () => Math.floor(Math.random() * disk));
    }
    if (kind === 'sequential') {
      const start = Math.floor(Math.random() * Math.floor(disk / 2));
      return Array.from({ length: n }, (_, i) => (start + i) % disk);
    }
    if (kind === 'hotspot') {
      // 80% of requests inside 3 small 20-track zones (like database index lookups)
      const safeMax = Math.max(1, disk - 20);
      const zones = Array.from({ length: 3 }, () => Math.floor(Math.random() * safeMax));
      const reqs = [];
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.8) {
          const z = zones[Math.floor(Math.random() * zones.length)];
          reqs.push(z + Math.floor(Math.random() * Math.min(20, disk - z)));
        } else {
          reqs.push(Math.floor(Math.random() * disk));
        }
      }
      return reqs;
    }
    return Array.from({ length: n }, () => Math.floor(Math.random() * disk));
  }

  // --- Scheduling Algorithms ---
  function getAlgorithmPath(name, reqs, head, disk) {
    switch (name) {
      case 'FCFS': {
        return reqs.map((track, idx) => ({ track, reqIdx: idx }));
      }

      case 'SSTF': {
        const pending = reqs.map((track, idx) => ({ track, reqIdx: idx }));
        const path = [];
        let pos = head;
        while (pending.length > 0) {
          let bestIdx = 0;
          let minDiff = Math.abs(pending[0].track - pos);
          for (let i = 1; i < pending.length; i++) {
            const diff = Math.abs(pending[i].track - pos);
            if (diff < minDiff) {
              minDiff = diff;
              bestIdx = i;
            }
          }
          const chosen = pending[bestIdx];
          pending.splice(bestIdx, 1);
          path.push(chosen);
          pos = chosen.track;
        }
        return path;
      }

      case 'SCAN': {
        const items = reqs.map((track, idx) => ({ track, reqIdx: idx }));
        const up = items.filter(r => r.track >= head).sort((a, b) => a.track - b.track);
        const down = items.filter(r => r.track < head).sort((a, b) => b.track - a.track);
        let path = [...up];
        if (down.length > 0) {
          path.push({ track: disk - 1, reqIdx: null, isBoundary: true });
          path = path.concat(down);
        }
        return path;
      }

      case 'C-SCAN': {
        const items = reqs.map((track, idx) => ({ track, reqIdx: idx }));
        const up = items.filter(r => r.track >= head).sort((a, b) => a.track - b.track);
        const low = items.filter(r => r.track < head).sort((a, b) => a.track - b.track);
        let path = [...up];
        if (low.length > 0) {
          path.push({ track: disk - 1, reqIdx: null, isBoundary: true });
          path.push({ track: 0, reqIdx: null, isJump: true });
          path = path.concat(low);
        }
        return path;
      }

      default:
        return reqs.map((track, idx) => ({ track, reqIdx: idx }));
    }
  }

  // --- Metrics Evaluation ---
  function evaluate(path, head, totalReqCount) {
    let totalSeek = 0;
    let pos = head;
    const waits = new Array(totalReqCount).fill(0);
    const serviceOrder = [];

    for (const step of path) {
      totalSeek += Math.abs(step.track - pos);
      pos = step.track;
      if (step.reqIdx !== null && step.reqIdx !== undefined) {
        waits[step.reqIdx] = totalSeek;
        serviceOrder.push(step.reqIdx);
      }
    }

    const avgWait = waits.reduce((a, b) => a + b, 0) / (totalReqCount || 1);

    // Overtaking for fairness:
    // For each request i (0 <= i < totalReqCount), count requests j > i served before i
    const overtakings = new Array(totalReqCount).fill(0);
    for (let i = 0; i < totalReqCount; i++) {
      const posI = serviceOrder.indexOf(i);
      if (posI > 0) {
        let count = 0;
        for (let k = 0; k < posI; k++) {
          if (serviceOrder[k] > i) {
            count++;
          }
        }
        overtakings[i] = count;
      }
    }

    const maxOvertaking = overtakings.length > 0 ? Math.max(...overtakings) : 0;
    const avgOvertaking = overtakings.length > 0 ? overtakings.reduce((a, b) => a + b, 0) / overtakings.length : 0;

    return {
      totalSeek,
      avgWait,
      maxOvertaking,
      avgOvertaking,
      waits,
      overtakings,
      serviceOrder
    };
  }

  // --- DOM Elements ---
  const els = {
    workloadSelect: document.getElementById('workload-select'),
    algoSelect: document.getElementById('algo-select'),
    reqCountSlider: document.getElementById('req-count-slider'),
    reqCountVal: document.getElementById('req-count-val'),
    diskSizeSlider: document.getElementById('disk-size-slider'),
    diskSizeVal: document.getElementById('disk-size-val'),
    headPosSlider: document.getElementById('head-pos-slider'),
    headPosVal: document.getElementById('head-pos-val'),
    headSliderMax: document.getElementById('head-slider-max'),
    speedSlider: document.getElementById('speed-slider'),
    speedVal: document.getElementById('speed-val'),

    workloadCaption: document.getElementById('workload-caption'),
    algoCaption: document.getElementById('algo-caption'),
    currentWorkloadBadge: document.getElementById('current-workload-badge'),
    currentAlgoBadge: document.getElementById('current-algo-badge'),

    btnPlay: document.getElementById('btn-play'),
    playText: document.getElementById('play-text'),
    btnPause: document.getElementById('btn-pause'),
    btnStep: document.getElementById('btn-step'),
    btnReset: document.getElementById('btn-reset'),
    btnNewWorkload: document.getElementById('btn-new-workload'),
    btnCompareAll: document.getElementById('btn-compare-all'),
    btnHeroCompare: document.getElementById('btn-hero-compare'),
    btnStartSim: document.getElementById('btn-start-sim'),

    // HUD
    hudCurrentTrack: document.getElementById('hud-current-track'),
    hudDiskTotal: document.getElementById('hud-disk-total'),
    hudHeadStatus: document.getElementById('hud-head-status'),
    hudServedCount: document.getElementById('hud-served-count'),
    hudReqTotal: document.getElementById('hud-req-total'),
    hudProgressBarFill: document.getElementById('hud-progress-bar-fill'),
    hudSeekDist: document.getElementById('hud-seek-dist'),
    hudOvertakeStat: document.getElementById('hud-overtake-stat'),
    hudFairnessCaption: document.getElementById('hud-fairness-caption'),

    // Visualizer Canvas & Tooltip
    diskCanvas: document.getElementById('diskCanvas'),
    canvasTooltip: document.getElementById('canvas-tooltip'),
    trackRuler: {
      quarter: document.getElementById('ruler-quarter'),
      mid: document.getElementById('ruler-mid'),
      threeQuarter: document.getElementById('ruler-three-quarter'),
      max: document.getElementById('ruler-max')
    },

    // Chart
    movementChart: document.getElementById('movementChart'),
    chartStepCounter: document.getElementById('chart-step-counter'),

    // Race Elements
    btnStartRace: document.getElementById('btn-start-race'),
    btnResetRace: document.getElementById('btn-reset-race'),
    raceBanner: document.getElementById('race-banner'),
    raceWinnerTitle: document.getElementById('race-winner-title'),
    raceWinnerDesc: document.getElementById('race-winner-desc'),
    raceLanes: {
      FCFS: {
        canvas: document.getElementById('raceCanvas-FCFS'),
        seek: document.getElementById('race-seek-FCFS'),
        served: document.getElementById('race-served-FCFS'),
        rank: document.getElementById('race-rank-FCFS')
      },
      SSTF: {
        canvas: document.getElementById('raceCanvas-SSTF'),
        seek: document.getElementById('race-seek-SSTF'),
        served: document.getElementById('race-served-SSTF'),
        rank: document.getElementById('race-rank-SSTF')
      },
      SCAN: {
        canvas: document.getElementById('raceCanvas-SCAN'),
        seek: document.getElementById('race-seek-SCAN'),
        served: document.getElementById('race-served-SCAN'),
        rank: document.getElementById('race-rank-SCAN')
      },
      'C-SCAN': {
        canvas: document.getElementById('raceCanvas-CSCAN'),
        seek: document.getElementById('race-seek-CSCAN'),
        served: document.getElementById('race-served-CSCAN'),
        rank: document.getElementById('race-rank-CSCAN')
      }
    },

    // Results Table & Bar Charts
    metricsTableBody: document.getElementById('metrics-table-body'),
    btnRun20: document.getElementById('btn-run-20-runs'),
    monteCarloStatus: document.getElementById('monte-carlo-status'),
    mcStatusText: document.getElementById('mc-status-text'),
    seekChartCanvas: document.getElementById('seekChart'),
    overtakeChartCanvas: document.getElementById('overtakeChart'),

    // Fairness Demo
    fairnessCurrentAlgoLabel: document.getElementById('fairness-current-algo-label'),
    starvationTitle: document.getElementById('starvation-title'),
    starvationExplanation: document.getElementById('starvation-explanation'),
    starvedPillsContainer: document.getElementById('starved-pills-container')
  };

  // --- Chart Instances ---
  let chartMovementInstance = null;
  let chartSeekInstance = null;
  let chartOvertakeInstance = null;

  // --- Initialize Simulation ---
  function init() {
    setupEventListeners();
    initCharts();
    generateNewData();
    requestAnimationFrame(renderLoop);
  }

  function setupEventListeners() {
    // Sliders
    els.reqCountSlider.addEventListener('input', (e) => {
      state.reqCount = parseInt(e.target.value, 10);
      els.reqCountVal.textContent = state.reqCount;
      generateNewData();
    });

    els.diskSizeSlider.addEventListener('input', (e) => {
      state.diskSize = parseInt(e.target.value, 10);
      els.diskSizeVal.textContent = state.diskSize;
      els.headPosSlider.max = state.diskSize - 1;
      els.headSliderMax.textContent = state.diskSize - 1;
      if (state.headStart >= state.diskSize) {
        state.headStart = Math.floor(state.diskSize / 4);
        els.headPosSlider.value = state.headStart;
        els.headPosVal.textContent = state.headStart;
      }
      updateRuler();
      generateNewData();
    });

    els.headPosSlider.addEventListener('input', (e) => {
      state.headStart = parseInt(e.target.value, 10);
      els.headPosVal.textContent = state.headStart;
      recalculatePaths();
      resetSimulation();
    });

    els.speedSlider.addEventListener('input', (e) => {
      state.speed = parseFloat(e.target.value);
      els.speedVal.textContent = state.speed.toFixed(1) + 'x';
    });

    // Dropdowns
    els.workloadSelect.addEventListener('change', (e) => {
      state.workloadKind = e.target.value;
      updateCaptions();
      generateNewData();
    });

    els.algoSelect.addEventListener('change', (e) => {
      state.algoName = e.target.value;
      updateCaptions();
      recalculatePaths();
      resetSimulation();
    });

    // Buttons
    els.btnNewWorkload.addEventListener('click', () => {
      generateNewData();
    });

    els.btnPlay.addEventListener('click', togglePlay);
    els.btnPause.addEventListener('click', pauseSimulation);
    els.btnStep.addEventListener('click', stepSimulation);
    els.btnReset.addEventListener('click', resetSimulation);

    // Race Buttons
    els.btnCompareAll.addEventListener('click', () => {
      document.getElementById('race-section').scrollIntoView({ behavior: 'smooth' });
      startRace();
    });

    els.btnHeroCompare.addEventListener('click', () => {
      document.getElementById('race-section').scrollIntoView({ behavior: 'smooth' });
      startRace();
    });

    els.btnStartRace.addEventListener('click', startRace);
    els.btnResetRace.addEventListener('click', resetRace);

    // Monte Carlo
    els.btnRun20.addEventListener('click', runMonteCarlo20);

    // Canvas tooltip tracking
    els.diskCanvas.addEventListener('mousemove', handleCanvasHover);
    els.diskCanvas.addEventListener('mouseleave', () => {
      els.canvasTooltip.style.display = 'none';
    });

    // Handle Window Resize for Canvas DPI
    window.addEventListener('resize', () => {
      resizeCanvases();
    });

    resizeCanvases();
  }

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    // Main canvas
    const rect = els.diskCanvas.getBoundingClientRect();
    els.diskCanvas.width = rect.width * dpr;
    els.diskCanvas.height = 230 * dpr;
    const ctx = els.diskCanvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Race canvases
    ALGOS.forEach(algo => {
      const c = els.raceLanes[algo].canvas;
      const cRect = c.getBoundingClientRect();
      c.width = cRect.width * dpr;
      c.height = 52 * dpr;
      const cCtx = c.getContext('2d');
      cCtx.scale(dpr, dpr);
    });
  }

  function updateCaptions() {
    if (state.workloadKind === 'hotspot') {
      els.workloadCaption.textContent = '80% of reads hit 3 small index zones of 20 tracks (B-tree root/index blocks).';
      els.currentWorkloadBadge.textContent = 'Hotspot (DB Index)';
    } else if (state.workloadKind === 'random') {
      els.workloadCaption.textContent = 'Uniform random tracks across cylinders (independent OLTP queries).';
      els.currentWorkloadBadge.textContent = 'Random (OLTP)';
    } else {
      els.workloadCaption.textContent = 'Contiguous tracks wrapping around (Full Table Scan or WAL sequential stream).';
      els.currentWorkloadBadge.textContent = 'Sequential (WAL/Scan)';
    }

    if (state.algoName === 'FCFS') {
      els.algoCaption.textContent = 'Processes requests strictly in arrival order (no reordering).';
    } else if (state.algoName === 'SSTF') {
      els.algoCaption.textContent = 'Greedily selects nearest pending track to current head position.';
    } else if (state.algoName === 'SCAN') {
      els.algoCaption.textContent = 'Sweeps up to disk boundary (D-1), then reverses downward.';
    } else {
      els.algoCaption.textContent = 'Sweeps up to boundary (D-1), then jumps back to track 0 in one stroke.';
    }
    els.currentAlgoBadge.textContent = state.algoName;
    els.fairnessCurrentAlgoLabel.textContent = `${state.algoName} Fairness Analysis`;
  }

  function updateRuler() {
    const d = state.diskSize;
    els.hudDiskTotal.textContent = d - 1;
    els.trackRuler.quarter.textContent = `Track ${Math.round(d * 0.25)}`;
    els.trackRuler.mid.textContent = `Track ${Math.round(d * 0.5)}`;
    els.trackRuler.threeQuarter.textContent = `Track ${Math.round(d * 0.75)}`;
    els.trackRuler.max.textContent = `Track ${d - 1} (Outer)`;
  }

  // --- Data Generation & Recalculation ---
  function generateNewData() {
    state.requests = generateWorkload(state.workloadKind, state.reqCount, state.diskSize);
    state.isAveraged = false;
    updateRuler();
    recalculatePaths();
    resetSimulation();
    resetRace();
    updateResultsSection();
    updateFairnessSection();
  }

  function recalculatePaths() {
    // Generate paths and metrics for all 4 algorithms on current workload
    state.racePaths = {};
    state.raceResults = {};
    ALGOS.forEach(algo => {
      const p = getAlgorithmPath(algo, state.requests, state.headStart, state.diskSize);
      state.racePaths[algo] = p;
      state.raceResults[algo] = evaluate(p, state.headStart, state.requests.length);
    });

    state.activePath = state.racePaths[state.algoName];
    state.activeMetrics = state.raceResults[state.algoName];
    updateMovementChart();
  }

  // --- Simulation Control ---
  function togglePlay() {
    if (state.isPlaying) {
      pauseSimulation();
    } else {
      playSimulation();
    }
  }

  function playSimulation() {
    if (state.currentStepIndex >= state.activePath.length) {
      resetSimulation();
    }
    state.isPlaying = true;
    els.btnPlay.classList.add('playing');
    els.playText.textContent = 'Pause';
    els.hudHeadStatus.textContent = 'Actuator scanning...';
  }

  function pauseSimulation() {
    state.isPlaying = false;
    els.btnPlay.classList.remove('playing');
    els.playText.textContent = 'Play';
    els.hudHeadStatus.textContent = 'Paused';
  }

  function resetSimulation() {
    pauseSimulation();
    state.currentStepIndex = 0;
    state.stepProgress = 0;
    state.currentHeadPos = state.headStart;
    state.servedSet.clear();
    state.trailHistory = [{ track: state.headStart, progress: 1.0 }];

    updateHUD(0, 0, 0);
    els.hudHeadStatus.textContent = 'Idle at start position';
    updateMovementChart();
  }

  function stepSimulation() {
    if (state.currentStepIndex < state.activePath.length) {
      const step = state.activePath[state.currentStepIndex];
      state.currentHeadPos = step.track;
      if (step.reqIdx !== null && step.reqIdx !== undefined) {
        state.servedSet.add(step.reqIdx);
      }
      state.trailHistory.push({ track: step.track, progress: 1.0 });
      state.currentStepIndex++;
      state.stepProgress = 0;

      // Calculate seek so far
      let seekSoFar = 0;
      let pos = state.headStart;
      for (let i = 0; i < state.currentStepIndex; i++) {
        seekSoFar += Math.abs(state.activePath[i].track - pos);
        pos = state.activePath[i].track;
      }
      updateHUD(state.currentHeadPos, state.servedSet.size, seekSoFar);
      updateMovementChart();
    }
  }

  function updateHUD(headTrack, servedCount, totalSeek) {
    els.hudCurrentTrack.textContent = Math.round(headTrack);
    els.hudServedCount.textContent = servedCount;
    els.hudReqTotal.textContent = state.requests.length;

    const pct = Math.min(100, Math.round((servedCount / (state.requests.length || 1)) * 100));
    els.hudProgressBarFill.style.width = pct + '%';

    els.hudSeekDist.textContent = totalSeek;

    // Fairness live counter
    if (state.algoName === 'FCFS') {
      els.hudOvertakeStat.textContent = '0';
      els.hudFairnessCaption.textContent = 'FCFS: strictly 0 (Zero starvation)';
    } else {
      els.hudOvertakeStat.textContent = state.activeMetrics.maxOvertaking;
      els.hudFairnessCaption.textContent = `Max overtakings: ${state.activeMetrics.maxOvertaking} reqs`;
    }
  }

  // --- Main Animation Render Loop (requestAnimationFrame) ---
  function renderLoop(timestamp) {
    if (!state.lastTimestamp) state.lastTimestamp = timestamp;
    const deltaMs = Math.min(64, timestamp - state.lastTimestamp);
    state.lastTimestamp = timestamp;

    // Advance single visualizer if playing
    if (state.isPlaying && state.activePath.length > 0) {
      if (state.currentStepIndex < state.activePath.length) {
        const currentTarget = state.activePath[state.currentStepIndex];
        const prevTrack = state.currentStepIndex === 0
          ? state.headStart
          : state.activePath[state.currentStepIndex - 1].track;

        // Speed calculation: steps per second
        const stepRate = 2.0 * state.speed; 
        state.stepProgress += (deltaMs / 1000) * stepRate;

        if (state.stepProgress >= 1.0) {
          // Reached step target
          state.stepProgress = 1.0;
          state.currentHeadPos = currentTarget.track;
          if (currentTarget.reqIdx !== null && currentTarget.reqIdx !== undefined) {
            state.servedSet.add(currentTarget.reqIdx);
          }
          state.trailHistory.push({ track: currentTarget.track, progress: 1.0 });

          state.currentStepIndex++;
          state.stepProgress = 0;

          if (state.currentStepIndex >= state.activePath.length) {
            pauseSimulation();
            els.hudHeadStatus.textContent = 'Completed all requests!';
          }
        } else {
          // Smooth interpolation
          state.currentHeadPos = prevTrack + (currentTarget.track - prevTrack) * state.stepProgress;
        }

        // Calculate live seek distance
        let liveSeek = 0;
        let pos = state.headStart;
        for (let i = 0; i < state.currentStepIndex; i++) {
          liveSeek += Math.abs(state.activePath[i].track - pos);
          pos = state.activePath[i].track;
        }
        if (state.currentStepIndex < state.activePath.length) {
          const curTargetTrack = state.activePath[state.currentStepIndex].track;
          const fromTrack = state.currentStepIndex === 0 ? state.headStart : state.activePath[state.currentStepIndex - 1].track;
          liveSeek += Math.round(Math.abs(curTargetTrack - fromTrack) * state.stepProgress);
        }

        updateHUD(state.currentHeadPos, state.servedSet.size, liveSeek);
        updateMovementChart();
      }
    }

    // Advance race if active
    if (state.raceActive) {
      advanceRace(deltaMs);
    }

    // Render Canvas
    drawDiskCanvas();
    drawRaceCanvases();

    requestAnimationFrame(renderLoop);
  }

  // --- Canvas Drawing: Primary Visualizer ---
  function drawDiskCanvas() {
    const canvas = els.diskCanvas;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = 230;

    ctx.clearRect(0, 0, w, h);

    const padX = 40;
    const trackWidth = w - padX * 2;
    const trackY = 120;
    const diskSize = state.diskSize;

    function trackToX(t) {
      return padX + (t / (diskSize - 1)) * trackWidth;
    }

    // 1. Background Grid & Track Cylinder Scale
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    const gridStep = Math.max(10, Math.round(diskSize / 10));
    for (let t = 0; t < diskSize; t += gridStep) {
      const gx = trackToX(t);
      ctx.beginPath();
      ctx.moveTo(gx, 40);
      ctx.lineTo(gx, 200);
      ctx.stroke();

      // Tick marks
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(gx, trackY - 12);
      ctx.lineTo(gx, trackY + 12);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(t, gx, trackY + 28);
    }

    // 2. Physical Track Bar
    const gradTrack = ctx.createLinearGradient(padX, 0, padX + trackWidth, 0);
    gradTrack.addColorStop(0, '#0284c7');
    gradTrack.addColorStop(0.5, '#3b82f6');
    gradTrack.addColorStop(1, '#8b5cf6');

    ctx.fillStyle = 'rgba(30, 41, 59, 0.8)';
    ctx.beginPath();
    ctx.roundRect(padX - 8, trackY - 8, trackWidth + 16, 16, 8);
    ctx.fill();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 3. Draw Travel Trail
    if (state.trailHistory.length > 0) {
      ctx.beginPath();
      const firstX = trackToX(state.trailHistory[0].track);
      ctx.moveTo(firstX, trackY);
      for (let i = 1; i < state.trailHistory.length; i++) {
        const tx = trackToX(state.trailHistory[i].track);
        ctx.lineTo(tx, trackY);
      }
      ctx.lineTo(trackToX(state.currentHeadPos), trackY);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // Special moves animation: Boundary travel (SCAN) & Return Jump (C-SCAN)
    if (state.currentStepIndex < state.activePath.length) {
      const curStep = state.activePath[state.currentStepIndex];
      const prevTrack = state.currentStepIndex === 0
        ? state.headStart
        : state.activePath[state.currentStepIndex - 1].track;

      if (curStep.isBoundary) {
        // SCAN sweep to D-1
        ctx.save();
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(trackToX(prevTrack), trackY);
        ctx.lineTo(trackToX(state.currentHeadPos), trackY);
        ctx.stroke();
        ctx.restore();
      } else if (curStep.isJump) {
        // C-SCAN jump to 0 (curved arc)
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const startX = trackToX(prevTrack);
        const endX = trackToX(state.currentHeadPos);
        const midX = (startX + endX) / 2;
        ctx.moveTo(startX, trackY);
        ctx.quadraticCurveTo(midX, trackY - 50, endX, trackY);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 4. Request Dots
    const reqs = state.requests;
    const overtakings = state.activeMetrics ? state.activeMetrics.overtakings : [];
    const maxOvertake = state.activeMetrics ? state.activeMetrics.maxOvertaking : 0;

    for (let i = 0; i < reqs.length; i++) {
      const track = reqs[i];
      const rx = trackToX(track);
      const isServed = state.servedSet.has(i);
      const isStarved = maxOvertake > 10 && overtakings[i] >= maxOvertake * 0.75;

      ctx.save();
      ctx.beginPath();
      ctx.arc(rx, trackY, 5, 0, Math.PI * 2);

      if (isServed) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.5)';
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 4;
        ctx.fill();
      } else if (isStarved) {
        // Highlight starved request in red with soft pulse
        ctx.fillStyle = '#f43f5e';
        ctx.shadowColor = '#f43f5e';
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      } else {
        ctx.fillStyle = '#38bdf8';
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 8;
        ctx.fill();
      }
      ctx.restore();
    }

    // 5. Disk Head Icon & Actuator
    const headX = trackToX(state.currentHeadPos);

    // Glowing vertical actuator pointer
    const gradBeam = ctx.createLinearGradient(headX, 40, headX, trackY + 40);
    gradBeam.addColorStop(0, 'rgba(56, 189, 248, 0)');
    gradBeam.addColorStop(0.5, 'rgba(56, 189, 248, 0.7)');
    gradBeam.addColorStop(1, 'rgba(56, 189, 248, 0)');

    ctx.strokeStyle = gradBeam;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(headX, 45);
    ctx.lineTo(headX, trackY + 45);
    ctx.stroke();

    // Actuator Head Housing
    ctx.save();
    ctx.translate(headX, trackY);

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 16;
    ctx.fill();

    // Solid inner core
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Head Position Tag Badge
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-24, -38, 48, 20, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`T:${Math.round(state.currentHeadPos)}`, 0, -24);

    ctx.restore();
  }

  // --- Canvas Hover Tooltip ---
  function handleCanvasHover(e) {
    const rect = els.diskCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const padX = 40;
    const trackWidth = rect.width - padX * 2;
    const diskSize = state.diskSize;

    function trackToX(t) {
      return padX + (t / (diskSize - 1)) * trackWidth;
    }

    const reqs = state.requests;
    let closestIdx = -1;
    let minDist = 18;

    for (let i = 0; i < reqs.length; i++) {
      const rx = trackToX(reqs[i]);
      const ry = 120;
      const d = Math.hypot(mouseX - rx, mouseY - ry);
      if (d < minDist) {
        minDist = d;
        closestIdx = i;
      }
    }

    if (closestIdx !== -1) {
      const reqTrack = reqs[closestIdx];
      const isServed = state.servedSet.has(closestIdx);
      const overtakes = state.activeMetrics ? state.activeMetrics.overtakings[closestIdx] : 0;

      els.canvasTooltip.style.display = 'block';
      els.canvasTooltip.style.left = `${mouseX}px`;
      els.canvasTooltip.style.top = `${mouseY}px`;
      els.canvasTooltip.innerHTML = `
        <div style="font-weight:700; color:#38bdf8; margin-bottom:2px;">Request #${closestIdx}</div>
        <div>Track: <strong>${reqTrack}</strong></div>
        <div>Status: <span style="color:${isServed ? '#10b981' : '#60a5fa'}">${isServed ? 'Served' : 'Pending'}</span></div>
        <div>Overtaken: <strong style="color:${overtakes > 0 ? '#f43f5e' : '#cbd5e1'}">${overtakes}</strong> times</div>
      `;
    } else {
      els.canvasTooltip.style.display = 'none';
    }
  }

  // --- Progressive Head Movement Line Chart (Chart.js) ---
  function initCharts() {
    // 1. Head Movement Chart
    const ctxMove = els.movementChart.getContext('2d');
    chartMovementInstance = new Chart(ctxMove, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Head Track Position',
          data: [],
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.08)',
          fill: true,
          tension: 0.1,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#38bdf8',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            title: { display: true, text: 'Seek Step', color: '#94a3b8' },
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#64748b', font: { family: 'JetBrains Mono' } }
          },
          y: {
            min: 0,
            max: state.diskSize - 1,
            title: { display: true, text: 'Track #', color: '#94a3b8' },
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#64748b', font: { family: 'JetBrains Mono' } }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });

    // 2. Total Seek Bar Chart
    const ctxSeek = els.seekChartCanvas.getContext('2d');
    chartSeekInstance = new Chart(ctxSeek, {
      type: 'bar',
      data: {
        labels: ['FCFS', 'SSTF', 'SCAN', 'C-SCAN'],
        datasets: [{
          label: 'Total Seek Distance (tracks)',
          data: [0, 0, 0, 0],
          backgroundColor: [
            'rgba(148, 163, 184, 0.8)',
            'rgba(56, 189, 248, 0.85)',
            'rgba(168, 85, 247, 0.85)',
            'rgba(245, 158, 11, 0.85)'
          ],
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#cbd5e1', font: { family: 'JetBrains Mono', weight: 'bold' } }
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono' } }
          }
        }
      }
    });

    // 3. Max Overtaking Bar Chart
    const ctxOvertake = els.overtakeChartCanvas.getContext('2d');
    chartOvertakeInstance = new Chart(ctxOvertake, {
      type: 'bar',
      data: {
        labels: ['FCFS', 'SSTF', 'SCAN', 'C-SCAN'],
        datasets: [{
          label: 'Max Overtaking (Starvation)',
          data: [0, 0, 0, 0],
          backgroundColor: [
            'rgba(16, 185, 129, 0.85)', // FCFS always 0 (green)
            'rgba(244, 63, 94, 0.85)',  // SSTF (red)
            'rgba(168, 85, 247, 0.85)', // SCAN (purple)
            'rgba(245, 158, 11, 0.85)'  // C-SCAN (amber)
          ],
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#cbd5e1', font: { family: 'JetBrains Mono', weight: 'bold' } }
          },
          y: {
            min: 0,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono' } }
          }
        }
      }
    });
  }

  function updateMovementChart() {
    if (!chartMovementInstance) return;

    chartMovementInstance.options.scales.y.max = state.diskSize - 1;

    // Show progressive plot up to current step
    const stepsToShow = state.activePath.slice(0, state.currentStepIndex + 1);
    const labels = [0];
    const dataPoints = [state.headStart];

    stepsToShow.forEach((step, idx) => {
      labels.push(idx + 1);
      dataPoints.push(step.track);
    });

    chartMovementInstance.data.labels = labels;
    chartMovementInstance.data.datasets[0].data = dataPoints;
    chartMovementInstance.update();

    els.chartStepCounter.textContent = `Step ${state.currentStepIndex} of ${state.activePath.length}`;
  }

  // --- Algorithm Race Mode ---
  function startRace() {
    resetRace();
    state.raceActive = true;
    els.btnStartRace.innerHTML = `
      <div class="spinner" style="width:14px; height:14px; border-width:2px;"></div>
      <span>Race in Progress...</span>
    `;
    els.raceBanner.classList.add('hidden');
  }

  function resetRace() {
    state.raceActive = false;
    els.btnStartRace.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      <span>Start Algorithm Race</span>
    `;
    els.raceBanner.classList.add('hidden');

    ALGOS.forEach(algo => {
      state.raceProgress[algo] = {
        stepIndex: 0,
        subProgress: 0,
        head: state.headStart,
        seek: 0,
        served: 0,
        finished: false,
        finishTime: null
      };
      els.raceLanes[algo].seek.textContent = '0';
      els.raceLanes[algo].served.textContent = `0/${state.requests.length}`;
      els.raceLanes[algo].rank.textContent = '-';
      els.raceLanes[algo].rank.className = 'lane-rank-badge';
    });
  }

  function advanceRace(deltaMs) {
    const raceSpeed = 2.4 * state.speed;
    let allFinished = true;

    ALGOS.forEach(algo => {
      const p = state.racePaths[algo];
      const prog = state.raceProgress[algo];

      if (!prog.finished) {
        allFinished = false;
        prog.subProgress += (deltaMs / 1000) * raceSpeed;

        if (prog.stepIndex < p.length) {
          const curTarget = p[prog.stepIndex];
          const prevTrack = prog.stepIndex === 0 ? state.headStart : p[prog.stepIndex - 1].track;

          if (prog.subProgress >= 1.0) {
            prog.subProgress = 0;
            prog.head = curTarget.track;
            if (curTarget.reqIdx !== null && curTarget.reqIdx !== undefined) {
              prog.served++;
            }
            prog.seek += Math.abs(curTarget.track - prevTrack);
            prog.stepIndex++;

            if (prog.stepIndex >= p.length) {
              prog.finished = true;
              prog.finishTime = performance.now();
            }
          } else {
            prog.head = prevTrack + (curTarget.track - prevTrack) * prog.subProgress;
          }
        } else {
          prog.finished = true;
          prog.finishTime = performance.now();
        }

        els.raceLanes[algo].seek.textContent = Math.round(prog.seek);
        els.raceLanes[algo].served.textContent = `${prog.served}/${state.requests.length}`;
      }
    });

    if (allFinished) {
      state.raceActive = false;
      els.btnStartRace.innerHTML = `<span>Race Finished</span>`;
      rankRaceWinners();
    }
  }

  function rankRaceWinners() {
    // Rank by total seek distance (OS throughput benchmark)
    const sorted = [...ALGOS].sort((a, b) => {
      return state.raceProgress[a].seek - state.raceProgress[b].seek;
    });

    const rankClasses = ['rank-gold', 'rank-silver', 'rank-bronze', ''];
    sorted.forEach((algo, idx) => {
      const badge = els.raceLanes[algo].rank;
      badge.textContent = `#${idx + 1}`;
      badge.className = `lane-rank-badge ${rankClasses[idx] || ''}`;
    });

    const winner = sorted[0];
    els.raceWinnerTitle.textContent = `${winner} Achieved Lowest Seek Distance (${Math.round(state.raceProgress[winner].seek)} tracks)!`;
    if (winner === 'SSTF') {
      els.raceWinnerDesc.textContent = 'SSTF dominated raw physical seek distance, but review the fairness table to observe its severe starvation impact on distant requests.';
    } else if (winner === 'SCAN' || winner === 'C-SCAN') {
      els.raceWinnerDesc.textContent = `${winner} provided high mechanical efficiency while maintaining bounded latency guarantees.`;
    } else {
      els.raceWinnerDesc.textContent = 'FCFS served requests in arrival sequence with zero overtaking, but incurred higher seek distance.';
    }
    els.raceBanner.classList.remove('hidden');
  }

  // --- Canvas Drawing: 4 Mini Race Lanes ---
  function drawRaceCanvases() {
    const padX = 20;
    const diskSize = state.diskSize;

    ALGOS.forEach(algo => {
      const canvas = els.raceLanes[algo].canvas;
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = 52;

      ctx.clearRect(0, 0, w, h);

      const trackWidth = w - padX * 2;
      const trackY = 26;

      function trackToX(t) {
        return padX + (t / (diskSize - 1)) * trackWidth;
      }

      // Track slot
      ctx.fillStyle = 'rgba(30, 41, 59, 0.6)';
      ctx.beginPath();
      ctx.roundRect(padX - 4, trackY - 4, trackWidth + 8, 8, 4);
      ctx.fill();

      // Requests
      const reqs = state.requests;
      const path = state.racePaths[algo];
      const prog = state.raceProgress[algo];

      // Set of served request indices for this algorithm
      const servedSet = new Set();
      for (let s = 0; s < prog.stepIndex; s++) {
        if (path[s] && path[s].reqIdx !== null && path[s].reqIdx !== undefined) {
          servedSet.add(path[s].reqIdx);
        }
      }

      for (let i = 0; i < reqs.length; i++) {
        const rx = trackToX(reqs[i]);
        ctx.beginPath();
        ctx.arc(rx, trackY, 3, 0, Math.PI * 2);
        if (servedSet.has(i)) {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.4)';
        } else {
          ctx.fillStyle = '#64748b';
        }
        ctx.fill();
      }

      // Head indicator
      const hx = trackToX(prog.head);
      ctx.beginPath();
      ctx.arc(hx, trackY, 7, 0, Math.PI * 2);
      if (algo === 'FCFS') ctx.fillStyle = '#cbd5e1';
      else if (algo === 'SSTF') ctx.fillStyle = '#38bdf8';
      else if (algo === 'SCAN') ctx.fillStyle = '#a855f7';
      else ctx.fillStyle = '#f59e0b';
      ctx.fill();

      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  // --- Results Table & Chart Updates ---
  function updateResultsSection() {
    const metricsData = state.isAveraged ? state.averagedMetrics : state.raceResults;

    // Find best values (minimum) for each column
    const minSeek = Math.min(...ALGOS.map(a => metricsData[a].totalSeek));
    const minWait = Math.min(...ALGOS.map(a => metricsData[a].avgWait));
    const minMaxOvertake = Math.min(...ALGOS.map(a => metricsData[a].maxOvertaking));
    const minAvgOvertake = Math.min(...ALGOS.map(a => metricsData[a].avgOvertaking));

    let html = '';
    ALGOS.forEach(algo => {
      const m = metricsData[algo];
      const isBestSeek = Math.abs(m.totalSeek - minSeek) < 0.1;
      const isBestWait = Math.abs(m.avgWait - minWait) < 0.1;
      const isBestMaxOver = Math.abs(m.maxOvertaking - minMaxOvertake) < 0.1;
      const isBestAvgOver = Math.abs(m.avgOvertaking - minAvgOvertake) < 0.1;

      let verdict = '';
      if (algo === 'FCFS') verdict = '100% Fair (No starvation), Poor Seek Latency';
      else if (algo === 'SSTF') verdict = 'Minimal Seek, High Starvation Risk';
      else if (algo === 'SCAN') verdict = 'Balanced Seek & Bounded Starvation';
      else verdict = 'Predictable Bounded Wait, Uniform Latency';

      html += `
        <tr>
          <td><strong style="color:#fff;">${algo}</strong></td>
          <td class="${isBestSeek ? 'table-best-val' : ''}">${m.totalSeek.toFixed(1)}</td>
          <td class="${isBestWait ? 'table-best-val' : ''}">${m.avgWait.toFixed(1)}</td>
          <td class="${isBestMaxOver ? 'table-best-val' : ''}">${m.maxOvertaking.toFixed(1)}</td>
          <td class="${isBestAvgOver ? 'table-best-val' : ''}">${m.avgOvertaking.toFixed(1)}</td>
          <td style="font-family:inherit; font-size:0.84rem; color:#94a3b8;">${verdict}</td>
        </tr>
      `;
    });

    els.metricsTableBody.innerHTML = html;

    // Update Comparison Bar Charts
    if (chartSeekInstance && chartOvertakeInstance) {
      chartSeekInstance.data.datasets[0].data = ALGOS.map(a => metricsData[a].totalSeek);
      chartSeekInstance.update();

      chartOvertakeInstance.data.datasets[0].data = ALGOS.map(a => metricsData[a].maxOvertaking);
      chartOvertakeInstance.update();
    }
  }

  // --- Monte Carlo 20 Experiments Simulation ---
  function runMonteCarlo20() {
    els.monteCarloStatus.classList.remove('hidden');
    els.mcStatusText.textContent = `Simulating 20 independent ${state.workloadKind} workloads...`;

    setTimeout(() => {
      const N_RUNS = 20;
      const accumulated = {
        FCFS: { totalSeek: 0, avgWait: 0, maxOvertaking: 0, avgOvertaking: 0 },
        SSTF: { totalSeek: 0, avgWait: 0, maxOvertaking: 0, avgOvertaking: 0 },
        SCAN: { totalSeek: 0, avgWait: 0, maxOvertaking: 0, avgOvertaking: 0 },
        'C-SCAN': { totalSeek: 0, avgWait: 0, maxOvertaking: 0, avgOvertaking: 0 }
      };

      for (let run = 0; run < N_RUNS; run++) {
        const testReqs = generateWorkload(state.workloadKind, state.reqCount, state.diskSize);
        const testHead = Math.floor(Math.random() * state.diskSize);

        ALGOS.forEach(algo => {
          const path = getAlgorithmPath(algo, testReqs, testHead, state.diskSize);
          const ev = evaluate(path, testHead, testReqs.length);
          accumulated[algo].totalSeek += ev.totalSeek / N_RUNS;
          accumulated[algo].avgWait += ev.avgWait / N_RUNS;
          accumulated[algo].maxOvertaking += ev.maxOvertaking / N_RUNS;
          accumulated[algo].avgOvertaking += ev.avgOvertaking / N_RUNS;
        });
      }

      state.isAveraged = true;
      state.averagedMetrics = accumulated;

      els.monteCarloStatus.classList.remove('hidden');
      els.mcStatusText.textContent = `Completed 20 Monte Carlo runs! Results below reflect averaged metrics.`;

      updateResultsSection();
    }, 60);
  }

  // --- Fairness & Starvation Demo Section ---
  function updateFairnessSection() {
    const sstfMetrics = state.raceResults.SSTF;
    if (!sstfMetrics) return;

    const overtakings = sstfMetrics.overtakings;
    const reqs = state.requests;

    // Create ranked list of requests by overtaking count
    const ranked = reqs.map((track, idx) => ({
      reqIdx: idx,
      track,
      overtakes: overtakings[idx] || 0
    })).sort((a, b) => b.overtakes - a.overtakes);

    const maxOvertake = sstfMetrics.maxOvertaking;
    const threshold = Math.max(5, maxOvertake * 0.7);

    let pillsHtml = '';
    ranked.forEach(item => {
      const isSevere = item.overtakes >= threshold && item.overtakes > 0;
      pillsHtml += `
        <div class="req-pill ${isSevere ? 'pill-starved' : ''}" 
             title="Request #${item.reqIdx} at Track ${item.track} was passed over ${item.overtakes} times by newer queries">
          <span>Req #${item.reqIdx} (T:${item.track})</span>
          <span class="pill-overtake-count">${item.overtakes}x overtaken</span>
        </div>
      `;
    });

    els.starvedPillsContainer.innerHTML = pillsHtml;

    // Explanatory callout text
    if (ranked.length > 0 && ranked[0].overtakes > 0) {
      const worst = ranked[0];
      els.starvationTitle.textContent = `Worst Starvation Detected: Request #${worst.reqIdx} at Track ${worst.track}`;
      els.starvationExplanation.textContent = `
        Under ${state.workloadKind} workload, Request #${worst.reqIdx} arrived early at track ${worst.track}, 
        but was passed over ${worst.overtakes} times by newer requests because SSTF greedily lingered around nearby cylinder clusters. 
        In production database workloads, this causes high tail latency (p99/p99.9) for cold table lookups.
      `;
    } else {
      els.starvationTitle.textContent = `No Starvation Detected`;
      els.starvationExplanation.textContent = `All requests were served near arrival order.`;
    }
  }

  // --- Launch on DOM Ready ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
