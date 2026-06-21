import {
  AlertTriangle,
  BadgeCheck,
  Boxes,
  Bug,
  ChevronDown,
  ChevronsLeftRight,
  Circle,
  ClipboardList,
  Code2,
  ExternalLink,
  Eye,
  FolderOpen,
  Github,
  GitBranch,
  Laptop,
  LayoutDashboard,
  ListFilter,
  Loader2,
  Monitor,
  PanelRight,
  Play,
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
  WandSparkles,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { seedBranches, seedEndpoints, seedProfiles, seedRepositories } from './data/seed';
import type {
  DiffStatus,
  EndpointDefinition,
  MockProfile,
  RepositorySummary,
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
  const [selectedEndpointId, setSelectedEndpointId] = useState(seedEndpoints[0].id);
  const [githubOrg, setGithubOrg] = useState('acme-pizza');
  const [githubToken, setGithubToken] = useState('');
  const [search, setSearch] = useState('');
  const [diffStatus, setDiffStatus] = useState<DiffStatus>('idle');
  const [diffReport, setDiffReport] = useState<VisualDiffReport | null>(null);
  const [selectedReportRouteId, setSelectedReportRouteId] = useState<string | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ running: false });
  const [message, setMessage] = useState(
    'Use a local folder or GitHub organization to select a repository.',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [sensitivity, setSensitivity] = useState(0.001);
  const [viewport, setViewport] = useState({ width: 1280, height: 900 });
  const [activeNav, setActiveNav] = useState('Compare');
  const [reports, setReports] = useState<VisualDiffReport[]>([]);

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
      try {
        setBusy('Scanning local repository');
        const [localBranches, detectedEndpoints] = await Promise.all([
          bridge.listLocalBranches(repo.path),
          bridge.scanEndpoints(repo.path),
        ]);
        const branchOptions = localBranches.length ? localBranches : [nextBase];
        setBranches([...branchOptions, workingTreeRef]);
        setTargetBranch(localBranches.find((branch) => branch !== nextBase) ?? workingTreeRef);
        setEndpoints(detectedEndpoints.length ? detectedEndpoints : seedEndpoints);
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
        setEndpoints(seedEndpoints);
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
          <span>Deep Dish Diff</span>
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
              onToggleProfile={toggleProfile}
              onActivateProfile={activateProfile}
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
              onToggleProfile={toggleProfile}
              onActivateProfile={activateProfile}
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
          />
        )}
      </main>
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

function MockProfiles({
  profiles,
  endpoints,
  onToggle,
  onAdd,
}: {
  profiles: MockProfile[];
  endpoints: EndpointDefinition[];
  onToggle: (profileId: string) => void;
  onAdd: () => void;
}) {
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
        {profiles.map((profile) => (
          <article
            key={profile.id}
            className={cx('profile-row', `profile-${profile.color}`, profile.enabled && 'enabled')}
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
            <div>
              <strong>{profile.name}</strong>
              <small>{profile.description}</small>
            </div>
            <Toggle
              checked={profile.enabled}
              onChange={() => onToggle(profile.id)}
              label={`Toggle ${profile.name}`}
            />
          </article>
        ))}
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

function SidecarPanel({
  sidecar,
  profile,
  selectedEndpoint,
  onLaunch,
  onStop,
  profiles,
  onToggleProfile,
  onActivateProfile,
}: {
  sidecar: SidecarStatus;
  profile: MockProfile;
  selectedEndpoint: EndpointDefinition;
  onLaunch: () => Promise<void>;
  onStop: () => Promise<void>;
  profiles: MockProfile[];
  onToggleProfile: (profileId: string) => void;
  onActivateProfile: (profileId: string) => void;
}) {
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

      <section className="browser-preview-card">
        <div className="section-heading inline">
          <div>
            <h2>Browser preview</h2>
            <p>Floating toolbar injected over the target.</p>
          </div>
          <ExternalLink size={17} />
        </div>
        <div className="mini-browser">
          <div className="mini-url">{sidecar.url ?? 'http://localhost:3000'}</div>
          <div className="pizza-page">
            <div className="pizza-photo" />
            <div className="floating-toolbar">
              <div className="toolbar-title">
                <span>🍕</span>
                <strong>Deep Dish Diff</strong>
              </div>
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
              <div className="toolbar-footer">
                <Eye size={15} />
                <TerminalSquare size={15} />
                <ToggleRight size={16} />
              </div>
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

function SettingsView({
  workspacePath,
  githubOrg,
  githubToken,
  viewport,
  sensitivity,
}: {
  workspacePath: string;
  githubOrg: string;
  githubToken: string;
  viewport: { width: number; height: number };
  sensitivity: number;
}) {
  return (
    <div className="content-view">
      <section className="panel-section">
        <div className="section-heading">
          <h2>Settings</h2>
          <p>Current configuration</p>
        </div>
        <div style={{ padding: '12px' }}>
          <div style={{ marginBottom: '16px' }}>
            <strong style={{ display: 'block', marginBottom: '4px' }}>Workspace path</strong>
            <div style={{ fontSize: '13px', color: '#666', wordBreak: 'break-all' }}>
              {workspacePath}
            </div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <strong style={{ display: 'block', marginBottom: '4px' }}>GitHub organization</strong>
            <div style={{ fontSize: '13px', color: '#666' }}>{githubOrg || '(Not set)'}</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <strong style={{ display: 'block', marginBottom: '4px' }}>GitHub token</strong>
            <div style={{ fontSize: '13px', color: '#666' }}>
              {githubToken ? '•••••••••' : '(Not set)'}
            </div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <strong style={{ display: 'block', marginBottom: '4px' }}>Default viewport</strong>
            <div style={{ fontSize: '13px', color: '#666' }}>
              {viewport.width} × {viewport.height}px
            </div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <strong style={{ display: 'block', marginBottom: '4px' }}>Default sensitivity</strong>
            <div style={{ fontSize: '13px', color: '#666' }}>
              {sensitivity === 0
                ? '0%'
                : sensitivity < 0.01
                  ? `${(sensitivity * 100).toFixed(1)}%`
                  : `${Math.round(sensitivity * 100)}%`}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
