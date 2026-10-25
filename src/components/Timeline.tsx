import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import type { GitData, BranchLane, BranchRef, CommitNode, CommitEdge, TimeGap, PatchLink } from '../types';
import { useSettings, cssVar } from '../settings';
import { filterRefs } from '../refs';
import { minimapMap, viewportRect, type MinimapMap } from './minimap';
import { LANE_HEIGHT } from '../inactive';
import type { TraceRow, TraceBar, SedimentKind } from '../inactive';
import { headToLaneTip, type ComparePair } from '../compare';
import { collapsedRuns, type CollapsedRun } from '../collapse';
import { createDelayGate, step as delayGateStep, type DelayGate } from '../delaygate';
import { saveViewport, loadViewport } from '../viewpersist';

/** A busy indicator must hold off for a beat (sub-frame async waits never
 *  flash it) and, once visible, stay long enough to read as a state rather
 *  than a strobe. */
function useDelayedBusy(busy: boolean, delayMs = 350, minShowMs = 500): boolean {
  const gateRef = useRef<DelayGate | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!gateRef.current) gateRef.current = createDelayGate(delayMs, minShowMs);
    const gate = gateRef.current;
    const apply = () => {
      const res = delayGateStep(gate, busy, performance.now());
      setVisible(res.visible);
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      if (res.at !== null) {
        timerRef.current = window.setTimeout(apply, Math.max(0, res.at - performance.now()));
      }
    };
    apply();
    return () => window.clearTimeout(timerRef.current);
  }, [busy, delayMs, minShowMs]);
  return visible;
}

interface TimelineProps {
  data: GitData;
  /** Repo path keying the camera persistence (viewpersist.ts): the first
   *  draw of a mounted repo restores the user's last zoom/pan for THIS path
   *  instead of the default anchor, and every gesture end saves it back --
   *  a webview reload, tab switch or background refresh can no longer throw
   *  the view away. Empty string disables persistence (mock preview). */
  viewKey: string;
  onCommitClick: (commitId: string) => void;
  selectedCommitId: string | null;
  /** Increments when a repository is (re)opened — the only time the viewport resets. */
  resetKey: number;
  /** True while this tab is the active one. Keep-alive shells keep hidden
   *  tabs mounted under display:none; a draw there measures the container
   *  0x0 and every closure it builds (zoom handler, minimap viewport,
   *  edge-load probe) carries that poisoned size until the next VISIBLE
   *  draw. So hidden draws are skipped — and `active` in draw's deps makes
   *  the activation itself the re-draw, with real dimensions. */
  active: boolean;
  /** "View from this branch" (lane context menu). */
  onViewFromBranch: (branchName: string) => void;
  /** "Only related branches" (lane context menu): rebuild the view with
   *  just this lane's blood-line closure (spec 4.1). */
  onRelatedBranch: (branchName: string) => void;
  /** View options lifted to the app header. */
  compressed: boolean;
  showMergeLinks: boolean;
  showRefLabels: boolean;
  /** Fork/merge name annotations (🌱/🔀) on the graph; off by default —
   *  the hover tooltip carries the same names instead. */
  showAnnotations: boolean;
  /** Cherry-pick / rebase copy links (empty when the Copies toggle is off). */
  patchLinks: PatchLink[];
  /** Increment to trigger "Fit to view" from outside. */
  fitSignal: number;
  /** Increment to trigger "go home" (Age-of-Empires style camera snap to
   *  HEAD + ring flash + minimap ping) from the header button / H key. */
  headSignal: number;
  /** True while older history can still be paged in. */
  hasMore: boolean;
  /** True while a date-range window crops the DISPLAY: page-in would pull
   *  history the filter then hides (invisible work, plus a relayout cascade
   *  because the displayed scene never grows). Panning to the oldest edge
   *  shows a hint instead of loading; widening the scope reveals what is
   *  already loaded instantly. */
  dateRangeActive: boolean;
  /** An older-history page load is in flight. */
  loadingOlder: boolean;
  /** A USER-initiated async rebuild is in flight (branch filter / lens swap).
   *  Fed through the delay gate — only waits that outlast the gate show the
   *  render badge. Background refreshes deliberately never set this: they
   *  must keep the canvas on screen. */
  busy: boolean;
  /** Called when the user pans near the oldest (left) edge of the scene. */
  onLoadOlder: () => void;
  /** External "jump to commit" (header search); seq increments per jump. */
  focusCommit: { id: string; seq: number } | null;
  /** Inactive-lane collapse (frontend display state). Empty values = the
   *  pre-collapse rendering, byte for byte. */
  hiddenIds: Set<string>;
  traceRows: TraceRow[];
  traceBars: TraceBar[];
  /** Trace-row / trace-chip click: toggle (expand/collapse) the whole group. */
  onExpandTraceGroup: (kind: SedimentKind) => void;
  /** Action label for a trace group's title ("Collapse" when the group is
   *  fully expanded, "Expand" otherwise) — App owns the toggle state. */
  traceGroupLabel: (kind: SedimentKind) => string;
  /** Shorthand of the branch HEAD is on; null while detached. Drives the
   *  current-branch lane chip marker (spec 4.3). */
  headBranch: string | null;
  /** Sibling worktree members' checkouts (branch name -> member name),
   *  EXCLUDING the current member (whose lane is the head lane): each
   *  entry earns a house badge on its lane chip -- one graph, N anchors. */
  memberLanes: Map<string, string>;
  /** Branch name while the header position pill is hovered (RepoView):
   *  transiently focuses the "you are here" lane. Null when not hovered. */
  headLaneHover: string | null;
  /** "Check out this branch" (lane context menu, M3.1): switch the actual
   *  worktree HEAD (App owns the dirty-confirm state machine). */
  onCheckoutBranch: (branchName: string) => void;
  /** Ctrl/Cmd+click on a node (M3.2): feed the compare pairing state
   *  machine in App (spec 4.4). */
  onCompareClick: (commitId: string) => void;
  /** Base id of an INCOMPLETE pair: while non-null the pending node gets
   *  a ring. A complete pair opens the compare panel instead -- no ring. */
  compareBaseId: string | null;
  /** "Compare with HEAD" (lane context menu, M3.2): App stores the
   *  ready-made complete pair produced by headToLaneTip. */
  onComparePair: (pair: ComparePair) => void;
  /** Lane context menu "Copy name": RepoView owns the clipboard write and
   *  the confirmation toast (same channel as the ref-panel chips). */
  onCopyName: (name: string) => void;
  /** A plain click on EMPTY canvas (nodes/edges stop propagation; a pan
   *  gesture's trailing click is filtered by movement). The host closes
   *  the details panel -- the canvas acts as the panel's "outside". */
  onCanvasClick: () => void;
  /** Starred (favorited) lane names -- the chip's ★ glyph and the lane
   *  menu's star/unstar label both derive from this. */
  starredLanes: Set<string>;
  /** Lane menu "Star / Unstar" (RepoView owns the persisted set). */
  onToggleStarLane: (name: string) => void;
  /** Lane chip hover × / lane menu "Fold": fold the lane into its sediment
   *  row -- pure display state, instant, session-only. */
  onFoldLane: (name: string) => void;
}

const MINIMAP_W = 280;
const MINIMAP_H = 170;

/** Neutral gray for commits no lane claims (lane_owner ""); visible on both
 *  themes, distinct from every lane color including main's blue. */
const UNATTRIBUTED_COLOR = '#9E9E9E';

/** Below this on-screen row height (LANE_HEIGHT * zoom scale) the ref badge
 *  pills and fork/merge annotations mute entirely; HEAD and tag pills stay. */
const LABEL_MIN_ROW_H = 28;

/** How close (scene px) the view's left edge must sit to the oldest loaded
 *  commit before another history page comes in — one working-zoom viewport
 *  width. See maybeLoadOlder for why this must not scale with 1/k. */
const EDGE_PROBE_SCENE_PX = 1600;

/** Lane-chip label cap: longer names keep head and tail with an ellipsis in
 *  the middle (the tail carries the distinguishing part); the chip's title
 *  holds the full name. */
const CHIP_NAME_MAX = 28;

function middleEllipsis(name: string): string {
  if (name.length <= CHIP_NAME_MAX) return name;
  return `${name.slice(0, 14)}…${name.slice(name.length - 12)}`;
}

interface LaneMenu {
  x: number;
  y: number;
  lane: BranchLane;
}

interface BadgePill {
  name: string;
  is_tag: boolean;
  is_remote: boolean;
  /** A remote-tracking twin (any <remote>/x for local x) was folded into
   *  this local pill; it earns a cloud marker. */
  synced: boolean;
}

interface BadgeSpec {
  c: CommitNode;
  /** Refs AFTER the remote filter -- the pill list AND the full-name
   *  <title> both derive from this filtered list (no ghost counts). */
  refs: BranchRef[];
  names: BadgePill[];
  level: number;
}

function nodeRadius(c: CommitNode): number {
  const volume = c.additions + c.deletions;
  if (volume <= 0) return 7;
  return 7 + Math.min(7, Math.sqrt(volume) / 2.5);
}

// --- the canvas scene model ---------------------------------------------------
// The heavy graph layers (HEAD band, gap breaks, lane lines/bars, trace bars,
// patch links, edges, nodes, rings) render as immediate-mode Canvas 2D: the
// DOM/SVG retained-mode pipeline charged a full style/layout/paint pass per
// rebuild for ~13k elements (the 100-lane switch report), while a canvas
// repaint of the same primitives costs ~10ms. The SVG overlay above the
// canvas keeps only what wants DOM semantics: text (pills, annotations, the
// HEAD label) and the few interactive widgets (trace rows, +N chips).
interface EdgeEntry {
  p: Path2D;
  d: string;
  type: CommitEdge['edge_type'];
  from: string;
  to: string;
  color: string;
  width: number;
  opacity: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
interface NodeEntry {
  c: CommitNode;
  x: number;
  y: number;
  r: number;
  color: string;
  opacity: number;
  x0: number;
  x1: number;
}
interface LaneBarEntry {
  lane: BranchLane;
  y: number;
  x1: number;
  x2: number;
  color: string;
  width: number;
  opacity: number;
}
interface RingEntry {
  x: number;
  y: number;
  r: number;
  color: string;
  width: number;
  opacity: number;
  dash: number[];
}
interface CanvasModel {
  band: number | null;
  gapBreaks: { x: number; y1: number; y2: number }[];
  laneLines: { y: number; color: string; opacity: number }[];
  laneBars: LaneBarEntry[];
  laneBarByLane: Map<number, LaneBarEntry>;
  traceBars: { y: number; x1: number; x2: number; color: string }[];
  patchLinks: { p: Path2D; color: string }[];
  edges: EdgeEntry[];
  edgeMaxSpan: number;
  nodes: NodeEntry[];
  rings: RingEntry[];
}

type Hit = { kind: 'node'; c: CommitNode }
  | { kind: 'edge'; edge: { from: string; to: string } }
  | { kind: 'lane'; lane: BranchLane };

/** [lo, hi) over arr sorted by x0: the entries whose x-window can intersect
 *  [x0, x1]. maxSpan widens the left bound so long edges crossing the
 *  viewport are never dropped (the SVG cull learned this the same way). */
function xWindow(arr: { x0: number }[], maxSpan: number, x0: number, x1: number): [number, number] {
  let lo = 0;
  let hi = arr.length;
  const leftBound = x0 - maxSpan;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].x0 < leftBound) lo = mid + 1;
    else hi = mid;
  }
  const wLo = lo;
  hi = arr.length;
  lo = wLo;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].x0 <= x1) lo = mid + 1;
    else hi = mid;
  }
  return [wLo, lo];
}

export function Timeline({ data, viewKey, onCommitClick, selectedCommitId, resetKey, active, onViewFromBranch, onRelatedBranch, compressed, showMergeLinks, showRefLabels, showAnnotations, patchLinks, fitSignal, headSignal, hasMore, dateRangeActive, loadingOlder, busy, onLoadOlder, focusCommit, hiddenIds, traceRows, traceBars, onExpandTraceGroup, traceGroupLabel, headBranch, headLaneHover, memberLanes, onCheckoutBranch, onCompareClick, compareBaseId, onComparePair, onCopyName, onCanvasClick, starredLanes, onToggleStarLane, onFoldLane }: TimelineProps) {
  const { t, theme, lang, hideRemotes } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const minimapRef = useRef<SVGSVGElement>(null);
  const laneRailRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const resetKeyRef = useRef(-1);
  /** Previous frame's data — viewport anchoring across pagination relayouts. */
  const prevDataRef = useRef<GitData | null>(null);
  const [hoveredCommit, setHoveredCommit] = useState<CommitNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [laneMenu, setLaneMenu] = useState<LaneMenu | null>(null);
  /** Endpoints of the last plain-clicked edge; drives the highlight rings. */
  const [edgeHighlight, setEdgeHighlight] = useState<{ from: string; to: string } | null>(null);
  /** Open collapsed-run bubble: the +N chip opens THIS popover (commit list)
   *  instead of exploding the run into overlapping nodes — expanded runs
   *  space at ~11px, far under node size, and read as one blob. The bubble
   *  browses the commits in place; "Expand on canvas" is the explicit,
   *  opt-in spatial verb inside the popover. */
  const [runMenu, setRunMenu] = useState<{ x: number; y: number; run: CollapsedRun } | null>(null);

  const busyDelayed = useDelayedBusy(busy);
  /** True while the camera rests within the page-in probe zone of the oldest
   *  loaded commit AND a date range hides whatever would load there — the
   *  "widen the time scope" hint state (see maybeLoadOlder). */
  const [atOldestEdge, setAtOldestEdge] = useState(false);
  useEffect(() => {
    if (!dateRangeActive) setAtOldestEdge(false);
  }, [dateRangeActive]);
  /** A frame-coalesced repaint scheduled by the zoom handler; component-level
   *  so draw() can cancel a stale frame before rebuilding the scene. */
  const pendingCullRef = useRef(0);
  /** True while a draw restores the camera programmatically (viewport reset
   *  or refresh anchoring): those zoom events must not probe for older
   *  history — see the zoom handler note. */
  const restoringCameraRef = useRef(false);
  /** Trailing debounce for camera persistence: wheel-pan programs one zoom
   *  transform per wheel tick, each firing the behavior's 'end' -- one
   *  localStorage write per burst, not per tick. */
  const viewportSaveTimer = useRef(0);
  /** Where the current canvas press began, so a pan gesture's trailing
   *  click event can be told apart from a deliberate empty-canvas click. */
  const canvasPressRef = useRef<{ x: number; y: number } | null>(null);

  // View-local state (options themselves live in the app header)
  const [focusedLane, setFocusedLane] = useState<string | null>(null);
  const [expandedLanes, setExpandedLanes] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const zoomRef = useRef<d3.ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const sceneBoundsRef = useRef({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  /** The canvas scene model: the immutable primitive lists paint() strokes
   *  and hitTest() classifies against. Rebuilt wholesale by draw(). */
  const modelRef = useRef<CanvasModel | null>(null);
  /** Screen-point classifier (nodes / edges / lane rows), rebuilt by draw()
   *  against the current model. */
  const hitTestRef = useRef<(sx: number, sy: number) => Hit | null>(() => null);
  /** Scene→minimap mapping (uniform scale, letterbox-centered), set during
   *  minimap draw; viewport rect and jump hit-testing read it. */
  const minimapMapRef = useRef<MinimapMap>({ s: 1, x0: 0, y0: 0, boxW: MINIMAP_W, boxH: MINIMAP_H });

  const commitMap = useMemo(() => new Map(data.commits.map(c => [c.id, c])), [data]);
  const branchColorMap = useMemo(() => new Map(data.branches.map(b => [b.name, b.color])), [data]);

  // Unattributed commits (lane_owner "" — a ref-carrying stray from a branch
  // the panel deselected; see layout.rs fallback pass 1) ride the graph
  // without claiming a lane: neutral gray, never the host lane's color.
  const ownerColor = (owner: string) =>
    owner === '' ? UNATTRIBUTED_COLOR : branchColorMap.get(owner) ?? '#4A90D9';

  // Reset view-local state when a different repository is opened.
  useEffect(() => {
    setFocusedLane(null);
    setExpandedLanes(new Set());
    setExpandedIds(new Set());
    setLaneMenu(null);
    setEdgeHighlight(null);
  }, [resetKey]);

  // Header-pill hover reaches into the lane-focus machinery: hovering the
  // position pill flashes the checked-out lane (dims all others) with no
  // click -- the pill IS the "you are here" control, so its hover is the
  // zero-discovery-cost way to pick that lane out of 35. On leave, only a
  // focus WE set is cleared; a chip-clicked focus survives.
  const pillFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (headLaneHover) {
      pillFocusRef.current = headLaneHover;
      setFocusedLane(headLaneHover);
    } else {
      const was = pillFocusRef.current;
      pillFocusRef.current = null;
      setFocusedLane(prev => (prev === was ? null : prev));
    }
  }, [headLaneHover]);

  // Foreign lineage (lane_owner "" — commits of branches with no rendered
  // lane) is hidden outright: a lane shows only its own branch's commits.
  const visibleCommits = useMemo(() => {
    const alive = data.commits.filter(c => !hiddenIds.has(c.id) && c.lane_owner !== '');
    if (!compressed) return alive;
    return alive.filter(c => c.is_key || expandedLanes.has(c.lane_owner) || expandedIds.has(c.id));
  }, [data, compressed, expandedLanes, expandedIds, hiddenIds]);

  // Folded stretches of the compressed view: one chip per maximal run of
  // hidden non-key commits (collapse.ts), so the user expands exactly the
  // segment they care about instead of the whole lane.
  const collapseRunData = useMemo(
    () => (compressed ? collapsedRuns(data.commits, data.branches, hiddenIds, expandedLanes, expandedIds) : []),
    [data, compressed, hiddenIds, expandedLanes, expandedIds],
  );

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  /** Center the viewport on a scene point, keeping the current zoom. Live
   *  container dimensions: callers include the minimap scrubber and the
   *  edge jump verbs, both of which must survive container resizes. */
  const centerOn = useCallback((sx: number, sy: number) => {
    const container = containerRef.current;
    const zoom = zoomRef.current;
    if (!container || !zoom) return;
    const t = transformRef.current;
    const next = d3.zoomIdentity
      .translate(container.clientWidth / 2 - sx * t.k, container.clientHeight / 2 - sy * t.k)
      .scale(t.k);
    d3.select(container).call(zoom.transform, next);
  }, []);

  const draw = useCallback(() => {
    if (!svgRef.current || !containerRef.current) return;
    // Hidden keep-alive tab: clientWidth/Height are 0 under display:none,
    // and this draw's closures (zoom handler, minimapViewport,
    // maybeLoadOlder) would carry that poisoned size into the next visible
    // session -- the minimap box vanishing on every pan of a re-activated
    // tab (0x0 window hits the F2 guard) was exactly this. Nothing is
    // laid out for an invisible container anyway; activation re-runs draw
    // through the `active` dep with real dimensions.
    if (!active) return;

    // A frame-coalesced repaint from the PREVIOUS draw's zoom handler may
    // still be pending; its closures reference the scene this draw is about
    // to wipe. Cancel it — the draw rebuilds everything anyway.
    if (pendingCullRef.current) {
      cancelAnimationFrame(pendingCullRef.current);
      pendingCullRef.current = 0;
    }

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();
    // Canvas backing store sized in device pixels (CSS size stays 100%);
    // assigning width/height clears it — paint() runs at the end of draw.
    const cv = canvasRef.current;
    if (cv) {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(width * dpr));
      cv.height = Math.max(1, Math.round(height * dpr));
    }

    // --- current-lane band ----------------------------------------------------
    // "You are here" extended from a point (the HEAD node's green ring) to
    // a REGION: a translucent band behind the whole checked-out swimlane.
    // Painted FIRST by the canvas (under every scene layer) and pinned to
    // the VIEWPORT's width rather than the scene's, so the band never
    // scrolls out from under the eye on a wide canvas (the sticky ruler's
    // opaque backdrop covers it at the top). The lane comes from the HEAD
    // COMMIT, not the branch name -- detached HEAD and filtered views still
    // land on the row the user is actually on; name matching is only the
    // fallback. Skipped when the lane has no loaded commits.
    const headCommit = data.commits.find(c => c.is_head && !hiddenIds.has(c.id));
    const headLaneIndex = headCommit?.lane
      ?? (headBranch != null ? data.branches.find(b => b.name === headBranch)?.lane_index : undefined)
      ?? null;
    const band = headLaneIndex != null && data.commits.some(c => c.lane === headLaneIndex)
      ? headLaneIndex
      : null;

    const dimOthers = (name: string) => focusedLane !== null && focusedLane !== name;
    const laneOpacity = (name: string) => (dimOthers(name) ? 0.12 : 1);

    // Foreign lineage (lane_owner "") is parked on lane 0 but belongs to no
    // lane — excluded so a lane's track never stretches over hidden commits.
    const laneSpan = new Map<number, { min: number; max: number }>();
    for (const c of data.commits) {
      if (c.lane_owner === '') continue;
      const span = laneSpan.get(c.lane) ?? { min: c.x, max: c.x };
      span.min = Math.min(span.min, c.x);
      span.max = Math.max(span.max, c.x);
      laneSpan.set(c.lane, span);
    }

    // --- the canvas model -----------------------------------------------------
    // Every scene primitive the canvas paints, as plain data + Path2D. The
    // x-window indexes (sorted arrays + xWindow) are the cull: paint and
    // hit-testing binary-search the visible window instead of scanning the
    // whole scene.
    const model: CanvasModel = {
      band,
      gapBreaks: (data.time_gaps ?? []).map(gap => ({
        x: (gap.x_start + gap.x_end) / 2,
        y1: 0,
        y2: 0,
      })),
      laneLines: [],
      laneBars: [],
      laneBarByLane: new Map(),
      traceBars: traceBars.map(tb => ({
        y: tb.laneIndex * LANE_HEIGHT,
        x1: tb.x1,
        x2: tb.x2,
        color: tb.color,
      })),
      patchLinks: [],
      edges: [],
      edgeMaxSpan: 0,
      nodes: [],
      rings: [],
    };

    const allX = data.commits.map(c => c.x);
    const minX = Math.min(...allX, 0) - 180;
    const maxX = Math.max(...allX, 100) + 200;
    const minY = Math.min(...data.commits.map(c => c.y), 0) - LANE_HEIGHT;
    const maxY = Math.max(...data.commits.map(c => c.y), 0) + LANE_HEIGHT;
    for (const gb of model.gapBreaks) { gb.y1 = minY; gb.y2 = maxY; }
    sceneBoundsRef.current = { minX, maxX, minY, maxY };
    // No viewBox: the scene lives in plain pixel space and the zoom transform
    // owns all scaling. (viewBox + zoom double-scales, which made large repos
    // render microscopically small.)

    for (const b of data.branches) {
      const y = b.lane_index * LANE_HEIGHT;
      model.laneLines.push({ y, color: b.color, opacity: dimOthers(b.name) ? 0.05 : 0.3 });
      const span = laneSpan.get(b.lane_index);
      if (!span) continue;
      // Hue already encodes branch identity, so the checked-out lane's
      // emphasis is WEIGHT: a heavier, brighter spine riding the band.
      const entry: LaneBarEntry = {
        lane: b,
        y,
        x1: span.min,
        x2: span.max,
        color: b.color,
        width: b.lane_index === headLaneIndex ? 7 : 4,
        opacity: dimOthers(b.name) ? 0.12 : (b.lane_index === headLaneIndex ? 0.9 : 0.55),
      };
      model.laneBars.push(entry);
      model.laneBarByLane.set(b.lane_index, entry);
    }

    const visibleIds = new Set(visibleCommits.map(c => c.id));
    const visibleEdges = data.edges.filter(e => {
      if (!showMergeLinks && e.edge_type === 'Merge') return false;
      return visibleIds.has(e.from) && visibleIds.has(e.to); // Branch/Merge endpoints are key nodes
    });

    // Edge direction (from the backend): from = child commit, to = parent.
    //
    // Routing rule: a connector may NEVER run horizontally along a live lane
    // — there it rides on top of the lane's own track and becomes
    // indistinguishable from it. Horizontal travel is only allowed before
    // the lane's first commit (fork edges, approaching the lane birth) or
    // after its last commit (merge edges, leaving a lane that folds back).
    // Everything else routes as a forward-flow curve whose x coordinate
    // advances monotonically from the EARLIER commit to the LATER one, so
    // every connector reads left-to-right like the time axis itself.
    //
    // diagCurve: diagonal (~45°) tangents at both ends. The curve departs
    // its lane line immediately (never rides it, upholding the rule above),
    // and the control x's stay strictly between the endpoints (k is capped
    // at 45% of |dx|), so x(t) is monotone: the eye can always tell which
    // commit came first. Authored direction is unchanged per edge type —
    // the flow overlay's dot march keys off it. Time-inverted pairs
    // (rebase/amend clock skew, dx < 0) get the mirrored shape: the line
    // trending backward is then the TRUTH about the data.
    const diagCurve = (x1: number, y1: number, x2: number, y2: number): string => {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx === 0 || dy === 0) return `M ${x1} ${y1} L ${x2} ${y2}`;
      const k = Math.min(Math.abs(dy), Math.abs(dx) * 0.9) * 0.5;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      return `M ${x1} ${y1} C ${x1 + sx * k} ${y1 + sy * k}, ${x2 - sx * k} ${y2 - sy * k}, ${x2} ${y2}`;
    };
    // Rounded elbow: leave (x1,y1) with a VERTICAL tangent and arrive at
    // (x2,y2) with a HORIZONTAL one — the fork/merge route (drop or climb
    // time-aligned with the endpoint commit, then glide in along empty
    // track) with the old 90° kink smoothed away. The control points sit
    // inside the endpoints' rectangle, so the curve itself stays inside it
    // (convex hull) and the no-horizontal-on-a-live-lane invariant holds
    // exactly as it did for the polyline.
    const elbowVH = (x1: number, y1: number, x2: number, y2: number): string => {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx === 0 || dy === 0) return `M ${x1} ${y1} L ${x2} ${y2}`;
      // Corner sharpness scales with the SHORTER leg: tiny hops stay soft,
      // and a long drop keeps most of its time-aligned vertical run.
      const k = Math.min(Math.abs(dx), Math.abs(dy)) * 0.5;
      return `M ${x1} ${y1} C ${x1} ${y1 + Math.sign(dy) * k}, ${x2 - Math.sign(dx) * k} ${y2}, ${x2} ${y2}`;
    };
    const edgePath = (d: CommitEdge): string => {
      const from = commitMap.get(d.from);
      const to = commitMap.get(d.to);
      if (!from || !to) return '';
      if (d.edge_type === 'Direct') {
        return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
      }
      if (d.edge_type === 'Merge') {
        // Merge link: mirrored fork routing — climb out of the merged lane's
        // tip, then glide left into the merge commit along the target lane's
        // EMPTY tail track. Only legal when the parent really is the lane's
        // last commit: if the merged branch lives on (or time runs
        // inverted), the horizontal approach would overlap a live lane.
        const span = laneSpan.get(to.lane);
        const laneEndsAtParent = !!span && to.x >= span.max - 0.5;
        if (to.x <= from.x && laneEndsAtParent) {
          return elbowVH(from.x, from.y, to.x, to.y);
        }
        return diagCurve(from.x, from.y, to.x, to.y);
      }
      // fork (Branch): drop out of the fork-point commit (time-aligned with
      // the commit the branch was born at), then glide right into the child
      // lane's first commit along its EMPTY pre-birth track. Only legal
      // when the child really is the lane's leftmost commit (otherwise the
      // horizontal approach overlaps the already-live child lane).
      const span = laneSpan.get(from.lane);
      const laneBornAtChild = !!span && from.x <= span.min + 0.5;
      if (to.x <= from.x && laneBornAtChild) {
        return elbowVH(to.x, to.y, from.x, from.y);
      }
      // Time-inverted fork (child commit timestamps earlier than the fork
      // commit — rebase/amend artifacts) or displaced lane birth.
      return diagCurve(to.x, to.y, from.x, from.y);
    };
    const isHotEdge = (d: { from: string; to: string }) =>
      edgeHighlight !== null && edgeHighlight.from === d.from && edgeHighlight.to === d.to;

    for (const d of visibleEdges) {
      const from = commitMap.get(d.from);
      const to = commitMap.get(d.to);
      if (!from || !to) continue; // dangling edge datum: undrawable, unhittable
      const dStr = edgePath(d);
      const color = isHotEdge(d) ? cssVar('--edge-hot', '#FFD166')
        : ownerColor(from.lane_owner);
      const width = isHotEdge(d) ? 4
        : d.edge_type === 'Direct' ? 2.5 : d.edge_type === 'Branch' ? 1.8 : 1.3;
      let opacity: number;
      if (isHotEdge(d)) opacity = 1;
      else if (focusedLane && d.edge_type === 'Merge') {
        // in focus mode keep merge links touching the focused lane visible
        const touches = from.lane_owner === focusedLane || to?.lane_owner === focusedLane;
        opacity = touches ? 0.9 : 0.06;
      } else {
        opacity = dimOthers(from.lane_owner) ? 0.08 : (d.edge_type === 'Merge' ? 0.7 : 0.9);
      }
      model.edges.push({
        p: new Path2D(dStr),
        d: dStr,
        type: d.edge_type,
        from: d.from,
        to: d.to,
        color,
        width,
        opacity,
        x0: Math.min(from.x, to.x),
        x1: Math.max(from.x, to.x),
        y0: Math.min(from.y, to.y),
        y1: Math.max(from.y, to.y),
      });
      const span = model.edges[model.edges.length - 1].x1 - model.edges[model.edges.length - 1].x0;
      if (span > model.edgeMaxSpan) model.edgeMaxSpan = span;
    }
    model.edges.sort((a, b) => a.x0 - b.x0);

    // --- patch links: cherry-pick / rebase copies ------------------------------
    // Dashed forward-flow curves between commits carrying the same patch
    // (Copies toggle). Cyan = rebase run, orange = cherry-pick. Under the
    // nodes. Drawn earlier -> later (the copy lands after the original), so
    // the link reads left-to-right like every other connector.
    const patchLinkData = patchLinks.filter(l => visibleIds.has(l.from) && visibleIds.has(l.to));
    for (const l of patchLinkData) {
      const a = commitMap.get(l.from);
      const b = commitMap.get(l.to);
      if (!a || !b) continue;
      const [p, q] = a.x <= b.x ? [a, b] : [b, a];
      model.patchLinks.push({
        p: new Path2D(diagCurve(p.x, p.y, q.x, q.y)),
        color: l.kind === 'rebase' ? cssVar('--patch-rebase', '#26C6DA') : cssVar('--patch-cherry', '#FFA726'),
      });
    }

    for (const c of visibleCommits) {
      model.nodes.push({
        c,
        x: c.x,
        y: c.y,
        r: nodeRadius(c),
        color: ownerColor(c.lane_owner),
        opacity: laneOpacity(c.lane_owner),
        x0: c.x,
        x1: c.x,
      });
    }
    model.nodes.sort((a, b) => a.x0 - b.x0);

    // Rings and markers around individual commits, in paint order (they sit
    // above the node circles). Screen semantics unchanged: selection glow +
    // crisp ring, compare-pending dashed double ring, HEAD green ring, edge
    // highlight amber rings.
    const accent = cssVar('--accent', '#e94560');
    const addRing = (c: CommitNode, r: number, color: string, width: number, opacity: number, dash: number[] = []) => {
      model.rings.push({ x: c.x, y: c.y, r, color, width, opacity, dash });
    };
    for (const c of visibleCommits) {
      if (c.id !== selectedCommitId) continue;
      // Selection halo: a crisp accent ring over a soft wide glow. The accent
      // contrasts with the canvas in every theme (a plain white stroke was
      // invisible on light themes and washed out on pale lane colors).
      addRing(c, nodeRadius(c) + 8, accent, 6, 0.3);
      addRing(c, nodeRadius(c) + 4, accent, 2.5, 1);
    }
    // Pending-compare ring (spec 4.4): ONLY while pairing is incomplete
    // (compareBaseId is non-null exactly then) the waiting base gets a
    // double ring, so the node the next ctrl+click will pair against is
    // obvious. Three ring semantics share the canvas and must stay
    // distinguishable at a glance: single-select = accent (soft glow +
    // crisp ring, r+8/r+4), HEAD = green (r+5), compare-pending =
    // --compare-ring, dashed, thinner, and one step wider (r+11/r+7).
    if (compareBaseId) {
      const pending = cssVar('--compare-ring', '#b388ff');
      for (const c of visibleCommits) {
        if (c.id !== compareBaseId) continue;
        addRing(c, nodeRadius(c) + 11, pending, 5, 0.25);
        addRing(c, nodeRadius(c) + 7, pending, 1.5, 1, [4, 3]);
      }
    }
    for (const c of visibleCommits) {
      if (!c.is_head) continue;
      addRing(c, nodeRadius(c) + 5, cssVar('--success', '#4CAF50'), 2, laneOpacity(c.lane_owner));
    }
    // edge-click highlight: amber rings around the two endpoint commits
    if (edgeHighlight) {
      for (const c of visibleCommits) {
        if (c.id !== edgeHighlight.from && c.id !== edgeHighlight.to) continue;
        addRing(c, nodeRadius(c) + 6, cssVar('--edge-hot', '#FFD166'), 2.5, laneOpacity(c.lane_owner));
      }
    }
    modelRef.current = model;

    // Screen-point classifier against THIS model. Nodes win over edges (they
    // render above them, as in the old stacking); edges hit-test through
    // Path2D stroke containment — the old invisible 14px fat strokes, minus
    // 2.7k DOM paths. Lane rows hit-test as a band (the old target was a 4px
    // bar stroke; the band is the same verb with a humane target). The stroke
    // test runs with an IDENTITY transform and a scene-space point, so both
    // sides of the predicate live in the same untransformed space.
    hitTestRef.current = (sx: number, sy: number): Hit | null => {
      const m = modelRef.current;
      if (!m || !cv) return null;
      const t = transformRef.current;
      // Caller coordinates are CLIENT coordinates; the scene lives relative
      // to the canvas' own box (the container is not at viewport origin).
      const rect = cv.getBoundingClientRect();
      const px = (sx - rect.left - t.x) / t.k;
      const py = (sy - rect.top - t.y) / t.k;
      let best: CommitNode | null = null;
      let bestD2 = Infinity;
      const [nLo, nHi] = xWindow(m.nodes, 0, px - 48, px + 48);
      for (let i = nLo; i < nHi; i++) {
        const n = m.nodes[i];
        const dx = px - n.x;
        const dy = py - n.y;
        const d2 = dx * dx + dy * dy;
        const r = n.r + 4;
        if (d2 <= r * r && d2 < bestD2) {
          bestD2 = d2;
          best = n.c;
        }
      }
      if (best) return { kind: 'node', c: best };
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && m.edges.length > 0) {
        const margin = 14 / t.k;
        const [eLo, eHi] = xWindow(m.edges, m.edgeMaxSpan, px, px);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.lineWidth = margin * 2;
        for (let i = eHi - 1; i >= eLo; i--) {
          const e = m.edges[i];
          if (py < e.y0 - margin || py > e.y1 + margin) continue;
          if (ctx.isPointInStroke(e.p, px, py)) {
            ctx.restore();
            return { kind: 'edge', edge: { from: e.from, to: e.to } };
          }
        }
        ctx.restore();
      }
      const laneIdx = Math.round(py / LANE_HEIGHT);
      const bar = m.laneBarByLane.get(laneIdx);
      if (bar && Math.abs(py - laneIdx * LANE_HEIGHT) <= 20 && px >= bar.x1 - 30 && px <= bar.x2 + 30) {
        return { kind: 'lane', lane: bar.lane };
      }
      return null;
    };

    // --- the SVG overlay -------------------------------------------------------
    // Text and the few interactive widgets, in one detached group mounted in
    // one insertion. pointer-events are none at the svg root (canvas hit-
    // testing owns the pointer); the widgets re-enable it individually.
    const g = d3.create('svg:g').attr('class', 'timeline-content');

    // --- inactive-lane sediment hit rows --------------------------------------
    // Full-width invisible click targets for expanding a sediment group.
    const traceLabel = (r: TraceRow) =>
      t(r.kind === 'hidden' ? 'hiddenLanes'
        : r.kind === 'archived' ? 'archivedLanes' : 'dormantLanes', { n: r.count });
    g.selectAll('.trace-hit')
      .data(traceRows)
      .enter()
      .append('rect')
      .attr('class', 'trace-hit')
      .attr('x', minX - 50)
      .attr('width', maxX + 100 - (minX - 50))
      .attr('y', (d: TraceRow) => d.laneIndex * LANE_HEIGHT - 12)
      .attr('height', 24)
      .attr('fill', 'rgba(0,0,0,0)')
      .style('cursor', 'pointer')
      .on('click', (event: MouseEvent, d: TraceRow) => {
        event.stopPropagation();
        onExpandTraceGroup(d.kind);
      })
      .append('title')
      .text((d: TraceRow) => `${traceLabel(d)} — ${traceGroupLabel(d.kind)}`);

    // --- collapsed-run chips ---------------------------------------------------
    if (compressed) {
      const chips = g.selectAll('.collapse-chip')
        .data(collapseRunData)
        .enter()
        .append('g')
        .attr('class', 'collapse-chip')
        // The chip floats just ABOVE the lane line: centered in the gap
        // between the run's bracketing nodes (collapse.ts), so it never
        // covers a node and never blocks a merge edge's origin.
        .attr('transform', d => `translate(${d.x}, ${d.lane_index * LANE_HEIGHT - 16})`)
        .style('cursor', 'pointer')
        .on('click', (e, d) => {
          // The bubble verb: browse the run's commits in a popover. The old
          // expand-in-place exploded N commits at ~11px spacing (layout's
          // interpolated cascade) — a blob, not information.
          e.stopPropagation();
          setRunMenu({ x: e.clientX, y: e.clientY, run: d });
        });
      chips.append('rect')
        .attr('x', -18).attr('y', -9)
        .attr('width', 36).attr('height', 18)
        .attr('rx', 9)
        .attr('fill', cssVar('--bg-input', '#2a2a2a'))
        .attr('stroke', d => d.color)
        .attr('stroke-width', 1);
      chips.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', 3)
        .attr('font-size', '10px')
        .attr('fill', cssVar('--text-dim', '#bbbbbb'))
        .text(d => `+${d.ids.length}`);
      chips.append('title').text(d => t('collapsedTip', { n: d.ids.length }));
    }

    // HEAD label above the checked-out commit (the ring itself is canvas).
    for (const c of visibleCommits) {
      if (!c.is_head) continue;
      g.append('text')
        .attr('class', 'head-mark')
        .attr('x', c.x).attr('y', c.y - nodeRadius(c) - 10)
        .attr('font-size', '10px')
        .attr('font-weight', 'bold')
        .attr('text-anchor', 'middle')
        .attr('fill', cssVar('--success', '#4CAF50'))
        .attr('pointer-events', 'none')
        .attr('opacity', laneOpacity(c.lane_owner))
        .datum(c)
        .text('HEAD');
    }

    // Flow-direction overlay on the clicked edge: round dots marching from
    // the PARENT commit to the CHILD commit — the direction data flows — so
    // fork (downstream into the new lane) vs merge (upstream into the merge
    // commit) is obvious at a glance. March direction follows the path's
    // authoring direction: fork paths start at the parent, merge/direct
    // paths at the child.
    if (edgeHighlight) {
      const hot = model.edges.find(e => isHotEdge(e));
      if (hot) {
        g.append('path')
          .attr('class', `edge-flow ${hot.type === 'Branch' ? 'flow-fwd' : 'flow-rev'}`)
          .attr('d', hot.d)
          .attr('fill', 'none')
          .attr('stroke', cssVar('--edge-flow', '#FFF3C4'))
          .attr('stroke-width', 5)
          .attr('stroke-linecap', 'round')
          .attr('stroke-dasharray', '0 18')
          .attr('pointer-events', 'none');
      }
    }

    // NOTE: no SVG <title> on nodes — the custom HTML tooltip below covers
    // hover; a native title would show up as a second, redundant popup.

    // --- shared text-collision occupancy -----------------------------------
    // Every in-scene text element (ref badges, fork/merge annotations)
    // registers its bounding box here. Anything that can't find a free slot
    // is dropped instead of overlapping — badges may climb levels to find
    // space, annotations are simply skipped. Commit messages and short ids
    // are intentionally NOT drawn on the canvas: hover tooltip and the
    // CommitDetails panel carry them, and the badges own this space now.
    interface TextBox { x0: number; y0: number; x1: number; y1: number }
    const placedBoxes: TextBox[] = [];
    const boxCollides = (b: TextBox) =>
      placedBoxes.some(p => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);

    // --- hidden-source merge badges ------------------------------------------
    // With a merge edge's source lane excluded (★/active view modes) or
    // folded, the edge vanishes together with its source commit — the merge
    // becomes undetectable on the canvas. A compact 🔀 glyph on the target
    // node keeps the fact visible at any zoom, independent of the
    // annotation toggles; when the full merge annotations are on they
    // already draw "🔀 name" and the badge stands down to avoid doubles.
    if (!(showAnnotations && showMergeLinks)) {
      const hiddenSourceMerges = new Set<string>();
      for (const e of data.edges) {
        if (e.edge_type !== 'Merge') continue;
        if (visibleIds.has(e.to) && !visibleIds.has(e.from)) hiddenSourceMerges.add(e.to);
      }
      const targets = visibleCommits.filter(c => hiddenSourceMerges.has(c.id));
      if (targets.length > 0) {
        const badges = g.selectAll('.merge-badge')
          .data(targets)
          .enter()
          .append('g')
          .attr('class', 'merge-badge')
          .attr('transform', (d: CommitNode) => `translate(${d.x}, ${d.y - nodeRadius(d) - 8})`)
          .attr('opacity', (d: CommitNode) => laneOpacity(d.lane_owner));
        badges.append('text')
          .attr('text-anchor', 'middle')
          .attr('y', -2)
          .attr('font-size', '10px')
          .text('🔀');
        badges.append('title')
          .text((d: CommitNode) => t('hiddenMergeTip', { name: d.merge_branch_name ?? '' }));
      }
    }

    // --- ref badges, collision-resolved against all placed text ------------
    // A commit shows at most two pills (first ref + "+N"). A pill group that
    // would overlap any already-placed text box is pushed to a higher level;
    // groups that find no free level are dropped (their refs stay reachable
    // through the node tooltip and the CommitDetails panel).
    if (showRefLabels) {
      const pillW = (name: string) => name.length * 5.6 + 14;
      const LEVEL_H = 40;
      const MAX_LEVEL = 3;
      const specs: BadgeSpec[] = [];
      // Remote-ref filter runs FIRST (spec 4.3): slice(0, 2), the "+N" count
      // and the full-name <title> all derive from the FILTERED list -- a
      // hidden remote must never leave a "+1" pill with nothing behind it.
      const withRefs = visibleCommits
        .map(c => ({ c, refs: filterRefs(c.branch_refs, hideRemotes) }))
        .filter(e => e.refs.length > 0)
        .sort((a, b) => a.c.x - b.c.x);
      // A local branch and its remote-tracking counterpart collapse into ONE
      // pill: any remote whose post-prefix name matches a local ref
      // (upstream/x folds into x too) drops out, and the local pill earns a
      // cloud marker. The folded names stay in the tooltip and <title>.
      const foldRemotes = (refs: BranchRef[]): { shown: BranchRef[]; synced: Set<string> } => {
        const locals = new Set(refs.filter(r => !r.is_remote && !r.is_tag).map(r => r.name));
        const synced = new Set<string>();
        const shown = refs.filter(r => {
          if (!r.is_remote) return true;
          const slash = r.name.indexOf('/');
          if (slash >= 0 && locals.has(r.name.slice(slash + 1))) {
            synced.add(r.name.slice(slash + 1));
            return false;
          }
          return true;
        });
        return { shown, synced };
      };
      for (const { c, refs } of withRefs) {
        const folded = foldRemotes(refs);
        const shown = folded.shown.slice(0, 2);
        const extra = folded.shown.length - shown.length;
        const names: BadgePill[] = shown.map(r => ({
          name: r.name,
          is_tag: r.is_tag,
          is_remote: r.is_remote,
          synced: folded.synced.has(r.name),
        }));
        if (extra > 0) names.push({ name: `+${extra}`, is_tag: false, is_remote: false, synced: false });
        const pillText = (n: BadgePill) => (n.synced ? `${n.name} ⤒` : n.name);
        const width = Math.max(...names.map(n => pillW(pillText(n))));
        const stackH = (names.length - 1) * 18;
        let level = -1;
        for (let l = 0; l <= MAX_LEVEL; l++) {
          const gy = c.y - nodeRadius(c) - 8 - l * LEVEL_H;
          const box: TextBox = {
            x0: c.x - width / 2 - 2,
            y0: gy - stackH - 15,
            x1: c.x + width / 2 + 2,
            y1: gy + 4,
          };
          if (!boxCollides(box)) {
            placedBoxes.push(box);
            level = l;
            break;
          }
        }
        if (level < 0) continue;
        specs.push({ c, refs, names, level });
      }
      const badgeGroups = g.selectAll('.ref-badges')
        .data(specs)
        .enter()
        .append('g')
        .attr('class', 'ref-badges')
        .attr('transform', s => `translate(${s.c.x}, ${s.c.y - nodeRadius(s.c) - 8 - s.level * LEVEL_H})`)
        .attr('opacity', s => laneOpacity(s.c.lane_owner));
      badgeGroups.each(function (s) {
        const grp = d3.select(this);
        grp.append('title').text(s.refs.map(r => r.name).join('\n'));
        // Connector pin from the pill stack down to its commit node — without
        // it, badges lifted to higher levels look detached from their commit.
        const dropY = 8 + s.level * LEVEL_H;
        if (dropY > 6) {
          grp.append('line')
            .attr('x1', 0).attr('y1', 4)
            .attr('x2', 0).attr('y2', dropY)
            .attr('stroke', cssVar('--text-faint', '#888888'))
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '2,2')
            .attr('opacity', 0.65);
        }
        s.names.forEach((n, i) => {
          const w = pillW(n.synced ? `${n.name} ⤒` : n.name);
          // Remote-tracking pills read as SECONDARY: outline style (canvas
          // fill + lane-color stroke/text) against the local pills' solid
          // lane-color fill. Tags keep their solid purple.
          const outline = n.is_remote && !n.is_tag;
          const laneColor = ownerColor(s.c.lane_owner);
          const item = grp.append('g')
            .datum(n)
            .attr('class', n.is_tag ? 'pill pill-tag' : 'pill')
            .attr('transform', `translate(${-w / 2}, ${-i * 18})`);
          item.append('rect')
            .attr('x', 0).attr('y', -13)
            .attr('width', w).attr('height', 16)
            .attr('rx', 8)
            .attr('fill', n.is_tag ? cssVar('--tag-pill', '#9C27B0') : n.name.startsWith('+') ? cssVar('--text-faint', '#555555') : outline ? cssVar('--bg-canvas', '#1a1a2e') : laneColor)
            .attr('stroke', outline ? laneColor : 'none')
            .attr('stroke-width', outline ? 1 : 0)
            .attr('opacity', 0.92);
          const label = item.append('text')
            .attr('x', w / 2).attr('y', -2)
            .attr('text-anchor', 'middle')
            .attr('font-size', '10px')
            .attr('fill', outline ? laneColor : '#fff');
          if (n.synced) {
            label.append('tspan').text(n.name);
            label.append('tspan').attr('opacity', 0.7).text(' ⤒');
          } else if (n.is_remote && n.name.includes('/')) {
            // Dim the remote prefix (origin/) so the branch name pops.
            const cut = n.name.indexOf('/') + 1;
            label.append('tspan').attr('opacity', 0.55).text(n.name.slice(0, cut));
            label.append('tspan').text(n.name.slice(cut));
          } else {
            label.text(n.name);
          }
        });
      });
    }

    // --- fork / merge annotations -------------------------------------------
    // Annotations climb levels like ref badges when their preferred slot is
    // taken (fork labels grow downward from the node, merge labels upward),
    // and every annotation gets a dashed connector back to its commit node so
    // ownership is unambiguous even when lifted far away. Beyond
    // MAX_ANN_LEVEL there is no sane space left; only then is one dropped.
    // Each branch name is rendered in its own lane's color, so the label
    // visually points at the lane it talks about.
    interface AnnSpec { c: CommitNode; level: number }
    interface AnnPart { text: string; color: string }
    const ANN_H = 18;
    const MAX_ANN_LEVEL = 8;

    const drawAnnotations = (
      className: string,
      commits: CommitNode[],
      partsOf: (c: CommitNode) => AnnPart[],
      fallbackColor: string,
      // level-0 baseline relative to the commit, and growth direction
      baseY: (c: CommitNode) => number,
      dir: 1 | -1,
    ) => {
      const fullText = (c: CommitNode) => partsOf(c).map(p => p.text).join('');
      const specs: AnnSpec[] = [];
      for (const c of [...commits].sort((a, b) => a.x - b.x)) {
        const w = fullText(c).length * 5.4;
        for (let l = 0; l <= MAX_ANN_LEVEL; l++) {
          const baseline = baseY(c) + dir * l * ANN_H;
          const box: TextBox = { x0: c.x - w / 2, y0: baseline - 9, x1: c.x + w / 2, y1: baseline + 3 };
          if (!boxCollides(box)) {
            placedBoxes.push(box);
            specs.push({ c, level: l });
            break;
          }
        }
      }

      const grps = g.selectAll(`.${className}`)
        .data(specs)
        .enter()
        .append('g')
        .attr('class', className)
        .attr('transform', s => `translate(${s.c.x}, ${baseY(s.c) + dir * s.level * ANN_H})`)
        .attr('opacity', s => laneOpacity(s.c.lane_owner));

      // Connector pin from the label back to the node edge (in group coords
      // the node sits at y = -dir * (offset from baseline to node center)).
      grps.append('line')
        .attr('x1', 0).attr('y1', dir === 1 ? -9 : 3)
        .attr('x2', 0)
        .attr('y2', s => {
          const nodeEdgeY = dir === 1 ? s.c.y + nodeRadius(s.c) : s.c.y - nodeRadius(s.c);
          return nodeEdgeY - (baseY(s.c) + dir * s.level * ANN_H);
        })
        .attr('stroke', s => partsOf(s.c)[0]?.color ?? fallbackColor)
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')
        .attr('opacity', 0.65);

      const texts = grps.append('text')
        .attr('font-size', '10px')
        .attr('text-anchor', 'middle');
      texts.each(function (s) {
        const t = d3.select(this);
        for (const part of partsOf(s.c)) {
          t.append('tspan').attr('fill', part.color).text(part.text);
        }
      });
    };

    const laneColorOf = (name: string, fallback: string) =>
      branchColorMap.get(name) ?? fallback;

    // Fork/merge annotations are opt-in (showAnnotations, default off): the
    // hover tooltip carries the same names, so the canvas stays quiet.
    if (showAnnotations) {
      drawAnnotations(
        'fork-label',
        visibleCommits.filter(c => c.fork_branch_name),
        c => (c.fork_branch_name ?? '').split(', ').map((name, i) => ({
          text: (i === 0 ? '🌱 ' : ', ') + name,
          color: laneColorOf(name, '#4A90D9'),
        })),
        '#4A90D9',
        c => c.y + 24,
        1,
      );

      if (showMergeLinks) {
        drawAnnotations(
          'merge-label',
          visibleCommits.filter(c => c.merge_branch_name),
          c => [{
            text: `🔀 ${c.merge_branch_name}`,
            color: laneColorOf(c.merge_branch_name ?? '', cssVar('--accent', '#E91E63')),
          }],
          cssVar('--accent', '#E91E63'),
          c => c.y - nodeRadius(c) - 8,
          -1,
        );
      }
    }

    // --- canvas paint ----------------------------------------------------------
    // Immediate-mode stroke of the visible window. Line widths are in scene
    // units so they scale with zoom exactly as the SVG stroke-widths did.
    const paint = () => {
      const m = modelRef.current;
      if (!cv || !m) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const t = transformRef.current;
      const w = cv.width / dpr;
      const h = cv.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (m.band != null) {
        ctx.fillStyle = cssVar('--head-lane-band', 'rgba(76, 175, 80, 0.08)');
        ctx.fillRect(0, t.applyY(m.band * LANE_HEIGHT) - (LANE_HEIGHT / 2) * t.k, w, LANE_HEIGHT * t.k);
      }
      const vx0 = -t.x / t.k;
      const vx1 = (w - t.x) / t.k;
      const vy0 = -t.y / t.k;
      const vy1 = (h - t.y) / t.k;
      ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
      // gap breaks
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = cssVar('--gap-break', '#a06a3a');
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      for (const gb of m.gapBreaks) {
        if (gb.x < vx0 || gb.x > vx1) continue;
        ctx.moveTo(gb.x, gb.y1);
        ctx.lineTo(gb.x, gb.y2);
      }
      ctx.stroke();
      // lane guide lines
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      for (const ll of m.laneLines) {
        if (ll.y < vy0 || ll.y > vy1) continue;
        ctx.globalAlpha = ll.opacity;
        ctx.strokeStyle = ll.color;
        ctx.beginPath();
        ctx.moveTo(minX - 50, ll.y);
        ctx.lineTo(maxX + 50, ll.y);
        ctx.stroke();
      }
      // lane bars + trace bars: round caps
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      for (const bar of m.laneBars) {
        if (bar.y < vy0 || bar.y > vy1) continue;
        ctx.globalAlpha = bar.opacity;
        ctx.strokeStyle = bar.color;
        ctx.lineWidth = bar.width;
        ctx.beginPath();
        ctx.moveTo(bar.x1, bar.y);
        ctx.lineTo(bar.x2, bar.y);
        ctx.stroke();
      }
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.3;
      for (const tb of m.traceBars) {
        if (tb.y < vy0 || tb.y > vy1) continue;
        ctx.strokeStyle = tb.color;
        ctx.beginPath();
        ctx.moveTo(tb.x1, tb.y);
        ctx.lineTo(tb.x2, tb.y);
        ctx.stroke();
      }
      // patch links (under the nodes, dashed)
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.75;
      for (const pl of m.patchLinks) {
        ctx.strokeStyle = pl.color;
        ctx.stroke(pl.p);
      }
      // edges
      ctx.setLineDash([]);
      const [eLo, eHi] = xWindow(m.edges, m.edgeMaxSpan, vx0, vx1);
      for (let i = eLo; i < eHi; i++) {
        const e = m.edges[i];
        if (e.y1 < vy0 || e.y0 > vy1) continue;
        ctx.globalAlpha = e.opacity;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = e.width;
        ctx.stroke(e.p);
      }
      // nodes
      ctx.lineCap = 'butt';
      const [nLo, nHi] = xWindow(m.nodes, 0, vx0 - 20, vx1 + 20);
      for (let i = nLo; i < nHi; i++) {
        const n = m.nodes[i];
        if (n.y < vy0 || n.y > vy1) continue;
        ctx.globalAlpha = n.opacity;
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // rings
      ctx.setLineDash([]);
      for (const r of m.rings) {
        if (r.y < vy0 || r.y > vy1) continue;
        ctx.globalAlpha = r.opacity;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = r.width;
        ctx.setLineDash(r.dash);
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };

    // --- overlay + chip cull (the DOM half of the per-frame sync) --------------
    // The canvas paints only the visible window by construction; the SVG
    // overlay's few dozen widgets still cull display, and the pinned chip
    // rail repositions.
    const cullOverlay = () => {
      const t = transformRef.current;
      const M = 240; // scene-px margin around the viewport
      const x0 = -t.x / t.k - M;
      const x1 = (width - t.x) / t.k + M;
      const y0 = -t.y / t.k - M;
      const y1 = (height - t.y) / t.k + M;
      const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

      // Density mute: below the label row-height threshold the pill stack
      // and the fork/merge annotations drop out entirely; HEAD and tag
      // pills stay readable at any zoom.
      const rowH = LANE_HEIGHT * t.k;
      const labelsMuted = rowH < LABEL_MIN_ROW_H;

      g.selectAll<SVGGElement, BadgeSpec>('.ref-badges')
        .style('display', d => {
          if (!inView(d.c.x, d.c.y)) return 'none';
          if (labelsMuted && !d.names.some(n => n.is_tag)) return 'none';
          return null;
        });
      g.selectAll<SVGGElement, BadgePill>('.ref-badges .pill')
        .style('display', d => (labelsMuted && !d.is_tag ? 'none' : null));
      g.selectAll<SVGGElement, AnnSpec>('.fork-label,.merge-label')
        .style('display', d => (labelsMuted || !inView(d.c.x, d.c.y) ? 'none' : null));
      // The hidden-source merge badge is load-bearing at any zoom (often
      // the only evidence of the merge) — cull by view, never mute.
      g.selectAll<SVGGElement, CommitNode>('.merge-badge')
        .style('display', d => (inView(d.x, d.y) ? null : 'none'));
      g.selectAll<SVGTextElement, CommitNode>('.head-mark')
        .style('display', d => (inView(d.x, d.y) ? null : 'none'));
      rail.selectAll<HTMLDivElement, BranchLane>('.lane-chip')
        .style('display', d => {
          const y = d.lane_index * LANE_HEIGHT;
          if (y < y0 || y > y1) return 'none';
          // keep clear of the sticky ruler band
          const sy = y * t.k + t.y;
          if (sy < 34 || sy > height - 8) return 'none';
          // At heavy zoom-out lanes squeeze together; thin the pinned chips so
          // they never overlap on screen (every Nth lane keeps its label).
          if (rowH < 18 && d.lane_index % Math.ceil(18 / rowH) !== 0) return 'none';
          return null;
        })
        .style('top', d => `${d.lane_index * LANE_HEIGHT * t.k + t.y - 9}px`);
      g.selectAll<SVGGElement, CollapsedRun>('.collapse-chip')
        .style('display', d => (inView(d.x, d.lane_index * LANE_HEIGHT - 16) ? null : 'none'));
      g.selectAll<SVGRectElement, TraceRow>('.trace-hit')
        .style('display', d => {
          const y = d.laneIndex * LANE_HEIGHT;
          return y >= y0 && y <= y1 ? null : 'none';
        });
    };

    // --- zoom ----------------------------------------------------------------
    const minimapViewport = () => {
      if (!minimapRef.current) return;
      const t = transformRef.current;
      // screen = t * scene ; scene->mini = uniform scale + letterbox (./minimap)
      // LIVE container size, not the draw-time capture: the container can
      // collapse to 0 (or recover) between draws -- panel toggles, macOS
      // live window resize -- and the zero-window guard must judge the
      // window that IS, or a 0-size draw poisons the rect until the next
      // full redraw while every later pan/zoom keeps reading stale dims.
      const w = containerRef.current?.clientWidth || width;
      const h = containerRef.current?.clientHeight || height;
      const r = viewportRect(t.k, t.x, t.y, w, h, minimapMapRef.current);
      d3.select(minimapRef.current).select('.mm-viewport')
        .attr('x', r.x).attr('y', r.y)
        .attr('width', r.w).attr('height', r.h);
    };

    // Near the oldest (left) edge of the scene? Page in the next chunk of
    // history. Covers drag-pan, wheel-pan and minimap jumps — all of them
    // funnel through this zoom handler. The probe margin is a fixed
    // scene-px budget, NOT the viewport width in scene coordinates: at
    // overview zoom (width/k spans the whole scene) the old margin made the
    // condition always-true, so any redraw — a fetch refresh, a view-mode
    // switch — cascaded page-ins (backend walk + full scene rebuild each)
    // until has_more ran out, on a resting camera the user never panned
    // (the fetch -> star -> starred view fan-spin report). At >= 1x zoom
    // the viewport width is the smaller value and nothing changes; panning
    // to the actual oldest edge still pages exactly as before, one chunk
    // per approach — after a page the scene grows ~28k scene-px to the
    // left, which alone drops the resting camera out of the zone.
    //
    // With a DATE RANGE active the scene cannot grow: every page the
    // backend loads is filtered out of the display, so the same probe stays
    // true and the cascade runs away (each round a relayout plus a lazy
    // stats merge — the big/small node flicker report) while nothing new
    // ever appears. There, reaching the edge lights the widen-the-scope
    // hint instead of loading; widening reveals what is already loaded
    // instantly, because the backend session already holds it.
    const maybeLoadOlder = (t: d3.ZoomTransform) => {
      if (!hasMore || loadingOlder) {
        setAtOldestEdge(false);
        return;
      }
      const visibleLeft = -t.x / t.k;
      const probe = Math.min(width / t.k, EDGE_PROBE_SCENE_PX);
      const atEdge = visibleLeft < sceneBoundsRef.current.minX + probe;
      if (dateRangeActive) {
        setAtOldestEdge(atEdge);
        return;
      }
      setAtOldestEdge(false);
      if (atEdge) onLoadOlder();
    };

    // Frame-coalesced follow-up work: the transform itself applies per zoom
    // event (the overlay group tracks the pointer exactly; the canvas
    // repaints), while the per-event bookkeeping — canvas paint, overlay
    // cull, the minimap viewport, the ruler — runs at most ONCE per
    // animation frame. The rAF callback reads transformRef (always the
    // LATEST transform), so the final frame of a gesture is guaranteed to
    // paint against the resting camera. draw() cancels a pending frame
    // before rebuilding the scene.
    const scheduleFrame = () => {
      if (pendingCullRef.current) return;
      pendingCullRef.current = requestAnimationFrame(() => {
        pendingCullRef.current = 0;
        paint();
        cullOverlay();
        minimapViewport();
        updateRuler?.();
      });
    };

    const zoom = d3.zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.005, 40])
      // Wheel events are handled by our own trackpad-friendly handler
      // (scroll = pan, pinch/ctrl = zoom); d3 only keeps drag-pan. Everything
      // that is NOT the graph surface (chip rail, minimap, menus, toolbar)
      // stays out of the gesture — it all bubbles to the container now.
      .filter((event: Event) => {
        if (event.type === 'wheel') return false;
        const target = event.target as Element | null;
        return !target?.closest('.lane-rail,.minimap,.view-toolbar,.lane-menu,.run-menu,.tooltip,.render-overlay,.locate-float');
      })
      .on('zoom', (event: d3.D3ZoomEvent<HTMLDivElement, unknown>) => {
        transformRef.current = event.transform;
        g.attr('transform', event.transform.toString());
        scheduleFrame();
        // Pagination is a USER-navigation behavior (pan / minimap jump /
        // search jump). The camera-restore transforms at the end of every
        // draw fire this same event; letting them probe loaded a page of
        // older history on every fetch refresh and view-mode switch — each
        // a backend walk plus a full scene rebuild, repeating while the
        // edge stayed reachable (the fetch -> star -> starred view fan-spin
        // report). Draw-time restores set restoringCamera below.
        if (!restoringCameraRef.current) maybeLoadOlder(event.transform);
      })
      .on('end', () => {
        // Remember the camera wherever a gesture (or a programmatic camera
        // move -- refresh anchoring, jumps) leaves it. The transform is
        // captured now: a viewKey switch racing the debounce must not file
        // this camera under the new repo's path.
        if (!viewKey) return;
        const t = transformRef.current;
        window.clearTimeout(viewportSaveTimer.current);
        viewportSaveTimer.current = window.setTimeout(() => saveViewport(viewKey, t), 250);
      });
    // Every draw installs a fresh zoom behavior; d3 registers its DOM
    // listeners under the .zoom namespace, so strip the previous draw's set
    // first -- without this, stacked behaviors accumulate one listener set
    // per redraw and all of them fight over the same gesture.
    const containerSel = d3.select(container);
    containerSel.on('.zoom', null);
    containerSel.call(zoom);
    zoomRef.current = zoom;

    // --- sticky time ruler ---------------------------------------------------
    // Lives OUTSIDE the zoomable scene: pinned to the top of the canvas with
    // an opaque backdrop. The time→x mapping is piecewise-linear, anchored on
    // the commits THEMSELVES — not just the time span endpoints: the backend
    // stretches x with a per-lane min-spacing cascade, so a two-endpoint map
    // drifts by days in dense regions. Same-timestamp commits on different
    // lanes can sit at different x; their mean is the compromise anchor.
    // Ticks are generated for the VISIBLE time window only, so zooming in
    // refines their precision; ticks falling inside a folded gap are dropped.
    let updateRuler: (() => void) | null = null;
    if (data.commits.length > 1) {
      const gaps = [...(data.time_gaps ?? [])].sort((a, b) => a.x_start - b.x_start);

      // One anchor per distinct commit timestamp (mean x), x forced
      // non-decreasing so the map stays monotone.
      const byTime = new Map<number, { sum: number; n: number }>();
      for (const c of data.commits) {
        const e = byTime.get(c.timestamp);
        if (e) { e.sum += c.x; e.n++; } else byTime.set(c.timestamp, { sum: c.x, n: 1 });
      }
      const times: number[] = [];
      const xs: number[] = [];
      for (const [t, agg] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
        times.push(t);
        const x = agg.sum / agg.n;
        xs.push(xs.length > 0 ? Math.max(x, xs[xs.length - 1]) : x);
      }
      const lerpAnchors = (v: number, from: number[], to: number[]): number => {
        if (v <= from[0]) return to[0];
        for (let i = 1; i < from.length; i++) {
          if (v <= from[i]) {
            const d = from[i] - from[i - 1];
            return d <= 0 ? to[i] : to[i - 1] + (to[i] - to[i - 1]) * (v - from[i - 1]) / d;
          }
        }
        return to[to.length - 1];
      };
      const timeToX = (t: number) => lerpAnchors(t, times, xs);
      const xToTime = (x: number) => lerpAnchors(x, xs, times);
      const inGap = (t: number) => gaps.some(gp => t > gp.t_start && t < gp.t_end);

      const ruler = svg.append('g')
        .attr('class', 'time-ruler-sticky')
        .attr('pointer-events', 'none');
      ruler.append('rect')
        .attr('x', 0).attr('y', 0)
        .attr('width', width).attr('height', 26)
        .attr('fill', cssVar('--bg-canvas', '#1a1a2e'));
      ruler.append('line')
        .attr('x1', 0).attr('x2', width)
        .attr('y1', 26).attr('y2', 26)
        .attr('stroke', cssVar('--ruler-line', '#2c2c3e'))
        .attr('stroke-width', 1);
      const axisG = ruler.append('g').attr('transform', 'translate(0, 26)');

      const pad2 = (n: number) => String(n).padStart(2, '0');
      const fmtDuration = (sec: number): string => {
        const days = sec / 86400;
        if (days < 90) return `${Math.max(1, Math.round(days))}d`;
        if (days < 730) return `${Math.round(days / 30.4)}mo`;
        return `${(days / 365.25).toFixed(1)}y`;
      };

      updateRuler = () => {
        const t = transformRef.current;
        // Visible time window (with margin), so ticks adapt to the zoom level.
        const vt0 = xToTime(-t.x / t.k - 100);
        const vt1 = xToTime((width - t.x) / t.k + 100);
        if (!(vt1 > vt0)) return;
        const shown = d3.scaleTime()
          .domain([new Date(vt0 * 1000), new Date(vt1 * 1000)])
          .ticks(Math.max(3, Math.floor(width / 150)))
          .filter(d => !inGap(d.getTime() / 1000));

        // Pick a precision strictly finer than the tightest tick gap, so two
        // adjacent labels can never read the same (e.g. four "2026-01" ticks).
        let minGapSec = Infinity;
        for (let i = 1; i < shown.length; i++) {
          minGapSec = Math.min(minGapSec, (shown[i].getTime() - shown[i - 1].getTime()) / 1000);
        }
        const fmtTick = (dt: Date): string => {
          const date = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
          if (minGapSec >= 250 * 86400) return `${dt.getFullYear()}`;
          if (minGapSec >= 25 * 86400) return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
          if (minGapSec >= 20 * 3600) return date;
          const time = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
          if (minGapSec >= 40 * 60) return `${date} ${time}`;
          return `${date} ${time}:${pad2(dt.getSeconds())}`;
        };

        const tick = axisG
          .selectAll<SVGGElement, Date>('.rtick')
          // Ticks are uniform in TIME, but the scene x is not (dense regions
          // are cascade-stretched), so labels can bunch up in x. Greedily
          // keep only ticks whose label clears the previous kept one.
          .data((() => {
            const kept: Date[] = [];
            let lastX = -Infinity;
            for (const d of shown) {
              const x = t.applyX(timeToX(d.getTime() / 1000));
              const w = fmtTick(d).length * 5.8 + 12;
              if (x - lastX >= w) { kept.push(d); lastX = x; }
            }
            return kept;
          })(), d => String(+d));
        const tickEnter = tick.enter().append('g').attr('class', 'rtick');
        tickEnter.append('line')
          .attr('y1', -5).attr('y2', 0)
          .attr('stroke', cssVar('--tick-line', '#555'));
        tickEnter.append('text')
          .attr('y', -8).attr('text-anchor', 'middle')
          .attr('fill', cssVar('--text-dim', '#888')).attr('font-size', '10px');
        const tickMerged = tickEnter.merge(tick);
        tickMerged.attr('transform', d => `translate(${t.applyX(timeToX(d.getTime() / 1000))},0)`);
        tickMerged.select('text').text(fmtTick);
        tick.exit().remove();

        // Axis-break markers: "// 45d" at the center of each folded gap.
        const brk = axisG
          .selectAll<SVGGElement, TimeGap>('.rbreak')
          .data(gaps, d => String(d.t_start));
        const brkEnter = brk.enter().append('g').attr('class', 'rbreak');
        brkEnter.append('text')
          .attr('y', -8).attr('text-anchor', 'middle')
          .attr('fill', cssVar('--gap-break', '#a06a3a')).attr('font-size', '10px');
        brkEnter.merge(brk)
          .attr('transform', d => `translate(${t.applyX((d.x_start + d.x_end) / 2)},0)`)
          .select('text')
          .text(d => `// ${fmtDuration(d.t_end - d.t_start)}`);
        brk.exit().remove();
      };
      updateRuler();
    }

    // --- lane chips: HTML overlay pinned to the left edge --------------------
    // Rendered OUTSIDE the svg as a frosted-glass rail on the highest z-layer,
    // so labels stay crisp and readable when the graph scrolls beneath them
    // (SVG-in-scene labels can't do backdrop blur). cullOverlay() repositions
    // them on every pan/zoom and thins them at heavy zoom-out.
    const rail = d3.select(laneRailRef.current);
    const chips = rail.selectAll<HTMLDivElement, BranchLane>('.lane-chip')
      .data(data.branches, (d: BranchLane) => d.name)
      .join('div')
      // Current-branch marker (spec 4.3): the head-lane class adds the dot
      // prefix + tint. Sibling worktree members' checked-out lanes get a
      // house badge -- one graph, N anchors, no duplicate member views.
      // A lane with NO commits in the loaded set (its tip outside the load
      // window, or every commit outside the date range) renders hollow:
      // dashed border + muted, with an honest tooltip -- an unmarked empty
      // row read as "the branch has nothing" / a rendering bug (the
      // fetched-branch phantom-lane report).
      .attr('class', (d: BranchLane) => (
        d.name === headBranch ? 'lane-chip head-lane'
          : memberLanes.has(d.name) ? 'lane-chip member-lane'
            : laneSpan.has(d.lane_index) ? 'lane-chip'
              : 'lane-chip lane-chip-empty'))
      .attr('title', (d: BranchLane) => {
        const hint = d.name === headBranch ? t('currentBranchTip')
          : memberLanes.has(d.name) ? t('checkedOutIn', { name: memberLanes.get(d.name)! })
            : !laneSpan.has(d.lane_index) ? t('laneEmptyTip')
              : null;
        return hint ? `${d.name} — ${hint}` : d.name;
      })
      .style('color', (d: BranchLane) => d.color)
      .style('border-color', (d: BranchLane) => d.color)
      .style('opacity', (d: BranchLane) => dimOthers(d.name) ? 0.25 : 1)
      .on('click', (_e: MouseEvent, d: BranchLane) => {
        setFocusedLane(prev => (prev === d.name ? null : d.name));
      })
      .on('contextmenu', (event: MouseEvent, d: BranchLane) => {
        event.preventDefault();
        setLaneMenu({ x: event.clientX, y: event.clientY, lane: d });
      });
    // Chip content: [★][name][×]. The star marks a favorite (persisted),
    // the × folds the lane into its sediment row (display-only, session
    // state) -- the two map-model verbs that live on the canvas itself.
    chips.html('');
    chips.filter((d: BranchLane) => starredLanes.has(d.name))
      .append('span')
      .attr('class', 'lane-chip-star')
      .text('★');
    chips.append('span')
      .attr('class', 'lane-chip-name')
      .text((d: BranchLane) => middleEllipsis(d.name));
    chips.append('span')
      .attr('class', 'lane-chip-fold')
      .attr('title', t('foldLane'))
      .text('×')
      .on('click', (event: MouseEvent, d: BranchLane) => {
        event.stopPropagation();
        onFoldLane(d.name);
      });
    // Trace-row chips ride the same rail; datum is BranchLane-shaped so the
    // shared cull code path (lane_index-keyed) handles them unchanged.
    rail.selectAll<HTMLDivElement, BranchLane>('.lane-chip.trace-chip')
      .data(traceRows.map(r => ({
        name: traceLabel(r),
        lane_index: r.laneIndex,
        color: '#888888',
        is_tag: false,
        fork_point: null,
        merged_into: null,
        is_active: false,
      })), (d: BranchLane) => d.name)
      .join('div')
      .attr('class', 'lane-chip trace-chip')
      .style('color', (d: BranchLane) => d.color)
      .style('border-color', (d: BranchLane) => d.color)
      .text((d: BranchLane) => d.name)
      .style('cursor', 'pointer')
      .on('click', (_e: MouseEvent, d: BranchLane) => {
        const r = traceRows.find(tr => tr.laneIndex === d.lane_index);
        if (r) onExpandTraceGroup(r.kind);
      });

    // --- minimap ----------------------------------------------------------------------
    // Uniform scale: one factor for both axes, with the scene letterboxed
    // (centered) inside the map. The previous per-axis stretch filled the map
    // with an extremely wide-flat scene, but it is exactly why the viewport
    // rect's aspect ratio could never match the timeline window's — the rect
    // is derived from the same uniform map, so both now share one ratio at
    // any pan/zoom.
    // Lanes render as activity bars spanning their commits; key commits are
    // bright dots. The map answers "where is the activity", not "where are
    // individual commits".
    if (minimapRef.current) {
      const mm = d3.select(minimapRef.current);
      mm.selectAll('*').remove();
      mm.attr('width', MINIMAP_W).attr('height', MINIMAP_H);
      const sceneW = Math.max(maxX - minX, 1);
      const sceneH = Math.max(maxY - minY, 1);
      const map = minimapMap(sceneW, sceneH, MINIMAP_W, MINIMAP_H, minX, minY);
      minimapMapRef.current = map;
      const mx = (x: number) => (x - map.x0) * map.s;
      const my = (y: number) => (y - map.y0) * map.s;

      for (const b of data.branches) {
        const span = laneSpan.get(b.lane_index);
        if (!span) continue;
        // The checked-out lane reads in the same "you are here" green as
        // the mm-head dot and the in-graph band -- one color, one meaning,
        // every surface.
        const isHeadLane = b.lane_index === headLaneIndex;
        const y = my(b.lane_index * LANE_HEIGHT);
        mm.append('line')
          .attr('x1', mx(span.min))
          .attr('x2', Math.max(mx(span.max), mx(span.min) + 2))
          .attr('y1', y).attr('y2', y)
          .attr('stroke', isHeadLane ? cssVar('--success', '#4CAF50') : b.color)
          .attr('stroke-width', isHeadLane ? 4 : 3)
          .attr('stroke-linecap', 'round')
          .attr('opacity', dimOthers(b.name) ? 0.15 : (isHeadLane ? 1 : 0.9));
      }
      // Sediment rows in the map too: low-opacity dead-lane bars.
      for (const tb of traceBars) {
        const y = my(tb.laneIndex * LANE_HEIGHT);
        mm.append('line')
          .attr('x1', mx(tb.x1))
          .attr('x2', Math.max(mx(tb.x2), mx(tb.x1) + 1))
          .attr('y1', y).attr('y2', y)
          .attr('stroke', tb.color)
          .attr('stroke-width', 2)
          .attr('opacity', 0.35);
      }
      // Key-commit dots: one batched innerHTML parse instead of one
      // append per commit — the minimap redraws with every scene, and a
      // large repo puts thousands of dots here.
      const dots: string[] = [];
      for (const c of data.commits) {
        if (!c.is_key || hiddenIds.has(c.id)) continue;
        // Lane-colored like the main graph; hardcoded white vanished on
        // light themes, --text turned into a black blob.
        dots.push(`<circle cx="${mx(c.x)}" cy="${my(c.y)}" r="1.8" fill="${ownerColor(c.lane_owner)}" opacity="0.85"/>`);
      }
      if (dots.length > 0) {
        const dotG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        dotG.innerHTML = dots.join('');
        mm.node()!.appendChild(dotG);
      }

      // time anchors: oldest ↔ newest month
      const fmtMY = (ts: number) => {
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      };
      const tMin = Math.min(...data.commits.map(c => c.timestamp));
      const tMax = Math.max(...data.commits.map(c => c.timestamp));
      mm.append('text')
        .attr('x', 3).attr('y', MINIMAP_H - 4)
        .attr('font-size', '10px').attr('fill', cssVar('--text-faint', '#777777'))
        .text(fmtMY(tMin));
      mm.append('text')
        .attr('x', MINIMAP_W - 3).attr('y', MINIMAP_H - 4)
        .attr('font-size', '10px').attr('fill', cssVar('--text-faint', '#777777'))
        .attr('text-anchor', 'end')
        .text(fmtMY(tMax));

      mm.append('rect')
        .attr('class', 'mm-viewport')
        .attr('fill', 'rgba(125, 184, 240, 0.16)')
        .attr('stroke', cssVar('--link', '#8ec6ff'))
        .attr('stroke-width', 1.5)
        .attr('rx', 2)
        .attr('pointer-events', 'none');

      // HEAD anchor (topmost): in a 6000-commit map the graph's own green
      // ring + label shrink to nothing at overview zoom -- the map itself
      // is the surface that stays readable, so the dot lives HERE. Same
      // green as the in-graph marker; dark rim reads on light and dark
      // themes. Skipped when a filtered view has no head node in it.
      const headNode = data.commits.find(c => c.is_head && !hiddenIds.has(c.id))
        ?? data.commits.find(c => c.is_head);
      if (headNode) {
        mm.append('circle')
          .attr('class', 'mm-head')
          .attr('cx', mx(headNode.x))
          .attr('cy', my(headNode.y))
          .attr('r', 3.5)
          .attr('fill', cssVar('--success', '#4CAF50'))
          .attr('stroke', 'rgba(0, 0, 0, 0.45)')
          .attr('stroke-width', 1)
          .attr('pointer-events', 'none');
      }

      // Click to jump; hold and drag to scrub the viewport across the map.
      // Invert the same map the drawing used, so the jump lands exactly on
      // what was clicked.
      const jump = (event: MouseEvent) => {
        const [px, py] = d3.pointer(event, minimapRef.current);
        const m = minimapMapRef.current;
        centerOn(px / m.s + m.x0, py / m.s + m.y0);
      };
      mm.on('mousedown', (event: MouseEvent) => {
        event.preventDefault();
        jump(event);
        const move = (ev: MouseEvent) => jump(ev);
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      mm.on('click', (event: MouseEvent) => event.stopPropagation());
    }

    // Mount the fully-built overlay in one insertion (see the detached build
    // note at the top): everything below only wires camera/state, never
    // overlay elements. Appended AFTER the ruler, matching the old stacking
    // (graph content above the sticky ruler's backdrop).
    svg.node()!.appendChild(g.node()!);

    // Test seam: canvas hit-testing replaced DOM nodes, so the extension E2E
    // locates commits through this hook instead of querySelector('.node').
    (window as unknown as { __GTV_CANVAS__?: unknown }).__GTV_CANVAS__ = {
      commitCount: visibleCommits.length,
      ids: visibleCommits.slice(0, 8).map(c => c.id),
      toScreen: (id: string) => {
        const c = commitMap.get(id);
        if (!c || !cv) return null;
        const t = transformRef.current;
        const rect = cv.getBoundingClientRect();
        return { x: c.x * t.k + t.x + rect.left, y: c.y * t.k + t.y + rect.top };
      },
    };

    // --- viewport: reset only when a repo was (re)opened ------------------------------
    const initialDraw = resetKeyRef.current === -1;
    const shouldReset = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    if (data.commits.length > 0 && shouldReset) {
      // Default view: readable 1x zoom, positioned on the newest commit
      // (HEAD when known) — latest activity sits right-of-center, its lane
      // vertically centered. Pan/zoom out from there, or use the minimap.
      const newest = data.commits.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      const head = data.commits.find(c => c.is_head && !hiddenIds.has(c.id));
      const newestVisible = visibleCommits.length > 0
        ? visibleCommits.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
        : null;
      const target = head ?? newestVisible ?? data.commits.find(c => c.is_head) ?? newest;
      const k = 1;
      let t = d3.zoomIdentity
        .translate(width * 0.7 - target.x * k, height / 2 - target.y * k)
        .scale(k);
      // First draw of a mounted repo: the user's remembered camera replaces
      // the default anchor, so a webview reload / repo re-open lands where
      // they left off instead of zooming back out to the overview. Rejected
      // when it aims far outside the scene (stale memory of a shrunken
      // filtered view would restore into empty space) and k is clamped into
      // the zoom behavior's scaleExtent.
      if (initialDraw && viewKey) {
        const saved = loadViewport(viewKey);
        if (saved) {
          const sk = Math.min(40, Math.max(0.005, saved.k));
          const st = d3.zoomIdentity.translate(saved.x, saved.y).scale(sk);
          const cx = (width / 2 - st.x) / sk;
          const cy = (height / 2 - st.y) / sk;
          const M = 800; // scene-px of slack around the bounds
          if (cx >= minX - M && cx <= maxX + M && cy >= minY - M && cy <= maxY + M) t = st;
        }
      }
      restoringCameraRef.current = true;
      containerSel.call(zoom.transform, t);
      restoringCameraRef.current = false;
      transformRef.current = t;
    } else {
      // Data changed without a view reset (older history paged in, or diff
      // stats merged in): the backend re-laid out the whole set, so scene x
      // coordinates may have shifted. Keep the commit nearest the viewport
      // center fixed on screen; everything else drifts smoothly around it.
      let t = transformRef.current;
      const prev = prevDataRef.current;
      if (prev && prev.commits !== data.commits) {
        const centerSceneX = (width / 2 - t.x) / t.k;
        let anchor: CommitNode | null = null;
        let best = Infinity;
        for (const c of prev.commits) {
          const d = Math.abs(c.x - centerSceneX);
          if (d < best) {
            best = d;
            anchor = c;
          }
        }
        const moved = anchor ? commitMap.get(anchor.id) : undefined;
        if (anchor && moved && moved.x !== anchor.x) {
          t = d3.zoomIdentity
            .translate(t.x + (anchor.x - moved.x) * t.k, t.y)
            .scale(t.k);
          transformRef.current = t;
        }
      }
      restoringCameraRef.current = true;
      containerSel.call(zoom.transform, t);
      restoringCameraRef.current = false;
    }
    prevDataRef.current = data;
    minimapViewport();
    // First paint of this scene (a camera restore also fires the zoom
    // handler, but an unchanged transform must not rely on that).
    paint();
    cullOverlay();
  }, [data, viewKey, onCommitClick, selectedCommitId, resetKey, active, compressed, showMergeLinks, showRefLabels, showAnnotations, patchLinks, focusedLane, expandedLanes, collapseRunData, visibleCommits, commitMap, branchColorMap, edgeHighlight, theme, lang, t, hasMore, dateRangeActive, loadingOlder, onLoadOlder, hiddenIds, traceRows, traceBars, onExpandTraceGroup, traceGroupLabel, hideRemotes, headBranch, memberLanes, onCompareClick, compareBaseId, starredLanes, onFoldLane, centerOn]);

  // Full redraw: the canvas repaint + the light SVG overlay rebuild are both
  // cheap enough to run synchronously on every dep change — the old
  // heavy-scene scrim existed because a 13k-element DOM join blocked the
  // main thread past a frame budget, which the canvas model eliminated.
  useEffect(() => {
    draw();
  }, [draw]);

  // Latest draw for the size observer below. The observer itself must live
  // for the component's lifetime: keying the observe() on draw identity
  // (the previous shape) re-fired an initial observation after every redraw
  // trigger — a mode switch, refresh or page-in each rebuilt the whole
  // scene a SECOND time (the second long task of the 100-lane starred/all
  // switch report).
  const drawRef = useRef<() => void>(() => {});
  useEffect(() => { drawRef.current = draw; }, [draw]);

  // Container-size redraws: panel toggles and flex re-layouts resize the
  // container silently, and during a macOS live window drag WebKit reports
  // transient 0x0 clientWidth/Height, so a resize-triggered draw can capture
  // a zero window. Every closure built by that draw (minimap viewport rect,
  // ruler backdrop, cull window) stays poisoned until an unrelated dep
  // triggers a full redraw. Observing the container makes any size change --
  // including recovery from a transient zero -- re-run draw with real
  // dimensions. (draw() writes only canvas/svg pixel sizes that CSS 100%
  // overrides, so observing cannot feed back into layout.)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // observe() always delivers one initial entry; the draw effect already
    // drew with real dimensions, so swallow exactly that first delivery.
    let delivered = false;
    const ro = new ResizeObserver(() => {
      if (!delivered) {
        delivered = true;
        return;
      }
      drawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Unmount-only: cancel a pending debounced camera save (the draw effect's
  // cleanup must NOT do this -- a redraw landing inside the debounce window
  // would drop the save with no later gesture to reschedule it).
  useEffect(() => () => window.clearTimeout(viewportSaveTimer.current), []);

  /** Fit the whole scene into the viewport (toolbar "Fit" button). */
  const fitToView = useCallback(() => {
    if (!zoomRef.current || !containerRef.current) return;
    const { minX, maxX, minY, maxY } = sceneBoundsRef.current;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;
    const sceneW = maxX - minX;
    const sceneH = maxY - minY;
    if (sceneW <= 0 || sceneH <= 0) return;
    const k = Math.min(width / sceneW, height / sceneH, 1) * 0.9;
    const t = d3.zoomIdentity
      .translate(width / 2 - (minX + sceneW / 2) * k, height / 2 - (minY + sceneH / 2) * k)
      .scale(k);
    d3.select(containerRef.current).call(zoomRef.current.transform, t);
  }, []);

  // "Fit" lives in the app header; fitSignal increments trigger it here.
  const fitSignalRef = useRef(fitSignal);
  useEffect(() => {
    if (fitSignalRef.current === fitSignal) return;
    fitSignalRef.current = fitSignal;
    fitToView();
  }, [fitSignal, fitToView]);

  // "Go home" lives in the app header (button + H key); headSignal
  // increments trigger it here. Age-of-Empires go-home semantics: the
  // camera snaps straight to the town center — no glide — the spot flashes
  // a "you are here" ring, and the minimap pings at the landing point.
  // Position only: selection and the details panel stay the user's (H in
  // AoE selects the TC; here the ring alone carries the feedback). Zoom
  // follows the search-jump rule — never below 1x, so the landing context
  // is legible from a zoomed-out overview.
  const headSignalRef = useRef(headSignal);
  useEffect(() => {
    if (headSignalRef.current === headSignal) return;
    headSignalRef.current = headSignal;
    const c = data.commits.find(x => x.is_head && !hiddenIds.has(x.id))
      ?? data.commits.find(x => x.is_head);
    if (!c || !svgRef.current || !zoomRef.current || !containerRef.current) return;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;
    const k = Math.max(transformRef.current.k, 1);
    const next = d3.zoomIdentity
      .translate(width / 2 - c.x * k, height / 2 - c.y * k)
      .scale(k);
    d3.select(containerRef.current).call(zoomRef.current.transform, next);

    // Ring flash on the HEAD node, in screen coordinates (the pulses live
    // on the svg root, outside the zoom group, so the camera snap doesn't
    // drag them along). Two quick pulses read as "flare", one reads as
    // noise; both fade fully so nothing lingers on the canvas.
    const svg = d3.select(svgRef.current);
    const rgb = cssVar('--head-lane-rgb', '76, 175, 80');
    const sx = next.x + c.x * k;
    const sy = next.y + c.y * k;
    for (const delay of [0, 200]) {
      svg.append('circle')
        .attr('cx', sx).attr('cy', sy).attr('r', 10)
        .attr('fill', 'none')
        .attr('stroke', `rgba(${rgb}, 0.9)`)
        .attr('stroke-width', 3)
        .attr('pointer-events', 'none')
        .transition().delay(delay).duration(420).ease(d3.easeCubicOut)
        .attr('r', 30)
        .attr('stroke', `rgba(${rgb}, 0)`)
        .attr('stroke-width', 1)
        .remove();
    }

    // Minimap ping at the landing spot — the AoE flare that tells you
    // where "home" sits in the whole-scheme-of-things.
    if (minimapRef.current) {
      const map = minimapMapRef.current;
      d3.select(minimapRef.current).append('circle')
        .attr('cx', (c.x - map.x0) * map.s)
        .attr('cy', (c.y - map.y0) * map.s)
        .attr('r', 2)
        .attr('fill', 'none')
        .attr('stroke', `rgba(${rgb}, 0.9)`)
        .attr('stroke-width', 2)
        .attr('pointer-events', 'none')
        .transition().duration(700).ease(d3.easeCubicOut)
        .attr('r', 16)
        .attr('stroke', `rgba(${rgb}, 0)`)
        .remove();
    }
  }, [headSignal, data, hiddenIds]);

  // Header search jump: make sure the target node is visible (expanding
  // its lane in compressed mode — x/y are backend-computed and do not
  // change on expand) and center on it, zooming to at least 1x so the
  // node is legible when jumping from a zoomed-out overview.
  const focusSeqRef = useRef(0);
  useEffect(() => {
    if (!focusCommit || focusSeqRef.current === focusCommit.seq) return;
    focusSeqRef.current = focusCommit.seq;
    const c = commitMap.get(focusCommit.id);
    if (!c || !svgRef.current || !zoomRef.current || !containerRef.current) return;
    if (compressed && !c.is_key && !expandedLanes.has(c.lane_owner)) {
      setExpandedLanes(prev => new Set(prev).add(c.lane_owner));
    }
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;
    const k = Math.max(transformRef.current.k, 1);
    const next = d3.zoomIdentity
      .translate(width / 2 - c.x * k, height / 2 - c.y * k)
      .scale(k);
    d3.select(containerRef.current).call(zoomRef.current.transform, next);
  }, [focusCommit, commitMap, compressed, expandedLanes]);

  // Trackpad-friendly wheel handling (Figma-style):
  //   two-finger scroll (plain wheel)  -> pan
  //   pinch (ctrlKey wheel) / cmd+wheel -> zoom around the cursor
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const zoom = zoomRef.current;
      if (!zoom) return;
      const t = transformRef.current;
      const unit = event.deltaMode === 1 ? 16 : 1; // Firefox line mode
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;

      let next: d3.ZoomTransform;
      if (event.ctrlKey || event.metaKey) {
        const rect = node.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const k2 = Math.min(40, Math.max(0.005, t.k * Math.exp(-dy * 0.0022)));
        const s = k2 / t.k;
        // keep the scene point under the cursor fixed on screen
        next = d3.zoomIdentity
          .translate(mx - s * (mx - t.x), my - s * (my - t.y))
          .scale(k2);
      } else {
        next = d3.zoomIdentity.translate(t.x - dx, t.y - dy).scale(t.k);
      }
      d3.select(node).call(zoom.transform, next);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  // Tooltip chips share the badge filter (spec 4.3): the chip list derives
  // from the FILTERED refs and the whole row hides when nothing survives.
  const hoveredRefs = hoveredCommit ? filterRefs(hoveredCommit.branch_refs, hideRemotes) : [];
  // Lane-menu "compare with HEAD" (M3.2): precomputed for the open menu so
  // the item can render grayed out when HEAD is outside the loaded set
  // (date window / pagination cropped it) or the lane has no loaded tip.
  const headPair = laneMenu ? headToLaneTip(data, laneMenu.lane.name) : null;

  return (
    <div
      ref={containerRef}
      className="timeline-container"
      onMouseDown={e => { canvasPressRef.current = { x: e.clientX, y: e.clientY }; }}
      onClick={e => {
        const press = canvasPressRef.current;
        canvasPressRef.current = null;
        // A drag-pan also ends with a click event on this container; only
        // a nearly stationary press counts as a deliberate click (4px of
        // slack for shaky hands).
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return;
        const target = e.target as Element;
        // Overlay widgets (ref pills, merge badges) carry no verbs: a click
        // on them counts as an empty-canvas click, exactly as when they
        // intercepted the event in the old stacking.
        if (target.closest('.ref-badges,.merge-badge,.head-mark')) {
          setLaneMenu(null);
          setRunMenu(null);
          setEdgeHighlight(null);
          onCanvasClick();
          return;
        }
        const hit = hitTestRef.current(e.clientX, e.clientY);
        if (hit?.kind === 'node') {
          // Modifier split mirrors the edge-click precedent: ctrl/cmd
          // feeds the compare pairer, a plain click stays a selection.
          if (e.ctrlKey || e.metaKey) onCompareClick(hit.c.id);
          else onCommitClick(hit.c.id);
          return;
        }
        if (hit?.kind === 'edge') {
          //   click       -> highlight both endpoint commits
          //   ctrl/cmd+click -> jump to the parent end
          //   shift+click    -> jump to the child end
          const d = hit.edge;
          if (e.ctrlKey || e.metaKey) {
            const parent = commitMap.get(d.to);
            if (parent) centerOn(parent.x, parent.y);
          } else if (e.shiftKey) {
            const child = commitMap.get(d.from);
            if (child) centerOn(child.x, child.y);
          } else {
            setEdgeHighlight(h => (h && h.from === d.from && h.to === d.to ? null : { from: d.from, to: d.to }));
          }
          return;
        }
        setLaneMenu(null);
        setRunMenu(null);
        setEdgeHighlight(null);
        onCanvasClick();
      }}
      onContextMenu={e => {
        // The lane verb lives on the lane ROW (band hit-test): the old
        // target was the 4px bar stroke itself. Overlay widgets and non-
        // canvas surfaces keep the browser's own menu.
        const target = e.target as Element;
        if (target.closest('.lane-rail,.minimap,.view-toolbar,.lane-menu,.run-menu,.tooltip,.ref-badges,.merge-badge,.collapse-chip,.trace-hit,.head-mark')) return;
        const hit = hitTestRef.current(e.clientX, e.clientY);
        if (hit?.kind === 'lane') {
          e.preventDefault();
          setLaneMenu({ x: e.clientX, y: e.clientY, lane: hit.lane });
        }
      }}
      onPointerMove={e => {
        const hit = hitTestRef.current(e.clientX, e.clientY);
        const el = e.currentTarget as HTMLDivElement;
        el.style.cursor = hit?.kind === 'node' ? 'pointer' : '';
        if (hit?.kind === 'node') {
          setHoveredCommit(prev => (prev?.id === hit.c.id ? prev : hit.c));
          setTooltipPos({ x: e.clientX, y: e.clientY });
        } else {
          setHoveredCommit(prev => (prev ? null : prev));
        }
      }}
      onPointerLeave={() => setHoveredCommit(null)}
    >
      <canvas ref={canvasRef} className="timeline-canvas"></canvas>
      <svg ref={svgRef} className="timeline-overlay"></svg>
      <div className="lane-rail-blur"></div>
      {/* Lane chips are canvas controls, not empty space: their clicks must
          not bubble to the container's empty-canvas handler (which closes
          the details panel). */}
      <div ref={laneRailRef} className="lane-rail" onClick={e => e.stopPropagation()}></div>

      {busyDelayed && (
        <div className="render-overlay" aria-live="polite" role="status">
          <div className="render-card">
            <span className="render-spinner" aria-hidden="true" />
            <span className="render-card-text">{t('rendering')}</span>
            <span className="render-card-sub">{t('renderingTip')}</span>
          </div>
        </div>
      )}

      {/* Same non-empty-space rule as the lane rail: the toolbar's buttons
          act on the graph, they must not also dismiss the details panel. */}
      <div className="view-toolbar" onClick={e => e.stopPropagation()}>
        {loadingOlder && (
          <span className="view-btn loading-older">{t('loadingOlder')}</span>
        )}
        {atOldestEdge && (
          <span className="view-btn loading-older">{t('olderAtEdge')}</span>
        )}
        {compressed && expandedLanes.size + expandedIds.size > 0 && (
          <button className="view-btn" onClick={() => { setExpandedLanes(new Set()); setExpandedIds(new Set()); }}>
            {t('collapseAll')}
          </button>
        )}
        {focusedLane && (
          <button className="view-btn focused" onClick={() => setFocusedLane(null)}>
            ✕ {focusedLane}
          </button>
        )}
      </div>

      <svg ref={minimapRef} className="minimap"></svg>

      {runMenu && (
        <div
          className="run-menu"
          style={{ left: runMenu.x, top: runMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="run-menu-head">{t('runCommits', { n: runMenu.run.ids.length })}</div>
          <div className="run-menu-list">
            {runMenu.run.ids.map(id => {
              const c = commitMap.get(id);
              if (!c) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className="run-menu-row"
                  title={`${formatTime(c.timestamp)} · ${c.message}`}
                  onClick={() => { onCommitClick(id); setRunMenu(null); }}
                >
                  <span className="run-menu-time">{formatTime(c.timestamp)}</span>
                  <span className="run-menu-msg">{c.message}</span>
                </button>
              );
            })}
          </div>
          <div className="run-menu-foot">
            <button
              type="button"
              className="view-btn"
              title={t('runExpandTip')}
              onClick={() => {
                setExpandedIds(prev => new Set([...prev, ...runMenu.run.ids]));
                setRunMenu(null);
              }}
            >
              {t('runExpand')}
            </button>
          </div>
        </div>
      )}

      {laneMenu && (
        <div
          className="lane-menu"
          style={{ left: laneMenu.x, top: laneMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => { onCopyName(laneMenu.lane.name); setLaneMenu(null); }}>
            {t('copyName')}
          </button>
          <button onClick={() => { setFocusedLane(f => f === laneMenu.lane.name ? null : laneMenu.lane.name); setLaneMenu(null); }}>
            {focusedLane === laneMenu.lane.name ? t('unfocusLane') : t('focusLane')}
          </button>
          {/* Map-model verbs on the lane itself: star = the persisted
              favorite (feeds the ★ view mode), fold = instant display-level
              hiding. Tags are not lane-star material (the starred view works
              over branch lanes). */}
          {!laneMenu.lane.is_tag && (
            <button onClick={() => { onToggleStarLane(laneMenu.lane.name); setLaneMenu(null); }}>
              {starredLanes.has(laneMenu.lane.name) ? t('unpin') : t('pin')}
            </button>
          )}
          <button onClick={() => { onFoldLane(laneMenu.lane.name); setLaneMenu(null); }}>
            {t('foldLane')}
          </button>
          <button onClick={() => { setExpandedLanes(prev => new Set(prev).add(laneMenu.lane.name)); setLaneMenu(null); }}>
            {t('expandAll')}
          </button>
          <button onClick={() => { onViewFromBranch(laneMenu.lane.name); setLaneMenu(null); }}>
            {t('viewFromBranch')}
          </button>
          {/* Tag lanes have no blood-line of their own: the closure degrades
              to main-only, and relatedOnly destructively REPLACES the whole
              selection -- not worth an entry point for a meaningless target. */}
          {!laneMenu.lane.is_tag && (
            <button onClick={() => { onRelatedBranch(laneMenu.lane.name); setLaneMenu(null); }}>
              {t('relatedOnly')}
            </button>
          )}
          {/* M3.1: real worktree checkout (tags are not checkout targets).
              The CURRENT branch's own lane is not special-cased either:
              checking it out is a git safe no-op (spec 5). Coexists with
              "View from this branch" above -- worktree change vs view-only.
              Remote-only lanes (origin/x) have no local branch to check out;
              the backend would refuse, so the entry is not offered. */}
          {!laneMenu.lane.is_tag && !laneMenu.lane.is_remote && (
            <button onClick={() => { onCheckoutBranch(laneMenu.lane.name); setLaneMenu(null); }}>
              {t('checkoutThisBranch')}
            </button>
          )}
          {/* M3.2: compare this lane's tip against the HEAD commit (tags
              excluded -- a tag tip is rarely what "compare with HEAD"
              promises). Grayed out when headToLaneTip cannot resolve the
              pair from what is loaded; the complete pair then flows through
              the exact same channel as two hand-picked nodes (spec 4.5). */}
          {!laneMenu.lane.is_tag && (
            <button
              disabled={!headPair}
              onClick={() => { if (headPair) { onComparePair(headPair); setLaneMenu(null); } }}
            >
              {t('compareWithHead')}
            </button>
          )}
        </div>
      )}

      {hoveredCommit && (
        <div
          className="tooltip"
          style={{ left: tooltipPos.x + 15, top: tooltipPos.y + 15 }}
        >
          <div className="tooltip-hash">{hoveredCommit.short_id}</div>
          <div className="tooltip-message">{hoveredCommit.message}</div>
          <div className="tooltip-author">
            {hoveredCommit.author_name}
            {/* Unattributed commits name no lane — the refs below say
                where they belong. */}
            {hoveredCommit.lane_owner ? <> · {hoveredCommit.lane_owner}</> : null}
          </div>
          <div className="tooltip-time">{formatTime(hoveredCommit.timestamp)}</div>
          {(hoveredCommit.additions + hoveredCommit.deletions) > 0 && (
            <div className="tooltip-time">
              <span className="diff-add">+{hoveredCommit.additions}</span>{' '}
              <span className="diff-del">−{hoveredCommit.deletions}</span>
            </div>
          )}
          <div className="tooltip-time">{t('nodeCompareTip')}</div>
          {hoveredRefs.length > 0 && (
            <div className="tooltip-branches">
              {hoveredRefs.map((ref, i) => (
                <span key={i} className={`tooltip-tag ${ref.is_tag ? 'tag-tag' : 'tag-branch'}`}>
                  {ref.name}
                </span>
              ))}
            </div>
          )}
          {/* Fork/merge recall: the canvas annotations are opt-in, so the
              tooltip always carries the branch names for these points. */}
          {hoveredCommit.fork_branch_name && (
            <div className="tooltip-time">🌱 {hoveredCommit.fork_branch_name}</div>
          )}
          {hoveredCommit.merge_branch_name && (
            <div className="tooltip-time">🔀 {hoveredCommit.merge_branch_name}</div>
          )}
        </div>
      )}
    </div>
  );
}
