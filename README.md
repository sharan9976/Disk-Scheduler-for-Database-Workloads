# Disk Scheduler for Database Workloads

An interactive, animated single-page simulator comparing operating system disk scheduling algorithms (**FCFS**, **SSTF**, **SCAN**, and **C-SCAN**) under modern database workloads.

---

## 🚀 How to Run

1. **No installations required** (pure HTML5, CSS3, and Vanilla JavaScript).
2. Simply double-click [`index.html`](file:///d:/os/index.html) to open it in Google Chrome, Microsoft Edge, Firefox, or any modern web browser.
3. (Optional) Alternatively, serve using any lightweight static server:
   ```powershell
   # Python 3
   py -3 -m http.server 8080
   # Then visit http://localhost:8080 in your browser
   ```

---

## 🎯 Features

### 1. Interactive Animated Disk Visualizer
- **60 FPS Canvas Engine**: Smoothly renders cylinder tracks, glowing pending requests, and sliding actuator read/write head.
- **Color-Coded Statuses**:
  - 🔵 **Cyan**: Actuator Head & Pending Requests
  - 🟢 **Emerald**: Serviced Requests
  - 🟣 **Purple**: SCAN trip to the disk boundary (`D - 1`)
  - 🟠 **Amber**: C-SCAN rapid return jump back to track `0`
  - 🔴 **Coral Red**: Starved / highly overtaken requests
- **Live HUD Counters**: Current cylinder track, requests serviced count, accumulated seek distance, and active starvation stats.
- **Interactive Tooltip**: Hover over any request dot on the track bar to inspect its Arrival Index, Cylinder Track, and Overtaking count.

### 2. Multi-Algorithm Race Mode ("Race All 4")
- Animates **FCFS**, **SSTF**, **SCAN**, and **C-SCAN** in 4 synchronized real-time race lanes executing the exact same request sequence.
- Live seek distance meters, requests serviced counters, and post-race podium rankings (Gold 🥇, Silver 🥈, Bronze 🥉).

### 3. Head Movement Trajectory Chart
- Progressive line chart (powered by Chart.js) plotting **Track Position vs. Seek Step** in real-time as the disk head navigates cylinders.

### 4. Database Workload Models
- **Hotspot (80/20 DB Index Lookups)**: 80% of reads hit 3 small 20-track zones (mimicking B-tree root blocks and active database buffer pool pages), while 20% are uniform random.
- **Random (OLTP Transactions)**: Uniform distributed read requests across all cylinders.
- **Sequential (Table / WAL Scans)**: Consecutive cylinder tracks starting from a random point and wrapping around (mimicking Write-Ahead Logging or bulk table scans).

### 5. Rigorous Fairness & Overtaking Analysis
- **Zero-Overtaking Guarantee**: In FCFS, requests are processed strictly in arrival order, ensuring max and average overtaking are always exactly **0**.
- **Starvation Detection**: For SSTF, SCAN, and C-SCAN, detects requests that arrived early but were passed over by newer queries because the scheduler greedily lingered in nearby cylinder hotspots.
- **Interactive Starvation Inspector**: Click/hover on request pills to identify severely starved requests and see why they occurred.

### 6. Monte Carlo Benchmark ("Run 20 Experiments & Average")
- Generates 20 independent workloads with randomized starting head positions.
- Averages total seek, mean wait time, max overtaking, and average overtaking across all 20 runs.
- Highlights the best value in each column with a green `★ Best` indicator.

---

## 📊 Summary of Algorithms

| Algorithm | Seek Distance | Fairness / Starvation | Ideal Database Scenario |
| :--- | :--- | :--- | :--- |
| **FCFS** | Very High (Thrashing) | **100% Fair (0 Overtaking)** | Dedicated append-only Write-Ahead Log (WAL) streams |
| **SSTF** | **Lowest** | **Severe Starvation** | Synthetic raw IOPS benchmarks (unsafe for mixed queries) |
| **SCAN** | Low | Bounded Starvation (2 sweeps) | Mixed OLTP read queries + bulk table scans |
| **C-SCAN**| Moderate-Low | **Most Uniform Wait Distribution** | Multi-tenant clusters needing tight tail latency (p99/p99.9 SLAs) |

---

## 🛠 File Structure
- [`index.html`](file:///d:/os/index.html) - Main semantic layout, hero section, canvas containers, and controls.
- [`style.css`](file:///d:/os/style.css) - Modern dark UI, glassmorphism card surfaces, gradients, and responsive styles.
- [`script.js`](file:///d:/os/script.js) - Workload generators, scheduling algorithms, canvas animation loop, Chart.js integrations.
