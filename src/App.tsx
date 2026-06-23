import {
  AlertTriangle,
  BadgeCheck,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsLeftRight,
  Circle,
  ClipboardList,
  Code2,
  Crosshair,
  ExternalLink,
  FolderOpen,
  Github,
  GitBranch,
  Laptop,
  LayoutDashboard,
  ListFilter,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  Move,
  PanelRight,
  Play,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Smartphone,
  StopCircle,
  TerminalSquare,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Select } from '@base-ui/react/select';
import { Switch } from '@base-ui/react/switch';
import { Toggle as ToggleGroupItem } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { seedBranches, seedEndpoints, seedRepositories } from './data/seed';
import { FilterCombobox } from './components/FilterCombobox';
import type {
  ChangeLinkResult,
  ChangeProbe,
  DiffStatus,
  EndpointDefinition,
  MockBody,
  RepositorySummary,
  ServerLogEntry,
  SidecarStatus,
  VisualDiffReport,
  VisualDiffRouteReport,
} from './lib/types';

const bridge = window.deepDiff;
const workingTreeRef = '__working_tree__';

// Placeholder shown in Electron before a workspace is opened — no `path`, so the
// run/launch guards correctly block and prompt the user to open a folder. (Demo
// mode, with no bridge, still seeds a fake repo so the UI has something to show.)
const EMPTY_REPO: RepositorySummary = {
  id: '',
  name: 'No repository',
  fullName: 'No repository selected',
  source: 'local',
};

// Capture viewport presets, keyed for the device Toggle Group.
const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 900 },
  laptop: { width: 1024, height: 768 },
  mobile: { width: 375, height: 667 },
} as const;
type ViewportKey = keyof typeof VIEWPORT_PRESETS;

function viewportKey(viewport: { width: number; height: number }): ViewportKey | '' {
  return (
    (Object.keys(VIEWPORT_PRESETS) as ViewportKey[]).find(
      (key) =>
        VIEWPORT_PRESETS[key].width === viewport.width &&
        VIEWPORT_PRESETS[key].height === viewport.height,
    ) ?? ''
  );
}

// Diff-tolerance presets (fraction of pixels allowed to differ) for the
// sensitivity Select. Label keeps the toolbar button's old formatting.
const SENSITIVITY_PRESETS = [0, 0.001, 0.01, 0.05, 0.1, 0.25] as const;

function formatSensitivityPct(value: number): string {
  if (value === 0) return '0%';
  return value < 0.01 ? `${(value * 100).toFixed(1)}%` : `${Math.round(value * 100)}%`;
}

const SENSITIVITY_ITEMS = SENSITIVITY_PRESETS.map((value) => ({
  value,
  label: formatSensitivityPct(value),
}));

const navItems = [
  { label: 'Compare', icon: ChevronsLeftRight },
  { label: 'Endpoints', icon: Code2 },
  { label: 'Sidecar', icon: Server },
  { label: 'Reports', icon: ClipboardList },
  { label: 'Settings', icon: Settings },
];

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

// Base UI Switch keeps the same external API as the old custom button so call
// sites are untouched: it still renders `<button role="switch" aria-checked>`
// (cypress drives `[role="switch"]`). `onChange` stays argument-less — call
// sites toggle off current state, not the emitted `checked` value. The thumb is
// forced to a <span> so the existing `.toggle span` CSS still positions it.
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <Switch.Root
      className={cx('toggle', checked && 'toggle-on')}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
    >
      <Switch.Thumb render={<span />} />
    </Switch.Root>
  );
}

// Reapply persisted per-endpoint mock edits onto a freshly scanned/seeded list.
function withMockEdits(
  list: EndpointDefinition[],
  edits: Record<string, MockBody>,
): EndpointDefinition[] {
  if (!Object.keys(edits).length) return list;
  return list.map((endpoint) => {
    const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
    return edits[key] ? { ...endpoint, mock: edits[key] } : endpoint;
  });
}

function MethodPill({ method }: { method: string }) {
  return <span className={cx('method-pill', `method-${method.toLowerCase()}`)}>{method}</span>;
}

function StatusPill({ status }: { status: DiffStatus }) {
  const labels: Record<DiffStatus, string> = {
    idle: 'Ready',
    running: 'Running',
    passed: 'Completed',
    failed: 'Needs review',
  };

  return (
    <span className={cx('status-pill', `status-${status}`)}>
      {status === 'running' ? <Loader2 size={14} className="spin" /> : <BadgeCheck size={14} />}
      {labels[status]}
    </span>
  );
}

function branchLabel(branch: string) {
  return branch === workingTreeRef ? 'Working tree' : branch;
}

function toRunRef(branch: string) {
  return branch === workingTreeRef ? workingTreeRef : branch;
}

function formatMismatch(value: number) {
  return `${(value * 100).toFixed(value < 0.01 ? 3 : 2)}%`;
}

// Map an Electron <webview> console-message level (0-3) to a stable name.
function webviewConsoleLevel(level?: number): string {
  if (level === 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 1) return 'info';
  return 'log';
}

// Bottom drawer that shows captured dev-server output + rendered-page console,
// streamed from the main process. Lines are tagged by server (base / target /
// sidecar) and stream (stdout / stderr / console / install / system).
// Escape, then wrap JSON tokens in classed spans for syntax highlighting. The
// input is escaped first, so the only markup injected is our own <span>s.
function highlightJsonHtml(json: string): string {
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'tok-num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'tok-key' : 'tok-str';
      else if (/^(?:true|false)$/.test(match)) cls = 'tok-bool';
      else if (match === 'null') cls = 'tok-null';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

// If a log line contains a JSON object/array (optionally after a text prefix),
// pretty-print + highlight that portion; otherwise render the raw text.
function tryFormatJson(text: string): { pre: string; json: string } | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const candidate = text.slice(start).trim();
  if (candidate.length < 2) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== 'object') return null;
    return { pre: text.slice(0, start), json: JSON.stringify(parsed, null, 2) };
  } catch {
    return null;
  }
}

function LogText({ text }: { text: string }) {
  const formatted = useMemo(() => tryFormatJson(text), [text]);
  if (!formatted) return <span className="log-text">{text}</span>;
  return (
    <span className="log-text">
      {formatted.pre.trim() && <span className="log-pre">{formatted.pre.trim()} </span>}
      <code
        className="log-json"
        dangerouslySetInnerHTML={{ __html: highlightJsonHtml(formatted.json) }}
      />
    </span>
  );
}

function LogDrawer({
  entries,
  open,
  onClose,
  onClear,
  revealFile,
}: {
  entries: ServerLogEntry[];
  open: boolean;
  onClose: () => void;
  onClear: () => void;
  revealFile?: string;
}) {
  const [filter, setFilter] = useState<'all' | 'base' | 'target' | 'sidecar' | 'errors'>('all');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const isError = (entry: ServerLogEntry) => entry.stream === 'stderr' || entry.level === 'error';

  const visible = useMemo(
    () =>
      entries.filter((entry) => {
        if (filter === 'all') return true;
        if (filter === 'errors') return isError(entry);
        return entry.server === filter;
      }),
    [entries, filter],
  );

  // Keep the newest line in view, but only when the user is already at the bottom.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible, open]);

  if (!open) return null;

  const errorCount = entries.filter(isError).length;
  const chips: { key: typeof filter; label: string }[] = [
    { key: 'all', label: `All ${entries.length}` },
    { key: 'base', label: 'Base' },
    { key: 'target', label: 'Target' },
    { key: 'sidecar', label: 'Sidecar' },
    { key: 'errors', label: `Errors ${errorCount}` },
  ];

  return (
    <section className="log-drawer">
      <header className="log-drawer-head">
        <div className="log-drawer-title">
          <TerminalSquare size={15} />
          <strong>Server &amp; page logs</strong>
        </div>
        <div className="log-filters">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cx('log-filter', filter === chip.key && 'active')}
              onClick={() => setFilter(chip.key)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="log-drawer-actions">
          {revealFile && bridge?.revealLog && (
            <button
              type="button"
              className="ghost-button"
              title={revealFile}
              onClick={() => bridge.revealLog?.(revealFile).catch(() => undefined)}
            >
              <FolderOpen size={14} />
              Reveal file
            </button>
          )}
          <button type="button" className="ghost-button" onClick={onClear}>
            <Trash2 size={14} />
            Clear
          </button>
          <button type="button" className="icon-button" aria-label="Close logs" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div
        className="log-drawer-body"
        ref={bodyRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {visible.length === 0 ? (
          <p className="log-empty">No logs yet. Launch the sidecar or run a visual diff.</p>
        ) : (
          visible.map((entry, index) => (
            <div
              key={`${entry.ts}-${index}`}
              className={cx(
                'log-line',
                isError(entry) && 'is-error',
                entry.stream === 'system' && 'is-system',
                entry.stream === 'network' && 'is-network',
                entry.level === 'warning' && 'is-warn',
              )}
            >
              <span className="log-time">
                {new Date(entry.ts).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={cx('log-tag', `tag-${entry.server}`)}>{entry.server}</span>
              <span className="log-stream">
                {entry.stream}
                {entry.level ? `:${entry.level}` : ''}
              </span>
              <LogText text={entry.text} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function App() {
  const [sourceMode, setSourceMode] = useState<'local' | 'github'>('local');
  const [workspacePath, setWorkspacePath] = useState('No workspace selected');
  // In Electron, start empty so the UI prompts the user to open a workspace
  // instead of showing a fake demo repo that errors on run. Seeds only fill the
  // no-bridge demo mode.
  const [repositories, setRepositories] = useState<RepositorySummary[]>(
    bridge ? [] : seedRepositories,
  );
  const [selectedRepo, setSelectedRepo] = useState<RepositorySummary>(
    bridge ? EMPTY_REPO : seedRepositories[0],
  );
  const [branches, setBranches] = useState<string[]>(bridge ? [] : seedBranches);
  const [baseBranch, setBaseBranch] = useState('main');
  const [targetBranch, setTargetBranch] = useState('feature/order-flow');
  const [endpoints, setEndpoints] = useState<EndpointDefinition[]>(bridge ? [] : seedEndpoints);
  // Single live mock set: every detected endpoint is mocked by default. The user's
  // deviations are the only persisted state — `disabledMockKeys` (turned-off keys)
  // and `mockEdits` (edited bodies). `mocksEnabled` is the master switch.
  const [mocksEnabled, setMocksEnabled] = useState(true);
  const [disabledMockKeys, setDisabledMockKeys] = useState<string[]>([]);
  // Per-endpoint edited mock bodies, keyed `METHOD:path`, reapplied onto freshly
  // scanned endpoints so edits survive a rescan/restart. Persisted to state.json.
  const [mockEdits, setMockEdits] = useState<Record<string, MockBody>>({});
  // Latest mockEdits for use inside async scan handlers without stale closures.
  const mockEditsRef = useRef(mockEdits);
  mockEditsRef.current = mockEdits;
  // Gates the persistence save effect until after the initial load has hydrated
  // state — otherwise the first render would overwrite state.json with seeds.
  const [stateHydrated, setStateHydrated] = useState(false);
  const [selectedEndpointId, setSelectedEndpointId] = useState(bridge ? '' : seedEndpoints[0].id);
  const [githubOrg, setGithubOrg] = useState('acme-pizza');
  const [search, setSearch] = useState('');
  const [diffStatus, setDiffStatus] = useState<DiffStatus>('idle');
  const [diffReport, setDiffReport] = useState<VisualDiffReport | null>(null);
  const [selectedReportRouteId, setSelectedReportRouteId] = useState<string | null>(null);
  // Absolute path of the selected local repo's overlay folder (test-only files Deep Diff
  // copies over the capture worktree). Created on select; revealed via the topbar button.
  const [overlayPath, setOverlayPath] = useState<string | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ running: false });
  const [message, setMessage] = useState(
    'Use a local folder or GitHub organization to select a repository.',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [sensitivity, setSensitivity] = useState(0.001);
  const [viewport, setViewport] = useState({ width: 1280, height: 900 });
  const [activeNav, setActiveNav] = useState('Compare');
  const [reports, setReports] = useState<VisualDiffReport[]>([]);
  // Streamed dev-server output + rendered-page console (sidecar + visual diff),
  // for the bottom log drawer. The full record lives in per-run files on disk;
  // this in-memory buffer is capped for render performance.
  const [logEntries, setLogEntries] = useState<ServerLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);

  // Hydrate persisted state once on mount. Falls through to seeds when the
  // bridge is absent (demo mode) or the file is empty (first run).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await bridge?.loadState?.();
        if (cancelled || !saved) return;
        if (saved.mockEdits) setMockEdits(saved.mockEdits);
        if (saved.disabledMocks) setDisabledMockKeys(saved.disabledMocks);
        if (typeof saved.mocksEnabled === 'boolean') setMocksEnabled(saved.mocksEnabled);
        if (saved.settings) {
          const s = saved.settings;
          if (typeof s.githubOrg === 'string') setGithubOrg(s.githubOrg);
          // No GitHub token is persisted or collected in the UI; it's resolved at
          // use-time in the main process from env vars / `gh auth token`.
          if (typeof s.sensitivity === 'number') setSensitivity(s.sensitivity);
          if (s.viewport) setViewport(s.viewport);
        }
      } catch {
        // Ignore — keep seed defaults.
      } finally {
        if (!cancelled) setStateHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Dev/test seam: if the main process seeded a workspace (DEEP_DIFF_WORKSPACE),
  // auto-open it on mount — no native folder dialog — so the full flow is
  // automatable over CDP. No-op in normal use (returns null).
  useEffect(() => {
    if (!bridge?.getSeededWorkspace) return;
    void (async () => {
      try {
        const seeded = await bridge.getSeededWorkspace();
        if (!seeded) return;
        setWorkspacePath(seeded.workspacePath);
        setRepositories(seeded.repositories);
        if (seeded.repositories[0]) await hydrateRepository(seeded.repositories[0]);
      } catch {
        /* ignore */
      }
    })();
    // Run once on mount; hydrateRepository is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist UI state (debounced) after hydration. Skips the pre-hydration render
  // so seeds never clobber a saved file.
  useEffect(() => {
    if (!stateHydrated || !bridge?.saveState) return;
    const timer = window.setTimeout(() => {
      void bridge.saveState({
        version: 2,
        mockEdits,
        disabledMocks: disabledMockKeys,
        mocksEnabled,
        settings: { githubOrg, sensitivity, viewport },
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [stateHydrated, mockEdits, disabledMockKeys, mocksEnabled, githubOrg, sensitivity, viewport]);

  useEffect(() => {
    if (!bridge?.onServerLog) return;
    return bridge.onServerLog((entry) => {
      setLogEntries((prev) => {
        const next = prev.length >= 3000 ? prev.slice(prev.length - 2999) : prev.slice();
        next.push(entry);
        return next;
      });
    });
  }, []);

  // Endpoints discovered at runtime (sidecar proxy) or captured with a real body
  // (network interceptor) join the inventory as mockable rows. New keys are added
  // (reapplying saved edits); for an existing key, a freshly CAPTURED real body
  // upgrades a synthetic mock in place — unless the user has edited it (their edit
  // wins) or it's a body-less proxy-discovery hit (which never clobbers a richer
  // scanned definition).
  useEffect(() => {
    if (!bridge?.onObservedEndpoints) return;
    return bridge.onObservedEndpoints((endpoint) => {
      setEndpoints((prev) => {
        const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
        const idx = prev.findIndex(
          (existing) => `${existing.method.toUpperCase()}:${existing.path}` === key,
        );
        if (idx === -1) {
          const [withEdits] = withMockEdits([endpoint], mockEditsRef.current);
          return [...prev, withEdits];
        }
        if (endpoint.framework !== 'observed (captured)' || mockEditsRef.current[key]) {
          return prev;
        }
        const next = prev.slice();
        next[idx] = { ...next[idx], mock: endpoint.mock, framework: endpoint.framework };
        return next;
      });
    });
  }, []);

  const filteredEndpoints = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return endpoints;
    return endpoints.filter(
      (endpoint) =>
        endpoint.path.toLowerCase().includes(query) ||
        endpoint.method.toLowerCase().includes(query) ||
        endpoint.framework.toLowerCase().includes(query),
    );
  }, [endpoints, search]);

  const selectedEndpoint =
    endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? endpoints[0];

  // The live override map sent to the sidecar/diff: every detected endpoint that the
  // user hasn't turned off, with its edited body (mockEdits) or generated fallback.
  const disabledSet = useMemo(() => new Set(disabledMockKeys), [disabledMockKeys]);
  const effectiveOverrides = useMemo(() => {
    const overrides: Record<string, MockBody> = {};
    for (const endpoint of endpoints) {
      const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
      if (disabledSet.has(key)) continue;
      overrides[key] = mockEdits[key] ?? endpoint.mock;
    }
    return overrides;
  }, [endpoints, disabledSet, mockEdits]);
  const enabledMockCount = Object.keys(effectiveOverrides).length;
  const mocksLabel = mocksEnabled
    ? `${enabledMockCount} of ${endpoints.length} endpoint mocks active`
    : 'Mocks paused';

  async function hydrateRepository(repo: RepositorySummary) {
    setSelectedRepo(repo);
    setMessage(`${repo.fullName} selected.`);

    const nextBase = repo.defaultBranch ?? 'main';
    setBaseBranch(nextBase);

    if (repo.source === 'local' && repo.path && bridge) {
      // Create the per-repo overlay folder now (don't wait for a diff) so it exists and
      // its path is known the moment a local repo is selected. Fire-and-forget; optional
      // so a partial bridge (e.g. the Cypress mock) doesn't break selection.
      void bridge
        .overlayFolder?.(repo.path, false)
        .then(setOverlayPath, () => setOverlayPath(null));
      try {
        setBusy('Scanning local repository');
        const [localBranches, detectedEndpoints] = await Promise.all([
          bridge.listLocalBranches(repo.path),
          bridge.scanEndpoints(repo.path),
        ]);
        const branchOptions = localBranches.length ? localBranches : [nextBase];
        setBranches([...branchOptions, workingTreeRef]);
        setTargetBranch(localBranches.find((branch) => branch !== nextBase) ?? workingTreeRef);
        setEndpoints(
          withMockEdits(
            detectedEndpoints.length ? detectedEndpoints : seedEndpoints,
            mockEditsRef.current,
          ),
        );
        setSelectedEndpointId((detectedEndpoints[0] ?? seedEndpoints[0]).id);
        setDiffReport(null);
        setSelectedReportRouteId(null);
        setMessage(
          detectedEndpoints.length
            ? `${detectedEndpoints.length} endpoints detected from ${repo.name}.`
            : 'No endpoints detected yet. Seed mocks are loaded so the workflow remains usable.',
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Local repository scan failed.');
      } finally {
        setBusy(null);
      }
      return;
    }

    if (repo.source === 'github' && repo.owner && bridge?.cloneAndOpen) {
      setOverlayPath(null);
      try {
        setBusy(`Cloning ${repo.fullName}…`);
        // Clone the remote repo to a temp dir; it comes back as a local repo with
        // a real path, then hydrates (scan + branches) exactly like a local one.
        const cloned = await bridge.cloneAndOpen({ owner: repo.owner, repository: repo.name });
        await hydrateRepository(cloned);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Failed to clone the repository.');
        setBusy(null);
      }
      return;
    }

    setBranches(seedBranches);
    setEndpoints(seedEndpoints);
    setDiffReport(null);
    setSelectedReportRouteId(null);
    setOverlayPath(null);
  }

  // Create (if needed) and open the selected local repo's overlay folder in the OS file
  // manager. Self-diagnosing: if the bridge isn't loaded (demo mode), say so explicitly
  // rather than doing nothing.
  async function openOverlayFolder() {
    if (!bridge?.overlayFolder) {
      setMessage('Overlay folder unavailable — Electron bridge not loaded (demo mode).');
      return;
    }
    if (!selectedRepo.path) {
      setMessage('Select a local repository to use an overlay folder.');
      return;
    }
    try {
      const dir = await bridge.overlayFolder(selectedRepo.path, true);
      setOverlayPath(dir);
      setMessage(`Overlay folder: ${dir}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open the overlay folder.');
    }
  }

  async function chooseWorkspace() {
    if (!bridge) {
      setWorkspacePath('/demo/acme-pizza');
      setRepositories(seedRepositories.filter((repo) => repo.source === 'local'));
      setMessage('Demo workspace loaded. Run the Electron app to use the native folder picker.');
      return;
    }

    try {
      setBusy('Opening folder picker');
      const selection = await bridge.selectWorkspace();
      if (!selection) return;
      setWorkspacePath(selection.workspacePath);
      setRepositories(selection.repositories);
      if (selection.repositories[0]) {
        await hydrateRepository(selection.repositories[0]);
      } else {
        setMessage('No Git repositories were found in that folder.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Workspace selection failed.');
    } finally {
      setBusy(null);
    }
  }

  async function fetchGitHubRepositories() {
    if (!githubOrg.trim()) {
      setMessage('Enter a GitHub organization first.');
      return;
    }

    if (!bridge) {
      const demoRepos = seedRepositories.filter((repo) => repo.source === 'github');
      setRepositories(demoRepos);
      await hydrateRepository(demoRepos[0]);
      setMessage('Demo GitHub organization loaded. Run the Electron app to call GitHub directly.');
      return;
    }

    try {
      setBusy('Fetching GitHub repositories');
      const remoteRepos = await bridge.fetchGitHubRepos({
        organization: githubOrg,
      });
      setRepositories(remoteRepos);
      if (remoteRepos[0]) await hydrateRepository(remoteRepos[0]);
      setMessage(`${remoteRepos.length} repositories loaded from ${githubOrg}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'GitHub repository fetch failed.');
    } finally {
      setBusy(null);
    }
  }

  async function runVisualDiff() {
    if (!bridge?.runVisualDiff || !selectedRepo.path) {
      setMessage('Open a local repository in Electron before running a real visual diff.');
      return;
    }

    setDiffStatus('running');
    setDiffReport(null);
    setSelectedReportRouteId(null);
    setMessage(
      `Comparing ${branchLabel(targetBranch)} against ${branchLabel(baseBranch)} with ${mocksLabel.toLowerCase()}.`,
    );
    setBusy('Capturing baseline and target pages');

    try {
      const report = await bridge.runVisualDiff({
        repoPath: selectedRepo.path,
        baseRef: toRunRef(baseBranch),
        targetRef: toRunRef(targetBranch),
        viewport,
        mismatchTolerance: sensitivity,
        endpointOverrides: mocksEnabled ? effectiveOverrides : undefined,
        // Keys the user edited — the diff pre-flight won't overwrite these with
        // freshly-captured real bodies.
        userMockKeys: Object.keys(mockEdits),
      });
      setDiffReport(report);
      setReports((prev) => [report, ...prev]);
      setSelectedReportRouteId(report.routes[0]?.id ?? null);
      setDiffStatus(report.changedRoutes > 0 ? 'failed' : 'passed');
      setMessage(
        report.changedRoutes > 0
          ? `${report.changedRoutes} of ${report.totalRoutes} routes changed.`
          : `${report.totalRoutes} routes captured with no visual differences.`,
      );
    } catch (error) {
      setDiffStatus('failed');
      setMessage(error instanceof Error ? error.message : 'Visual diff failed.');
      // A diff failure is usually a dev server that never came up — surface the
      // captured output so the cause is visible.
      setLogsOpen(true);
    } finally {
      setBusy(null);
    }
  }

  async function launchSidecar() {
    if (bridge) {
      if (!selectedRepo.path) {
        setMessage('Open a local repository before launching the sidecar.');
        return;
      }
      try {
        setBusy('Launching sidecar');
        const nextStatus = await bridge.launchSidecar({
          repoPath: selectedRepo.path,
          branch: targetBranch === workingTreeRef ? undefined : targetBranch,
          endpointOverrides: mocksEnabled ? effectiveOverrides : undefined,
        });
        setSidecar(nextStatus);
        setMessage(`Sidecar running at ${nextStatus.url}.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Sidecar launch failed.');
        setLogsOpen(true);
      } finally {
        setBusy(null);
      }
      return;
    }

    const demoStatus = {
      running: true,
      url: 'http://127.0.0.1:54321',
      port: 54321,
      pid: 4312,
      command: 'pnpm run dev',
      startedAt: new Date().toISOString(),
    };
    setSidecar(demoStatus);
    setMessage(
      'Demo sidecar is running. Select a local repository in Electron to launch a real process.',
    );
  }

  async function stopSidecar() {
    if (bridge) {
      setSidecar(await bridge.stopSidecar());
    } else {
      setSidecar({ running: false });
    }
    setMessage('Sidecar stopped.');
  }

  // Flip one endpoint's mock on/off. Mocks are ON by default, so a flip records the
  // deviation in disabledMockKeys (off) or clears it (on). A running sidecar reflects
  // this live: SidecarPanel watches `effectiveOverrides` and pushes them to the proxy
  // via `setSidecarOverrides`, then reloads the preview. A diff run reads them at run
  // time. New endpoints from a later scan/runtime-discovery are enabled automatically.
  function toggleMock(endpoint: EndpointDefinition) {
    const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
    setDisabledMockKeys((current) =>
      current.includes(key) ? current.filter((existing) => existing !== key) : [...current, key],
    );
  }

  // Bulk enable/disable every currently-detected endpoint's mock.
  function setAllMocks(enabled: boolean) {
    setDisabledMockKeys(
      enabled
        ? []
        : endpoints.map((endpoint) => `${endpoint.method.toUpperCase()}:${endpoint.path}`),
    );
  }

  // Edit a mock body. Recorded in mockEdits (survives rescan/restart) and folded into
  // the live inventory so the editor and effectiveOverrides reflect it immediately.
  function editEndpointMock(endpoint: EndpointDefinition, body: MockBody) {
    const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
    setEndpoints((current) =>
      current.map((item) => (item.id === endpoint.id ? { ...item, mock: body } : item)),
    );
    setMockEdits((current) => ({ ...current, [key]: body }));
  }

  return (
    <div className="app-shell">
      <aside className="nav-rail">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img src="/brand/mark-primary.svg" alt="" />
          </div>
          <span>Deep Diff</span>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                className={cx('nav-item', activeNav === item.label && 'active')}
                type="button"
                onClick={() => setActiveNav(item.label)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="rail-status">
          <span className={cx('live-dot', sidecar.running && 'running')} />
          <div>
            <strong>{sidecar.running ? 'Sidecar running' : 'Sidecar idle'}</strong>
            <small>{sidecar.url ?? 'No local server'}</small>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-label">Workspace</span>
            <strong>{workspacePath}</strong>
          </div>
          <div className="topbar-actions">
            <button className="ghost-button" type="button" onClick={chooseWorkspace}>
              <FolderOpen size={16} />
              Open folder
            </button>
            <button className="ghost-button" type="button" onClick={fetchGitHubRepositories}>
              <Github size={16} />
              Fetch GitHub org
            </button>
            {selectedRepo.path && (
              <button
                className="ghost-button"
                type="button"
                onClick={openOverlayFolder}
                title={overlayPath ?? 'Open the overlay folder for this repository'}
              >
                <FolderOpen size={16} />
                Overlay folder
              </button>
            )}
            <button
              className={cx('ghost-button', logsOpen && 'active')}
              type="button"
              onClick={() => setLogsOpen((value) => !value)}
              title="Show captured dev-server output and page console"
            >
              <TerminalSquare size={16} />
              Logs
              {logEntries.some((entry) => entry.stream === 'stderr' || entry.level === 'error') && (
                <span className="logs-badge">
                  {
                    logEntries.filter(
                      (entry) => entry.stream === 'stderr' || entry.level === 'error',
                    ).length
                  }
                </span>
              )}
            </button>
          </div>
        </header>

        <section className="status-strip">
          <StatusPill status={diffStatus} />
          <span>{message}</span>
          {busy && (
            <span className="busy-note">
              <Loader2 size={14} className="spin" />
              {busy}
            </span>
          )}
        </section>

        {activeNav === 'Compare' && (
          <div className="content-grid">
            <section className="left-panel">
              <RepositoryControls
                sourceMode={sourceMode}
                setSourceMode={setSourceMode}
                repositories={repositories}
                selectedRepo={selectedRepo}
                onSelectRepository={hydrateRepository}
                branches={branches}
                baseBranch={baseBranch}
                targetBranch={targetBranch}
                setBaseBranch={setBaseBranch}
                setTargetBranch={setTargetBranch}
                githubOrg={githubOrg}
                setGithubOrg={setGithubOrg}
                chooseWorkspace={chooseWorkspace}
                fetchGitHubRepositories={fetchGitHubRepositories}
                runVisualDiff={runVisualDiff}
                diffStatus={diffStatus}
              />

              <MockInventory
                endpoints={filteredEndpoints}
                total={endpoints.length}
                enabledCount={enabledMockCount}
                search={search}
                setSearch={setSearch}
                selectedEndpointId={selectedEndpointId}
                setSelectedEndpointId={setSelectedEndpointId}
                disabledKeys={disabledSet}
                mocksEnabled={mocksEnabled}
                onToggleMocksEnabled={setMocksEnabled}
                onToggleMock={toggleMock}
                onSetAll={setAllMocks}
                onEditMock={editEndpointMock}
              />
            </section>

            <ComparisonWorkspace
              baseBranch={baseBranch}
              targetBranch={targetBranch}
              diffStatus={diffStatus}
              mocksLabel={mocksLabel}
              report={diffReport}
              selectedRouteId={selectedReportRouteId}
              setSelectedRouteId={setSelectedReportRouteId}
              sensitivity={sensitivity}
              setSensitivity={setSensitivity}
              viewport={viewport}
              setViewport={setViewport}
            />

            <SidecarPanel
              sidecar={sidecar}
              selectedEndpoint={selectedEndpoint}
              onLaunch={launchSidecar}
              onStop={stopSidecar}
              endpoints={endpoints}
              repoPath={selectedRepo.path}
              baseRef={toRunRef(baseBranch)}
              targetRef={toRunRef(targetBranch)}
              mocksEnabled={mocksEnabled}
              effectiveOverrides={effectiveOverrides}
              disabledKeys={disabledSet}
              onToggleMocksEnabled={setMocksEnabled}
              onToggleMock={toggleMock}
              onSidecarStatus={setSidecar}
            />
          </div>
        )}

        {activeNav === 'Endpoints' && (
          <div className="content-view">
            <MockInventory
              endpoints={filteredEndpoints}
              total={endpoints.length}
              enabledCount={enabledMockCount}
              search={search}
              setSearch={setSearch}
              selectedEndpointId={selectedEndpointId}
              setSelectedEndpointId={setSelectedEndpointId}
              disabledKeys={disabledSet}
              mocksEnabled={mocksEnabled}
              onToggleMocksEnabled={setMocksEnabled}
              onToggleMock={toggleMock}
              onSetAll={setAllMocks}
              onEditMock={editEndpointMock}
            />
          </div>
        )}

        {activeNav === 'Sidecar' && (
          <div className="content-view">
            <SidecarPanel
              sidecar={sidecar}
              selectedEndpoint={selectedEndpoint}
              onLaunch={launchSidecar}
              onStop={stopSidecar}
              endpoints={endpoints}
              repoPath={selectedRepo.path}
              baseRef={toRunRef(baseBranch)}
              targetRef={toRunRef(targetBranch)}
              mocksEnabled={mocksEnabled}
              effectiveOverrides={effectiveOverrides}
              disabledKeys={disabledSet}
              onToggleMocksEnabled={setMocksEnabled}
              onToggleMock={toggleMock}
              onSidecarStatus={setSidecar}
            />
          </div>
        )}

        {activeNav === 'Reports' && <ReportsView reports={reports} />}

        {activeNav === 'Settings' && (
          <SettingsView
            workspacePath={workspacePath}
            githubOrg={githubOrg}
            viewport={viewport}
            sensitivity={sensitivity}
            onChangeGithubOrg={setGithubOrg}
            onChangeViewport={setViewport}
            onChangeSensitivity={setSensitivity}
            repoPath={selectedRepo.path ?? ''}
          />
        )}
      </main>

      <LogDrawer
        entries={logEntries}
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        onClear={() => setLogEntries([])}
        revealFile={diffReport?.logFile ?? sidecar.logFile}
      />
    </div>
  );
}

function RepositoryControls({
  sourceMode,
  setSourceMode,
  repositories,
  selectedRepo,
  onSelectRepository,
  branches,
  baseBranch,
  targetBranch,
  setBaseBranch,
  setTargetBranch,
  githubOrg,
  setGithubOrg,
  chooseWorkspace,
  fetchGitHubRepositories,
  runVisualDiff,
  diffStatus,
}: {
  sourceMode: 'local' | 'github';
  setSourceMode: (source: 'local' | 'github') => void;
  repositories: RepositorySummary[];
  selectedRepo: RepositorySummary;
  onSelectRepository: (repo: RepositorySummary) => Promise<void>;
  branches: string[];
  baseBranch: string;
  targetBranch: string;
  setBaseBranch: (branch: string) => void;
  setTargetBranch: (branch: string) => void;
  githubOrg: string;
  setGithubOrg: (org: string) => void;
  chooseWorkspace: () => Promise<void>;
  fetchGitHubRepositories: () => Promise<void>;
  runVisualDiff: () => Promise<void>;
  diffStatus: DiffStatus;
}) {
  const visibleRepositories = repositories.filter((repo) => repo.source === sourceMode);

  return (
    <div className="panel-section">
      <div className="section-heading">
        <div>
          <h2>Repository</h2>
          <p>Select a local clone or fetch repositories from GitHub.</p>
        </div>
      </div>

      <ToggleGroup
        className="segmented-control"
        value={[sourceMode]}
        onValueChange={(value) => {
          // Single-select: ignore an empty array (deselecting the active item) —
          // a source mode must always be set.
          const next = value[0];
          if (next === 'local' || next === 'github') setSourceMode(next);
        }}
      >
        <ToggleGroupItem
          value="local"
          className={cx(sourceMode === 'local' && 'selected')}
          aria-label="Local repositories"
        >
          <FolderOpen size={15} />
          Local
        </ToggleGroupItem>
        <ToggleGroupItem
          value="github"
          className={cx(sourceMode === 'github' && 'selected')}
          aria-label="GitHub organization"
        >
          <Github size={15} />
          GitHub org
        </ToggleGroupItem>
      </ToggleGroup>

      {sourceMode === 'local' ? (
        <button className="wide-secondary" type="button" onClick={chooseWorkspace}>
          <FolderOpen size={16} />
          Open repository folder
        </button>
      ) : (
        <div className="github-form">
          <label>
            <span>Organization</span>
            <input value={githubOrg} onChange={(event) => setGithubOrg(event.target.value)} />
          </label>
          <button className="wide-secondary" type="button" onClick={fetchGitHubRepositories}>
            <RefreshCcw size={16} />
            Fetch repositories
          </button>
        </div>
      )}

      <label className="field-label">
        <span>Repository</span>
        <FilterCombobox
          items={visibleRepositories}
          value={selectedRepo}
          onValueChange={(repo) => void onSelectRepository(repo)}
          itemToLabel={(repo) => repo.fullName}
          itemToKey={(repo) => repo.id}
          placeholder="Filter by name…"
          ariaLabel="Repository"
          emptyMessage="No repositories match"
          showClear
          data-testid="repo-combobox"
        />
      </label>

      <div className="branch-grid">
        <label className="field-label">
          <span>Base branch</span>
          <FilterCombobox
            items={branches}
            value={baseBranch}
            onValueChange={setBaseBranch}
            itemToLabel={branchLabel}
            placeholder="Filter branches…"
            ariaLabel="Base branch"
            emptyMessage="No branches match"
            data-testid="base-branch-combobox"
          />
        </label>
        <label className="field-label">
          <span>Target branch</span>
          <FilterCombobox
            items={branches}
            value={targetBranch}
            onValueChange={setTargetBranch}
            itemToLabel={branchLabel}
            placeholder="Filter branches…"
            ariaLabel="Target branch"
            emptyMessage="No branches match"
            data-testid="target-branch-combobox"
          />
        </label>
      </div>

      <button
        className="primary-action"
        type="button"
        onClick={runVisualDiff}
        disabled={diffStatus === 'running'}
        data-testid="run-visual-diff"
      >
        {diffStatus === 'running' ? <Loader2 size={17} className="spin" /> : <Play size={17} />}
        Run visual diff
      </button>
    </div>
  );
}

// Read view (syntax-highlighted JSON) + inline textarea editor for a single
// mock body. Validates that the draft parses to a JSON object before saving.
function MockBodyEditor({
  body,
  editable,
  hint,
  onSave,
}: {
  body: MockBody;
  editable: boolean;
  hint?: string;
  onSave: (body: MockBody) => void;
}) {
  const pretty = useMemo(() => JSON.stringify(body ?? {}, null, 2), [body]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pretty);
  const [error, setError] = useState<string | null>(null);

  function start() {
    setDraft(pretty);
    setError(null);
    setEditing(true);
  }

  function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError('Invalid JSON.');
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      setError('Mock body must be a JSON object or array.');
      return;
    }
    onSave(parsed);
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <div className="mock-body">
        <pre
          className="mock-json"
          dangerouslySetInnerHTML={{ __html: highlightJsonHtml(pretty) }}
        />
        {editable && (
          <button type="button" className="mock-edit-btn" onClick={start}>
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mock-body editing">
      <textarea
        className="mock-json-edit"
        value={draft}
        spellCheck={false}
        rows={Math.min(18, draft.split('\n').length + 1)}
        onChange={(event) => setDraft(event.target.value)}
      />
      {hint && <p className="mock-edit-hint">{hint}</p>}
      {error && <p className="mock-edit-error">{error}</p>}
      <div className="mock-edit-actions">
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
        >
          Cancel
        </button>
        <button type="button" className="primary-action" onClick={save}>
          Save mock
        </button>
      </div>
    </div>
  );
}

// The single live mock surface: every detected endpoint is mocked by default. Each
// row toggles its mock on/off (a deviation tracked in disabledKeys) and expands to an
// editable response body. A master switch pauses the whole set; bulk actions flip all.
function MockInventory({
  endpoints,
  total,
  enabledCount,
  search,
  setSearch,
  selectedEndpointId,
  setSelectedEndpointId,
  disabledKeys,
  mocksEnabled,
  onToggleMocksEnabled,
  onToggleMock,
  onSetAll,
  onEditMock,
}: {
  endpoints: EndpointDefinition[];
  total: number;
  enabledCount: number;
  search: string;
  setSearch: (query: string) => void;
  selectedEndpointId: string;
  setSelectedEndpointId: (id: string) => void;
  disabledKeys: Set<string>;
  mocksEnabled: boolean;
  onToggleMocksEnabled: (value: boolean) => void;
  onToggleMock: (endpoint: EndpointDefinition) => void;
  onSetAll: (enabled: boolean) => void;
  onEditMock: (endpoint: EndpointDefinition, body: MockBody) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className={cx('panel-section endpoint-section', !mocksEnabled && 'mocks-paused')}>
      <div className="section-heading inline">
        <div>
          <h2>Endpoint mocks</h2>
          <p>
            {enabledCount} of {total} mocked
            {mocksEnabled ? '' : ' · paused'}
          </p>
        </div>
        <Toggle
          checked={mocksEnabled}
          onChange={() => onToggleMocksEnabled(!mocksEnabled)}
          label="Enable all endpoint mocks"
        />
      </div>

      <div className="mock-bulk-actions">
        <button type="button" className="icon-text-button" onClick={() => onSetAll(true)}>
          <ToggleRight size={14} />
          Enable all
        </button>
        <button type="button" className="icon-text-button" onClick={() => onSetAll(false)}>
          <ToggleLeft size={14} />
          Disable all
        </button>
      </div>

      <label className="search-box">
        <Search size={15} />
        <input
          value={search}
          placeholder="Search endpoints"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      <div className="endpoint-list">
        {endpoints.length === 0 && (
          <p className="profile-mocks-empty">No endpoints detected yet.</p>
        )}
        {endpoints.map((endpoint) => {
          const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
          const on = !disabledKeys.has(key);
          const isOpen = expanded.has(endpoint.id);
          return (
            <div key={endpoint.id} className="mock-row-block">
              <div
                className={cx(
                  'endpoint-row mock-row',
                  selectedEndpointId === endpoint.id && 'selected',
                  !on && 'mock-off',
                )}
              >
                <button
                  type="button"
                  className="mock-row-main"
                  onClick={() => {
                    setSelectedEndpointId(endpoint.id);
                    toggleExpand(endpoint.id);
                  }}
                  aria-expanded={isOpen}
                >
                  <MethodPill method={endpoint.method} />
                  <span className="mock-row-path" title={endpoint.path}>
                    {endpoint.path}
                  </span>
                  <small className="mock-row-framework">{endpoint.framework}</small>
                  {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                <Toggle
                  checked={on}
                  onChange={() => onToggleMock(endpoint)}
                  label={`Mock ${endpoint.method} ${endpoint.path}`}
                />
              </div>
              {isOpen && (
                <MockBodyEditor
                  body={endpoint.mock ?? {}}
                  editable
                  hint={`${endpoint.method} ${endpoint.path}`}
                  onSave={(next) => onEditMock(endpoint, next)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ComparisonWorkspace({
  baseBranch,
  targetBranch,
  diffStatus,
  mocksLabel,
  report,
  selectedRouteId,
  setSelectedRouteId,
  sensitivity,
  setSensitivity,
  viewport,
  setViewport,
}: {
  baseBranch: string;
  targetBranch: string;
  diffStatus: DiffStatus;
  mocksLabel: string;
  report: VisualDiffReport | null;
  selectedRouteId: string | null;
  setSelectedRouteId: (id: string) => void;
  sensitivity: number;
  setSensitivity: (v: number) => void;
  viewport: { width: number; height: number };
  setViewport: (v: { width: number; height: number }) => void;
}) {
  const selectedRoute =
    report?.routes.find((route) => route.id === selectedRouteId) ?? report?.routes[0];
  const vpKey = viewportKey(viewport);

  return (
    <section className="compare-workspace" data-testid="comparison-workspace">
      <div className="compare-toolbar">
        <div>
          <h1>Visual comparison</h1>
          <p>
            {report
              ? `${report.totalRoutes} captured routes at ${report.viewport.width}x${report.viewport.height}`
              : 'No report captured yet.'}
          </p>
        </div>
        <div className="toolbar-controls">
          <ToggleGroup
            className="viewport-group"
            value={vpKey ? [vpKey] : []}
            onValueChange={(value) => {
              const key = value[0];
              if (key && key in VIEWPORT_PRESETS) setViewport(VIEWPORT_PRESETS[key as ViewportKey]);
            }}
          >
            <ToggleGroupItem
              value="desktop"
              className={cx('icon-button', vpKey === 'desktop' && 'selected')}
              aria-label="Desktop viewport"
            >
              <Monitor size={17} />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="laptop"
              className={cx('icon-button', vpKey === 'laptop' && 'selected')}
              aria-label="Laptop viewport"
            >
              <Laptop size={17} />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="mobile"
              className={cx('icon-button', vpKey === 'mobile' && 'selected')}
              aria-label="Mobile viewport"
            >
              <Smartphone size={17} />
            </ToggleGroupItem>
          </ToggleGroup>
          <Select.Root
            items={SENSITIVITY_ITEMS}
            value={sensitivity}
            onValueChange={(value) => setSensitivity(value ?? 0)}
          >
            <Select.Trigger
              className="ghost-button compact"
              title="Tolerance — percentage of pixels that may differ before a route is marked changed"
            >
              <SlidersHorizontal size={16} />
              <span>Sensitivity</span>
              <Select.Value>{(value: number) => formatSensitivityPct(value)}</Select.Value>
              <Select.Icon className="combobox-icon-btn">
                <ChevronDown size={14} />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner className="combobox-positioner" sideOffset={4}>
                <Select.Popup className="combobox-popup">
                  <Select.List>
                    {SENSITIVITY_ITEMS.map((item) => (
                      <Select.Item key={item.value} value={item.value} className="combobox-item">
                        <Select.ItemText>{item.label}</Select.ItemText>
                        <Select.ItemIndicator className="combobox-item-indicator">
                          <Check size={14} />
                        </Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </div>
      </div>

      <div className="comparison-header">
        <div>
          <span>Baseline</span>
          <strong>
            <GitBranch size={14} />
            {report?.baseRef ?? branchLabel(baseBranch)}
          </strong>
        </div>
        <div>
          <span>Current</span>
          <strong>
            <GitBranch size={14} />
            {report?.targetRef ?? branchLabel(targetBranch)}
          </strong>
        </div>
      </div>

      {report && (
        <div className="report-route-strip" data-testid="report-route-strip">
          {report.routes.map((route) => (
            <button
              key={route.id}
              type="button"
              data-testid={`report-route${route.path.replace(/\//g, '-') || '-root'}`}
              className={cx(
                'report-route-button',
                selectedRoute?.id === route.id && 'selected',
                route.status,
              )}
              onClick={() => setSelectedRouteId(route.id)}
            >
              <span>{route.path}</span>
              <small>
                {route.status === 'failed' ? formatMismatch(route.mismatchRatio) : route.status}
              </small>
            </button>
          ))}
        </div>
      )}

      <div className={cx('browser-compare', Boolean(report) && 'report-compare')}>
        {selectedRoute && report ? (
          <>
            <ScreenshotFrame
              title="Baseline"
              branch={report.baseRef}
              url={`${report.baseUrl}${selectedRoute.urlPath}`}
              image={selectedRoute.beforeImage}
              route={selectedRoute}
              testId="screenshot-baseline"
            />
            <ScreenshotFrame
              title="Current"
              branch={report.targetRef}
              url={`${report.targetUrl}${selectedRoute.urlPath}`}
              image={selectedRoute.afterImage}
              route={selectedRoute}
              testId="screenshot-current"
            />
            <ScreenshotFrame
              title="Diff"
              branch={`${selectedRoute.mismatchPixels.toLocaleString()} changed pixels`}
              url={selectedRoute.path}
              image={selectedRoute.diffImage}
              route={selectedRoute}
              wide
              testId="screenshot-diff"
            />
          </>
        ) : (
          <div className="empty-report" data-testid="empty-report">
            <ClipboardList size={30} />
            <strong>
              {diffStatus === 'running' ? 'Capturing report' : 'No visual report yet'}
            </strong>
            <span>{mocksLabel} for the next comparison run.</span>
          </div>
        )}
      </div>

      <footer className="diff-footer">
        <span className="difference-count" data-testid="diff-footer-count">
          <AlertTriangle size={15} />
          {report
            ? `${report.changedRoutes}/${report.totalRoutes} routes changed`
            : diffStatus === 'running'
              ? 'Capturing'
              : 'No report'}
        </span>
        <div className="legend">
          <span>
            <i className="legend-content" />
            Pixel diff
          </span>
          <span>
            <i className="legend-layout" />
            Baseline
          </span>
          <span>
            <i className="legend-other" />
            Current
          </span>
        </div>
      </footer>
    </section>
  );
}

function ScreenshotFrame({
  title,
  branch,
  url,
  image,
  route,
  wide,
  testId,
}: {
  title: string;
  branch: string;
  url: string;
  image: string;
  route: VisualDiffRouteReport;
  wide?: boolean;
  testId?: string;
}) {
  return (
    <article className={cx('browser-frame', 'report-frame', wide && 'wide')} data-testid={testId}>
      <div className="frame-top">
        <div>
          <Circle size={8} fill="currentColor" />
          <Circle size={8} fill="currentColor" />
          <Circle size={8} fill="currentColor" />
        </div>
        <span>{url}</span>
        <RefreshCcw size={13} />
      </div>
      <div className="site-preview report-preview">
        <div className="report-shot-meta">
          <strong>{title}</strong>
          <span>{branch}</span>
        </div>
        {route.status === 'error' ? (
          <div className="route-error">{route.error}</div>
        ) : (
          <img src={image} alt={`${title} screenshot for ${route.path}`} />
        )}
      </div>
    </article>
  );
}

// Minimal shape of the Electron <webview> element we use (avoids depending on
// Electron.WebviewTag types in the renderer program).
interface PreviewWebview extends HTMLElement {
  reload(): void;
  getURL(): string;
  openDevTools(): void;
  executeJavaScript(code: string): Promise<unknown>;
}

// Runs inside the sidecar <webview>. Patches console.* so object arguments are
// JSON-stringified BEFORE the real console call — otherwise Chromium collapses
// them to "[object Object]" before the `console-message` event we capture fires,
// and the object content is unrecoverable on our side. Idempotent (guards a flag).
const CONSOLE_PATCH_SCRIPT = `(() => {
  if (window.__ddsConsolePatched) return;
  window.__ddsConsolePatched = true;
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (a === null || a === undefined || typeof a !== 'object') return String(a);
    try { return JSON.stringify(a, null, 2); } catch (_e) { return String(a); }
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[m];
    if (typeof orig !== 'function') continue;
    console[m] = (...args) => orig.apply(console, args.map(fmt));
  }
})();`;

// Runs inside the sidecar <webview>. Walks the DOM and reads each visible
// element's source origin from (a) an explicit data attribute, or (b) the React
// dev-build fiber's `_debugSource` (fileName + line). Returns JSON-serializable
// probes; the main process matches them against the changed-file set.
const CHANGE_PROBE_SCRIPT = `(() => {
  const out = [];
  const attrSource = (el) =>
    el.getAttribute('data-dds-source') ||
    el.getAttribute('data-source') ||
    el.getAttribute('data-inspector-relative-path') || '';
  const fiberSource = (el) => {
    for (const key in el) {
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
        let fiber = el[key];
        let depth = 0;
        while (fiber && depth < 40) {
          const src = fiber._debugSource;
          if (src && src.fileName) {
            return src.fileName + (src.lineNumber ? ':' + src.lineNumber : '');
          }
          fiber = fiber._debugOwner || fiber.return;
          depth++;
        }
      }
    }
    return '';
  };
  const nodes = document.body ? document.body.querySelectorAll('*') : [];
  let id = 0;
  for (const el of nodes) {
    const source = attrSource(el) || fiberSource(el);
    if (!source) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({
      id: 'el' + id++,
      sourcePath: source,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      tag: el.tagName.toLowerCase(),
    });
    if (id > 4000) break;
  }
  return out;
})()`;

function SidecarPanel({
  sidecar,
  selectedEndpoint,
  onLaunch,
  onStop,
  endpoints,
  repoPath,
  baseRef,
  targetRef,
  mocksEnabled,
  effectiveOverrides,
  disabledKeys,
  onToggleMocksEnabled,
  onToggleMock,
  onSidecarStatus,
}: {
  sidecar: SidecarStatus;
  selectedEndpoint?: EndpointDefinition;
  onLaunch: () => Promise<void>;
  onStop: () => Promise<void>;
  endpoints: EndpointDefinition[];
  repoPath?: string;
  baseRef: string;
  targetRef: string;
  mocksEnabled: boolean;
  effectiveOverrides: Record<string, MockBody>;
  disabledKeys: Set<string>;
  onToggleMocksEnabled: (value: boolean) => void;
  onToggleMock: (endpoint: EndpointDefinition) => void;
  onSidecarStatus: (status: SidecarStatus) => void;
}) {
  const webviewRef = useRef<PreviewWebview | null>(null);
  // Only embed a live <webview> in the real Electron app (bridge present) with a
  // running sidecar. The demo fallback sets running:true in a plain browser, so
  // gating on sidecar.running alone would mount an inert webview there.
  const canEmbed = Boolean(bridge) && sidecar.running && Boolean(sidecar.url);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // The webview is hidden until its first *successful* navigation so the user
  // never sees Chromium's connection-refused error page flash by (the sidecar
  // dev server isn't listening yet when launchSidecar returns).
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [showEndpoints, setShowEndpoints] = useState(false);
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [changeLinks, setChangeLinks] = useState<ChangeLinkResult[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [changeNote, setChangeNote] = useState<string | null>(null);

  // Highlight the on-page elements that originate from a file changed between
  // baseRef and targetRef. Probes the live webview DOM, then has the main
  // process match each element's source against the git diff. Toggles off when
  // highlights are already shown.
  async function inspectChanges() {
    if (changeLinks.length > 0) {
      setChangeLinks([]);
      setChangeNote(null);
      return;
    }
    const webview = webviewRef.current;
    if (!webview || !bridge?.linkChanges || !repoPath) return;
    setInspecting(true);
    setChangeNote(null);
    try {
      const probes = (await webview.executeJavaScript(CHANGE_PROBE_SCRIPT)) as ChangeProbe[];
      const links = await bridge.linkChanges({
        repoPath,
        baseRef,
        targetRef,
        elements: Array.isArray(probes) ? probes : [],
      });
      setChangeLinks(links);
      if (links.length === 0) {
        setChangeNote(
          probes && probes.length
            ? 'No changed-file elements on this page.'
            : 'No source-tagged elements found (needs a React dev build or data-dds-source).',
        );
      }
    } catch (err) {
      setChangeNote(err instanceof Error ? err.message : 'Failed to inspect changes.');
    } finally {
      setInspecting(false);
    }
  }

  useEffect(() => {
    const el = webviewRef.current;
    if (!el || !canEmbed) return;

    // New URL → not-yet-loaded, so the panel shows "Connecting…" and the webview
    // stays hidden until a navigation completes cleanly.
    setPreviewLoaded(false);
    setPreviewError(null);

    // did-fail-load AND did-finish-load/dom-ready all fire for Chromium's error
    // page, so "loaded" can't key off dom-ready. A navigation is a genuine
    // success only if it stops loading WITHOUT having failed — track that flag.
    let navFailed = false;
    let retryTimer: number | undefined;

    // Safety net: if a navigation somehow settles before these listeners attach
    // (e.g. a remount while the server is already up), onStop can be missed and
    // the webview would stay hidden behind "Connecting…". Never stay hidden
    // longer than this — worst case it reveals whatever the webview shows, which
    // is the pre-existing behavior anyway.
    const revealFallback = window.setTimeout(() => setPreviewLoaded(true), 8000);

    const onStart = () => {
      navFailed = false;
    };
    const onFail = (event: Event) => {
      const detail = event as unknown as { errorCode: number; isMainFrame?: boolean };
      // -3 = ABORTED (navigation superseded); ignore subframe failures too.
      if (detail.errorCode === -3 || detail.isMainFrame === false) return;
      navFailed = true;
      // launchSidecar returns before the dev server is listening, so the first
      // load(s) refuse; retry until one succeeds.
      setPreviewError('Connecting to the sidecar…');
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => webviewRef.current?.reload(), 1200);
    };
    const onStop = () => {
      if (navFailed) return; // error page — keep hidden, keep retrying
      window.clearTimeout(retryTimer);
      window.clearTimeout(revealFallback);
      setPreviewError(null);
      setPreviewLoaded(true);
    };

    // Forward the preview page's browser console into the run log (the page lives
    // in this <webview>, so its console can't be captured in the main process the
    // way the visual-diff capture window's is).
    const onConsole = (event: Event) => {
      const e = event as unknown as { level?: number; message?: string };
      bridge
        ?.appendLog?.({ text: String(e.message ?? ''), level: webviewConsoleLevel(e.level) })
        ?.catch(() => undefined);
    };

    // Patch the page's console as early as we can reach a frame so object args
    // are JSON-stringified before Chromium collapses them to "[object Object]".
    const onDomReady = () => {
      webviewRef.current?.executeJavaScript(CONSOLE_PATCH_SCRIPT).catch(() => undefined);
    };

    el.addEventListener('console-message', onConsole as EventListener);
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-fail-load', onFail as EventListener);
    el.addEventListener('did-stop-loading', onStop);
    return () => {
      window.clearTimeout(retryTimer);
      window.clearTimeout(revealFallback);
      el.removeEventListener('console-message', onConsole as EventListener);
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-fail-load', onFail as EventListener);
      el.removeEventListener('did-stop-loading', onStop);
    };
  }, [canEmbed, sidecar.url]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // The live override map sent to the proxy: the whole mock set when enabled, or an
  // empty map (full pass-through) when paused. Mirrors what launchSidecar/runVisualDiff
  // send.
  const overridesKey = useMemo(
    () => JSON.stringify(mocksEnabled ? effectiveOverrides : {}),
    [mocksEnabled, effectiveOverrides],
  );
  // The override map last pushed to (or first observed on) the running sidecar.
  // Null = no running sidecar observed yet; the first observation after a launch
  // records the launch-time state without re-pushing it.
  const lastSyncedOverridesRef = useRef<string | null>(null);

  // Keep a running sidecar's mock proxy in sync with toolbar toggles, without a
  // relaunch. On change we push the effective overrides over IPC; the main
  // process swaps the proxy's live map (bringing a proxy up the first time and
  // returning its new URL). We then reload the <webview> so the page re-fetches
  // through the proxy — or, when a proxy was just created, repoint it (changing
  // sidecar.url remounts the keyed <webview> at the new proxy URL).
  useEffect(() => {
    if (!bridge?.setSidecarOverrides || !sidecar.running) {
      lastSyncedOverridesRef.current = null;
      return;
    }
    const applyOverrides = bridge.setSidecarOverrides;
    // First run for this sidecar = the launch-time state, already applied.
    if (lastSyncedOverridesRef.current === null) {
      lastSyncedOverridesRef.current = overridesKey;
      return;
    }
    if (lastSyncedOverridesRef.current === overridesKey) return;
    lastSyncedOverridesRef.current = overridesKey;

    const nextOverrides = mocksEnabled ? effectiveOverrides : {};
    const currentUrl = sidecar.url;
    let cancelled = false;
    void (async () => {
      try {
        const next = await applyOverrides(nextOverrides);
        if (cancelled) return;
        if (next.url === currentUrl) {
          webviewRef.current?.reload();
        } else {
          onSidecarStatus(next);
        }
      } catch {
        // Best-effort: the toggle still lives in the profile and applies on the
        // next launch/diff even if this live update failed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    overridesKey,
    sidecar.running,
    sidecar.url,
    mocksEnabled,
    effectiveOverrides,
    onSidecarStatus,
  ]);

  // Drag the floating toolbar within the preview area. While dragging we set a
  // `dragging` class so the <webview> gets pointer-events:none — otherwise the
  // webview (a separate layer) swallows pointer moves and the drag stalls.
  function startToolbarDrag(event: ReactPointerEvent) {
    const container = previewRef.current;
    const toolbar = (event.target as HTMLElement).closest(
      '.floating-toolbar',
    ) as HTMLElement | null;
    if (!container || !toolbar) return;
    event.preventDefault();
    // Capture the pointer and kill the webview's pointer-events synchronously.
    // setDragging() is async, so without this the webview (a separate OS layer)
    // swallows the first moves and the drag feels sticky on grab.
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    container.classList.add('dragging');
    const startRect = toolbar.getBoundingClientRect();
    const offX = event.clientX - startRect.left;
    const offY = event.clientY - startRect.top;
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const c = container.getBoundingClientRect();
      const maxX = Math.max(0, c.width - toolbar.offsetWidth);
      const maxY = Math.max(0, c.height - toolbar.offsetHeight);
      const x = Math.min(Math.max(0, ev.clientX - c.left - offX), maxX);
      const y = Math.min(Math.max(0, ev.clientY - c.top - offY), maxY);
      setToolbarPos({ x, y });
    };
    const onUp = (ev: PointerEvent) => {
      setDragging(false);
      container.classList.remove('dragging');
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    // Listen on the capture target so moves are delivered even over the webview.
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  return (
    <aside className="right-panel">
      <section className="sidecar-card">
        <div className="section-heading inline">
          <div>
            <h2>Sidecar</h2>
            <p>{sidecar.running ? sidecar.url : 'Standalone target server'}</p>
          </div>
          <PanelRight size={18} />
        </div>

        <div className={cx('sidecar-state', sidecar.running && 'running')}>
          <span className="live-dot running" />
          <strong>{sidecar.running ? 'Running' : 'Stopped'}</strong>
          <small>{sidecar.pid ? `pid ${sidecar.pid}` : 'ready'}</small>
        </div>

        <div className="sidecar-actions">
          <button className="primary-action" type="button" onClick={onLaunch}>
            <Play size={16} />
            Launch sidecar
          </button>
          <button className="wide-secondary" type="button" onClick={onStop}>
            <StopCircle size={16} />
            Stop
          </button>
        </div>
      </section>

      <section className="sidecar-card">
        <div className="section-heading inline">
          <div>
            <h2>Selected mock</h2>
            <p>{selectedEndpoint?.path ?? 'No endpoint selected'}</p>
          </div>
          <Boxes size={18} />
        </div>
        <div className="shape-table">
          {(selectedEndpoint?.fields ?? []).map((field) => (
            <div key={field.name}>
              <span>{field.name}</span>
              <code>{field.type}</code>
              <small>{field.example}</small>
            </div>
          ))}
        </div>
      </section>

      <section className={cx('browser-preview-card', fullscreen && 'fullscreen')}>
        <div className="section-heading inline">
          <div>
            <h2>Browser preview</h2>
            <p>Floating toolbar injected over the target.</p>
          </div>
          <ExternalLink size={17} />
        </div>
        <div className="mini-browser">
          <div className="mini-url">
            <span className="mini-url-text">{sidecar.url ?? 'http://localhost:3000'}</span>
            <div className="mini-actions">
              {canEmbed && (
                <button
                  type="button"
                  className="mini-reload"
                  onClick={() => webviewRef.current?.reload()}
                  aria-label="Reload preview"
                >
                  <RefreshCcw size={13} />
                </button>
              )}
              <button
                type="button"
                className="mini-reload"
                onClick={() => setFullscreen((value) => !value)}
                aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              >
                {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            </div>
          </div>
          <div className={cx('pizza-page', dragging && 'dragging')} ref={previewRef}>
            {canEmbed ? (
              <webview
                key={sidecar.url}
                ref={(el) => {
                  webviewRef.current = el as PreviewWebview | null;
                }}
                src={sidecar.url}
                partition="sidecar-preview"
                className={cx('preview-webview', !previewLoaded && 'loading')}
              />
            ) : bridge ? (
              <div className="preview-empty">
                <span>🍕</span>
                <p>Launch the sidecar to preview the live target here.</p>
              </div>
            ) : (
              <>
                <div className="pizza-photo" />
                <div className="preview-note">Live preview is desktop-only.</div>
              </>
            )}
            {canEmbed && !previewLoaded && (
              <div className="preview-empty">
                <span>🍕</span>
                <p>{previewError ?? 'Connecting to the sidecar…'}</p>
              </div>
            )}
            {changeLinks.length > 0 && (
              <div className="change-overlays">
                {changeLinks.map((link) => (
                  <div
                    key={link.id}
                    className="change-overlay"
                    style={{
                      left: link.rect?.x ?? 0,
                      top: link.rect?.y ?? 0,
                      width: link.rect?.width ?? 0,
                      height: link.rect?.height ?? 0,
                    }}
                    title={`${link.tag ?? 'element'} ← ${link.file}`}
                  >
                    <span className="change-overlay-label">{link.file}</span>
                  </div>
                ))}
              </div>
            )}
            <div
              className={cx(
                'floating-toolbar',
                toolbarCollapsed && 'collapsed',
                dragging && 'dragging',
              )}
              style={
                toolbarPos
                  ? { left: toolbarPos.x, top: toolbarPos.y, right: 'auto', bottom: 'auto' }
                  : undefined
              }
            >
              <div className="toolbar-title" onPointerDown={startToolbarDrag}>
                <Move className="toolbar-grip" size={13} />
                <span>🍕</span>
                <strong>Deep Diff</strong>
                <button
                  type="button"
                  className="toolbar-collapse"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setToolbarCollapsed((value) => !value)}
                  aria-label={toolbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'}
                >
                  {toolbarCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {!toolbarCollapsed && (
                <>
                  <div className="toolbar-toggle">
                    <span>Mocks</span>
                    <Toggle
                      checked={mocksEnabled}
                      onChange={() => onToggleMocksEnabled(!mocksEnabled)}
                      label="Toggle all endpoint mocks"
                    />
                  </div>
                  {showEndpoints && (
                    <div className="toolbar-endpoints">
                      {endpoints.map((endpoint) => {
                        const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
                        const on = !disabledKeys.has(key);
                        return (
                          <div className="toolbar-endpoint" key={endpoint.id}>
                            <MethodPill method={endpoint.method} />
                            <span className="toolbar-endpoint-path">{endpoint.path}</span>
                            <Toggle
                              checked={on}
                              onChange={() => onToggleMock(endpoint)}
                              label={`Mock ${endpoint.method} ${endpoint.path}`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="toolbar-footer">
                    <button
                      type="button"
                      className={cx('toolbar-action', showEndpoints && 'active')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => setShowEndpoints((value) => !value)}
                      aria-pressed={showEndpoints}
                      aria-label="Endpoint mocks"
                      title="Endpoint mocks"
                    >
                      <ToggleRight size={16} />
                    </button>
                    {canEmbed && (
                      <button
                        type="button"
                        className="toolbar-action"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => webviewRef.current?.openDevTools()}
                        aria-label="Open devtools"
                        title="Open devtools"
                      >
                        <TerminalSquare size={15} />
                      </button>
                    )}
                    {canEmbed && (
                      <button
                        type="button"
                        className={cx('toolbar-action', changeLinks.length > 0 && 'active')}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={inspectChanges}
                        disabled={inspecting || !previewLoaded}
                        aria-pressed={changeLinks.length > 0}
                        aria-label="Highlight changed elements"
                        title={`Highlight elements from files changed ${baseRef}…${targetRef}`}
                      >
                        <Crosshair size={15} />
                        {changeLinks.length > 0 && (
                          <span className="toolbar-action-badge">{changeLinks.length}</span>
                        )}
                      </button>
                    )}
                  </div>
                  {changeNote && <p className="toolbar-note">{changeNote}</p>}
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </aside>
  );
}

function ReportsView({ reports }: { reports: VisualDiffReport[] }) {
  return (
    <div className="content-view">
      <section className="panel-section">
        <div className="section-heading">
          <h2>Reports history</h2>
          <p>{reports.length} diffs captured this session</p>
        </div>
        {reports.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
            No reports yet. Run a visual diff comparison from the Compare tab.
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              maxHeight: 'calc(100vh - 300px)',
              overflowY: 'auto',
            }}
          >
            {reports.map((report) => (
              <div
                key={report.id}
                style={{
                  padding: '12px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px',
                }}
              >
                <div style={{ fontWeight: '600', marginBottom: '4px' }}>
                  {report.baseRef} → {report.targetRef}
                </div>
                <div style={{ color: '#666', fontSize: '13px', marginBottom: '4px' }}>
                  {report.totalRoutes} routes • {report.changedRoutes} changed •{' '}
                  {(report.durationMs / 1000).toFixed(1)}s
                </div>
                <div
                  style={{
                    color: report.changedRoutes > 0 ? '#d32f2f' : '#388e3c',
                    fontSize: '12px',
                  }}
                >
                  {report.changedRoutes > 0
                    ? `⚠ ${report.changedRoutes} differences`
                    : '✓ No differences'}
                </div>
                <div style={{ color: '#999', fontSize: '11px', marginTop: '4px' }}>
                  {new Date(report.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// Browse/edit/create/delete the per-repo overlay config files (app-owned storage
// under userData/overlays/<repo>) directly in the UI — no Finder round-trip.
function OverlayEditor({ repoPath }: { repoPath: string }) {
  const available = Boolean(bridge?.listOverlayFiles && repoPath);
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!available) return;
    bridge!
      .listOverlayFiles(repoPath)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [available, repoPath]);

  async function open(file: string) {
    if (!bridge?.readOverlayFile) return;
    try {
      const text = await bridge.readOverlayFile(repoPath, file);
      setSelected(file);
      setContent(text);
      setDirty(false);
      setStatus(null);
    } catch {
      setStatus('Could not read file.');
    }
  }

  async function save() {
    if (!bridge?.writeOverlayFile || !selected) return;
    try {
      setFiles(await bridge.writeOverlayFile(repoPath, selected, content));
      setDirty(false);
      setStatus('Saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    }
  }

  async function create() {
    const name = newName.trim();
    if (!bridge?.writeOverlayFile || !name) return;
    try {
      setFiles(await bridge.writeOverlayFile(repoPath, name, ''));
      setNewName('');
      await open(name);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Create failed.');
    }
  }

  async function remove(file: string) {
    if (!bridge?.deleteOverlayFile) return;
    try {
      setFiles(await bridge.deleteOverlayFile(repoPath, file));
      if (selected === file) {
        setSelected(null);
        setContent('');
        setDirty(false);
      }
    } catch {
      setStatus('Delete failed.');
    }
  }

  if (!available) {
    return (
      <p className="settings-overlay-empty">Select a local repository to edit its overlay files.</p>
    );
  }

  return (
    <div className="overlay-editor">
      <div className="overlay-files">
        {files.length === 0 && <p className="overlay-empty">No overlay files yet.</p>}
        {files.map((file) => (
          <div key={file} className={cx('overlay-file', selected === file && 'active')}>
            <button type="button" className="overlay-file-name" onClick={() => open(file)}>
              {file}
            </button>
            <button
              type="button"
              className="overlay-file-del"
              aria-label={`Delete ${file}`}
              onClick={() => remove(file)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="overlay-new">
          <input
            value={newName}
            placeholder="path/to/file.ts"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create();
            }}
          />
          <button type="button" className="ghost-button" onClick={() => void create()}>
            <Plus size={14} /> New
          </button>
        </div>
      </div>

      <div className="overlay-content">
        {selected ? (
          <>
            <div className="overlay-content-head">
              <code>{selected}</code>
              <button
                type="button"
                className="primary-action"
                disabled={!dirty}
                onClick={() => void save()}
              >
                Save
              </button>
            </div>
            <textarea
              className="overlay-textarea"
              value={content}
              spellCheck={false}
              onChange={(event) => {
                setContent(event.target.value);
                setDirty(true);
                setStatus(null);
              }}
            />
            {status && <p className="overlay-status">{status}</p>}
          </>
        ) : (
          <p className="overlay-empty">Pick a file to edit, or create one.</p>
        )}
      </div>
    </div>
  );
}

function SettingsView({
  workspacePath,
  githubOrg,
  viewport,
  sensitivity,
  onChangeGithubOrg,
  onChangeViewport,
  onChangeSensitivity,
  repoPath,
}: {
  workspacePath: string;
  githubOrg: string;
  viewport: { width: number; height: number };
  sensitivity: number;
  onChangeGithubOrg: (value: string) => void;
  onChangeViewport: (value: { width: number; height: number }) => void;
  onChangeSensitivity: (value: number) => void;
  repoPath: string;
}) {
  const sensitivityPct =
    sensitivity < 0.01 ? (sensitivity * 100).toFixed(1) : String(Math.round(sensitivity * 100));

  return (
    <div className="content-view">
      <section className="panel-section">
        <div className="section-heading">
          <h2>Settings</h2>
          <p>Edits save automatically.</p>
        </div>
        <div className="settings-form">
          <label className="settings-field">
            <span>Workspace path</span>
            <input value={workspacePath} readOnly title="Set by choosing a workspace folder" />
            <small>Chosen via the workspace picker.</small>
          </label>

          <label className="settings-field">
            <span>GitHub organization</span>
            <input
              value={githubOrg}
              placeholder="acme-pizza"
              onChange={(event) => onChangeGithubOrg(event.target.value)}
            />
          </label>

          <div className="settings-field">
            <span>GitHub authentication</span>
            <small>
              No token field — the GitHub token is resolved automatically from{' '}
              <code>GITHUB_TOKEN</code>/<code>GH_TOKEN</code> or <code>gh auth token</code>. Nothing
              is collected in the UI or saved to disk.
            </small>
          </div>

          <div className="settings-field">
            <span>Default viewport</span>
            <div className="settings-row">
              <input
                type="number"
                min={1}
                value={viewport.width}
                aria-label="Viewport width"
                onChange={(event) =>
                  onChangeViewport({
                    width: Math.max(1, Number(event.target.value) || 0),
                    height: viewport.height,
                  })
                }
              />
              <span className="settings-times">×</span>
              <input
                type="number"
                min={1}
                value={viewport.height}
                aria-label="Viewport height"
                onChange={(event) =>
                  onChangeViewport({
                    width: viewport.width,
                    height: Math.max(1, Number(event.target.value) || 0),
                  })
                }
              />
              <span className="settings-unit">px</span>
            </div>
          </div>

          <label className="settings-field">
            <span>Default sensitivity ({sensitivityPct}%)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={sensitivityPct}
              onChange={(event) =>
                onChangeSensitivity(
                  Math.min(100, Math.max(0, Number(event.target.value) || 0)) / 100,
                )
              }
            />
            <small>Pixel-diff tolerance; lower is stricter.</small>
          </label>
        </div>
      </section>

      <section className="panel-section">
        <div className="section-heading">
          <h2>Overlay files</h2>
          <p>Per-repo files copied over each worktree to bypass capture blockers.</p>
        </div>
        <OverlayEditor repoPath={repoPath} />
      </section>
    </div>
  );
}

export default App;
