import {
  AlertTriangle,
  BadgeCheck,
  Boxes,
  Bug,
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
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  SquareStack,
  StopCircle,
  TerminalSquare,
  ToggleRight,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { seedBranches, seedEndpoints, seedProfiles, seedRepositories } from './data/seed';
import type {
  ChangeLinkResult,
  ChangeProbe,
  DiffStatus,
  EndpointDefinition,
  MockProfile,
  RepositorySummary,
  ServerLogEntry,
  SidecarStatus,
  VisualDiffReport,
  VisualDiffRouteReport,
} from './lib/types';

const bridge = window.deepDiff;
const workingTreeRef = '__working_tree__';

const navItems = [
  { label: 'Compare', icon: ChevronsLeftRight },
  { label: 'Mock Profiles', icon: SquareStack },
  { label: 'Endpoints', icon: Code2 },
  { label: 'Sidecar', icon: Server },
  { label: 'Reports', icon: ClipboardList },
  { label: 'Settings', icon: Settings },
];

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

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
    <button
      className={cx('toggle', checked && 'toggle-on')}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

// Reapply persisted per-endpoint mock edits onto a freshly scanned/seeded list.
function withMockEdits(
  list: EndpointDefinition[],
  edits: Record<string, Record<string, unknown>>,
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
  const [repositories, setRepositories] = useState<RepositorySummary[]>(seedRepositories);
  const [selectedRepo, setSelectedRepo] = useState<RepositorySummary>(seedRepositories[0]);
  const [branches, setBranches] = useState(seedBranches);
  const [baseBranch, setBaseBranch] = useState('main');
  const [targetBranch, setTargetBranch] = useState('feature/order-flow');
  const [endpoints, setEndpoints] = useState<EndpointDefinition[]>(seedEndpoints);
  const [profiles, setProfiles] = useState<MockProfile[]>(seedProfiles);
  const [activeProfileId, setActiveProfileId] = useState(seedProfiles[0].id);
  // Per-endpoint edited mock bodies, keyed `METHOD:path`, reapplied onto freshly
  // scanned endpoints so edits survive a rescan/restart. Persisted to state.json.
  const [mockEdits, setMockEdits] = useState<Record<string, Record<string, unknown>>>({});
  // Latest mockEdits for use inside async scan handlers without stale closures.
  const mockEditsRef = useRef(mockEdits);
  mockEditsRef.current = mockEdits;
  // Gates the persistence save effect until after the initial load has hydrated
  // state — otherwise the first render would overwrite state.json with seeds.
  const [stateHydrated, setStateHydrated] = useState(false);
  const [selectedEndpointId, setSelectedEndpointId] = useState(seedEndpoints[0].id);
  const [githubOrg, setGithubOrg] = useState('acme-pizza');
  const [githubToken, setGithubToken] = useState('');
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
        if (saved.profiles?.length) setProfiles(saved.profiles);
        if (saved.activeProfileId) setActiveProfileId(saved.activeProfileId);
        if (saved.mockEdits) setMockEdits(saved.mockEdits);
        if (saved.settings) {
          const s = saved.settings;
          if (typeof s.githubOrg === 'string') setGithubOrg(s.githubOrg);
          // NB: githubToken is intentionally NOT persisted (never written to disk);
          // it's resolved at use-time in the main process from env / `gh auth token`.
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

  // Persist UI state (debounced) after hydration. Skips the pre-hydration render
  // so seeds never clobber a saved file.
  useEffect(() => {
    if (!stateHydrated || !bridge?.saveState) return;
    const timer = window.setTimeout(() => {
      void bridge.saveState({
        version: 1,
        profiles,
        activeProfileId,
        mockEdits,
        // githubToken deliberately omitted — secrets are never written to disk.
        settings: { githubOrg, sensitivity, viewport },
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [stateHydrated, profiles, activeProfileId, mockEdits, githubOrg, sensitivity, viewport]);

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

  // Endpoints discovered at runtime through the sidecar proxy join the inventory as
  // mockable rows. Dedupe by METHOD:path so a runtime hit never overrides a richer
  // scanned definition, and reapply any saved per-endpoint mock edits.
  useEffect(() => {
    if (!bridge?.onObservedEndpoints) return;
    return bridge.onObservedEndpoints((endpoint) => {
      setEndpoints((prev) => {
        const key = `${endpoint.method}:${endpoint.path}`;
        if (prev.some((existing) => `${existing.method}:${existing.path}` === key)) return prev;
        const [withEdits] = withMockEdits([endpoint], mockEditsRef.current);
        return [...prev, withEdits];
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
  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ??
    profiles.find((profile) => profile.enabled) ??
    profiles[0];

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

    if (repo.source === 'github' && repo.owner && bridge) {
      setOverlayPath(null); // remote repo has no local worktree to overlay
      try {
        setBusy('Loading GitHub branches');
        const remoteBranches = await bridge.fetchGitHubBranches({
          owner: repo.owner,
          repository: repo.name,
          token: githubToken || undefined,
        });
        setBranches(remoteBranches.length ? remoteBranches : [nextBase]);
        setTargetBranch(
          remoteBranches.find((branch) => branch !== nextBase) ?? remoteBranches[0] ?? nextBase,
        );
        setEndpoints(withMockEdits(seedEndpoints, mockEditsRef.current));
        setMessage(
          'GitHub branches loaded. Clone or open the repository locally to run endpoint scanning.',
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'GitHub branch lookup failed.');
      } finally {
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
        token: githubToken || undefined,
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
      `Comparing ${branchLabel(targetBranch)} against ${branchLabel(baseBranch)} with ${activeProfile.name}.`,
    );
    setBusy('Capturing baseline and target pages');

    try {
      const report = await bridge.runVisualDiff({
        repoPath: selectedRepo.path,
        baseRef: toRunRef(baseBranch),
        targetRef: toRunRef(targetBranch),
        viewport,
        mismatchTolerance: sensitivity,
        endpointOverrides: activeProfile.enabled ? activeProfile.endpointOverrides : undefined,
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
    if (bridge && selectedRepo.path) {
      try {
        setBusy('Launching sidecar');
        const nextStatus = await bridge.launchSidecar({
          repoPath: selectedRepo.path,
          branch: targetBranch === workingTreeRef ? undefined : targetBranch,
          endpointOverrides: activeProfile.enabled ? activeProfile.endpointOverrides : undefined,
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

  function toggleProfile(profileId: string) {
    setProfiles((current) => {
      const next = current.map((profile) =>
        profile.id === profileId ? { ...profile, enabled: !profile.enabled } : profile,
      );
      const activeStillAvailable = next.some(
        (profile) => profile.id === activeProfileId && profile.enabled,
      );
      if (!activeStillAvailable) {
        setActiveProfileId((next.find((profile) => profile.enabled) ?? next[0]).id);
      }
      return next;
    });
  }

  // Toggle a single endpoint's mock override on/off for the active profile.
  // A running sidecar reflects this live: SidecarPanel watches the active
  // profile's effective overrides and pushes them to the proxy via
  // `setSidecarOverrides` (bringing a proxy up on the first override), then
  // reloads the preview. A visual-diff run still reads them at diff time.
  function toggleEndpointOverride(endpoint: EndpointDefinition, profileId = activeProfileId) {
    const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
    let turnedOn = false;
    setProfiles((current) =>
      current.map((profile) => {
        if (profile.id !== profileId) return profile;
        const next = { ...profile.endpointOverrides };
        if (next[key]) {
          delete next[key];
        } else {
          next[key] = endpoint.mock;
          turnedOn = true;
        }
        // Turning a mock ON only has runtime effect if the profile is enabled —
        // the sidecar/diff send overrides solely from the active *enabled* profile.
        // Auto-enable so the toggle the user just flipped actually applies.
        return { ...profile, enabled: turnedOn ? true : profile.enabled, endpointOverrides: next };
      }),
    );
    // ...and make it the active profile, so the runtime (which uses only the
    // active profile) picks up the mock the user just enabled.
    if (turnedOn && profileId !== activeProfileId) setActiveProfileId(profileId);
  }

  // Edit a mock body. When the profile has an active override for the endpoint,
  // edit that override; otherwise edit the endpoint's default mock (recorded in
  // mockEdits so it survives a rescan/restart).
  function editEndpointMock(
    endpoint: EndpointDefinition,
    profileId: string,
    body: Record<string, unknown>,
  ) {
    const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
    const profile = profiles.find((item) => item.id === profileId);
    if (profile && profile.endpointOverrides[key]) {
      setProfiles((current) =>
        current.map((item) =>
          item.id === profileId
            ? { ...item, endpointOverrides: { ...item.endpointOverrides, [key]: body } }
            : item,
        ),
      );
      return;
    }
    setEndpoints((current) =>
      current.map((item) => (item.id === endpoint.id ? { ...item, mock: body } : item)),
    );
    setMockEdits((current) => ({ ...current, [key]: body }));
  }

  function activateProfile(profileId: string) {
    setActiveProfileId(profileId);
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId ? { ...profile, enabled: true } : profile,
      ),
    );
  }

  function addProfile() {
    const next: MockProfile = {
      id: `profile-${Date.now()}`,
      name: `Mock Profile ${profiles.length + 1}`,
      description: 'Generated from detected endpoint response shapes',
      color: profiles.length % 2 === 0 ? 'green' : 'yellow',
      enabled: false,
      endpointOverrides: endpoints.reduce<Record<string, Record<string, unknown>>>(
        (overrides, endpoint) => {
          overrides[`${endpoint.method.toUpperCase()}:${endpoint.path}`] = endpoint.mock;
          return overrides;
        },
        {},
      ),
    };
    setProfiles((current) => [...current, next]);
    setMessage(`${next.name} created with ${endpoints.length} endpoint mocks.`);
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
              Open local organization
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
                githubToken={githubToken}
                setGithubToken={setGithubToken}
                chooseWorkspace={chooseWorkspace}
                fetchGitHubRepositories={fetchGitHubRepositories}
                runVisualDiff={runVisualDiff}
                diffStatus={diffStatus}
              />

              <MockProfiles
                profiles={profiles}
                endpoints={endpoints}
                onToggle={toggleProfile}
                onAdd={addProfile}
              />

              <EndpointInventory
                endpoints={filteredEndpoints}
                total={endpoints.length}
                search={search}
                setSearch={setSearch}
                selectedEndpointId={selectedEndpointId}
                setSelectedEndpointId={setSelectedEndpointId}
              />
            </section>

            <ComparisonWorkspace
              baseBranch={baseBranch}
              targetBranch={targetBranch}
              diffStatus={diffStatus}
              profile={activeProfile}
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
              profile={activeProfile}
              selectedEndpoint={selectedEndpoint}
              onLaunch={launchSidecar}
              onStop={stopSidecar}
              profiles={profiles}
              endpoints={endpoints}
              repoPath={selectedRepo.path}
              baseRef={toRunRef(baseBranch)}
              targetRef={toRunRef(targetBranch)}
              onToggleProfile={toggleProfile}
              onActivateProfile={activateProfile}
              onToggleEndpointOverride={toggleEndpointOverride}
              onSidecarStatus={setSidecar}
            />
          </div>
        )}

        {activeNav === 'Mock Profiles' && (
          <div className="content-view">
            <MockProfiles
              profiles={profiles}
              endpoints={endpoints}
              onToggle={toggleProfile}
              onAdd={addProfile}
              onToggleEndpointOverride={toggleEndpointOverride}
              onEditEndpointMock={editEndpointMock}
            />
          </div>
        )}

        {activeNav === 'Endpoints' && (
          <div className="content-view">
            <EndpointInventory
              endpoints={filteredEndpoints}
              total={endpoints.length}
              search={search}
              setSearch={setSearch}
              selectedEndpointId={selectedEndpointId}
              setSelectedEndpointId={setSelectedEndpointId}
            />
          </div>
        )}

        {activeNav === 'Sidecar' && (
          <div className="content-view">
            <SidecarPanel
              sidecar={sidecar}
              profile={activeProfile}
              selectedEndpoint={selectedEndpoint}
              onLaunch={launchSidecar}
              onStop={stopSidecar}
              profiles={profiles}
              endpoints={endpoints}
              repoPath={selectedRepo.path}
              baseRef={toRunRef(baseBranch)}
              targetRef={toRunRef(targetBranch)}
              onToggleProfile={toggleProfile}
              onActivateProfile={activateProfile}
              onToggleEndpointOverride={toggleEndpointOverride}
              onSidecarStatus={setSidecar}
            />
          </div>
        )}

        {activeNav === 'Reports' && <ReportsView reports={reports} />}

        {activeNav === 'Settings' && (
          <SettingsView
            workspacePath={workspacePath}
            githubOrg={githubOrg}
            githubToken={githubToken}
            viewport={viewport}
            sensitivity={sensitivity}
            onChangeGithubOrg={setGithubOrg}
            onChangeGithubToken={setGithubToken}
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
  githubToken,
  setGithubToken,
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
  githubToken: string;
  setGithubToken: (token: string) => void;
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

      <div className="segmented-control">
        <button
          className={cx(sourceMode === 'local' && 'selected')}
          type="button"
          onClick={() => setSourceMode('local')}
        >
          <FolderOpen size={15} />
          Local
        </button>
        <button
          className={cx(sourceMode === 'github' && 'selected')}
          type="button"
          onClick={() => setSourceMode('github')}
        >
          <Github size={15} />
          GitHub org
        </button>
      </div>

      {sourceMode === 'local' ? (
        <button className="wide-secondary" type="button" onClick={chooseWorkspace}>
          <FolderOpen size={16} />
          Select organization folder
        </button>
      ) : (
        <div className="github-form">
          <label>
            <span>Organization</span>
            <input value={githubOrg} onChange={(event) => setGithubOrg(event.target.value)} />
          </label>
          <label>
            <span>Token</span>
            <input
              value={githubToken}
              type="password"
              placeholder="Optional for private repos"
              onChange={(event) => setGithubToken(event.target.value)}
            />
          </label>
          <button className="wide-secondary" type="button" onClick={fetchGitHubRepositories}>
            <RefreshCcw size={16} />
            Fetch repositories
          </button>
        </div>
      )}

      <label className="field-label">
        <span>Repository</span>
        <div className="select-wrap">
          <select
            value={selectedRepo.id}
            onChange={(event) => {
              const repo = repositories.find((candidate) => candidate.id === event.target.value);
              if (repo) void onSelectRepository(repo);
            }}
          >
            {visibleRepositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
      </label>

      <div className="branch-grid">
        <label className="field-label">
          <span>Base branch</span>
          <div className="select-wrap">
            <select value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branchLabel(branch)}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
        <label className="field-label">
          <span>Target branch</span>
          <div className="select-wrap">
            <select value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)}>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branchLabel(branch)}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
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
  body: Record<string, unknown>;
  editable: boolean;
  hint?: string;
  onSave: (body: Record<string, unknown>) => void;
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
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Mock body must be a JSON object.');
      return;
    }
    onSave(parsed as Record<string, unknown>);
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

function MockProfiles({
  profiles,
  endpoints,
  onToggle,
  onAdd,
  onToggleEndpointOverride,
  onEditEndpointMock,
}: {
  profiles: MockProfile[];
  endpoints: EndpointDefinition[];
  onToggle: (profileId: string) => void;
  onAdd: () => void;
  onToggleEndpointOverride?: (endpoint: EndpointDefinition, profileId: string) => void;
  onEditEndpointMock?: (
    endpoint: EndpointDefinition,
    profileId: string,
    body: Record<string, unknown>,
  ) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const canExpand = Boolean(onToggleEndpointOverride);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="panel-section">
      <div className="section-heading inline">
        <div>
          <h2>Mock Profiles</h2>
          <p>Valid response data from detected shapes.</p>
        </div>
        <button className="icon-text-button" type="button" onClick={onAdd}>
          <Plus size={15} />
          New
        </button>
      </div>

      <div className="profile-list">
        {profiles.map((profile) => {
          const isOpen = expanded.has(profile.id);
          const overrideCount = Object.keys(profile.endpointOverrides).length;
          return (
            <div key={profile.id} className="profile-block">
              <article
                className={cx(
                  'profile-row',
                  `profile-${profile.color}`,
                  profile.enabled && 'enabled',
                  canExpand && 'expandable',
                )}
              >
                <div className="profile-icon">
                  {profile.color === 'red' ? (
                    <Bug size={16} />
                  ) : profile.color === 'yellow' ? (
                    <Zap size={16} />
                  ) : (
                    <ShieldCheck size={16} />
                  )}
                </div>
                {canExpand ? (
                  <button
                    type="button"
                    className="profile-meta"
                    onClick={() => toggleExpand(profile.id)}
                    aria-expanded={isOpen}
                  >
                    <strong>{profile.name}</strong>
                    <small>
                      {overrideCount} of {endpoints.length} endpoints mocked
                    </small>
                  </button>
                ) : (
                  <div>
                    <strong>{profile.name}</strong>
                    <small>{profile.description}</small>
                  </div>
                )}
                {canExpand && (
                  <button
                    type="button"
                    className="profile-expand"
                    onClick={() => toggleExpand(profile.id)}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${profile.name} mocks`}
                  >
                    {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                )}
                <Toggle
                  checked={profile.enabled}
                  onChange={() => onToggle(profile.id)}
                  label={`Toggle ${profile.name}`}
                />
              </article>

              {canExpand && isOpen && (
                <div className="profile-mocks">
                  {endpoints.length === 0 && (
                    <p className="profile-mocks-empty">No endpoints detected yet.</p>
                  )}
                  {endpoints.map((endpoint) => {
                    const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
                    const override = profile.endpointOverrides[key];
                    const active = Boolean(override);
                    const body = active ? override : endpoint.mock;
                    return (
                      <div key={endpoint.id} className={cx('mock-row', active && 'active')}>
                        <div className="mock-row-head">
                          <MethodPill method={endpoint.method} />
                          <code title={endpoint.path}>{endpoint.path}</code>
                          <Toggle
                            checked={active}
                            onChange={() => onToggleEndpointOverride?.(endpoint, profile.id)}
                            label={`Toggle mock for ${endpoint.method} ${endpoint.path} in ${profile.name}`}
                          />
                        </div>
                        <MockBodyEditor
                          body={body ?? {}}
                          editable={canExpand}
                          hint={
                            active
                              ? 'Editing this profile’s override'
                              : 'Editing the endpoint default mock'
                          }
                          onSave={(next) => onEditEndpointMock?.(endpoint, profile.id, next)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mock-summary">
        <WandSparkles size={16} />
        <span>{endpoints.length} endpoints can be hydrated into a profile.</span>
      </div>
    </div>
  );
}

function EndpointInventory({
  endpoints,
  total,
  search,
  setSearch,
  selectedEndpointId,
  setSelectedEndpointId,
}: {
  endpoints: EndpointDefinition[];
  total: number;
  search: string;
  setSearch: (query: string) => void;
  selectedEndpointId: string;
  setSelectedEndpointId: (id: string) => void;
}) {
  return (
    <div className="panel-section endpoint-section">
      <div className="section-heading">
        <h2>Endpoints</h2>
        <p>{total} endpoints detected</p>
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
        {endpoints.map((endpoint) => (
          <button
            key={endpoint.id}
            type="button"
            className={cx('endpoint-row', selectedEndpointId === endpoint.id && 'selected')}
            onClick={() => setSelectedEndpointId(endpoint.id)}
          >
            <MethodPill method={endpoint.method} />
            <span>{endpoint.path}</span>
            <small>{endpoint.status}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function ComparisonWorkspace({
  baseBranch,
  targetBranch,
  diffStatus,
  profile,
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
  profile: MockProfile;
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
          <button
            className={cx(
              'icon-button',
              viewport.width === 1280 && viewport.height === 900 && 'selected',
            )}
            type="button"
            aria-label="Desktop viewport"
            onClick={() => setViewport({ width: 1280, height: 900 })}
          >
            <Monitor size={17} />
          </button>
          <button
            className={cx(
              'icon-button',
              viewport.width === 1024 && viewport.height === 768 && 'selected',
            )}
            type="button"
            aria-label="Laptop viewport"
            onClick={() => setViewport({ width: 1024, height: 768 })}
          >
            <Laptop size={17} />
          </button>
          <button
            className={cx(
              'icon-button',
              viewport.width === 375 && viewport.height === 667 && 'selected',
            )}
            type="button"
            aria-label="Mobile viewport"
            onClick={() => setViewport({ width: 375, height: 667 })}
          >
            <Smartphone size={17} />
          </button>
          <button
            className="ghost-button compact"
            type="button"
            title="Click to cycle tolerance — percentage of pixels that may differ before a route is marked changed"
            onClick={() => {
              const presets = [0, 0.001, 0.01, 0.05, 0.1, 0.25];
              const next = presets[(presets.indexOf(sensitivity) + 1) % presets.length];
              setSensitivity(next ?? 0);
            }}
          >
            <SlidersHorizontal size={16} />
            {`Sensitivity ${sensitivity === 0 ? '0%' : sensitivity < 0.01 ? `${(sensitivity * 100).toFixed(1)}%` : `${Math.round(sensitivity * 100)}%`}`}
          </button>
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
            <span>{profile.name} will be applied to the next comparison run.</span>
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
  profile,
  selectedEndpoint,
  onLaunch,
  onStop,
  profiles,
  endpoints,
  repoPath,
  baseRef,
  targetRef,
  onToggleProfile,
  onActivateProfile,
  onToggleEndpointOverride,
  onSidecarStatus,
}: {
  sidecar: SidecarStatus;
  profile: MockProfile;
  selectedEndpoint: EndpointDefinition;
  onLaunch: () => Promise<void>;
  onStop: () => Promise<void>;
  profiles: MockProfile[];
  endpoints: EndpointDefinition[];
  repoPath?: string;
  baseRef: string;
  targetRef: string;
  onToggleProfile: (profileId: string) => void;
  onActivateProfile: (profileId: string) => void;
  onToggleEndpointOverride: (endpoint: EndpointDefinition) => void;
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

  // Effective overrides for the active profile: an enabled profile contributes
  // its endpoint map; a disabled one contributes nothing (every request passes
  // through). Mirrors what launchSidecar/runVisualDiff send.
  const overridesKey = useMemo(
    () => JSON.stringify(profile.enabled ? profile.endpointOverrides : {}),
    [profile.enabled, profile.endpointOverrides],
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

    const nextOverrides = profile.enabled ? profile.endpointOverrides : {};
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
  }, [overridesKey, sidecar.running, sidecar.url, profile, onSidecarStatus]);

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
            <p>{selectedEndpoint.path}</p>
          </div>
          <Boxes size={18} />
        </div>
        <div className="shape-table">
          {selectedEndpoint.fields.map((field) => (
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
                  <label>
                    <span>Profile</span>
                    <select
                      value={profile.id}
                      onChange={(event) => onActivateProfile(event.target.value)}
                    >
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {profiles.slice(0, 4).map((item) => (
                    <div className="toolbar-toggle" key={item.id}>
                      <span>{item.name.replace('Margherita ', '').replace('Pepperoni ', '')}</span>
                      <Toggle
                        checked={item.enabled}
                        onChange={() => onToggleProfile(item.id)}
                        label={`Preview ${item.name}`}
                      />
                    </div>
                  ))}
                  {showEndpoints && (
                    <div className="toolbar-endpoints">
                      {endpoints.map((endpoint) => {
                        const key = `${endpoint.method.toUpperCase()}:${endpoint.path}`;
                        const on = Boolean(profile.endpointOverrides[key]);
                        return (
                          <div className="toolbar-endpoint" key={endpoint.id}>
                            <MethodPill method={endpoint.method} />
                            <span className="toolbar-endpoint-path">{endpoint.path}</span>
                            <Toggle
                              checked={on}
                              onChange={() => onToggleEndpointOverride(endpoint)}
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
  githubToken,
  viewport,
  sensitivity,
  onChangeGithubOrg,
  onChangeGithubToken,
  onChangeViewport,
  onChangeSensitivity,
  repoPath,
}: {
  workspacePath: string;
  githubOrg: string;
  githubToken: string;
  viewport: { width: number; height: number };
  sensitivity: number;
  onChangeGithubOrg: (value: string) => void;
  onChangeGithubToken: (value: string) => void;
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

          <label className="settings-field">
            <span>GitHub token</span>
            <input
              type="password"
              value={githubToken}
              placeholder="Uses gh CLI / GITHUB_TOKEN by default"
              autoComplete="off"
              onChange={(event) => onChangeGithubToken(event.target.value)}
            />
            <small>
              Session only — never saved to disk. Leave blank to use <code>gh auth token</code> or{' '}
              <code>GITHUB_TOKEN</code>.
            </small>
          </label>

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
