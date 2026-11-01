import random
import statistics
import matplotlib.pyplot as plt

DISK = 200       # tracks 0..199
N_REQ = 100      # requests per run
RUNS = 20        # runs to average

# ---------- workload generator ----------
def generate(kind, n=N_REQ, disk=DISK):
    if kind == "random":
        return [random.randint(0, disk - 1) for _ in range(n)]
    if kind == "sequential":
        start = random.randint(0, disk // 2)
        return [(start + i) % disk for i in range(n)]
    if kind == "hotspot":  # 80% of requests in 3 small zones (like index lookups)
        zones = [random.randint(0, disk - 20) for _ in range(3)]
        reqs = []
        for _ in range(n):
            if random.random() < 0.8:
                z = random.choice(zones)
                reqs.append(z + random.randint(0, 19))
            else:
                reqs.append(random.randint(0, disk - 1))
        return reqs

# ---------- algorithms (return path of (track, is_request)) ----------
def fcfs(reqs, head, disk=DISK):
    return [(r, True) for r in reqs]

def sstf(reqs, head, disk=DISK):
    pending, path, pos = list(reqs), [], head
    while pending:
        nxt = min(pending, key=lambda r: abs(r - pos))
        pending.remove(nxt)
        path.append((nxt, True))
        pos = nxt
    return path

def scan(reqs, head, disk=DISK):
    up = sorted(r for r in reqs if r >= head)
    down = sorted((r for r in reqs if r < head), reverse=True)
    path = [(r, True) for r in up]
    if down:
        path.append((disk - 1, False))   # go to the end, then reverse
        path += [(r, True) for r in down]
    return path

def cscan(reqs, head, disk=DISK):
    up = sorted(r for r in reqs if r >= head)
    low = sorted(r for r in reqs if r < head)
    path = [(r, True) for r in up]
    if low:
        path += [(disk - 1, False), (0, False)]  # go to end, jump to start
        path += [(r, True) for r in low]
    return path

ALGOS = {"FCFS": fcfs, "SSTF": sstf, "SCAN": scan, "C-SCAN": cscan}

# ---------- metrics ----------
def evaluate(path, head):
    total, pos, waits = 0, head, []
    for track, is_req in path:
        total += abs(track - pos)
        pos = track
        if is_req:
            waits.append(total)   # wait = head movement before this request is served
    return total, max(waits), statistics.pstdev(waits)

# ---------- experiment ----------
KINDS = ["random", "sequential", "hotspot"]
results = {k: {a: [0, 0, 0] for a in ALGOS} for k in KINDS}

for kind in KINDS:
    for _ in range(RUNS):
        reqs = generate(kind)
        head = random.randint(0, DISK - 1)
        for name, fn in ALGOS.items():
            seek, maxw, sd = evaluate(fn(reqs, head), head)
            results[kind][name][0] += seek / RUNS
            results[kind][name][1] += maxw / RUNS
            results[kind][name][2] += sd / RUNS

# ---------- print table ----------
for kind in KINDS:
    print(f"\n=== {kind.upper()} workload ===")
    print(f"{'Algo':8}{'Total seek':>12}{'Max wait':>12}{'Wait StdDev':>14}")
    for name, (s, m, sd) in results[kind].items():
        print(f"{name:8}{s:12.1f}{m:12.1f}{sd:14.1f}")

# ---------- graphs ----------
fig, axes = plt.subplots(2, 3, figsize=(14, 7))
for col, kind in enumerate(KINDS):
    names = list(ALGOS)
    axes[0][col].bar(names, [results[kind][n][0] for n in names], color="steelblue")
    axes[0][col].set_title(f"{kind}: total seek distance")
    axes[1][col].bar(names, [results[kind][n][1] for n in names], color="indianred")
    axes[1][col].set_title(f"{kind}: max wait (fairness)")
plt.tight_layout()
plt.savefig("results.png")
plt.show()