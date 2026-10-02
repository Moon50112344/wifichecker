/**
 * AetherDroid — Frontend Router & UI Controller
 * Real streaming: WebRTC video via RTCPeerConnection to the Runtime Host.
 * Real APK pipeline: multipart upload → host adb install → real package names.
 */

import {
  onInput,
  onHardwareKey,
  emitKeyboard,
  initInputHandler
} from './input-handler.js';

const API = {
  // IMPORTANT:
  // Runtime Host health is exposed by the Worker at /api/runtime-health.
  // Do NOT use the old /api/host-status endpoint.
  hostStatus: () => '/api/runtime-health',

  instances: () => '/api/instances',
  start: () => '/api/start',
  power: () => '/api/power',
  signal: () => '/api/signal',
  input: () => '/api/input',
  apks: () => '/api/apks',
  upload: (params) => `/api/apks/upload${params ? `?${params}` : ''}`,
  install: () => '/api/install',
  watchdog: () => '/api/watchdog',
};

const state = {
  view: 'dashboard',
  instances: [],
  apks: [],
  apksLoaded: false,
  activeSession: null,
  pendingAction: false,
  keyboardCapture: false,
  consoleOpen: false,
  hostOnline: false,
  pc: null,
  remoteStream: null,
  retryAttempt: 0,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data?.ok === false) {
    const err = new Error(
      data?.error ?? `Request failed (${res.status})`
    );

    err.hostOnline = data?.hostOnline;
    err.status = res.status;
    err.data = data;

    throw err;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const el = document.createElement('div');

  el.className =
    `toast ${type} px-4 py-3 rounded-xl text-sm text-slate-100 ` +
    `shadow-lg max-w-xs`;

  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('leaving');

    setTimeout(() => {
      el.remove();
    }, 300);
  }, 3200);
}

// ---------------------------------------------------------------------------
// ADB Console
// ---------------------------------------------------------------------------

function logConsole(message, type = 'info') {
  const out = $('console-output');
  if (!out) return;

  const line = document.createElement('div');

  line.className = `terminal-line terminal-line-${type}`;

  const ts = new Date().toLocaleTimeString();

  const escaped = String(message).replace(
    /[<>&]/g,
    (c) => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
    }[c])
  );

  line.innerHTML =
    `<span class="terminal-ts">${ts}</span> ` +
    `<span class="terminal-prompt">$</span> ${escaped}`;

  out.appendChild(line);

  while (out.children.length > 80) {
    out.removeChild(out.firstChild);
  }

  out.scrollTop = out.scrollHeight;
}

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

function setLoading(on) {
  const overlay = $('loading-overlay');
  if (!overlay) return;

  overlay.classList.toggle('hidden', !on);
}

function setBtnLoading(btn, on) {
  if (!btn) return;

  btn.disabled = on;
  btn.classList.toggle('opacity-60', on);
  btn.classList.toggle('cursor-wait', on);
}

// Host-offline warn throttle
let lastHostWarnAt = 0;

// ---------------------------------------------------------------------------
// Host connection status
// ---------------------------------------------------------------------------

async function checkHostStatus(force = false) {
  try {
    const data = await api(API.hostStatus());

    /*
     * Worker /api/runtime-health returns:
     *
     * {
     *   ok: true,
     *   runtime: {
     *     ok: true,
     *     host: "...",
     *     ...
     *   },
     *   status: 200
     * }
     *
     * The old frontend expected:
     *
     * data.hostOnline
     *
     * which does not exist in the new response.
     */

    const runtimeOnline =
      data?.runtime?.ok === true ||
      data?.ok === true;

    setHostOnline(runtimeOnline);

    return runtimeOnline;
  } catch (err) {
    console.warn(
      '[checkHostStatus] failed:',
      err?.message ?? err
    );

    /*
     * Only mark offline when the actual health request fails.
     *
     * Do not treat missing data.hostOnline as offline.
     */
    setHostOnline(false);

    return false;
  }
}

function setHostOnline(online) {
  const normalized = online === true;
  const changed = normalized !== state.hostOnline;

  state.hostOnline = normalized;

  const banner = $('host-banner');

  banner?.classList.toggle('hidden', normalized);

  // Disable provisioning when host is offline
  const provisionBtn = $('provision-btn');

  if (provisionBtn) {
    provisionBtn.disabled = !normalized;
    provisionBtn.title = normalized
      ? ''
      : 'Requires a connected Runtime Host';
  }

  if (changed) {
    if (normalized) {
      toast('Runtime Host connected', 'success');
    } else {
      toast(
        'Runtime Host offline — streaming disabled',
        'error'
      );
    }
  }

  /*
   * Re-render instance cards because their Connect/Start
   * buttons depend on hostOnline.
   */
  if ($('instance-grid') && state.instances.length) {
    renderInstances();
  }

  /*
   * Repository install buttons also depend on hostOnline.
   */
  if ($('package-grid') && state.apks.length) {
    renderApks();
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const TITLES = {
  dashboard: 'Command Center',
  phone: 'Live View Terminal',
  repository: 'APK Repository',
};

function switchView(view) {
  if (!TITLES[view]) return;

  state.view = view;

  try {
    sessionStorage.setItem(
      'aetherdroid.view',
      view
    );
  } catch (_) {
    // non-fatal
  }

  document
    .querySelectorAll('.view')
    .forEach((v) => v.classList.add('hidden'));

  const target = $(`view-${view}`);

  if (target) {
    target.classList.remove('hidden');

    target.style.animation = 'none';

    void target.offsetHeight;

    target.style.animation = '';
  }

  document
    .querySelectorAll('.nav-btn')
    .forEach((btn) => {
      const active =
        btn.getAttribute('data-view') === view;

      btn.classList.toggle(
        'bg-blue-600/15',
        active
      );

      btn.classList.toggle(
        'text-blue-400',
        active
      );

      btn.classList.toggle(
        'text-slate-400',
        !active
      );
    });

  const title = $('page-title');

  if (title) {
    title.textContent = TITLES[view];
  }

  if (view === 'phone') {
    startStream();
  }

  if (view === 'repository') {
    fetchApks();
  }

  window.scrollTo({
    top: 0,
  });
}

// ---------------------------------------------------------------------------
// Dashboard: instance cards
// ---------------------------------------------------------------------------

const STATUS_STYLES = {
  online: {
    dot: 'bg-emerald-500',
    label: 'Online',
    text: 'text-emerald-400',
  },

  offline: {
    dot: 'bg-slate-500',
    label: 'Offline',
    text: 'text-slate-400',
  },

  booting: {
    dot: 'bg-amber-400 pulse-blue',
    label: 'Provisioning…',
    text: 'text-amber-400',
  },
};

function formatUptime(bootedAt, fallback) {
  if (!bootedAt) {
    return fallback ?? '0h';
  }

  const ms = new Date(bootedAt).getTime();

  if (Number.isNaN(ms)) {
    return fallback ?? '0h';
  }

  const secs = Math.max(
    0,
    Math.floor(
      (Date.now() - ms) / 1000
    )
  );

  const h = Math.floor(secs / 3600);
  const m = Math.floor(
    (secs % 3600) / 60
  );

  const d = Math.floor(h / 24);

  if (d > 0) {
    return `${d}d ${h % 24}h`;
  }

  if (h > 0) {
    return `${h}h ${m}m`;
  }

  return `${m}m`;
}

function refreshUptimes() {
  document
    .querySelectorAll('[data-booted-at]')
    .forEach((el) => {
      el.textContent = formatUptime(
        el.getAttribute('data-booted-at'),
        '—'
      );
    });
}

setInterval(
  refreshUptimes,
  30000
);

function renderStats() {
  const online =
    state.instances.filter(
      (i) => i.status === 'online'
    );

  const statInstances = $('stat-instances');
  const statCpu = $('stat-cpu');
  const statRam = $('stat-ram');

  if (statInstances) {
    statInstances.textContent =
      String(online.length);
  }

  if (statCpu) {
    statCpu.textContent =
      String(
        online.reduce(
          (s, i) => s + (i.cpu ?? 0),
          0
        )
      );
  }

  if (statRam) {
    statRam.textContent =
      String(
        online.reduce(
          (s, i) => s + (i.ram ?? 0),
          0
        )
      );
  }
}

function instanceCard(inst) {
  const s =
    STATUS_STYLES[inst.status] ??
    STATUS_STYLES.offline;

  const connectable =
    inst.status === 'online' &&
    state.hostOnline;

  return `
    <article
      class="glass-panel rounded-2xl p-6 flex flex-col gap-4"
      data-id="${inst.id}"
    >
      <div class="flex items-start justify-between">
        <div class="min-w-0">
          <h4 class="font-semibold text-slate-100 truncate">
            ${inst.name ?? 'Cloud Phone'}
          </h4>

          <p class="text-xs font-mono text-slate-500 mt-0.5">
            ${inst.id}
          </p>
        </div>

        <span class="flex items-center gap-2 text-xs font-medium ${s.text}">
          <span class="w-2 h-2 rounded-full ${s.dot}"></span>
          ${s.label}
        </span>
      </div>

      <div class="flex flex-wrap gap-4 text-xs text-slate-400">
        <span class="flex items-center gap-1.5">
          <svg
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <rect
              x="4"
              y="4"
              width="16"
              height="16"
              rx="2"
            />
            <path d="M9 4v16M4 9h16"/>
          </svg>

          ${inst.cpu ?? 0} vCPU
        </span>

        <span class="flex items-center gap-1.5">
          <svg
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <rect
              x="3"
              y="7"
              width="18"
              height="10"
              rx="2"
            />
            <circle
              cx="7"
              cy="12"
              r="1"
              fill="currentColor"
            />
          </svg>

          ${inst.ram ?? 0} GB
        </span>

        <span>
          Android ${inst.os ?? '—'}
        </span>

        <span>
          Uptime
          <span
            data-booted-at="${inst.bootedAt ?? ''}"
            class="text-slate-300 font-medium"
          >
            ${formatUptime(
              inst.bootedAt,
              inst.vRuntime
            )}
          </span>
        </span>
      </div>

      <div class="flex gap-2 mt-auto pt-2">
        <button
          class="connect-btn flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${
            connectable
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }"
          data-id="${inst.id}"
          ${connectable ? '' : 'disabled'}
          title="${
            connectable
              ? ''
              : state.hostOnline
                ? 'Instance offline'
                : 'Runtime Host offline'
          }"
        >
          ${
            inst.status === 'booting'
              ? 'Provisioning…'
              : connectable
                ? 'Connect'
                : 'Offline'
          }
        </button>

        <button
          class="power-btn px-3 py-2 rounded-lg text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${
            inst.status === 'offline'
              ? 'bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-400'
              : 'bg-red-600/15 hover:bg-red-600/25 text-red-400'
          }"
          data-id="${inst.id}"
          data-action="${
            inst.status === 'offline'
              ? 'start'
              : 'stop'
          }"
          aria-label="${
            inst.status === 'offline'
              ? 'Start instance'
              : 'Stop instance'
          }"
          ${state.hostOnline ? '' : 'disabled'}
        >
          ${
            inst.status === 'offline'
              ? 'Start'
              : 'Stop'
          }
        </button>
      </div>
    </article>
  `;
}

function renderInstances() {
  const grid = $('instance-grid');

  if (!grid) return;

  if (!state.instances.length) {
    grid.innerHTML = `
      <div class="glass-panel rounded-2xl p-10 text-center md:col-span-2 xl:col-span-3">
        <p class="text-slate-300 font-medium">
          No cloud phones yet
        </p>

        <p class="text-sm text-slate-500 mt-1">
          ${
            state.hostOnline
              ? 'Provision your first Android instance to get started.'
              : 'Runtime Host is offline — connect a host to provision phones.'
          }
        </p>
      </div>
    `;
  } else {
    grid.innerHTML =
      state.instances
        .map(instanceCard)
        .join('');
  }

  renderStats();
}

async function fetchInstances() {
  const grid = $('instance-grid');

  if (
    grid &&
    !state.instances.length
  ) {
    grid.innerHTML =
      Array.from({ length: 3 })
        .map(
          () =>
            '<div class="skeleton glass-panel rounded-2xl p-6 h-44"></div>'
        )
        .join('');
  }

  try {
    const data =
      await api(API.instances());

    state.instances =
      data.instances ?? [];

    /*
     * Keep compatibility with Worker responses that
     * include hostOnline.
     *
     * If hostOnline isn't present, don't overwrite the
     * result obtained from /api/runtime-health.
     */
    if (
      typeof data.hostOnline ===
      'boolean'
    ) {
      setHostOnline(
        data.hostOnline
      );
    }

    renderInstances();

    return state.instances;
  } catch (err) {
    console.error(
      '[fetchInstances] failed:',
      err?.message ?? err
    );

    /*
     * If the error explicitly says that the host is
     * offline, reflect that in the UI.
     */
    if (
      err?.hostOnline === false ||
      err?.status === 503
    ) {
      setHostOnline(false);
    }

    if (grid) {
      grid.innerHTML = `
        <div class="glass-panel rounded-2xl p-10 text-center md:col-span-2 xl:col-span-3">
          <p class="text-red-400 font-medium">
            Failed to load instances
          </p>

          <p class="text-sm text-slate-500 mt-1">
            ${err?.message ?? 'Unknown error'}
          </p>

          <button
            id="retry-load"
            class="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
          >
            Retry
          </button>
        </div>
      `;

      $('retry-load')
        ?.addEventListener(
          'click',
          fetchInstances
        );
    }

    toast(
      'Could not reach the Control Plane',
      'error'
    );

    return [];
  }
}

// ---------------------------------------------------------------------------
// Watchdog health widget
// ---------------------------------------------------------------------------

function healthCard(node) {
  const healthy =
    node.status === 'healthy';

  return `
    <div class="rounded-xl bg-slate-900/60 border border-slate-800 p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-slate-100 truncate">
            ${node.label}
          </p>

          <p class="text-[11px] text-slate-500 mt-0.5">
            ${node.cores} cores · ${node.instances} instance(s)
          </p>
        </div>

        <span
          class="flex items-center gap-1.5 text-[11px] font-medium ${
            healthy
              ? 'text-emerald-400'
              : 'text-amber-400'
          }"
        >
          <span
            class="status-indicator w-2 h-2 rounded-full ${
              healthy
                ? 'bg-emerald-500'
                : 'bg-amber-400 pulse-dot'
            }"
          ></span>

          ${healthy ? 'Healthy' : 'Degraded'}
        </span>
      </div>

      <div class="space-y-2.5">
        <div>
          <div class="flex justify-between text-[11px] text-slate-500 mb-1">
            <span>Load average</span>
            <span class="font-mono">
              ${Math.round(node.load * 100)}%
            </span>
          </div>

          <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              class="health-bar h-full rounded-full"
              style="width:${Math.round(node.load * 100)}%"
            ></div>
          </div>
        </div>

        <div>
          <div class="flex justify-between text-[11px] text-slate-500 mb-1">
            <span>Disk usage</span>
            <span class="font-mono">
              ${Math.round(node.disk * 100)}%
            </span>
          </div>

          <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              class="health-bar h-full rounded-full"
              style="width:${Math.round(node.disk * 100)}%"
            ></div>
          </div>
        </div>

        <p class="text-[11px] text-slate-500">
          Network:
          <span class="font-mono text-slate-300">
            ${node.netMbps} Mbps
          </span>
        </p>
      </div>
    </div>
  `;
}

async function fetchWatchdog() {
  try {
    const data =
      await api(API.watchdog());

    const grid = $('health-grid');

    if (
      grid &&
      data?.nodes
    ) {
      grid.innerHTML =
        data.nodes.length
          ? data.nodes
              .map(healthCard)
              .join('')
          : '<p class="text-sm text-slate-500 sm:col-span-2 lg:col-span-3">No Runtime Host connected — real node metrics unavailable.</p>';
    }

    const overall =
      data?.overall ?? 'down';

    const pct =
      data?.uptimePct ?? '--';

    const dot =
      $('health-badge-dot');

    const text =
      $('health-badge-text');

    const badgePct =
      $('health-badge-pct');

    const statUptime =
      $('stat-uptime');

    if (dot) {
      dot.className =
        `status-indicator w-2 h-2 rounded-full ${
          overall === 'operational'
            ? 'bg-emerald-500'
            : overall === 'down'
              ? 'bg-red-500'
              : 'bg-amber-400 pulse-dot'
        }`;
    }

    if (text) {
      text.textContent =
        overall === 'operational'
          ? 'Host healthy'
          : overall === 'down'
            ? 'Runtime Host offline'
            : 'Host degraded';
    }

    if (badgePct) {
      badgePct.textContent =
        `${pct}%`;
    }

    if (statUptime) {
      statUptime.textContent =
        `${pct}%`;
    }

    const ts =
      $('watchdog-timestamp');

    if (
      ts &&
      data?.watchdogLastRun
    ) {
      ts.textContent =
        `watchdog: ${new Date(
          data.watchdogLastRun
        ).toLocaleTimeString()}`;
    }

    /*
     * Watchdog is secondary to the actual Runtime Host
     * health endpoint.
     *
     * Do not mark the host offline solely because the
     * watchdog data says "down" if /api/runtime-health
     * already confirmed the Runtime Host is online.
     */
    if (
      overall === 'operational'
    ) {
      setHostOnline(true);
    }
  } catch (err) {
    console.warn(
      '[fetchWatchdog] failed:',
      err?.message ?? err
    );

    const dot =
      $('health-badge-dot');

    const text =
      $('health-badge-text');

    if (dot) {
      dot.className =
        'status-indicator w-2 h-2 rounded-full bg-red-500';
    }

    if (text) {
      text.textContent =
        'Watchdog unreachable';
    }
  }
}

// ---------------------------------------------------------------------------
// Provision & power
// ---------------------------------------------------------------------------

async function provision() {
  const btn =
    $('provision-btn');

  setBtnLoading(btn, true);
  setLoading(true);

  try {
    /*
     * Re-check the host immediately before provisioning.
     * This prevents provisioning while the host has gone
     * offline since the last 30-second health check.
     */
    const hostReady =
      await checkHostStatus(true);

    if (!hostReady) {
      throw Object.assign(
        new Error(
          'Runtime Host is not connected'
        ),
        {
          hostOnline: false,
          status: 503,
        }
      );
    }

    const data =
      await api(API.start(), {
        method: 'POST',
        body: JSON.stringify({
          name:
            `Cloud Phone ${
              state.instances.length + 1
            }`,
        }),
      });

    if (data?.instance) {
      const idx =
        state.instances.findIndex(
          (i) =>
            i.id ===
            data.instance.id
        );

      if (idx >= 0) {
        state.instances[idx] =
          data.instance;
      } else {
        state.instances.push(
          data.instance
        );
      }

      renderInstances();

      logConsole(
        `provision ${data.instance.id} → ${data.instance.status}`,
        data.instance.status ===
          'online'
          ? 'success'
          : 'info'
      );

      toast(
        `Provisioned ${data.instance.id}`,
        'success'
      );
    }

    await fetchInstances();
  } catch (err) {
    console.error(
      '[provision] failed:',
      err?.message ?? err
    );

    logConsole(
      `provision failed: ${
        err?.message ??
        'unknown error'
      }`,
      'error'
    );

    if (
      err.hostOnline === false ||
      err.status === 503
    ) {
      setHostOnline(false);

      toast(
        'Runtime Host not connected — cannot provision',
        'error'
      );
    } else {
      toast(
        err?.message ??
          'Provisioning failed',
        'error'
      );
    }
  } finally {
    setBtnLoading(btn, false);
    setLoading(false);
  }
}

async function powerCycle(id, action) {
  if (state.pendingAction) return;

  state.pendingAction = true;

  const btn =
    document.querySelector(
      `.power-btn[data-id="${id}"]`
    );

  setBtnLoading(btn, true);

  try {
    const data =
      await api(API.power(), {
        method: 'POST',
        body: JSON.stringify({
          id,
          action,
        }),
      });

    if (data?.instance) {
      const idx =
        state.instances.findIndex(
          (i) => i.id === id
        );

      if (idx >= 0) {
        state.instances[idx] =
          data.instance;
      }

      renderInstances();

      logConsole(
        `power ${action} ${id} → ${data.instance.status}`,
        action === 'stop'
          ? 'error'
          : 'success'
      );

      toast(
        action === 'stop'
          ? `${id} powered off`
          : `${id} is now online`,
        action === 'stop'
          ? 'error'
          : 'success'
      );
    }
  } catch (err) {
    console.error(
      '[powerCycle] failed:',
      err?.message ?? err
    );

    if (
      err.hostOnline === false ||
      err.status === 503
    ) {
      setHostOnline(false);
    }

    logConsole(
      `power ${action} ${id} failed`,
      'error'
    );

    toast(
      err?.message ??
        'Power action failed',
      'error'
    );
  } finally {
    setBtnLoading(btn, false);
    state.pendingAction = false;
  }
}

// ---------------------------------------------------------------------------
// APK Repository
// ---------------------------------------------------------------------------

const APK_STATES = {
  pending: {
    badge: 'state-pending',
    label: 'Pending',
    card: 'state-pending',
  },

  installing: {
    badge: 'state-installing',
    label: 'Installing…',
    card: 'state-installing',
  },

  installed: {
    badge: 'state-installed',
    label: 'Installed',
    card: 'state-installed',
  },
};

function apksForSession() {
  try {
    return (
      JSON.parse(
        sessionStorage.getItem(
          'aetherdroid.apks'
        ) ?? '[]'
      ) ?? []
    );
  } catch (_) {
    return [];
  }
}

function persistApks() {
  try {
    sessionStorage.setItem(
      'aetherdroid.apks',
      JSON.stringify(state.apks)
    );
  } catch (err) {
    console.warn(
      '[persistApks] storage unavailable:',
      err?.message ?? err
    );
  }
}

function mergeApk(apk) {
  if (!apk?.id) return;

  const idx =
    state.apks.findIndex(
      (a) => a.id === apk.id
    );

  if (idx >= 0) {
    state.apks[idx] = {
      ...state.apks[idx],
      ...apk,
    };
  } else {
    state.apks.unshift(apk);
  }

  persistApks();

  if (
    state.view ===
    'repository'
  ) {
    renderApks();
  }
}

function deriveApkName(fileName) {
  const base =
    fileName.replace(
      /\.apk$/i,
      ''
    );

  const parts =
    base
      .split(/[-_.]/)
      .filter(Boolean);

  const name =
    parts[0]
      ? parts[0].replace(
          /([a-z])([A-Z])/g,
          '$1 $2'
        )
      : 'Unknown App';

  const version =
    parts[1]?.match(
      /^v?\d+(\.\d+)*$/i
    )
      ? parts[1].replace(
          /^v/i,
          ''
        )
      : '1.0.0';

  return {
    name:
      name.charAt(0).toUpperCase() +
      name.slice(1),

    version,
  };
}

function packageCard(apk) {
  const s =
    APK_STATES[apk.status] ??
    APK_STATES.pending;

  const installable =
    apk.status === 'pending' &&
    apk.uploaded;

  const online =
    state.instances.some(
      (i) =>
        i.status === 'online'
    ) &&
    state.hostOnline;

  const canInstall =
    installable && online;

  const installTitle =
    !apk.uploaded
      ? 'Upload APK with the target device connected'
      : !online
        ? 'No online device on the Runtime Host'
        : '';

  return `
    <article
      class="package-card ${s.card}"
      data-apk-id="${apk.id}"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-blue-600/15 border border-blue-600/30 flex items-center justify-center shrink-0">
            <svg
              class="w-5 h-5 text-blue-400"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <rect
                x="7"
                y="2"
                width="10"
                height="20"
                rx="2"
              />
              <line
                x1="11"
                y1="19"
                x2="13"
                y2="19"
              />
            </svg>
          </div>

          <div class="min-w-0">
            <h4 class="font-semibold text-slate-100 truncate">
              ${apk.name ?? 'Package'}
            </h4>

            <p class="text-xs font-mono text-slate-500 mt-0.5 truncate">
              ${
                apk.packageName ??
                apk.package ??
                apk.id
              }
            </p>
          </div>
        </div>

        <span class="badge ${s.badge} shrink-0">
          ${s.label}
        </span>
      </div>

      <div class="flex flex-wrap gap-2">
        <span class="badge version">
          v${apk.version ?? '1.0.0'}
        </span>

        <span class="badge size">
          ${apk.size ?? '—'}
        </span>

        <span class="badge">
          ${
            apk.uploaded
              ? 'On host'
              : 'Not uploaded'
          }
        </span>
      </div>

      ${
        apk.status === 'installing'
          ? `
            <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                class="apk-install-bar h-full rounded-full bg-blue-500 transition-all duration-300"
                style="width:0%"
              ></div>
            </div>
          `
          : ''
      }

      <div class="flex gap-2 mt-auto pt-2">
        <button
          class="install-btn flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${
            canInstall
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }"
          data-apk-id="${apk.id}"
          ${canInstall ? '' : 'disabled'}
          title="${installTitle}"
        >
          ${
            apk.status === 'installed'
              ? 'Installed'
              : apk.status === 'installing'
                ? 'Installing…'
                : 'Install'
          }
        </button>

        <button
          class="delete-btn px-3 py-2 rounded-lg text-xs font-medium bg-red-600/15 hover:bg-red-600/25 text-red-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          data-apk-id="${apk.id}"
          aria-label="Remove ${
            apk.name ?? 'package'
          } from repository"
        >
          Remove
        </button>
      </div>
    </article>
  `;
}

function renderApks() {
  const grid =
    $('package-grid');

  if (!grid) return;

  if (!state.apks.length) {
    grid.innerHTML = `
      <div class="glass-panel rounded-2xl p-10 text-center md:col-span-2 xl:col-span-3">
        <p class="text-slate-300 font-medium">
          No packages in your repository
        </p>

        <p class="text-sm text-slate-500 mt-1">
          Upload an APK above or drag &amp; drop files to get started.
        </p>
      </div>
    `;

    return;
  }

  grid.innerHTML =
    state.apks
      .map(packageCard)
      .join('');
}

async function fetchApks() {
  const grid =
    $('package-grid');

  if (
    grid &&
    !state.apks.length &&
    !state.apksLoaded
  ) {
    grid.innerHTML =
      Array.from({ length: 3 })
        .map(
          () =>
            '<div class="skeleton package-card h-44"></div>'
        )
        .join('');
  }

  try {
    const data =
      await api(API.apks());

    const serverApks =
      data.apks ?? [];

    const byId =
      new Map();

    serverApks.forEach(
      (a) =>
        byId.set(a.id, a)
    );

    state.apks.forEach(
      (a) =>
        byId.set(a.id, a)
    );

    state.apks =
      Array.from(
        byId.values()
      );

    if (
      !state.apks.length &&
      apksForSession().length
    ) {
      state.apks =
        apksForSession();
    }

    state.apksLoaded =
      true;

    persistApks();
    renderApks();
  } catch (err) {
    console.error(
      '[fetchApks] failed:',
      err?.message ?? err
    );

    const local =
      apksForSession();

    if (local.length) {
      state.apks =
        local;

      renderApks();
    } else if (grid) {
      grid.innerHTML = `
        <div class="glass-panel rounded-2xl p-10 text-center md:col-span-2 xl:col-span-3">
          <p class="text-red-400 font-medium">
            Failed to load repository
          </p>

          <p class="text-sm text-slate-500 mt-1">
            ${err?.message ?? 'Unknown error'}
          </p>

          <button
            id="retry-apks"
            class="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
          >
            Retry
          </button>
        </div>
      `;

      $('retry-apks')
        ?.addEventListener(
          'click',
          fetchApks
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Real APK upload pipeline
// ---------------------------------------------------------------------------

function newApkId() {
  return `apk-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
}

/**
 * Upload a real APK File via XHR for progress.
 */
function uploadApkFile(
  file,
  {
    apkId,
    sessionId,
    onProgress,
  } = {}
) {
  return new Promise(
    (resolve, reject) => {
      const params =
        new URLSearchParams();

      params.set(
        'id',
        apkId ??
          newApkId()
      );

      params.set(
        'name',
        deriveApkName(
          file.name
        ).name
      );

      if (sessionId) {
        params.set(
          'sessionId',
          sessionId
        );
      }

      const xhr =
        new XMLHttpRequest();

      xhr.open(
        'POST',
        API.upload(
          params.toString()
        )
      );

      xhr.upload.onprogress =
        (e) => {
          if (
            e.lengthComputable &&
            typeof onProgress ===
              'function'
          ) {
            onProgress(
              Math.min(
                99,
                Math.round(
                  (e.loaded /
                    e.total) *
                    100
                )
              )
            );
          }
        };

      xhr.onload = () => {
        let data = {};

        try {
          data =
            JSON.parse(
              xhr.responseText ??
                '{}'
            );
        } catch (_) {}

        if (
          xhr.status >= 200 &&
          xhr.status < 300 &&
          data?.ok
        ) {
          onProgress?.(100);
          resolve(data);
        } else {
          reject(
            Object.assign(
              new Error(
                data?.error ??
                  `Upload failed (${xhr.status})`
              ),
              {
                status:
                  xhr.status,

                hostOnline:
                  data?.hostOnline,

                data,
              }
            )
          );
        }
      };

      xhr.onerror = () =>
        reject(
          new Error(
            'Network error during APK upload'
          )
        );

      const fd =
        new FormData();

      fd.append(
        'file',
        file
      );

      xhr.send(fd);
    }
  );
}

// ---------------------------------------------------------------------------
// Live-view progress panel
// ---------------------------------------------------------------------------

function showUploadProgress(
  fileName,
  pct = 0,
  statusText =
    'Uploading to Runtime Host…'
) {
  const wrap =
    $('apk-progress');

  if (!wrap) return;

  wrap.classList.remove(
    'hidden'
  );

  $('apk-file-name').textContent =
    fileName;

  $('apk-pct').textContent =
    `${pct}%`;

  $('apk-bar').style.width =
    `${pct}%`;

  $('apk-status-text').textContent =
    statusText;
}

function finishUploadProgress(
  statusText,
  success = true
) {
  const wrap =
    $('apk-progress');

  if (!wrap) return;

  $('apk-pct').textContent =
    '100%';

  $('apk-bar').style.width =
    '100%';

  $('apk-status-text').textContent =
    statusText;

  $('apk-status-text').className =
    `text-xs mt-2 ${
      success
        ? 'text-emerald-400'
        : 'text-red-400'
    }`;

  setTimeout(
    () =>
      wrap.classList.add(
        'hidden'
      ),
    4000
  );
}

// ---------------------------------------------------------------------------
// Full APK upload flow
// ---------------------------------------------------------------------------

async function handleApkUpload(
  file,
  {
    sessionId = null,
    showProgress = false,
  } = {}
) {
  if (!file) return null;

  if (
    !file.name
      .toLowerCase()
      .endsWith('.apk')
  ) {
    toast(
      'Only .apk files are supported',
      'error'
    );

    return null;
  }

  if (showProgress) {
    showUploadProgress(
      file.name,
      0
    );
  }

  try {
    const data =
      await uploadApkFile(
        file,
        {
          sessionId,

          onProgress: (
            pct
          ) => {
            if (
              showProgress
            ) {
              showUploadProgress(
                file.name,
                pct,
                sessionId
                  ? 'Uploading to Runtime Host…'
                  : 'Uploading to registry…'
              );
            }
          },
        }
      );

    const apk =
      data?.apk;

    if (apk) {
      mergeApk(apk);
    }

    if (data?.uploaded) {
      logConsole(
        `adb install -r ${file.name} → Success (${data.packageName ?? 'package detected'})`,
        'success'
      );

      if (showProgress) {
        finishUploadProgress(
          'Installed on device',
          true
        );
      }

      toast(
        `${apk?.name ?? file.name} installed on ${sessionId}`,
        'success'
      );
    } else {
      logConsole(
        `registered ${file.name} — metadata saved, upload to host pending`
      );

      if (showProgress) {
        finishUploadProgress(
          'Saved to registry — connect a device to upload',
          true
        );
      }

      toast(
        `${apk?.name ?? file.name} saved. Connect a device to upload.`,
        'info'
      );
    }

    if (
      data?.hostOnline ===
      false
    ) {
      setHostOnline(false);
    }

    return apk ?? null;
  } catch (err) {
    console.error(
      '[handleApkUpload] failed:',
      err?.message ?? err
    );

    if (showProgress) {
      finishUploadProgress(
        err?.message ??
          'Upload failed',
        false
      );
    }

    if (
      err.hostOnline ===
      false
    ) {
      setHostOnline(false);
    }

    toast(
      err?.message ??
        'APK upload failed',
      'error'
    );

    /*
     * Local UI fallback.
     *
     * This does NOT claim that the APK was uploaded
     * or installed. It only preserves the repository
     * UI state.
     */
    const {
      name,
      version,
    } =
      deriveApkName(
        file.name
      );

    const apk = {
      id: newApkId(),
      name,
      version,

      package:
        `com.aetherdroid.${name
          .toLowerCase()
          .replace(
            /[^a-z0-9]/g,
            ''
          )}`,

      size: file.size
        ? `${(
            file.size /
            (1024 * 1024)
          ).toFixed(1)} MB`
        : '—',

      status: 'pending',
      uploaded: false,
      packageName: null,
      targetInstance: null,
      fileName:
        file.name,

      addedAt:
        new Date().toISOString(),
    };

    mergeApk(apk);

    logConsole(
      `upload ${file.name} failed: ${
        err?.message ??
        'unknown'
      }`,
      'error'
    );

    return apk;
  }
}

// ---------------------------------------------------------------------------
// Back-compat shim
// ---------------------------------------------------------------------------

function registerApk(
  fileName,
  fileSize
) {
  const {
    name,
    version,
  } =
    deriveApkName(
      fileName
    );

  const apk = {
    id: newApkId(),
    name,
    version,

    package:
      `com.aetherdroid.${name
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ''
        )}`,

    size: fileSize
      ? `${(
          fileSize /
          (1024 * 1024)
        ).toFixed(1)} MB`
      : '—',

    status: 'pending',
    uploaded: false,
    packageName: null,
    targetInstance: null,
    fileName,
    addedAt:
      new Date().toISOString(),
  };

  mergeApk(apk);

  if (
    state.view ===
    'repository'
  ) {
    renderApks();
  }

  return apk;
}

// ---------------------------------------------------------------------------
// Install pipeline
// ---------------------------------------------------------------------------

async function installApk(
  apkId
) {
  const apk =
    state.apks.find(
      (a) =>
        a.id === apkId
    );

  if (!apk) {
    toast(
      'Package not found',
      'error'
    );

    return;
  }

  const inst =
    state.instances.find(
      (i) =>
        i.status ===
        'online'
    );

  if (
    !inst ||
    !state.hostOnline
  ) {
    toast(
      'No online device. Provision a phone on a connected Runtime Host first.',
      'error'
    );

    return;
  }

  if (!apk.uploaded) {
    toast(
      'Upload APK with the target device connected first',
      'error'
    );

    return;
  }

  if (
    apk.status !==
    'pending'
  ) {
    return;
  }

  apk.status =
    'installing';

  persistApks();
  renderApks();

  toast(
    `Installing ${apk.name} on ${inst.id}…`
  );

  try {
    const data =
      await api(
        API.install(),
        {
          method: 'POST',

          body:
            JSON.stringify({
              sessionId:
                inst.id,

              apkId:
                apk.id,
            }),
        }
      );

    const delay =
      Number(
        data?.installDelayMs
      ) || 1000;

    const cardEl =
      document.querySelector(
        `.package-card[data-apk-id="${apkId}"]`
      );

    if (cardEl) {
      const bar =
        cardEl.querySelector(
          '.apk-install-bar'
        );

      if (bar) {
        const started =
          performance.now();

        const tick = () => {
          const pct =
            Math.min(
              95,
              ((performance.now() -
                started) /
                delay) *
                100
            );

          bar.style.width =
            `${pct}%`;

          if (
            performance.now() -
              started <
            delay
          ) {
            requestAnimationFrame(
              tick
            );
          } else {
            bar.style.width =
              '100%';
          }
        };

        requestAnimationFrame(
          tick
        );
      }
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          delay
        )
    );

    apk.status =
      'installed';

    if (
      data?.packageName
    ) {
      apk.packageName =
        data.packageName;
    }

    persistApks();

    if (
      state.view ===
      'repository'
    ) {
      renderApks();
    }

    logConsole(
      `installed ${apk.fileName ?? apk.name} → ${
        data?.packageName ??
        apk.packageName ??
        apk.package
      }`,
      'success'
    );

    toast(
      `${apk.name} installed successfully`,
      'success'
    );
  } catch (err) {
    console.error(
      '[installApk] failed:',
      err?.message ?? err
    );

    apk.status =
      'pending';

    persistApks();

    if (
      state.view ===
      'repository'
    ) {
      renderApks();
    }

    if (
      err.hostOnline ===
      false ||
      err.status === 503
    ) {
      setHostOnline(false);
    }

    logConsole(
      `install ${apk.name} failed: ${
        err?.message ??
        'unknown'
      }`,
      'error'
    );

    toast(
      err?.message ??
        'Installation failed',
      'error'
    );
  }
}

// ---------------------------------------------------------------------------
// WebRTC real streaming
// ---------------------------------------------------------------------------

function teardownPeerConnection() {
  if (state.pc) {
    try {
      state.pc.close();
    } catch (_) {}

    state.pc = null;
  }

  state.remoteStream =
    null;

  const video =
    $('phone-video');

  if (video) {
    video.srcObject =
      null;

    video.classList.add(
      'hidden'
    );
  }
}

function setLiveIndicator(
  live
) {
  const el =
    $('live-indicator');

  if (!el) return;

  el.classList.toggle(
    'bg-emerald-500',
    live
  );

  el.classList.toggle(
    'bg-slate-500',
    !live
  );

  el.classList.toggle(
    'pulse-dot',
    live
  );
}

function updateLastSeen(
  lastSeen
) {
  const el =
    $('session-lastseen');

  if (!el) return;

  if (!lastSeen) {
    el.textContent = '—';
    return;
  }

  const ms =
    new Date(
      lastSeen
    ).getTime();

  el.textContent =
    Number.isNaN(ms)
      ? '—'
      : new Date(
          ms
        ).toLocaleTimeString();
}

function showStreamOverlay(
  text,
  spinner = true
) {
  const statusEl =
    $('stream-status');

  const textEl =
    $('stream-status-text');

  const spinEl =
    statusEl?.querySelector(
      '.loading-spinner'
    );

  if (statusEl) {
    statusEl.classList.remove(
      'opacity-0',
      'pointer-events-none'
    );
  }

  if (textEl) {
    textEl.textContent =
      text;
  }

  if (spinEl) {
    spinEl.classList.toggle(
      'hidden',
      !spinner
    );
  }
}

function hideStreamOverlay() {
  $('stream-status')
    ?.classList.add(
      'opacity-0',
      'pointer-events-none'
    );
}

function setStreamErrorState(
  message
) {
  const statusEl =
    $('stream-status');

  const textEl =
    $('stream-status-text');

  const spinEl =
    statusEl?.querySelector(
      '.loading-spinner'
    );

  if (statusEl) {
    statusEl.classList.remove(
      'opacity-0',
      'pointer-events-none'
    );
  }

  if (textEl) {
    textEl.textContent =
      message;
  }

  if (spinEl) {
    spinEl.classList.add(
      'hidden'
    );
  }

  setLiveIndicator(false);
}

async function startStream() {
  const inst =
    state.instances.find(
      (i) =>
        i.status ===
        'online'
    );

  const deviceEl =
    $('session-device');

  teardownPeerConnection();

  if (!deviceEl) {
    return;
  }

  if (
    !inst ||
    !state.hostOnline
  ) {
    deviceEl.textContent =
      '—';

    setStreamErrorState(
      state.hostOnline
        ? 'No online device. Provision a phone first.'
        : 'Runtime Host not connected.'
    );

    return;
  }

  state.activeSession =
    inst;

  state.retryAttempt =
    0;

  deviceEl.textContent =
    `${inst.name ?? inst.id} · ${inst.id}`;

  updateLastSeen(
    inst.lastSeen
  );

  logConsole(
    `adb connect ${inst.id} (Runtime Host)`
  );

  await connectWebRTC(
    inst
  );
}

async function connectWebRTC(
  inst
) {
  showStreamOverlay(
    'Negotiating WebRTC session…'
  );

  try {
    const pc =
      new RTCPeerConnection({
        iceServers: [
          {
            urls:
              'stun:stun.l.google.com:19302',
          },
        ],
      });

    state.pc = pc;

    pc.addTransceiver(
      'video',
      {
        direction:
          'recvonly',
      }
    );

    pc.ontrack = (
      event
    ) => {
      const video =
        $('phone-video');

      if (!video) {
        return;
      }

      state.remoteStream =
        event.streams[0] ??
        new MediaStream([
          event.track,
        ]);

      video.srcObject =
        state.remoteStream;

      video.classList.remove(
        'hidden'
      );

      video
        .play()
        .catch(() => {});
    };

    pc.oniceconnectionstatechange =
      () => {
        const s =
          pc.iceConnectionState;

        if (
          s === 'connected' ||
          s === 'completed'
        ) {
          state.retryAttempt =
            0;

          hideStreamOverlay();

          setLiveIndicator(
            true
          );

          logConsole(
            'WebRTC connected — live video track active',
            'success'
          );
        } else if (
          s === 'disconnected' ||
          s === 'failed' ||
          s === 'closed'
        ) {
          setLiveIndicator(
            false
          );

          if (
            s === 'failed' ||
            s === 'disconnected'
          ) {
            scheduleStreamRetry(
              inst
            );
          }
        }
      };

    const offer =
      await pc.createOffer();

    await pc.setLocalDescription(
      offer
    );

    const data =
      await api(
        API.signal(),
        {
          method: 'POST',

          body:
            JSON.stringify({
              sessionId:
                inst.id,

              type:
                'offer',

              sdp:
                offer.sdp,
            }),
        }
      );

    if (
      !data?.answer?.sdp
    ) {
      throw new Error(
        'Host returned no SDP answer'
      );
    }

    await pc.setRemoteDescription(
      new RTCSessionDescription(
        data.answer
      )
    );
  } catch (err) {
    console.error(
      '[connectWebRTC] failed:',
      err?.message ?? err
    );

    teardownPeerConnection();

    if (
      err.hostOnline ===
        false ||
      err.status ===
        503
    ) {
      setHostOnline(
        false
      );

      setStreamErrorState(
        'Runtime Host not connected.'
      );

      logConsole(
        'Runtime Host not connected — stream unavailable',
        'error'
      );

      toast(
        'Runtime Host not connected',
        'error'
      );
    } else {
      setStreamErrorState(
        'Stream negotiation failed. Use Reconnect to retry.'
      );

      logConsole(
        `signaling failed: ${
          err?.message ??
          'unknown'
        }`,
        'error'
      );

      scheduleStreamRetry(
        inst
      );
    }
  }
}

function scheduleStreamRetry(
  inst
) {
  if (
    state.view !==
    'phone'
  ) {
    return;
  }

  const delay =
    Math.min(
      15000,
      2000 *
        Math.pow(
          2,
          state.retryAttempt++
        )
    );

  logConsole(
    `reconnecting stream in ${Math.round(
      delay / 1000
    )}s…`
  );

  setTimeout(() => {
    if (
      state.view ===
        'phone' &&
      state.instances.some(
        (i) =>
          i.status ===
          'online'
      ) &&
      state.hostOnline
    ) {
      connectWebRTC(
        inst
      );
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// ADB Bridge
// ---------------------------------------------------------------------------

const KEYCODES = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
};

let latencySamples =
  [];

function updateLatencyDisplay(
  rttMs
) {
  latencySamples.push(
    rttMs
  );

  if (
    latencySamples.length >
    10
  ) {
    latencySamples.shift();
  }

  const avg =
    latencySamples.reduce(
      (a, b) => a + b,
      0
    ) /
    latencySamples.length;

  const el =
    $('latency-value');

  if (el) {
    el.textContent =
      `${Math.round(avg)}ms`;

    el.classList.toggle(
      'text-emerald-400',
      avg < 120
    );

    el.classList.toggle(
      'text-amber-400',
      avg >= 120
    );
  }
}

function sessionReady() {
  return Boolean(
    state.activeSession &&
    state.activeSession.status ===
      'online' &&
    state.hostOnline
  );
}

async function sendInput(
  payload
) {
  if (!sessionReady()) {
    return null;
  }

  const started =
    performance.now();

  try {
    const data =
      await api(
        API.input(),
        {
          method: 'POST',

          body:
            JSON.stringify({
              sessionId:
                state.activeSession
                  .id,

              seq:
                payload.seq,

              ts:
                payload.ts ??
                Date.now(),

              ...payload,
            }),
        }
      );

    const serverMs =
      Number(
        data?.processingMs
      ) || 0;

    updateLatencyDisplay(
      Math.max(
        0,
        performance.now() -
          started -
          serverMs
      )
    );

    return data;
  } catch (err) {
    if (
      err.hostOnline ===
        false ||
      err.status === 503
    ) {
      setHostOnline(
        false
      );
    }

    const now =
      Date.now();

    if (
      now -
        lastHostWarnAt >
      60000
    ) {
      lastHostWarnAt =
        now;

      console.warn(
        '[sendInput] failed:',
        err?.message ??
          err
      );
    }

    return null;
  }
}

let heartbeatSeq =
  0;

setInterval(() => {
  if (sessionReady()) {
    sendInput({
      kind:
        'heartbeat',

      seq:
        ++heartbeatSeq,
    }).then(() => {
      updateLastSeen(
        new Date().toISOString()
      );
    });
  }
}, 15000);

// ---------------------------------------------------------------------------
// Dropzone wiring
// ---------------------------------------------------------------------------

function wireDropzone(
  dropEl,
  inputEl,
  isRepository
) {
  if (
    !dropEl ||
    !inputEl
  ) {
    return;
  }

  inputEl.addEventListener(
    'change',
    () => {
      if (
        inputEl.files?.length
      ) {
        const file =
          inputEl.files[0];

        inputEl.value =
          '';

        const sessionId =
          isRepository
            ? null
            : state.activeSession
                  ?.status ===
                'online'
              ? state
                  .activeSession
                  .id
              : null;

        handleApkUpload(
          file,
          {
            sessionId,
            showProgress:
              !isRepository,
          }
        );
      }
    }
  );

  dropEl.addEventListener(
    'click',
    () =>
      inputEl.click()
  );

  dropEl.addEventListener(
    'keydown',
    (e) => {
      if (
        e.key === 'Enter' ||
        e.key === ' '
      ) {
        e.preventDefault();
        inputEl.click();
      }
    }
  );

  [
    'dragover',
    'dragenter',
  ].forEach((ev) =>
    dropEl.addEventListener(
      ev,
      (e) => {
        e.preventDefault();

        dropEl.classList.add(
          'border-blue-500'
        );
      }
    )
  );

  [
    'dragleave',
    'drop',
  ].forEach((ev) =>
    dropEl.addEventListener(
      ev,
      (e) => {
        e.preventDefault();

        dropEl.classList.remove(
          'border-blue-500'
        );
      }
    )
  );

  dropEl.addEventListener(
    'drop',
    (e) => {
      const file =
        e.dataTransfer
          ?.files?.[0];

      if (!file) return;

      const sessionId =
        isRepository
          ? null
          : state.activeSession
                ?.status ===
              'online'
            ? state
                .activeSession
                .id
            : null;

      handleApkUpload(
        file,
        {
          sessionId,
          showProgress:
            !isRepository,
        }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Session recovery
// ---------------------------------------------------------------------------

function restoreSession() {
  let saved =
    null;

  try {
    saved =
      JSON.parse(
        sessionStorage.getItem(
          'aetherdroid.session'
        ) ?? 'null'
      );
  } catch (_) {
    saved =
      null;
  }

  let savedView =
    null;

  try {
    savedView =
      sessionStorage.getItem(
        'aetherdroid.view'
      );
  } catch (_) {
    savedView =
      null;
  }

  fetchInstances()
    .then(() => {
      if (saved?.id) {
        const inst =
          state.instances.find(
            (i) =>
              i.id ===
                saved.id &&
              i.status ===
                'online'
          );

        if (
          inst &&
          state.hostOnline
        ) {
          state.activeSession =
            inst;

          toast(
            `Restored session with ${
              inst.name ??
              inst.id
            }`,
            'success'
          );
        } else {
          try {
            sessionStorage.removeItem(
              'aetherdroid.session'
            );
          } catch (_) {
            // non-fatal
          }
        }
      }

      switchView(
        savedView &&
          TITLES[savedView]
          ? savedView
          : 'dashboard'
      );
    });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function setup() {
  initInputHandler();

  document
    .querySelectorAll(
      '.nav-btn'
    )
    .forEach((btn) =>
      btn.addEventListener(
        'click',
        () =>
          switchView(
            btn.getAttribute(
              'data-view'
            )
          )
      )
    );

  const sidebar =
    $('sidebar');

  const backdrop =
    $('sidebar-backdrop');

  $('menu-btn')?.addEventListener(
    'click',
    () => {
      sidebar?.classList.toggle(
        '-translate-x-full'
      );

      backdrop?.classList.toggle(
        'hidden'
      );
    }
  );

  backdrop?.addEventListener(
    'click',
    () => {
      sidebar?.classList.add(
        '-translate-x-full'
      );

      backdrop?.classList.add(
        'hidden'
      );
    }
  );

  $('host-retry')?.addEventListener(
    'click',
    () =>
      checkHostStatus(true)
  );

  $('provision-btn')?.addEventListener(
    'click',
    provision
  );

  $('refresh-btn')?.addEventListener(
    'click',
    async (e) => {
      const btn =
        e.currentTarget;

      setBtnLoading(
        btn,
        true
      );

      await Promise.all([
        checkHostStatus(true),
        fetchInstances(),
        fetchWatchdog(),
      ]);

      setBtnLoading(
        btn,
        false
      );

      toast(
        'Synced with Control Plane'
      );
    }
  );

  $('instance-grid')?.addEventListener(
    'click',
    (e) => {
      const btn =
        e.target.closest(
          'button'
        );

      if (!btn) return;

      const id =
        btn.getAttribute(
          'data-id'
        );

      if (
        btn.classList.contains(
          'connect-btn'
        )
      ) {
        if (
          !state.hostOnline
        ) {
          toast(
            'Runtime Host not connected',
            'error'
          );

          return;
        }

        const inst =
          state.instances.find(
            (i) =>
              i.id === id
          );

        if (inst) {
          try {
            sessionStorage.setItem(
              'aetherdroid.session',
              JSON.stringify({
                id: inst.id,
              })
            );
          } catch (_) {
            // non-fatal
          }
        }

        switchView(
          'phone'
        );
      } else if (
        btn.classList.contains(
          'power-btn'
        )
      ) {
        powerCycle(
          id,
          btn.getAttribute(
            'data-action'
          )
        );
      }
    }
  );

  $('repo-upload-btn')?.addEventListener(
    'click',
    () =>
      $('repo-apk-input')
        ?.click()
  );

  $('repo-refresh-btn')?.addEventListener(
    'click',
    async (e) => {
      const btn =
        e.currentTarget;

      setBtnLoading(
        btn,
        true
      );

      await fetchApks();

      setBtnLoading(
        btn,
        false
      );

      toast(
        'Repository synced'
      );
    }
  );

  wireDropzone(
    $('repo-drop'),
    $('repo-apk-input'),
    true
  );

  wireDropzone(
    $('apk-drop'),
    $('apk-input'),
    false
  );

  $('go-repository-btn')?.addEventListener(
    'click',
    () =>
      switchView(
        'repository'
      )
  );

  $('package-grid')?.addEventListener(
    'click',
    (e) => {
      const btn =
        e.target.closest(
          'button'
        );

      if (!btn) return;

      const apkId =
        btn.getAttribute(
          'data-apk-id'
        );

      if (
        btn.classList.contains(
          'install-btn'
        )
      ) {
        installApk(
          apkId
        );
      } else if (
        btn.classList.contains(
          'delete-btn'
        )
      ) {
        const apk =
          state.apks.find(
            (a) =>
              a.id ===
              apkId
          );

        if (
          apk?.status ===
          'installing'
        ) {
          toast(
            'Cannot remove a package mid-install',
            'error'
          );

          return;
        }

        state.apks =
          state.apks.filter(
            (a) =>
              a.id !==
              apkId
          );

        persistApks();
        renderApks();

        toast(
          `${
            apk?.name ??
            'Package'
          } removed`,
          'info'
        );
      }
    }
  );

  $('console-toggle')?.addEventListener(
    'click',
    () => {
      state.consoleOpen =
        !state.consoleOpen;

      const consoleEl =
        $('adb-console');

      const chevron =
        $('console-chevron');

      consoleEl?.classList.toggle(
        'hidden',
        !state.consoleOpen
      );

      if (chevron) {
        chevron.style.transform =
          state.consoleOpen
            ? 'rotate(180deg)'
            : '';
      }

      $('console-toggle')
        ?.setAttribute(
          'aria-expanded',
          String(
            state.consoleOpen
          )
        );
    }
  );

  $('reconnect-btn')?.addEventListener(
    'click',
    () =>
      startStream()
  );

  $('end-session-btn')?.addEventListener(
    'click',
    () => {
      teardownPeerConnection();

      state.activeSession =
        null;

      latencySamples =
        [];

      setLiveIndicator(
        false
      );

      try {
        sessionStorage.removeItem(
          'aetherdroid.session'
        );
      } catch (_) {
        // non-fatal
      }

      if (
        $('latency-value')
      ) {
        $('latency-value')
          .textContent =
          '--ms';
      }

      setStreamErrorState(
        'Session ended.'
      );

      if (
        $('session-device')
      ) {
        $('session-device')
          .textContent =
          '—';
      }

      logConsole(
        'adb disconnect',
        'error'
      );

      toast(
        'Session ended'
      );
    }
  );

  onInput((p) => {
    if (
      !sessionReady()
    ) {
      return;
    }

    sendInput({
      kind: 'touch',
      type: p.type,
      x: p.x,
      y: p.y,
      seq: p.seq,
      ts: p.ts,
    });
  });

  onHardwareKey((p) => {
    if (
      !sessionReady()
    ) {
      toast(
        'No active device session',
        'error'
      );

      return;
    }

    logConsole(
      `input keyevent ${
        KEYCODES[p.key] ??
        p.key
      }`
    );

    sendInput({
      kind: 'key',
      key: p.key,
      keycode:
        KEYCODES[p.key] ??
        null,
    });
  });

  const kbBtn =
    $('keyboard-toggle');

  kbBtn?.addEventListener(
    'click',
    () => {
      state.keyboardCapture =
        !state.keyboardCapture;

      kbBtn.setAttribute(
        'aria-pressed',
        String(
          state.keyboardCapture
        )
      );

      kbBtn.classList.toggle(
        'bg-blue-600',
        state.keyboardCapture
      );

      kbBtn.classList.toggle(
        'text-white',
        state.keyboardCapture
      );

      kbBtn.classList.toggle(
        'bg-slate-800',
        !state.keyboardCapture
      );

      kbBtn.classList.toggle(
        'text-slate-400',
        !state.keyboardCapture
      );

      toast(
        state.keyboardCapture
          ? 'Keyboard capture on — physical keys route to device'
          : 'Keyboard capture off',
        'info'
      );
    }
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (
        !state.keyboardCapture ||
        !sessionReady()
      ) {
        return;
      }

      if (
        e.target instanceof
          HTMLElement &&
        [
          'INPUT',
          'TEXTAREA',
        ].includes(
          e.target.tagName
        )
      ) {
        return;
      }

      if (
        emitKeyboard(e)
      ) {
        e.preventDefault();
      }
    }
  );

  const local =
    apksForSession();

  if (local.length) {
    state.apks =
      local;

    renderApks();
  }

  logConsole(
    'control plane bridge initialized — real APK pipeline active'
  );

  /*
   * IMPORTANT STARTUP ORDER:
   *
   * 1. Check the actual Runtime Host health endpoint.
   * 2. Load instances.
   * 3. Load watchdog information.
   * 4. Restore the previous session/view.
   *
   * This prevents the old /api/host-status mismatch
   * from making the UI permanently show "offline".
   */
  checkHostStatus(true)
    .then(() => {
      fetchWatchdog();

      setInterval(
        fetchWatchdog,
        15000
      );

      setInterval(
        () =>
          checkHostStatus(),
        30000
      );

      restoreSession();
    });

  const clock =
    $('clock');

  const updateClock =
    () => {
      if (clock) {
        clock.textContent =
          new Date()
            .toLocaleTimeString();
      }
    };

  updateClock();

  setInterval(
    updateClock,
    1000
  );
}

if (
  document.readyState !==
  'loading'
) {
  setup();
} else {
  document.addEventListener(
    'DOMContentLoaded',
    setup
  );
            }
